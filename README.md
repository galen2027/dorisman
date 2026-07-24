# DorisMan — Doris 授权管理平台

<p align="center">
  <img src="web/public/logo.png" alt="DorisMan Logo" width="120" />
</p>

DorisMan 是一个面向 **Apache Doris 3.x / 4.x** 的图形化授权管理平台：不用手写 SQL，即可完成 Doris 用户、角色、权限的日常管理。所有写操作都会先生成 **SQL 预览**，确认无误后才真正执行；同时保留一个 SQL 控制台用于自由执行。

- 前端：Vue 3 + Element Plus + Vite
- 后端：Node.js + Express + mysql2（Doris 走 MySQL 协议，直连 FE 9030 端口）
- 交付：单一可执行二进制（linux-x64，pkg node18），解压即用，目标环境统信 UOS V20 / Debian 11.9

---

## 1. 功能一览

| 模块 | 能力 |
|---|---|
| 平台登录 | 多账号（管理员 / 只读两种角色）、JWT 会话、登录失败限流锁定、RSA 加密传输密码 |
| 集群管理 | 多套 Doris 集群连接配置（保存前实测连接）；顶栏切换，**同一时刻只有一个生效集群**，所有管理操作均针对它 |
| 用户管理 | 用户列表（按用户名分组，展示 host 数、角色、来源地址）、授权详情、属性查看/编辑、克隆授权、禁用/启用、重置密码、删除 |
| 创建用户 | 向导式表单：用户名 + 多 host（`'10.%'`、`'172.16.%'`）+ 16 位随机强密码生成器 + 默认角色 + 多层级多权限 → SQL 预览 → 执行 |
| 编辑授权 | 预填当前授权（SHOW GRANTS 解析），生成 **diff SQL**（新增 GRANT / 移除 REVOKE / 改密 SET PASSWORD）→ 预览 → 执行 |
| 角色管理 | 角色列表、创建角色（含 COMMENT）、角色授权（多层级多权限）、角色成员查看、删除角色 |
| 权限模型 | 全局 `*.*.*` → Catalog `ctl.*.*` → 库 `ctl.db.*` → 表 `ctl.db.tbl` 四级级联选择（实时拉取，可手填）；权限项多选（SELECT/LOAD/ALTER/CREATE/DROP/SHOW_VIEW/GRANT/USAGE/ADMIN 等），只读、读写快捷预设；系统库（information_schema/mysql）默认不出现在选择器，手动输入时二次确认 |
| SQL 控制台 | 自由编写 SQL 直接执行，结果表格展示；DROP/REVOKE 等危险语句二次确认；禁止操作 root/admin |
| 审计日志 | 全部登录与写操作落审计（操作人、来源 IP、SQL、成功/失败、耗时），SQL 中的密码自动脱敏 |
| 系统用户 | 平台自身账号管理：新建、角色变更（admin/readonly）、重置密码、删除 |

内置保护：Doris 内置账号 **root / admin 全平台只读**——不允许在页面或 SQL 控制台编辑其授权、改密或删除，只能查看。

## 2. 架构与目录

```
dorismanweb/
├── server/                  # 后端（Express + mysql2）
│   ├── src/
│   │   ├── index.js         # 入口：托管 web/dist，监听 0.0.0.0:${PORT:-9197}
│   │   ├── config.js        # 端口/数据目录/限流等全局配置
│   │   ├── routes.js        # 全部 REST API（/api/...）
│   │   ├── doris.js         # Doris 连接池与只读查询封装
│   │   ├── sqlgen.js        # 表单 JSON → SQL 语句数组（创建/更新 diff/角色）
│   │   ├── grantsParser.js  # SHOW GRANTS / SHOW ROLES 输出解析
│   │   ├── store.js         # JSON 文件存储（账号/集群/用户状态/审计）
│   │   ├── auth.js          # JWT 签发校验、登录限流
│   │   ├── loginCrypto.js   # 登录密码 RSA-OAEP 解密
│   │   ├── password.js      # 16 位强密码生成与强度校验
│   │   └── protect.js       # root/admin 内置账号保护
│   └── test/                # node --test 单元测试（88 例）
├── web/                     # 前端（Vue 3 + Element Plus）
│   ├── public/              # logo / favicon
│   └── src/
│       ├── views/           # 登录、用户、角色、SQL 控制台、审计、集群、系统用户
│       ├── components/      # GrantsEditor（授权编辑器）、SqlPreviewDialog（SQL 预览）
│       └── utils/           # 内置账号判定、RSA 加密等
├── scripts/
│   ├── bundle-server.js     # esbuild 打包后端 → dist/server.cjs（依赖全内嵌）
│   ├── package.js           # pkg 打 linux/win 二进制 + tar.gz 发布包
│   └── wsl-smoke.sh         # WSL 冒烟（二进制启动 + 健康检查）
├── SPEC.md                  # 完整设计规格说明
└── release/                 # 打包产物（二进制 / tar.gz / bin/ 脚本 / conf/ 示例 / 部署 README）
```

