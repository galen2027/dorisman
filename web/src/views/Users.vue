<template>
  <div class="page-card">
    <!-- 工具条：搜索 / 刷新 / 新建 -->
    <div class="toolbar">
      <el-input v-model="keyword" placeholder="按用户名搜索" clearable style="width: 240px" :prefix-icon="Search" />
      <el-button :icon="Refresh" @click="loadUsers">刷新</el-button>
      <div class="spacer" />
      <el-button v-if="auth.isAdmin" type="primary" :icon="Plus" @click="$router.push('/users/create')">新建用户</el-button>
    </div>

    <!-- 用户表格：按用户名分组，展开行显示各 host -->
    <el-table v-loading="loading" :data="filteredUsers" row-key="user" border>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="host-table">
            <el-table :data="row.hosts" size="small" border :row-class-name="hostRowClass">
              <el-table-column label="来源地址 (host)" prop="host" width="230">
                <template #default="{ row: h }">
                  <span>{{ h.host }}</span>
                  <el-tag v-if="isBuiltinUser(row.user)" type="warning" size="small" style="margin-left: 6px">内置账号</el-tag>
                </template>
              </el-table-column>
              <!-- 状态：禁用标记由平台本地记录；禁用显示灰 tag，tooltip 展示禁用时间与操作人 -->
              <el-table-column label="状态" width="96" align="center">
                <template #default="{ row: h }">
                  <el-tooltip
                    v-if="h.disabled"
                    placement="top"
                    :content="`禁用时间：${formatTime(h.disabledAt)}；操作人：${h.disabledBy || '未知'}`"
                  >
                    <el-tag type="info" size="small">已禁用</el-tag>
                  </el-tooltip>
                  <el-tag v-else type="success" size="small">正常</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="角色">
                <template #default="{ row: h }">
                  <el-tag v-for="r in h.roles" :key="r" size="small" style="margin-right: 4px">{{ r }}</el-tag>
                  <span v-if="!h.roles?.length" class="muted">（无）</span>
                </template>
              </el-table-column>
              <el-table-column label="授权项数" prop="grantCount" width="100" align="center" />
              <el-table-column label="操作" width="400">
                <template #default="{ row: h }">
                  <el-button size="small" text type="primary" @click="viewGrants(row.user, h)">查看授权</el-button>
                  <!-- 内置账号（root/admin）只读：仅保留「查看授权」，其余操作按钮隐藏 -->
                  <template v-if="auth.isAdmin && !isBuiltinUser(row.user)">
                    <el-button size="small" text type="primary" @click="goEdit(row.user, h.host)">编辑授权</el-button>
                    <el-button size="small" text type="warning" @click="openResetPwd(row.user, h.host)">重置密码</el-button>
                    <el-button v-if="h.disabled" size="small" type="success" plain @click="openEnable(row.user, h.host)">启用</el-button>
                    <el-button v-else size="small" text type="danger" @click="disableLogin(row.user, h.host)">禁用登录</el-button>
                    <el-button size="small" text type="danger" @click="dropUser(row.user, h.host)">删除</el-button>
                  </template>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="用户名" prop="user">
        <template #default="{ row }">
          <span>{{ row.user }}</span>
          <el-tag v-if="isBuiltinUser(row.user)" type="warning" size="small" style="margin-left: 6px">内置账号</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="host 数量" width="100" align="center">
        <template #default="{ row }">{{ row.hosts.length }}</template>
      </el-table-column>
      <!-- 角色：该用户所有 host 的角色并集；主机：所有 host，逗号分隔，过长省略号+tooltip -->
      <el-table-column label="角色" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ rolesUnion(row) || '-' }}</template>
      </el-table-column>
      <el-table-column label="主机" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ row.hosts.map((h) => h.host).join(', ') }}</template>
      </el-table-column>
    </el-table>

    <!-- 查看授权抽屉 -->
    <el-drawer v-model="grantsDrawer" :title="`授权详情：${grantsData?.userIdentity || ''}`" size="640px">
      <!-- 内置账号（root/admin）平台内只读，抽屉顶部常驻提示 -->
      <el-alert
        v-if="isBuiltinUser(grantsTarget.user)"
        type="info"
        :closable="false"
        show-icon
        class="block"
        title="内置账号仅可查看；修改请直连 Doris 后台执行 SQL"
      />
      <template v-if="grantsData">
        <h4>角色</h4>
        <div class="block">
          <el-tag v-for="r in grantsData.roles" :key="r" style="margin-right: 6px">{{ r }}</el-tag>
          <span v-if="!grantsData.roles?.length" class="muted">（无角色）</span>
        </div>

        <h4>授权项（解析后）</h4>
        <el-table :data="grantsData.grants" size="small" border class="block">
          <el-table-column label="层级" width="80">
            <template #default="{ row }">{{ levelLabel(row.level) }}</template>
          </el-table-column>
          <el-table-column label="目标" width="180">
            <template #default="{ row }"><span class="mono">{{ grantTargetText(row) }}</span></template>
          </el-table-column>
          <el-table-column label="权限">
            <template #default="{ row }">
              <el-tag v-for="p in row.privileges" :key="p" size="small" style="margin: 2px 4px 2px 0">{{ p }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="GRANT OPTION" width="110" align="center">
            <template #default="{ row }">{{ row.grantOption ? '是' : '否' }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!grantsData.grants?.length" description="无解析出的授权项" :image-size="60" class="block" />

        <!-- 解析失败的原始单元格 -->
        <template v-if="grantsData.unparsed?.length">
          <h4>未能解析的内容</h4>
          <div v-for="(u, i) in grantsData.unparsed" :key="i" class="block unparsed">
            <el-tag size="small" type="warning">{{ u.field }}</el-tag>
            <span class="mono">{{ u.value }}</span>
          </div>
        </template>

        <!-- 用户属性（SHOW PROPERTY FOR 'user'，按用户名生效，与该用户全部 host 相关）
             默认只读灰显；admin 可点「修改属性」打开编辑对话框，走 SQL 预览确认流程 -->
        <div class="prop-header">
          <h4>用户属性</h4>
          <el-button
            v-if="auth.isAdmin && propertyRows.length && !isBuiltinUser(grantsTarget.user)"
            size="small"
            type="primary"
            plain
            @click="openPropDialog"
          >
            修改属性
          </el-button>
        </div>
        <div class="block">
          <el-table v-if="propertyRows.length" :data="propertyRows" size="small" border class="prop-readonly">
            <el-table-column label="Key" prop="Key" width="240" />
            <el-table-column label="Value">
              <template #default="{ row }"><span class="mono prop-value">{{ row.Value }}</span></template>
            </el-table-column>
          </el-table>
          <span v-else-if="propertyError" class="muted">属性查询失败：{{ propertyError }}</span>
          <span v-else class="muted">（无属性数据）</span>
        </div>

        <h4>原始 SHOW GRANTS 数据</h4>
        <pre class="raw-json mono">{{ JSON.stringify(grantsData.raw, null, 2) }}</pre>
      </template>
      <el-skeleton v-else :rows="6" animated />
    </el-drawer>

    <!-- 重置密码对话框（复用为「启用并重置密码」：后端改密成功即自动解除禁用标记） -->
    <el-dialog v-model="pwdDialog" :title="pwdDialogTitle" width="440px">
      <el-form label-width="80px">
        <el-form-item label="新密码">
          <div class="pwd-line">
            <el-input v-model="pwdValue" type="password" show-password placeholder="请输入或随机生成" />
            <el-button @click="pwdValue = generatePassword()">随机生成</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!pwdValue" @click="previewResetPwd">下一步</el-button>
      </template>
    </el-dialog>

    <!-- 修改属性对话框：可编辑键值表，仅变更的键生成 SET PROPERTY -->
    <el-dialog v-model="propEditDialog" :title="`修改属性：${grantsTarget.user}`" width="560px" append-to-body>
      <el-table :data="propEditRows" size="small" border max-height="420">
        <el-table-column label="Key" prop="Key" width="220" />
        <el-table-column label="Value">
          <template #default="{ row }">
            <el-input v-model="row.edit" size="small" :placeholder="row.Value" />
          </template>
        </el-table-column>
      </el-table>
      <div class="tip">仅被修改的键会生成 SET PROPERTY 语句；属性按用户名生效（对该用户全部 host 生效）</div>
      <template #footer>
        <el-button @click="propEditDialog = false">取消</el-button>
        <el-button type="primary" @click="previewProperty">预览属性修改 SQL</el-button>
      </template>
    </el-dialog>

    <!-- SQL 预览对话框（重置密码用） -->
    <SqlPreviewDialog v-model="sqlDialog" title="重置密码 SQL 确认" :sql-list="sqlList" :executor="executeResetPwd" @success="onResetSuccess" />

    <!-- SQL 预览对话框（属性修改用） -->
    <SqlPreviewDialog
      v-model="propSqlDialog"
      title="属性修改 SQL 确认"
      :sql-list="propSqlList"
      :executor="executeProperty"
      @success="onPropertySuccess"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Refresh, Plus } from '@element-plus/icons-vue'
