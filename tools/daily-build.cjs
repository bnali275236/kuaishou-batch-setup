/* eslint-disable */
/**
 * 每日基建·跑量复投计划自动创建（09:40 定时任务调用）
 *
 * 流程：
 *  1. 从罗盘素材榜（近 7 天，全账户共享池）取复投池：激活≥3 且 CPA≤11，按消耗排序取 TOP 10
 *     （池子不够时放宽到 激活≥2 且 CPA≤13）
 *  2. 出价：基础 9 元；复投池平均 CPA ≤ 7 时提到 9.5 抢量（上限 10，绝不超）
 *  3. 每户各建 1 条「PZ38x-跑量复投-MMDD」：计划→组→创意链路，版位只传 [6] 上下滑大屏
 *  4. 当日已创建过同名任务则跳过（幂等）
 *  5. 提交后轮询任务结果，推送钉钉卡片
 *
 * 只做「上计划」，不动在跑计划、不改预算；关停/调价仍由人工按巡检告警处理。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const effects = require('./auto-effects.cjs');

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitor.config.json'), 'utf-8'));
const DRY = process.argv.includes('--dry');
const DWS_JS =
  process.env.DWS_JS ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.workbuddy/binaries/node/cli-connector-packages/node_modules/dingtalk-workspace-cli/bin/dws.js',
  );

const API = CFG.api;
const APP_ID = '2199178419318';
const PACKAGE_ID = '1099685944711';
const ACCOUNTS = [
  { id: '124276386', tag: '386' },
  { id: '124276387', tag: '387' },
];
const MONITOR_URLS = {
  124276386:
    'https://api-cb.pzds.com/api/third/ad/click/kuaishou?channel_tag=kuaishouapp386&apkType=0&imei=__IMEI2__&oaid=__OAID2__&ip=__IP__&ipv4=__IPV4__&ipv6=__IPV6__&adCallback=__CALLBACK__&adId=__AID__&dId=__DID__&dName=__DNAME__&clickTime=__TS__&idfa=__IDFA2__&androidId=__ANDROIDID2__&ua=__UA__&deviceType=__OS__&advertiserId=__ACCOUNTID__&adName=__UNITNAME__&creativeId=__CID__&model=__MODEL__&csite=__CSITE__&llsid=__LLSID__',
  124276387:
    'https://api-cb.pzds.com/api/third/ad/click/kuaishou?channel_tag=kuaishouapp387&apkType=0&imei=__IMEI2__&oaid=__OAID2__&ip=__IP__&ipv4=__IPV4__&ipv6=__IPV6__&adCallback=__CALLBACK__&adId=__AID__&dName=__DNAME__&clickTime=__TS__&idfa=__IDFA2__&androidId=__ANDROIDID2__&ua=__UA__&deviceType=__OS__&advertiserId=__ACCOUNTID__&adName=__UNITNAME__&creativeId=__CID__&model=__MODEL__&csite=__CSITE__&llsid=__LLSID__',
};

// 文案池：按素材主题轮换（与跑量计划保持一致口径）
const themeOf = (n) => {
  const s = String(n || '');
  if (s.includes('王者')) return 'wz';
  if (s.includes('和平') || s.includes('吃鸡')) return 'hp';
  if (s.includes('超自然')) return 'cs';
  if (s.includes('三角洲')) return 'gz';
  if (s.includes('光遇')) return 'gy';
  if (s.includes('无畏')) return 'wy';
  if (s.includes('蛋仔')) return 'dz';
  if (s.includes('原神')) return 'ys';
  return 'ty';
};
const COPY = {
  wz: ['王者账号低价直售，担保交易极速发货', '满级皮肤号白菜价，买号就上盼之账号', '现成王者号即买即玩，不想肝就来买', '皮肤多段位高的王者号，盼之白菜价出'],
  hp: ['和平精英账号低价直售，满配皮肤秒提号', '买和平精英号上盼之账号，担保交易安心', '满级和平精英账号白菜价，即买即上号', '和平精英账号全网低价，盼之售后包赔'],
  cs: ['超自然行动组账号低价出，秒发货包安心', '买超自然号上盼之，担保交易极速提号', '超自然账号白菜价，现号直售即买即玩', '超自然行动组高性价比号，盼之担保出'],
  gz: ['三角洲行动账号低价直售，秒发货可验号', '买三角洲号上盼之账号，担保交易放心', '满配三角洲账号白菜价，即买即上号', '三角洲账号全网低价，盼之售后包赔'],
  gy: ['光遇账号低价直售，稀有斗篷现号秒提', '买光遇号上盼之，担保交易安全放心', '光遇账号全网低价，售后包赔可验号'],
  wy: ['无畏契约账号低价出，满皮肤现货秒提', '买无畏契约号上盼之，担保交易极速发'],
  dz: ['蛋仔派对账号低价直售，稀有皮肤秒提号', '买蛋仔号上盼之，担保交易安全放心'],
  ys: ['原神账号低价直售，满命角色秒发货', '买原神号上盼之，担保交易可验号'],
  ty: ['游戏账号低价直售，担保交易极速发货', '买游戏账号上盼之，全网低价可验号', '热门游戏账号白菜价，现号直售秒提', '游戏账号折扣专场，盼之担保售后无忧'],
};
const cursor = new Map();
const descFor = (n) => {
  const t = themeOf(n);
  const p = COPY[t] ?? COPY.ty;
  const i = cursor.get(t) ?? 0;
  cursor.set(t, i + 1);
  return p[i % p.length];
};

const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);
const yuan = (n) => (n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2));

async function api(p, body) {
  const res = await fetch(API + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status} ${txt.slice(0, 200)}`);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`${p} → 非 JSON 响应`);
  }
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
  return { ok, out };
}

const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mmdd = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------------- 取复投池 ---------------- */
async function repoolList() {
  const now = new Date();
  const start = ymd(new Date(now.getTime() - 6 * 86400000));
  const end = ymd(new Date(now.getTime() - 86400000)); // 用 T-1 定稿口径
  const r = await api('/api/material/history', { startDate: start, endDate: end, granularity: 'TOTAL' });
  const raw = Array.isArray(r) ? r : r.rows || r.items || [];
  const mats = raw
    .map((m) => {
      const charge = Number(m.charge || 0);
      const activation = Number(m.activation || 0);
      return {
        photoId: String(m.photoId || ''),
        name: m.materialName || m.name || String(m.photoId || ''),
        charge,
        activation,
        cpa: activation > 0 ? charge / activation : null,
      };
    })
    .filter((m) => m.photoId);
  let pool = mats
    .filter((m) => m.activation >= 3 && m.cpa != null && m.cpa <= 11)
    .sort((a, b) => b.charge - a.charge)
    .slice(0, 10);
  let relaxed = false;
  if (pool.length < 4) {
    pool = mats
      .filter((m) => m.activation >= 2 && m.cpa != null && m.cpa <= 13)
      .sort((a, b) => b.charge - a.charge)
      .slice(0, 6);
    relaxed = true;
  }
  return { pool, relaxed, start, end };
}

