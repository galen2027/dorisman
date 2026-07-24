// grantsParser.js 单元测试（node:test + node:assert）
// 覆盖：SPEC 5.5 两种单元格风格 + unparsed 兜底
const { test } = require('node:test');
const assert = require('node:assert');
const { parseShowGrantsRow } = require('../src/grantsParser');

// ---------------------------------------------------------------------------
// 风格 a：目标前缀风格 `internal`.`db1`.*: SELECT_PRIV,LOAD_PRIV
// ---------------------------------------------------------------------------

test('解析 DatabasePrivs 目标前缀风格', () => {
  const row = {
    UserIdentity: "'devuser'@'10.%'",
    Password: '*ABC',
    GlobalPrivs: '',
    CatalogPrivs: '',
    DatabasePrivs: '`internal`.`db1`.*: SELECT_PRIV,LOAD_PRIV; `internal`.`db2`.*: ALTER_PRIV',
    TablePrivs: '',
    ResourcePrivs: '',
    Roles: '`dev_tmp_role`',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.userIdentity, "'devuser'@'10.%'");
  assert.strictEqual(parsed.user, 'devuser');
  assert.strictEqual(parsed.host, '10.%');
  assert.deepStrictEqual(parsed.roles, ['dev_tmp_role']);
  assert.strictEqual(parsed.unparsed.length, 0);
  assert.strictEqual(parsed.grants.length, 2);

  const g1 = parsed.grants[0];
  assert.strictEqual(g1.level, 'database');
  assert.strictEqual(g1.catalog, 'internal');
  assert.strictEqual(g1.database, 'db1');
  assert.strictEqual(g1.table, null);
  assert.deepStrictEqual(g1.privileges, ['SELECT_PRIV', 'LOAD_PRIV']);
  assert.strictEqual(g1.grantOption, false);

  const g2 = parsed.grants[1];
  assert.strictEqual(g2.database, 'db2');
  assert.deepStrictEqual(g2.privileges, ['ALTER_PRIV']);
});

test('解析 CatalogPrivs / TablePrivs / ResourcePrivs', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    CatalogPrivs: '`hive`.*.*: SELECT_PRIV',
    DatabasePrivs: '',
    TablePrivs: '`internal`.`db1`.`t1`: SELECT_PRIV,DROP_PRIV',
    ResourcePrivs: "RESOURCE 'spark_res': USAGE_PRIV",
    Roles: '',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.grants.length, 3);

  const cat = parsed.grants.find((g) => g.level === 'catalog');
  assert.strictEqual(cat.catalog, 'hive');
  assert.deepStrictEqual(cat.privileges, ['SELECT_PRIV']);

  const tbl = parsed.grants.find((g) => g.level === 'table');
  assert.strictEqual(tbl.table, 't1');
  assert.deepStrictEqual(tbl.privileges, ['SELECT_PRIV', 'DROP_PRIV']);

  const res = parsed.grants.find((g) => g.level === 'resource');
  assert.strictEqual(res.resource, 'spark_res');
  assert.deepStrictEqual(res.privileges, ['USAGE_PRIV']);
});

// ---------------------------------------------------------------------------
// 风格 b：布尔风格 SELECT_PRIV: true; DROP_PRIV: false
// ---------------------------------------------------------------------------

test('解析 GlobalPrivs 布尔风格（false 忽略）', () => {
  const row = {
    UserIdentity: "'admin'@'%'",
    GlobalPrivs: 'SELECT_PRIV: true; DROP_PRIV: false; ADMIN_PRIV: true',
    Roles: '',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.grants.length, 1);
  const g = parsed.grants[0];
  assert.strictEqual(g.level, 'global');
  // 保留原始出现顺序（SELECT 在前、ADMIN 在后），false 项被忽略
  assert.deepStrictEqual(g.privileges, ['SELECT_PRIV', 'ADMIN_PRIV']);
});

test('解析 GlobalPrivs 纯逗号列表风格', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    GlobalPrivs: 'SELECT_PRIV,LOAD_PRIV',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.grants.length, 1);
  assert.strictEqual(parsed.grants[0].level, 'global');
  assert.deepStrictEqual(parsed.grants[0].privileges, ['SELECT_PRIV', 'LOAD_PRIV']);
});

// ---------------------------------------------------------------------------
// 全局目标 *.*.*
// ---------------------------------------------------------------------------