数据流：前端表单 → 后端 `sqlgen.js` 生成 SQL 数组 → 前端弹窗预览 → 用户确认 → 逐条执行并返回每条成败 → 写审计日志。**预览与执行共用同一生成器，保证所见即所执行。**

## 3. 存储设计：为什么用 JSON 文件而不是 SQLite

平台自身数据量极小（账号、集群连接各几十条；审计为追加日志），因此**全部使用 JSON 文件存储，未引入 SQLite**：

| data/ 文件 | 内容 |
|---|---|
| `accounts.json` | 平台账号（用户名 / bcrypt 密码哈希 / 角色） |
| `clusters.json` | 集群连接（Doris 密码 AES-256-GCM 加密存储） |
| `userStatus.json` | 用户禁用状态本地记录（Doris 3.0.6 无原生 ACCOUNT LOCK） |
| `audit.jsonl` | 审计日志，每行一个 JSON（append-only） |
| `.secret` | 32 字节随机密钥（JWT 签名 + 集群密码加密共用，0600） |
| `INIT_ADMIN_PASSWORD.txt` | 首次初始化的 admin 随机密码（0600，用后请删除） |

选型原因：

1. **pkg 打包限制**：better-sqlite3 等原生模块无法打进单一二进制；
2. **运行时基线**：发布包内置 node18，无 `node:sqlite`（node22+ 才有）；
3. **运维简单**：备份 = 打包 data 目录，排障 = 直接看文件，无需额外客户端。

## 4. 安全设计

- 平台密码 bcrypt(10) 哈希存储；初始 admin 密码为随机 16 位强密码，仅写在启动横幅与 0600 文件中；
- 登录密码前端 **RSA-OAEP(2048) 加密**后传输，后端私钥解密，避免明文过网；
- 登录限流：同一 IP 1 分钟内失败 5 次锁定 5 分钟；
- 集群密码 AES-256-GCM 加密落盘，密钥在 `data/.secret`（0600）；
- 审计 SQL 自动脱敏（IDENTIFIED BY / PASSWORD 子句打码）；
- root/admin 内置账号全平台只读保护；危险 SQL（DROP/REVOKE/ALTER）执行前二次确认；
- API 全部鉴权（JWT，12h），写操作要求 admin 角色，只读账号仅可查看。

## 5. 开发

```bash
npm install && npm --prefix server install && npm --prefix web install

npm run dev:server     # 后端 → http://localhost:9197
npm run dev:web        # 前端 → http://localhost:5173（/api 代理到 9197）

npm test               # 后端单元测试（node --test，88 例）

# 真机 E2E（需要一套 Doris，默认 127.0.0.1:9030）
DORIS_HOST=<fe-host> DORIS_USER=admin DORIS_PWD=<pwd> node server/tools/e2e-live.js

# WSL 二进制冒烟
bash scripts/wsl-smoke.sh
```

生产模式（单进程同时托管 API 与前端）：

```bash
npm run build          # vite build + esbuild bundle → dist/server.cjs
node dist/server.cjs   # http://localhost:9197
```

## 6. 打包与部署（linux-x64）

