// 开发调试工具：只读探测 Doris 集群权限相关语句的返回格式（用于兼容 3.x / 4.x 差异）
// 用法: node server/tools/probe-cluster.js <host> <port> <user> <password>
// 注意：本工具只执行只读 SHOW/SELECT/DESC 语句，不在集群上做任何变更。
const mysql = require('mysql2/promise');

const QUERIES = [
  ['version', 'SELECT VERSION() AS version'],
  ['current_user', 'SELECT CURRENT_USER() AS current_user'],
  ['catalogs', 'SHOW CATALOGS'],
  ['databases_internal', 'SHOW DATABASES FROM `internal`'],
  ['tables_mysql', 'SHOW TABLES FROM `internal`.`mysql`'],
  ['all_grants', 'SHOW ALL GRANTS'],
  ['roles', 'SHOW ROLES'],
  ['grants_admin', "SHOW GRANTS FOR 'admin'@'%'"],
  ['property_admin_host', "SHOW PROPERTY FOR 'admin'@'%'"],
  ['property_admin', 'SHOW PROPERTY FOR \'admin\''],
  ['password_policy_vars', "SHOW VARIABLES LIKE 'validate_password%'"],
  ['mysql_user_columns', 'DESC mysql.user'],
];

(async () => {
  const [host, port, user, password] = process.argv.slice(2);
  if (!host || !port || !user || !password) {
    console.error('usage: node probe-cluster.js <host> <port> <user> <password>');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host, port: Number(port), user, password, connectTimeout: 10000,
  });
  const out = {};
  for (const [name, sql] of QUERIES) {
    try {
      const [rows, fields] = await conn.query(sql);
      out[name] = {
        ok: true,
        columns: fields.map((f) => f.name),
        rowCount: rows.length,
        sample: rows.slice(0, 3),
      };
    } catch (e) {
      out[name] = { ok: false, error: e.message };
    }
  }
  await conn.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('CONNECT_FAIL:', e.message);
  process.exit(2);
});