test('解析 *.*.* 全局目标', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    GlobalPrivs: '*.*.*: GRANT_PRIV',
  };
  const parsed = parseShowGrantsRow(row);
  const g = parsed.grants.find((x) => x.level === 'global');
  assert.ok(g);
  assert.deepStrictEqual(g.privileges, ['GRANT_PRIV']);
});

// ---------------------------------------------------------------------------
// unparsed 兜底：无法解析的单元格不抛异常
// ---------------------------------------------------------------------------

test('无法解析的单元格进 unparsed，不抛异常', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    DatabasePrivs: '%%% 这是一段无法解析的内容 %%%',
    TablePrivs: '`internal`.`db1`.`t1`: SELECT_PRIV', // 正常项不受影响
    ColPrivs: '%%% 不建模列的奇怪内容 %%%', // 不建模的列非空 → unparsed
  };
  const parsed = parseShowGrantsRow(row);
  // 正常解析的表级授权仍在
  assert.strictEqual(parsed.grants.length, 1);
  assert.strictEqual(parsed.grants[0].level, 'table');
  // 两段无法解析的内容都进了 unparsed
  const fields = parsed.unparsed.map((u) => u.field);
  assert.ok(fields.includes('DatabasePrivs'));
  assert.ok(fields.includes('ColPrivs'));
});

test('异常输入不抛异常', () => {
  assert.doesNotThrow(() => parseShowGrantsRow(null));
  assert.doesNotThrow(() => parseShowGrantsRow(undefined));
  assert.doesNotThrow(() => parseShowGrantsRow({}));
  assert.doesNotThrow(() => parseShowGrantsRow('garbage'));
  const parsed = parseShowGrantsRow(null);
  assert.deepStrictEqual(parsed.grants, []);
  assert.deepStrictEqual(parsed.roles, []);
});

// ---------------------------------------------------------------------------
// 列名大小写差异容错
// ---------------------------------------------------------------------------

test('列名大小写不敏感', () => {
  const row = {
    useridentity: "'u'@'%'",
    globalprivs: 'SELECT_PRIV',
    roles: 'r1, `r2`',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.user, 'u');
  assert.strictEqual(parsed.grants.length, 1);
  assert.deepStrictEqual(parsed.roles, ['r1', 'r2']);
});

// ---------------------------------------------------------------------------
// Roles 列的多种写法
// ---------------------------------------------------------------------------

test('Roles 列：反引号 / 引号 / 裸名混写', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    Roles: "`role_a`,'role_b',role_c",
  };
  const parsed = parseShowGrantsRow(row);
  assert.deepStrictEqual(parsed.roles, ['role_a', 'role_b', 'role_c']);
});

// ---------------------------------------------------------------------------
// UserIdentity 解析
// ---------------------------------------------------------------------------

test('UserIdentity 解析 user 与 host', () => {
  const row = { UserIdentity: "'devuser'@'172.16.%'" };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.user, 'devuser');
  assert.strictEqual(parsed.host, '172.16.%');
});

// ---------------------------------------------------------------------------
// 真机样例（server/tools/probe-result.json，Doris 3.x/4.x 实际返回）
// 真实特征：无反引号两段式目标、大小写混合权限名、Password 列 Yes/No、
// null 单元格、裸角色名、WorkloadGroupPrivs 解析为 workload_group 授权项
// ---------------------------------------------------------------------------

test('真机 all_grants：root 行完整解析', () => {
  const row = {
    UserIdentity: "'root'@'%'",
    Comment: 'ROOT',
    Password: 'Yes',
    Roles: 'operator',
    GlobalPrivs: 'Node_priv,Admin_priv',
    CatalogPrivs: null,
    DatabasePrivs: 'internal.information_schema: Select_priv; internal.mysql: Select_priv',
    TablePrivs: null,
    ColPrivs: null,
    ResourcePrivs: null,
    CloudClusterPrivs: null,
    CloudStagePrivs: null,
    StorageVaultPrivs: null,
    WorkloadGroupPrivs: 'normal: Usage_priv',
    ComputeGroupPrivs: null,
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.user, 'root');
  assert.strictEqual(parsed.host, '%');
  assert.deepStrictEqual(parsed.roles, ['operator']);

  // 全局权限：Node_priv/Admin_priv 归一化为大写
  const g = parsed.grants.find((x) => x.level === 'global');
  assert.ok(g);
  assert.deepStrictEqual(g.privileges, ['NODE_PRIV', 'ADMIN_PRIV']);

  // 两段式裸目标：catalog.db（无反引号、无 .* 后缀）
  const dbs = parsed.grants.filter((x) => x.level === 'database');
  assert.strictEqual(dbs.length, 2);
  assert.strictEqual(dbs[0].catalog, 'internal');
  assert.strictEqual(dbs[0].database, 'information_schema');
  assert.deepStrictEqual(dbs[0].privileges, ['SELECT_PRIV']);
  assert.strictEqual(dbs[1].database, 'mysql');

  // WorkloadGroupPrivs 解析为 workload_group 授权项（不再进 unparsed）
  const wg = parsed.grants.find((x) => x.level === 'workload_group');
  assert.ok(wg);
  assert.strictEqual(wg.workloadGroup, 'normal');
  assert.deepStrictEqual(wg.privileges, ['USAGE_PRIV']);
  assert.strictEqual(parsed.grants.length, 4);
  assert.strictEqual(parsed.unparsed.length, 0);
});

