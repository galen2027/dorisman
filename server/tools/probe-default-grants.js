// 验证 Doris 新用户是否默认自带 information_schema/mysql 的 SELECT_PRIV
// 创建一次性探针用户 → SHOW GRANTS → 立即删除。用法：node server/tools/probe-default-grants.js
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

(async () => {
  // 选第一个当前可连通的集群
  for (const c of clusters) {
    let conn;
    try {
      conn = await mysql.createConnection({
        host: c.host, port: c.port, user: c.username,
        password: decrypt(c.passwordEnc), connectTimeout: 5000,
      });
    } catch {
      continue; // 连不上换下一个
    }
    console.log(`使用集群: ${c.name} (${c.host}:${c.port})`);
    const u = 'dorisman_probe_tmp';
    try {
      // 只建用户，不给任何授权
      await conn.query(`CREATE USER IF NOT EXISTS '${u}'@'%' IDENTIFIED BY 'Probe#12345Aa'`);
      console.log(`已创建探针用户（未做任何 GRANT）`);
      const [rows] = await conn.query(`SHOW GRANTS FOR '${u}'@'%'`);
      console.log('SHOW GRANTS 原始返回：');
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (v) console.log(`  ${k}: ${v}`);
        }
      }
    } finally {
      try {
        await conn.query(`DROP USER IF EXISTS '${u}'@'%'`);
        console.log('探针用户已删除（环境已还原）');
      } catch (e) {
        console.log('删除探针用户失败，请手动清理:', e.message);
      }
      await conn.end();
    }
    return;
  }
  console.log('没有可连通的集群');
})();
