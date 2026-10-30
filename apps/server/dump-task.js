process.chdir('D:/工作/wkbd快手工作台/apps/server');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const tables = await p.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('tables:', JSON.stringify(tables));
  const items = await p.$queryRawUnsafe(
    "SELECT id, displayName, errorMessage, payloadJson FROM TaskItem WHERE status='FAILED' AND level='CREATIVE' ORDER BY id DESC LIMIT 2",
  );
  for (const it of items) {
    console.log('=== item', it.id, it.displayName, '===');
    console.log('errMsg:', String(it.errorMessage || '').slice(0, 300));
    console.log('payload:', it.payloadJson);
  }
  const unit = await p.$queryRawUnsafe(
    "SELECT id, displayName, payloadJson FROM TaskItem WHERE status='SUCCESS' AND level='UNIT' ORDER BY id DESC LIMIT 1",
  );
  for (const u of unit) {
    console.log('=== unit', u.id, u.displayName, '===');
    console.log('payload:', u.payloadJson);
  }
  await p.$disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