/**
 * 罗盘共享池的 photoId 是按账户归属的：A 户的 photoId 传到 B 户会报 401000「视频不存在」。
 * 按账户分别拉素材榜，按素材名（去 .mp4、去重音差异）匹配出该账户自己的 photoId。
 * 返回 map: photoId -> { name, charge, activation, cpa }（该账户可用版本）
 */
async function accountPool(advertiserId, pool) {
  const r = await api('/api/material/history', {
    advertiserIds: [advertiserId],
    startDate: ymd(new Date(Date.now() - 29 * 86400000)), // 素材维度可回溯 6 个月，取 30 天足够覆盖
    endDate: ymd(new Date(Date.now() - 86400000)),
    granularity: 'TOTAL',
  });
  const raw = Array.isArray(r) ? r : r.rows || r.items || [];
  const norm = (n) => String(n || '').replace(/\.mp4$/i, '').trim();
  const byName = new Map();
  for (const m of raw) {
    const charge = Number(m.charge || 0);
    const activation = Number(m.activation || 0);
    const item = {
      photoId: String(m.photoId || ''),
      name: norm(m.materialName || m.name),
      charge,
      activation,
      cpa: activation > 0 ? charge / activation : null,
    };
    if (!item.photoId) continue;
    const prev = byName.get(item.name);
    if (!prev || item.charge > prev.charge) byName.set(item.name, item);
  }
  const out = [];
  const missing = [];
  for (const p of pool) {
    const hit = byName.get(norm(p.name));
    if (hit) out.push({ ...hit, refCharge: p.charge, refCpa: p.cpa });
    else missing.push(norm(p.name));
  }
  return { out, missing };
}

