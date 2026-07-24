# DorisMan — Doris 授权管理平台 技术规格书

> 本文件是整个项目的**单一事实来源**。后端、前端、打包都必须严格遵循这里的契约。
> 目标环境：Apache Doris 3.x / 4.x（存算一体），管理平台最终打包为单一可执行二进制，
> 在 统信 UOS V20 / Debian 11.9（linux-x64）上解压即用。

---

## 1. 技术选型与硬性约束

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js (兼容 node18) + Express 4 + mysql2 3.x | Doris 走 MySQL 协议，直连 FE 9030 端口 |
| 前端 | Vue 3 + Vite + Element Plus + Pinia + Vue Router + axios | 中后台管理界面 |
| 本地存储 | JSON 文件（accounts.json / clusters.json / audit.jsonl） | **禁用 better-sqlite3 等原生模块** |
| 打包 | esbuild 打包后端为单文件 CJS → `pkg@5.8.1` 生成 node18 linux/win x64 二进制 | 前端产物经 pkg assets 内嵌 |
| 鉴权 | JWT（jsonwebtoken）+ bcryptjs 密码哈希 | 页面自身账号体系，与 Doris 账号无关 |

**硬性约束：**

1. 所有 npm 依赖必须是**纯 JavaScript**，禁止任何需要 node-gyp 编译的原生模块（否则二进制打包失败）。允许使用：express、mysql2、jsonwebtoken、bcryptjs、cors 等。
2. 后端代码必须兼容 **Node 18**（不使用 `node:sqlite`、不依赖 20+ 新 API）。
3. 前端构建产物为静态文件，由后端 express.static 托管（生产模式单端口）。
4. 所有对 Doris 的**写操作**（CREATE USER / GRANT / REVOKE / ALTER / DROP ...）必须先经过"SQL 预览"接口生成语句，由用户在前端确认后才调用执行接口。
5. 代码注释、UI 文案使用**简体中文**；代码风格清晰，便于使用者阅读学习。

---

## 2. 目录结构

```
dorismanweb/
├── SPEC.md                  # 本文件
├── package.json             # 根编排脚本（无依赖，仅有 scripts）
├── server/                  # 后端（独立 package.json）
│   ├── package.json
│   ├── src/
│   │   ├── index.js         # 入口：创建 express app，托管 web/dist，监听端口
│   │   ├── config.js        # 端口、数据目录等
│   │   ├── store.js         # JSON 文件存储（账号/集群/审计），密钥管理
│   │   ├── auth.js          # 登录、JWT 签发与校验中间件、RBAC 中间件
│   │   ├── doris.js         # mysql2 连接池管理、只读查询封装
│   │   ├── sqlgen.js        # SQL 生成器（纯函数，无 IO）
│   │   ├── grantsParser.js  # SHOW GRANTS 结果解析（纯函数）
│   │   ├── password.js      # 16 位强随机密码生成（纯函数）
│   │   └── routes.js        # 全部 API 路由
│   └── test/
│       ├── sqlgen.test.js   # node --test 单元测试
│       └── grantsParser.test.js
├── web/                     # 前端（独立 package.json）
│   ├── package.json
│   ├── vite.config.js       # dev 代理 /api → http://localhost:9197
│   ├── index.html
│   └── src/
│       ├── main.js          # Element Plus 中文语言包
│       ├── App.vue
│       ├── router.js        # 路由 + 登录守卫 + 角色守卫
│       ├── store.js         # Pinia：登录态、当前集群
│       ├── api.js           # axios 封装（JWT 头、401 跳登录）
│       ├── utils/password.js# 前端随机密码生成（crypto.getRandomValues）
│       └── views/
│           ├── Login.vue
│           ├── Layout.vue   # 侧边栏 + 顶栏（集群切换器 + 用户菜单）
│           ├── Users.vue    # 用户列表
│           ├── UserDetail.vue# 用户详情（授权/属性/改密/删除）
│           ├── UserEdit.vue # 创建用户 / 更新授权（同一组件两种模式）
│           ├── Roles.vue    # 角色管理
│           ├── SqlConsole.vue # SQL 控制台（仅 admin）
│           ├── Audit.vue    # 审计日志（仅 admin）
│           ├── Clusters.vue # 集群管理（仅 admin 写）
│           └── Accounts.vue # 平台账号管理（仅 admin）
├── dist/                    # esbuild 输出（server.cjs）
└── release/                 # pkg 输出与最终 tar 包
```

