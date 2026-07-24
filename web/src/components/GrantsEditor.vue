<template>
  <div class="grants-editor">
    <!-- 工具条：系统库显隐开关（默认隐藏，谨慎授权）+ 全部权限项说明 -->
    <div class="editor-bar">
      <el-checkbox v-model="showSystemDbs" size="small">
        显示系统库（information_schema / mysql，谨慎授权）
      </el-checkbox>
      <el-button size="small" text type="primary" :icon="QuestionFilled" @click="openPrivHelp">全部权限项说明</el-button>
    </div>

    <div v-for="(row, idx) in rows" :key="idx" class="grant-row">
      <!-- 第一行：层级 + 目标 -->
      <div class="row-line">
        <el-select v-model="row.level" placeholder="层级" style="width: 170px" @change="onLevelChange(row)">
          <el-option v-for="l in LEVELS" :key="l.value" :label="l.label" :value="l.value" />
        </el-select>

        <!-- 全局层级：目标固定为 *.*.* -->
        <el-input v-if="row.level === 'global'" model-value="*.*.*（全局）" disabled style="width: 320px" />

        <!-- 资源层级：手输资源名 -->
        <el-input
          v-else-if="row.level === 'resource'"
          v-model="row.resource"
          placeholder="资源名，* 表示全部资源"
          style="width: 320px"
          clearable
        />

        <!-- 负载组层级：下拉（选项来自 workload-groups 接口），接口失败时可手输 -->
        <el-select
          v-else-if="row.level === 'workload_group'"
          v-model="row.workloadGroup"
          placeholder="选择负载组，也可手动输入"
          style="width: 320px"
          filterable
          allow-create
          default-first-option
          clearable
          @focus="loadWorkloadGroups"
        >
          <el-option v-for="g in workloadGroups" :key="g" :label="g" :value="g" />
        </el-select>

        <!-- Catalog/库/表层级：级联选择，异步加载，支持 * 与手输新名称 -->
        <!-- key 绑定系统库开关：切换显隐后强制重建级联，让数据库选项即时刷新 -->
        <el-cascader
          v-else
          :key="`casc-${idx}-${showSystemDbs}`"
          v-model="row.target"
          :props="cascaderPropsFor(row)"
          :placeholder="targetPlaceholder(row.level)"
          style="width: 320px"
          filterable
          clearable
          @change="(val) => onTargetChange(row, val)"
        />

        <!-- 操作按钮 -->
        <el-button size="small" @click="cloneRow(idx)">再加一个目标</el-button>
        <el-button size="small" type="danger" plain @click="removeRow(idx)">删除</el-button>
      </div>

      <!-- 第二行：权限多选 + GRANT OPTION + 快捷预设 -->
      <div class="row-line">
        <el-select
          v-model="row.privileges"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="选择权限"
          style="width: 440px"
        >
          <el-option v-for="p in privilegesForLevel(row.level)" :key="p.value" :label="p.label" :value="p.value">
            <span>{{ p.label }}</span>
            <el-tag v-if="p.danger" type="warning" size="small" style="margin-left: 8px">高危</el-tag>
          </el-option>
        </el-select>

        <el-checkbox v-model="row.grantOption">WITH GRANT OPTION</el-checkbox>

        <!-- 资源/负载组层级只有 USAGE_PRIV，预设无意义 -->
        <template v-if="row.level !== 'resource' && row.level !== 'workload_group'">
          <el-button size="small" text type="primary" @click="applyPreset(row, 'readonly')">只读</el-button>
          <el-button size="small" text type="primary" @click="applyPreset(row, 'readwrite')">读写</el-button>
          <el-button size="small" text type="primary" @click="applyAll(row)">全量(当前层级)</el-button>
        </template>
      </div>

      <!-- ADMIN_PRIV 高危警示 -->
      <el-alert
        v-if="row.privileges.includes('ADMIN_PRIV')"
        type="warning"
        :closable="false"
        title="⚠ ADMIN_PRIV 是超级管理权限，请确认确实需要授予"
        style="margin: 4px 0"
      />

      <!-- 系统库警示：目标选中 information_schema / mysql 时提示 -->
      <el-alert
        v-if="isSystemDbTarget(row)"
        type="warning"
        :closable="false"
        title="⚠ 目标是系统库（information_schema / mysql），请确认确有必要再授权"
        style="margin: 4px 0"
      />

      <!-- 负载组列表接口失败提示：允许手动输入名称 -->
      <el-alert
        v-if="row.level === 'workload_group' && wgFailed"
        type="info"
        :closable="false"
        title="负载组列表获取失败，可直接手动输入负载组名称"
        style="margin: 4px 0"
      />
    </div>

    <el-button type="primary" plain size="small" @click="addRow">＋ 添加授权项</el-button>

    <!-- 全部权限项说明对话框：数据来自 GET /api/c/:clusterId/privileges，失败时降级为内置说明 -->
    <el-dialog v-model="privHelpDialog" title="全部权限项说明" width="720px" append-to-body>
      <el-alert
        v-if="privHelpFallback"
        type="info"
        :closable="false"
        title="权限说明接口暂不可用，以下为内置说明（可能不完整），不影响授权编辑"
        style="margin-bottom: 10px"
      />
      <el-table v-loading="privHelpLoading" :data="privHelpRows" border size="small" max-height="440">
        <el-table-column prop="Privilege" label="权限项" width="180" />
        <el-table-column prop="Context" label="适用层级" width="200" />
        <el-table-column prop="Comment" label="说明" />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { ElMessageBox } from 'element-plus'
