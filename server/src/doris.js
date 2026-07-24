// Doris 连接层（mysql2，MySQL 协议直连 FE 9030）
//   - 按集群维护连接池（connectTimeout 5s），集群删除时销毁
//   - 只读查询封装：SHOW CATALOGS / DATABASES / TABLES / ALL GRANTS / GRANTS FOR / ROLES / PROPERTY
//   - 各版本列名差异容错
const mysql = require('mysql2/promise');
const store = require('./store');
const sqlgen = require('./sqlgen');
const config = require('./config');

// clusterId → mysql2 Pool
const pools = new Map();

// ---------------------------------------------------------------------------
// 连接池管理
// ---------------------------------------------------------------------------

/**
 * 取指定集群的连接池（惰性创建）
 * @param {{id:string, host:string, port:number, username:string, password:string}} cluster 已解密的集群信息
 */
function getPool(cluster) {
  let pool = pools.get(cluster.id);
  if (!pool) {
    pool = mysql.createPool({
      host: cluster.host,
      port: cluster.port || 9030,
      user: cluster.username,
      password: cluster.password,
      connectTimeout: config.DORIS_CONNECT_TIMEOUT,
      connectionLimit: 4,
      waitForConnections: true,
      queueLimit: 0,
      charset: 'utf8mb4',
      // 管理工具不需要多语句，保持关闭更安全
      multipleStatements: false,
    });
    pools.set(cluster.id, pool);
  }
  return pool;
}

/** 销毁指定集群的连接池（集群删除/连接信息变更时调用） */
async function destroyPool(clusterId) {
  const pool = pools.get(clusterId);
  if (pool) {
    pools.delete(clusterId);
    try {
      await pool.end();
    } catch (err) {
      // 销毁失败不影响主流程
      console.error(`[doris] 销毁连接池失败（${clusterId}）：${err.message}`);
    }
  }
}

/** 关闭全部连接池（进程退出前调用） */
async function closeAllPools() {
  const ids = [...pools.keys()];
  await Promise.all(ids.map((id) => destroyPool(id)));
}

// ---------------------------------------------------------------------------
// 集群信息解析（含密码解密）
// ---------------------------------------------------------------------------

/**
 * 根据集群 id 取出完整连接信息（密码已解密）
 * @returns 集群对象或 null
 */
function resolveCluster(clusterId) {
  const c = store.findCluster(clusterId);
  if (!c) return null;
  let password = '';
  try {
    password = store.decryptPassword(c.passwordEnc);
  } catch (err) {
    throw new Error(`集群「${c.name}」的密码解密失败：${err.message}`);
  }
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port || 9030,
    username: c.username,
    password,
  };
}

// ---------------------------------------------------------------------------
// 查询封装
// ---------------------------------------------------------------------------

/** 执行查询，返回 rows 数组 */
async function query(cluster, sql) {
  const pool = getPool(cluster);
  const [rows] = await pool.query(sql);
  return rows;
}

/** 执行查询，同时返回 fields（SQL 控制台需要列名） */
async function queryWithFields(cluster, sql) {
  const pool = getPool(cluster);
  const [rows, fields] = await pool.query(sql);
  return { rows, fields };
}

/**
 * 测试连接：返回 {ok:true, version, dorisVersion} 或 {ok:false, error}
 * 使用独立连接（不走池），避免污染池状态。
 * version 为 SELECT VERSION() 结果（协议兼容版本，真机多为 5.7.99）；
 * dorisVersion 为真实 Doris 版本：优先 SHOW FRONTENDS 的 Version 列（需要权限），
 * 失败或无权限时回退为 version。
 * @param {{host:string, port:number, username:string, password:string}} connInfo
 */
