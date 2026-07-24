<template>
  <div class="page-card">
    <div class="toolbar">
      <el-button :icon="Refresh" @click="loadClusters">刷新</el-button>
      <div class="spacer" />
      <el-button v-if="auth.isAdmin" type="primary" :icon="Plus" @click="openForm()">新增集群</el-button>
    </div>

    <el-table v-loading="loading" :data="clusterStore.list" border>
      <el-table-column label="名称" prop="name" width="180" />
      <el-table-column label="地址" prop="host" />
      <el-table-column label="端口" prop="port" width="100" align="center" />
      <el-table-column label="账号" prop="username" width="140" />
      <!-- 单活跃语义：同一时间只有一个"当前集群"，所有用户/角色管理都针对它 -->
      <el-table-column label="当前集群" width="170" align="center">
        <template #default="{ row }">
          <el-button size="small" text type="primary" :disabled="isCurrent(row)" @click="setCurrent(row)">
            设为当前
          </el-button>
          <el-tag v-if="isCurrent(row)" type="success" size="small" style="margin-left: 4px">当前</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="连接状态" width="140" align="center">
        <template #default="{ row }">
          <!-- 进入页面自动逐个测试：转圈 → 绿/红 -->
          <el-icon v-if="testState[row.id]?.status === 'testing'" class="is-loading"><Loading /></el-icon>
          <el-tag v-else-if="testState[row.id]?.status === 'ok'" type="success" size="small">
            正常 {{ testState[row.id].version ? `(${testState[row.id].version})` : '' }}
          </el-tag>
          <el-tooltip v-else-if="testState[row.id]?.status === 'fail'" :content="testState[row.id].error" placement="top">
            <el-tag type="danger" size="small">连接失败</el-tag>
          </el-tooltip>
          <span v-else class="muted">未测试</span>
        </template>
      </el-table-column>
      <el-table-column v-if="auth.isAdmin" label="操作" width="170">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openForm(row)">编辑</el-button>
          <el-button size="small" text type="danger" @click="removeCluster(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增 / 编辑集群对话框 -->
    <el-dialog v-model="formDialog" :title="form.id ? '编辑集群' : '新增集群'" width="480px" :close-on-click-modal="false">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="90px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如 生产集群" />
        </el-form-item>
        <el-form-item label="地址" prop="host">
          <el-input v-model="form.host" placeholder="FE 地址，如 192.168.1.10" />
        </el-form-item>
        <el-form-item label="端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" />
          <span class="muted" style="margin-left: 8px">MySQL 协议端口，默认 9030</span>
        </el-form-item>
        <el-form-item label="账号" prop="username">
          <el-input v-model="form.username" placeholder="Doris 账号，如 root / admin" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="form.id ? '留空表示不修改密码' : 'Doris 账号密码'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :loading="testing" @click="testForm">测试连接</el-button>
        <el-button @click="formDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus, Loading } from '@element-plus/icons-vue'
import api from '../api'
import { useAuthStore, useClusterStore } from '../store'

const auth = useAuthStore()
const clusterStore = useClusterStore()

const loading = ref(false)
// 每个集群的连通性测试状态：{ [id]: {status: testing|ok|fail, version, error} }
const testState = ref({})

onMounted(loadClusters)

/** 是否当前集群（currentId 持久化在 localStorage，刷新页面不丢） */
function isCurrent(row) {
  return String(row.id) === String(clusterStore.currentId)
}

/** 设为当前集群：写入 Pinia + localStorage；Layout 的 router-view key 随 currentId 变化，当前页数据自动刷新 */
function setCurrent(row) {
  if (isCurrent(row)) return
  clusterStore.select(row.id)
  ElMessage.success(`已将「${row.name}」设为当前集群`)
}

async function loadClusters() {
  loading.value = true
  try {
    await clusterStore.load()
    testAll()
  } finally {
    loading.value = false
  }
}

/** 进入页面自动逐个调用 test 接口 */
async function testAll() {
  for (const c of clusterStore.list) {
    testState.value[c.id] = { status: 'testing' }
    api
      .post(`/clusters/${c.id}/test`)
      .then((res) => {
        // 优先展示真实 Doris 版本（dorisVersion），无权限探测时回退协议版本
        testState.value[c.id] = res.ok
          ? { status: 'ok', version: res.dorisVersion || res.version }
          : { status: 'fail', error: res.error || '连接失败' }
      })
      .catch((e) => {
        testState.value[c.id] = {
          status: 'fail',
          error: e.response?.data?.error?.message || '连接失败'
        }
      })
  }
}

// ---- 新增 / 编辑 ----
const formDialog = ref(false)
const formRef = ref()
const saving = ref(false)
const testing = ref(false)
const form = reactive({ id: null, name: '', host: '', port: 9030, username: '', password: '' })

const formRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  host: [{ required: true, message: '请输入地址', trigger: 'blur' }],
  port: [{ required: true, message: '请输入端口', trigger: 'blur' }],
  username: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  password: [
    {
      validator: (r, v, cb) => {
        if (!form.id && !v) return cb(new Error('请输入密码'))
        cb()
      },
      trigger: 'blur'
    }
  ]
}

function openForm(row) {
  if (row) {
    Object.assign(form, { id: row.id, name: row.name, host: row.host, port: row.port, username: row.username, password: '' })
  } else {
    Object.assign(form, { id: null, name: '', host: '', port: 9030, username: '', password: '' })
  }
  formDialog.value = true
}

/** 表单内"测试连接"：新增时先临时保存再测？——改为直接调已有集群 test 或提示先保存。
 *  为免产生脏数据，这里对未保存的新集群给出提示；编辑场景先保存再测。 */
async function testForm() {
  await formRef.value.validate()
  if (!form.id) {
    ElMessage.info('请先保存集群，保存成功后会自动测试连接')
    return
  }
  testing.value = true
  try {
    // 编辑场景连接信息可能已变更，先保存再测试
    await save(true)
    const res = await api.post(`/clusters/${form.id}/test`)
    const ver = res.dorisVersion || res.version
    if (res.ok) ElMessage.success(`连接成功${ver ? `，版本：${ver}` : ''}`)
    else ElMessage.error(`连接失败：${res.error || ''}`)
  } catch {
    // 拦截器已提示
  } finally {
    testing.value = false
  }
}

async function save(silent = false) {
  await formRef.value.validate()
  saving.value = true
  try {
    const body = { name: form.name, host: form.host, port: form.port, username: form.username }
    if (form.password) body.password = form.password
    if (form.id) {
      await api.put(`/clusters/${form.id}`, body)
    } else {
      // 后端创建前会实测连接，失败返回 400 中文原因
      const created = await api.post('/clusters', body)
      form.id = created.id
    }
    if (!silent) {
      ElMessage.success('已保存')
      formDialog.value = false
    }
    await clusterStore.load()
    testAll()
  } catch (e) {
    if (silent) throw e
    // 拦截器已提示
  } finally {
    saving.value = false
  }
}

async function removeCluster(row) {
  try {
    await ElMessageBox.confirm(`确定删除集群「${row.name}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  try {
    await api.delete(`/clusters/${row.id}`)
    ElMessage.success('已删除')
    await clusterStore.load()
  } catch {
    // 拦截器已提示
  }
}
</script>

<style scoped>
.muted {
  color: #909399;
  font-size: 12px;
}
</style>
