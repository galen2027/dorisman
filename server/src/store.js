// JSON 文件存储（纯 JS，无原生模块）
// 依据 SPEC 3：
//   - data/accounts.json   平台账号 [{username, passwordHash, role, createdAt}]
//   - data/clusters.json   集群 [{id, name, host, port, username, passwordEnc, createdAt}]
//   - data/.secret         32 字节 hex 密钥（JWT 签名 + 集群密码 AES-256-GCM 加密共用），0600
//   - data/audit.jsonl     审计日志，每行一个 JSON
//   - data/INIT_ADMIN_PASSWORD.txt  首次初始化写入的初始管理员密码（0600）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { generatePassword } = require('./password');

// 模块内状态（init() 之后可用）
const state = {
  dataDir: null,
  secretKey: null, // Buffer(32)
};

// ---------------------------------------------------------------------------
// 基础文件工具
// ---------------------------------------------------------------------------

/** 确保目录存在 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 读取 JSON 文件，不存在或损坏时返回 fallback */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    console.error(`[store] 读取 ${file} 失败，使用默认值：${err.message}`);
    return fallback;
  }
}

/** 原子写 JSON 文件（先写临时文件再改名，避免写一半损坏） */
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// 密钥管理
// ---------------------------------------------------------------------------

/**
 * 加载或首次生成 data/.secret（32 字节随机数，hex 存储，权限 0600）
 * @returns {Buffer} 32 字节密钥
 */
function loadOrCreateSecret(dataDir) {
  const secretFile = path.join(dataDir, '.secret');
  if (fs.existsSync(secretFile)) {
    const hex = fs.readFileSync(secretFile, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
    console.error('[store] .secret 文件内容非法，重新生成（旧加密数据将无法解密）');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(secretFile, key.toString('hex'), { mode: 0o600 });
  return key;
}

// ---------------------------------------------------------------------------
// AES-256-GCM 加解密（集群密码）
// ---------------------------------------------------------------------------

/**
 * 加密明文密码，输出 base64 三段式：iv.tag.ciphertext
 */
function encryptPassword(plain) {
  const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
  const cipher = crypto.createCipheriv('aes-256-gcm', state.secretKey, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

/**
 * 解密 encryptPassword 的产出；失败抛错
 */
function decryptPassword(enc) {
  const parts = String(enc).split('.');
  if (parts.length !== 3) throw new Error('密文格式错误');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', state.secretKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

/**
 * 初始化数据目录与各文件。
 * 首次启动（accounts.json 不存在）时自动创建 admin 账号：
 *   - 随机 16 位强密码
 *   - 写入 INIT_ADMIN_PASSWORD.txt（0600）
 *   - 返回值中带上初始密码，由入口打印启动横幅
 * @returns {{dataDir: string, initialAdmin: {username: string, password: string} | null}}
 */
function init() {
  const dataDir = config.DATA_DIR;
  ensureDir(dataDir);
  state.dataDir = dataDir;
  state.secretKey = loadOrCreateSecret(dataDir);

  let initialAdmin = null;
  const accountsFile = path.join(dataDir, 'accounts.json');
  if (!fs.existsSync(accountsFile)) {
    // 首次启动引导：创建 admin / 随机 16 位强密码
    const password = generatePassword();
    const accounts = [
      {
        username: 'admin',
        passwordHash: bcrypt.hashSync(password, 10),
        role: 'admin',
        createdAt: new Date().toISOString(),
      },
    ];
    writeJsonAtomic(accountsFile, accounts);
    fs.writeFileSync(path.join(dataDir, 'INIT_ADMIN_PASSWORD.txt'), password + '\n', { mode: 0o600 });
    initialAdmin = { username: 'admin', password };
  }

  const clustersFile = path.join(dataDir, 'clusters.json');
  if (!fs.existsSync(clustersFile)) {
    writeJsonAtomic(clustersFile, []);
  }

  return { dataDir, initialAdmin };
}

// ---------------------------------------------------------------------------
// 平台账号
// ---------------------------------------------------------------------------

function getAccounts() {
  return readJson(path.join(state.dataDir, 'accounts.json'), []);
}

function saveAccounts(accounts) {
  writeJsonAtomic(path.join(state.dataDir, 'accounts.json'), accounts);
}

function findAccount(username) {
  return getAccounts().find((a) => a.username === username) || null;
}

// ---------------------------------------------------------------------------
// 集群
// ---------------------------------------------------------------------------

function getClusters() {
  return readJson(path.join(state.dataDir, 'clusters.json'), []);
}

function saveClusters(clusters) {
  writeJsonAtomic(path.join(state.dataDir, 'clusters.json'), clusters);
}

function findCluster(id) {
  return getClusters().find((c) => c.id === id) || null;
}

// ---------------------------------------------------------------------------
// 审计日志（audit.jsonl 追加写）
// ---------------------------------------------------------------------------

// 审计脱敏正则（统一出口）：
//   IDENTIFIED BY '...' → IDENTIFIED BY '***'
//   PASSWORD('...')     → PASSWORD('***')
// 兼容转义字符（\' \\）与大小写
const IDENTIFIED_BY_RE = /(IDENTIFIED\s+BY\s+)'(?:[^'\\]|\\.)*'/gi;
const PASSWORD_FN_RE = /(PASSWORD\s*\(\s*)'(?:[^'\\]|\\.)*'(\s*\))/gi;

/**
 * SQL 密码脱敏：把语句中的密码字面量替换为 '***'
 * 写审计与读审计（含历史日志）都经过本函数，任何出口不出现明文密码。
 * @param {*} sql 原始 SQL（非字符串原样返回）
 * @returns {*} 脱敏后的 SQL
 */
function maskSqlSecrets(sql) {
  if (typeof sql !== 'string' || sql === '') return sql;
  return sql
    .replace(IDENTIFIED_BY_RE, "$1'***'")
    .replace(PASSWORD_FN_RE, "$1'***'$2");
}

/** 审计记录脱敏（返回新对象，不改原对象） */
function maskAuditEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.sql !== 'string') return entry;
  return Object.assign({}, entry, { sql: maskSqlSecrets(entry.sql) });
}

