// SQL 生成器（纯函数模块，无 IO，便于单元测试）
// 依据 SPEC 5.2 / 5.3：
//   - 所有函数返回 SQL 字符串数组（一个操作可能展开成多条）
//   - 标识符用反引号包裹，反引号转义为双反引号
//   - 字符串值中的 ' 转义为 \'，\ 转义为 \\
//   - 用户名、host、库表名只允许 [A-Za-z0-9_$.%-] 等安全字符，先校验再生成 —— 防注入第一关
//   - 授权层级：global / catalog / database / table / resource

// ---------------------------------------------------------------------------
// 常量定义
// ---------------------------------------------------------------------------

// 用户名 / host / 库表名 / 角色名 允许的安全字符（SPEC 5.3 第 6 条）
const SAFE_NAME_RE = /^[A-Za-z0-9_$.%-]+$/;

// 权限名格式（用于 REVOKE 等场景的宽松校验）
const PRIV_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// CREATE/DROP ROLE 的角色名是裸标识符（不能带引号，真机 Doris 3.0.6 已验证）：
// 严格校验——字母开头，仅允许 [A-Za-z0-9_$]，非法直接抛错（注入防线）
const ROLE_IDENT_RE = /^[A-Za-z][A-Za-z0-9_$]*$/;

// 各层级可用的权限项（SPEC 5.1）
const COMMON_PRIVS = [
  'SELECT_PRIV',
  'LOAD_PRIV',
  'ALTER_PRIV',
  'CREATE_PRIV',
  'DROP_PRIV',
  'SHOW_VIEW_PRIV',
  'GRANT_PRIV',
];
const GLOBAL_ONLY_PRIVS = ['ADMIN_PRIV']; // 仅全局
const RESOURCE_PRIVS = ['USAGE_PRIV'];    // 仅 RESOURCE 层级
const WORKLOAD_GROUP_PRIVS = ['USAGE_PRIV']; // 仅 WORKLOAD GROUP 层级（真机 Doris 3.0.6 已验证）

const LEVELS = ['global', 'catalog', 'database', 'table', 'resource', 'workload_group'];
// 解析器能产出、但编辑器不支持修改的层级（计算组/存储库）：
// 出现在"当前已有"集合时直接忽略（永不生成对应 SQL），出现在期望集合时报错
const READONLY_LEVELS = ['compute_group', 'storage_vault'];

// ---------------------------------------------------------------------------
// 基础工具：校验与转义
// ---------------------------------------------------------------------------

/**
 * 校验名称是否只含安全字符，非法直接抛错（防注入第一关）
 * @param {string} name 待校验名称
 * @param {string} label 中文标签，用于报错信息
 */
