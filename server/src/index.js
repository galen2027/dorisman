// 入口：创建 express app，托管 web/dist，监听端口
// 依据 SPEC 2 / 8：
//   - 生产模式托管 ../web/dist 静态文件（不存在仅警告不报错）
//   - GET 非 /api 路径回退 index.html（若存在）
//   - 监听 0.0.0.0:${PORT:-9197}
//   - 首次启动打印初始管理员密码横幅
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const config = require('./config');

// ---------------------------------------------------------------------------
// 命令行参数：--help / --version 直接输出后退出（不启动服务）
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`DorisMan — Doris 授权管理平台 v${config.VERSION}${config.BUILD_TIME ? `（构建时间 ${config.BUILD_TIME}）` : ''}

用法：dorisman [选项]

选项：
  --port <端口>       Web 监听端口（默认 9197，等价环境变量 PORT）
  --host <地址>       监听地址（默认 0.0.0.0，等价环境变量 HOST）
  --data <目录>       数据目录（默认：可执行文件旁 ./data，等价环境变量 DORISMAN_DATA）
  --version, -v       显示版本号与构建时间后退出
  --help, -h          显示本帮助后退出

示例：
  ./dorisman                          # 默认配置启动
  ./dorisman --port 9090              # 指定端口
  ./dorisman --data /opt/dorisman/data

说明：
  - 前端页面已内嵌于程序中，自动加载，无需任何配置；
  - 首次启动自动生成 admin 随机密码，打印在控制台并写入数据目录下
    INIT_ADMIN_PASSWORD.txt，请登录后立即修改。`);
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(`DorisMan v${config.VERSION}${config.BUILD_TIME ? ` (build ${config.BUILD_TIME})` : ' (dev)'}`);
  process.exit(0);
}

const store = require('./store');
const doris = require('./doris');
const createRouter = require('./routes');

// ---------------------------------------------------------------------------
// 初始化存储（首启创建 admin / .secret）
// ---------------------------------------------------------------------------
const { dataDir, initialAdmin } = store.init();

// ---------------------------------------------------------------------------
// 创建 express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// API 路由
app.use('/api', createRouter());

// API 404：未匹配的 /api 路径统一 JSON 错误
app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.path}` } });
});

// ---------------------------------------------------------------------------
// 生产模式静态托管（web/dist 不存在仅警告）
// ---------------------------------------------------------------------------
const webDist = config.WEB_DIST;
const hasWebDist = fs.existsSync(webDist);
if (hasWebDist) {
  app.use(express.static(webDist));
} else {
  console.warn(`[警告] 前端构建目录不存在：${webDist}，仅提供 API 服务（开发模式属正常情况）`);
}

// SPA 回退：GET 且非 /api 路径 → index.html（若存在）
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  }
  const indexHtml = path.join(webDist, 'index.html');
  if (hasWebDist && fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  res
    .status(404)
    .json({ error: { code: 'NOT_FOUND', message: '前端资源未构建，请先执行 web 构建' } });
});

// 兜底错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] 未捕获异常：', err);
  if (res.headersSent) return;
  res.status(500).json({ error: { code: 'INTERNAL', message: `服务器内部错误：${err.message}` } });
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const server = app.listen(config.PORT, config.HOST, () => {
  const url = `http://localhost:${config.PORT}`;
  console.log('='.repeat(64));
  console.log(' DorisMan — Doris 授权管理平台（后端）');
  console.log(` 版本:       ${config.VERSION}${config.BUILD_TIME ? `（构建时间 ${config.BUILD_TIME}）` : '（开发模式）'}`);
  console.log(` 监听地址:   http://${config.HOST}:${config.PORT}（本机访问 ${url}）`);
  console.log(` 数据目录:   ${dataDir}`);
  if (hasWebDist) {
    if (process.pkg) {
      console.log(' 前端资源:   已内嵌于本程序，自动加载（无需任何配置与维护）');
    } else {
      console.log(` 前端目录:   ${webDist}（自动探测加载，无需配置）`);
    }
  } else {
    console.log(' 前端目录:   （未构建，仅 API）');
  }
  if (initialAdmin) {
    console.log('-'.repeat(64));
    console.log(' 【首次启动】已创建初始管理员账号：');
    console.log(`   用户名: ${initialAdmin.username}`);
    console.log(`   初始密码: ${initialAdmin.password}`);
    console.log(`   （密码同时写入 ${path.join(dataDir, 'INIT_ADMIN_PASSWORD.txt')}）`);
    console.log('   请登录后立即修改密码！');
  }
  console.log('='.repeat(64));
});

// 优雅退出：关闭 Doris 连接池
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭...`);
  server.close(() => {
    doris.closeAllPools().finally(() => process.exit(0));
  });
  // 兜底：3 秒内未关闭则强制退出
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
