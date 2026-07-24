<template>
  <el-container class="layout">
    <!-- 深色侧边栏 -->
    <el-aside width="210px" class="sidebar">
      <div class="logo">
        <img class="logo-img" src="/logo.png" alt="DM" />
        <span class="logo-text">DorisMan</span>
      </div>
      <el-menu :default-active="activeMenu" router background-color="#1f2d3d" text-color="#bfcbd9" active-text-color="#ffffff">
        <el-menu-item index="/users">
          <el-icon><User /></el-icon><span>用户管理</span>
        </el-menu-item>
        <el-menu-item index="/roles">
          <el-icon><Avatar /></el-icon><span>角色管理</span>
        </el-menu-item>
        <el-menu-item v-if="auth.isAdmin" index="/sql">
          <el-icon><Monitor /></el-icon><span>SQL控制台</span>
        </el-menu-item>
        <!-- 系统管理分组：审计日志 / 集群管理 / 系统用户（路由路径不变） -->
        <el-sub-menu index="system">
          <template #title>
            <el-icon><Setting /></el-icon><span>系统管理</span>
          </template>
          <el-menu-item v-if="auth.isAdmin" index="/audit">
            <el-icon><Document /></el-icon><span>审计日志</span>
          </el-menu-item>
          <el-menu-item index="/clusters">
            <el-icon><Connection /></el-icon><span>集群管理</span>
          </el-menu-item>
          <el-menu-item v-if="auth.isAdmin" index="/accounts">
            <el-icon><Postcard /></el-icon><span>系统用户</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
    </el-aside>

    <el-container>
      <!-- 顶栏：左侧集群切换，右侧账号菜单 -->
      <el-header class="topbar">
        <div class="cluster-switch">
          <span class="label">当前集群</span>
          <el-select
            :model-value="clusterStore.currentId"
            placeholder="无可用集群"
            style="width: 300px"
            :disabled="!clusterStore.hasCluster"
            @change="onSwitchCluster"
          >
            <el-option v-for="c in clusterStore.list" :key="c.id" :value="String(c.id)" :label="`${c.name}（${c.host}:${c.port}）`" />
          </el-select>
        </div>

        <div class="topbar-right">
          <!-- 当前集群醒目标识：所有用户/角色管理操作都针对该集群 -->
          <div v-if="clusterStore.current" class="current-cluster" title="当前集群（所有管理操作均针对它）">
            <el-icon class="cc-icon"><Connection /></el-icon>
            <span class="cc-name">{{ clusterStore.current.name }}</span>
            <span class="cc-addr">{{ clusterStore.current.host }}:{{ clusterStore.current.port }}</span>
          </div>

          <el-dropdown @command="onUserCommand">
            <span class="user-menu">
              <el-icon><UserFilled /></el-icon>
              {{ auth.user?.username }}
              <el-tag size="small" :type="auth.isAdmin ? 'danger' : 'info'" style="margin-left: 4px">
                {{ auth.isAdmin ? '管理员' : '只读' }}
              </el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="password">修改密码</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 内容区：无集群时（集群管理页除外）显示空状态引导 -->
      <el-main class="content">
        <el-empty
          v-if="showNoClusterTip"
          description="暂无可用集群，请先到「集群管理」添加集群"
        >
          <el-button type="primary" @click="$router.push('/clusters')">前往集群管理</el-button>
        </el-empty>
        <!-- key 绑定集群 id：切换集群后强制重建页面组件以刷新数据 -->
        <router-view v-else :key="clusterStore.currentId" />
      </el-main>
    </el-container>
  </el-container>

  <!-- 修改密码对话框 -->
  <el-dialog v-model="pwdDialog" title="修改密码" width="420px">
    <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="80px">
      <el-form-item label="原密码" prop="oldPassword">
        <el-input v-model="pwdForm.oldPassword" type="password" show-password />
      </el-form-item>
      <el-form-item label="新密码" prop="newPassword">
        <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少 8 位，含字母和数字" />
      </el-form-item>
      <el-form-item label="确认密码" prop="confirm">
        <el-input v-model="pwdForm.confirm" type="password" show-password />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="pwdDialog = false">取消</el-button>
      <el-button type="primary" :loading="pwdLoading" @click="submitPassword">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { User, Avatar, Monitor, Document, Connection, Setting, UserFilled, Postcard } from '@element-plus/icons-vue'
import { useAuthStore, useClusterStore } from '../store'
import api from '../api'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const clusterStore = useClusterStore()

const activeMenu = computed(() => '/' + (route.path.split('/')[1] || 'users'))

// 进入布局时确保集群列表已加载（Login 已预载，这里兜底刷新场景）
onMounted(() => {
  if (!clusterStore.loaded) clusterStore.load().catch(() => {})
})

// 无集群且不在集群管理页时显示引导空状态
const showNoClusterTip = computed(() => clusterStore.loaded && !clusterStore.hasCluster && route.path !== '/clusters')

/** 切换集群：写入 Pinia；router-view 的 key 变化会自动刷新当前页 */
function onSwitchCluster(id) {
  clusterStore.select(id)
  ElMessage.success('已切换集群')
}

// ---- 修改密码 ----
const pwdDialog = ref(false)
const pwdLoading = ref(false)
const pwdFormRef = ref()
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' })

const pwdRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      // 与后端一致：≥8 位且含字母+数字
      pattern: /^(?=.*[A-Za-z])(?=.*\d).{8,}$/,
      message: '至少 8 位，且同时包含字母和数字',
      trigger: 'blur'
    }
  ],
  confirm: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (r, v, cb) => (v === pwdForm.newPassword ? cb() : cb(new Error('两次输入不一致'))),
      trigger: 'blur'
    }
  ]
}

function onUserCommand(cmd) {
  if (cmd === 'logout') {
    ElMessageBox.confirm('确定退出登录吗？', '提示', { type: 'warning' }).then(() => {
      auth.logout()
      router.push('/login')
    }).catch(() => {})
  } else if (cmd === 'password') {
    pwdForm.oldPassword = pwdForm.newPassword = pwdForm.confirm = ''
    pwdDialog.value = true
  }
}

async function submitPassword() {
  await pwdFormRef.value.validate()
  pwdLoading.value = true
  try {
    await api.post('/auth/change-password', {
      oldPassword: pwdForm.oldPassword,
      newPassword: pwdForm.newPassword
    })
    ElMessage.success('密码修改成功')
    pwdDialog.value = false
  } catch {
    // 拦截器已提示
  } finally {
    pwdLoading.value = false
  }
}
</script>

<style scoped>
.layout {
  height: 100%;
}
.sidebar {
  background-color: #1f2d3d;
}
.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #fff;
  font-size: 20px;
  font-weight: bold;
  letter-spacing: 1px;
}
.logo-img {
  width: 30px;
  height: 30px;
  border-radius: 7px;
}
.sidebar :deep(.el-menu) {
  border-right: none;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}
.cluster-switch {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cluster-switch .label {
  color: #606266;
  font-size: 14px;
}
.user-menu {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: #303133;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
/* 顶栏右侧当前集群醒目标识：绿色徽章，名称加粗 + host:port */
.current-cluster {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 4px;
  background: #f0f9eb;
  border: 1px solid #b3d8a4;
}
.cc-icon {
  color: #529b2e;
}
.cc-name {
  font-weight: 700;
  font-size: 14px;
  color: #303133;
}
.cc-addr {
  font-size: 13px;
  color: #529b2e;
  font-weight: 600;
}
.content {
  background: #f0f2f5;
  overflow-y: auto;
}
</style>