function assertSafeName(name, label) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label}不能为空`);
  }
  if (name.length > 128) {
    throw new Error(`${label}长度不能超过 128 个字符`);
  }
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`${label}含有非法字符（仅允许字母、数字、_ $ . % -）：${name}`);
  }
}

/**
 * 校验 CREATE/DROP ROLE 用的角色标识符（比 assertSafeName 更严格：
 * 角色名在 CREATE/DROP ROLE 语句中是裸标识符，不能靠引号转义兜底，
 * 必须字母开头且只含 [A-Za-z0-9_$]，非法直接抛错 —— 注入防线）
 * @param {string} role 角色名
 * @returns {string} 校验通过的原角色名
 */
function assertRoleIdent(role) {
  if (typeof role !== 'string' || role.length === 0) {
    throw new Error('角色名不能为空');
  }
  if (role.length > 128) {
    throw new Error('角色名长度不能超过 128 个字符');
  }
  if (!ROLE_IDENT_RE.test(role)) {
    throw new Error(`角色名含有非法字符（CREATE/DROP ROLE 要求字母开头的标识符，仅允许字母、数字、_ $）：${role}`);
  }
  return role;
}

/**
 * 标识符加反引号，内部反引号转义为双反引号
 * @param {string} ident 标识符
 * @returns {string} 如 `db_name`
 */
function quoteIdent(ident) {
  return '`' + String(ident).replace(/`/g, '``') + '`';
}

/**
 * 字符串字面量加单引号，\ 转义为 \\，' 转义为 \'
 * @param {string} value 字符串值
 * @returns {string} 如 'it\'s'
 */
function quoteString(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * 生成 'user'@'host' 形式的用户标识字面量
 */
function userIdent(user, host) {
  return `${quoteString(user)}@${quoteString(host)}`;
}

// ---------------------------------------------------------------------------
// 授权项规范化
// ---------------------------------------------------------------------------

/**
 * 返回指定层级允许的权限集合
 */
function allowedPrivsForLevel(level) {
  if (level === 'resource') return RESOURCE_PRIVS;
  if (level === 'workload_group') return WORKLOAD_GROUP_PRIVS;
  if (level === 'global') return COMMON_PRIVS.concat(GLOBAL_ONLY_PRIVS);
  return COMMON_PRIVS;
}

/**
 * 规范化并校验一条授权项（来自用户输入，严格校验）
 * 输入结构：{ level, catalog, database, table, resource, privileges, grantOption }
 * @returns 规范化后的授权项（privileges 去重排序）
 */
function normalizeGrant(item) {
  if (!item || typeof item !== 'object') {
    throw new Error('授权项格式错误');
  }
  const level = String(item.level || '').toLowerCase();
  if (READONLY_LEVELS.includes(level)) {
    throw new Error(`授权层级 ${level}（计算组/存储库）暂不支持在编辑器中修改`);
  }
  if (!LEVELS.includes(level)) {
    throw new Error(`未知的授权层级：${item.level}`);
  }
  const g = {
    level,
    catalog: null,
    database: null,
    table: null,
    resource: null,
    workloadGroup: null,
    privileges: [],
    grantOption: !!item.grantOption,
  };
  // 按层级校验必填字段与安全字符
  if (level === 'catalog' || level === 'database' || level === 'table') {
    assertSafeName(item.catalog, 'Catalog 名');
    g.catalog = item.catalog;
  }
  if (level === 'database' || level === 'table') {
    assertSafeName(item.database, '数据库名');
    g.database = item.database;
  }
  if (level === 'table') {
    assertSafeName(item.table, '表名');
    g.table = item.table;
  }
  if (level === 'resource') {
    const name = item.resource === undefined || item.resource === null ? '*' : String(item.resource);
    if (name !== '*') assertSafeName(name, '资源名');
    g.resource = name;
  }
  if (level === 'workload_group') {
    assertSafeName(item.workloadGroup, '负载组名');
    g.workloadGroup = item.workloadGroup;
    // 真机未验证 WITH GRANT OPTION 对负载组的支持，拒绝以免生成未验证语法
    if (item.grantOption) {
      throw new Error('负载组授权不支持 WITH GRANT OPTION');
    }
  }
  // 权限校验：非空、格式正确、且属于当前层级可用项
  if (!Array.isArray(item.privileges) || item.privileges.length === 0) {
    throw new Error('授权项至少需要选择一个权限');
  }
  const allowed = allowedPrivsForLevel(level);
  const privs = [];
  for (const p of item.privileges) {
    const priv = String(p).toUpperCase();
    if (!allowed.includes(priv)) {
      throw new Error(`权限 ${priv} 不适用于 ${level} 层级`);
    }
    if (!privs.includes(priv)) privs.push(priv);
  }
  g.privileges = privs.sort();
  return g;
}

/**
 * 宽松规范化一条"当前已有"授权项（来自 SHOW GRANTS 解析结果，服务端数据）
 * 不做安全字符白名单（数据来自 Doris），但仍对权限名做格式校验，生成时靠转义兜底。
 * 编辑器不支持的层级（compute_group / storage_vault 等只读层级）返回 null，
 * 由调用方过滤——diff 永不为其生成 SQL（只读展示，不可编辑即不可撤销）。
 */
function normalizeExistingGrant(item) {
  const level = String(item.level || '').toLowerCase();
  if (READONLY_LEVELS.includes(level)) return null;
  const g = {
    level,
    catalog: item.catalog == null ? null : String(item.catalog),
    database: item.database == null ? null : String(item.database),
    table: item.table == null ? null : String(item.table),
    resource: item.resource == null ? null : String(item.resource),
    workloadGroup: item.workloadGroup == null ? null : String(item.workloadGroup),
    privileges: [],
    grantOption: !!item.grantOption,
  };
  if (!LEVELS.includes(g.level)) {
    throw new Error(`未知的授权层级：${item.level}`);
  }
  const privs = [];
  for (const p of item.privileges || []) {
    const priv = String(p).toUpperCase();
    if (!PRIV_NAME_RE.test(priv)) continue; // 非法权限名直接忽略，避免注入
    if (!privs.includes(priv)) privs.push(priv);
  }
  g.privileges = privs.sort();
  return g;
}

// ---------------------------------------------------------------------------
// ON 目标生成（SPEC 5.2）
// ---------------------------------------------------------------------------

/**
 * 生成 ON 目标子句
 * global:   *.*.*
 * catalog:  `catalog`.*.*
 * database: `catalog`.`db`.*
 * table:    `catalog`.`db`.`table`
 * resource: RESOURCE 'name'
 */
function onTarget(g) {
  switch (g.level) {
    case 'global':
      return '*.*.*';
    case 'catalog':
      return `${quoteIdent(g.catalog)}.*.*`;
    case 'database':
      return `${quoteIdent(g.catalog)}.${quoteIdent(g.database)}.*`;
    case 'table':
      return `${quoteIdent(g.catalog)}.${quoteIdent(g.database)}.${quoteIdent(g.table)}`;
    case 'resource':
      return `RESOURCE ${quoteString(g.resource == null ? '*' : g.resource)}`;
    case 'workload_group':
      return `WORKLOAD GROUP ${quoteString(g.workloadGroup)}`;
    default:
      throw new Error(`未知的授权层级：${g.level}`);
  }
}

// ---------------------------------------------------------------------------
// 单条 GRANT / REVOKE 语句拼装
// ---------------------------------------------------------------------------

/** GRANT <privs> ON <目标> TO <对象> [WITH GRANT OPTION]; */
function grantSql(g, subject) {
  const opt = g.grantOption ? ' WITH GRANT OPTION' : '';
  return `GRANT ${g.privileges.join(', ')} ON ${onTarget(g)} TO ${subject}${opt};`;
}

/** REVOKE <privs> ON <目标> FROM <对象>; */
function revokeSql(g, subject) {
  return `REVOKE ${g.privileges.join(', ')} ON ${onTarget(g)} FROM ${subject};`;
}

// ---------------------------------------------------------------------------
// diff 计算（SPEC 5.3 第 2 条）
// ---------------------------------------------------------------------------

/** 授权项的 diff key：level|catalog|db|table（resource / workload_group 层级用名字占位） */
function grantKey(g) {
  if (g.level === 'resource') {
    return `resource|||${g.resource == null ? '*' : g.resource}`;
  }
  if (g.level === 'workload_group') {
    return `workload_group|||${g.workloadGroup || ''}`;
  }
  return `${g.level}|${g.catalog || ''}|${g.database || ''}|${g.table || ''}`;
}

/**
 * 计算授权集合差异
 * @param {Array} currentGrants 当前授权项数组（已 normalizeExistingGrant）
 * @param {Array} desiredGrants 期望授权项数组（已 normalizeGrant）
 * @returns {{grants: Array, revokes: Array}} 需要执行的 GRANT / REVOKE 项
 */
function diffGrants(currentGrants, desiredGrants) {
  const currentMap = new Map();
  for (const g of currentGrants) currentMap.set(grantKey(g), g);
  const desiredMap = new Map();
  for (const g of desiredGrants) desiredMap.set(grantKey(g), g);

  const grants = [];
  const revokes = [];

  // 期望集合：新增目标 / 权限增量 / grantOption 变化
  for (const [key, d] of desiredMap) {
    const c = currentMap.get(key);
    if (!c) {
      // 当前没有 → 整条 GRANT
      grants.push(d);
      continue;
    }
    const added = d.privileges.filter((p) => !c.privileges.includes(p));
    const removed = c.privileges.filter((p) => !d.privileges.includes(p));
    if (added.length > 0) {
      grants.push(Object.assign({}, d, { privileges: added.slice().sort() }));
    }
    if (removed.length > 0) {
      revokes.push(Object.assign({}, c, { privileges: removed.slice().sort() }));
    }
    // 权限集合相同但 WITH GRANT OPTION 标志不同：通过对齐处理
    if (added.length === 0 && removed.length === 0 && d.grantOption !== c.grantOption) {
      if (d.grantOption) {
        // 补上 GRANT OPTION：重授全部权限并带 WITH GRANT OPTION
        grants.push(d);
      } else {
        // 去掉 GRANT OPTION：先整体撤回再不带选项重授
        revokes.push(c);
        grants.push(d);
      }
    }
  }

  // 当前集合中多出来的目标 → 整体 REVOKE
  for (const [key, c] of currentMap) {
    if (!desiredMap.has(key)) revokes.push(c);
  }

  return { grants, revokes };
}

/** 角色集合差异 */
function diffRoles(currentRoles, desiredRoles) {
  const cur = new Set(currentRoles || []);
  const des = new Set(desiredRoles || []);
  const toGrant = [...des].filter((r) => !cur.has(r));
  const toRevoke = [...cur].filter((r) => !des.has(r));
  return { toGrant, toRevoke };
}

// ---------------------------------------------------------------------------
// 对外 API：各类 SQL 生成函数（SPEC 5.3）
// ---------------------------------------------------------------------------

/**
 * 1. 创建用户（多 host 展开）
 * @param {{user:string, hosts:string[], password:string, roles?:string[], grants?:Array}} input
 * @returns {string[]} SQL 数组
 */
function buildCreateUserSql(input) {
  const { user, hosts, password } = input || {};
  const roles = input.roles || [];
  const grants = input.grants || [];

  assertSafeName(user, '用户名');
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('来源地址 hosts 不能为空');
  }
  for (const h of hosts) assertSafeName(h, '来源地址 host');
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('创建用户必须提供密码');
  }
  for (const r of roles) assertSafeName(r, '角色名');
  const items = grants.map(normalizeGrant);

  const sql = [];
  // 每个 host 一条 CREATE USER
  for (const host of hosts) {
    sql.push(`CREATE USER IF NOT EXISTS ${userIdent(user, host)} IDENTIFIED BY ${quoteString(password)};`);
  }
  // 每个 host × 每条授权项
  for (const host of hosts) {
    for (const g of items) {
      sql.push(grantSql(g, userIdent(user, host)));
    }
  }
  // 每个 host × 每个角色
  for (const host of hosts) {
    for (const r of roles) {
      sql.push(`GRANT ${quoteString(r)} TO ${userIdent(user, host)};`);
    }
  }
  return sql;
}

/**
 * 2. 更新用户授权（diff：当前集合 vs 期望集合）
 * @param {{user:string, host:string, current:{roles:string[],grants:Array}, desired:{roles:string[],grants:Array}, password?:string|null}} input
 * @returns {string[]} SQL 数组（无变更时为空数组）
 */
function buildUpdateUserSql(input) {
  const { user, host, current, desired } = input || {};
  assertSafeName(user, '用户名');
  assertSafeName(host, '来源地址 host');

  const subject = userIdent(user, host);
  const currentGrants = ((current && current.grants) || []).map(normalizeExistingGrant).filter(Boolean);
  const desiredGrants = ((desired && desired.grants) || []).map(normalizeGrant);
  const currentRoles = (current && current.roles) || [];
  const desiredRoles = (desired && desired.roles) || [];
  for (const r of desiredRoles) assertSafeName(r, '角色名');

  const sql = [];

  // 权限 diff
  const { grants, revokes } = diffGrants(currentGrants, desiredGrants);
  for (const g of grants) sql.push(grantSql(g, subject));
  for (const g of revokes) sql.push(revokeSql(g, subject));

  // 角色 diff
  const { toGrant, toRevoke } = diffRoles(currentRoles, desiredRoles);
  for (const r of toGrant) sql.push(`GRANT ${quoteString(r)} TO ${subject};`);
  for (const r of toRevoke) sql.push(`REVOKE ${quoteString(r)} FROM ${subject};`);

  // 修改密码
  if (input.password != null && input.password !== '') {
    sql.push(buildChangePasswordSql(user, host, input.password)[0]);
  }

  return sql;
}

/**
 * 3. 删除用户
 */
function buildDropUserSql(user, host) {
  assertSafeName(user, '用户名');
  assertSafeName(host, '来源地址 host');
  return [`DROP USER IF EXISTS ${userIdent(user, host)};`];
}

/**
 * 4. 修改密码
 */
function buildChangePasswordSql(user, host, password) {
  assertSafeName(user, '用户名');
  assertSafeName(host, '来源地址 host');
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('新密码不能为空');
  }
  return [`SET PASSWORD FOR ${userIdent(user, host)} = PASSWORD(${quoteString(password)});`];
}

/**
 * 5a. 创建角色
 * @param {{role:string, comment?:string, grants?:Array}} input
 */
function buildCreateRoleSql(input) {
  const { role } = input || {};
  const comment = input.comment || '';
  const grants = input.grants || [];
  // CREATE ROLE 的角色名是裸标识符（带引号在 Doris 3.0.6 报语法错误），严格校验
  assertRoleIdent(role);
  const items = grants.map(normalizeGrant);

  const sql = [];
  sql.push(`CREATE ROLE IF NOT EXISTS ${role} COMMENT ${quoteString(comment)};`);
  // GRANT ... TO ROLE 'role' 保持带引号字符串（真机已验证正确）
  for (const g of items) {
    sql.push(grantSql(g, `ROLE ${quoteString(role)}`));
  }
  return sql;
}

/**
 * 5b. 更新角色授权（diff）
 * @param {{role:string, current:{grants:Array}|Array, desired:{grants:Array}|Array}} input
 */
function buildUpdateRoleSql(input) {
  const { role } = input || {};
  assertSafeName(role, '角色名');
  const subject = `ROLE ${quoteString(role)}`;

  const currentGrantsRaw = Array.isArray(input.current) ? input.current : (input.current && input.current.grants) || [];
  const desiredGrantsRaw = Array.isArray(input.desired) ? input.desired : (input.desired && input.desired.grants) || [];
  const currentGrants = currentGrantsRaw.map(normalizeExistingGrant).filter(Boolean);
  const desiredGrants = desiredGrantsRaw.map(normalizeGrant);

  const { grants, revokes } = diffGrants(currentGrants, desiredGrants);
  const sql = [];
  for (const g of grants) sql.push(grantSql(g, subject));
  for (const g of revokes) sql.push(revokeSql(g, subject));
  return sql;
}

/**
 * 5c. 删除角色
 */
function buildDropRoleSql(role) {
  // DROP ROLE 的角色名同样是裸标识符（带引号报语法错误），严格校验
  assertRoleIdent(role);
  return [`DROP ROLE IF EXISTS ${role};`];
}

/**
 * 6. 修改用户属性（SET PROPERTY，按用户名生效，与 host 无关）
 * 每个键生成一条：SET PROPERTY FOR 'user' 'key' = 'value';
 * @param {string} user 用户名（安全字符校验）
 * @param {Object<string, string|number>} properties 键值对（key 为 SHOW PROPERTY 返回的键名）
 * @returns {string[]} SQL 数组（properties 为空时返回空数组）
 */
function buildSetPropertySql(user, properties) {
  assertSafeName(user, '用户名');
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('属性集合必须是键值对对象');
  }
  const entries = Object.entries(properties).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return [];
  const sql = [];
  for (const [key, value] of entries) {
    // 键名防注入：只允许字母开头的标识符（Doris 属性键如 cpu_resource_limit）
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(key)) {
      throw new Error(`属性键名含有非法字符：${key}`);
    }
    // 值统一按字符串字面量处理并转义（防注入第二关）
    sql.push(`SET PROPERTY FOR ${quoteString(user)} ${quoteString(key)} = ${quoteString(String(value))};`);
  }
  return sql;
}

module.exports = {
  // 常量（测试用）
  SAFE_NAME_RE,
  ROLE_IDENT_RE,
  COMMON_PRIVS,
  GLOBAL_ONLY_PRIVS,
  RESOURCE_PRIVS,
  WORKLOAD_GROUP_PRIVS,
  LEVELS,
  READONLY_LEVELS,
  // 基础工具
  assertSafeName,
  assertRoleIdent,
  quoteIdent,
  quoteString,
  userIdent,
  onTarget,
  normalizeGrant,
  diffGrants,
  diffRoles,
  // SQL 生成
  buildCreateUserSql,
  buildUpdateUserSql,
  buildDropUserSql,
  buildChangePasswordSql,
  buildCreateRoleSql,
  buildUpdateRoleSql,
  buildDropRoleSql,
  buildSetPropertySql,
};