import { QuestionFilled } from '@element-plus/icons-vue'
import api from '../api'
import { LEVELS, PRESETS, privilegesForLevel } from '../utils/grants'

/**
 * 授权项编辑器（UserEdit 与 Roles 共用）
 * v-model: grants 数组，元素形如：
 *   { level:'database', catalog:'internal', database:'db1', table:null,
 *     privileges:['SELECT_PRIV'], grantOption:false }
 * 资源层级为 { level:'resource', resource:'*', privileges:['USAGE_PRIV'], grantOption:false }
 */
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  clusterId: { type: [String, Number], required: true }
})
const emit = defineEmits(['update:modelValue'])

// ---- 内部行结构：target 为级联路径数组（如 ['internal','db1','t1']），提交时再展开 ----
function grantToRow(g) {
  const row = {
    level: g.level || 'global',
    target: [],
    resource: g.resource || '',
    workloadGroup: g.workloadGroup ?? g.workload_group ?? '',
    privileges: [...(g.privileges || [])],
    grantOption: !!g.grantOption
  }
  if (g.level === 'catalog') row.target = [g.catalog].filter(Boolean)
  else if (g.level === 'database') row.target = [g.catalog, g.database].filter(Boolean)
  else if (g.level === 'table') row.target = [g.catalog, g.database, g.table].filter(Boolean)
  return row
}

function emptyRow() {
  return { level: 'global', target: [], resource: '', workloadGroup: '', privileges: [], grantOption: false }
}

const rows = ref(props.modelValue.length ? props.modelValue.map(grantToRow) : [emptyRow()])
let syncing = false // 防止 watch 循环

// 内部行变化 → 展开为 grants 结构提交给父组件
watch(
  rows,
  (val) => {
    const grants = val.map((r) => {
      const g = { level: r.level, privileges: [...r.privileges], grantOption: r.grantOption }
      if (r.level === 'resource') {
        g.resource = r.resource || '*'
      } else if (r.level === 'workload_group') {
        g.workloadGroup = r.workloadGroup || ''
      } else if (r.level !== 'global') {
        g.catalog = r.target[0] ?? null
        if (r.level === 'database' || r.level === 'table') g.database = r.target[1] ?? null
        if (r.level === 'table') g.table = r.target[2] ?? null
      }
      return g
    })
    syncing = true
    emit('update:modelValue', grants)
    nextTick(() => (syncing = false))
  },
  { deep: true }
)

