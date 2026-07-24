// scripts/bundle-server.js
// 用 esbuild 把 server/src/index.js 打成单文件 dist/server.cjs（SPEC §8）
//
// 路径设计（关键，勿随意改动）：
//   - bundle 输出在 dist/，与 server/src 一样都是「仓库根下一层」，因此 config.js 里的
//     path.join(__dirname, '..', 'web', 'dist') / path.join(__dirname, '..', 'data')
//     相对关系在 bundle 后保持不变，__dirname 无需改写。
//   - pkg 打包后 __dirname 指向「只读 snapshot」内的 dist/，web/dist 经 pkg assets
//     内嵌在 snapshot 相同相对位置（/snapshot/dorismanweb/web/dist），静态托管照常工作；
//     但 data 目录必须可写，不能落在 snapshot —— 故用下方 banner 在 pkg 运行时预设
//     DORISMAN_DATA（config.js 优先读该环境变量）指向可执行文件所在目录（bin/）
//     上一级的 data/（即解压根目录/data）。
//     用户显式设置 DORISMAN_DATA 时不覆盖。
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

// 注入 bundle 顶部的引导代码（先于所有模块代码执行）。
// process.pkg 仅存在于 pkg 打包后的运行时。
const BANNER = [
  '// ── DorisMan 打包引导（由 scripts/bundle-server.js 注入，非业务代码） ──',
  'if (process.pkg && !process.env.DORISMAN_DATA) {',
  '  process.env.DORISMAN_DATA = require("path").join(require("path").dirname(process.execPath), "..", "data");',
  '}',
  '',
].join('\n');

async function main() {
  const outdir = path.join(ROOT, 'dist');
  fs.mkdirSync(outdir, { recursive: true });

  // 构建时间注入（config.js 的 BUILD_TIME 读取该全局常量）；
  // 可用环境变量 DORISMAN_BUILD_TIME 覆盖（CI 固定时间戳等场景）
  const buildTime = process.env.DORISMAN_BUILD_TIME || new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'server', 'src', 'index.js')],
    outfile: path.join(outdir, 'server.cjs'),
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    bundle: true,
    minify: false, // 不压缩，便于线上排障对照源码
    sourcemap: false,
    logLevel: 'info',
    banner: { js: BANNER },
    define: { __DORISMAN_BUILD_TIME__: JSON.stringify(buildTime) },
  });

  const size = fs.statSync(path.join(outdir, 'server.cjs')).size;
  console.log(`[bundle-server] 完成：dist/server.cjs（${(size / 1024 / 1024).toFixed(2)} MB，构建时间 ${buildTime}）`);
}

main().catch((err) => {
  console.error('[bundle-server] 失败：', err);
  process.exit(1);
});
