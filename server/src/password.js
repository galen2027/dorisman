// 16 位强随机密码生成（纯函数模块，无 IO）
// 规则（SPEC 5.4）：
//   - 固定 16 位
//   - 至少含 1 大写、1 小写、1 数字、1 特殊字符
//   - 特殊字符集合为 !@#$%^&*-_=+（不含引号和反斜杠，避免 SQL 转义问题）
//   - 使用 crypto.randomInt 生成，最后洗牌保证类别位置随机
const crypto = require('crypto');

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
const SPECIAL = '!@#$%^&*-_=+';
const ALL = UPPER + LOWER + DIGIT + SPECIAL;

const PASSWORD_LENGTH = 16;

/**
 * 从给定字符集中均匀随机取一个字符
 * @param {string} charset 字符集
 * @returns {string} 单个字符
 */
function pickOne(charset) {
  return charset[crypto.randomInt(0, charset.length)];
}

/**
 * Fisher-Yates 洗牌（原地打乱，使用 crypto.randomInt 保证安全随机）
 * @param {string[]} arr 字符数组
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

/**
 * 生成 16 位强随机密码
 * @returns {string} 满足规则的密码
 */
function generatePassword() {
  // 先各取 1 个保证四种类别都出现
  const chars = [
    pickOne(UPPER),
    pickOne(LOWER),
    pickOne(DIGIT),
    pickOne(SPECIAL),
  ];
  // 剩余位数从全集中取
  while (chars.length < PASSWORD_LENGTH) {
    chars.push(pickOne(ALL));
  }
  // 洗牌，避免前四位固定为大/小/数/特的顺序
  shuffle(chars);
  return chars.join('');
}

/**
 * 校验密码是否满足 16 位强密码规则（用于测试与自检）
 * @param {string} pwd 待校验密码
 * @returns {boolean}
 */
function isStrongPassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length !== PASSWORD_LENGTH) return false;
  const hasUpper = /[A-Z]/.test(pwd);
  const hasLower = /[a-z]/.test(pwd);
  const hasDigit = /[0-9]/.test(pwd);
  const hasSpecial = pwd.split('').some((c) => SPECIAL.includes(c));
  // 不允许出现集合外字符（尤其引号、反斜杠、空白）
  const allAllowed = pwd.split('').every((c) => ALL.includes(c));
  return hasUpper && hasLower && hasDigit && hasSpecial && allAllowed;
}

/**
 * 平台账号密码强度校验（SPEC 6.2）：≥8 位且含字母+数字
 * @param {string} pwd 待校验密码
 * @returns {boolean}
 */
function isValidAccountPassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 8) return false;
  return /[A-Za-z]/.test(pwd) && /[0-9]/.test(pwd);
}

module.exports = {
  generatePassword,
  isStrongPassword,
  isValidAccountPassword,
  SPECIAL,
  PASSWORD_LENGTH,
};
