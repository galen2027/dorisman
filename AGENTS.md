# DorisMan 项目协作指南

最后更新：2026-11-27。适用于已有项目维护与扩展；当前软件版本为 `0.1.2`。

## 项目目标与本次边界

DorisMan 是 Apache Doris 用户、角色和授权管理平台。现有功能包含多集群连接、用户多 host 管理、授权差异计算、属性修改、密码重置、禁用、角色、SQL 控制台及 Doris SQL 审计。

本次交付为项目梳理和扩展设计，未实现新业务功能。后续需求已确认：

- 部门、小组只组织 **Doris 账号**，不组织平台登录账号。
- 平台登录角色仍为 `admin/readonly`；组织负责人通过独立的范围授权关联平台账号，在获批范围内管理 Doris 成员和分配权限。
- 目标适配 Doris `3.0.8` 行列权限，完善凭据安全、审计和 Web 关于/帮助与版本信息。
- 历史 `plan.md` 中资源分组、FE/BE 节点管理属于未完成的历史需求，本轮没有确认纳入开发。

## 文档导航和事实边界

| 文件 | 用途 |
| --- | --- |
| [项目设计方案](docs/DorisMan项目设计方案_v1.0_261127.md) | 当前代码事实、已知缺口、拟建方案、接口和验收基线 |
| [README.md](README.md) | 使用概览、开发命令和原有发布说明 |
| [SPEC.md](SPEC.md) | 原始技术契约；其中旧语法、路径和能力声明需要结合设计方案中的差异清单阅读 |
| [plan.md](plan.md) | 历史计划与历史测试记录，不作为当前完成情况依据 |
| `server/test/` | 现有后端自动测试 |

规则、设计意图和运行事实分别维护：本文件约束协作，设计方案记录现状与目标；实际行为以最新代码和本次验证为据。发现差异先报告并同步受影响文档，不能默默改变契约。未来设计不能写成当前已实现能力。

## 技术和环境约束

- 沿用现有 **npm + 三份 package-lock.json**（根、server、web）；不迁移 pnpm、不自动升级框架、不套用新项目固定版本。
- `package.json` 声明 Node `>=18`；后端 CommonJS、前端 ESM/Vue SFC；后端及 bundle 必须兼容发布目标 Node 18。
- 本次实际验证环境：Node `20.12.2`、npm `10.5.0`。这不代表已验证 Node 18 或目标 Linux。
- 保留 Express 4、mysql2、Vue 3、Element Plus、Pinia、Vue Router、axios 和现有锁文件版本。
- 平台存储为 JSON/JSONL，Doris 通过 mysql2 连接 FE 的 MySQL 协议端口，默认 `9030`。不得擅自替换为 SQLite/MySQL 平台数据库。
- 后端新增运行依赖必须满足现有纯 JavaScript 和 pkg 打包边界；不引入 node-gyp 原生依赖。构建工具自身可有平台二进制，如现有 esbuild。
- 复用已安装依赖；确需按锁文件重装时，在对应目录执行 `npm ci`。注意该命令会替换该目录的 `node_modules`，不应为了文档任务执行。
- 不新建虚拟环境，不修改全局 PATH、系统运行时或共享缓存。

## 代码地图

| 路径 | 职责与修改关注点 |
| --- | --- |
| `server/src/index.js` | Express 启动、CORS、JSON body、API 装配、静态托管、SPA 回退、退出清理 |
| `server/src/config.js` | CLI、环境变量、版本、数据/前端路径、限流和超时常量 |
| `server/src/routes.js` | 现有全部 41 个 method/path 路由、鉴权接线、preview/execute、逐条审计 |
| `server/src/doris.js` | 按集群连接池、SHOW 查询、版本探测、密码解密后的连接信息 |
| `server/src/sqlgen.js` | 无 IO 的校验、转义、SQL 生成、授权与角色 diff |
| `server/src/grantsParser.js` | SHOW GRANTS/SHOW ROLES 解析、未解析字段透传 |
| `server/src/store.js` | JSON 原子替换、AES-GCM、账号、集群、本地禁用状态、审计脱敏 |
| `server/src/auth.js`、`loginCrypto.js`、`protect.js` | JWT/RBAC/限流、RSA 登录、内置账号保护 |
| `web/src/router.js`、`store.js`、`api.js` | 页面守卫、登录/当前集群、axios 与加密 |
| `web/src/views/Users.vue`、`UserEdit.vue`、`Roles.vue` | 用户列表与详情/属性抽屉、创建/编辑/克隆授权、角色管理 |
| `web/src/components/GrantsEditor.vue` | 权限层级、元数据级联、负载组选择和校验 |
| `web/src/components/SqlPreviewDialog.vue` | SQL 预览、调用父组件 executor、展示执行结果 |
| `scripts/bundle-server.js`、`scripts/package.js` | node18 bundle、pkg、启动脚本和部署包内容生成 |
| `release.sh`、`scripts/publish-github.sh` | 带提交、标签和远程推送副作用的发布流程 |

