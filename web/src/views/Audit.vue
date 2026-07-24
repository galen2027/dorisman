<template>
  <div class="page-card">
    <!-- 筛选：集群 / 账号 -->
    <div class="toolbar">
      <el-select v-model="filterCluster" placeholder="全部集群" clearable style="width: 240px" @change="load(1)">
        <el-option v-for="c in clusterStore.list" :key="c.id" :label="c.name" :value="String(c.id)" />
      </el-select>
      <el-input v-model="filterAccount" placeholder="按账号筛选" clearable style="width: 200px" @change="load(1)" />
      <el-button :icon="Refresh" @click="load(page)">刷新</el-button>
    </div>

    <!-- 审计表格：时间倒序（后端已倒序） -->
    <el-table v-loading="loading" :data="items" border size="small">
      <el-table-column label="时间" prop="time" width="170" />
      <el-table-column label="账号" prop="account" width="110" />
      <el-table-column label="集群" prop="clusterName" width="140" />
      <el-table-column label="动作" prop="action" width="130" />
      <el-table-column label="SQL" min-width="280">
        <template #default="{ row }">
          <span class="mono sql-cell" :title="row.sql">{{ row.sql }}</span>
        </template>
      </el-table-column>
      <el-table-column label="结果" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="row.ok ? 'success' : 'danger'" size="small">{{ row.ok ? '成功' : '失败' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="错误" min-width="160">
        <template #default="{ row }">
          <span class="error-text" :title="row.error">{{ row.error || '' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="IP" prop="ip" width="120" />
    </el-table>

    <el-pagination
      style="margin-top: 16px; justify-content: flex-end"
      background
      layout="total, prev, pager, next"
      :total="total"
      :page-size="size"
      :current-page="page"
      @current-change="load"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import api from '../api'
import { useClusterStore } from '../store'

const clusterStore = useClusterStore()

const loading = ref(false)
const items = ref([])
const total = ref(0)
const page = ref(1)
const size = 50
const filterCluster = ref('')
const filterAccount = ref('')

onMounted(() => load(1))

async function load(p) {
  page.value = p
  loading.value = true
  try {
    const data = await api.get('/audit', {
      params: {
        page: p,
        size,
        clusterId: filterCluster.value || undefined,
        account: filterAccount.value || undefined
      }
    })
    items.value = data.items || []
    total.value = data.total || 0
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.sql-cell {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.error-text {
  color: #f56c6c;
  font-size: 12px;
}
</style>