---

## 3. 数据存储（data 目录）

数据目录位置：环境变量 `DORISMAN_DATA` 优先，否则取**可执行文件所在目录下的 `data/`**（开发时为 `server/data/`）。首次启动自动创建。

| 文件 | 内容 |
|---|---|
| `data/accounts.json` | `[{username, passwordHash, role, createdAt}]`，role ∈ `admin` / `readonly` |
| `data/clusters.json` | `[{id, name, host, port, username, passwordEnc, createdAt}]`，密码用 AES-256-GCM 加密 |
| `data/.secret` | 随机生成的 32 字节 hex 密钥（JWT 签名 + 集群密码加密共用），权限 0600 |
| `data/audit.jsonl` | 审计日志，每行一个 JSON：`{id, time, account, accountRole, clusterId, clusterName, action, sql, ok, error, ip}` |
| `data/INIT_ADMIN_PASSWORD.txt` | 仅首次初始化时写入的初始管理员密码（0600），并在启动横幅打印 |

**首次启动引导**：若 accounts.json 不存在，自动创建账号 `admin`（角色 admin），密码为随机 16 位强密码，写入 INIT_ADMIN_PASSWORD.txt 并打印到控制台，提示用户登录后立即修改。

**集群连接信息**：host、port（默认 9030）、username（root/admin 均可）、password（加密存储，任何 API 都不返回明文）。

---

## 4. 平台账号与 RBAC

- 角色：`admin`（全部功能）、`readonly`（只读）。
- readonly **允许**：登录、改自己密码、查看集群列表（不含密码）、切换集群、查看用户/角色/授权/属性。
- readonly **禁止**：一切 POST/PUT/DELETE 变更接口、SQL 控制台、审计日志查看、账号管理、集群增删改。
- 后端用 `requireAuth` + `requireAdmin` 两个中间件实现；前端路由同步隐藏入口，但**安全以后端为准**。
- 登录接口加简单内存限流：同一 IP 1 分钟内失败 5 次锁定 5 分钟。
- JWT 有效期 12 小时。

---

## 5. Doris 权限模型（本项目覆盖范围）

### 5.1 权限项（前端多选框）

| 权限 | 说明 | 适用层级 |
|---|---|---|
| SELECT_PRIV | 查询 | 全局/Catalog/库/表 |
| LOAD_PRIV | 导入/写入（LOAD、INSERT、DELETE） | 全局/Catalog/库/表 |
| ALTER_PRIV | schema 变更 | 全局/Catalog/库/表 |
| CREATE_PRIV | 创建库表视图 | 全局/Catalog/库/表 |
| DROP_PRIV | 删除库表视图 | 全局/Catalog/库/表 |
| SHOW_VIEW_PRIV | 查询视图（2.x+） | 全局/Catalog/库/表 |
| GRANT_PRIV | 授权/撤权/用户管理 | 全局/Catalog/库/表 |
| USAGE_PRIV | 资源使用权限 | 仅 RESOURCE 层级 |
| ADMIN_PRIV | 超管（高危，界面加警示） | 仅全局 |

不暴露 NODE_PRIV（root 专属）。快捷预设：**只读** = SELECT_PRIV；**读写** = SELECT_PRIV + LOAD_PRIV + ALTER_PRIV + CREATE_PRIV + DROP_PRIV。

### 5.2 授权层级与 ON 目标生成规则

| level | ON 目标（三段式，标识符用反引号包裹） |
|---|---|
| `global` | `*.*.*` |
| `catalog` | `` `catalog`.*.* `` |
| `database` | `` `catalog`.`db`.* `` |
| `table` | `` `catalog`.`db`.`table` `` |
| `resource` | `RESOURCE 'name'`（name 为 `*` 或具体资源名；仅允许 USAGE_PRIV） |

### 5.3 SQL 生成规则（sqlgen.js 纯函数）

所有函数返回 **SQL 字符串数组**（一个操作可能展开成多条）。

1. **创建用户**：对每个 host 生成：
   `CREATE USER IF NOT EXISTS 'user'@'host' IDENTIFIED BY 'pwd';`
   然后每个 host × 每条授权项：
   `GRANT <priv1, priv2> ON <目标> TO 'user'@'host' [WITH GRANT OPTION];`
   然后每个 host × 每个角色：
   `GRANT 'role' TO 'user'@'host';`
