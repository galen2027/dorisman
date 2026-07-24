// 逐条验证 Doris 权限相关语句在真机上的真实语法（对临时角色/用户操作，结束自动清理）
// 用法: node server/tools/verify-sql-syntax.js <host> <port> <user> <password>
const mysql = require('mysql2/promise');

const ROLE = 'tmp_syntax_check_role';
const USER = 'tmp_syntax_check_user';

async function trySql(conn, label, sql) {
  try {
    const [rows, fields] = await conn.query(sql);
    const cols = fields ? fields.map((f) => f.name).slice(0, 6).join(',') : '';
    console.log(`OK   ${label}\n     → ${Array.isArray(rows) ? rows.length + ' 行' : 'OK'}${cols ? ' 列[' + cols + ']' : ''}`);
    return true;
  } catch (e) {
    console.log(`FAIL ${label}\n     → ${e.message.split('\n')[0].slice(0, 150)}`);
    return false;
  }
}

(async () => {
  const [host, port, user, password] = process.argv.slice(2);
  const conn = await mysql.createConnection({ host, port: Number(port), user, password, connectTimeout: 10000 });

  console.log('===== 只读语句 =====');
  await trySql(conn, 'SHOW PRIVILEGES', 'SHOW PRIVILEGES');
  await trySql(conn, 'SHOW ROW POLICY', 'SHOW ROW POLICY');
  await trySql(conn, 'SHOW GRANTS FOR ROLE(引号)', `SHOW GRANTS FOR ROLE 'admin'`);
  await trySql(conn, 'SHOW GRANTS FOR ROLE(无引号)', 'SHOW GRANTS FOR ROLE admin');

  console.log('===== 角色语法（临时角色） =====');
  await trySql(conn, 'CREATE ROLE 引号+COMMENT', `CREATE ROLE IF NOT EXISTS '${ROLE}' COMMENT '语法验证'`);
  await trySql(conn, 'CREATE ROLE 无引号+COMMENT', `CREATE ROLE IF NOT EXISTS ${ROLE} COMMENT '语法验证'`);
  await trySql(conn, 'GRANT ... TO ROLE 引号', `GRANT SELECT_PRIV ON \`internal\`.\`mysql\`.* TO ROLE '${ROLE}'`);
  await trySql(conn, 'SHOW GRANTS FOR 临时角色', `SHOW GRANTS FOR ROLE '${ROLE}'`);
  await trySql(conn, 'REVOKE ... FROM ROLE 引号', `REVOKE SELECT_PRIV ON \`internal\`.\`mysql\`.* FROM ROLE '${ROLE}'`);
  await trySql(conn, 'DROP ROLE 引号', `DROP ROLE IF EXISTS '${ROLE}'`);
  await trySql(conn, 'DROP ROLE 无引号', `DROP ROLE IF EXISTS ${ROLE}`);

  console.log('===== 用户/密码语法（临时用户） =====');
  await trySql(conn, 'CREATE USER', `CREATE USER IF NOT EXISTS '${USER}'@'%' IDENTIFIED BY 'Tmp#2026abXY'`);
  await trySql(conn, "SET PASSWORD FOR = PASSWORD('...')", `SET PASSWORD FOR '${USER}'@'%' = PASSWORD('Tmp#2026cdXY')`);
  await trySql(conn, 'ALTER USER IDENTIFIED BY', `ALTER USER '${USER}'@'%' IDENTIFIED BY 'Tmp#2026efXY'`);
  await trySql(conn, 'DROP USER', `DROP USER IF EXISTS '${USER}'@'%'`);

  await conn.end();
})().catch((e) => { console.error('CONNECT_FAIL:', e.message); process.exit(2); });