import api from '../api'
import { useAuthStore, useClusterStore } from '../store'
import { generatePassword } from '../utils/password'
import { levelLabel, grantTargetText } from '../utils/grants'
import { isBuiltinUser } from '../utils/builtin'
import SqlPreviewDialog from '../components/SqlPreviewDialog.vue'

const router = useRouter()
const auth = useAuthStore()
const clusterStore = useClusterStore()

const loading = ref(false)
const users = ref([])
const keyword = ref('')

// 前端搜索过滤（按用户名）
const filteredUsers = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return users.value
  return users.value.filter((u) => u.user.toLowerCase().includes(kw))
})

/** 该用户所有 host 的角色并集（逗号分隔） */
function rolesUnion(row) {
  const set = new Set()
  for (const h of row.hosts || []) {
    for (const r of h.roles || []) set.add(r)
  }
  return [...set].join(', ')
}

onMounted(loadUsers)

async function loadUsers() {
  if (!clusterStore.currentId) return
  loading.value = true
  try {
    users.value = await api.get(`/c/${clusterStore.currentId}/users`)
  } catch {
    users.value = []
  } finally {
    loading.value = false
  }
}

// ---- 查看授权 ----
const grantsDrawer = ref(false)
const grantsData = ref(null)
const grantsTarget = ref({ user: '', host: '' }) // 当前抽屉对应的用户，供属性接口复用

