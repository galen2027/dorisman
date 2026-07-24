import { defineStore } from 'pinia'
import api, { fetchAuthPubkey, encryptPassword } from './api'

// 登录态存储 key
const TOKEN_KEY = 'dorisman_token'
const USER_KEY = 'dorisman_user'

/**
 * 认证 store：token 持久化在 localStorage，user 保存 {username, role}
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: JSON.parse(localStorage.getItem(USER_KEY) || 'null')
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    isAdmin: (s) => s.user?.role === 'admin'
  },
  actions: {
    /** 登录：优先 RSA-OAEP/SHA-256 加密提交 passwordEnc+kid；公钥获取失败时降级明文提交 */
    async login(username, password) {
      let payload
      try {
        const { kid, publicKeyPem } = await fetchAuthPubkey()
        if (!kid || !publicKeyPem) throw new Error('pubkey 响应不完整')
        payload = { username, passwordEnc: encryptPassword(publicKeyPem, password), kid }
      } catch (e) {
        // 降级：公钥接口不可用或加密失败时按旧契约明文提交（后端兼容）
        console.warn('[DorisMan] 获取登录公钥失败，降级为明文提交密码：', e)
        payload = { username, password }
      }
      const data = await api.post('/auth/login', payload)
      this.token = data.token
      this.user = data.user
      localStorage.setItem(TOKEN_KEY, data.token)
      localStorage.setItem(USER_KEY, JSON.stringify(data.user))
    },
    /** 退出登录：清理本地状态 */
    logout() {
      this.token = ''
      this.user = null
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
    },
    /** 判断当前用户是否拥有指定角色 */
    hasRole(role) {
      return this.user?.role === role
    }
  }
})

/**
 * 集群 store：集群列表 + 当前选中集群
 * currentId 持久化，保证刷新页面后仍停留在原集群
 */
export const useClusterStore = defineStore('cluster', {
  state: () => ({
    list: [],
    currentId: localStorage.getItem('dorisman_cluster') || '',
    loaded: false
  }),
  getters: {
    current(s) {
      return s.list.find((c) => String(c.id) === String(s.currentId)) || null
    },
    hasCluster(s) {
      return s.list.length > 0
    }
  },
  actions: {
    /** 拉取集群列表；若当前选中已失效则回退到第一个 */
    async load() {
      this.list = await api.get('/clusters')
      this.loaded = true
      if (this.list.length === 0) {
        this.currentId = ''
        localStorage.removeItem('dorisman_cluster')
      } else if (!this.current) {
        this.select(this.list[0].id)
      }
    },
    /** 切换当前集群 */
    select(id) {
      this.currentId = String(id)
      localStorage.setItem('dorisman_cluster', this.currentId)
    }
  }
})
