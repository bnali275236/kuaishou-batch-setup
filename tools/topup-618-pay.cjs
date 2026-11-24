/** 618 付费 MCB 计划补齐全素材（11 条），建完立即暂停待人工确认 */
const BASE = 'http://127.0.0.1:7801';
const UNIT = '45636351669';
const ADV = '130483618';

const TAGS = ['盼之电竞', '东东电竞', '陪玩', '护航', '三角洲陪玩', '三角洲护航', '体验单', '螃蟹电竞', 'PERO电竞', 'KOOK'];
const DESC_A = '盼之电竞开业送福利，送新人限时体验单';
const DESC_B = '找陪玩护航就来盼之电竞';
const FIELDS = {
  creative_category: 80302,
  creative_tag: TAGS,
  recommendation: '找陪玩护航就来盼之电竞',
  outer_loop_native: 1,
  kol_user_type: 1,
  kol_user_id: 5502712421,
};
const CLICK =
  'https://api-cb.pzds.com/api/third/ad/click/kuaishou?channel_tag=kspzdj618&appCode=PZDJ&apkType=0&imei=__IMEI2__&oaid=__OAID2__&ip=__IP__&ipv4=__IPV4__&ipv6=__IPV6__&adCallback=__CALLBACK__&adId=__AID__&dId=__DID__&dName=__DNAME__&clickTime=__TS__&idfa=__IDFA2__&androidId=__ANDROIDID2__&ua=__UA__&deviceType=__OS__&advertiserId=__ACCOUNTID__&adName=__UNITNAME__&creativeId=__CID__&model=__MODEL__&csite=__CSITE__&llsid=__LLSID__';

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json();
  if (j.statusCode && j.statusCode >= 400) throw new Error(typeof j.message === 'string' ? j.message : JSON.stringify(j.message).slice(0, 300));
  return j;
}

(async () => {
  // 已在付费组的素材
  const crs = await api('POST', '/api/manage/structure', { advertiserId: ADV, level: 'creative' });
  const onPay = new Set(
    crs.filter((c) => c.unitId === UNIT && c.raw?.photo_id).map((c) => String(c.raw.photo_id)),
  );
  const mats = await api('GET', `/api/plan/assets/videos?advertiserId=${ADV}`);
  const missing = mats.filter((m) => !onPay.has(String(m.id)));
  console.log(`付费组已有 ${onPay.size} 条，待补 ${missing.length} 条`);
  if (missing.length === 0) return;

  const items = missing.map((m, i) => ({
    photoId: String(m.id),
    name: String(m.name || '').replace(/\.mp4$/i, '').trim(),
    description: i % 2 === 0 ? DESC_A : DESC_B,
    actionBarText: '立即下载',
    clickTrackUrl: CLICK,
    fields: FIELDS,
  }));
  const r = await api('POST', '/api/manage/creative-create', { advertiserId: ADV, unitId: UNIT, items });
  const okIds = r.filter((x) => x.ok).map((x) => x.creativeId);
  for (const x of r) {
    console.log(x.ok ? `  ✅ ${x.creativeId}` : `  ❌ ${x.photoId} :: ${x.error}`);
  }
  if (okIds.length) {
    await new Promise((res) => setTimeout(res, 2000));
    const pr = await api('POST', '/api/manage/status', { advertiserId: ADV, level: 'creative', ids: okIds, action: 'PAUSE' });
    console.log(`已暂停 ${okIds.length} 条新创意（等人工确认后再开）：`, JSON.stringify(pr).slice(0, 200));
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