## 现有契约：修改前必须核对

1. API 前缀 `/api`；成功返回业务本体，错误 `{error:{code,message}}` 配合 HTTP 状态码。沿用 camelCase 字段及现有函数风格，禁止全项目机械改名或替换成 `code/msg/data` 包装。
2. Doris 对象按 `clusterId + user + host` 标识；URL 动态段使用 `encodeURIComponent`。用户属性按用户名生效，路径中的 host 不构成属性隔离。
3. 当前集群是浏览器 localStorage/Pinia 中的选择；每个 API 显式带 clusterId，不是服务器全局独占集群。
4. SQL 生成器只做纯计算；网络与执行在 doris/routes 层，文件 IO 在 store 层。DDL/授权语法不能使用绑定变量代替标识符，必须校验并正确转义，不能直接拼接未校验输入。
5. 用户/角色授权编辑重新读取 Doris 当前值，计算 GRANT/REVOKE diff。`roles/grants` 缺省通常代表保留，显式空数组代表清空；不得混淆。
6. 普通批量执行出错即停、已成功 SQL 不自动回滚。HTTP 200 不表示业务全部成功，调用方必须检查 `results[].ok` 或 `ok`。
7. 现有 preview 和 execute 会分别生成 SQL，没有不可变计划或快照绑定，不能宣传为严格“所见即所执行”。新增写功能应按设计方案补齐计划校验。
8. 新增 Doris 写操作必须有预览/明确确认、后端权限检查、输入校验、逐条结果及脱敏审计；不能仅隐藏前端按钮。
9. 当前平台只有 admin 全局写权限。范围负责人尚未实现：新增后应使用独立 scope/capability 校验，普通 readonly 继续只读，不能直接放开 `requireAdmin`。
10. `root/admin` Doris 账号保护必须保留；内置角色 `admin/operator` 禁删。控制台当前是正则保护，新增语法需补对应反例和绕过测试。
11. 禁用是随机改密并记录 `userStatus.json`，启用需要新密码；不是原生账号锁定，不能保证终止已有会话。外部改密可能导致本地标记漂移。
12. 编辑器支持 global/catalog/database/table/resource/workload_group；compute_group/storage_vault 仅解析展示，列权限和 Row Policy 管理尚未实现。
13. 审计和业务时间目前用 ISO UTC 字符串，界面以浏览器时区展示。改时间策略前评估历史记录，不直接全量替换存储格式。

## 安全和数据保护

- 不读取或输出真实运行数据、`.secret`、初始密码、集群密码、JWT、SQL 中的密码；联调使用隔离临时目录和测试账号。
- 平台密码保留不可逆哈希，集群连接密码需要可逆加密；二者用途不同。新功能不得返回集群密码或增加密码回显页面。
- 登录 RSA 失败降级明文、JWT 撤销缺失、审计覆盖不足等是已知缺口，不能当作规范固化。目标方案要求 HTTPS 和禁止明文降级。
- 不能自动删除 `accounts.json` 作为密码恢复方案；不能重新生成 `.secret` 修复解密问题。密钥损坏须停止相关写操作并从备份恢复。
- `data/`、日志和密钥不进入 Git、发布包或截图；故障描述中也不能写密钥片段。
- 不使用生产集群执行 `server/tools/e2e-live.js` 或语法探测：这些工具可能创建/授权/删除对象，先阅读源码并明确目标测试范围。

## 开发流程与验证

修改前读取最新相关文件、文档和 `git status --short`，说明位置、影响范围和预期结果；只做当前需求的最小修改，不覆盖用户已有变更。

```powershell
npm run dev:server  # 后端默认 9197
npm run dev:web     # 前端默认 5173，/api 代理到 9197
npm test           # 后端 node --test
npm run build      # Vite + esbuild，不等于 pkg 或 Linux 验证
node server/src/index.js --help
node server/src/index.js --version
```