// 父组件重置/预填时同步回内部行
watch(
  () => props.modelValue,
  (val) => {
    if (syncing) return
    rows.value = val && val.length ? val.map(grantToRow) : [emptyRow()]
  }
)

// ---- 行操作 ----
function addRow() {
  rows.value.push(emptyRow())
}

function removeRow(idx) {
  rows.value.splice(idx, 1)
}

/** 克隆行：保留层级/权限/GRANT OPTION，清空目标让用户另选 */
function cloneRow(idx) {
  const src = rows.value[idx]
  rows.value.splice(idx + 1, 0, {
    level: src.level,
    target: [],
    resource: '',
    workloadGroup: '',
    privileges: [...src.privileges],
    grantOption: src.grantOption
  })
}

/** 层级切换：清空目标并剔除新层级不可用的权限 */
function onLevelChange(row) {
  row.target = []
  row.resource = ''
  row.workloadGroup = ''
  const allowed = privilegesForLevel(row.level).map((p) => p.value)
  row.privileges = row.privileges.filter((p) => allowed.includes(p))
  if (row.level === 'workload_group') loadWorkloadGroups()
}

function targetPlaceholder(level) {
  return { catalog: '选择 Catalog', database: 'Catalog / 数据库', table: 'Catalog / 数据库 / 表' }[level] || '选择目标'
}

/** 快捷预设（SPEC 5.1） */
function applyPreset(row, key) {
  const allowed = privilegesForLevel(row.level).map((p) => p.value)
  row.privileges = PRESETS[key].privileges.filter((p) => allowed.includes(p))
}

/** 全量（当前层级全部可用权限） */
function applyAll(row) {
  row.privileges = privilegesForLevel(row.level).map((p) => p.value)
}

// ---- 级联数据：按集群异步加载并缓存（缓存保存未过滤的原始列表，过滤在构建节点时进行）----
const cache = ref({ catalogs: null, dbs: {}, tables: {} })

// ---- 系统库保护：internal catalog 下的系统库默认不出现在数据库选项中 ----
const SYSTEM_CATALOG = 'internal'
const SYSTEM_DBS = ['information_schema', 'mysql']
const showSystemDbs = ref(false) // 「显示系统库（谨慎授权）」开关

/** 数据库列表按开关过滤系统库（仅 internal catalog） */
function filterDbs(catalog, dbs) {
  if (catalog === SYSTEM_CATALOG && !showSystemDbs.value) {
    return (dbs || []).filter((d) => !SYSTEM_DBS.includes(d))
  }
  return dbs || []
}

/** 判断该行目标是否选中了系统库（库/表层级，db 为 information_schema / mysql） */
function isSystemDbTarget(row) {
  return row.target[0] === SYSTEM_CATALOG && SYSTEM_DBS.includes(row.target[1])
}

// ---- 全部权限项说明：GET /api/c/:clusterId/privileges，失败时降级为内置静态说明 ----
const privHelpDialog = ref(false)
const privHelpLoading = ref(false)
const privHelpRows = ref([])
const privHelpFallback = ref(false)
let privHelpLoaded = false // 成功拉取过一次后不再重复请求

// 接口不可用时的降级数据（对应 SPEC 5.1 权限模型）
const STATIC_PRIVILEGES = [
  { Privilege: 'SELECT_PRIV', Context: '全局/Catalog/库/表', Comment: '查询数据' },
  { Privilege: 'LOAD_PRIV', Context: '全局/Catalog/库/表', Comment: '导入/写入（LOAD、INSERT、DELETE）' },
  { Privilege: 'ALTER_PRIV', Context: '全局/Catalog/库/表', Comment: 'schema 变更' },
  { Privilege: 'CREATE_PRIV', Context: '全局/Catalog/库/表', Comment: '创建库表视图' },
  { Privilege: 'DROP_PRIV', Context: '全局/Catalog/库/表', Comment: '删除库表视图' },
  { Privilege: 'SHOW_VIEW_PRIV', Context: '全局/Catalog/库/表', Comment: '查询视图（2.x+）' },
  { Privilege: 'GRANT_PRIV', Context: '全局/Catalog/库/表', Comment: '授权/撤权/用户管理' },
  { Privilege: 'USAGE_PRIV', Context: '仅 RESOURCE 层级', Comment: '资源使用权限' },
  { Privilege: 'ADMIN_PRIV', Context: '仅全局', Comment: '超级管理权限（高危）' }
]