test('真机 all_grants：admin 行完整解析', () => {
  const row = {
    UserIdentity: "'admin'@'%'",
    Comment: 'ADMIN',
    Password: 'Yes',
    Roles: 'admin',
    GlobalPrivs: 'Admin_priv',
    CatalogPrivs: null,
    DatabasePrivs: 'internal.information_schema: Select_priv; internal.mysql: Select_priv',
    TablePrivs: null,
    ColPrivs: null,
    ResourcePrivs: null,
    CloudClusterPrivs: null,
    CloudStagePrivs: null,
    StorageVaultPrivs: null,
    WorkloadGroupPrivs: 'normal: Usage_priv',
    ComputeGroupPrivs: null,
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.user, 'admin');
  assert.deepStrictEqual(parsed.roles, ['admin']);
  const g = parsed.grants.find((x) => x.level === 'global');
  assert.deepStrictEqual(g.privileges, ['ADMIN_PRIV']);
  assert.strictEqual(parsed.grants.filter((x) => x.level === 'database').length, 2);
  const wg = parsed.grants.find((x) => x.level === 'workload_group');
  assert.ok(wg);
  assert.strictEqual(wg.workloadGroup, 'normal');
  assert.deepStrictEqual(wg.privileges, ['USAGE_PRIV']);
});

test('真机 roles：SHOW ROLES 行（无 UserIdentity，Name 列）', () => {
  const adminRole = {
    Name: 'admin',
    Comment: null,
    Users: "'admin'@'%'",
    GlobalPrivs: 'Admin_priv',
    DatabasePrivs: null,
  };
  const parsed1 = parseShowGrantsRow(adminRole);
  assert.strictEqual(parsed1.user, null); // 无 UserIdentity 列
  assert.strictEqual(parsed1.grants.length, 1);
  assert.strictEqual(parsed1.grants[0].level, 'global');
  assert.deepStrictEqual(parsed1.grants[0].privileges, ['ADMIN_PRIV']);

  const operatorRole = {
    Name: 'operator',
    Comment: null,
    Users: "'root'@'%'",
    GlobalPrivs: 'Node_priv,Admin_priv',
    DatabasePrivs: null,
  };
  const parsed2 = parseShowGrantsRow(operatorRole);
  assert.deepStrictEqual(parsed2.grants[0].privileges, ['NODE_PRIV', 'ADMIN_PRIV']);
});

test('真机裸路径：TablePrivs 三段式与 CatalogPrivs 单段', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    CatalogPrivs: 'hive: Select_priv',
    TablePrivs: 'internal.db1.t1: Select_priv,Load_priv; db2.t2: Alter_priv',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.unparsed.length, 0);

  const cat = parsed.grants.find((g) => g.level === 'catalog');
  assert.strictEqual(cat.catalog, 'hive');
  assert.deepStrictEqual(cat.privileges, ['SELECT_PRIV']);

  const tables = parsed.grants.filter((g) => g.level === 'table');
  assert.strictEqual(tables.length, 2);
  assert.strictEqual(tables[0].catalog, 'internal');
  assert.strictEqual(tables[0].database, 'db1');
  assert.strictEqual(tables[0].table, 't1');
  assert.deepStrictEqual(tables[0].privileges, ['SELECT_PRIV', 'LOAD_PRIV']);
  // 两段式表层级：无 catalog 段
  assert.strictEqual(tables[1].catalog, null);
  assert.strictEqual(tables[1].database, 'db2');
  assert.strictEqual(tables[1].table, 't2');
});