async function testConnection(connInfo) {
  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: connInfo.host,
      port: connInfo.port || 9030,
      user: connInfo.username,
      password: connInfo.password,
      connectTimeout: config.DORIS_CONNECT_TIMEOUT,
      charset: 'utf8mb4',
    });
    const [rows] = await conn.query('SELECT VERSION() AS version');
    const version = rows && rows[0] ? String(rows[0].version) : '';
    // 尝试取真实 Doris 版本（SHOW FRONTENDS 的 Version 列）；失败不影响连通性结论
    let dorisVersion = version;
    try {
      const [feRows] = await conn.query('SHOW FRONTENDS');
      if (Array.isArray(feRows) && feRows.length > 0) {
        const keys = Object.keys(feRows[0]);
        const verKey = keys.find((k) => /^version$/i.test(k));
        if (verKey && feRows[0][verKey]) {
          dorisVersion = String(feRows[0][verKey]);
        }
      }
    } catch (e) {
      // 无权限或版本不支持时静默回退 SELECT VERSION() 的结果
    }
    return { ok: true, version, dorisVersion };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch (e) {
        // 忽略关闭异常
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 列名容错工具
// ---------------------------------------------------------------------------

/**
 * 从行对象中按正则候选挑列值；都挑不到时退回第 index 列
 */
function pickColumn(row, patterns, fallbackIndex = 0) {
  const keys = Object.keys(row);
  for (const p of patterns) {
    const k = keys.find((key) => p.test(key));
    if (k !== undefined) return row[k];
  }
  if (keys.length > fallbackIndex) return row[keys[fallbackIndex]];
  if (keys.length > 0) return row[keys[0]];
  return undefined;
}

/** 把查询结果转成字符串名称列表（去空） */
function rowsToNameList(rows, patterns, fallbackIndex = 0) {
  const out = [];
  for (const row of rows || []) {
    const v = pickColumn(row, patterns, fallbackIndex);
    if (v != null && String(v) !== '') out.push(String(v));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 只读元数据查询（SPEC 6.5 / 6.6 / 6.7）
// ---------------------------------------------------------------------------

/** SHOW CATALOGS → ["internal", ...]（兼容列名差异：真机为 CatalogName，老版本为 Catalog） */
async function showCatalogs(cluster) {
  const rows = await query(cluster, 'SHOW CATALOGS');
  return rowsToNameList(rows, [/^catalog_?name$/i, /^catalog$/i, /^name$/i], 1);
}

/** SHOW DATABASES FROM `catalog` → ["db1", ...] */
async function showDatabases(cluster, catalog) {
  sqlgen.assertSafeName(catalog, 'Catalog 名');
  const rows = await query(cluster, `SHOW DATABASES FROM ${sqlgen.quoteIdent(catalog)}`);
  return rowsToNameList(rows, [/^database$/i, /^schema$/i], 0);
}

/** SHOW TABLES FROM `catalog`.`db` → ["t1", ...] */
async function showTables(cluster, catalog, db) {
  sqlgen.assertSafeName(catalog, 'Catalog 名');
  sqlgen.assertSafeName(db, '数据库名');
  const rows = await query(
    cluster,
    `SHOW TABLES FROM ${sqlgen.quoteIdent(catalog)}.${sqlgen.quoteIdent(db)}`
  );
  return rowsToNameList(rows, [/^tables[_ ]/i, /^table/i], 0);
}

/** SHOW ALL GRANTS → 原始行数组 */
async function showAllGrants(cluster) {
  return query(cluster, 'SHOW ALL GRANTS');
}

/** SHOW GRANTS FOR 'user'@'host' → 原始行数组 */
async function showGrantsFor(cluster, user, host) {
  sqlgen.assertSafeName(user, '用户名');
  sqlgen.assertSafeName(host, '来源地址 host');
  return query(cluster, `SHOW GRANTS FOR ${sqlgen.userIdent(user, host)}`);
}

/** SHOW PROPERTY FOR 'user' → 原始行数组 [{Key, Value}]
 *  真机探测：Doris 不支持 'user'@'host' 语法（报语法错误），只能按用户名查询 */
async function showPropertyFor(cluster, user) {
  sqlgen.assertSafeName(user, '用户名');
  return query(cluster, `SHOW PROPERTY FOR ${sqlgen.quoteString(user)}`);
}

/** SHOW ROLES → 原始行数组 */
async function showRoles(cluster) {
  return query(cluster, 'SHOW ROLES');
}

/** SHOW PRIVILEGES → 原始行数组 [{Privilege, Context, Comment}]（Doris 3.0.6 返回 12 行） */
async function showPrivileges(cluster) {
  return query(cluster, 'SHOW PRIVILEGES');
}

/** SHOW WORKLOAD GROUPS → ["normal", ...]（真机 3.0.6 返回列 [Id, Name, cpu_share, ...]，取 Name 列） */
async function showWorkloadGroups(cluster) {
  const rows = await query(cluster, 'SHOW WORKLOAD GROUPS');
  return rowsToNameList(rows, [/^name$/i, /^workload[_ ]?group/i], 1);
}

/** 降级数据源：SELECT User, Host FROM mysql.user */
async function mysqlUserFallback(cluster) {
  return query(cluster, 'SELECT `User`, `Host` FROM `mysql`.`user`');
}

module.exports = {
  resolveCluster,
  query,
  queryWithFields,
  testConnection,
  destroyPool,
  closeAllPools,
  showCatalogs,
  showDatabases,
  showTables,
  showAllGrants,
  showGrantsFor,
  showPropertyFor,
  showRoles,
  showPrivileges,
  showWorkloadGroups,
  mysqlUserFallback,
};
