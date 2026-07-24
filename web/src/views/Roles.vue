<template>
  <div class="page-card">
    <div class="toolbar">
      <el-button :icon="Refresh" @click="loadRoles">刷新</el-button>
      <div class="spacer" />
      <el-button v-if="auth.isAdmin" type="primary" :icon="Plus" @click="openCreate">新建角色</el-button>
    </div>

    <!-- 角色列表：SHOW ROLES 原始行表格化 -->
    <el-table v-loading="loading" :data="roles" border>
      <el-table-column label="角色名" width="200">
        <template #default="{ row }">
          {{ roleName(row) }}
          <el-tag v-if="isBuiltin(row)" size="small" type="info" style="margin-left: 6px">系统内置</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="备注">
        <template #default="{ row }">{{ roleComment(row) || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="340">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="viewGrants(roleName(row))">查看授权</el-button>
          <el-button size="small" text type="primary" @click="viewMembers(roleName(row))">查看成员</el-button>
          <template v-if="auth.isAdmin">
            <el-button size="small" text type="primary" :disabled="isBuiltin(row)" @click="openEdit(roleName(row))">编辑授权</el-button>
            <el-button size="small" text type="danger" :disabled="isBuiltin(row)" @click="dropRole(roleName(row))">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建角色对话框 -->
    <el-dialog v-model="createDialog" title="新建角色" width="860px" :close-on-click-modal="false">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="90px">
        <el-form-item label="角色名" prop="role">
          <el-input v-model="createForm.role" placeholder="如 dev_role" style="width: 320px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.comment" placeholder="可选" style="width: 480px" />
        </el-form-item>
        <el-form-item label="授权项">
          <GrantsEditor ref="createEditorRef" v-model="createForm.grants" :cluster-id="clusterStore.currentId" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="previewing" @click="previewCreate">预览 SQL</el-button>
      </template>
    </el-dialog>

    <!-- 编辑角色授权对话框 -->
    <el-dialog v-model="editDialog" :title="`编辑授权：${editRole}`" width="860px" :close-on-click-modal="false">
      <GrantsEditor ref="editEditorRef" v-model="editGrants" :cluster-id="clusterStore.currentId" />
      <template #footer>
        <el-button @click="editDialog = false">取消</el-button>
        <el-button type="primary" :loading="previewing" @click="previewEdit">预览变更 SQL</el-button>
      </template>
    </el-dialog>

    <!-- 查看授权抽屉 -->
    <el-drawer v-model="grantsDrawer" :title="`角色授权：${grantsRole}`" size="640px">
      <template v-if="grantsData">
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
        <template v-if="grantsData.unparsed?.length">
          <h4>未能解析的内容</h4>
          <div v-for="(u, i) in grantsData.unparsed" :key="i" class="block unparsed">
            <el-tag size="small" type="warning">{{ u.field }}</el-tag>
            <span class="mono">{{ u.value }}</span>
          </div>
        </template>
        <h4>原始数据</h4>
        <pre class="raw-json mono">{{ JSON.stringify(grantsData.raw, null, 2) }}</pre>
      </template>
      <el-skeleton v-else :rows="6" animated />
    </el-drawer>

    <!-- 成员对话框 -->
    <el-dialog v-model="memberDialog" :title="`角色成员：${memberRole}`" width="480px">
      <template v-if="members.length">
        <el-tag v-for="m in members" :key="m" style="margin: 4px 8px 4px 0">{{ m }}</el-tag>
      </template>
      <el-empty v-else description="该角色暂无成员" :image-size="60" />
    </el-dialog>

    <!-- SQL 预览对话框（新建 / 编辑共用） -->
    <SqlPreviewDialog v-model="sqlDialog" :title="sqlDialogTitle" :sql-list="sqlList" :executor="sqlExecutor" @success="onSqlSuccess" />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus } from '@element-plus/icons-vue'
import api from '../api'
import { useAuthStore, useClusterStore } from '../store'
import { levelLabel, grantTargetText } from '../utils/grants'
import GrantsEditor from '../components/GrantsEditor.vue'
import SqlPreviewDialog from '../components/SqlPreviewDialog.vue'

const auth = useAuthStore()
const clusterStore = useClusterStore()

const loading = ref(false)
const roles = ref([])

// SHOW ROLES 原始行按列名容错取值（不同 Doris 版本列名有差异）
function roleName(row) {
  return row.Name ?? row.name ?? Object.values(row)[0]
}
function roleComment(row) {
  return row.Comment ?? row.comment ?? ''
}
// 系统内置角色禁止删除/编辑
function isBuiltin(row) {
  return ['admin', 'operator'].includes(String(roleName(row)).toLowerCase())
}

onMounted(loadRoles)

