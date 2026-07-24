// protect 内置账号保护单元测试（node:test + node:assert）
// 覆盖：isProtectedUser 精确匹配、assertNotProtectedUser 抛 403、
//       checkConsoleSql 命中 4 类模式 + 放行正常语句（含 'rooter' 边界）
const { test } = require('node:test');
const assert = require('node:assert');

const {
  PROTECTED_USERS,
  isProtectedUser,
  assertNotProtectedUser,
  checkConsoleSql,
} = require('../src/protect');

// ---------------------------------------------------------------------------
// PROTECTED_USERS / isProtectedUser
// ---------------------------------------------------------------------------

test('PROTECTED_USERS 恰好包含 root 与 admin', () => {
  assert.deepStrictEqual(PROTECTED_USERS, ['root', 'admin']);
});

test('isProtectedUser 对 root/admin 返回 true', () => {
  assert.strictEqual(isProtectedUser('root'), true);
  assert.strictEqual(isProtectedUser('admin'), true);
});

test('isProtectedUser 精确匹配：大小写、前后缀、普通用户均返回 false', () => {
  assert.strictEqual(isProtectedUser('ROOT'), false, '大小写不同不算精确匹配');
  assert.strictEqual(isProtectedUser('Admin'), false);
  assert.strictEqual(isProtectedUser('rooter'), false);
  assert.strictEqual(isProtectedUser('xadmin'), false);
  assert.strictEqual(isProtectedUser('root '), false);
  assert.strictEqual(isProtectedUser(' rowin'), false);
  assert.strictEqual(isProtectedUser('rowin'), false);
  assert.strictEqual(isProtectedUser(''), false);
  assert.strictEqual(isProtectedUser(undefined), false);
  assert.strictEqual(isProtectedUser(null), false);
  assert.strictEqual(isProtectedUser(123), false);
});

// ---------------------------------------------------------------------------
// assertNotProtectedUser
// ---------------------------------------------------------------------------

test('assertNotProtectedUser 对 root/admin 抛出 status=403 的中文错误', () => {
  for (const u of ['root', 'admin']) {
    assert.throws(
      () => assertNotProtectedUser(u),
      (err) => {
        assert.strictEqual(err.status, 403, 'err.status 必须是 403（兼容 routes.js err.status 分支）');
        assert.ok(
          err.message.includes('内置账号 root/admin 仅可查看，不允许在平台中修改'),
          `message 应含中文提示，实际：${err.message}`
        );
        assert.ok(err.message.includes('直连 Doris 后台'), 'message 应提示可直连后台');
        return true;
      }
    );
  }
});

test('assertNotProtectedUser 对普通用户与非字符串不抛错', () => {
  for (const u of ['rowin', 'dorisman_test', 'rooter', 'Admin', undefined, null]) {
    assert.doesNotThrow(() => assertNotProtectedUser(u), `不应拦截：${String(u)}`);
  }
});

// ---------------------------------------------------------------------------
// checkConsoleSql —— 4 类命中模式
// ---------------------------------------------------------------------------

function assertConsoleBlocked(sql, label) {
  assert.throws(
    () => checkConsoleSql(sql),
    (err) => {
      assert.strictEqual(err.status, 403, `${label}：err.status 必须是 403`);
      assert.ok(
        err.message.includes('SQL 控制台不允许操作内置账号 root/admin'),
        `${label}：message 应含控制台提示，实际：${err.message}`
      );
      assert.ok(err.message.includes('直连 Doris 后台'), `${label}：message 应提示可直连后台`);
      return true;
    },
    `${label} 应被拦截：${sql}`
  );
}

test('checkConsoleSql 拦截 GRANT/REVOKE 针对 root/admin（模式 1）', () => {
  assertConsoleBlocked("GRANT SELECT_PRIV ON *.*.* TO 'root'@'%'", 'GRANT 到 root');
  assertConsoleBlocked('grant select_priv on *.*.* to "admin"@"%"', '小写 GRANT 到 admin（双引号）');
  assertConsoleBlocked("REVOKE SELECT_PRIV ON internal.mysql.* FROM 'admin'@'%'", 'REVOKE 自 admin');
  assertConsoleBlocked("REVOKE 'r1' FROM root@'%'", 'REVOKE 无引号 root');
  assertConsoleBlocked("GRANT 'dev_role' TO ROLE 'root'@'%'", 'GRANT TO ROLE root');
  assertConsoleBlocked("GRANT USAGE_PRIV ON WORKLOAD GROUP 'normal' TO 'admin'@'10.%'", '负载组 GRANT 到 admin');
});

