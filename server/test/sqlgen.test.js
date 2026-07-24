// sqlgen.js 单元测试（node:test + node:assert）
// 覆盖：SQL 生成（多 host 展开、diff 增删、角色、转义）与注入拦截
const { test } = require('node:test');
const assert = require('node:assert');
const sqlgen = require('../src/sqlgen');

// ---------------------------------------------------------------------------
// 转义
// ---------------------------------------------------------------------------

test('quoteIdent：反引号转义为双反引号', () => {
  assert.strictEqual(sqlgen.quoteIdent('db1'), '`db1`');
  assert.strictEqual(sqlgen.quoteIdent('a`b'), '`a``b`');
});

test('quoteString：单引号与反斜杠转义', () => {
  assert.strictEqual(sqlgen.quoteString('abc'), "'abc'");
  assert.strictEqual(sqlgen.quoteString("a'b"), "'a\\'b'");
  assert.strictEqual(sqlgen.quoteString('a\\b'), "'a\\\\b'");
  assert.strictEqual(sqlgen.quoteString("a\\'b"), "'a\\\\\\'b'");
});

// ---------------------------------------------------------------------------
// ON 目标生成（SPEC 5.2）
// ---------------------------------------------------------------------------

test('onTarget：五种层级', () => {
  assert.strictEqual(sqlgen.onTarget({ level: 'global' }), '*.*.*');
  assert.strictEqual(sqlgen.onTarget({ level: 'catalog', catalog: 'internal' }), '`internal`.*.*');
  assert.strictEqual(
    sqlgen.onTarget({ level: 'database', catalog: 'internal', database: 'db1' }),
    '`internal`.`db1`.*'
  );
  assert.strictEqual(
    sqlgen.onTarget({ level: 'table', catalog: 'internal', database: 'db1', table: 't1' }),
    '`internal`.`db1`.`t1`'
  );
  assert.strictEqual(sqlgen.onTarget({ level: 'resource', resource: '*' }), "RESOURCE '*'");
  assert.strictEqual(sqlgen.onTarget({ level: 'resource', resource: 'my_res' }), "RESOURCE 'my_res'");
});

// ---------------------------------------------------------------------------
// 创建用户（多 host 展开）
// ---------------------------------------------------------------------------

test('buildCreateUserSql：多 host 展开 + 授权 + 角色', () => {
  const sql = sqlgen.buildCreateUserSql({
    user: 'devuser',
    hosts: ['10.%', '172.16.%'],
    password: 'Abc123!@#def4567',
    roles: ['dev_tmp_role'],
    grants: [
      {
        level: 'database',
        catalog: 'internal',
        database: 'TMP',
        table: null,
        privileges: ['SELECT_PRIV', 'LOAD_PRIV'],
        grantOption: false,
      },
    ],
  });
  assert.deepStrictEqual(sql, [
    "CREATE USER IF NOT EXISTS 'devuser'@'10.%' IDENTIFIED BY 'Abc123!@#def4567';",
    "CREATE USER IF NOT EXISTS 'devuser'@'172.16.%' IDENTIFIED BY 'Abc123!@#def4567';",
    'GRANT LOAD_PRIV, SELECT_PRIV ON `internal`.`TMP`.* TO \'devuser\'@\'10.%\';',
    'GRANT LOAD_PRIV, SELECT_PRIV ON `internal`.`TMP`.* TO \'devuser\'@\'172.16.%\';',
    "GRANT 'dev_tmp_role' TO 'devuser'@'10.%';",
    "GRANT 'dev_tmp_role' TO 'devuser'@'172.16.%';",
  ]);
});

test('buildCreateUserSql：WITH GRANT OPTION 与全局层级', () => {
  const sql = sqlgen.buildCreateUserSql({
    user: 'ops',
    hosts: ['%'],
    password: 'x',
    roles: [],
    grants: [
      { level: 'global', privileges: ['SELECT_PRIV'], grantOption: true },
    ],
  });
  assert.deepStrictEqual(sql, [
    "CREATE USER IF NOT EXISTS 'ops'@'%' IDENTIFIED BY 'x';",
    "GRANT SELECT_PRIV ON *.*.* TO 'ops'@'%' WITH GRANT OPTION;",
  ]);
});