test('真机不解析列：ColPrivs / CloudClusterPrivs / CloudStagePrivs 透传 unparsed', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    DatabasePrivs: 'internal.db1: Select_priv',
    ColPrivs: 'internal.db1.t1.c1: Select_priv',
    CloudClusterPrivs: 'cluster1: Usage_priv',
    CloudStagePrivs: 'stage1: Usage_priv',
  };
  const parsed = parseShowGrantsRow(row);
  // 正常授权项不受影响
  assert.strictEqual(parsed.grants.length, 1);
  assert.strictEqual(parsed.grants[0].level, 'database');
  // 三个不建模列全部进 unparsed
  const fields = parsed.unparsed.map((u) => u.field);
  assert.ok(fields.includes('ColPrivs'));
  assert.ok(fields.includes('CloudClusterPrivs'));
  assert.ok(fields.includes('CloudStagePrivs'));
});

test('真机格式与 SPEC 反引号格式混排均兼容', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    DatabasePrivs: '`internal`.`db1`.*: SELECT_PRIV; internal.db2: Select_priv',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.unparsed.length, 0);
  assert.strictEqual(parsed.grants.length, 2);
  assert.strictEqual(parsed.grants[0].database, 'db1');
  assert.strictEqual(parsed.grants[1].database, 'db2');
  assert.deepStrictEqual(parsed.grants[1].privileges, ['SELECT_PRIV']);
});

// ---------------------------------------------------------------------------
// 命名对象权限列：WorkloadGroupPrivs / ComputeGroupPrivs / StorageVaultPrivs
// 真机 Doris 3.0.6 已验证格式 `normal: Usage_priv`
// ---------------------------------------------------------------------------

test('WorkloadGroupPrivs 解析为 workload_group 授权项', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    WorkloadGroupPrivs: 'normal: Usage_priv',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.unparsed.length, 0);
  assert.strictEqual(parsed.grants.length, 1);
  const g = parsed.grants[0];
  assert.strictEqual(g.level, 'workload_group');
  assert.strictEqual(g.workloadGroup, 'normal');
  assert.deepStrictEqual(g.privileges, ['USAGE_PRIV']);
  assert.strictEqual(g.grantOption, false);
  // 其他目标字段为 null
  assert.strictEqual(g.catalog, null);
  assert.strictEqual(g.database, null);
  assert.strictEqual(g.table, null);
  assert.strictEqual(g.resource, null);
});

test('ComputeGroupPrivs / StorageVaultPrivs 解析为对应层级', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    ComputeGroupPrivs: 'cg_hot: Usage_priv',
    StorageVaultPrivs: 'sv_s3: Usage_priv',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.unparsed.length, 0);
  const cg = parsed.grants.find((g) => g.level === 'compute_group');
  assert.ok(cg);
  assert.strictEqual(cg.computeGroup, 'cg_hot');
  assert.deepStrictEqual(cg.privileges, ['USAGE_PRIV']);
  const sv = parsed.grants.find((g) => g.level === 'storage_vault');
  assert.ok(sv);
  assert.strictEqual(sv.storageVault, 'sv_s3');
  assert.deepStrictEqual(sv.privileges, ['USAGE_PRIV']);
});

test('命名对象列：多段与引号包裹的名字', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    WorkloadGroupPrivs: "normal: Usage_priv; 'etl group': Usage_priv",
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.unparsed.length, 0);
  assert.strictEqual(parsed.grants.length, 2);
  assert.strictEqual(parsed.grants[0].workloadGroup, 'normal');
  assert.strictEqual(parsed.grants[1].workloadGroup, 'etl group');
});

test('命名对象列：畸形段进 unparsed，正常段不受影响', () => {
  const row = {
    UserIdentity: "'u'@'%'",
    WorkloadGroupPrivs: 'normal: Usage_priv; 没有冒号的段',
    ComputeGroupPrivs: null,
    StorageVaultPrivs: '',
  };
  const parsed = parseShowGrantsRow(row);
  assert.strictEqual(parsed.grants.length, 1);
  assert.strictEqual(parsed.grants[0].workloadGroup, 'normal');
  assert.strictEqual(parsed.unparsed.length, 1);
  assert.strictEqual(parsed.unparsed[0].field, 'WorkloadGroupPrivs');
  assert.strictEqual(parsed.unparsed[0].value, '没有冒号的段');
});
