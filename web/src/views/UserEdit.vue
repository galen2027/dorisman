<template>
  <div class="page-card">
    <el-page-header :content="isEdit ? `编辑授权：'${route.params.user}'@'${route.params.host}'` : '新建用户'" @back="$router.push('/users')" />

    <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" style="margin-top: 20px; max-width: 980px">
      <!-- 用户名：create 提供常用预置建议（仍可自由输入）；edit 模式锁定 -->
      <el-form-item label="用户名" prop="user">
        <el-autocomplete
          v-if="!isEdit"
          v-model="form.user"
          :fetch-suggestions="queryUserPresets"
          placeholder="如 devuser，可直接选择预置账号"
          style="width: 320px"
        />
        <el-input v-else v-model="form.user" disabled style="width: 320px" />
      </el-form-item>

      <!-- 从现有用户复制（仅 create 模式）：预填角色与授权项，密码与来源地址不复制 -->
      <el-form-item v-if="!isEdit" label="从现有用户复制">
        <el-select
          v-model="cloneSource"
          filterable
          clearable
          placeholder="选择源用户 user@host（可选）"
          style="width: 380px"
        >
          <el-option v-for="opt in cloneOptions" :key="opt.value" :label="opt.value" :value="opt.value" />
        </el-select>
        <el-button :disabled="!cloneSource" :loading="cloning" @click="applyClone">复制授权</el-button>
        <div class="tip">将源用户的角色与授权项预填到下方表单（会覆盖当前已填的角色与授权项）；密码与来源地址不会被复制</div>
      </el-form-item>

      <!-- 来源地址 hosts：create 为 tag 多值输入；edit 锁定为当前 host -->
      <el-form-item label="来源地址" prop="hosts">
        <el-select
          v-if="!isEdit"
          v-model="form.hosts"
          multiple
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          no-data-text="输入后回车添加，如 10.% 、172.16.% 、% 或具体 IP"
          placeholder="输入 host 后回车添加，可多个"
          style="width: 520px"
        />
        <el-input v-else :model-value="form.hosts[0] || route.params.host" disabled style="width: 320px" />
        <div class="tip">支持 % 通配，如 10.% 、172.16.% 、% 或具体 IP</div>
      </el-form-item>

      <!-- 密码：create 必填；edit 留空表示不修改 -->
      <!-- 布局：el-input 自带 show-password 眼睛图标（输入框内部），随机生成按钮独立放右侧同行，任何宽度下都不重叠 -->
      <el-form-item label="密码" :prop="isEdit ? '' : 'password'">
        <div class="pwd-line">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="isEdit ? '留空表示不修改密码' : '请输入或随机生成'"
            style="width: 320px"
          />
          <el-button @click="form.password = generatePassword()">随机生成</el-button>
        </div>
        <div v-if="form.password" class="tip">强度：{{ strength.label }}</div>
      </el-form-item>

      <!-- 角色多选 -->
      <el-form-item label="角色">
        <el-select v-model="form.roles" multiple filterable placeholder="选择要授予的角色" style="width: 520px">
          <el-option v-for="r in roleOptions" :key="r" :label="r" :value="r" />
        </el-select>
      </el-form-item>

      <!-- 授权项编辑器（GrantsEditor 复用组件） -->
      <el-form-item label="授权项">
        <GrantsEditor ref="editorRef" v-model="form.grants" :cluster-id="clusterStore.currentId" style="width: 100%" />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="previewing" @click="preview">预览 SQL</el-button>
        <el-button @click="$router.push('/users')">返回列表</el-button>
      </el-form-item>
    </el-form>

    <!-- SQL 预览与确认 -->
    <SqlPreviewDialog v-model="sqlDialog" :title="isEdit ? '更新授权 SQL 确认' : '创建用户 SQL 确认'" :sql-list="sqlList" :executor="execute" @success="onSuccess">
      <!-- edit 模式：展示接口返回的当前授权，便于与变更对照 -->
      <el-collapse v-if="isEdit && currentGrants" style="margin-bottom: 12px">
        <el-collapse-item title="当前授权（变更前，来自 SHOW GRANTS）" name="1">
          <div v-if="currentGrants.roles?.length" class="current-line">
            角色：<el-tag v-for="r in currentGrants.roles" :key="r" size="small" style="margin-right: 4px">{{ r }}</el-tag>
          </div>
          <div v-for="(g, i) in currentGrants.grants" :key="i" class="current-line mono">
            [{{ levelLabel(g.level) }}] {{ grantTargetText(g) }} → {{ g.privileges.join(', ') }}{{ g.grantOption ? '（WITH GRANT OPTION）' : '' }}
          </div>
          <div v-if="!currentGrants.grants?.length" class="current-line">（当前无授权项）</div>
        </el-collapse-item>
      </el-collapse>
    </SqlPreviewDialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api from '../api'
