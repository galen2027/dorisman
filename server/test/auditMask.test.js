// 审计日志密码脱敏单元测试（node:test + node:assert）
// 覆盖：store.maskSqlSecrets 统一出口 —— IDENTIFIED BY '...' / PASSWORD('...')
// 一律替换为 '***'，写审计与读审计（含历史日志）都经过它
const { test } = require('node:test');
const assert = require('node:assert');
const { maskSqlSecrets } = require('../src/store');

test('IDENTIFIED BY 密码脱敏', () => {
  assert.strictEqual(
    maskSqlSecrets("CREATE USER IF NOT EXISTS 'dev'@'%' IDENTIFIED BY 'Abc123!@#def4567';"),
    "CREATE USER IF NOT EXISTS 'dev'@'%' IDENTIFIED BY '***';"
  );
  assert.strictEqual(
    maskSqlSecrets("ALTER USER 'dev'@'%' IDENTIFIED BY 'NewPwd2026xyZ!';"),
    "ALTER USER 'dev'@'%' IDENTIFIED BY '***';"
  );
});

test('PASSWORD() 密码脱敏', () => {
  assert.strictEqual(
    maskSqlSecrets("SET PASSWORD FOR 'u'@'%' = PASSWORD('Doris#Test2026xY');"),
    "SET PASSWORD FOR 'u'@'%' = PASSWORD('***');"
  );
});

test('大小写不敏感与转义字符兼容', () => {
  // 小写写法
  assert.strictEqual(
    maskSqlSecrets("create user 'u'@'%' identified by 'secret123';"),
    "create user 'u'@'%' identified by '***';"
  );
  // 密码内含转义引号
  assert.strictEqual(
    maskSqlSecrets("SET PASSWORD FOR 'u'@'%' = PASSWORD('it\\'s_secret');"),
    "SET PASSWORD FOR 'u'@'%' = PASSWORD('***');"
  );
});

test('一条语句中多处密码全部脱敏', () => {
  const sql =
    "CREATE USER 'a'@'%' IDENTIFIED BY 'pwd_A_12345678'; SET PASSWORD FOR 'b'@'%' = PASSWORD('pwd_B_12345678');";
  const masked = maskSqlSecrets(sql);
  assert.ok(!masked.includes('pwd_A_12345678'));
  assert.ok(!masked.includes('pwd_B_12345678'));
  assert.strictEqual(masked.match(/\*\*\*/g).length, 2);
});

test('非密码语句原样返回；非字符串输入原样返回', () => {
  assert.strictEqual(
    maskSqlSecrets("GRANT SELECT_PRIV ON `internal`.`db1`.* TO 'u'@'%';"),
    "GRANT SELECT_PRIV ON `internal`.`db1`.* TO 'u'@'%';"
  );
  assert.strictEqual(maskSqlSecrets(null), null);
  assert.strictEqual(maskSqlSecrets(undefined), undefined);
  assert.strictEqual(maskSqlSecrets(''), '');
});

test('PASSWORD( 与其他括号内容不混淆', () => {
  // 不带字符串字面量的 PASSWORD 写法不会被误伤（如 PASSWORD(*) 星号）
  const sql = "SELECT PASSWORD('abc123') FROM t;";
  assert.strictEqual(maskSqlSecrets(sql), "SELECT PASSWORD('***') FROM t;");
});
