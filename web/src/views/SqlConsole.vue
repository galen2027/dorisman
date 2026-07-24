<template>
  <div class="page-card">
    <!-- SQL 输入区 -->
    <el-input
      v-model="sql"
      type="textarea"
      :rows="6"
      class="mono"
      placeholder="输入单条 SQL 语句，如 SHOW GRANTS; （危险语句执行前会二次确认）"
    />
    <div class="exec-bar">
      <el-button type="primary" :loading="executing" :disabled="!sql.trim()" @click="execute">执行</el-button>
      <span class="muted">仅支持单条语句；所有语句都会写入审计日志</span>
    </div>

    <!-- 结果区 -->
    <div v-if="result" class="result-area">
      <!-- 错误：红色展示 -->
      <el-alert v-if="!result.ok" type="error" :closable="false" :title="result.error" show-icon />
      <!-- 查询类结果：动态列表格 -->
      <template v-else-if="result.kind === 'result'">
        <div class="result-meta">
          共 {{ result.rows.length }} 行，耗时 {{ result.durationMs }} ms
          <el-tag v-if="result.truncated" type="warning" size="small" style="margin-left: 8px">结果已截断（最多 1000 行）</el-tag>
        </div>
        <el-table :data="tableRows" border size="small" max-height="480">
          <el-table-column v-for="(col, i) in result.columns" :key="i" :label="col" :prop="String(i)" show-overflow-tooltip />
        </el-table>
      </template>
      <!-- 执行类结果 -->
      <el-alert v-else type="success" :closable="false" show-icon :title="`执行成功，影响行数：${result.affectedRows}，耗时 ${result.durationMs} ms`" />
    </div>

    <!-- 本地历史（localStorage 最近 50 条，点击回填） -->
    <div v-if="history.length" class="history-area">
      <div class="history-head">
        <span>历史记录</span>
        <el-button size="small" text type="danger" @click="clearHistory">清空</el-button>
      </div>
      <div
        v-for="(h, i) in history"
        :key="i"
        class="history-item mono"
        :title="h"
        @click="sql = h"
      >
        {{ h }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import api from '../api'
import { useClusterStore } from '../store'
import { isBuiltinTargetSql } from '../utils/builtin'

const clusterStore = useClusterStore()

const sql = ref('')
const executing = ref(false)
const result = ref(null)

// 查询结果 rows（数组）转成 el-table 需要的对象形式
const tableRows = computed(() => {
  if (!result.value?.rows) return []
  return result.value.rows.map((r) => Object.fromEntries(r.map((v, i) => [String(i), v])))
})

// 危险关键词：执行前二次确认（大小写不敏感）
const DANGER_PATTERN = /\b(DROP|REVOKE|TRUNCATE)\b|ALTER\s+SYSTEM|\bGRANT\b/i

const HISTORY_KEY = 'dorisman_sql_history'
const history = ref(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'))

function pushHistory(statement) {
  // 去重并插到最前，最多保留 50 条
  const list = [statement, ...history.value.filter((h) => h !== statement)].slice(0, 50)
  history.value = list
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
}

function clearHistory() {
  history.value = []
  localStorage.removeItem(HISTORY_KEY)
}

async function execute() {
  const statement = sql.value.trim()
  if (!statement) return
  // 内置账号前置预检：针对 root/admin 的写操作直接阻止（后端同思路硬拦截，前端先行提示）
  if (isBuiltinTargetSql(statement)) {
    ElMessageBox.alert(
      '该语句针对内置账号 root/admin，平台不允许执行；如确需操作请直连 Doris 后台',
      '内置账号保护',
      { type: 'warning', confirmButtonText: '知道了' }
    )
    return
  }
  // 危险语句二次确认
  if (DANGER_PATTERN.test(statement)) {
    try {
      await ElMessageBox.confirm(
        '检测到 DROP / REVOKE / TRUNCATE / ALTER SYSTEM / GRANT 等高危关键词，确认执行？',
        '高危操作确认',
        { type: 'warning', confirmButtonText: '仍要执行', confirmButtonClass: 'el-button--danger' }
      )
    } catch {
      return
    }
  }
  executing.value = true
  result.value = null
  try {
    // 后端约定：失败也是 HTTP 200，ok:false + error 放 body
    result.value = await api.post(`/c/${clusterStore.currentId}/execute`, { sql: statement })
    pushHistory(statement)
  } catch {
    // 网络/鉴权错误由拦截器提示
  } finally {
    executing.value = false
  }
}
</script>

<style scoped>
.exec-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
}
.muted {
  color: #909399;
  font-size: 13px;
}
.result-area {
  margin-top: 8px;
}
.result-meta {
  margin-bottom: 8px;
  color: #606266;
  font-size: 13px;
}
.history-area {
  margin-top: 20px;
  border-top: 1px solid #ebeef5;
  padding-top: 12px;
}
.history-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #606266;
  margin-bottom: 8px;
}
.history-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #606266;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-item:hover {
  background: #ecf5ff;
  color: #409eff;
}
</style>
