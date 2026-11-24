/**
 * 细则 1124 第二批搭建（2026-11-24 用户指令）：
 *   1. 623 = 全自动周期稳投（UAX auto_manage + 周期稳投 7 日/3500），激活+付费各一个
 *   2. 619-622 各加「人群包」计划（唯一可见包 4030006 非目标用户人群包，一包一计划）
 *   3. 619-622 各加「低成本复投」计划（最大转化 MCB；激活户按激活成本 Top6 / 付费户用 618 付费计划原 6 条）
 *   4. 全部建完即暂停（initialStatus=PAUSED，引擎已修复该参数生效）；618 完全不动
 *
 * 用法：node tools/build-extras-1124.cjs [--dry]
 */
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
const { planName, unitName, unitCount, splitUnits } = require('./naming.cjs');

const BASE = 'http://127.0.0.1:7801';
const DRY = process.argv.includes('--dry');
const DATE = '1124';
const POP_ID = 4030006; // 各新账户唯一可见人群包：非目标用户人群包（1.69 亿，type=6）

/* ——— 与矩阵脚本一致的模板 ——— */
const TAGS = ['盼之电竞', '东东电竞', '陪玩', '护航', '三角洲陪玩', '三角洲护航', '体验单', '螃蟹电竞', 'PERO电竞', 'KOOK'];
const CATEGORY = 80302;
const ACTION_BAR = '立即下载';
const REC = '找陪玩护航就来盼之电竞';
const KOL = { kolUserType: 1, kolUserId: '5502712421' };
const DESC_A = '盼之电竞开业送福利，送新人限时体验单';
const DESC_B = '找陪玩护航就来盼之电竞';
const APP = { appId: '2199199404082', packageId: '1099687999125' };
const APK_URL =
  'https://p1-ad.adukwai.com/bs2/ad-app/YWQtYXBwOmFkX2RzcF9hcHA6NTUwMjcxMjQyMTpNRVJDSEFOVDpbQkA2YWZhMzQyMToyNTIyMzY0NjY0MTQyMQ%3D%3D.apk';
const clickUrl = (tag) =>
  `https://api-cb.pzds.com/api/third/ad/click/kuaishou?channel_tag=${tag}&appCode=PZDJ&apkType=0&imei=__IMEI2__&oaid=__OAID2__&ip=__IP__&ipv4=__IPV4__&ipv6=__IPV6__&adCallback=__CALLBACK__&adId=__AID__&dId=__DID__&dName=__DNAME__&clickTime=__TS__&idfa=__IDFA2__&androidId=__ANDROIDID2__&ua=__UA__&deviceType=__OS__&advertiserId=__ACCOUNTID__&adName=__UNITNAME__&creativeId=__CID__&model=__MODEL__&csite=__CSITE__&llsid=__LLSID__`;

/* ——— 低成本素材（618 赛马结果，按素材名跨账户匹配）——— */
/** 激活成本 Top6（近 7 天，5.10~12.45 元）→ 619/621 复投 */
const ACT_LOW = [
  '自产-混剪-20261119-林婕-盼之电竞-品牌背书-01', // 5.10
  '1119-盼之电竞-AI真人口播（1）', // 6.28
  '1123-盼之电竞-AIGC', // 9.39
  '自产-混剪-20261119-林忧-盼之电竞-品牌背书-02', // 10.54
  '自产-混剪-20261119-林忧-盼之电竞-品牌背书-01', // 12.22
  '自产-混剪-20261119-林婕-盼之电竞-AIGC创意-01', // 12.45（激活量最大 12 个）
];
/** 618 付费 MCB 计划原 6 条 → 620/622 复投 */
const PAY_LOW = [
  '自产-混剪-20261119-林婕-盼之电竞-AIGC创意-01',
  '自产-混剪-20261119-林忧-盼之电竞-品牌背书-02',
  '1119-盼之电竞-AI真人口播（1）',
  '1123-盼之电竞-AIGC',
  '自产-混剪-20261119-林婕-盼之电竞-品牌背书-01',
  '自产-混剪-20261119-林忧-盼之电竞-服务硬广-02',
];

