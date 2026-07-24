<template>
  <div class="login-page">
    <el-card class="login-card">
      <div class="login-title">
        <img class="login-logo" src="/logo.png" alt="DorisMan" />
        <h1>DorisMan</h1>
        <p>Doris 授权管理平台</p>
      </div>
      <el-form :model="form" @submit.prevent="doLogin">
        <el-form-item>
          <el-input v-model="form.username" placeholder="用户名" size="large" :prefix-icon="User" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            size="large"
            show-password
            :prefix-icon="Lock"
            @keyup.enter="doLogin"
          />
        </el-form-item>
        <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="doLogin">
          登 录
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import { useAuthStore, useClusterStore } from '../store'

const router = useRouter()
const auth = useAuthStore()
const clusterStore = useClusterStore()

const form = reactive({ username: '', password: '' })
const loading = ref(false)

async function doLogin() {
  if (!form.username || !form.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }
  loading.value = true
  try {
    await auth.login(form.username, form.password)
    // 登录成功后预载集群列表，失败不阻塞进入首页
    clusterStore.load().catch(() => {})
    ElMessage.success('登录成功')
    router.push('/')
  } catch {
    // 错误信息已由 axios 拦截器统一弹出（后端中文 message）
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1f2d3d 0%, #2b3a4d 100%);
}
.login-card {
  width: 380px;
}
.login-title {
  text-align: center;
  margin-bottom: 24px;
}
.login-logo {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  margin-bottom: 10px;
}
.login-title h1 {
  margin: 0;
  font-size: 28px;
  color: #303133;
}
.login-title p {
  margin: 6px 0 0;
  color: #909399;
  font-size: 14px;
}
</style>
