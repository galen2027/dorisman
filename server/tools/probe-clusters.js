// 只读诊断：解密本地 clusters.json，逐集群对比 SHOW ALL GRANTS 与 mysql.user
// 不打印任何密码明文。用法：node server/tools/probe-clusters.js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const DATA = path.join(__dirname, '..', 'data');
const secretKey = Buffer.from(fs.readFileSync(path.join(DATA, '.secret'), 'utf8').trim(), 'hex');
const clusters = JSON.parse(fs.readFileSync(path.join(DATA, 'clusters.json'), 'utf8'));

function decrypt(enc) {
  const [iv, tag, ct] = String(enc).split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function probe(c) {
  const out = { name: c.name, host: `${c.host}:${c.port}`, username: c.username };
  let conn;
  try {
    conn = await mysql.createConnection({
      host: c.host,
      port: c.port,
      user: c.username,
      password: decrypt(c.passwordEnc),
      connectTimeout: 6000,
    });
  } catch (e) {
    out.error = `连接失败: ${e.message}`;
    return out;
  }
  try {
    const [ver] = await conn.query('SELECT VERSION() AS v');
    out.version = ver[0] && ver[0].v;
    const [grants] = await conn.query('SHOW ALL GRANTS');
    out.showAllGrantsUsers = grants.map((r) => r.UserIdentity || r[Object.keys(r)[0]]);
    try {
      const [mu] = await conn.query('SELECT `User`, `Host` FROM mysql.user');
      out.mysqlUserRows = mu.map((r) => `'${r.User}'@'${r.Host}'`);
    } catch (e) {
      out.mysqlUserError = e.message;
    }
  } catch (e) {
    out.error = e.message;
  } finally {
    await conn.end();
  }
  return out;
}

(async () => {
  for (const c of clusters) {
    const r = await probe(c);
    console.log('='.repeat(66));
    console.log(`集群: ${r.name} (${r.host}, 账号 ${r.username})`);
    if (r.error) {
      console.log('  ', r.error);
      continue;
    }
    console.log('  Doris 版本:', r.version);
    console.log(`  SHOW ALL GRANTS 用户 (${r.showAllGrantsUsers.length}):`, JSON.stringify(r.showAllGrantsUsers));
    if (r.mysqlUserError) {
      console.log('  mysql.user 查询失败:', r.mysqlUserError);
    } else {
      console.log(`  mysql.user 行 (${r.mysqlUserRows.length}):`, JSON.stringify(r.mysqlUserRows));
    }
  }
})();