import { useClusterStore } from '../store'
import { generatePassword, passwordStrength } from '../utils/password'
import { levelLabel, grantTargetText } from '../utils/grants'
import { isBuiltinUser } from '../utils/builtin'
import GrantsEditor from '../components/GrantsEditor.vue'
import SqlPreviewDialog from '../components/SqlPreviewDialog.vue'

const route = useRoute()
const router = useRouter()
const clusterStore = useClusterStore()

// 模式判断：路由带 user/host 参数即 edit
const isEdit = computed(() => !!route.params.user)

const formRef = ref()
const editorRef = ref()
const form = reactive({
  user: '',
  hosts: [],
  password: '',
  roles: [],
  grants: []
})

const strength = computed(() => passwordStrength(form.password))

// 用户名快捷预置（仅 create 模式展示，仍允许自由输入）
const USER_PRESETS = ['rowin', 'rowu', 'rochx']
function queryUserPresets(qs, cb) {
  const kw = (qs || '').trim().toLowerCase()
  cb(USER_PRESETS.filter((n) => !kw || n.toLowerCase().includes(kw)).map((value) => ({ value })))
}

// host 格式校验：% 通配 / IP 段 / 具体 IP 等安全字符（SPEC 5.3.6）
const HOST_PATTERN = /^[A-Za-z0-9_$.%-]+$/
const rules = {
  user: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9_$][A-Za-z0-9_$.-]*$/, message: '仅允许字母、数字、_ $ . -', trigger: 'blur' }
  ],
  hosts: [
    {
      validator: (r, v, cb) => {
        if (!v || v.length === 0) return cb(new Error('请至少添加一个来源地址'))
        if (v.some((h) => !HOST_PATTERN.test(h))) return cb(new Error('host 仅允许字母、数字、_ $ . % -'))
        cb()
      },
      trigger: 'change'
    }
  ],
  password: [{ required: true, message: '请输入密码（可点击随机生成）', trigger: 'blur' }]
}

// 角色选项（来自 roles 接口，SHOW ROLES 原始行按列名容错取名）
const roleOptions = ref([])

// ---- 从现有用户复制（create 模式）：选项为用户列表展开的 user@host ----
const cloneOptions = ref([]) // [{ value: "'u'@'h'", user, host }]
const cloneSource = ref('')
const cloning = ref(false)