- 文档变更：核对相对链接、代码/接口映射、图表和事实状态；不为可逆文案修改新增实现镜像式测试。
- SQL/解析变更：补代表性输入、差异、未识别字段、注入和权限边界测试，运行 `npm test`。
- 前端或跨层变更：运行 `npm run build`；涉及交互时在真实浏览器操作目标流程，构建成功不能替代 UI 验证。
- API/鉴权/组织范围变更：运行真实本地进程验证未登录、普通 readonly、负责人范围内/外及 admin，不只测试纯函数。
- Doris 行列权限：必须在目标 3.0.8 测试集群用普通业务账号查询验证，包括其他角色继承、越权行列和多策略组合；未提供环境时明确未验证。
- 完成以可观测行为为准。交付区分已实现、已验证、未验证和未实现；不把占位逻辑、mock 或历史测试数说成完成证据。
- 本次基线：2026-11-27，`npm test` 为 88/88，`npm run build` 成功；隔离本地 HTTP 冒烟验证了 RSA 登录、readonly 拦截、静态托管，也复现了角色删除确认字段缺失、登录/账号无审计和删除账号后 JWT 仍有效。

## 已知缺口与扩展顺序

优先修复明文降级、JWT 撤销、角色删除参数、grantOption 撤回顺序风险、审计遗漏、预览并发漂移，再分阶段增加组织范围、列权限、Row Policy 和关于/帮助；具体设计和验收见设计方案。新功能尚未给出工期与资源承诺。

## Git 协作流程

- 开始前检查工作区、当前分支、远程地址和远程分支头；只暂存本次明确涉及的文件，不使用 `git add .` 混入其他改动。
- 后续工作默认在 `codex/<任务名>` 分支进行。当前本地 `main` 保留历史，远程 `origin/main` 为干净快照；新分支优先基于已核实的远程快照建立。切换前比较文件树，存在差异时先处理工作区保护和变更迁移，不能强制覆盖。
- 提交前检查 staged diff、敏感信息和对应验证结果，使用 `docs:`、`feat:`、`fix:` 等明确的提交类型；纯文档提交不递增软件版本。
- 提交与推送是独立步骤；用户仅要求本地提交时不推送。后续获准推送时优先推送任务分支并通过 PR 审阅，不直接把历史本地 main 推到远程，不自动 force 推送或运行现有发布脚本。
- 提交后检查工作区与提交文件清单，报告分支、commit 和推送状态；远程读取权限不能替代写入权限验证，也不能将未推送状态说成已同步。

## 配置与发布注意事项

- `DATA_DIR`：`--data` > `DORISMAN_DATA` > 源码 `server/data` / bundle 根目录 `data`；二进制由 banner 定位到 `bin/../data`。
- **当前代码实际优先级**：`PORT/HOST` 环境变量 > `--port/--host` > 默认 `9197/0.0.0.0`。`start.sh` 总会 export PORT，因此 `--port` 可能被覆盖；后续修复要同时改代码、帮助与测试。
- 不在本次梳理中运行 `npm run package`：它默认递增版本，重写文件并可能下载 pkg runtime；普通 build 不会递增软件版本。
- `release.sh` 默认直接推送本地 main/tag，与 README 的禁止直接推送说明冲突；`publish-github.sh` 会 force 推送。未解决前禁止把两者作为自动化验证命令执行，远程写入按用户明确要求处理。
- 已有版本为 `0.1.2`，文档版本独立为 `v1.0`；不因通用新项目规则强制将软件版本重置为 `1.0.0`。
- 未来发布需保留 `--help/--version`、追加 Release 记录、校验构建版本/锁文件一致性、Linux LF 脚本、完整部署与回滚说明。不得把 Windows node_modules 或可执行文件当 Linux 依赖交付。
- 维护真实可编辑源文件，不修改被忽略的 `dist/`、`web/dist/` 或 `release/` 代替修改源码。

## 按需规则引用

按实际任务加载 `C:\Users\luosh\.codex\rules\` 下的 `20-output.md`（文档）、`31-shell.md`（Shell）、`32-sql.md`/`41-doris.md`（Doris/SQL）、`50-mermaid.md`（图示）。新项目初始化或发布目录规划才加载 `21-project-layout.md`；已有项目不因此自动重构目录。