test('buildCreateUserSql：resource 层级仅允许 USAGE_PRIV', () => {
  const sql = sqlgen.buildCreateUserSql({
    user: 'etl',
    hosts: ['%'],
    password: 'x',
    roles: [],
    grants: [{ level: 'resource', resource: 'spark_res', privileges: ['USAGE_PRIV'] }],
  });
  assert.strictEqual(sql[1], "GRANT USAGE_PRIV ON RESOURCE 'spark_res' TO 'etl'@'%';");
  // USAGE_PRIV 之外的权限必须报错
  assert.throws(
    () =>
      sqlgen.buildCreateUserSql({
        user: 'etl',
        hosts: ['%'],
        password: 'x',
        grants: [{ level: 'resource', resource: 'r1', privileges: ['SELECT_PRIV'] }],
      }),
    /不适用于 resource 层级/
  );
});

// ---------------------------------------------------------------------------
// 注入拦截（防注入第一关）
// ---------------------------------------------------------------------------

test('注入拦截：用户名/host/库表名含非法字符直接报错', () => {
  // 用户名注入
  assert.throws(
    () =>
      sqlgen.buildCreateUserSql({
        user: "dev' OR '1'='1",
        hosts: ['%'],
        password: 'x',
      }),
    /非法字符/
  );
  // host 注入
  assert.throws(
    () =>
      sqlgen.buildCreateUserSql({
        user: 'dev',
        hosts: ["%'; DROP USER 'a'@'b'; --"],
        password: 'x',
      }),
    /非法字符/
  );
  // 库名注入（反引号闭合尝试）
  assert.throws(
    () =>
      sqlgen.buildCreateUserSql({
        user: 'dev',
        hosts: ['%'],
        password: 'x',
        grants: [
          { level: 'database', catalog: 'internal', database: 'db`; DROP TABLE x; --', privileges: ['SELECT_PRIV'] },
        ],
      }),
    /非法字符/
  );
  // 角色名注入
  assert.throws(
    () => sqlgen.buildDropRoleSql("r'; DROP ROLE 'x"),
    /非法字符/
  );
});

test('层级权限校验：ADMIN_PRIV 仅全局、USAGE_PRIV 仅 resource', () => {
  assert.throws(
    () =>
      sqlgen.buildCreateUserSql({
        user: 'dev',
        hosts: ['%'],
        password: 'x',
        grants: [{ level: 'database', catalog: 'internal', database: 'd1', privileges: ['ADMIN_PRIV'] }],
      }),
    /不适用于 database 层级/
  );
  // 全局可以用 ADMIN_PRIV
  const sql = sqlgen.buildCreateUserSql({
    user: 'sa',
    hosts: ['%'],
    password: 'x',
    grants: [{ level: 'global', privileges: ['ADMIN_PRIV'] }],
  });
  assert.strictEqual(sql[1], "GRANT ADMIN_PRIV ON *.*.* TO 'sa'@'%';");
});

// ---------------------------------------------------------------------------
// 更新授权 diff
// ---------------------------------------------------------------------------

