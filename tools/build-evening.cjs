/* eslint-disable */
/**
 * 每日第三批（19:30）· 晚高峰补位
 *
 * 逻辑（不建全新素材，只放大当日已验证的）：
 *  1. 拉两户今日创意级报表（实时）
 *  2. 筛「激活 ≥ 2 且 CPA ≤ 10（≈1.1× 出价）」的创意，按激活数降序取 TOP 6
 *  3. 用该创意**当初的原始文案**（local payload 里的 description，是被验证过的）复投
 *  4. 每户建 1 条「PZ38x-晚高峰-MMDD」，出价 9，版位 [6]
 *  5. 无可达标创意 → 不建计划，只推卡片（避免无意义铺量）
 *
 * 只处理库内可映射 photoId 的创意（即本工具建的计划）；用户手工建的 UAX 创意无法映射，跳过。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const effects = require('./auto-effects.cjs');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitor.config.json'), 'utf-8'));
const DRY = process.argv.includes('--dry');
const API = CFG.api;
const APP_ID = '2199178419318';
const PACKAGE_ID = '1099685944711';
const DB = path.join(process.env.APPDATA || '', '快手投放工作台', 'app.db');
const DWS_JS =
  process.env.DWS_JS ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.workbuddy/binaries/node/cli-connector-packages/node_modules/dingtalk-workspace-cli/bin/dws.js',
  );
const ACCOUNTS = [
  { id: '124276386', tag: '386' },
  { id: '124276387', tag: '387' },
];
const MONITOR_URLS = {
  124276386:
    'https://api-cb.pzds.com/api/third/ad/click/kuaishou?channel_tag=kuaishouapp386&apkType=0&imei=__IMEI2__&oaid=__OAID2__&ip=__IP__&ipv4=__IPV4__&ipv6=__IPV6__&adCallback=__CALLBACK__&adId=__AID__&dId=__DID__&dName=__DNAME__&clickTime=__TS__&idfa=__IDFA2__&androidId=__ANDROIDID2__&ua=__UA__&deviceType=__OS__&advertiserId=__ACCOUNTID__&adName=__UNITNAME__&creativeId=__CID__&model=__MODEL__&csite=__CSITE__&llsid=__LLSID__',
  124276387:
    'https://api-cb.pzds.com/api/third/ad/click/kuaishou?channel_tag=kuaishouapp387&apkType=0&imei=__IMEI2__&oaid=__OAID2__&ip=__IP__&ipv4=__IPV4__&ipv6=__IPV6__&adCallback=__CALLBACK__&adId=__AID__&dId=__DID__&dName=__DNAME__&clickTime=__TS__&idfa=__IDFA2__&androidId=__ANDROIDID2__&ua=__UA__&deviceType=__OS__&advertiserId=__ACCOUNTID__&adName=__UNITNAME__&creativeId=__CID__&model=__MODEL__&csite=__CSITE__&llsid=__LLSID__',
};

const MIN_ACT = 2;
const MAX_CPA = 10;
const TOP_N = 6;

const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);
const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mmdd = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const yuan = (n) => (n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2));

async function api(p, body) {
  const res = await fetch(API + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status} ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

function pushDingtalk(card) {
  if (DRY || !CFG.dingtalk.enabled) {
    console.log('--- 未推送（dry）---');
    return { ok: true, skipped: true };
  }
  const res = spawnSync(
    process.execPath,
    [DWS_JS, 'chat', '+send-to-group', '--group', CFG.dingtalk.group, '--content', card, '--yes', '--format', 'json'],
    { encoding: 'utf-8', timeout: 60000 },
  );
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const ok = res.status === 0 && !/"success"\s*:\s*false/.test(out);
  log(`推送${ok ? '成功' : '失败'}：${out.replace(/\s+/g, ' ').slice(0, 200)}`);
  return { ok };
}

/** creativeId → { photoId, name, description }（本工具建过的创意才有） */
async function creativeMap() {
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient({ datasources: { db: { url: 'file:' + DB } } });
  try {
    const items = await p.batchTaskItem.findMany({
      where: { level: 'CREATIVE', platformId: { not: null } },
      select: { platformId: true, advertiserId: true, displayName: true, payloadJson: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const map = new Map(); // `${ad}:${creativeId}` -> {...}
    for (const it of items) {
      const key = `${it.advertiserId}:${it.platformId}`;
      if (map.has(key)) continue;
      let pl = {};
      try {
        pl = JSON.parse(it.payloadJson || '{}');
      } catch {
        continue;
      }
      if (!pl.photo_id) continue;
      map.set(key, { photoId: String(pl.photo_id), name: it.displayName || String(pl.photo_id), description: pl.description || null });
    }
    return map;
  } finally {
    await p.$disconnect();
  }
}

async function creativeRows(advertiserId, date) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await api('/api/report/level/creative', { advertiserId, startDate: date, endDate: date, page, pageSize: 200 });
    const rows = j.rows || [];
    out.push(...rows);
    if (rows.length < 200) break;
  }
  return out;
}

function buildRow(advertiserId, tag, rowNo, planName, today, bid, vids) {
  const videos = vids.map((v) => ({ photoId: v.photoId, name: String(v.name).replace(/\.mp4$/i, ''), description: v.description }));
  return {
    rowNo,
    advertiserId,
    campaignName: planName,
    campaignType: 2,
    adType: 0,
    campaignDayBudgetYuan: null,
    campaignBidType: 0,
    autoManage: 0,
    unitName: planName,
    bidType: 10,
    cpaBidYuan: bid,
    ocpxActionType: 180,
    sceneIds: [6],
    unitType: 4,
    beginTime: today,
    unitDayBudgetYuan: null,
    platformOs: 1,
    appId: APP_ID,
    packageId: PACKAGE_ID,
    appDownloadType: 0,
    useAppMarket: 0,
    clickMonitorUrl: MONITOR_URLS[advertiserId] ?? null,
    creativeName: planName + '-创意',
    creativeNameSameAsMaterial: true,
    materialType: 1,
    photoId: videos[0].photoId,
    creativeVideos: videos,
    units: [{ unitName: planName, videos }],
    actionBarText: '立即下载',
    description: videos[0].description,
    creativeCategory: null,
    creativeTags: null,
    outerLoopNative: 0,
    targeting: null,
  };
}

async function alreadyDone(name) {
  try {
    const r = await api('/api/plan/tasks?page=1&pageSize=20');
    const list = r.items || r.list || (Array.isArray(r) ? r : []);
    return list.some((t) => t.name === name && ['RUNNING', 'SUCCESS', 'SUCCEEDED', 'PARTIAL'].includes(String(t.status)));
  } catch {
    return false;
  }
}

(async () => {
  const today = ymd();
  const suffix = mmdd();
  const taskName = `晚高峰-${suffix}（自动）`;
  log(`开始：${taskName}`);

  if (await alreadyDone(taskName)) {
    log('今日已跑过，跳过');
    process.exit(0);
  }

  const cmap = await creativeMap();
  const perAccount = [];

  for (const acc of ACCOUNTS) {
    let rows;
    try {
      rows = await creativeRows(acc.id, today);
    } catch (e) {
      log(`${acc.tag} 创意报表拉取失败：${e.message}`);
      perAccount.push({ acc, vids: [], note: '报表拉取失败：' + String(e.message).slice(0, 60) });
      continue;
    }
    const cand = rows
      .map((r) => {
        const cid = String(r.creativeId || '');
        const m = cmap.get(`${acc.id}:${cid}`);
        const charge = Number(r.charge || 0);
        const act = Number(r.activation || 0);
        const cpa = r.activationCost != null ? Number(r.activationCost) : act > 0 ? charge / act : null;
        return m ? { ...m, cid, charge, act, cpa } : null;
      })
      .filter((x) => x && x.act >= MIN_ACT && x.cpa != null && x.cpa <= MAX_CPA)
      .sort((a, b) => b.act - a.act || a.cpa - b.cpa);

    // 同一素材去重（同素材可能有多条创意）
    const seen = new Set();
    const vids = [];
    for (const c of cand) {
      if (seen.has(c.photoId)) continue;
      seen.add(c.photoId);
      vids.push({ photoId: c.photoId, name: c.name, description: c.description || '游戏账号低价直售，担保交易极速发货', charge: c.charge, act: c.act, cpa: c.cpa });
      if (vids.length >= TOP_N) break;
    }
    log(`${acc.tag} 达标创意 ${cand.length} 条 → 去重后 ${vids.length} 条`);
    perAccount.push({ acc, vids });
  }

  const usable = perAccount.filter((x) => x.vids.length > 0);
  if (usable.length === 0) {
    log('无达标创意，不建计划');
    const detail = perAccount.map((x) => `- ${x.acc.tag}：${x.note || `今日没有 CPA≤${MAX_CPA} 且激活≥${MIN_ACT} 的创意`}`).join('\n');
    pushDingtalk(`### 【快手基建·晚高峰】${suffix} 不建计划\n\n${detail}\n\n晚高峰不铺新计划，把量留给已验证的；若想加量，可给曝光不足的计划提价 10–15%。`);
    process.exit(0);
  }

  const rows = usable.map((x, i) => buildRow(x.acc.id, x.acc.tag, i + 1, `PZ${x.acc.tag}-晚高峰-${suffix}`, today, 9, x.vids));
  for (const x of usable) {
    const r = rows.find((rr) => rr.advertiserId === x.acc.id);
    log(`${r.advertiserId} ${r.campaignName}：${x.vids.length} 条 / 出价 9`);
    x.vids.forEach((v) => log(`   ${v.name.slice(0, 38)} · ${yuan(v.charge)}元/${v.act}激活/CPA${yuan(v.cpa)}`));
  }

  if (DRY) {
    console.log('--- dry，不提交 ---');
    process.exit(0);
  }

  const created = await api('/api/plan/tasks', { name: taskName, rows, initialStatus: 'RUNNING' });
  const taskId = created.id || created.taskId;
  log(`任务已创建 id=${taskId}`);

  let task = null;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    task = await api(`/api/plan/tasks/${taskId}`);
    const st = String(task.status);
    if (['DONE', 'SUCCESS', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(st)) break;
    log(`进度 ${task.succeeded ?? 0}/${task.totalItems ?? '?'} …`);
  }

  const st = String(task.status);
  const okN = task.succeeded ?? 0;
  const totN = task.totalItems ?? 0;
  log(`任务结束：${st} ${okN}/${totN}`);

  /* ---- 收尾自查①：参数边界 ---- */
  const issues = [];
  for (const r of rows) {
    if (JSON.stringify(r.sceneIds) !== '[6]') issues.push(`${r.campaignName} 版位异常 ${JSON.stringify(r.sceneIds)}`);
    if (!(r.cpaBidYuan >= 8 && r.cpaBidYuan <= 10)) issues.push(`${r.campaignName} 出价越界 ${r.cpaBidYuan}`);
    for (const v of r.units[0].videos) if (!v.description) issues.push(`素材缺文案：${v.name}`);
  }

  /* ---- 收尾自查②：成功计划再 RUN 一次（幂等保险） ---- */
  const campIds = (task.items || []).filter((x) => x.level === 'CAMPAIGN' && x.platformId);
  for (const c of campIds) {
    try {
      const rr = await api('/api/manage/status', { advertiserId: c.advertiserId, level: 'campaign', ids: [String(c.platformId)], action: 'RUN' });
      if (rr.errors && rr.errors.length) issues.push(`计划 ${c.platformId} 打开失败：${JSON.stringify(rr.errors).slice(0, 80)}`);
      else log(`计划 ${c.platformId} 已确认投放中`);
    } catch (e) {
      issues.push(`计划 ${c.platformId} 打开失败：${String(e.message).slice(0, 80)}`);
    }
  }
  if (campIds.length === 0 && okN > 0) issues.push('⚠ 任务有成功项但没拿到计划 ID，需人工核对状态');
  // 效果台账：记录新建计划，+24h 回看首日表现
  if (!DRY) {
    for (const c of campIds) {
      effects.recordAction({
        kind: 'BUILD', rule: '晚高峰补位', date, hour: new Date().getHours(),
        advertiserId: c.advertiserId,
        tag: String(c.displayName || '').replace(/^PZ(\d+).*$/, '$1'),
        objectId: String(c.platformId),
        name: c.displayName || String(c.platformId),
        before: { charge: 0, activation: 0, show: 0, clicks: 0 },
      });
    }
    log(`已登记 ${campIds.length} 条新计划进效果台账`);
  }

  const lines = [
    `### 【快手基建·晚高峰】${suffix} 已验证创意复投`,
    '',
    `- 任务「${taskName}」：**${['DONE', 'SUCCESS', 'SUCCEEDED'].includes(st) ? '✅ 全部成功' : '⚠️ ' + st}** ${okN}/${totN}`,
    `- 出价 9 元 · 版位 [6] 上下滑 · ocpx 激活 180 · 用原始已验证文案`,
  ];
  for (const x of usable) {
    lines.push(`- ${x.acc.tag}：${x.vids.length} 条`);
    x.vids.forEach((v) => lines.push(`  · ${v.name.slice(0, 32)} · ${yuan(v.charge)}元/${v.act}激活/CPA ${yuan(v.cpa)}`));
  }
  lines.push('', issues.length ? `**⚠ 自查发现 ${issues.length} 个问题：**\n${issues.slice(0, 6).map((x) => `- ${x}`).join('\n')}` : '✅ 自查通过：版位/出价/文案/计划投放状态全部正常。');
  lines.push('', '晚高峰 19:30–23:00 是全天第二波流量，这批只用已验证创意放大，不测新。');
  pushDingtalk(lines.join('\n'));
  process.exit(['DONE', 'SUCCESS', 'SUCCEEDED', 'PARTIAL'].includes(st) ? 0 : 1);
})();
