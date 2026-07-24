// 认证与 RBAC（SPEC 4 / 6.2）
//   - 登录接口内存限流：同一 IP 1 分钟内失败 5 次锁定 5 分钟
//   - JWT 有效期 12 小时，签名密钥来自 data/.secret
//   - requireAuth / requireAdmin 两个中间件
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const store = require('./store');
const config = require('./config');
const loginCrypto = require('./loginCrypto');

// ---------------------------------------------------------------------------
// 登录限流（内存实现，进程重启即清零）
// ---------------------------------------------------------------------------

// ip → { fails: number[]（失败时间戳）, lockedUntil: number|null }
const loginAttempts = new Map();

/** 清理过期记录（惰性清理，避免内存膨胀） */
function gcAttempts(now) {
  if (loginAttempts.size < 1000) return;
  for (const [ip, rec] of loginAttempts) {
    const locked = rec.lockedUntil && rec.lockedUntil > now;
    const recent = rec.fails.some((t) => now - t < config.LOGIN_LIMIT.windowMs);
    if (!locked && !recent) loginAttempts.delete(ip);
  }
}

/**
 * 检查该 IP 当前是否允许尝试登录
 * @returns {{allowed: boolean, waitSeconds?: number}}
 */
function checkLoginAllowed(ip) {
  const now = Date.now();
  gcAttempts(now);
  const rec = loginAttempts.get(ip);
  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    return { allowed: false, waitSeconds: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

/** 记录一次失败，达到阈值则锁定 */
function recordLoginFail(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec) {
    rec = { fails: [], lockedUntil: null };
    loginAttempts.set(ip, rec);
  }
  // 只保留统计窗口内的失败
  rec.fails = rec.fails.filter((t) => now - t < config.LOGIN_LIMIT.windowMs);
  rec.fails.push(now);
  if (rec.fails.length >= config.LOGIN_LIMIT.maxFails) {
    rec.lockedUntil = now + config.LOGIN_LIMIT.lockMs;
    rec.fails = [];
  }
}

/** 登录成功后清除失败记录 */
function resetLoginFails(ip) {
  loginAttempts.delete(ip);
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

/** 签发 JWT（12 小时） */
function signToken(account) {
  return jwt.sign(
    { username: account.username, role: account.role },
    store.getSecretKey(),
    { expiresIn: config.JWT_EXPIRES_IN }
  );
}

// ---------------------------------------------------------------------------
// 统一错误响应
// ---------------------------------------------------------------------------

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

// ---------------------------------------------------------------------------
// 登录处理器（POST /api/auth/login）
// ---------------------------------------------------------------------------

function login(req, res) {
  const ip = req.ip || 'unknown';
  const check = checkLoginAllowed(ip);
  if (!check.allowed) {
    const minutes = Math.ceil(check.waitSeconds / 60);
    return fail(res, 429, 'LOGIN_LOCKED', `失败次数过多，账号已锁定，请约 ${minutes} 分钟后再试`);
  }

  const { username, password, passwordEnc, kid } = req.body || {};

  // 密码来源：优先加密路径（passwordEnc + kid，RSA-OAEP/SHA-256），
  // 其次明文路径（password，curl / API 兼容）
  let plainPassword = null;
  if (typeof passwordEnc === 'string' && passwordEnc !== '') {
    try {
      plainPassword = loginCrypto.decryptPassword(kid, passwordEnc);
    } catch (err) {
      return fail(res, 400, err.code || 'DECRYPT_FAILED', err.message);
    }
  } else if (typeof password === 'string' && password !== '') {
    plainPassword = password;
  }

  if (typeof username !== 'string' || !username || !plainPassword) {
    return fail(res, 400, 'INVALID_INPUT', '用户名和密码不能为空');
  }

  const account = store.findAccount(username);
  // 用户名不存在与密码错误返回同样的提示，避免账号枚举
  if (!account || !bcrypt.compareSync(plainPassword, account.passwordHash)) {
    recordLoginFail(ip);
    return fail(res, 401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }

  resetLoginFails(ip);
  const token = signToken(account);
  res.json({ token, user: { username: account.username, role: account.role } });
}

// ---------------------------------------------------------------------------
// 中间件
// ---------------------------------------------------------------------------

/** 要求已登录（校验 Bearer JWT） */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return fail(res, 401, 'UNAUTHORIZED', '未登录或登录已过期');
  }
  try {
    const payload = jwt.verify(m[1], store.getSecretKey());
    req.user = { username: payload.username, role: payload.role };
    next();
  } catch (err) {
    return fail(res, 401, 'UNAUTHORIZED', '未登录或登录已过期');
  }
}

/** 要求管理员角色（需在 requireAuth 之后使用） */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return fail(res, 403, 'FORBIDDEN', '仅管理员可执行此操作');
  }
  next();
}

module.exports = {
  login,
  signToken,
  requireAuth,
  requireAdmin,
  // 导出供测试
  checkLoginAllowed,
  recordLoginFail,
  resetLoginFails,
};