test('buildUpdateUserSql：权限增删 + 角色增删 + 改密', () => {
  const current = {
    roles: ['old_role', 'keep_role'],
    grants: [
      {
        level: 'database',
        catalog: 'internal',
        database: 'db1',
        table: null,
        privileges: ['SELECT_PRIV', 'LOAD_PRIV'],
        grantOption: false,
      },
      {
        level: 'table',
        catalog: 'internal',
        database: 'db1',
        table: 't_old',
        privileges: ['SELECT_PRIV'],
        grantOption: false,
      },
    ],
  };
  const desired = {
    roles: ['keep_role', 'new_role'],
    grants: [
      {
        // db1：增加 ALTER_PRIV，去掉 LOAD_PRIV
        level: 'database',
        catalog: 'internal',
        database: 'db1',
        table: null,
        privileges: ['SELECT_PRIV', 'ALTER_PRIV'],
        grantOption: false,
      },
      {
        // 新增 catalog 层级授权
        level: 'catalog',
        catalog: 'hive',
        privileges: ['SELECT_PRIV'],
        grantOption: false,
      },
      // t_old 整条移除 → 应生成 REVOKE
    ],
  };
  const sql = sqlgen.buildUpdateUserSql({
    user: 'devuser',
    host: '10.%',
    current,
    desired,
    password: 'NewPass123!@#abc',
  });
  assert.deepStrictEqual(sql, [
    "GRANT ALTER_PRIV ON `internal`.`db1`.* TO 'devuser'@'10.%';",
    "GRANT SELECT_PRIV ON `hive`.*.* TO 'devuser'@'10.%';",
    "REVOKE LOAD_PRIV ON `internal`.`db1`.* FROM 'devuser'@'10.%';",
    "REVOKE SELECT_PRIV ON `internal`.`db1`.`t_old` FROM 'devuser'@'10.%';",
    "GRANT 'new_role' TO 'devuser'@'10.%';",
    "REVOKE 'old_role' FROM 'devuser'@'10.%';",
    "SET PASSWORD FOR 'devuser'@'10.%' = PASSWORD('NewPass123!@#abc');",
  ]);
});

test('buildUpdateUserSql：无变更返回空数组', () => {
  const current = {
    roles: ['r1'],
    grants: [
      {
        level: 'database',
        catalog: 'internal',
        database: 'db1',
        table: null,
        privileges: ['SELECT_PRIV'],
        grantOption: false,
      },
    ],
  };
  const sql = sqlgen.buildUpdateUserSql({
    user: 'u',
    host: '%',
    current,
    desired: {
      roles: ['r1'],
      grants: [
        { level: 'database', catalog: 'internal', database: 'db1', privileges: ['SELECT_PRIV'] },
      ],
    },
    password: null,
  });
  assert.deepStrictEqual(sql, []);
});

test('buildUpdateUserSql：grantOption 变化补齐授权', () => {
  const current = {
    roles: [],
    grants: [
      { level: 'global', privileges: ['SELECT_PRIV'], grantOption: false },
    ],
  };
  const desired = {
    roles: [],
    grants: [{ level: 'global', privileges: ['SELECT_PRIV'], grantOption: true }],
  };
  const sql = sqlgen.buildUpdateUserSql({ user: 'u', host: '%', current, desired });
  assert.deepStrictEqual(sql, ["GRANT SELECT_PRIV ON *.*.* TO 'u'@'%' WITH GRANT OPTION;"]);
});

// ---------------------------------------------------------------------------
// 删除用户 / 修改密码
// ---------------------------------------------------------------------------

test('buildDropUserSql / buildChangePasswordSql', () => {
  assert.deepStrictEqual(sqlgen.buildDropUserSql('dev', '10.%'), [
    "DROP USER IF EXISTS 'dev'@'10.%';",
  ]);
  assert.deepStrictEqual(sqlgen.buildChangePasswordSql('dev', '%', 'P@ss1234'), [
    "SET PASSWORD FOR 'dev'@'%' = PASSWORD('P@ss1234');",
  ]);
});

// ---------------------------------------------------------------------------
// 角色 CRUD
// ---------------------------------------------------------------------------

test('buildCreateRoleSql：创建角色 + 授权', () => {
  const sql = sqlgen.buildCreateRoleSql({
    role: 'analyst',
    comment: '分析师只读',
    grants: [
      { level: 'database', catalog: 'internal', database: 'report', privileges: ['SELECT_PRIV'] },
    ],
  });
  assert.deepStrictEqual(sql, [
    "CREATE ROLE IF NOT EXISTS analyst COMMENT '分析师只读';",
    "GRANT SELECT_PRIV ON `internal`.`report`.* TO ROLE 'analyst';",
  ]);
});

test('buildCreateRoleSql / buildDropRoleSql：角色名严格标识符校验（注入防线）', () => {
  // 数字开头、含 . % - 空格、引号注入全部拒绝（CREATE/DROP ROLE 用裸标识符，不能靠引号兜底）
  for (const bad of ['1role', 'my-role', 'my.role', 'my role', "r'; DROP ROLE 'x", 'role%', '']) {
    assert.throws(() => sqlgen.buildCreateRoleSql({ role: bad }), /非法字符|不能为空/, `应拒绝：${bad}`);
    assert.throws(() => sqlgen.buildDropRoleSql(bad), /非法字符|不能为空/, `应拒绝：${bad}`);
  }
  // 合法标识符（含 _ $）放行
  assert.deepStrictEqual(sqlgen.buildCreateRoleSql({ role: 'r_1$ok', comment: '' }), [
    "CREATE ROLE IF NOT EXISTS r_1$ok COMMENT '';",
  ]);
});

