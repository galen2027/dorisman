// 验证 Doris 3.0.6 的禁用用户与负载组授权语法（临时用户，结束自动清理）
// 用法: node server/tools/verify-lock-wg.js <host> <port> <user> <password>
const mysql = require('mysql2/promise');

const U = 'tmp_lock_check';

async function t(conn, label, sql) {
  try {
    const [rows, fields] = await conn.query(sql);
    const cols = fields ? fields.map((f) => f.name).slice(0, 8).join(',') : '';
    console.log(`OK   ${label}\n     → ${Array.isArray(rows) ? rows.length + ' 行' : 'OK'}${cols ? ' [' + cols + ']' : ''}`);
    if (label.includes('SHOW GRANTS') && rows[0]) console.log('     WorkloadGroupPrivs =', JSON.stringify(rows[0].WorkloadGroupPrivs));
    return true;
  } catch (e) {
    console.log(`FAIL ${label}\n     → ${e.message.split('\n')[0].slice(0, 160)}`);
    return false;
  }
}

(async () => {
  const [host, port, user, password] = process.argv.slice(2);
  const conn = await mysql.createConnection({ host, port: Number(port), user, password, connectTimeout: 10000 });

  await t(conn, 'SHOW WORKLOAD GROUPS', 'SHOW WORKLOAD GROUPS');
  await t(conn, '创建临时用户', `CREATE USER IF NOT EXISTS '${U}'@'%' IDENTIFIED BY 'Tmp#2026lock'`);

  console.log('--- 负载组授权 ---');
  await t(conn, "GRANT USAGE_PRIV ON WORKLOAD GROUP 'normal'", `GRANT USAGE_PRIV ON WORKLOAD GROUP 'normal' TO '${U}'@'%'`);
  await t(conn, 'SHOW GRANTS 看单元格格式', `SHOW GRANTS FOR '${U}'@'%'`);
  await t(conn, 'REVOKE 负载组', `REVOKE USAGE_PRIV ON WORKLOAD GROUP 'normal' FROM '${U}'@'%'`);

  console.log('--- 禁用用户 ---');
  await t(conn, 'ALTER USER ... ACCOUNT LOCK', `ALTER USER '${U}'@'%' ACCOUNT LOCK`);
  // 锁定后尝试用临时用户登录
  try {
    const c2 = await mysql.createConnection({ host, port: Number(port), user: U, password: 'Tmp#2026lock', connectTimeout: 5000 });
    await c2.end();
    console.log('FAIL 锁定后登录 → 竟然成功了');
  } catch (e) {
    console.log('OK   锁定后登录被拒 →', e.message.split('\n')[0].slice(0, 120));
  }
  await t(conn, 'ALTER USER ... ACCOUNT UNLOCK', `ALTER USER '${U}'@'%' ACCOUNT UNLOCK`);
  try {
    const c3 = await mysql.createConnection({ host, port: Number(port), user: U, password: 'Tmp#2026lock', connectTimeout: 5000 });
    await c3.end();
    console.log('OK   解锁后登录成功');
  } catch (e) {
    console.log('FAIL 解锁后登录 →', e.message.split('\n')[0].slice(0, 120));
  }
  await t(conn, '清理临时用户', `DROP USER IF EXISTS '${U}'@'%'`);
  await conn.end();
})().catch((e) => { console.error('CONNECT_FAIL:', e.message); process.exit(2); });
