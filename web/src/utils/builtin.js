/**
 * Doris 内置账号（root / admin）保护工具
 *
 * 平台约定：内置账号在 DorisMan 内只读 —— 不允许编辑授权、重置密码、
 * 禁用/启用、删除、修改属性；后端做硬性拦截（403），前端在此做按钮级隐藏与提示。
 * 用户名比较大小写不敏感，与后端拦截口径保持一致。
 */

const BUILTIN_USERS = ['root', 'admin']

/** 判断用户名是否为 Doris 内置账号（root / admin，大小写不敏感） */
export function isBuiltinUser(user) {
  if (user === null || user === undefined) return false
  return BUILTIN_USERS.includes(String(user).trim().toLowerCase())
}

/**
 * SQL 前置预检正则（大小写不敏感，与后端同思路）：
 * 1. GRANT / REVOKE 目标为 'root'@ 或 'admin'@
 * 2. CREATE / ALTER / DROP USER 'root|admin'@
 * 3. SET PASSWORD FOR 'root|admin'@
 * 4. SET PROPERTY FOR 'root|admin'
 * 引号兼容单引号 / 双引号 / 反引号，用反向引用保证开闭引号一致。
 */
const BUILTIN_SQL_PATTERNS = [
  /\b(?:GRANT|REVOKE)\b[\s\S]*?(['"`])(?:root|admin)\1\s*@/i,
  /\b(?:CREATE|ALTER|DROP)\s+USER\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(['"`])(?:root|admin)\1\s*@/i,
  /\bSET\s+PASSWORD\s+FOR\s+(['"`])(?:root|admin)\1\s*@/i,
  /\bSET\s+PROPERTY\s+FOR\s+(['"`])(?:root|admin)\1/i
]

/** 预检 SQL 是否针对内置账号 root/admin 的写操作（命中则应阻止提交） */
export function isBuiltinTargetSql(statement) {
  if (!statement) return false
  return BUILTIN_SQL_PATTERNS.some((re) => re.test(statement))
}
