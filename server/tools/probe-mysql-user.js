// 只读探针：对比 SHOW ALL GRANTS 中的用户 与 mysql.user 表内容
// 用法：DORIS_HOST=xxx DORIS_PWD=xxx node server/tools/probe-mysql-user.js
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DORIS_HOST || '127.0.0.1',
    port: Number(process.env.DORIS_PORT || 9030),
    user: process.env.DORIS_USER || 'admin',
    password: process.env.DORIS_PWD || '',
    connectTimeout: 8000,
  });

  const [cat] = await conn.query('SELECT CURRENT_CATALOG() AS c');
  console.log('当前 catalog:', JSON.stringify(cat));

  const [ver] = await conn.query('SELECT VERSION() AS v');
  console.log('Doris 版本:', JSON.stringify(ver));

  console.log('\n--- SHOW ALL GRANTS（用户身份列） ---');
  try {
    const [rows] = await conn.query('SHOW ALL GRANTS');
    const identities = rows.map((r) => r.UserIdentity || r[Object.keys(r)[0]]);
    console.log(`共 ${rows.length} 行:`, JSON.stringify(identities));
  } catch (e) {
    console.log('SHOW ALL GRANTS 失败:', e.message);
  }

  console.log('\n--- SELECT User, Host FROM mysql.user ---');
  try {
    const [rows] = await conn.query('SELECT `User`, `Host` FROM mysql.user');
    console.log(`共 ${rows.length} 行:`, JSON.stringify(rows));
  } catch (e) {
    console.log('查询失败:', e.message);
  }

  console.log('\n--- SELECT User, Host FROM internal.mysql.user（显式 internal catalog） ---');
  try {
    const [rows] = await conn.query('SELECT `User`, `Host` FROM internal.mysql.user');
    console.log(`共 ${rows.length} 行:`, JSON.stringify(rows));
  } catch (e) {
    console.log('查询失败:', e.message);
  }

  await conn.end();
}

main().catch((e) => {
  console.error('探针失败:', e.message);
  process.exit(1);
});