async function loadRoles() {
  if (!clusterStore.currentId) return
  loading.value = true
  try {
    roles.value = await api.get(`/c/${clusterStore.currentId}/roles`)
  } catch {
    roles.value = []
  } finally {
    loading.value = false
  }
}

// ---- 新建角色 ----
const createDialog = ref(false)
const createFormRef = ref()
const createEditorRef = ref()
const createForm = reactive({ role: '', comment: '', grants: [] })
const createRules = {
  role: [
    { required: true, message: '请输入角色名', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9_$][A-Za-z0-9_.$-]*$/, message: '仅允许字母、数字、_ $ . -', trigger: 'blur' }
  ]
}

function openCreate() {
  createForm.role = ''
  createForm.comment = ''
  createForm.grants = []
  createDialog.value = true
}

// ---- 编辑角色授权 ----
const editDialog = ref(false)
const editEditorRef = ref()
const editRole = ref('')
const editGrants = ref([])

async function openEdit(role) {
  editRole.value = role
  editGrants.value = []
  editDialog.value = true
  try {
    const data = await api.get(`/c/${clusterStore.currentId}/roles/${encodeURIComponent(role)}/grants`)
    editGrants.value = data.grants || []
  } catch {
    // 拦截器已提示
  }
}

// ---- 预览与执行（新建 / 编辑复用 SqlPreviewDialog） ----
const previewing = ref(false)
const sqlDialog = ref(false)
const sqlDialogTitle = ref('')
const sqlList = ref([])
let sqlExecutor = async () => []
let sqlMode = '' // 'create' | 'edit'

async function previewCreate() {
  await createFormRef.value.validate()
  const check = createEditorRef.value.validate()
  if (!check.ok) return ElMessage.warning(check.message)
  previewing.value = true
  try {
    const res = await api.post(`/c/${clusterStore.currentId}/roles/preview`, {
      role: createForm.role,
      comment: createForm.comment,
      grants: createForm.grants
    })
    sqlList.value = res.sql || []
    sqlDialogTitle.value = `创建角色「${createForm.role}」SQL 确认`
    sqlMode = 'create'
    sqlExecutor = async () => {
      const r = await api.post(`/c/${clusterStore.currentId}/roles`, {
        role: createForm.role,
        comment: createForm.comment,
        grants: createForm.grants,
        confirm: true
      })
      return r.results || []
    }
    createDialog.value = false
    sqlDialog.value = true
  } catch {
    // 拦截器已提示
  } finally {
    previewing.value = false
  }
}

async function previewEdit() {
  const check = editEditorRef.value.validate()
  if (!check.ok) return ElMessage.warning(check.message)
  previewing.value = true
  try {
    const res = await api.post(`/c/${clusterStore.currentId}/roles/${encodeURIComponent(editRole.value)}/preview-update`, {
      grants: editGrants.value
    })
    sqlList.value = res.sql || []
    if (sqlList.value.length === 0) {
      ElMessage.info('无变更')
      return
    }
    sqlDialogTitle.value = `更新角色「${editRole.value}」授权 SQL 确认`
    sqlMode = 'edit'
    sqlExecutor = async () => {
      const r = await api.put(`/c/${clusterStore.currentId}/roles/${encodeURIComponent(editRole.value)}`, {
        grants: editGrants.value,
        confirm: true
      })
      return r.results || []
    }
    editDialog.value = false
    sqlDialog.value = true
  } catch {
    // 拦截器已提示
  } finally {
    previewing.value = false
  }
}

function onSqlSuccess() {
  ElMessage.success(sqlMode === 'create' ? '角色创建成功' : '授权更新成功')
  loadRoles()
}

// ---- 查看授权 ----
const grantsDrawer = ref(false)
const grantsRole = ref('')
const grantsData = ref(null)

async function viewGrants(role) {
  grantsRole.value = role
  grantsData.value = null
  grantsDrawer.value = true
  try {
    grantsData.value = await api.get(`/c/${clusterStore.currentId}/roles/${encodeURIComponent(role)}/grants`)
  } catch {
    grantsDrawer.value = false
  }
}

// ---- 查看成员 ----
const memberDialog = ref(false)
const memberRole = ref('')
const members = ref([])

async function viewMembers(role) {
  memberRole.value = role
  members.value = []
  memberDialog.value = true
  try {
    members.value = await api.get(`/c/${clusterStore.currentId}/roles/${encodeURIComponent(role)}/members`)
  } catch {
    // 拦截器已提示
  }
}

// ---- 删除角色（内置角色前端禁用，后端也会拦截） ----
async function dropRole(role) {
  try {
    await ElMessageBox.confirm(`确定删除角色「${role}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  try {
    await api.delete(`/c/${clusterStore.currentId}/roles/${encodeURIComponent(role)}`)
    ElMessage.success('已删除')
    loadRoles()
  } catch {
    // 拦截器已提示
  }
}
</script>

<style scoped>
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
