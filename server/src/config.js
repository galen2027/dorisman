// 全局配置：端口、数据目录等
// 说明：全部配置均可通过环境变量覆盖，默认值面向开发模式。
const path = require('path');
const fs = require('fs');

// 数据目录：--data=xxx / --data xxx 命令行参数 > 环境变量 DORISMAN_DATA > 默认可执行文件旁 data/
// 开发模式下 __dirname 为 server/src，向上两级即 server/，故为 server/data
function argValue(name) {
  const prefix = `--${name}=`;
  const direct = process.argv.find((a) => a.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}
const cliDataDir = argValue('data');
const DATA_DIR = cliDataDir
  ? path.resolve(cliDataDir)
  : process.env.DORISMAN_DATA
    ? path.resolve(process.env.DORISMAN_DATA)
    : path.join(__dirname, '..', 'data');

// 监听端口：PORT 环境变量 或 --port=xxxx / --port xxxx 命令行参数，默认 9197
const PORT = parseInt(process.env.PORT || argValue('port') || '9197', 10);

// 监听地址：生产要求监听 0.0.0.0（HOST 环境变量或 --host 可覆盖）
const HOST = process.env.HOST || argValue('host') || '0.0.0.0';

// 前端静态文件目录（生产/单端口模式）
// 三种布局自动探测：
//   ① esbuild  bundle 后（dist/server.cjs）：__dirname=<root>/dist   → ../web/dist
//   ② pkg snapshot 内（assets 内嵌）：      __dirname=/snapshot/<root>/dist → ../web/dist
//   ③ 源码开发（server/src/index.js）：     __dirname=<root>/server/src → ../../web/dist
const WEB_DIST_CANDIDATES = [
  path.join(__dirname, '..', 'web', 'dist'),
  path.join(__dirname, '..', '..', 'web', 'dist'),
];
const WEB_DIST = WEB_DIST_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'index.html'))) || WEB_DIST_CANDIDATES[0];

// JWT 有效期：12 小时
const JWT_EXPIRES_IN = '12h';

// 登录限流：同一 IP 1 分钟内失败 5 次锁定 5 分钟
const LOGIN_LIMIT = {
  windowMs: 60 * 1000,   // 统计窗口 1 分钟
  maxFails: 5,           // 窗口内最大失败次数
  lockMs: 5 * 60 * 1000, // 锁定时长 5 分钟
};

// Doris 连接池默认连接超时（毫秒）
const DORIS_CONNECT_TIMEOUT = 5000;

// SQL 控制台结果行数上限
const CONSOLE_ROW_LIMIT = 1000;

// 后端版本号，用于 /api/health 与 --version
const VERSION = '0.1.2';

// 构建时间：由 scripts/bundle-server.js 在打包时经 esbuild define 注入；
// 源码开发模式下为 undefined，回退为空串（展示为 dev）
/* global __DORISMAN_BUILD_TIME__ */
const BUILD_TIME =
  typeof __DORISMAN_BUILD_TIME__ !== 'undefined'
    ? __DORISMAN_BUILD_TIME__
    : process.env.DORISMAN_BUILD_TIME || '';

module.exports = {
  DATA_DIR,
  PORT,
  HOST,
  WEB_DIST,
  JWT_EXPIRES_IN,
  LOGIN_LIMIT,
  DORIS_CONNECT_TIMEOUT,
  CONSOLE_ROW_LIMIT,
  VERSION,
  BUILD_TIME,
  // 供 --help / 单测使用的命令行参数解析
  argValue,
};