test('buildUpdateRoleSql：diff 增删', () => {
  const current = [
    { level: 'global', privileges: ['SELECT_PRIV', 'LOAD_PRIV'], grantOption: false },
  ];
  const desired = [{ level: 'global', privileges: ['SELECT_PRIV'] }];
  const sql = sqlgen.buildUpdateRoleSql({ role: 'r1', current, desired });
  assert.deepStrictEqual(sql, ["REVOKE LOAD_PRIV ON *.*.* FROM ROLE 'r1';"]);
});

test('buildDropRoleSql', () => {
  assert.deepStrictEqual(sqlgen.buildDropRoleSql('analyst'), ["DROP ROLE IF EXISTS analyst;"]);
});

// ---------------------------------------------------------------------------
// 密码中的特殊字符转义（SQL 字符串）
// ---------------------------------------------------------------------------

test('密码含引号/反斜杠时被正确转义', () => {
  const sql = sqlgen.buildChangePasswordSql('dev', '%', "a'b\\c");
  assert.deepStrictEqual(sql, ["SET PASSWORD FOR 'dev'@'%' = PASSWORD('a\\'b\\\\c');"]);
});

// ---------------------------------------------------------------------------
// 用户属性（SET PROPERTY，真机仅支持按用户名）
// ---------------------------------------------------------------------------

test('buildSetPropertySql：一键一条语句', () => {
  const sql = sqlgen.buildSetPropertySql('devuser', {
    cpu_resource_limit: '8',
    max_user_connections: 100,
  });
  assert.deepStrictEqual(sql, [
    "SET PROPERTY FOR 'devuser' 'cpu_resource_limit' = '8';",
    "SET PROPERTY FOR 'devuser' 'max_user_connections' = '100';",
  ]);
});

test('buildSetPropertySql：空集合返回空数组，null/undefined 值跳过', () => {
  assert.deepStrictEqual(sqlgen.buildSetPropertySql('devuser', {}), []);
  assert.deepStrictEqual(
    sqlgen.buildSetPropertySql('devuser', { a: null, b: undefined }),
    []
  );
});

test('buildSetPropertySql：值中的引号/反斜杠被转义', () => {
  const sql = sqlgen.buildSetPropertySql('devuser', { note: "it's \\ ok" });
  assert.deepStrictEqual(sql, ["SET PROPERTY FOR 'devuser' 'note' = 'it\\'s \\\\ ok';"]);
});

test('buildSetPropertySql：非法键名/用户名直接抛错（防注入）', () => {
  assert.throws(() => sqlgen.buildSetPropertySql('devuser', { "k'; DROP TABLE x--": '1' }));
  assert.throws(() => sqlgen.buildSetPropertySql('devuser', { '1bad': '1' }));
  assert.throws(() => sqlgen.buildSetPropertySql('devuser', { '': '1' }));
  assert.throws(() => sqlgen.buildSetPropertySql("bad'user", { ok_key: '1' }));
  assert.throws(() => sqlgen.buildSetPropertySql('devuser', ['not-object']));
});

// ---------------------------------------------------------------------------
// 负载组（WORKLOAD GROUP）授权
// 真机 Doris 3.0.6 已验证：GRANT USAGE_PRIV ON WORKLOAD GROUP 'normal' TO 'u'@'h'
// ---------------------------------------------------------------------------

test('onTarget：workload_group 层级', () => {
  assert.strictEqual(
    sqlgen.onTarget({ level: 'workload_group', workloadGroup: 'normal' }),
    "WORKLOAD GROUP 'normal'"
  );
});

