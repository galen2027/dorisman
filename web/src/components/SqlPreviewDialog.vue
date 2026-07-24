<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="720px"
    :close-on-click-modal="false"
    :close-on-press-escape="status !== 'executing'"
    :show-close="status !== 'executing'"
    @update:model-value="onUpdateVisible"
    @open="onOpen"
  >
    <!-- 额外说明插槽（如 edit 模式展示"当前授权"） -->
    <slot />

    <!-- SQL 预览区：编号 + 等宽字体 -->
    <div class="sql-list">
      <div v-for="(sql, i) in sqlList" :key="i" class="sql-item">
        <span class="sql-no">{{ i + 1 }}</span>
        <pre class="sql-text mono">{{ sql }}</pre>
        <!-- 执行后逐条显示结果 -->
        <span v-if="status === 'done' && results[i]" class="sql-result">
          <el-icon v-if="results[i].ok" color="#67c23a"><CircleCheckFilled /></el-icon>
          <el-tooltip v-else :content="results[i].error || '执行失败'" placement="top">
            <el-icon color="#f56c6c"><CircleCloseFilled /></el-icon>
          </el-tooltip>
        </span>
      </div>
      <el-empty v-if="sqlList.length === 0" description="无变更（生成的 SQL 为空）" :image-size="60" />
    </div>

    <!-- 执行失败明细：停留在对话框内供用户查看 -->
    <el-alert
      v-if="status === 'done' && failedCount > 0"
      type="error"
      :closable="false"
      style="margin-top: 12px"
      :title="`共 ${failedCount} 条执行失败，请检查以下错误信息`"
    >
      <ul class="error-list">
        <li v-for="(r, i) in results" v-show="!r.ok" :key="i">
          第 {{ i + 1 }} 条：{{ r.error }}
        </li>
      </ul>
    </el-alert>
    <el-alert
      v-else-if="status === 'done' && results.length > 0"
      type="success"
      :closable="false"
      style="margin-top: 12px"
      title="全部执行成功"
    />

    <template #footer>
      <el-button @click="copyAll" :disabled="sqlList.length === 0">复制全部 SQL</el-button>
      <el-button v-if="status !== 'executing'" @click="close">{{ status === 'done' ? '关闭' : '取消' }}</el-button>
      <el-button
        v-if="status !== 'done'"
        type="primary"
        :loading="status === 'executing'"
        :disabled="sqlList.length === 0"
        @click="doExecute"
      >
        {{ status === 'executing' ? '执行中…' : '确认执行' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { CircleCheckFilled, CircleCloseFilled } from '@element-plus/icons-vue'

/**
 * SQL 预览对话框（所有 Doris 写操作的统一出口）
 * - modelValue: 显示/隐藏
 * - sqlList: 待执行的 SQL 数组（来自 preview 接口）
 * - executor: 执行函数，返回 Promise<[{sql, ok, error}]>，由父组件调用真正的执行接口
 * - 成功全部执行完 emit('success')，失败时停留展示错误
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: 'SQL 预览与确认' },
  sqlList: { type: Array, default: () => [] },
  executor: { type: Function, required: true }
})
const emit = defineEmits(['update:modelValue', 'success'])

// status: preview（预览）/ executing（执行中）/ done（执行结束）
const status = ref('preview')
const results = ref([])

const failedCount = computed(() => results.value.filter((r) => !r.ok).length)

// 每次打开重置状态
function onOpen() {
  status.value = 'preview'
  results.value = []
}

function onUpdateVisible(v) {
  emit('update:modelValue', v)
}

function close() {
  emit('update:modelValue', false)
}

/** 复制全部 SQL 到剪贴板 */
async function copyAll() {
  try {
    await navigator.clipboard.writeText(props.sqlList.join('\n'))
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败，请手动选择复制')
  }
}

/** 确认执行：调用父组件传入的 executor，逐条展示结果 */
async function doExecute() {
  status.value = 'executing'
  try {
    const res = await props.executor()
    results.value = res || []
    status.value = 'done'
    if (failedCount.value === 0 && results.value.length > 0) {
      emit('success')
    }
  } catch (e) {
    // 请求本身失败（网络错误等），回到预览态让用户重试
    status.value = 'preview'
  }
}
</script>

<style scoped>
.sql-list {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid #ebeef5;
  border-radius: 4px;
}
.sql-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #f2f6fc;
}
.sql-item:last-child {
  border-bottom: none;
}
.sql-no {
  flex: none;
  width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  background: #ecf5ff;
  color: #409eff;
  border-radius: 50%;
  font-size: 12px;
}
.sql-text {
  flex: 1;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 13px;
  line-height: 22px;
}
.sql-result {
  flex: none;
  font-size: 18px;
  line-height: 22px;
}
.error-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