2. **更新授权（diff）**：输入"当前授权集合（解析自 SHOW GRANTS）"和"期望授权集合"，按 `level|catalog|db|table` 为 key 做集合差：
   - 期望有而当前没有的权限 → `GRANT ...`
   - 当前有而期望没有的权限 → `REVOKE <privs> ON <目标> FROM 'user'@'host';`
   - 角色同理：`GRANT 'r' TO ...` / `REVOKE 'r' FROM 'u'@'h';`
   - 传入了新密码 → `ALTER USER 'user'@'host' IDENTIFIED BY 'pwd';`
   - diff 结果为空时返回空数组，前端提示"无变更"。
3. **删除用户**：`DROP USER IF EXISTS 'user'@'host';`
4. **修改密码**：`ALTER USER 'user'@'host' IDENTIFIED BY 'pwd';`
5. **角色**：
   - 创建：`CREATE ROLE IF NOT EXISTS 'role' COMMENT '...';` + 授权项 `GRANT <privs> ON <目标> TO ROLE 'role';`
   - 更新：同样 diff（GRANT/REVOKE ... TO/FROM ROLE 'role'）
   - 删除：`DROP ROLE IF EXISTS 'role';`
6. **转义规则**：用户名/角色名/标识符中的反引号转义为双反引号；字符串值中的 `'` 转义为 `\'`，`\` 转义为 `\\`。**用户名、host、库表名只允许 `[A-Za-z0-9_$.%-]` 等安全字符**，先校验再生成，非法直接报错——这是防注入第一关。

### 5.4 随机密码（password.js）

16 位，至少含 1 大写、1 小写、1 数字、1 特殊字符（特殊字符集合 `!@#$%^&*-_=+`，**不含引号和反斜杠**以免转义问题），用 `crypto.randomInt` 生成并洗牌。前端用 `crypto.getRandomValues` 实现同规则（生成在前端完成，随表单提交）。

### 5.5 SHOW GRANTS 解析（grantsParser.js 纯函数，必须防御式）

`SHOW GRANTS FOR 'u'@'h'` / `SHOW ALL GRANTS` 返回列（版本间有差异，按列名容错取值）：
`UserIdentity, Password, GlobalPrivs, CatalogPrivs, DatabasePrivs, TablePrivs, ResourcePrivs, WorkloadGroupPrivs, ComputeGroupPrivs, StorageVaultPrivs, Roles`

单元格格式示例（两种都要兼容）：
- `DatabasePrivs`: `` `internal`.`db1`.*: SELECT_PRIV,LOAD_PRIV; `internal`.`db2`.*: ALTER_PRIV ``
- `GlobalPrivs`: `SELECT_PRIV,LOAD_PRIV` 或 `SELECT_PRIV: true; DROP_PRIV: false` 风格

解析输出统一结构：
```json
{
  "userIdentity": "'devuser'@'10.%'",
  "roles": ["dev_tmp_role"],
  "grants": [
    {"level": "database", "catalog": "internal", "database": "db1", "table": null,
     "privileges": ["SELECT_PRIV", "LOAD_PRIV"], "grantOption": false}
  ]
}
```
无法解析的单元格**不抛异常**，放入 `unparsed: [{field, value}]` 供界面展示原始值。单元测试用上述样例数据覆盖。

---

## 6. 后端 API 契约

统一约定：
- 前缀 `/api`；除 `/api/health` 和 `/api/auth/login` 外全部需要 `Authorization: Bearer <jwt>`。
- 错误响应统一：`{ "error": { "code": "...", "message": "中文错误信息" } }` + 合适 HTTP 状态码。
- 成功响应直接返回数据本体（对象或数组）。
- 路径中 `:user` / `:host` / `:role` 需要 URL 编码（host 含 `%`）。
- 所有写操作成功后写 audit.jsonl（含执行的每条 SQL、成功与否、错误信息）。
- 预览接口（preview）是纯计算，不触碰 Doris 写路径，但 update 预览需要读当前 SHOW GRANTS。

### 6.1 基础
- `GET /api/health` → `{ ok: true, version: "0.1.0" }`

