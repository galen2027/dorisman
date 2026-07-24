// scripts/package.js
// DorisMan 发布打包（SPEC §8）：
//   1. 确认 dist/server.cjs（缺失则自动先跑 bundle-server.js）
//   2. 调用 pkg API 生成 node18-linux-x64 / node18-win-x64 二进制 → release/
//   3. 生成 bin/start.sh、bin/stop.sh、conf/dorisman.conf 与 README-部署.md（放 release/ 并打入 tar.gz）
//   4. 打 linux 发布包 release/dorisman-web-v<版本>-linux-x64.tar.gz
//
// 发布包目录布局（解压根目录即工作目录，./bin/start.sh 即可启动）：
//   bin/     可执行文件（dorisman）与启动/停止脚本
//   conf/    可选配置文件 dorisman.conf（start.sh 存在则自动加载）
//   data/    运行数据（首次启动自动创建，不打入包内）
//   logs/    运行日志与 pid（首次启动自动创建，不打入包内）
//   README-部署.md  在包根目录
//
// 降级方案（pkg 需要联网从 github.com/vercel/pkg-fetch 下载 node18 base binary）：
//   网络不可达或 pkg 失败时，自动改为「绿色包」：tar.gz 内含
//   dist/server.cjs + web/dist + package.json + bin/start.sh（系统 node18+ 运行）+ README，
//   dist/ 与 web/ 留在根目录（dist/server.cjs 的 __dirname/../web/dist 相对关系不能破）。
//
// 备注（SPEC §8 备选方案）：若 pkg 静态目录直读 snapshot 有问题的后端兜底
//   「启动时复制 snapshot 内 web/dist 到 data/webroot」需改 server/src 实现，
//   本次打包冒烟已验证 snapshot 直读可行，无需启用该兜底。
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const ROOT_PKG = path.join(ROOT, 'package.json');

// 版本号唯一来源：根 package.json。打包默认在现版本上 patch+1：
//   node scripts/package.js                # 0.1.0 -> 0.1.1
//   node scripts/package.js --no-bump      # 保持现版本（release.sh 已递增过，走这个）
//   node scripts/package.js --version=1.2.0  # 显式指定
let VERSION = readPkgVersion();
const tarName = () => `dorisman-web-v${VERSION}-linux-x64.tar.gz`;

function readPkgVersion() {
  return JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8')).version;
}

