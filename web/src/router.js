import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from './store'

// 路由表：除登录页外都在 Layout 下，按 meta.requiresAdmin 控制 admin 专属页面
const routes = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
  {
    path: '/',
    component: () => import('./views/Layout.vue'),
    redirect: '/users',
    children: [
      { path: 'users', name: 'users', component: () => import('./views/Users.vue'), meta: { title: '用户管理' } },
      { path: 'users/create', name: 'user-create', component: () => import('./views/UserEdit.vue'), meta: { title: '新建用户', requiresAdmin: true } },
      // host 中可能含 %，路由参数统一 encodeURIComponent
      { path: 'users/:user/:host/edit', name: 'user-edit', component: () => import('./views/UserEdit.vue'), meta: { title: '编辑授权', requiresAdmin: true } },
      { path: 'roles', name: 'roles', component: () => import('./views/Roles.vue'), meta: { title: '角色管理' } },
      { path: 'sql', name: 'sql-console', component: () => import('./views/SqlConsole.vue'), meta: { title: 'SQL控制台', requiresAdmin: true } },
      { path: 'audit', name: 'audit', component: () => import('./views/Audit.vue'), meta: { title: '审计日志', requiresAdmin: true } },
      { path: 'clusters', name: 'clusters', component: () => import('./views/Clusters.vue'), meta: { title: '集群管理' } },
      // 菜单已归入「系统管理」分组（Layout.vue），路径保持不变避免破坏书签
      { path: 'accounts', name: 'accounts', component: () => import('./views/Accounts.vue'), meta: { title: '系统用户', requiresAdmin: true } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// 全局守卫：未登录跳 /login；requiresAdmin 页面对非 admin 用户拦截并提示
router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.path !== '/login' && !auth.isLoggedIn) {
    return { path: '/login' }
  }
  if (to.path === '/login' && auth.isLoggedIn) {
    return { path: '/' }
  }
  if (to.meta.requiresAdmin && !auth.isAdmin) {
    ElMessage.warning('该功能仅管理员可用')
    return { path: '/' }
  }
  return true
})

export default router