### 6.2 认证
- `POST /api/auth/login` `{username, password}` → `{token, user:{username, role}}`
- `GET /api/auth/me` → `{username, role}`
- `POST /api/auth/change-password` `{oldPassword, newPassword}` → `{ok:true}`（新密码强度：≥8 位且含字母+数字）

### 6.3 平台账号（requireAdmin）
- `GET /api/accounts` → `[{username, role, createdAt}]`
- `POST /api/accounts` `{username, password, role}` → 201 `{username, role, createdAt}`
- `PUT /api/accounts/:username` `{password?, role?}` → `{ok:true}`（禁止把自己改成 readonly / 禁止删除最后一个 admin）
- `DELETE /api/accounts/:username` → `{ok:true}`（禁止删除自己）

### 6.4 集群管理
- `GET /api/clusters` → `[{id, name, host, port, username, createdAt}]`（readonly 可用；永不返回密码）
- `POST /api/clusters`（admin）`{name, host, port, username, password}` → 创建，创建前用 mysql2 实测连接，失败返回 400 与中文原因
- `PUT /api/clusters/:id`（admin）同上字段可选；若改了连接信息需重测
- `DELETE /api/clusters/:id`（admin）
- `POST /api/clusters/:id/test` → `{ok:true, version}` 或 `{ok:false, error}`（readonly 可用）

### 6.5 Doris 元数据（按集群）
- `GET /api/c/:clusterId/catalogs` → `["internal", ...]`（`SHOW CATALOGS`，兼容列名差异）
- `GET /api/c/:clusterId/databases?catalog=xxx` → `["db1", ...]`（`SHOW DATABASES FROM \`catalog\``）
- `GET /api/c/:clusterId/tables?catalog=xxx&db=yyy` → `["t1", ...]`（`SHOW TABLES FROM \`catalog\`.\`db\``）

### 6.6 用户管理
- `GET /api/c/:clusterId/users` → 按用户名分组：
  ```json
  [{ "user": "devuser",
     "hosts": [{ "host": "10.%", "roles": ["dev_tmp_role"],
                 "grantCount": 3, "raw": { ...SHOW ALL GRANTS 原始行... } }] }]
  ```
  数据源 `SHOW ALL GRANTS`（失败则降级 `SELECT * FROM mysql.user` 只取 User/Host）。grantCount 为解析出的授权项数。
- `GET /api/c/:clusterId/users/:user/:host/grants` → 5.5 节解析结构 + `raw` 原始行
- `GET /api/c/:clusterId/users/:user/:host/property` → `SHOW PROPERTY FOR 'user'@'host'` 原始行数组 `[{Key, Value}]`
- `POST /api/c/:clusterId/users/preview`（admin）请求体：
  ```json
  { "user": "devuser", "hosts": ["10.%", "172.16.%"],
    "password": "16位密码", "roles": ["dev_tmp_role"],
    "grants": [ {"level":"database","catalog":"internal","database":"TMP","table":null,
                 "privileges":["SELECT_PRIV","LOAD_PRIV"],"grantOption":false} ] }
  ```
  → `{ "sql": ["CREATE USER ...", "GRANT ..."] }`
- `POST /api/c/:clusterId/users`（admin）同上请求体 + 字段 `confirm:true` → 逐条执行生成的 SQL，返回 `{results:[{sql, ok, error}]}`；**出错即停**并返回已执行明细（HTTP 207 风格不必，统一 200 + results 内标 ok）。
- `POST /api/c/:clusterId/users/:user/:host/preview-update`（admin）：
  `{ "password": null | "newpwd", "roles": ["r1"], "grants": [...] }` → 服务器先 SHOW GRANTS 取当前值，diff 后 → `{ "sql": [...], "current": <解析结构> }`
- `PUT /api/c/:clusterId/users/:user/:host`（admin）同上 + `confirm:true` → `{results:[...]}`
- `POST /api/c/:clusterId/users/:user/:host/password`（admin）`{password}` → 直接生成并执行 ALTER USER（也要先返回 sql 预览：前端先调 `POST /api/c/:clusterId/sql/preview-only`？不需要——前端本地就能拼这一条，直接在本接口 body 里带 `dryRun:true` 时只返回 sql 不执行）
- `DELETE /api/c/:clusterId/users/:user/:host`（admin）`{confirm:true}` → 执行 DROP USER