/** 按命令行参数递增/指定版本号，并写回 package.json 与 server/src/config.js */
function applyVersionBump() {
  const args = process.argv.slice(2);
  const explicitArg = args.find((a) => a.startsWith('--version='));
  const noBump = args.includes('--no-bump');
  const cur = readPkgVersion();
  let next = cur;
  if (explicitArg !== undefined) {
    const v = explicitArg.slice('--version='.length);
    if (!/^\d+\.\d+\.\d+$/.test(v)) {
      throw new Error(`--version 格式非法：${v}（应为 x.y.z，如 1.2.0）`);
    }
    next = v;
  } else if (!noBump) {
    const [a, b, c] = cur.split('.').map((n) => parseInt(n, 10));
    next = `${a}.${b}.${c + 1}`;
  }
  if (next === cur) {
    log(`版本号保持 v${cur}`);
    VERSION = cur;
    return;
  }
  const pkgJson = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
  pkgJson.version = next;
  fs.writeFileSync(ROOT_PKG, JSON.stringify(pkgJson, null, 2) + '\n');
  const cfgPath = path.join(ROOT, 'server', 'src', 'config.js');
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  if (!/const VERSION = '[^']*';/.test(cfg)) throw new Error('server/src/config.js 中未找到 VERSION 常量');
  fs.writeFileSync(cfgPath, cfg.replace(/const VERSION = '[^']*';/, `const VERSION = '${next}';`));
  VERSION = next;
  log(`版本号：v${cur} → v${next}（可用 --no-bump 保持不变，--version=x.y.z 显式指定）`);
}

const PKG_TARGETS = [
  { target: 'node18-linux-x64', out: path.join(RELEASE, 'dorisman-linux-x64') },
  { target: 'node18-win-x64', out: path.join(RELEASE, 'dorisman-win-x64.exe') },
];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[package] ${msg}`);
}

function copyFile(src, dst, mode) {
  fs.copyFileSync(src, dst);
  if (mode !== undefined) fs.chmodSync(dst, mode);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

/** 探测 github.com 可达性（pkg 需下载 base binary） */
function probeGithub(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.get(
      'https://github.com/vercel/pkg-fetch/releases',
      { timeout: timeoutMs, headers: { 'user-agent': 'dorisman-packager' } },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** 检查 pkg base binary 是否已在本地缓存（命中缓存时 pkg 完全离线可用） */
function hasPkgCache() {
  const os = require('os');
  const cacheRoot = process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache');
  try {
    const tags = fs.readdirSync(cacheRoot);
    for (const { target } of PKG_TARGETS) {
      // target 形如 node18-linux-x64 → 缓存文件 fetched-v18.5.0-linux-x64（次版本号不限）
      const m = target.match(/^node(\d+)-([a-z]+)-(x64|arm64|x86)$/);
      if (!m) return false;
      const [, major, platform, arch] = m;
      const re = new RegExp(`^fetched-v${major}\\.\\d+\\.\\d+-${platform}-${arch}$`);
      const hit = tags.some(
        (tag) =>
          fs.statSync(path.join(cacheRoot, tag)).isDirectory() &&
          fs.readdirSync(path.join(cacheRoot, tag)).some((f) => re.test(f))
      );
      if (!hit) return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

/** 用系统 tar 打 gzip 包（Git Bash / Linux / Win10+ 均自带 tar） */
function makeTarGz(stagingDir, files, outFile) {
  const tmpTar = path.join(stagingDir, tarName());
  const r = spawnSync('tar', ['-czf', tarName(), ...files], {
    cwd: stagingDir,
    stdio: 'inherit',
  });
  if (r.error || r.status !== 0) {
    throw new Error(`tar 打包失败：${r.error ? r.error.message : `exit ${r.status}`}`);
  }
  fs.renameSync(tmpTar, outFile);
}

// ---------------------------------------------------------------------------
// 发布文件内容
// ---------------------------------------------------------------------------

const START_SH_BINARY = `#!/bin/sh
# DorisMan 启动脚本（默认 nohup 后台运行）
# 用法：./bin/start.sh          后台启动（默认）
#       ./bin/start.sh -f       前台启动（调试用，Ctrl+C 停止）
# 可选配置：conf/dorisman.conf（存在则自动加载，shell 语法，可设置 PORT / DORISMAN_DATA 等）
# 无论从哪里调用本脚本，都以「解压根目录」为工作目录
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
cd "$ROOT_DIR"
mkdir -p data logs

[ -f conf/dorisman.conf ] && . ./conf/dorisman.conf
export PORT="\${PORT:-9197}"

if [ "\$1" = "-f" ] || [ "\$1" = "--foreground" ]; then
  shift
  exec ./bin/dorisman "\$@"
fi

if [ -f logs/dorisman.pid ] && kill -0 "$(cat logs/dorisman.pid)" 2>/dev/null; then
  echo "DorisMan 已在运行（PID $(cat logs/dorisman.pid)），端口 $PORT"
  exit 0
fi

nohup ./bin/dorisman "\$@" >> logs/dorisman.log 2>&1 &
echo $! > logs/dorisman.pid
echo "DorisMan 已后台启动（PID $(cat logs/dorisman.pid)），端口 $PORT"
echo "访问地址：http://<服务器IP>:$PORT"
echo "查看日志：tail -f logs/dorisman.log ；停止服务：./bin/stop.sh"
`;

const START_SH_GREEN = `#!/bin/sh
# DorisMan 绿色包启动脚本（需要系统已安装 Node.js >= 18）
# 用法：./bin/start.sh          后台启动（默认）
#       ./bin/start.sh -f       前台启动（调试用，Ctrl+C 停止）
# 可选配置：conf/dorisman.conf（存在则自动加载，shell 语法，可设置 PORT / DORISMAN_DATA 等）
# 无论从哪里调用本脚本，都以「解压根目录」为工作目录
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
cd "$ROOT_DIR"
mkdir -p data logs

[ -f conf/dorisman.conf ] && . ./conf/dorisman.conf
export PORT="\${PORT:-9197}"

if [ "\$1" = "-f" ] || [ "\$1" = "--foreground" ]; then
  shift
  exec node dist/server.cjs "\$@"
fi

if [ -f logs/dorisman.pid ] && kill -0 "$(cat logs/dorisman.pid)" 2>/dev/null; then
  echo "DorisMan 已在运行（PID $(cat logs/dorisman.pid)），端口 $PORT"
  exit 0
fi

nohup node dist/server.cjs "\$@" >> logs/dorisman.log 2>&1 &
echo $! > logs/dorisman.pid
echo "DorisMan 已后台启动（PID $(cat logs/dorisman.pid)），端口 $PORT"
echo "访问地址：http://<服务器IP>:$PORT"
echo "查看日志：tail -f logs/dorisman.log ；停止服务：./bin/stop.sh"
`;

const STOP_SH = `#!/bin/sh
# DorisMan 停止脚本（无论从哪里调用，都以「解压根目录」为工作目录）
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
cd "$ROOT_DIR"
if [ -f logs/dorisman.pid ]; then
  PID="$(cat logs/dorisman.pid)"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "已停止 DorisMan（PID $PID）"
  else
    echo "进程 $PID 已不存在，清理 pid 文件"
  fi
  rm -f logs/dorisman.pid
else
  echo "未找到 logs/dorisman.pid，尝试按进程名停止"
  pkill -f 'dorisman' 2>/dev/null || echo "未发现运行中的 DorisMan"
fi
`;

// conf/dorisman.conf 示例模板：全部注释，start.sh 存在则自动 source
const CONF_DORISMAN_CONF = `# DorisMan 可选配置文件
# 存在时由 bin/start.sh 自动加载（shell 语法，每行一条 KEY=VALUE）。
# 优先级：命令行参数 > 本文件 / 环境变量 > 默认值。

# Web 监听端口（默认 9197）
# PORT=9197

# Web 监听地址（默认 0.0.0.0）
# HOST=0.0.0.0

# 数据目录（默认 解压根目录/data）
# DORISMAN_DATA=/opt/dorisman/data
`;

const greenPackageJson = () => ({
  name: 'dorisman-web',
  version: VERSION,
  private: true,
  description:
    'DorisMan — Doris 授权管理平台（绿色包，全部 npm 依赖已内嵌进 dist/server.cjs，仅需系统 Node.js >= 18）',
  scripts: { start: 'node dist/server.cjs' },
  engines: { node: '>=18' },
});

/**
 * 生成 README-部署.md 内容
 * @param {'binary'|'green'} variant 二进制版 / 绿色 node 版
 */
function readmeContent(variant) {
  const isGreen = variant === 'green';
  return `# DorisMan 部署说明（linux-x64）

> DorisMan — Doris 授权管理平台 v${VERSION}
> 目标环境：统信 UOS V20 / Debian 11.9（linux-x64）
> 包类型：${isGreen ? '绿色包（需系统 Node.js >= 18 运行）' : '单一可执行二进制（解压即用，无需安装 Node.js）'}

---

## 0. 目录布局

解压根目录即工作目录，\`./bin/start.sh\` 即可启动：

\`\`\`
dorisman/
├── bin/          可执行文件与启动/停止脚本（dorisman、start.sh、stop.sh）
├── conf/         可选配置文件 dorisman.conf（start.sh 存在则自动加载）
├── data/         运行数据（首次启动自动创建，不打入包内）
├── logs/         运行日志与 pid（首次启动自动创建，不打入包内）
└── README-部署.md
\`\`\`
${isGreen ? '绿色包额外包含根目录下的 `dist/`（后端单文件）与 `web/`（前端静态资源）。\n' : ''}
## 1. 解压

将 \`${tarName()}\` 上传到服务器后：

\`\`\`sh
mkdir -p /opt/dorisman
tar -xzf ${tarName()} -C /opt/dorisman
cd /opt/dorisman
\`\`\`

${
  isGreen
    ? `赋予脚本可执行权限，并确认系统已安装 Node.js >= 18（\`node --version\` 可验证）：

\`\`\`sh
chmod +x bin/start.sh bin/stop.sh
\`\`\`

无需执行 npm install —— 全部依赖已内嵌在 dist/server.cjs 中。`
    : `赋予可执行权限：

\`\`\`sh
chmod +x bin/dorisman bin/start.sh bin/stop.sh
\`\`\``
}

