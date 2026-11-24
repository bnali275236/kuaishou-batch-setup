/**
 * 细则 1124 六账户矩阵搭建（2026-11-24 用户拍板）：
 *   - 激活出价 10 元 / 付费出价 150 元（OCPM）；618 的 MCB 计划已存在不动
 *   - 账户预算 1000 / 计划预算 500（周期稳投计划用 range_budget 3500×7日）
 *   - 计划建完即暂停（initialStatus=PAUSED → 只压计划层），组/创意默认开启
 *   - 所有素材全部上（17 条 ÷ 每组 5 条 = 4 组），不分新老/优选
 *   - 信息流统一开搜索快投（quick_search，需白名单）；搜索账户挂词包（广泛匹配）
 *
 * 用法：node tools/build-matrix-1124.cjs [--dry]
 */
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
const { planName, unitName, unitCount, splitUnits } = require('./naming.cjs');

const BASE = 'http://127.0.0.1:7801';
const DRY = process.argv.includes('--dry');
const DATE = '1124';

/* ——— 模板（来自 618 成功投放的创意/组）——— */
const TAGS = ['盼之电竞', '东东电竞', '陪玩', '护航', '三角洲陪玩', '三角洲护航', '体验单', '螃蟹电竞', 'PERO电竞', 'KOOK'];
const CATEGORY = 80302;
const ACTION_BAR = '立即下载';
const REC = '找陪玩护航就来盼之电竞';
const KOL = { kolUserType: 1, kolUserId: '5502712421' };
/** 广告语赛马：A 开业福利（17 创意里 9 条）/ B 找陪玩（8 条），按素材序号交替 */
const DESC_A = '盼之电竞开业送福利，送新人限时体验单';
const DESC_B = '找陪玩护航就来盼之电竞';
/** 应用链路（app/list 共享资产，六账户同包） */
const APP = { appId: '2199199404082', packageId: '1099687999125' };
const APK_URL =
  'https://p1-ad.adukwai.com/bs2/ad-app/YWQtYXBwOmFkX2RzcF9hcHA6NTUwMjcxMjQyMTpNRVJDSEFOVDpbQkA2YWZhMzQyMToyNTIyMzY0NjY0MTQyMQ%3D%3D.apk';
const clickUrl = (tag) =>
  `https://api-cb.pzds.com/api/third/ad/click/kuaishou?channel_tag=${tag}&appCode=PZDJ&apkType=0&imei=__IMEI2__&oaid=__OAID2__&ip=__IP__&ipv4=__IPV4__&ipv6=__IPV6__&adCallback=__CALLBACK__&adId=__AID__&dId=__DID__&dName=__DNAME__&clickTime=__TS__&idfa=__IDFA2__&androidId=__ANDROIDID2__&ua=__UA__&deviceType=__OS__&advertiserId=__ACCOUNTID__&adName=__UNITNAME__&creativeId=__CID__&model=__MODEL__&csite=__CSITE__&llsid=__LLSID__`;

/* ——— 账户矩阵（账户名 = 用户已改的平台名口径）——— */
const ACCOUNTS = [
  { id: '130483619', tag: '619', kind: 'feed', action: 180, bid: 10 },
  { id: '130483620', tag: '620', kind: 'feed', action: 190, bid: 150 },
  { id: '130483621', tag: '621', kind: 'search', action: 180, bid: 10 },
  { id: '130483622', tag: '622', kind: 'search', action: 190, bid: 150 },
  // 623 综合-周期稳投：激活 + 付费 各一个稳投计划（7 日 / 总预算 3500）
  { id: '130483623', tag: '623', kind: 'periodic', action: 180, bid: 10 },
  { id: '130483623', tag: '623', kind: 'periodic', action: 190, bid: 150 },
];

/** 解析词包（跳过表头/示例/说明行），广泛匹配 */
function loadWords() {
  const wb = XLSX.readFile('D:/.A/盼之电竞/剪辑素材/搜索词/template_v1.24b7784fcc80d6c0.xlsx');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['关键词上传'], { header: 1 });
  const words = [];
  for (const r of rows.slice(1)) {
    const w = String(r[0] || '').trim();
    if (!w || w.includes('示例') || w.startsWith('注意') || w.startsWith('关键词')) continue;
    if (w.length > 20) continue;
    words.push(w);
  }
  return [...new Set(words)];
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (j.statusCode && j.statusCode >= 400) throw new Error(`API ${j.statusCode}: ${typeof j.message === 'string' ? j.message : JSON.stringify(j.message).slice(0, 400)}`);
  return j;
}

