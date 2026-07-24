// 登录密码加密传输（node-forge，纯 JS，无原生模块）
//   - 服务启动后惰性生成 ephemeral RSA-2048 密钥对（仅存内存，进程重启即更换）
//   - GET /api/auth/pubkey 返回 {kid, publicKeyPem}（无需鉴权）
//   - 前端用 WebCrypto RSA-OAEP + SHA-256 加密 UTF-8 密码后 base64 传输
//   - 本模块用对应私钥解密（RSA-OAEP + SHA-256），kid 不匹配或解密失败抛中文错误
const crypto = require('crypto');
const forge = require('node-forge');

// 模块内状态（ephemeral，仅存内存）
const state = {
  kid: null,
  privateKey: null,
  publicKeyPem: null,
};

/**
 * 确保密钥对已生成（惰性初始化，首次调用时同步生成 RSA-2048，约几百毫秒）
 */
function ensureKey() {
  if (state.privateKey) return;
  const pair = forge.pki.rsa.generateKeyPair(2048);
  state.privateKey = pair.privateKey;
  state.publicKeyPem = forge.pki.publicKeyToPem(pair.publicKey);
  state.kid = crypto.randomUUID();
}

/**
 * 取当前公钥信息
 * @returns {{kid: string, publicKeyPem: string}}
 */
function getPublicKey() {
  ensureKey();
  return { kid: state.kid, publicKeyPem: state.publicKeyPem };
}

/**
 * 解密前端加密的密码
 * @param {string} kid 客户端使用的密钥 ID（必须等于当前 kid）
 * @param {string} passwordEnc base64(RSA-OAEP/SHA-256 加密的 UTF-8 密码)
 * @returns {string} 明文密码
 * @throws {Error} 带 code 属性的中文错误（KID_MISMATCH / DECRYPT_FAILED）
 */
function decryptPassword(kid, passwordEnc) {
  ensureKey();
  if (typeof kid !== 'string' || kid !== state.kid) {
    const err = new Error('加密密钥已过期或不匹配，请刷新页面获取新公钥后重试');
    err.code = 'KID_MISMATCH';
    throw err;
  }
  if (typeof passwordEnc !== 'string' || passwordEnc === '') {
    const err = new Error('加密密码不能为空');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
  try {
    const cipherBin = forge.util.decode64(passwordEnc);
    const plainBin = state.privateKey.decrypt(cipherBin, 'RSA-OAEP', {
      md: forge.md.sha256.create(),
    });
    const password = forge.util.decodeUtf8(plainBin);
    if (typeof password !== 'string' || password === '') {
      throw new Error('empty');
    }
    return password;
  } catch (e) {
    const err = new Error('密码解密失败，请刷新页面后重试');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
}

module.exports = {
  getPublicKey,
  decryptPassword,
};