## 2. 启动与停止

\`\`\`sh
# 后台启动（默认，nohup 运行，日志写入 logs/dorisman.log）
./bin/start.sh

# 前台启动（调试用，Ctrl+C 停止）
./bin/start.sh -f

# 停止
./bin/stop.sh
\`\`\`

指定端口（默认 9197）：

\`\`\`sh
PORT=9090 ./bin/start.sh        # 环境变量方式
./bin/start.sh --port 9090      # 命令行参数方式（透传给 dorisman）
\`\`\`

## 2.1 命令行参数

\`\`\`sh
./bin/dorisman --help            # 查看全部参数说明
./bin/dorisman --version         # 查看版本号与构建时间
./bin/dorisman --port 9090       # 指定 Web 端口（等价 PORT 环境变量）
./bin/dorisman --host 127.0.0.1  # 指定监听地址（等价 HOST）
./bin/dorisman --data /opt/data  # 指定数据目录（等价 DORISMAN_DATA）
\`\`\`

通过 start.sh 透传参数：\`./bin/start.sh --port 9090 --data /opt/data\`（前台模式 \`./bin/start.sh -f --port 9090\`）。

## 2.2 配置文件（可选）

\`conf/dorisman.conf\` 为可选配置文件（shell 语法），存在时由 \`bin/start.sh\` 自动加载，
可设置 \`PORT\`、\`HOST\`、\`DORISMAN_DATA\` 等。包内为全注释示例，按需取消注释即可。
优先级：命令行参数 > 配置文件 / 环境变量 > 默认值。

## 3. 访问地址

浏览器打开：\`http://<服务器IP>:9197\`

## 4. 首次启动：初始管理员密码

首次启动会自动创建管理员账号 \`admin\`，密码为随机 16 位强密码，查看位置有两处：

1. 控制台启动横幅（【首次启动】段落，后台运行时见 \`logs/dorisman.log\`）；
2. 文件 \`data/INIT_ADMIN_PASSWORD.txt\`（权限 0600，仅属主可读）。

**请登录后立即在页面右上角「修改密码」中更换，并妥善删除该文件。**

## 5. data 与 logs 目录说明

数据目录默认在解压根目录的 \`./data\`，可用环境变量 \`DORISMAN_DATA\`（或 conf/dorisman.conf）覆盖。
首次启动自动创建，内容如下：

| 文件 | 内容 |
|---|---|
| \`accounts.json\` | 平台账号（用户名 / bcrypt 密码哈希 / 角色） |
| \`clusters.json\` | Doris 集群连接信息（密码 AES-256-GCM 加密存储） |
| \`.secret\` | 32 字节随机密钥（JWT 签名 + 集群密码加密共用，0600） |
| \`audit.jsonl\` | 审计日志，每行一个 JSON |
| \`INIT_ADMIN_PASSWORD.txt\` | 仅首次初始化写入的初始管理员密码（0600） |

**备份只需打包整个 data 目录。** 注意 \`.secret\` 丢失会导致已保存的集群密码无法解密（需重新录入集群）。

运行日志写入 \`logs/dorisman.log\`，进程号写入 \`logs/dorisman.pid\`（停止脚本据此停止服务）。

## 6. 防火墙

本平台为单端口服务，**只需放行 Web 端口（默认 9197）**。
Doris 的 9030 端口是本平台作为客户端**主动出站**连接，无需在平台侧放行入站。

## 7. Doris 侧账号要求

在「集群管理」中填写的 Doris 账号用于执行用户/角色/授权管理：

- 需要具备 **admin 角色**，或至少具备 **GRANT_PRIV**（授权/撤权/用户管理）权限；
- 通常使用 \`root\` 或 \`admin\` 账号即可；
- 连接地址为 FE 的 **9030**（MySQL 协议）端口。

## 8. 多集群配置

登录后进入左侧菜单「系统管理 → 集群管理」（仅 admin 可写）：

1. 点击「新建集群」，填写名称、FE 地址、端口（默认 9030）、账号密码；
2. 保存前平台会**实测连接**，失败会提示具体原因；
3. 保存多个集群后，通过顶栏的集群切换器在各集群间切换（同一时间只对一个集群操作）。

## 9. 常见问题

**Q：启动失败，提示端口被占用？**
A：报错形如 \`Error: listen EADDRINUSE: address already in use 0.0.0.0:9197\`。
更换端口：\`PORT=9090 ./bin/start.sh\`，或先释放占用进程。

**Q：添加集群或操作时提示连不上 Doris（9030 不通）？**
A：报错形如 \`无法连接到 Doris（host:9030）：connect ETIMEDOUT ...\` 或 \`ECONNREFUSED\`（接口错误码 \`CONNECT_FAILED\`）。
排查：平台服务器到 FE 9030 的网络连通性（\`telnet <fe-host> 9030\`）、防火墙、账号密码是否正确。

**Q：登录一直提示密码错误？**
A：确认是否已修改过初始密码；平台账号与 Doris 账号是两套体系，互不相通。
连续失败 5 次会锁定 5 分钟（按来源 IP 计）。

**Q：忘记 admin 密码怎么办？**
A：停止服务，备份后删除 \`data/accounts.json\`，重新启动即会再次走首次初始化流程
（重新生成 admin 随机密码并写入 \`data/INIT_ADMIN_PASSWORD.txt\`；集群配置不受影响）。
`;
}

