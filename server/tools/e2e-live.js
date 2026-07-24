// 端到端联调脚本：通过平台真实 API 对真实 Doris 集群做全链路验证
// 用法: node server/tools/e2e-live.js <平台admin密码> <Doris密码> [baseURL] [dorisHost] [dorisPort]
// 流程: 登录 → 添加集群 → 元数据/用户/角色/授权/属性读取 → 创建测试用户(预览+执行)
//       → 集群侧直查验证 → 属性编辑(预览+执行+验证) → 增量授权diff(预览+执行+验证)
//       → 内置账号 root/admin 保护(403) → 删除测试用户 → 审计日志。每个步骤打印 ✓/✗，任一失败以非零码退出。
const mysql = require('mysql2/promise');

const [platformPwd, dorisPwd, base = 'http://localhost:8091/api', dorisHost = '127.0.0.1', dorisPort = '9030'] = process.argv.slice(2);
if (!platformPwd || !dorisPwd) {
  console.error('usage: node e2e-live.js <平台admin密码> <Doris密码> [baseURL] [dorisHost] [dorisPort]');
  process.exit(1);
}

const TEST_USER = 'dorisman_test';
const TEST_PWD = 'Doris#Test2026xY'; // 16 位强密码
let token = '';
let clusterId = '';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  // 1. 健康检查
  let r = await api('GET', '/health');
  check('健康检查', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

  // 2. 登录
  r = await api('POST', '/auth/login', { username: 'admin', password: platformPwd });
  check('平台登录', r.status === 200 && !!r.data.token, r.data.user ? JSON.stringify(r.data.user) : JSON.stringify(r.data));
  token = r.data.token || '';

  // 3. 添加集群（已存在则复用）
  r = await api('POST', '/clusters', { name: 'E2E测试集群', host: dorisHost, port: Number(dorisPort), username: 'admin', password: dorisPwd });
  if (r.status === 200 || r.status === 201) {
    clusterId = r.data.id;
    check('添加集群（含连接实测）', true, `id=${clusterId}`);
  } else {
    const list = await api('GET', '/clusters');
    const found = (list.data || []).find((c) => c.name === 'E2E测试集群');
    if (found) {
      clusterId = found.id;
      check('添加集群（复用已存在）', true, `id=${clusterId}（首次报错：${JSON.stringify(r.data).slice(0, 80)}）`);
    } else {
      check('添加集群', false, JSON.stringify(r.data).slice(0, 200));
      throw new Error('无法添加集群，终止');
    }
  }

  // 4. 测试连接（验证 dorisVersion 字段）
  r = await api('POST', `/clusters/${clusterId}/test`);
  check('测试连接', r.status === 200 && r.data.ok === true, `version=${r.data.version} dorisVersion=${r.data.dorisVersion || '(无)'}`);

  // 5. 元数据
  r = await api('GET', `/c/${clusterId}/catalogs`);
  check('SHOW CATALOGS', r.status === 200 && Array.isArray(r.data) && r.data.includes('internal'), JSON.stringify(r.data).slice(0, 120));
  r = await api('GET', `/c/${clusterId}/databases?catalog=internal`);
  check('SHOW DATABASES', r.status === 200 && Array.isArray(r.data) && r.data.includes('mysql'), JSON.stringify(r.data).slice(0, 120));

  // 6. 用户/角色列表
  r = await api('GET', `/c/${clusterId}/users`);
  const users = Array.isArray(r.data) ? r.data.map((u) => u.user) : [];
  check('用户列表（分组）', r.status === 200 && users.includes('root') && users.includes('admin'), users.join(','));
  r = await api('GET', `/c/${clusterId}/roles`);
  const roleNames = Array.isArray(r.data) ? r.data.map((x) => x.Name || x.name) : [];
  check('角色列表', r.status === 200 && roleNames.includes('admin') && roleNames.includes('operator'), roleNames.join(','));

  // 7. 查看 admin@% 授权（验证真机格式解析）
  r = await api('GET', `/c/${clusterId}/users/admin/${encodeURIComponent('%')}/grants`);
  const parsed = r.data;
  const adminGlobal = (parsed.grants || []).find((g) => g.level === 'global');
  check('解析 admin@% 授权', r.status === 200 && !!adminGlobal && adminGlobal.privileges.includes('ADMIN_PRIV'),
    `grants=${(parsed.grants || []).length} 项, roles=${JSON.stringify(parsed.roles)}`);

  // 7b. 权限项清单接口（SHOW PRIVILEGES，3.0.6 返回 12 行）
  r = await api('GET', `/c/${clusterId}/privileges`);
  const privRows = Array.isArray(r.data) ? r.data : [];
  check('权限项清单（SHOW PRIVILEGES）', r.status === 200 && privRows.length === 12 && privRows.every((x) => x && 'Privilege' in x && 'Context' in x && 'Comment' in x),
    `共 ${privRows.length} 行，样例: ${JSON.stringify(privRows[0] || null)}`);

  // 8. 创建测试用户：预览
  const createReq = {
    user: TEST_USER, hosts: ['%'], password: TEST_PWD, roles: [],
    grants: [{ level: 'database', catalog: 'internal', database: 'mysql', table: null, privileges: ['SELECT_PRIV'], grantOption: false }],
  };
  r = await api('POST', `/c/${clusterId}/users/preview`, createReq);
  const previewSql = r.data.sql || [];
  check('创建用户 SQL 预览', r.status === 200 && previewSql.length === 2 && previewSql[0].includes('CREATE USER') && previewSql[1].includes('GRANT SELECT_PRIV'),
    previewSql.join(' | '));

  // 9. 创建测试用户：执行
  r = await api('POST', `/c/${clusterId}/users`, { ...createReq, confirm: true });
  const results = r.data.results || [];
  check('创建用户执行', r.status === 200 && results.every((x) => x.ok), results.map((x) => (x.ok ? '✓' : x.error)).join(' | '));

  // 10. 集群侧直查验证
  const conn = await mysql.createConnection({ host: dorisHost, port: Number(dorisPort), user: 'admin', password: dorisPwd, connectTimeout: 10000 });
  const [g1] = await conn.query(`SHOW GRANTS FOR '${TEST_USER}'@'%'`);
  const dbPrivs = g1[0] ? (g1[0].DatabasePrivs || '') : '';
  check('集群侧验证授权已生效', /internal\.mysql.*Select_priv/i.test(dbPrivs) || /internal\.`?mysql`?.*SELECT_PRIV/i.test(dbPrivs), dbPrivs);

  // 11. 属性编辑：预览 + 执行 + 验证
  r = await api('POST', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/property/preview`, { properties: { max_user_connections: '100' } });
  check('属性编辑 SQL 预览', r.status === 200 && (r.data.sql || []).some((s) => s.includes('SET PROPERTY')), JSON.stringify(r.data.sql || r.data).slice(0, 160));
  r = await api('PUT', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/property`, { properties: { max_user_connections: '100' }, confirm: true });
  check('属性编辑执行', r.status === 200 && (r.data.results || []).every((x) => x.ok), JSON.stringify(r.data).slice(0, 160));
  const [p1] = await conn.query(`SHOW PROPERTY FOR '${TEST_USER}'`);
  const muc = p1.find((x) => x.Key === 'max_user_connections');
  check('集群侧验证属性已生效', !!muc && String(muc.Value) === '100', muc ? `${muc.Key}=${muc.Value}` : '(未找到键)');

  // 12. 增量授权 diff：模拟前端编辑流程——先拉当前授权预填，再给 mysql 加 LOAD_PRIV → 应只生成 GRANT LOAD_PRIV
  // （Doris 新用户默认自带 information_schema 的 SELECT，预填后它保留在期望集合中，不会被误 REVOKE）
  // 预填映射：完整携带 resource / workloadGroup 字段（Doris 用户默认带 normal 负载组授权，
  // 预填丢失该字段会被后端校验拒绝或误 REVOKE）
  const mapGrants = (grants) => (grants || []).map((g) => ({
    level: g.level, catalog: g.catalog, database: g.database, table: g.table,
    resource: g.resource, workloadGroup: g.workloadGroup,
    privileges: [...g.privileges], grantOption: !!g.grantOption,
  }));
  const cur = await api('GET', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/grants`);
  const desired = mapGrants(cur.data.grants);
  const mysqlEntry = desired.find((g) => g.level === 'database' && g.database === 'mysql');
  if (mysqlEntry) mysqlEntry.privileges.push('LOAD_PRIV');
  const updateBody = { password: null, roles: cur.data.roles || [], grants: desired };
  r = await api('POST', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/preview-update`, updateBody);
  const diffSql = r.data.sql || [];
  check('增量授权 diff 预览（只加 LOAD）', r.status === 200 && diffSql.length === 1 && diffSql[0].includes('GRANT LOAD_PRIV'),
    diffSql.join(' | ') || JSON.stringify(r.data).slice(0, 160));
  r = await api('PUT', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}`, { ...updateBody, confirm: true });
  check('增量授权执行', r.status === 200 && (r.data.results || []).every((x) => x.ok));
  const [g2] = await conn.query(`SHOW GRANTS FOR '${TEST_USER}'@'%'`);
  const dbPrivs2 = g2[0] ? (g2[0].DatabasePrivs || '') : '';
  check('集群侧验证 LOAD 已生效', /Load_priv/i.test(dbPrivs2), dbPrivs2);

  // 12b. 带新密码的 preview-update：验证生成 SET PASSWORD 语句（不执行）
  r = await api('POST', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/preview-update`, { password: 'Doris#New2026xY99' });
  const pwdSql = r.data.sql || [];
  check('改密 preview-update 生成 SET PASSWORD', r.status === 200 && pwdSql.length === 1
    && pwdSql[0] === `SET PASSWORD FOR '${TEST_USER}'@'%' = PASSWORD('Doris#New2026xY99');`,
    pwdSql.join(' | ') || JSON.stringify(r.data).slice(0, 160));

  // 12c. 角色全链路：预览创建（验证 CREATE ROLE 无引号）
  const TEST_ROLE = 'dorisman_test_role';
  const roleCreateReq = {
    role: TEST_ROLE, comment: 'E2E测试角色',
    grants: [{ level: 'database', catalog: 'internal', database: 'mysql', table: null, privileges: ['SELECT_PRIV'], grantOption: false }],
  };
  r = await api('POST', `/c/${clusterId}/roles/preview`, roleCreateReq);
  const rolePreviewSql = r.data.sql || [];
  check('创建角色 SQL 预览（CREATE ROLE 无引号）', r.status === 200 && rolePreviewSql.length === 2
    && rolePreviewSql[0] === `CREATE ROLE IF NOT EXISTS ${TEST_ROLE} COMMENT 'E2E测试角色';`
    && rolePreviewSql[1] === `GRANT SELECT_PRIV ON \`internal\`.\`mysql\`.* TO ROLE '${TEST_ROLE}';`,
    rolePreviewSql.join(' | ') || JSON.stringify(r.data).slice(0, 200));

  // 12d. 创建角色：执行
  r = await api('POST', `/c/${clusterId}/roles`, { ...roleCreateReq, confirm: true });
  const roleCreateResults = r.data.results || [];
  check('创建角色执行', r.status === 200 && roleCreateResults.length === 2 && roleCreateResults.every((x) => x.ok),
    roleCreateResults.map((x) => (x.ok ? '✓' : x.error)).join(' | '));

  // 12e. 给角色追加授权（模拟前端编辑：先拉当前授权，再加 LOAD_PRIV）
  const roleCur = await api('GET', `/c/${clusterId}/roles/${TEST_ROLE}/grants`);
  check('角色授权查询（SHOW ROLES 解析）', roleCur.status === 200 && Array.isArray(roleCur.data.grants)
    && roleCur.data.grants.some((g) => g.level === 'database' && g.database === 'mysql' && g.privileges.includes('SELECT_PRIV'))
    && Array.isArray(roleCur.data.roles) && roleCur.data.roles.length === 0 && !!roleCur.data.raw,
    `grants=${JSON.stringify(roleCur.data.grants || roleCur.data).slice(0, 160)}`);
  const roleDesired = mapGrants(roleCur.data.grants);
  const roleMysqlEntry = roleDesired.find((g) => g.level === 'database' && g.database === 'mysql');
  if (roleMysqlEntry) roleMysqlEntry.privileges.push('LOAD_PRIV');
  r = await api('POST', `/c/${clusterId}/roles/${TEST_ROLE}/preview-update`, { grants: roleDesired });
  const roleDiffSql = r.data.sql || [];
  check('角色增量授权 diff 预览（只加 LOAD）', r.status === 200 && roleDiffSql.length === 1
    && roleDiffSql[0] === `GRANT LOAD_PRIV ON \`internal\`.\`mysql\`.* TO ROLE '${TEST_ROLE}';`,
    roleDiffSql.join(' | ') || JSON.stringify(r.data).slice(0, 160));
  r = await api('PUT', `/c/${clusterId}/roles/${TEST_ROLE}`, { grants: roleDesired, confirm: true });
  check('角色增量授权执行', r.status === 200 && (r.data.results || []).every((x) => x.ok), JSON.stringify(r.data).slice(0, 160));

  // 12f. 再次查询角色授权，验证解析出 LOAD_PRIV
  r = await api('GET', `/c/${clusterId}/roles/${TEST_ROLE}/grants`);
  check('角色授权解析含 LOAD_PRIV', r.status === 200 && (r.data.grants || []).some(
    (g) => g.level === 'database' && g.database === 'mysql' && g.privileges.includes('LOAD_PRIV') && g.privileges.includes('SELECT_PRIV')),
    JSON.stringify(r.data.grants || r.data).slice(0, 200));

  // 12g. 角色 members 接口（扫描 SHOW ALL GRANTS 的 Roles 列，空数组成员即可）
  r = await api('GET', `/c/${clusterId}/roles/${TEST_ROLE}/members`);
  check('角色 members 接口', r.status === 200 && Array.isArray(r.data), JSON.stringify(r.data).slice(0, 120));

  // 12h. 删除角色（验证 DROP ROLE 无引号）
  r = await api('DELETE', `/c/${clusterId}/roles/${TEST_ROLE}`, { confirm: true });
  const roleDropResults = r.data.results || [];
  check('删除角色（DROP ROLE 无引号）', r.status === 200 && roleDropResults.length === 1 && roleDropResults.every((x) => x.ok)
    && roleDropResults[0].sql === `DROP ROLE IF EXISTS ${TEST_ROLE};`,
    roleDropResults.map((x) => (x.ok ? x.sql : x.error)).join(' | ') || JSON.stringify(r.data).slice(0, 160));
  const [rolesAfter] = await conn.query('SHOW ROLES');
  check('集群侧验证角色已删除', !rolesAfter.some((x) => String(x.Name) === TEST_ROLE),
    `剩余角色: ${rolesAfter.map((x) => x.Name).join(',')}`);

  // 12i. 已删除角色再查 grants 应 404
  r = await api('GET', `/c/${clusterId}/roles/${TEST_ROLE}/grants`);
  check('已删除角色查询返回 404', r.status === 404, `status=${r.status}`);

  // 12j. 负载组清单接口（与前端 Core04 契约：返回名字数组）
  r = await api('GET', `/c/${clusterId}/workload-groups`);
  const wgNames = Array.isArray(r.data) ? r.data : [];
  check('负载组清单（SHOW WORKLOAD GROUPS）', r.status === 200 && wgNames.includes('normal'), JSON.stringify(wgNames).slice(0, 160));

  // 12k. 负载组授权：先撤销默认 normal（REVOKE）→ 解析验证无残留 → 再授予（GRANT）→ 解析验证
  // （Doris 用户默认自带 normal 负载组授权，直接授予是 no-op，故先撤销再授予以覆盖完整链路）
  const curWg = await api('GET', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/grants`);
  const wgBaseline = (curWg.data.grants || []).find((g) => g.level === 'workload_group');
  check('测试用户默认负载组授权基线', !!wgBaseline && wgBaseline.workloadGroup === 'normal'
    && wgBaseline.privileges.includes('USAGE_PRIV'), JSON.stringify(wgBaseline || null));
  const desiredNoWg = mapGrants(curWg.data.grants).filter((g) => g.level !== 'workload_group');
  r = await api('POST', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/preview-update`,
    { password: null, roles: curWg.data.roles || [], grants: desiredNoWg });
  const wgRevokeSql = r.data.sql || [];
  check('负载组撤销 diff 预览（REVOKE WORKLOAD GROUP）', r.status === 200
    && wgRevokeSql.length === 1 && wgRevokeSql[0] === `REVOKE USAGE_PRIV ON WORKLOAD GROUP 'normal' FROM '${TEST_USER}'@'%';`,
    wgRevokeSql.join(' | ') || JSON.stringify(r.data).slice(0, 160));
  r = await api('PUT', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}`,
    { password: null, roles: curWg.data.roles || [], grants: desiredNoWg, confirm: true });
  check('负载组撤销执行', r.status === 200 && (r.data.results || []).every((x) => x.ok), JSON.stringify(r.data).slice(0, 160));
  r = await api('GET', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/grants`);
  check('负载组撤销后解析无残留', r.status === 200
    && !(r.data.grants || []).some((g) => g.level === 'workload_group'),
    JSON.stringify((r.data.grants || []).map((g) => g.level)).slice(0, 160));
  // 再授予：期望集合加回 workload_group → GRANT
  const desiredWg = desiredNoWg.concat([{ level: 'workload_group', workloadGroup: 'normal', privileges: ['USAGE_PRIV'] }]);
  r = await api('POST', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/preview-update`,
    { password: null, roles: curWg.data.roles || [], grants: desiredWg });
  const wgSql = r.data.sql || [];
  check('负载组授权 diff 预览（GRANT WORKLOAD GROUP）', r.status === 200
    && wgSql.length === 1 && wgSql[0] === `GRANT USAGE_PRIV ON WORKLOAD GROUP 'normal' TO '${TEST_USER}'@'%';`,
    wgSql.join(' | ') || JSON.stringify(r.data).slice(0, 160));
  r = await api('PUT', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}`,
    { password: null, roles: curWg.data.roles || [], grants: desiredWg, confirm: true });
  check('负载组授权执行', r.status === 200 && (r.data.results || []).every((x) => x.ok), JSON.stringify(r.data).slice(0, 160));
  r = await api('GET', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/grants`);
  const wgGrant = (r.data.grants || []).find((g) => g.level === 'workload_group');
  check('负载组授权解析验证', r.status === 200 && !!wgGrant && wgGrant.workloadGroup === 'normal'
    && wgGrant.privileges.includes('USAGE_PRIV'),
    JSON.stringify(wgGrant || r.data).slice(0, 200));

  // 12l. 禁用登录：基线直连成功 → disable → 旧密码直连失败 → 重置密码恢复
  const RESET_PWD = 'Reset#2026xYzAa9';
  let baselineOk = false;
  try {
    const c0 = await mysql.createConnection({ host: dorisHost, port: Number(dorisPort), user: TEST_USER, password: TEST_PWD, connectTimeout: 8000 });
    await c0.end();
    baselineOk = true;
  } catch { baselineOk = false; }
  check('禁用前基线：测试用户可直连 Doris', baselineOk);
  r = await api('POST', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/disable`);
  check('禁用登录接口', r.status === 200 && r.data.ok === true
    && r.data.message === '已禁用登录，密码已随机化。启用请使用「重置密码」'
    && !('password' in r.data), JSON.stringify(r.data).slice(0, 200));
  let oldPwdRejected = false;
  try {
    const c1 = await mysql.createConnection({ host: dorisHost, port: Number(dorisPort), user: TEST_USER, password: TEST_PWD, connectTimeout: 8000 });
    await c1.end();
  } catch { oldPwdRejected = true; }
  check('禁用后旧密码直连 Doris 失败', oldPwdRejected);

  // 12l-b. 禁用状态本地跟踪：users 列表该 host 合并 disabled/disabledAt/disabledBy
  const findTestHost = (list) => {
    const u = (Array.isArray(list) ? list : []).find((x) => x.user === TEST_USER);
    return u ? (u.hosts || []).find((h) => h.host === '%') : null;
  };
  r = await api('GET', `/c/${clusterId}/users`);
  let hostEntry = findTestHost(r.data);
  check('禁用后用户列表标记 disabled=true 且 disabledBy=admin', r.status === 200 && !!hostEntry
    && hostEntry.disabled === true && hostEntry.disabledBy === 'admin'
    && typeof hostEntry.disabledAt === 'string' && hostEntry.disabledAt.length > 0,
    JSON.stringify(hostEntry ? { disabled: hostEntry.disabled, disabledAt: hostEntry.disabledAt, disabledBy: hostEntry.disabledBy } : null));
  const allHostEntries = (Array.isArray(r.data) ? r.data : []).flatMap((u) => u.hosts || []);
  check('用户列表全部 host 条目均含禁用契约字段', allHostEntries.length > 0
    && allHostEntries.every((h) => typeof h.disabled === 'boolean' && 'disabledAt' in h && 'disabledBy' in h),
    `共 ${allHostEntries.length} 个 host 条目`);

  r = await api('POST', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}/password`, { password: RESET_PWD });
  check('重置密码恢复（执行）', r.status === 200 && (r.data.results || []).every((x) => x.ok), JSON.stringify(r.data).slice(0, 160));
  let resetOk = false;
  try {
    const c2 = await mysql.createConnection({ host: dorisHost, port: Number(dorisPort), user: TEST_USER, password: RESET_PWD, connectTimeout: 8000 });
    await c2.end();
    resetOk = true;
  } catch { resetOk = false; }
  check('重置后新密码直连 Doris 成功', resetOk);

  // 12l-c. 改密 = 启用：重置密码后 users 列表该 host disabled=false 且字段清空
  r = await api('GET', `/c/${clusterId}/users`);
  hostEntry = findTestHost(r.data);
  check('重置密码后用户列表 disabled=false 且禁用字段清空', r.status === 200 && !!hostEntry
    && hostEntry.disabled === false && hostEntry.disabledAt === null && hostEntry.disabledBy === null,
    JSON.stringify(hostEntry ? { disabled: hostEntry.disabled, disabledAt: hostEntry.disabledAt, disabledBy: hostEntry.disabledBy } : null));

  // 12m. pubkey + 加密登录（RSA-OAEP/SHA-256 + base64，与前端 Core04 契约一致）
  r = await api('GET', '/auth/pubkey');
  const pub = r.data || {};
  check('获取登录公钥', r.status === 200 && typeof pub.kid === 'string' && String(pub.publicKeyPem || '').startsWith('-----BEGIN PUBLIC KEY-----'),
    `kid=${pub.kid || '(无)'}`);
  const forge = require('node-forge');
  const pubKey = forge.pki.publicKeyFromPem(pub.publicKeyPem);
  const encPwd = forge.util.encode64(pubKey.encrypt(forge.util.encodeUtf8(platformPwd), 'RSA-OAEP', { md: forge.md.sha256.create() }));
  r = await api('POST', '/auth/login', { username: 'admin', passwordEnc: encPwd, kid: pub.kid });
  check('加密登录（RSA-OAEP/SHA-256）', r.status === 200 && !!r.data.token, r.data.user ? JSON.stringify(r.data.user) : JSON.stringify(r.data));
  r = await api('POST', '/auth/login', { username: 'admin', passwordEnc: encPwd, kid: 'wrong-kid' });
  check('错误 kid 拒绝（400 中文错误）', r.status === 400 && r.data.error && /密钥已过期或不匹配/.test(r.data.error.message || ''),
    JSON.stringify(r.data).slice(0, 160));
  r = await api('POST', '/auth/login', { username: 'admin', passwordEnc: '!!!bad-base64!!!', kid: pub.kid });
  check('损坏密文拒绝（400）', r.status === 400 && r.data.error && /解密失败/.test(r.data.error.message || ''),
    JSON.stringify(r.data).slice(0, 160));

  // 12n. 内置账号 root/admin 保护：平台内仅可查看，一切修改返回 403
  // （下列请求均选用"即使保护失效也不产生实际写"的载荷：空 diff / dryRun / 空属性，确保安全）
  const PROTECT_MSG = /内置账号 root\/admin 仅可查看/;
  r = await api('PUT', `/c/${clusterId}/users/admin/${encodeURIComponent('%')}`, { confirm: true });
  check('内置账号保护：PUT 更新 admin@% 返回 403', r.status === 403 && !!r.data.error && PROTECT_MSG.test(r.data.error.message || ''),
    `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await api('POST', `/c/${clusterId}/users/admin/${encodeURIComponent('%')}/preview-update`, { password: null });
  check('内置账号保护：preview-update admin@% 返回 403', r.status === 403 && PROTECT_MSG.test((r.data.error || {}).message || ''),
    `status=${r.status}`);
  r = await api('POST', `/c/${clusterId}/users/root/${encodeURIComponent('%')}/password`, { password: 'Root#NoChange2026', dryRun: true });
  check('内置账号保护：root 改密（含 dryRun）返回 403', r.status === 403 && PROTECT_MSG.test((r.data.error || {}).message || ''),
    `status=${r.status}`);
  r = await api('POST', `/c/${clusterId}/users/admin/${encodeURIComponent('%')}/property/preview`, { properties: { max_user_connections: '200' } });
  check('内置账号保护：属性预览 admin 返回 403', r.status === 403 && PROTECT_MSG.test((r.data.error || {}).message || ''),
    `status=${r.status}`);
  r = await api('PUT', `/c/${clusterId}/users/admin/${encodeURIComponent('%')}/property`, { properties: {}, confirm: true });
  check('内置账号保护：属性更新 admin 返回 403', r.status === 403 && PROTECT_MSG.test((r.data.error || {}).message || ''),
    `status=${r.status}`);
  // SQL 控制台：针对 root/admin 的授权/改密语句被 403 拦截，正常语句放行
  const CONSOLE_MSG = /SQL 控制台不允许操作内置账号 root\/admin/;
  r = await api('POST', `/c/${clusterId}/execute`, { sql: "GRANT SELECT_PRIV ON *.*.* TO 'root'@'%'" });
  check('SQL 控制台拦截 GRANT 到 root（403）', r.status === 403 && !!r.data.error && CONSOLE_MSG.test(r.data.error.message || ''),
    `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await api('POST', `/c/${clusterId}/execute`, { sql: "SET PASSWORD FOR 'admin'@'%' = PASSWORD('NoChange2026')" });
  check('SQL 控制台拦截 SET PASSWORD admin（403）', r.status === 403 && CONSOLE_MSG.test((r.data.error || {}).message || ''),
    `status=${r.status}`);
  r = await api('POST', `/c/${clusterId}/execute`, { sql: 'SELECT 1' });
  check('SQL 控制台正常 SELECT 1 放行（200）', r.status === 200 && r.data.ok === true && r.data.kind === 'result',
    `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  // 控制台对普通测试用户不受影响（与既有流程一致的幂等授权）
  r = await api('POST', `/c/${clusterId}/execute`, { sql: `GRANT SELECT_PRIV ON \`internal\`.\`mysql\`.* TO '${TEST_USER}'@'%'` });
  check('SQL 控制台对普通用户 GRANT 不受影响', r.status === 200 && r.data.ok === true,
    `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

  // 13. 删除测试用户
  r = await api('DELETE', `/c/${clusterId}/users/${TEST_USER}/${encodeURIComponent('%')}`, { confirm: true });
  check('删除测试用户', r.status === 200 && (r.data.results ? r.data.results.every((x) => x.ok) : r.data.ok === true), JSON.stringify(r.data).slice(0, 120));
  let dropped = false;
  try { await conn.query(`SHOW GRANTS FOR '${TEST_USER}'@'%'`); } catch { dropped = true; }
  check('集群侧验证用户已删除', dropped);
  await conn.end();

  // 14. 审计日志（含密码脱敏检查）
  r = await api('GET', '/audit?page=1&size=200');
  const items = r.data.items || [];
  const actions = items.map((x) => x.action);
  check('审计日志已记录', r.status === 200 && items.length > 0 && actions.some((a) => /create|execute|set_property|drop/i.test(a)),
    `共 ${r.data.total} 条，最近动作: ${actions.slice(0, 5).join(',')}`);
  // 脱敏：任何审计 SQL 不得出现明文测试密码；IDENTIFIED BY / PASSWORD() 一律 '***'
  const sqls = items.map((x) => String(x.sql || ''));
  check('审计脱敏：无明文测试密码', !sqls.some((s) => s.includes(TEST_PWD) || s.includes('Reset#2026xYzAa9')),
    `检查 ${sqls.length} 条 SQL`);
  const createSql = sqls.find((s) => s.includes('CREATE USER IF NOT EXISTS'));
  check('审计脱敏：IDENTIFIED BY 打码', !!createSql && createSql.includes("IDENTIFIED BY '***'"),
    (createSql || '(未找到)').slice(0, 160));
  const disableSqls = sqls.filter((s) => s.includes('PASSWORD('));
  check('审计脱敏：PASSWORD() 打码', disableSqls.length > 0 && disableSqls.every((s) => s.includes("PASSWORD('***')")),
    (disableSqls[0] || '(未找到)').slice(0, 160));
  check('审计含禁用登录记录', actions.includes('disable_login'), actions.slice(0, 12).join(','));

  console.log(`\n========== E2E ${failures === 0 ? '全部通过' : `有 ${failures} 项失败`} ==========`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('E2E 中断:', e.message);
  process.exit(2);
});
