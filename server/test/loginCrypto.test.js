// 登录密码加密传输单元测试（node:test + node:assert）
// 覆盖：loginCrypto RSA-2048 / RSA-OAEP / SHA-256
//   - 加解密 roundtrip（用公钥加密、模块私钥解密，模拟前端 WebCrypto 路径）
//   - kid 不匹配拒绝
//   - 密文损坏 / 非 base64 拒绝
const { test } = require('node:test');
const assert = require('node:assert');
const forge = require('node-forge');
const loginCrypto = require('../src/loginCrypto');

/** 用当前公钥按前端契约加密密码：base64(RSA-OAEP/SHA-256(UTF-8 密码)) */
function encryptWithCurrentPubkey(plain) {
  const { publicKeyPem } = loginCrypto.getPublicKey();
  const pub = forge.pki.publicKeyFromPem(publicKeyPem);
  const bin = pub.encrypt(forge.util.encodeUtf8(plain), 'RSA-OAEP', {
    md: forge.md.sha256.create(),
  });
  return forge.util.encode64(bin);
}

test('pubkey：返回 kid 与 PEM 公钥', () => {
  const info = loginCrypto.getPublicKey();
  assert.ok(typeof info.kid === 'string' && info.kid.length > 0);
  assert.ok(info.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----'));
  // 重复调用返回同一把密钥（ephemeral 但进程内稳定）
  assert.strictEqual(loginCrypto.getPublicKey().kid, info.kid);
});

test('RSA 加解密 roundtrip', () => {
  const { kid } = loginCrypto.getPublicKey();
  const password = 'T3st#Pwd_2026!xYz'; // 含特殊字符的测试样例（非真实密码）
  const enc = encryptWithCurrentPubkey(password);
  const decrypted = loginCrypto.decryptPassword(kid, enc);
  assert.strictEqual(decrypted, password);
});

test('roundtrip：中文与 emoji 密码（UTF-8）', () => {
  const { kid } = loginCrypto.getPublicKey();
  const password = '密码Abc123!@#中文';
  const enc = encryptWithCurrentPubkey(password);
  assert.strictEqual(loginCrypto.decryptPassword(kid, enc), password);
});

test('错误 kid 拒绝（KID_MISMATCH）', () => {
  const enc = encryptWithCurrentPubkey('whatever1A');
  assert.throws(() => loginCrypto.decryptPassword('no-such-kid', enc), (err) => {
    assert.strictEqual(err.code, 'KID_MISMATCH');
    assert.match(err.message, /密钥已过期或不匹配/);
    return true;
  });
});

test('密文损坏 / 非 base64 拒绝（DECRYPT_FAILED）', () => {
  const { kid } = loginCrypto.getPublicKey();
  assert.throws(() => loginCrypto.decryptPassword(kid, '!!!not-base64!!!'), (err) => {
    assert.strictEqual(err.code, 'DECRYPT_FAILED');
    return true;
  });
  // 用别的密钥加密的密文也无法解密
  const otherPair = forge.pki.rsa.generateKeyPair(2048);
  const foreign = forge.util.encode64(
    otherPair.publicKey.encrypt(forge.util.encodeUtf8('abc12345'), 'RSA-OAEP', {
      md: forge.md.sha256.create(),
    })
  );
  assert.throws(() => loginCrypto.decryptPassword(kid, foreign), (err) => {
    assert.strictEqual(err.code, 'DECRYPT_FAILED');
    return true;
  });
});

test('空 passwordEnc 拒绝', () => {
  const { kid } = loginCrypto.getPublicKey();
  assert.throws(() => loginCrypto.decryptPassword(kid, ''), (err) => {
    assert.strictEqual(err.code, 'DECRYPT_FAILED');
    return true;
  });
});