// ---------------------------------------------------------------------------
// pkg 打包
// ---------------------------------------------------------------------------

async function runPkg() {
  const pkg = require('pkg');
  const entry = path.join(ROOT, 'dist', 'server.cjs');
  // 注意：入口是 .cjs 文件时 pkg 不会自动读取就近 package.json 里的 "pkg" 配置，
  // 必须显式 --config 指定（其 pkg.assets 才会生效，基准目录 = config 所在目录，
  // web/dist 在 snapshot 内落在 C:\snapshot\web\dist，与 config.js 的 WEB_DIST 推导一致）
  const config = path.join(ROOT, 'package.json');

  for (const { target, out } of PKG_TARGETS) {
    log(`pkg 目标 ${target} → ${path.relative(ROOT, out)}`);
    let lastErr = null;
    // 先试默认（V8 bytecode），失败再以 --no-bytecode 重试一次
    for (const extra of [[], ['--no-bytecode']]) {
      try {
        await pkg.exec([entry, '--target', target, '--output', out, '--config', config, ...extra]);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        log(`  ${target}${extra.length ? '（--no-bytecode）' : ''} 失败：${err.message}`);
      }
    }
    if (lastErr) throw new Error(`pkg 目标 ${target} 失败：${lastErr.message}`);
    if (!fs.existsSync(out)) throw new Error(`pkg 目标 ${target} 未产出文件`);
    log(`  完成（${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB）`);
  }
}