async function viewGrants(user, hostRow) {
  grantsDrawer.value = true
  grantsData.value = null
  grantsTarget.value = { user, host: hostRow.host }
  loadProperty() // 属性与授权并行加载，互不影响
  try {
    grantsData.value = await api.get(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(user)}/${encodeURIComponent(hostRow.host)}/grants`
    )
  } catch {
    grantsDrawer.value = false
  }
}

// ---- 用户属性（SHOW PROPERTY FOR 'user'，按用户名生效） ----
const propertyRows = ref([]) // [{Key, Value}]，只读展示
const propertyError = ref('')

async function loadProperty() {
  propertyRows.value = []
  propertyError.value = ''
  try {
    const { user, host } = grantsTarget.value
    const rows = await api.get(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(user)}/${encodeURIComponent(host)}/property`
    )
    propertyRows.value = (rows || []).map((r) => ({
      Key: r.Key,
      Value: r.Value ?? ''
    }))
  } catch (e) {
    propertyError.value = e.response?.data?.error?.message || '查询失败'
  }
}

// ---- 修改属性对话框：editable 副本，仅变更的键生效 ----
const propEditDialog = ref(false)
const propEditRows = ref([]) // [{Key, Value, edit}]

function openPropDialog() {
  propEditRows.value = propertyRows.value.map((r) => ({ Key: r.Key, Value: r.Value, edit: r.Value }))
  propEditDialog.value = true
}

/** 收集被修改的属性键值（与原始值不一致的键） */
function changedProperties() {
  const changed = {}
  for (const r of propEditRows.value) {
    if (String(r.edit ?? '') !== String(r.Value ?? '')) changed[r.Key] = r.edit ?? ''
  }
  return changed
}

// 属性修改走统一 SQL 预览确认流程
const propSqlDialog = ref(false)
const propSqlList = ref([])

async function previewProperty() {
  const changed = changedProperties()
  if (Object.keys(changed).length === 0) {
    ElMessage.info('没有修改任何属性')
    return
  }
  try {
    const { user, host } = grantsTarget.value
    const res = await api.post(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(user)}/${encodeURIComponent(host)}/property/preview`,
      { properties: changed }
    )
    propSqlList.value = res.sql || []
    propSqlDialog.value = true
  } catch {
    // 拦截器已提示
  }
}

async function executeProperty() {
  const { user, host } = grantsTarget.value
  const res = await api.put(
    `/c/${clusterStore.currentId}/users/${encodeURIComponent(user)}/${encodeURIComponent(host)}/property`,
    { properties: changedProperties(), confirm: true }
  )
  return res.results || []
}

function onPropertySuccess() {
  ElMessage.success('属性更新成功')
  propEditDialog.value = false
  loadProperty() // 重新拉取最新属性
}

// ---- 编辑授权：跳转到 UserEdit 的 edit 模式 ----
function goEdit(user, host) {
  router.push(`/users/${encodeURIComponent(user)}/${encodeURIComponent(host)}/edit`)
}

// ---- 重置密码：dryRun 拿 SQL → SqlPreviewDialog 确认 → 执行 ----
// 复用为「启用」流程：后端改密成功即自动解除禁用标记，故启用 = 重置密码
const pwdDialog = ref(false)
const pwdTarget = ref({ user: '', host: '' })
const pwdValue = ref('')
const pwdMode = ref('reset') // 'reset' 普通重置密码 | 'enable' 启用并重置密码
const sqlDialog = ref(false)
const sqlList = ref([])

const pwdDialogTitle = computed(() => {
  const identity = `'${pwdTarget.value.user}'@'${pwdTarget.value.host}'`
  return pwdMode.value === 'enable' ? `启用并重置密码：${identity}` : `重置密码：${identity}`
})

function openResetPwd(user, host) {
  pwdMode.value = 'reset'
  pwdTarget.value = { user, host }
  pwdValue.value = ''
  pwdDialog.value = true
}

/** 启用：打开重置密码对话框（标题区分），执行成功后后端自动解除禁用标记 */
function openEnable(user, host) {
  pwdMode.value = 'enable'
  pwdTarget.value = { user, host }
  pwdValue.value = ''
  pwdDialog.value = true
}

async function previewResetPwd() {
  try {
    // dryRun：只生成 SQL 不执行
    const res = await api.post(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(pwdTarget.value.user)}/${encodeURIComponent(pwdTarget.value.host)}/password`,
      { password: pwdValue.value, dryRun: true }
    )
    sqlList.value = res.sql || []
    pwdDialog.value = false
    sqlDialog.value = true
  } catch {
    // 拦截器已提示
  }
}

