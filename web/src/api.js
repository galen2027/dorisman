import axios from 'axios'
import forge from 'node-forge'
import { ElMessage } from 'element-plus'
import router from './router'

// axios 实例：统一 baseURL，请求自动带 JWT，响应统一处理错误
const api = axios.create({
  baseURL: '/api',
  timeout: 60000
})

// 请求拦截器：从 localStorage 取 token，附加 Authorization 头
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('dorisman_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器：401 清理登录态跳登录页；其他错误弹出后端返回的中文 message
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const resp = error.response
    if (resp && resp.status === 401) {
      // 登录态失效：清理并跳登录页（避免在登录页自身重复跳转）
      localStorage.removeItem('dorisman_token')
      localStorage.removeItem('dorisman_user')
      if (router.currentRoute.value.path !== '/login') {
        ElMessage.error(resp.data?.error?.message || '登录已过期，请重新登录')
        router.push('/login')
      }
    } else {
      // 请求配置带 silent:true 时不弹全局错误提示（由调用方自行降级处理）
      if (!error.config?.silent) {
        const msg = resp?.data?.error?.message || error.message || '请求失败'
        ElMessage.error(msg)
      }
    }
    return Promise.reject(error)
  }
)

export default api

/**
 * 获取登录 RSA 公钥（GET /api/auth/pubkey → {kid, publicKeyPem}）
 * silent：失败不弹全局错误，由调用方降级为明文提交
 */
export async function fetchAuthPubkey() {
  return api.get('/auth/pubkey', { silent: true })
}

/**
 * 用 RSA-OAEP/SHA-256 加密 UTF-8 密码，返回 base64
 * 与后端契约一致：passwordEnc = base64(RSA-OAEP/SHA-256(UTF-8 password))
 */
export function encryptPassword(publicKeyPem, password) {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem)
  const encrypted = publicKey.encrypt(forge.util.encodeUtf8(password), 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() }
  })
  return forge.util.encode64(encrypted)
}