async function openPrivHelp() {
  privHelpDialog.value = true
  if (privHelpLoaded) return
  privHelpLoading.value = true
  try {
    // silent：接口失败时不弹全局错误提示，本地降级处理
    const rows = await api.get(`/c/${props.clusterId}/privileges`, { silent: true })
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty')
    privHelpRows.value = rows
    privHelpFallback.value = false
    privHelpLoaded = true
  } catch {
    // 降级为内置静态说明，不影响编辑器使用；下次打开会重试接口
    privHelpRows.value = STATIC_PRIVILEGES
    privHelpFallback.value = true
  } finally {
    privHelpLoading.value = false
  }
}

// ---- 负载组列表：GET /api/c/:clusterId/workload-groups，失败时降级为手动输入 ----
const workloadGroups = ref([])
const wgFailed = ref(false)
let wgLoaded = false // 成功拉取过一次后不再重复请求

async function loadWorkloadGroups() {
  if (wgLoaded || wgFailed.value) return
  try {
    // silent：接口失败时不弹全局错误提示，本地降级为手输名称
    const list = await api.get(`/c/${props.clusterId}/workload-groups`, { silent: true })
    if (!Array.isArray(list)) throw new Error('bad response')
    workloadGroups.value = list
    wgLoaded = true
  } catch {
    wgFailed.value = true
    workloadGroups.value = []
  }
}

// 预填数据已含负载组层级时提前加载选项（编辑授权/角色场景）
if (rows.value.some((r) => r.level === 'workload_group')) loadWorkloadGroups()

watch(
  () => props.clusterId,
  () => {
    cache.value = { catalogs: null, dbs: {}, tables: {} }
    workloadGroups.value = []
    wgFailed.value = false
    wgLoaded = false
  }
)

async function loadCatalogs() {
  if (!cache.value.catalogs) {
    cache.value.catalogs = await api.get(`/c/${props.clusterId}/catalogs`)
  }
  return cache.value.catalogs
}

async function loadDbs(catalog) {
  if (!(catalog in cache.value.dbs)) {
    cache.value.dbs[catalog] = await api.get(`/c/${props.clusterId}/databases`, { params: { catalog } })
  }
  return cache.value.dbs[catalog]
}

async function loadTables(catalog, db) {
  const key = `${catalog}/${db}`
  if (!(key in cache.value.tables)) {
    cache.value.tables[key] = await api.get(`/c/${props.clusterId}/tables`, { params: { catalog, db } })
  }
  return cache.value.tables[key]
}

const CUSTOM = '__custom__' // "手动输入"占位节点

/** 构造某一级的节点列表：*（全部）+ 实际列表 + 手动输入 */
function buildNodes(names, isLeaf, depth, nodeLevel) {
  const nodes = [{ value: '*', label: '*（全部）', leaf: true }]
  for (const n of names || []) {
    nodes.push({ value: n, label: n, leaf: isLeaf })
  }
  // 手动输入节点：到最后一级时是叶子；中间级时展开后仍只有 * 与手动输入
  nodes.push({ value: CUSTOM, label: '＋ 手动输入新名称…', leaf: nodeLevel + 1 >= depth })
  return nodes
}