/** 追加一条审计记录（每行一个 JSON）；写入前对 SQL 做密码脱敏 */
function appendAudit(entry) {
  const line = JSON.stringify(maskAuditEntry(entry)) + '\n';
  fs.appendFileSync(path.join(state.dataDir, 'audit.jsonl'), line, 'utf8');
}

/** 读取全部审计记录（坏行跳过），返回数组；历史未脱敏记录在读取出口统一脱敏 */
function readAudit() {
  const file = path.join(state.dataDir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const items = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      items.push(maskAuditEntry(JSON.parse(t)));
    } catch (err) {
      // 坏行跳过，不影响整体
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// 用户禁用状态（userStatus.json）
// Doris 3.0.6 没有"禁用登录"标记，平台用本地文件跟踪：
//   [{clusterId, user, host, disabledAt, disabledBy}]
// 禁用 = 密码随机化（见 routes disable 接口）；改密/重建/删除用户即解除。
// ---------------------------------------------------------------------------

/** 读取全部禁用记录；文件缺失/损坏/非数组时返回 []（坏文件容错） */
function readUserStatus() {
  const rows = readJson(path.join(state.dataDir, 'userStatus.json'), []);
  return Array.isArray(rows) ? rows : [];
}

function writeUserStatus(rows) {
  writeJsonAtomic(path.join(state.dataDir, 'userStatus.json'), rows);
}

/** 按集群列出禁用记录 */
function listDisabled(clusterId) {
  return readUserStatus().filter((r) => r && r.clusterId === clusterId);
}

/**
 * 标记某 user@host 已禁用登录。
 * 幂等：重复标记不新增条目，仅更新 disabledAt 与 disabledBy。
 */
function markDisabled(clusterId, user, host, by) {
  const rows = readUserStatus();
  const now = new Date().toISOString();
  const existing = rows.find((r) => r && r.clusterId === clusterId && r.user === user && r.host === host);
  if (existing) {
    existing.disabledAt = now;
    existing.disabledBy = by;
  } else {
    rows.push({ clusterId, user, host, disabledAt: now, disabledBy: by });
  }
  writeUserStatus(rows);
}

/** 解除某 user@host 的禁用标记（改密/重建/删除用户后调用）；无匹配为空操作 */
function clearDisabled(clusterId, user, host) {
  const rows = readUserStatus();
  const next = rows.filter((r) => !(r && r.clusterId === clusterId && r.user === user && r.host === host));
  if (next.length !== rows.length) writeUserStatus(next);
}

/** 清空某集群的全部禁用标记（删除集群后调用）；无匹配为空操作 */
function clearDisabledByCluster(clusterId) {
  const rows = readUserStatus();
  const next = rows.filter((r) => !(r && r.clusterId === clusterId));
  if (next.length !== rows.length) writeUserStatus(next);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
  init,
  encryptPassword,
  decryptPassword,
  getAccounts,
  saveAccounts,
  findAccount,
  getClusters,
  saveClusters,
  findCluster,
  appendAudit,
  readAudit,
  maskSqlSecrets,
  listDisabled,
  markDisabled,
  clearDisabled,
  clearDisabledByCluster,
  // 测试/调试用：获取 JWT 密钥
  getSecretKey: () => state.secretKey,
  getDataDir: () => state.dataDir,
};