```bash
npm run package        # 自动 patch+1（如 0.1.0→0.1.1）+ 注入构建时间 → release/ 二进制 + tar.gz
node scripts/package.js --no-bump         # 保持现版本
node scripts/package.js --version=1.2.0   # 显式指定版本
```

每次打包自动：① 版本号 patch+1（可用 `--no-bump` / `--version=x.y.z` 覆盖），同步写回 `package.json` 与 `server/src/config.js`；② 重新 bundle 并注入**构建时间**（启动横幅、`--version`、`/api/health` 均可见）。

目标服务器（统信 UOS V20 / Debian 11.9，x86_64）。发布包布局：`bin/`（二进制与脚本）、`conf/`（可选配置示例）、`data/` 与 `logs/`（首启自动创建）、`README-部署.md`（包根）。解压根目录即工作目录：

```sh
mkdir -p /opt/dorisman && tar -xzf dorisman-web-v*-linux-x64.tar.gz -C /opt/dorisman
cd /opt/dorisman && chmod +x bin/dorisman bin/start.sh bin/stop.sh
./bin/start.sh         # 默认 nohup 后台运行，端口 9197，日志 logs/dorisman.log
./bin/stop.sh          # 停止
```

命令行参数（start.sh 会透传给二进制）：

```sh
./bin/dorisman --help            # 全部参数说明
./bin/dorisman --version         # 版本号与构建时间
./bin/dorisman --port 9090       # 指定端口（等价 PORT 环境变量）
./bin/dorisman --host 127.0.0.1  # 指定监听地址（等价 HOST）
./bin/dorisman --data /opt/data  # 指定数据目录（等价 DORISMAN_DATA）
```

浏览器访问 `http://<服务器IP>:9197`，用初始 admin 密码登录（见 `logs/dorisman.log` 横幅或 `data/INIT_ADMIN_PASSWORD.txt`）。启动横幅中的「前端资源」只是信息展示——页面文件已内嵌于程序，自动加载，**无需任何配置与维护**。详见发布包内 `README-部署.md`。

## 7. 发版与 GitHub 同步

```bash
./release.sh                   # 一键发版：版本号+1 → commit → tag → 构建 → 打包 → 推送
./release.sh minor --dry-run   # 支持 patch/minor/major 与 --dry-run 预演

./scripts/publish-github.sh    # 同步到 GitHub：当前源码压成单 commit 推到 origin/main
```

注意：本地 `main` 分支保留完整开发历史（早期提交曾混入测试用敏感信息，当前文件已清洗但历史仍在），**请勿直接 `git push origin main`**；统一走 `publish-github.sh` 的压缩历史推送，GitHub 仓库永远只有干净快照。

## 8. Doris 版本适配要点

- 授权语法覆盖 Doris 2.x+ 四级层级与 3.x 权限项；SQL 生成器按 `SHOW GRANTS` 实际输出解析，已针对 3.0.6 真机验证（E2E 66 项）；
- 角色名/用户名的引号策略按版本语法实测调整（`CREATE ROLE 'name'` 在部分版本被拒绝，生成器使用反引号/裸标识符）；
- 3.0.6 不支持 `ACCOUNT LOCK`：「禁用用户」以**随机化密码**等效实现（授权保留、密码不回显、审计脱敏），禁用状态由平台本地 `userStatus.json` 记录并在用户列表展示；「启用」= 重置密码；
- `SHOW PRIVILEGES` 用于权限项说明弹窗；Workload Group 授权等未覆盖项在授权详情中标注"未能解析的内容"，不影响其余功能。

## 9. 已知限制

- Doris 用户身份是 `user@host` 组合：多 host 创建会在 Doris 中展开为多条独立记录（各自有密码），平台按用户名分组展示；
- 行级权限策略（ROW POLICY）暂不支持页面管理，可在 SQL 控制台操作；
- 审计日志为本地 JSONL 文件，超大量部署建议自行做日志轮转；
- 若 Doris 侧在平台外直接改密，禁用状态可能与实际不符（重新禁用/启用即可校正）。

---

*Logo 由 AI 生成后经裁剪处理（`assets-src/`），页面图标位于 `web/public/`。*