/** 每个授权行的级联 props（深度随行层级变化） */
function cascaderPropsFor(row) {
  const depth = row.level === 'catalog' ? 1 : row.level === 'database' ? 2 : 3
  return {
    lazy: true,
    lazyLoad: async (node, resolve) => {
      try {
        if (node.level === 0) {
          resolve(buildNodes(await loadCatalogs(), depth <= 1, depth, 0))
        } else if (node.level === 1) {
          const catalog = node.value
          if (catalog === '*' || catalog === CUSTOM) {
            resolve(buildNodes([], depth <= 2, depth, 1))
          } else {
            // 系统库（internal 下的 information_schema / mysql）默认被过滤，打开开关才出现
            resolve(buildNodes(filterDbs(catalog, await loadDbs(catalog)), depth <= 2, depth, 1))
          }
        } else if (node.level === 2) {
          const catalog = node.parent?.value
          const db = node.value
          if (db === '*' || db === CUSTOM || catalog === '*' || catalog === CUSTOM) {
            resolve(buildNodes([], true, depth, 2))
          } else {
            resolve(buildNodes(await loadTables(catalog, db), true, depth, 2))
          }
        } else {
          resolve([])
        }
      } catch {
        // 接口失败（如无权限/连接断开）时给出空列表，axios 拦截器已提示
        resolve([])
      }
    }
  }
}

/** 处理级联选择：点击"手动输入"时弹窗录入新名称 */
function onTargetChange(row, val) {
  if (!val || val.length === 0) return
  if (val[val.length - 1] !== CUSTOM) return
  ElMessageBox.prompt('请输入新名称（库/表/Catalog 名）', '手动输入', {
    inputPattern: /^[A-Za-z0-9_$.%-]+$/,
    inputErrorMessage: '仅允许字母、数字、_ $ . % -',
    confirmButtonText: '确定',
    cancelButtonText: '取消'
  })
    .then(({ value }) => {
      const parentPath = val.slice(0, -1)
      // 写入缓存，保证级联组件能解析出新路径的显示文本
      if (parentPath.length === 0) {
        if (!cache.value.catalogs.includes(value)) cache.value.catalogs.push(value)
      } else if (parentPath.length === 1) {
        const c = parentPath[0]
        if (cache.value.dbs[c] && !cache.value.dbs[c].includes(value)) cache.value.dbs[c].push(value)
      } else if (parentPath.length === 2) {
        const key = `${parentPath[0]}/${parentPath[1]}`
        if (cache.value.tables[key] && !cache.value.tables[key].includes(value)) cache.value.tables[key].push(value)
      }
      const path = [...parentPath, value]
      // 先清空再设置，强制级联组件按新路径重算展示
      row.target = []
      nextTick(() => {
        row.target = path
      })
    })
    .catch(() => {
      row.target = []
    })
}

/** 校验：供父组件提交前调用，返回 {ok, message} */
function validate() {
  const list = rows.value
  if (list.length === 0) return { ok: true }
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const no = `第 ${i + 1} 条授权`
    if (r.privileges.length === 0) return { ok: false, message: `${no}：请选择权限` }
    if (r.level === 'catalog' && r.target.length !== 1) return { ok: false, message: `${no}：请选择 Catalog` }
    if (r.level === 'database' && r.target.length !== 2) return { ok: false, message: `${no}：请选择 Catalog 和数据库` }
    if (r.level === 'table' && r.target.length !== 3) return { ok: false, message: `${no}：请选择 Catalog、数据库和表` }
    if (r.level === 'resource' && !r.resource) return { ok: false, message: `${no}：请填写资源名（或 *）` }
    if (r.level === 'resource' && r.privileges.some((p) => p !== 'USAGE_PRIV')) {
      return { ok: false, message: `${no}：资源层级仅允许 USAGE_PRIV` }
    }
    if (r.level === 'workload_group' && !r.workloadGroup) {
      return { ok: false, message: `${no}：请选择或输入负载组名称` }
    }
    if (r.level === 'workload_group' && r.privileges.some((p) => p !== 'USAGE_PRIV')) {
      return { ok: false, message: `${no}：负载组层级仅允许 USAGE_PRIV` }
    }
  }
  return { ok: true }
}

defineExpose({ validate })
</script>

<style scoped>
.editor-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.grant-row {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fafafa;
}
.row-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.row-line:last-child {
  margin-bottom: 0;
}
</style>
