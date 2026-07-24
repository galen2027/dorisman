// password.js 单元测试（node:test + node:assert）
// 覆盖：16 位 / 字符类别 / 不含引号反斜杠 / 平台账号密码规则
const { test } = require('node:test');
const assert = require('node:assert');
const {
  generatePassword,
  isStrongPassword,
  isValidAccountPassword,
  SPECIAL,
  PASSWORD_LENGTH,
} = require('../src/password');

test('生成的密码为 16 位且包含四种字符类别', () => {
  // 多次生成降低随机性漏检风险
  for (let i = 0; i < 200; i++) {
    const pwd = generatePassword();
    assert.strictEqual(pwd.length, PASSWORD_LENGTH, '长度必须为 16');
    assert.ok(/[A-Z]/.test(pwd), '必须含大写字母');
    assert.ok(/[a-z]/.test(pwd), '必须含小写字母');
    assert.ok(/[0-9]/.test(pwd), '必须含数字');
    assert.ok(
      pwd.split('').some((c) => SPECIAL.includes(c)),
      '必须含特殊字符'
    );
    assert.ok(isStrongPassword(pwd), 'isStrongPassword 自检必须通过');
  }
});

test('生成的密码不含引号、反斜杠等危险字符', () => {
  for (let i = 0; i < 200; i++) {
    const pwd = generatePassword();
    assert.ok(!pwd.includes("'"), '不含单引号');
    assert.ok(!pwd.includes('"'), '不含双引号');
    assert.ok(!pwd.includes('\\'), '不含反斜杠');
    assert.ok(!pwd.includes('`'), '不含反引号');
    assert.ok(!/\s/.test(pwd), '不含空白字符');
  }
});

test('两次生成的密码不同（随机性）', () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.notStrictEqual(a, b);
});

test('isStrongPassword 拒绝不合规密码', () => {
  assert.strictEqual(isStrongPassword('short'), false); // 太短
  assert.strictEqual(isStrongPassword('alllowercase123!!'), false); // 无大写
  assert.strictEqual(isStrongPassword('ALLUPPERCASE123!!'), false); // 无小写
  assert.strictEqual(isStrongPassword('NoDigitsHere!!AB'), false); // 无数字
  assert.strictEqual(isStrongPassword('NoSpecial123abcd'), false); // 无特殊字符
  assert.strictEqual(isStrongPassword("Has'quote123!A"), false); // 含非法字符
});

test('isValidAccountPassword：平台账号密码规则（≥8 位且含字母+数字）', () => {
  assert.strictEqual(isValidAccountPassword('abc12345'), true);
  assert.strictEqual(isValidAccountPassword('ABC12345'), true);
  assert.strictEqual(isValidAccountPassword('a1b2c3d4'), true);
  assert.strictEqual(isValidAccountPassword('short1'), false); // 不足 8 位
  assert.strictEqual(isValidAccountPassword('onlyletters'), false); // 无数字
  assert.strictEqual(isValidAccountPassword('12345678'), false); // 无字母
  assert.strictEqual(isValidAccountPassword(''), false);
  assert.strictEqual(isValidAccountPassword(null), false);
});
