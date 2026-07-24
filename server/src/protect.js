// Doris 内置账号 root / admin 保护（纯函数模块，不依赖 express / store，可独立单测）
// 需求：内置账号在平台内只能查看、不能修改——不能改授权、不能改密、不能禁用、
//       不能删除、不能改属性；SQL 控制台同样禁止针对 root/admin 的授权/改密/生命周期语句。
// 错误约定：抛出带 err.status = 403 的 Error，与 routes.js 的 wrap/wrapDoris
//          err.status 分支兼容（返回 HTTP 403 + { error: { code, message } }）。
'use strict';

/** 受保护的内置账号（精确匹配，小写 root / admin） */
const PROTECTED_USERS = ['root', 'admin'];

/** 接口保护错误信息（账号维度） */
const PROTECTED_USER_MESSAGE =
  '内置账号 root/admin 仅可查看，不允许在平台中修改；如需操作请直连 Doris 后台执行 SQL';

/** SQL 控制台保护错误信息（语句维度；含误拦提示） */
const CONSOLE_SQL_MESSAGE =
  'SQL 控制台不允许操作内置账号 root/admin 的授权/密码/属性；如属误拦或确需操作，请直连 Doris 后台执行 SQL';

/**
 * 是否受保护内置账号（精确匹配）
 * @param {*} user 用户名
 * @returns {boolean}
 */
function isProtectedUser(user) {
  return typeof user === 'string' && PROTECTED_USERS.includes(user);
}

/** 构造 403 保护错误（err.status 供 routes.js 错误分支识别） */
function protectedError(message) {
  const err = new Error(message);
  err.status = 403;
  err.code = 'PROTECTED_USER';
  return err;
}

/**
 * 账号维度保护断言：受保护用户直接抛 403
 * @param {*} user 用户名
 */
function assertNotProtectedUser(user) {
  if (isProtectedUser(user)) {
    throw protectedError(PROTECTED_USER_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// SQL 控制台受保护账号筛查（大小写不敏感；宁可误拦不可漏拦）
// ---------------------------------------------------------------------------

// 1) 授权/回收：GRANT|REVOKE ... TO|FROM [ROLE] 'root|admin'@...
const RE_GRANT_REVOKE = /\b(GRANT|REVOKE)\b/i;
const RE_GRANT_TARGET = /(TO|FROM)\s+(ROLE\s+)?['"]?(root|admin)['"]?@/i;
// 2) 生命周期：CREATE|ALTER|DROP USER ... 'root|admin'@...
const RE_USER_DDL = /\b(CREATE|ALTER|DROP)\s+USER\b/i;
const RE_USER_TARGET = /['"]?(root|admin)['"]?@/i;
// 3) 改密：SET PASSWORD FOR 'root|admin'@...
const RE_SET_PASSWORD = /\bSET\s+PASSWORD\s+FOR\s+['"]?(root|admin)['"]?@/i;
// 4) 属性：SET PROPERTY FOR 'root|admin'（PROPERTY 语法无 @host，引号必须）
const RE_SET_PROPERTY = /\bSET\s+PROPERTY\s+FOR\s+['"](root|admin)['"]/i;

/**
 * SQL 控制台受保护账号筛查：命中针对 root/admin 的授权/改密/生命周期/属性语句抛 403。
 * 注意：按"宁可误拦"原则设计，例如 'xadmin'@'%' 也会被拦（提示中已说明可直连后台执行）；
 * 但 'rooter'@'%' 这类 root 后随其他字符的不会误中（root 后必须是引号或 @）。
 * @param {*} sql 单条 SQL
 */
function checkConsoleSql(sql) {
  const s = typeof sql === 'string' ? sql : String(sql == null ? '' : sql);
  const hit =
    (RE_GRANT_REVOKE.test(s) && RE_GRANT_TARGET.test(s)) ||
    (RE_USER_DDL.test(s) && RE_USER_TARGET.test(s)) ||
    RE_SET_PASSWORD.test(s) ||
    RE_SET_PROPERTY.test(s);
  if (hit) {
    throw protectedError(CONSOLE_SQL_MESSAGE);
  }
}

module.exports = {
  PROTECTED_USERS,
  isProtectedUser,
  assertNotProtectedUser,
  checkConsoleSql,
};
