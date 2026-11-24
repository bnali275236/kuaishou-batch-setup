/**
 * 搜索词包灌词工具（细则 1124：信息流搜索快投 + 搜索账户统一用同一词包）。
 *
 * 用法：
 *   node tools/search-words.cjs --unit <unitId> [--advertiser 130483621] [--file <xlsx>] [--dry]
 *
 * 行为：
 *   1. 解析搜索词 xlsx（sheet「关键词上传」，列：关键词 / 匹配方式）
 *   2. 调后端 /api/manage/word-create（v2/word_info/create）批量灌词，单次 ≤1000
 *   3. 打印成功 / 失败明细；--dry 只解析不发送
 *
 * 匹配方式映射：精确匹配→1 短语匹配→2 广泛匹配→3（空/未知默认 3 广泛）
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const XLSX = require(path.join(ROOT, 'node_modules/xlsx'));
const DEFAULT_FILE = 'D:/.A/盼之电竞/剪辑素材/搜索词/template_v1.24b7784fcc80d6c0.xlsx';
const BASE = process.env.WKB_BASE || 'http://127.0.0.1:7801';

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    unit: get('--unit'),
    advertiser: get('--advertiser') || '130483618',
    file: get('--file') || DEFAULT_FILE,
    dry: argv.includes('--dry'),
  };
}

/** 匹配方式中文 → 平台枚举 */
function matchTypeOf(text) {
  const t = String(text || '').trim();
  if (t.includes('精确')) return 1;
  if (t.includes('短语')) return 2;
  return 3; // 广泛 / 空 / 未知
}

function parseWords(file) {
  const wb = XLSX.readFile(file);
  const sn = wb.SheetNames.find((n) => n.includes('关键词上传')) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
  const words = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const word = String(row[0] || '').trim();
    if (!word || /示例/.test(word)) continue; // 跳过空行和模板示例
    if (word.length > 20) {
      console.log(`[跳过] 超过 20 字：${word.slice(0, 26)}…`);
      continue;
    }
    words.push({ word, matchType: matchTypeOf(row[1]) });
  }
  // 去重（同词不同匹配方式以第一次出现为准）
  const seen = new Set();
  const uniq = words.filter((w) => (seen.has(w.word) ? false : (seen.add(w.word), true)));
  return { sheet: sn, words: uniq };
}

(async () => {
  const args = parseArgs();
  if (!args.unit && !args.dry) {
    console.log('用法：node tools/search-words.cjs --unit <组ID> [--advertiser 130483621] [--file <xlsx>] [--dry]');
    process.exit(1);
  }
  const { sheet, words } = parseWords(args.file);
  const byType = { 1: 0, 2: 0, 3: 0 };
  for (const w of words) byType[w.matchType] += 1;
  console.log(`词包：${args.file}`);
  console.log(`sheet「${sheet}」共 ${words.length} 词（精确 ${byType[1]} / 短语 ${byType[2]} / 广泛 ${byType[3]}）`);
  if (args.dry) {
    console.log('前 10 词：', words.slice(0, 10).map((w) => `${w.word}(${w.matchType})`).join('、'));
    console.log('--dry 模式，不发送');
    return;
  }
  const r = await fetch(`${BASE}/api/manage/word-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ advertiserId: args.advertiser, unitId: args.unit, words }),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { console.log('HTTP', r.status, text.slice(0, 400)); process.exit(1); }
  if (j.message && !j.total) { console.log('失败：', j.message); process.exit(1); }
  console.log(`灌词完成：成功 ${j.successCount}/${j.total}`);
  if (j.failed?.length) {
    console.log('失败明细：');
    for (const f of j.failed.slice(0, 20)) console.log(`  · ${f.word} → ${f.error || '未知原因'}`);
    if (j.failed.length > 20) console.log(`  …共 ${j.failed.length} 条失败`);
  }
})();