async function main() {
  const words = loadWords();
  console.log(`词包：${words.length} 个词（广泛匹配）`);
  const today = new Date().toISOString().slice(0, 10);

  for (const acc of ACCOUNTS) {
    // 素材是账户级资产：逐账户拉库（photoId 不同）
    const mats = await api('GET', `/api/plan/assets/videos?advertiserId=${acc.id}`);
    const materials = mats.map((v) => ({ photoId: String(v.id), name: String(v.name || '').replace(/\.mp4$/i, '').trim() }));
    const isSearch = acc.kind === 'search';
    const actionName = acc.action === 180 ? '激活' : '付费';
    const delivery = isSearch ? 'SEARCH' : acc.kind === 'periodic' ? 'PERIODIC' : 'NORMAL';
    const plan = planName({ tag: acc.tag, batch: '全素材', bidMode: 'OCPX', delivery, action: acc.action, date: DATE });
    const groups = splitUnits(plan, materials); // 17 条 → 4 组（5/5/5/2）

    const units = groups.map((g, gi) => ({
      unitName: unitName(plan, gi),
      videos: g.materials.map((m, mi) => ({
        photoId: m.photoId,
        name: m.name,
        description: (g.unitIndex * 5 + mi) % 2 === 0 ? DESC_A : DESC_B,
      })),
    }));

    const row = {
      rowNo: 1,
      advertiserId: acc.id,
      campaignName: plan,
      campaignType: 2,
      adType: isSearch ? 1 : 0,
      ...(acc.kind === 'periodic'
        ? { periodicDeliveryType: 1, periodicDays: 7, rangeBudgetYuan: 3500 }
        : { campaignDayBudgetYuan: 500 }),
      searchQuick: isSearch ? null : 1, // 信息流统一开搜索快投（白名单，失败则在检查报告里说明）
      searchExtend: isSearch ? 1 : null,
      searchKeywords: isSearch ? words : null,
      searchMatchType: isSearch ? 3 : null,
      campaignBidType: 0,
      unitName: plan,
      bidType: 10,
      cpaBidYuan: acc.bid,
      ocpxActionType: acc.action,
      // 应用链路（共享应用资产，六账户同包同 APK 直链）
      appId: APP.appId,
      packageId: APP.packageId,
      url: APK_URL,
      photoId: materials[0]?.photoId,
      sceneIds: isSearch ? [39] : [6],
      unitType: 4,
      beginTime: today,
      platformOs: 1,
      showMode: 2,
      materialType: 1,
      creativeName: materials[0]?.name || plan,
      creativeNameSameAsMaterial: true,
      actionBarText: ACTION_BAR,
      creativeCategory: CATEGORY,
      creativeTags: TAGS,
      recommendation: REC,
      clickMonitorUrl: clickUrl(`kspzdj${acc.tag}`),
      // 原生仅信息流（搜索行不带，mapper/创意层都会拒）
      ...(isSearch ? {} : { outerLoopNative: 1, ...KOL }),
      units,
    };

    console.log(`\n=== ${acc.tag} ${kindLabel(acc.kind)} ${actionName} → ${plan}（${materials.length} 素材 / ${unitCount(materials.length)} 组）${DRY ? ' [DRY]' : ''}`);
    try {
      const t = await api('POST', '/api/plan/tasks', {
        name: `矩阵1124·${acc.tag}-${actionName}${acc.kind === 'periodic' ? '稳投' : ''}`,
        rows: [row],
        initialStatus: 'PAUSED',
        dryRun: DRY,
      });
      console.log(`  任务 #${t.id} 已创建：${t.totalItems} 条目（计划暂停 / 组创意开启）`);
      if (!DRY) await watchTask(t.id);
    } catch (e) {
      console.error(`  ❌ 提交失败：${e.message}`);
    }
  }
}

function kindLabel(k) {
  return k === 'feed' ? '信息流' : k === 'search' ? '搜索' : '周期稳投';
}

async function watchTask(id) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const t = await api('GET', `/api/plan/tasks/${id}`);
    const st = t.status;
    if (st === 'DONE' || st === 'PARTIAL' || st === 'FAILED' || st === 'CANCELLED') {
      console.log(`  任务结束：${st} 成功 ${t.succeeded}/${t.totalItems} 失败 ${t.failed}`);
      for (const it of t.items || []) {
        if (it.status !== 'SUCCEEDED') console.log(`    [${it.status}] ${it.level} ${it.displayName} :: ${String(it.errorMessage || '').slice(0, 160)}`);
      }
      return t;
    }
    if (i % 5 === 0) {
      const counts = {};
      for (const it of t.items || []) counts[it.status] = (counts[it.status] || 0) + 1;
      console.log(`  ... ${JSON.stringify(counts)}`);
    }
  }
  console.log('  超时未结束，稍后用任务接口复查');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