test('checkConsoleSql 拦截 CREATE/ALTER/DROP USER 针对 root/admin（模式 2）', () => {
  assertConsoleBlocked("CREATE USER 'root'@'%' IDENTIFIED BY 'xxx'", 'CREATE USER root');
  assertConsoleBlocked("create user if not exists 'admin'@'%'", '小写 CREATE USER admin');
  assertConsoleBlocked("ALTER USER 'admin'@'%' IDENTIFIED BY 'xxx'", 'ALTER USER admin');
  assertConsoleBlocked("DROP USER root@'localhost'", 'DROP USER 无引号 root');
  assertConsoleBlocked('DROP  USER  IF  EXISTS  "admin"@"%"', 'DROP USER 多空格+双引号 admin');
});

test('checkConsoleSql 拦截 SET PASSWORD FOR root/admin（模式 3）', () => {
  assertConsoleBlocked("SET PASSWORD FOR 'root'@'%' = PASSWORD('xxx')", 'SET PASSWORD root');
  assertConsoleBlocked("set password for admin@'%' = password('xxx')", '小写 SET PASSWORD 无引号 admin');
  assertConsoleBlocked('SET  PASSWORD  FOR  "admin"@"10.%" = PASSWORD(\'x\')', '多空格+双引号 SET PASSWORD');
});

test('checkConsoleSql 拦截 SET PROPERTY FOR root/admin（模式 4，无 @host）', () => {
  assertConsoleBlocked("SET PROPERTY FOR 'root' 'max_user_connections' = '100'", 'SET PROPERTY root');
  assertConsoleBlocked('set property for "admin" "max_user_connections" = "100"', '小写双引号 SET PROPERTY admin');
});

// ---------------------------------------------------------------------------
// checkConsoleSql —— 放行正常语句
// ---------------------------------------------------------------------------

test('checkConsoleSql 放行正常语句', () => {
  const allowed = [
    ['SELECT 1', '普通查询'],
    ["SELECT * FROM mysql.user WHERE User = 'root'", '查询中含 root 字样字符串'],
    ["SHOW GRANTS FOR 'root'@'%'", 'SHOW GRANTS 只读（GRANTS 不算 GRANT）'],
    ["SHOW PROPERTY FOR 'admin'", 'SHOW PROPERTY 只读'],
    ["GRANT SELECT_PRIV ON internal.mysql.* TO 'rowin'@'%'", '对普通用户 rowin 的 GRANT'],
    ["REVOKE LOAD_PRIV ON internal.mysql.* FROM 'rowin'@'%'", '对普通用户的 REVOKE'],
    ["GRANT SELECT_PRIV ON *.*.* TO 'rooter'@'%'", "root 后随其他字符 'rooter' 不误拦（正则边界）"],
    ["GRANT SELECT_PRIV ON *.*.* TO 'adminer'@'%'", "'adminer' 不误拦"],
    ["CREATE USER 'rowin'@'%' IDENTIFIED BY 'xxx'", 'CREATE 普通用户'],
    ["ALTER USER 'rowin'@'%' IDENTIFIED BY 'xxx'", 'ALTER 普通用户'],
    ["DROP USER IF EXISTS 'dorisman_test'@'%'", 'DROP 普通用户'],
    ["SET PASSWORD FOR 'rowin'@'%' = PASSWORD('xxx')", '普通用户改密'],
    ["SET PROPERTY FOR 'rowin' 'max_user_connections' = '100'", '普通用户改属性'],
    ["GRANT 'dev_role' TO 'rowin'@'%'", '授予角色给普通用户'],
    ['CREATE ROLE test_role', 'CREATE ROLE 不含 USER'],
    ["INSERT INTO t VALUES ('root@x')", 'DML 中含 root@ 字样'],
  ];
  for (const [sql, label] of allowed) {
    assert.doesNotThrow(() => checkConsoleSql(sql), `${label} 应放行：${sql}`);
  }
});

test('checkConsoleSql 对非字符串输入容错（空值放行）', () => {
  assert.doesNotThrow(() => checkConsoleSql(undefined));
  assert.doesNotThrow(() => checkConsoleSql(null));
  assert.doesNotThrow(() => checkConsoleSql(''));
});
