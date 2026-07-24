<template>
  <div class="page-card">
    <div class="toolbar">
      <el-button :icon="Refresh" @click="load">刷新</el-button>
      <div class="spacer" />
      <el-button type="primary" :icon="Plus" @click="openCreate">新建账号</el-button>
    </div>

    <el-table v-loading="loading" :data="accounts" border>
      <el-table-column label="用户名" prop="username" />
      <el-table-column label="角色" width="140" align="center">
        <template #default="{ row }">
          <el-tag :type="row.role === 'admin' ? 'danger' : 'info'" size="small">
            {{ row.role === 'admin' ? '管理员' : '只读' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" prop="createdAt" width="200" />
      <el-table-column label="操作" width="260">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openRole(row)">改角色</el-button>
          <el-button size="small" text type="warning" @click="openResetPwd(row)">重置密码</el-button>
          <!-- 禁止删除自己 -->
          <el-button size="small" text type="danger" :disabled="row.username === auth.user?.username" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建账号 -->
    <el-dialog v-model="createDialog" title="新建账号" width="440px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="80px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="createForm.username" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="createForm.password" type="password" show-password placeholder="至少 8 位，含字母和数字" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-radio-group v-model="createForm.role">
            <el-radio value="admin">管理员</el-radio>
            <el-radio value="readonly">只读</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 改角色 -->
    <el-dialog v-model="roleDialog" :title="`修改角色：${target.username}`" width="400px">
      <el-radio-group v-model="target.role">
        <el-radio value="admin">管理员</el-radio>
        <el-radio value="readonly">只读</el-radio>
      </el-radio-group>
      <template #footer>
        <el-button @click="roleDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitRole">确定</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="pwdDialog" :title="`重置密码：${target.username}`" width="440px">
      <el-input v-model="target.password" type="password" show-password placeholder="新密码：至少 8 位，含字母和数字" />
      <template #footer>
        <el-button @click="pwdDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!target.password" @click="submitResetPwd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus } from '@element-plus/icons-vue'
import api from '../api'
import { useAuthStore } from '../store'

const auth = useAuthStore()

const loading = ref(false)
const submitting = ref(false)
const accounts = ref([])

onMounted(load)

async function load() {
  loading.value = true
  try {
    accounts.value = await api.get('/accounts')
  } catch {
    accounts.value = []
  } finally {
    loading.value = false
  }
}

// ---- 新建 ----
const createDialog = ref(false)
const createFormRef = ref()
const createForm = reactive({ username: '', password: '', role: 'readonly' })
// 密码强度规则与后端一致：≥8 位且含字母+数字
const PWD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/
const createRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { pattern: PWD_PATTERN, message: '至少 8 位，且同时包含字母和数字', trigger: 'blur' }
  ],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }]
}

function openCreate() {
  Object.assign(createForm, { username: '', password: '', role: 'readonly' })
  createDialog.value = true
}

async function submitCreate() {
  await createFormRef.value.validate()
  submitting.value = true
  try {
    await api.post('/accounts', { ...createForm })
    ElMessage.success('创建成功')
    createDialog.value = false
    load()
  } catch {
    // 拦截器已提示
  } finally {
    submitting.value = false
  }
}

// ---- 改角色 / 重置密码（共用 target） ----
const roleDialog = ref(false)
const pwdDialog = ref(false)
const target = reactive({ username: '', role: '', password: '' })

function openRole(row) {
  Object.assign(target, { username: row.username, role: row.role, password: '' })
  roleDialog.value = true
}

function openResetPwd(row) {
  Object.assign(target, { username: row.username, role: row.role, password: '' })
  pwdDialog.value = true
}

async function submitRole() {
  submitting.value = true
  try {
    await api.put(`/accounts/${encodeURIComponent(target.username)}`, { role: target.role })
    ElMessage.success('角色已更新')
    roleDialog.value = false
    load()
  } catch {
    // 后端会拦截"把自己改成 readonly / 删除最后一个 admin"
  } finally {
    submitting.value = false
  }
}

async function submitResetPwd() {
  if (!PWD_PATTERN.test(target.password)) {
    ElMessage.warning('密码至少 8 位，且同时包含字母和数字')
    return
  }
  submitting.value = true
  try {
    await api.put(`/accounts/${encodeURIComponent(target.username)}`, { password: target.password })
    ElMessage.success('密码已重置')
    pwdDialog.value = false
  } catch {
    // 拦截器已提示
  } finally {
    submitting.value = false
  }
}

// ---- 删除 ----
async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除账号「${row.username}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  try {
    await api.delete(`/accounts/${encodeURIComponent(row.username)}`)
    ElMessage.success('已删除')
    load()
  } catch {
    // 拦截器已提示
  }
}
</script>