async function executeResetPwd() {
  const res = await api.post(
    `/c/${clusterStore.currentId}/users/${encodeURIComponent(pwdTarget.value.user)}/${encodeURIComponent(pwdTarget.value.host)}/password`,
    { password: pwdValue.value }
  )
  return res.results || []
}

function onResetSuccess() {
  // 改密成功后后端自动解除禁用标记，刷新列表让状态列变回「正常」
  ElMessage.success(pwdMode.value === 'enable' ? '已启用并重置密码' : '密码重置成功')
  loadUsers()
}

// ---- 禁用登录：Doris 无原生禁用，后端随机化密码使其无法登录（授权保留） ----
async function disableLogin(user, host) {
  try {
    await ElMessageBox.confirm(
      `确定禁用 '${user}'@'${host}' 的登录吗？Doris 无原生禁用功能，将随机化该用户的密码使其无法登录（授权信息保留）。如需恢复登录，请使用「启用」或「重置密码」。禁用状态由本平台本地记录；若在平台外直接改密，状态可能不准。`,
      '禁用登录确认',
      { type: 'warning', confirmButtonText: '禁用登录', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  try {
    const res = await api.post(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(user)}/${encodeURIComponent(host)}/disable`
    )
    ElMessage.success(res?.message || '已禁用登录')
    loadUsers() // 刷新列表让状态列变为「已禁用」
  } catch {
    // 拦截器已提示
  }
}

/** host 行样式：禁用行加弱化 class（浅灰底 + 文字变淡） */
function hostRowClass({ row }) {
  return row.disabled ? 'host-row-disabled' : ''
}

/** 禁用时间展示：ISO 字符串转本地可读时间，空值兜底 */
function formatTime(t) {
  if (!t) return '未知'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ---- 删除用户 ----
async function dropUser(user, host) {
  try {
    await ElMessageBox.confirm(
      `确定删除用户 '${user}'@'${host}' 吗？该操作不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  try {
    await api.delete(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(user)}/${encodeURIComponent(host)}`,
      { data: { confirm: true } }
    )
    ElMessage.success('已删除')
    loadUsers()
  } catch {
    // 拦截器已提示
  }
}
</script>

<style scoped>
.host-table {
  padding: 8px 24px;
  background: #fafafa;
}
.muted {
  color: #909399;
}
/* 禁用行视觉弱化：浅灰底 + 文字变淡，一眼可辨不可用 */
.host-table :deep(.host-row-disabled > td) {
  background: #f5f7fa;
  color: #a8abb2;
}
.block {
  margin-bottom: 16px;
}
h4 {
  margin: 12px 0 8px;
  color: #303133;
}
.unparsed {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.tip {
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
  margin-top: 6px;
}
.pwd-line {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
  width: 100%;
}
/* 属性区：标题 + 修改按钮同行 */
.prop-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.prop-header h4 {
  margin: 12px 0 8px;
}
/* 只读灰显属性表：整体灰底灰字，明确表示不可编辑 */
.prop-readonly {
  --el-table-header-bg-color: #f2f3f5;
  --el-table-header-text-color: #909399;
  background: #fafafa;
}
.prop-readonly :deep(.el-table__row) {
  background: #fafafa;
}
.prop-value {
  color: #909399;
}
.raw-json {
  background: #f5f7fa;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 12px;
  font-size: 12px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