test('buildCreateUserSql：负载组授权生成', () => {
  const sql = sqlgen.buildCreateUserSql({
    user: 'etl',
    hosts: ['%'],
    password: 'x',
    grants: [{ level: 'workload_group', workloadGroup: 'normal', privileges: ['USAGE_PRIV'] }],
  });
  assert.deepStrictEqual(sql, [
    "CREATE USER IF NOT EXISTS 'etl'@'%' IDENTIFIED BY 'x';",
    "GRANT USAGE_PRIV ON WORKLOAD GROUP 'normal' TO 'etl'@'%';",
  ]);
});

test('负载组授权：仅允许 USAGE_PRIV，其他权限报错', () => {
  assert.throws(
    () =>
      sqlgen.normalizeGrant({
        level: 'workload_group',
        workloadGroup: 'normal',
        privileges: ['SELECT_PRIV'],
      }),
    /不适用于 workload_group 层级/
  );
  // 负载组名安全字符校验（防注入）
  assert.throws(
    () =>
      sqlgen.normalizeGrant({
        level: 'workload_group',
        workloadGroup: "n'; DROP USER 'a'@'b'; --",
        privileges: ['USAGE_PRIV'],
      }),
    /非法字符/
  );
  // WITH GRANT OPTION 未验证，拒绝
  assert.throws(
    () =>
      sqlgen.normalizeGrant({
        level: 'workload_group',
        workloadGroup: 'normal',
        privileges: ['USAGE_PRIV'],
        grantOption: true,
      }),
    /WITH GRANT OPTION/
  );
});

test('buildUpdateUserSql：负载组授权 diff（新增/撤销）', () => {
  // 新增：当前无 → GRANT
  let sql = sqlgen.buildUpdateUserSql({
    user: 'u',
    host: '%',
    current: { roles: [], grants: [] },
    desired: {
      roles: [],
      grants: [{ level: 'workload_group', workloadGroup: 'normal', privileges: ['USAGE_PRIV'] }],
    },
  });
  assert.deepStrictEqual(sql, ["GRANT USAGE_PRIV ON WORKLOAD GROUP 'normal' TO 'u'@'%';"]);

  // 撤销：期望无 → REVOKE（diff key 含 level + 名字）
  sql = sqlgen.buildUpdateUserSql({
    user: 'u',
    host: '%',
    current: {
      roles: [],
      grants: [{ level: 'workload_group', workloadGroup: 'normal', privileges: ['USAGE_PRIV'] }],
    },
    desired: { roles: [], grants: [] },
  });
  assert.deepStrictEqual(sql, ["REVOKE USAGE_PRIV ON WORKLOAD GROUP 'normal' FROM 'u'@'%';"]);

  // 无变更 → 空数组
  sql = sqlgen.buildUpdateUserSql({
    user: 'u',
    host: '%',
    current: {
      roles: [],
      grants: [{ level: 'workload_group', workloadGroup: 'normal', privileges: ['USAGE_PRIV'] }],
    },
    desired: {
      roles: [],
      grants: [{ level: 'workload_group', workloadGroup: 'normal', privileges: ['USAGE_PRIV'] }],
    },
  });
  assert.deepStrictEqual(sql, []);
});

test('只读层级（compute_group/storage_vault）：期望集合报错，当前集合忽略', () => {
  // 编辑器不支持 → 提交到期望集合直接报错
  assert.throws(
    () =>
      sqlgen.buildUpdateUserSql({
        user: 'u',
        host: '%',
        current: { roles: [], grants: [] },
        desired: {
          roles: [],
          grants: [{ level: 'compute_group', computeGroup: 'cg1', privileges: ['USAGE_PRIV'] }],
        },
      }),
    /暂不支持在编辑器中修改/
  );
  // 当前集合含只读层级时静默忽略（不生成任何 SQL，不影响其他 diff）
  const sql = sqlgen.buildUpdateUserSql({
    user: 'u',
    host: '%',
    current: {
      roles: [],
      grants: [
        { level: 'compute_group', computeGroup: 'cg1', privileges: ['USAGE_PRIV'] },
        { level: 'storage_vault', storageVault: 'sv1', privileges: ['USAGE_PRIV'] },
      ],
    },
    desired: { roles: [], grants: [] },
  });
  assert.deepStrictEqual(sql, []);
});