### 6.7 角色管理
- `GET /api/c/:clusterId/roles` → `SHOW ROLES` 原始行数组
- `GET /api/c/:clusterId/roles/:role/grants` → `SHOW GRANTS FOR ROLE 'r'` 解析结构 + raw
- `GET /api/c/:clusterId/roles/:role/members` → 扫描 SHOW ALL GRANTS 的 Roles 列，返回 `["'u'@'h'", ...]`
- `POST /api/c/:clusterId/roles/preview`（admin）`{role, comment, grants:[...]}` → `{sql}`
- `POST /api/c/:clusterId/roles`（admin）同上 + confirm → `{results}`
- `POST /api/c/:clusterId/roles/:role/preview-update`（admin）`{grants:[...]}` → diff `{sql, current}`
- `PUT /api/c/:clusterId/roles/:role`（admin）confirm → `{results}`
- `DELETE /api/c/:clusterId/roles/:role`（admin）

### 6.8 SQL 控制台（requireAdmin）
- `POST /api/c/:clusterId/execute` `{sql}` → 单次单条语句：
  - 查询类：`{ok:true, kind:"result", columns:[...], rows:[[...]], durationMs}`
  - 执行类：`{ok:true, kind:"exec", affectedRows, durationMs}`
  - 失败：`{ok:false, error:"..."}`（HTTP 200，错误放 body，前端展示）
  - 行数上限：超过 1000 行截断并在响应里标 `truncated:true`
  - 全部语句写审计日志

### 6.9 审计日志（requireAdmin）
- `GET /api/audit?clusterId=&account=&page=1&size=50` → `{total, items:[...]}`（jsonl 倒序读取，内存分页）

---

## 7. 前端规格

### 7.1 全局
- Element Plus 中文（zh-cn）；整体深色侧边栏 + 浅色内容区的经典管理后台风格。
- 顶栏左侧：集群切换下拉（显示 name(host:port)，切换后刷新当前页数据）；右侧：当前账号 + 修改密码 + 退出。
- 所有 Doris 写操作统一走 **SqlPreviewDialog 组件**：展示编号 SQL 列表（等宽字体、可复制）、确认按钮 → 调执行接口 → 逐条显示 ✓/✗ 与错误信息。
- axios 拦截器：401 清 token 跳登录；错误统一 ElMessage 提示后端 message。
- 无可用集群时，除"集群管理"外所有页面显示空状态引导。

### 7.2 用户列表 Users.vue
- 表格按用户名分组展示（每行 user，展开显示各 host：来源地址、角色、授权项数、操作）。
- 顶部：搜索框（按用户名过滤）、刷新、"新建用户"按钮（admin 可见）。
- host 行操作：查看授权（抽屉展示解析后的授权表格 + 原始 SHOW GRANTS）、编辑授权、重置密码、删除（均 admin）。

### 7.3 创建/更新用户 UserEdit.vue（核心页面）
- 模式 create / edit（edit 时锁定用户名与 host，预填当前授权与角色）。
- 表单：
  - 用户名（create）；来源地址 hosts：tag 输入框，可添加多个（如 `10.%`、`172.16.%`、`%`），校验格式；
  - 密码（create 必填 / edit 留空表示不改）：输入框 + "随机生成"按钮（16 位强密码）+ 显示/隐藏切换 + 强度提示；
  - 角色：多选下拉（选项来自 roles 接口）；
  - 授权项编辑器：可增删的行列表，每行：
    - 层级选择（全局/Catalog/数据库/表/资源）；
    - 级联选择器选 catalog → 库 → 表（数据来自 6.5 接口，支持"全部 * "，也允许手填新名称）；
    - 权限多选（按层级过滤可用项，USAGE_PRIV 只在资源层级出现，ADMIN_PRIV 只在全局出现并带警示）；
    - WITH GRANT OPTION 开关；
    - 快捷预设按钮：只读 / 读写 / 全量(当前层级)；
    - 同一行支持添加多个目标（"再加一个目标"克隆该行）。
- 底部："预览 SQL"→ 调 preview 接口 → SqlPreviewDialog → 确认执行 → 结果展示 → 成功后跳回用户列表。
- edit 模式预览时额外展示"当前授权 vs 变更后"的 diff 说明（直接用接口返回的 current）。

