// Doris 权限模型常量（对应 SPEC 第 5 节）
// 供 GrantsEditor 与各页面共用

/** 授权层级 */
export const LEVELS = [
  { value: 'global', label: '全局' },
  { value: 'catalog', label: 'Catalog' },
  { value: 'database', label: '数据库' },
  { value: 'table', label: '表' },
  { value: 'resource', label: '资源' },
  { value: 'workload_group', label: '负载组(Workload Group)' }
]

/**
 * 权限项定义：
 * - onlyLevel: 仅允许出现的层级（字符串或数组）
 * - 无 onlyLevel：除 resource / workload_group 外均可
 * - danger: 是否高危（界面警示）
 */
export const PRIVILEGES = [
  { value: 'SELECT_PRIV', label: 'SELECT_PRIV（查询）' },
  { value: 'LOAD_PRIV', label: 'LOAD_PRIV（导入/写入）' },
  { value: 'ALTER_PRIV', label: 'ALTER_PRIV（schema变更）' },
  { value: 'CREATE_PRIV', label: 'CREATE_PRIV（创建库表视图）' },
  { value: 'DROP_PRIV', label: 'DROP_PRIV（删除库表视图）' },
  { value: 'SHOW_VIEW_PRIV', label: 'SHOW_VIEW_PRIV（查询视图）' },
  { value: 'GRANT_PRIV', label: 'GRANT_PRIV（授权管理）' },
  { value: 'USAGE_PRIV', label: 'USAGE_PRIV（资源/负载组使用）', onlyLevel: ['resource', 'workload_group'] },
  { value: 'ADMIN_PRIV', label: 'ADMIN_PRIV（超管）', onlyLevel: 'global', danger: true }
]

/** 按层级过滤可用权限项（负载组层级仅 USAGE_PRIV） */
export function privilegesForLevel(level) {
  return PRIVILEGES.filter((p) => {
    if (p.onlyLevel) {
      const allowed = Array.isArray(p.onlyLevel) ? p.onlyLevel : [p.onlyLevel]
      return allowed.includes(level)
    }
    // USAGE_PRIV 仅资源/负载组层级；其余权限不出现在这两个层级
    return level !== 'resource' && level !== 'workload_group'
  })
}

/** 快捷预设（SPEC 5.1）：只读 / 读写 */
export const PRESETS = {
  readonly: { label: '只读', privileges: ['SELECT_PRIV'] },
  readwrite: {
    label: '读写',
    privileges: ['SELECT_PRIV', 'LOAD_PRIV', 'ALTER_PRIV', 'CREATE_PRIV', 'DROP_PRIV']
  }
}

/** 层级中文名（详情表格用短名；workload_group 显示为「负载组」） */
export function levelLabel(level) {
  if (level === 'workload_group') return '负载组'
  return LEVELS.find((l) => l.value === level)?.label || level
}

/** 把一条授权项格式化为可读的目标文本（用于展示） */
export function grantTargetText(g) {
  if (g.level === 'global') return '*.*.*'
  if (g.level === 'resource') return `RESOURCE '${g.resource || '*'}'`
  if (g.level === 'workload_group') return `负载组: ${g.workloadGroup ?? g.workload_group ?? ''}`
  // compute_group / storage_vault：原样展示名称
  if (g.level === 'compute_group') return g.computeGroup ?? g.compute_group ?? ''
  if (g.level === 'storage_vault') return g.storageVault ?? g.storage_vault ?? ''
  const catalog = g.catalog || '*'
  if (g.level === 'catalog') return `${catalog}.*.*`
  const db = g.database || '*'
  if (g.level === 'database') return `${catalog}.${db}.*`
  return `${catalog}.${db}.${g.table || '*'}`
}
