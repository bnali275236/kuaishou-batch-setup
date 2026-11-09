/* eslint-disable */
/**
 * 每日第二批（14:00）· 新素材测新
 *
 * 逻辑：
 *  1. 拉两户素材库（/api/plan/assets/videos，含 uploadTime / cost7d）
 *  2. 取「近 3 天上传 + 审核通过 + 从未上过任何计划」的片子，每户最多 5 条
 *  3. 有新片 → 每户建 1 条「PZ38x-新素材-MMDD」；没有 → 只推钉钉提醒
 *  4. 出价 9（新片不抢量，先拿学习期数据）；版位 [6]；ocpx 激活 180；安卓
 *
 * 一创意一素材？不——组内多条素材同组便于集中冷启动，与主力计划一致口径。
 * 但每条素材用各自主题的文案，便于归因时看素材名。
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

/** 已上过计划的 photoId（从本地任务库读 payload，跨账户全集） */
async function usedPhotoIds() {
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient({ datasources: { db: { url: 'file:' + DB } } });
  try {
    const items = await p.batchTaskItem.findMany({
      where: { level: 'CREATIVE' },
      select: { payloadJson: true, advertiserId: true },
    });
    const map = new Map(); // advertiserId -> Set(photoId)
    for (const it of items) {
      let pl;
      try {
        pl = JSON.parse(it.payloadJson || '{}');
      } catch {
        continue;
      }
      const ids = [];
      if (pl.photo_id) ids.push(String(pl.photo_id));
      for (const v of pl.creative_videos || pl.videos || []) if (v.photo_id) ids.push(String(v.photo_id));
      const set = map.get(it.advertiserId) || new Set();
      ids.forEach((x) => set.add(x));
      map.set(it.advertiserId, set);
    }
    return map;
  } finally {
    await p.$disconnect();
  }
}

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
  const taskName = `新素材-${suffix}（自动）`;
  const cutoff = Date.now() - 3 * 86400000;
  log(`开始：${taskName}`);

  if (await alreadyDone(taskName)) {
    log('今日已跑过，跳过');
    process.exit(0);
  }

  const used = await usedPhotoIds();
  const picked = [];

  for (const acc of ACCOUNTS) {
    let list;
    try {
      const r = await api(`/api/plan/assets/videos?advertiserId=${acc.id}`);
      list = Array.isArray(r) ? r : r.items || r.list || r.videos || [];
    } catch (e) {
      log(`${acc.tag} 素材库拉取失败：${e.message}`);
      picked.push({ acc, vids: [], err: String(e.message).slice(0, 100) });
      continue;
    }
    const usedSet = used.get(acc.id) || new Set();
    const fresh = list
      .filter((v) => {
        const t = v.uploadTime ? new Date(String(v.uploadTime).replace(' ', 'T')).getTime() : 0;
        return t >= cutoff && Number(v.status) === 1 && !usedSet.has(String(v.id));
      })
      .sort((a, b) => String(b.uploadTime || '').localeCompare(String(a.uploadTime || '')))
      .slice(0, 5)
      .map((v) => ({ photoId: String(v.id), name: v.name || String(v.id) }));
    log(`${acc.tag} 近 3 天新片可用 ${fresh.length} 条`);
    picked.push({ acc, vids: fresh });
  }

  const usable = picked.filter((x) => x.vids.length > 0);
  if (usable.length === 0) {
    log('无新素材，跳过建计划');
    const detail = picked.map((x) => `- ${x.acc.tag}：${x.err ? '拉取失败 ' + x.err : '近 3 天没有未上过计划的新片'}`).join('\n');
    pushDingtalk(`### 【快手基建·测新】${suffix} 无新素材\n\n${detail}\n\n今日 14:00 测新批次跳过，请编辑尽快出片。`);
    process.exit(0);
  }

  const rows = usable.map((x, i) => buildRow(x.acc.id, x.acc.tag, i + 1, `PZ${x.acc.tag}-新素材-${suffix}`, today, 9, x.vids));
  for (const r of rows) {
    log(`${r.advertiserId} ${r.campaignName}：${r.units[0].videos.length} 条 / 出价 9`);
    r.units[0].videos.forEach((v) => log(`   ${v.name.slice(0, 40)} ← ${v.photoId}`));
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
  const fails = (task.items || []).filter((x) => x.status === 'FAILED');
  log(`任务结束：${st} ${okN}/${totN}`);

  /* ---- 收尾自查①：参数与文案/素材主题一致性 ---- */
  const issues = [];
  for (const r of rows) {
    if (JSON.stringify(r.sceneIds) !== '[6]') issues.push(`${r.campaignName} 版位异常 ${JSON.stringify(r.sceneIds)}`);
    if (!(r.cpaBidYuan >= 8 && r.cpaBidYuan <= 10)) issues.push(`${r.campaignName} 出价越界 ${r.cpaBidYuan}`);
    for (const v of r.units[0].videos) {
      if (!(COPY[themeOf(v.name)] ?? COPY.ty).includes(v.description)) issues.push(`文案疑似错配：${v.name} ← ${v.description}`);
      if (!v.photoId) issues.push(`素材缺 photoId：${v.name}`);
    }
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
        kind: 'BUILD', rule: '新素材测新', date, hour: new Date().getHours(),
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
    `### 【快手基建·测新】${suffix} 新素材已上`,
    '',
    `- 任务「${taskName}」：**${['DONE', 'SUCCESS', 'SUCCEEDED'].includes(st) ? '✅ 全部成功' : '⚠️ ' + st}** ${okN}/${totN}`,
    `- 出价 9 元 · 版位 [6] 上下滑 · ocpx 激活 180 · 安卓`,
  ];
  for (const r of rows) {
    lines.push(`- ${r.advertiserId} ${r.campaignName}：${r.units[0].videos.length} 条`);
    r.units[0].videos.forEach((v) => lines.push(`  · ${v.name.slice(0, 34)}`));
  }
  if (fails.length) {
    lines.push('', '**失败明细：**');
    fails.slice(0, 6).forEach((f) => lines.push(`- ${f.displayName}：${String(f.error || '').slice(0, 70)}`));
  }
  lines.push('', issues.length ? `**⚠ 自查发现 ${issues.length} 个问题：**\n${issues.slice(0, 6).map((x) => `- ${x}`).join('\n')}` : '✅ 自查通过：版位/出价/文案一致性/计划投放状态全部正常。');
  lines.push('', '测新计划给 4 小时观察，16:00 看曝光：<1000 提价 10–15%，0 点击的直接关停。');
  pushDingtalk(lines.join('\n'));
  process.exit(['DONE', 'SUCCESS', 'SUCCEEDED', 'PARTIAL'].includes(st) ? 0 : 1);
})();
