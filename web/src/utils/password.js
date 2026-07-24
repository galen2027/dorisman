// 随机密码生成：与 SPEC 5.4 同规则 —— 16 位，至少含 1 大写、1 小写、1 数字、1 特殊字符
// 特殊字符集合不含引号和反斜杠，避免 SQL 转义问题
// 浏览器端使用 crypto.getRandomValues 获取安全随机数

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGIT = '0123456789'
const SPECIAL = '!@#$%^&*-_=+'
const ALL = UPPER + LOWER + DIGIT + SPECIAL

/** 从 charset 中随机取一个字符（加密安全随机） */
function pickOne(charset) {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return charset[buf[0] % charset.length]
}

/** 洗牌（Fisher-Yates，使用加密随机数） */
function shuffle(chars) {
  const arr = [...chars]
  for (let i = arr.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const j = buf[0] % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** 生成 16 位强随机密码：保证四类字符各至少 1 个，其余随机补齐后洗牌 */
export function generatePassword() {
  const required = [pickOne(UPPER), pickOne(LOWER), pickOne(DIGIT), pickOne(SPECIAL)]
  const rest = Array.from({ length: 16 - required.length }, () => pickOne(ALL))
  return shuffle([...required, ...rest]).join('')
}

/** 简单强度评估，返回 {score: 0-4, label} 供界面提示 */
export function passwordStrength(pwd) {
  if (!pwd) return { score: 0, label: '未填写' }
  let score = 0
  if (pwd.length >= 8) score++
  if (pwd.length >= 12) score++
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++
  if (/\d/.test(pwd) && /[^A-Za-z0-9]/.test(pwd)) score++
  const labels = ['弱', '弱', '一般', '较强', '强']
  return { score, label: labels[score] }
}