/* ---------------- 出价 ---------------- */
function bidFor(pool) {
  const withCpa = pool.filter((m) => m.cpa != null);
  const avg = withCpa.length ? withCpa.reduce((s, m) => s + m.cpa, 0) / withCpa.length : null;
  let bid = 9;
  if (avg != null && avg <= 7) bid = 9.5; // 池子质量好，小幅抢量
  bid = Math.min(bid, 10); // 硬上限
  return { bid, avgCpa: avg };
}

/* ---------------- 建行 ---------------- */
function buildRow(advertiserId, tag, rowNo, planName, today, bid, vids) {
  const videos = vids.map((v) => ({ photoId: v.photoId, name: v.name.replace(/\.mp4$/i, ''), description: descFor(v.name) }));
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

/* ---------------- 幂等：当日同名任务已存在则跳过 ---------------- */
async function alreadyDone(name) {
  try {
    const r = await api(`/api/plan/tasks?page=1&pageSize=20`);
    const list = r.items || r.list || (Array.isArray(r) ? r : []);
    return list.some((t) => t.name === name && ['RUNNING', 'SUCCESS', 'PARTIAL'].includes(String(t.status)));
  } catch {
    return false;
  }
}

/* ---------------- 主流程 ---------------- */
(async () => {
  const today = ymd();
  const suffix = mmdd();
  const taskName = `跑量复投-${suffix}（自动）`;
  log(`开始：${taskName}`);

  let pool, relaxed, rangeStr;
  try {
    const rp = await repoolList();
    pool = rp.pool;
    relaxed = rp.relaxed;
    rangeStr = `${rp.start} ~ ${rp.end}`;
  } catch (e) {
    log('素材榜拉取失败：' + e.message);
    pushDingtalk(`### 【快手基建】${suffix} 复投计划未创建\n\n- 素材榜拉取失败：${String(e.message).slice(0, 160)}\n- 请检查 7801 后端与代理 DNS（昨日出现过 198.18.x 劫持）`);
    process.exit(1);
  }

  if (pool.length === 0) {
    log('复投池为空，退出');
    pushDingtalk(`### 【快手基建】${suffix} 复投计划未创建\n\n- 近 7 天没有达标的复投素材（激活≥3 且 CPA≤11，放宽线也没够着）\n- 今日只靠已有计划跑量，建议人工补新素材`);
    process.exit(0);
  }

  if (await alreadyDone(taskName)) {
    log('今日任务已存在，跳过');
    process.exit(0);
  }

  const { bid, avgCpa } = bidFor(pool);
  log(`复投池 ${pool.length} 条（${relaxed ? '放宽线' : '标准线'}，${rangeStr}），平均 CPA ${yuan(avgCpa)}，出价 ${bid}`);

  // 逐账户解析自己的 photoId（共享池 photoId 按账户归属，不能跨户直用）
  const perAccount = [];
  for (const a of ACCOUNTS) {
    const { out, missing } = await accountPool(a.id, pool);
    log(`${a.tag} 可用 ${out.length} 条，缺 ${missing.length} 条：${missing.join(' / ') || '无'}`);
    perAccount.push({ acc: a, vids: out, missing });
  }
  const usable = perAccount.filter((x) => x.vids.length > 0);
  if (usable.length === 0) {
    log('两户都没有可用素材，退出');
    pushDingtalk(`### 【快手基建】${suffix} 复投计划未创建\n\n- 复投池素材在 386/387 素材库里都找不到（共 ${pool.length} 条）\n- 需要人工先把素材传进库，或等素材榜轮换`);
    process.exit(0);
  }

  const rows = usable.map((x, i) => buildRow(x.acc.id, x.acc.tag, i + 1, `PZ${x.acc.tag}-跑量复投-${suffix}`, today, bid, x.vids));
  const allMissing = perAccount.flatMap((x) => x.missing.map((m) => `${x.acc.tag}缺：${m}`));

  for (const r of rows) {
    log(`${r.advertiserId} ${r.campaignName}：${r.units[0].videos.length} 条素材 / 版位 [6] / 出价 ${r.cpaBidYuan}`);
  }

  if (DRY) {
    console.log('--- dry，不提交 ---');
    for (const v of pool) console.log(`  ${v.name.slice(0, 44)} · 消耗 ${yuan(v.charge)} · EXP ${v.activation} · CPA ${yuan(v.cpa)}`);
    process.exit(0);
  }

  const created = await api('/api/plan/tasks', { name: taskName, rows, initialStatus: 'RUNNING' });
  const taskId = created.id || created.taskId;
  log(`任务已创建 id=${taskId}，等待执行…`);

  // 轮询执行结果（最多 4 分钟）
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
  const failItems = (task.items || []).filter((x) => x.status === 'FAILED');
  log(`任务结束：${st} ${okN}/${totN}`);

  /* ---- 收尾自查①：参数与文案/素材主题一致性 ---- */
  const issues = [];
  for (const r of rows) {
    if (JSON.stringify(r.sceneIds) !== '[6]') issues.push(`${r.campaignName} 版位异常 ${JSON.stringify(r.sceneIds)}`);
    if (!(r.cpaBidYuan >= 8 && r.cpaBidYuan <= 10)) issues.push(`${r.campaignName} 出价越界 ${r.cpaBidYuan}`);
    if (r.ocpxActionType !== 180) issues.push(`${r.campaignName} ocpx 异常 ${r.ocpxActionType}`);
    for (const v of r.units[0].videos) {
      if (!(COPY[themeOf(v.name)] ?? COPY.ty).includes(v.description)) issues.push(`文案疑似错配：${v.name} ← ${v.description}`);
      if (!v.photoId) issues.push(`素材缺 photoId：${v.name}`);
    }
  }

  /* ---- 收尾自查②：把成功创建的计划再 RUN 一次（幂等保险，防「创建后暂停」压住） ---- */
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
        kind: 'BUILD', rule: '复投主力', date, hour: new Date().getHours(),
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
    `### 【快手基建】${suffix} 跑量复投已提交`,
    '',
    `- 任务「${taskName}」：**${['DONE', 'SUCCESS', 'SUCCEEDED'].includes(st) ? '✅ 全部成功' : st === 'PARTIAL' ? '⚠️ 部分失败' : '❌ ' + st}** ${okN}/${totN}`,
    `- 出价 **${bid} 元**（池均 CPA ${yuan(avgCpa)}）· 版位 [6] 上下滑 · ocpx 激活 180 · 安卓`,
    `- 复投池（近 7 天，激活≥3 且 CPA≤11${relaxed ? '，已放宽' : ''}）：`,
  ];
  pool.slice(0, 10).forEach((m, i) => lines.push(`  ${i + 1}. ${m.name.replace(/\.mp4$/i, '').slice(0, 34)} · 消耗 ${yuan(m.charge)} · CPA ${yuan(m.cpa)}`));
  if (allMissing.length) {
    lines.push('', '**本户素材库没有、未上**（共享池归属其他账户，需先传库）：');
    allMissing.slice(0, 8).forEach((m) => lines.push(`- ${m.slice(0, 40)}`));
  }
  if (failItems.length) {
    lines.push('', '**失败明细：**');
    failItems.slice(0, 6).forEach((f) => lines.push(`- ${f.displayName}：${String(f.error || '').slice(0, 80)}`));
  }
  lines.push('', issues.length ? `**⚠ 自查发现 ${issues.length} 个问题：**\n${issues.slice(0, 6).map((x) => `- ${x}`).join('\n')}` : '✅ 自查通过：版位/出价/ocpx/文案一致性/计划投放状态全部正常。');
  lines.push('', '出价 9–9.5 之间按池质量浮动，上限 10。观察期不做成本判定（激活<8 不判），巡检每小时自动盯。');
  pushDingtalk(lines.join('\n'));
  process.exit(['DONE', 'SUCCESS', 'SUCCEEDED', 'PARTIAL'].includes(st) ? 0 : 1);
})();