// ---------------------------------------------------------------------------
// tar 发布包
// ---------------------------------------------------------------------------

function buildTar(variant) {
  const staging = path.join(RELEASE, '.staging-linux');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const isGreen = variant === 'green';
  // bin/：脚本（两版都有）；二进制版额外放可执行文件
  fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'bin', 'start.sh'), isGreen ? START_SH_GREEN : START_SH_BINARY);
  fs.writeFileSync(path.join(staging, 'bin', 'stop.sh'), STOP_SH);
  if (isGreen) {
    // 绿色包：dist/ 与 web/ 留在根目录（dist/server.cjs 的 __dirname/../web/dist 相对关系不能破）
    copyDir(path.join(ROOT, 'dist'), path.join(staging, 'dist'));
    copyDir(path.join(ROOT, 'web', 'dist'), path.join(staging, 'web', 'dist'));
    fs.writeFileSync(
      path.join(staging, 'package.json'),
      JSON.stringify(greenPackageJson(), null, 2) + '\n'
    );
  } else {
    copyFile(path.join(RELEASE, 'dorisman-linux-x64'), path.join(staging, 'bin', 'dorisman'));
  }

  // conf/：可选配置示例；data/ 与 logs/ 不打入包，由 start.sh 首启创建
  fs.mkdirSync(path.join(staging, 'conf'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'conf', 'dorisman.conf'), CONF_DORISMAN_CONF);
  fs.writeFileSync(path.join(staging, 'README-部署.md'), readmeContent(variant));

  const files = isGreen
    ? ['dist', 'web', 'package.json', 'bin', 'conf', 'README-部署.md']
    : ['bin', 'conf', 'README-部署.md'];

  const outTar = path.join(RELEASE, tarName());
  makeTarGz(staging, files, outTar);
  fs.rmSync(staging, { recursive: true, force: true });
  log(`发布包：release/${tarName()}（${(fs.statSync(outTar).size / 1024 / 1024).toFixed(1)} MB，${variant} 版）`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // 版本号：默认 patch+1（--no-bump 保持，--version=x.y.z 指定）
  applyVersionBump();

  // 每次打包都重新 bundle：保证构建时间与版本号注入为最新
  log('执行 bundle-server.js（注入构建时间）');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle-server.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('bundle-server.js 执行失败');
  if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
    throw new Error('web/dist 不存在，请先执行 npm --prefix web run build');
  }
  fs.mkdirSync(RELEASE, { recursive: true });

  // pkg 打包（缓存缺失且网络不可达、或 pkg 本身失败时降级绿色包）
  let pkgOk = false;
  let degradeReason = '';
  const cached = hasPkgCache();
  if (cached) {
    log('pkg base binary 已命中本地缓存，离线打包');
  }
  const reachable = cached ? true : await probeGithub();
  if (!reachable) {
    degradeReason = 'pkg base binary 本地缓存缺失，且无法访问 github.com 下载';
  } else {
    try {
      await runPkg();
      pkgOk = true;
    } catch (err) {
      degradeReason = err.message;
    }
  }

  if (pkgOk) {
    buildTar('binary');
    log('pkg 二进制打包成功（linux-x64 + win-x64）');
  } else {
    log(`!! pkg 不可用，降级为绿色包方案。原因：${degradeReason}`);
    buildTar('green');
  }

  // release/ 下按新布局放一份 bin/ 与 conf/ 便于查看（与 tar 内一致），并清理旧布局残留
  fs.rmSync(path.join(RELEASE, 'start.sh'), { force: true });
  fs.rmSync(path.join(RELEASE, 'stop.sh'), { force: true });
  fs.mkdirSync(path.join(RELEASE, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(RELEASE, 'conf'), { recursive: true });
  fs.writeFileSync(path.join(RELEASE, 'bin', 'start.sh'), pkgOk ? START_SH_BINARY : START_SH_GREEN);
  fs.writeFileSync(path.join(RELEASE, 'bin', 'stop.sh'), STOP_SH);
  fs.writeFileSync(path.join(RELEASE, 'conf', 'dorisman.conf'), CONF_DORISMAN_CONF);
  fs.writeFileSync(path.join(RELEASE, 'README-部署.md'), readmeContent(pkgOk ? 'binary' : 'green'));

  log('全部完成。产物见 release/ 目录。');
  return { pkgOk, degradeReason };
}

main().catch((err) => {
  console.error('[package] 失败：', err);
  process.exit(1);
});