/* ——— 账户任务表 ——— */
const JOBS = [
  { id: '130483619', tag: '619', kind: 'feed', action: 180, bid: 10 },
  { id: '130483620', tag: '620', kind: 'feed', action: 190, bid: 150 },
  { id: '130483621', tag: '621', kind: 'search', action: 180, bid: 10 },
  { id: '130483622', tag: '622', kind: 'search', action: 190, bid: 150 },
  { id: '130483623', tag: '623', kind: 'periodic', action: 180 },
  { id: '130483623', tag: '623', kind: 'periodic', action: 190 },
];

function loadWords() {
  const wb = XLSX.readFile('D:/.A/盼之电竞/剪辑素材/搜索词/template_v1.24b7784fcc80d6c0.xlsx');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['关键词上传'], { header: 1 });
  const words = [];
  for (const r of rows.slice(1)) {
    const w = String(r[0] || '').trim();
    if (!w || w.includes('示例') || w.startsWith('注意') || w.startsWith('关键词') || w.length > 20) continue;
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
  if (j.statusCode && j.statusCode >= 400)
    throw new Error(`API ${j.statusCode}: ${typeof j.message === 'string' ? j.message : JSON.stringify(j.message).slice(0, 400)}`);
  return j;
}

async function main() {
  const words = loadWords();
  console.log(`词包：${words.length} 个词（广泛匹配）`);
  const today = new Date().toISOString().slice(0, 10);

  for (const job of JOBS) {
    const isSearch = job.kind === 'search';
    const actionName = job.action === 180 ? '激活' : '付费';

    // —— 623：全自动周期稳投（纯计划行，平台自动搭建组/创意）——
    if (job.kind === 'periodic') {
      const mats623 = await api('GET', `/api/plan/assets/videos?advertiserId=${job.id}`);
      const plan = planName({ tag: job.tag, batch: '系统优选', bidMode: '全自动', delivery: 'PERIODIC', action: job.action, date: DATE });
      const row = {
        rowNo: 1,
        advertiserId: job.id,
        campaignName: plan,
        campaignType: 2,
        adType: 0,
        autoManage: 1,
        unitName: plan,
        creativeName: `${plan}-创意`,
        periodicDeliveryType: 1,
        periodicDays: 7,
        rangeBudgetYuan: 3500,
        // 以下字段仅为通过本地校验（UAX 纯计划行不下发组/创意，平台自动搭建）
        bidType: 10,
        cpaBidYuan: job.action === 180 ? 10 : 150,
        ocpxActionType: job.action,
        sceneIds: [6],
        unitType: 4,
        beginTime: today,
        platformOs: 1,
        materialType: 1,
        actionBarText: ACTION_BAR,
        appId: APP.appId,
        packageId: APP.packageId,
        url: APK_URL,
        photoId: String((mats623[0] || {}).id || ''),
      };
      console.log(`\n=== ${job.tag} 全自动周期稳投 ${actionName} → ${plan}${DRY ? ' [DRY]' : ''}`);
      await submit(row, `附加1124·${job.tag}-稳投${actionName}`);
      continue;
    }

    const mats = await api('GET', `/api/plan/assets/videos?advertiserId=${job.id}`);
    const byName = new Map(mats.map((v) => [String(v.name || '').replace(/\.mp4$/i, '').trim(), v]));
    const allMaterials = mats.map((v) => ({ photoId: String(v.id), name: String(v.name || '').replace(/\.mp4$/i, '').trim() }));
    const pickByName = (names, label) => {
      const out = [];
      for (const n of names) {
        const v = byName.get(n);
        if (!v) console.warn(`  ⚠️ ${job.tag} 素材库缺「${n}」，跳过`);
        else out.push({ photoId: String(v.id), name: n });
      }
      console.log(`  ${label}: ${out.length}/${names.length} 条`);
      return out;
    };

    const common = (plan, campaignBidType = 0) => ({
      advertiserId: job.id,
      campaignName: plan,
      campaignType: 2,
      adType: isSearch ? 1 : 0,
      campaignDayBudgetYuan: 500,
      campaignBidType,
      searchQuick: isSearch ? null : 1,
      searchExtend: isSearch ? 1 : null,
      searchKeywords: isSearch ? words : null,
      searchMatchType: isSearch ? 3 : null,
      unitName: plan,
      sceneIds: isSearch ? [39] : [6],
      unitType: 4,
      beginTime: today,
      platformOs: 1,
      showMode: 2,
      materialType: 1,
      creativeNameSameAsMaterial: true,
      actionBarText: ACTION_BAR,
      creativeCategory: CATEGORY,
      creativeTags: TAGS,
      recommendation: REC,
      clickMonitorUrl: clickUrl(`kspzdj${job.tag}`),
      appId: APP.appId,
      packageId: APP.packageId,
      url: APK_URL,
      ...(isSearch ? {} : { outerLoopNative: 1, ...KOL }),
    });

    const makeUnits = (plan, materials) =>
      splitUnits(plan, materials).map((g, gi) => ({
        unitName: unitName(plan, gi),
        videos: g.materials.map((m, mi) => ({
          photoId: m.photoId,
          name: m.name,
          description: (g.unitIndex * 5 + mi) % 2 === 0 ? DESC_A : DESC_B,
        })),
      }));

    // —— 人群包计划（一包一计划）——
    // ⚠️ 2026-11-24 实测暂停：新账户唯一可见包 4030006「非目标用户人群包」是**仅排除包**
    // （平台 401000「population字段不能传仅用于排除人群包」），正向定向用不了；
    // 两个自建标签包（176932660/176932652）只在 618 可见，需平台侧人群共享后才能建。跳过。
    if (process.env.BUILD_POPULATION === '1') {
      const plan = planName({ tag: job.tag, batch: '全素材', bidMode: 'OCPX', delivery: 'POP', action: job.action, date: DATE });
      const row = {
        ...common(plan),
        rowNo: 1,
        bidType: 10,
        cpaBidYuan: job.bid,
        ocpxActionType: job.action,
        targeting: { population: [POP_ID] },
        photoId: allMaterials[0]?.photoId,
        creativeName: allMaterials[0]?.name || plan,
        units: makeUnits(plan, allMaterials),
      };
      console.log(`\n=== ${job.tag} 人群包 ${actionName} → ${plan}（包 ${POP_ID} / ${allMaterials.length} 素材 / ${unitCount(allMaterials.length)} 组）${DRY ? ' [DRY]' : ''}`);
      await submit(row, `附加1124·${job.tag}-人群包${actionName}`);
    }

    // —— 低成本复投计划（按各账户自身投放类型 OCPX 复投优质素材；2026-11-24 用户纠偏：不是 MCB）——
    {
      const plan = planName({ tag: job.tag, batch: '低成本', bidMode: 'OCPX', delivery: isSearch ? 'SEARCH' : 'NORMAL', action: job.action, date: DATE });
      const set = job.action === 180 ? ACT_LOW : PAY_LOW;
      const materials = pickByName(set, '低成本素材');
      const row = {
        ...common(plan),
        rowNo: 2,
        bidType: 10,
        cpaBidYuan: job.bid,
        ocpxActionType: job.action,
        photoId: materials[0]?.photoId,
        creativeName: materials[0]?.name || plan,
        units: makeUnits(plan, materials),
      };
      console.log(`\n=== ${job.tag} 低成本复投(MCB) ${actionName} → ${plan}（${materials.length} 素材 / ${unitCount(materials.length)} 组）${DRY ? ' [DRY]' : ''}`);
      await submit(row, `附加1124·${job.tag}-低成本${actionName}`);
    }
  }
}

async function submit(row, name) {
  try {
    const t = await api('POST', '/api/plan/tasks', { name, rows: [row], initialStatus: 'PAUSED', dryRun: DRY });
    if (DRY) {
      console.log(`  [DRY] 校验通过（${t.totalItems ?? '?'} 条目）`);
      return;
    }
    console.log(`  任务 #${t.id} 已创建：${t.totalItems} 条目`);
    await watchTask(t.id);
  } catch (e) {
    console.error(`  ❌ ${e.message}`);
  }
}

async function watchTask(id) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const t = await api('GET', `/api/plan/tasks/${id}`);
    if (['DONE', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(t.status)) {
      console.log(`  任务结束：${t.status} 成功 ${t.succeeded}/${t.totalItems} 失败 ${t.failed}`);
      for (const it of t.items || []) {
        if (it.status !== 'SUCCEEDED') console.log(`    [${it.status}] ${it.level} ${it.displayName} :: ${String(it.errorMessage || '').slice(0, 200)}`);
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