onMounted(async () => {
  // 内置账号兜底：root/admin 平台内只读，直接输 URL 进入编辑页也立即跳回用户列表
  if (isEdit.value && isBuiltinUser(route.params.user)) {
    ElMessage.warning('内置账号 root/admin 仅可查看，不允许在平台内编辑授权')
    router.replace('/users')
    return
  }
  // 加载角色列表供多选
  try {
    const rows = await api.get(`/c/${clusterStore.currentId}/roles`)
    roleOptions.value = (rows || []).map((r) => r.Name ?? r.name ?? Object.values(r)[0]).filter(Boolean)
  } catch {
    roleOptions.value = []
  }

  if (isEdit.value) {
    // edit 模式：预填当前授权与角色，用户名/host 锁定
    form.user = route.params.user
    // 把当前 host 保留在表单模型中：hosts 校验要求"至少一个来源地址"，
    // 否则 edit 模式（hosts 输入锁定置灰）会因 hosts 为空而无法通过提交校验
    form.hosts = [route.params.host]
    try {
      const data = await api.get(
        `/c/${clusterStore.currentId}/users/${encodeURIComponent(route.params.user)}/${encodeURIComponent(route.params.host)}/grants`
      )
      form.roles = data.roles || []
      form.grants = data.grants || []
    } catch {
      // 拦截器已提示
    }
  } else {
    // create 模式：加载用户列表供"从现有用户复制"选择
    try {
      const users = await api.get(`/c/${clusterStore.currentId}/users`)
      const opts = []
      for (const u of users || []) {
        for (const h of u.hosts || []) {
          if (!h.host) continue
          opts.push({ value: `'${u.user}'@'${h.host}'`, user: u.user, host: h.host })
        }
      }
      cloneOptions.value = opts
    } catch {
      cloneOptions.value = []
    }
  }
})

/** 复制源用户的角色与授权项到表单（密码与来源地址保持当前已填值，不复制） */
async function applyClone() {
  const opt = cloneOptions.value.find((o) => o.value === cloneSource.value)
  if (!opt) return
  cloning.value = true
  try {
    const data = await api.get(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(opt.user)}/${encodeURIComponent(opt.host)}/grants`
    )
    form.roles = [...(data.roles || [])]
    // 深拷贝授权项（保留 workloadGroup 等全部字段），避免与接口数据共享引用
    form.grants = (data.grants || []).map((g) => ({
      ...g,
      privileges: [...(g.privileges || [])],
      grantOption: !!g.grantOption
    }))
    ElMessage.success(`已复制 '${opt.user}'@'${opt.host}' 的角色与授权项，请核对后预览`)
  } catch {
    // 拦截器已提示
  } finally {
    cloning.value = false
  }
}

// ---- 预览 / 执行 ----
const previewing = ref(false)
const sqlDialog = ref(false)
const sqlList = ref([])
const currentGrants = ref(null) // edit 模式 preview-update 返回的当前授权

async function preview() {
  await formRef.value.validate()
  const check = editorRef.value.validate()
  if (!check.ok) {
    ElMessage.warning(check.message)
    return
  }
  previewing.value = true
  try {
    if (isEdit.value) {
      const res = await api.post(
        `/c/${clusterStore.currentId}/users/${encodeURIComponent(route.params.user)}/${encodeURIComponent(route.params.host)}/preview-update`,
        { password: form.password || null, roles: form.roles, grants: form.grants }
      )
      sqlList.value = res.sql || []
      currentGrants.value = res.current || null
    } else {
      const res = await api.post(`/c/${clusterStore.currentId}/users/preview`, {
        user: form.user,
        hosts: form.hosts,
        password: form.password,
        roles: form.roles,
        grants: form.grants
      })
      sqlList.value = res.sql || []
      currentGrants.value = null
    }
    sqlDialog.value = true
  } catch {
    // 拦截器已提示
  } finally {
    previewing.value = false
  }
}

async function execute() {
  if (isEdit.value) {
    const res = await api.put(
      `/c/${clusterStore.currentId}/users/${encodeURIComponent(route.params.user)}/${encodeURIComponent(route.params.host)}`,
      { password: form.password || null, roles: form.roles, grants: form.grants, confirm: true }
    )
    return res.results || []
  }
  const res = await api.post(`/c/${clusterStore.currentId}/users`, {
    user: form.user,
    hosts: form.hosts,
    password: form.password,
    roles: form.roles,
    grants: form.grants,
    confirm: true
  })
  return res.results || []
}

function onSuccess() {
  ElMessage.success(isEdit.value ? '授权更新成功' : '用户创建成功')
  router.push('/users')
}
</script>

<style scoped>
.tip {
  width: 100%;
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}
/* 密码行：输入框（内置眼睛图标）+ 随机生成按钮同行 flex 排布，保证不重叠 */
.pwd-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  width: 100%;
}
.current-line {
  margin-bottom: 6px;
  font-size: 13px;
}
</style>