### 7.4 角色管理 Roles.vue
- 角色列表（名称、备注、是否系统内置 admin/operator、操作）；
- 新建角色对话框：名称 + 备注 + 授权项编辑器（复用 UserEdit 的编辑器组件，抽成 `GrantsEditor.vue`）；
- 每个角色：查看授权（抽屉）、编辑授权（diff 预览）、查看成员、删除（内置角色 admin/operator 禁止删除，前端禁用 + 后端拦截）。

### 7.5 SQL 控制台 SqlConsole.vue（admin）
- 上：多行 SQL 输入（单条执行）；下：结果区（表格展示 columns/rows，或 affectedRows，或红色错误）。
- 危险关键词（DROP/REVOKE/TRUNCATE/ALTER SYSTEM/GRANT）执行前弹确认框。
- 本地历史（localStorage 最近 50 条，点击回填）。

### 7.6 其他页面
- Audit.vue：时间倒序表格（时间、账号、集群、动作、SQL、结果、错误、IP），按集群/账号筛选，分页。
- Clusters.vue：卡片或表格展示集群（名称、地址、账号、连通状态灯——进入页面自动逐个 test），admin 可增改删；表单含"测试连接"按钮。
- Accounts.vue：账号表格 + 新建/改角色/重置密码/删除。
- Login.vue：居中卡片， DorisMan 标题，登录失败显示后端 message。

---

## 8. 打包与部署（根 package.json scripts）

```json
{
  "scripts": {
    "dev:server": "node server/src/index.js",
    "dev:web": "npm --prefix web run dev",
    "build": "npm --prefix web run build && node scripts/bundle-server.js",
    "package": "node scripts/package.js",
    "test": "npm --prefix server test"
  }
}
```

- `scripts/bundle-server.js`：esbuild 把 server/src/index.js 打成 `dist/server.cjs`（platform node, target node18, bundle, minify:false 便于排障）。
- `scripts/package.js`：调用 pkg API，targets：`node18-linux-x64`、`node18-win-x64`；assets：`web/dist/**/*`；输出 `release/dorisman-linux-x64[.exe]`。并生成 tar 包（解压根目录即工作目录，`./bin/start.sh` 即可启动）：
  ```
  release/dorisman-web-v<版本>-linux-x64.tar.gz
  ├── bin/
  │   ├── dorisman          # 二进制
  │   ├── start.sh          # #!/bin/sh; 默认 nohup 后台启动（-f 前台）；自动加载 conf/dorisman.conf
  │   └── stop.sh           # 停止脚本（按 logs/dorisman.pid 结束进程）
  ├── conf/
  │   └── dorisman.conf     # 可选配置示例（全注释：PORT / HOST / DORISMAN_DATA）
  ├── data/                 # 运行数据（首次启动由 start.sh 创建，不打入包）
  ├── logs/                 # 运行日志与 pid（首次启动由 start.sh 创建，不打入包）
  └── README-部署.md
  ```
- 运行行为：start.sh 无论从哪里调用都切到解压根目录作为工作目录，`mkdir -p data logs`；监听 `0.0.0.0:${PORT:-9197}`；托管内嵌的 web/dist；data 目录默认在解压根目录 `./data`（二进制由 bundle banner 预设 DORISMAN_DATA 指向 bin/ 上一级 data/）；启动横幅打印访问地址与初始密码提示。
- pkg 内 express.static 读取 snapshot 内 assets 路径（`path.join(__dirname, '..', 'web', 'dist')`）需验证可行；若 pkg 静态目录读取有问题，备选方案：启动时把 snapshot 内 web/dist 复制到 data/webroot 再托管（在 package.js 里留这个 fallback 注释即可，由后端代码实现优先 snapshot 直读）。

---

## 9. 验收标准

1. `npm --prefix server test` 全部通过（sqlgen / grantsParser / password 单测）。
2. `npm --prefix web run build` 成功。
3. 开发模式启动后端，curl 验证：health、登录、账号 CRUD、集群 CRUD（用一个不可达地址验证报错路径）。
4. esbuild 打包成功，pkg 生成 linux-x64 与 win-x64 二进制。
5. Windows 二进制本机冒烟：启动后浏览器打开登录页、登录、各页面无 500。
6. 无 Doris 真机环境下，Doris 相关接口用"连接失败"路径验证错误处理；SQL 生成逻辑全部走单测覆盖。
