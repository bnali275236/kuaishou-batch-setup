/**
 * 解析 .lnk（MS-SHLLINK），打印结构，用于手写 lnk 时对齐真实格式。
 * 用法：node tools/lnk-dump.cjs "C:\path\to\file.lnk"
 */
const fs = require('fs');

const file = process.argv[2];
const b = fs.readFileSync(file);
console.log('文件大小', b.length);

const u16 = (o) => b.readUInt16LE(o);
const u32 = (o) => b.readUInt32LE(o);

const headerSize = u32(0);
const clsid = b.subarray(4, 20).toString('hex');
const flags = u32(20);
const fileAttr = u32(24);
const showCmd = u32(60);
console.log('HeaderSize', headerSize.toString(16), 'CLSID', clsid);
console.log('LinkFlags', '0x' + flags.toString(16), 'FileAttr', '0x' + fileAttr.toString(16), 'ShowCmd', showCmd);
const has = (bit) => (flags & bit) !== 0;
console.log('  HasTargetIDList', has(0x1), 'HasLinkInfo', has(0x2), 'HasName', has(0x4), 'HasRelPath', has(0x8), 'HasWorkDir', has(0x10), 'HasArgs', has(0x20), 'HasIcon', has(0x40), 'IsUnicode', has(0x80));

let pos = headerSize;

if (has(0x1)) {
  const idListSize = u16(pos);
  console.log('IDListSize', idListSize);
  const start = pos + 2;
  let p = start;
  const items = [];
  while (pos + 2 + (p - start) < start + idListSize) {
    const size = u16(p);
    if (size === 0) {
      items.push('TERM');
      p += 2;
      break;
    }
    const data = b.subarray(p, p + size);
    items.push(data.toString('hex'));
    p += size;
  }
  console.log('IDList items:');
  items.forEach((it, i) => console.log('  [' + i + ']', it.length > 200 ? it.slice(0, 200) + '…' : it));
  pos = start + idListSize;
}

if (has(0x2)) {
  const infoSize = u32(pos);
  const infoHeaderSize = u32(pos + 4);
  const infoFlags = u32(pos + 8);
  const volOff = u32(pos + 12);
  const baseOff = u32(pos + 16);
  const netOff = u32(pos + 20);
  const suffixOff = u32(pos + 24);
  console.log('LinkInfo size', infoSize, 'header', infoHeaderSize, 'flags', infoFlags);
  console.log('  volOff', volOff, 'baseOff', baseOff, 'netOff', netOff, 'suffixOff', suffixOff);
  const readCStr = (off) => {
    let e = off;
    while (b[e] !== 0 && e < pos + infoSize) e++;
    return b.subarray(off, e).toString('latin1');
  };
  if (infoFlags & 1) {
    console.log('  LocalBasePath:', JSON.stringify(readCStr(pos + baseOff)));
    console.log('  CommonPathSuffix:', JSON.stringify(readCStr(pos + suffixOff)));
    console.log('  VolumeIDSize:', u32(pos + volOff), 'label:', JSON.stringify(readCStr(pos + volOff + u32(pos + volOff + 12))));
  }
  if (infoHeaderSize >= 0x24) {
    console.log('  (has unicode offsets) baseOffU', u32(pos + 28), 'suffixOffU', u32(pos + 32));
  }
  pos += infoSize;
}

const readStrData = (isUni) => {
  const n = u16(pos);
  const raw = b.subarray(pos + 2, pos + 2 + n * (isUni ? 2 : 1));
  const s = isUni ? raw.toString('utf16le') : raw.toString('latin1');
  pos += 2 + n * (isUni ? 2 : 1);
  return s;
};
if (has(0x4)) console.log('NAME:', JSON.stringify(readStrData(has(0x80))));
if (has(0x8)) console.log('RELATIVE_PATH:', JSON.stringify(readStrData(has(0x80))));
if (has(0x10)) console.log('WORKING_DIR:', JSON.stringify(readStrData(has(0x80))));
if (has(0x20)) console.log('ARGUMENTS:', JSON.stringify(readStrData(has(0x80))));
if (has(0x40)) console.log('ICON_LOCATION:', JSON.stringify(readStrData(has(0x80))));

// ExtraData 尾块
console.log('剩余字节', b.length - pos, '前16:', b.subarray(pos, pos + 16).toString('hex'));
