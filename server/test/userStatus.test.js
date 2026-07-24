// userStatus 禁用状态存储单元测试（node:test + node:assert）
// 用 fs 临时目录初始化 store，覆盖：标记 / 幂等更新 / 解除 / 按集群清空 / 坏文件容错
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require store 之前设置数据目录（config 在模块加载时读取环境变量）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorisman-userstatus-'));
process.env.DORISMAN_DATA = tmpDir;
const store = require('../src/store');

store.init();

const statusFile = path.join(tmpDir, 'userStatus.json');
const readRaw = () => JSON.parse(fs.readFileSync(statusFile, 'utf8'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('初始无文件时 listDisabled 返回空数组', () => {
  assert.deepStrictEqual(store.listDisabled('c1'), []);
});

test('markDisabled 新增条目，字段完整且 disabledAt 为 ISO 时间', () => {
  store.markDisabled('c1', 'dev', '%', 'admin');
  const rows = store.listDisabled('c1');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].clusterId, 'c1');
  assert.strictEqual(rows[0].user, 'dev');
  assert.strictEqual(rows[0].host, '%');
  assert.strictEqual(rows[0].disabledBy, 'admin');
  assert.ok(typeof rows[0].disabledAt === 'string' && !Number.isNaN(Date.parse(rows[0].disabledAt)));
  // 落盘结构与内存一致
  assert.deepStrictEqual(readRaw(), rows);
});

test('重复标记幂等：不新增条目，更新 disabledAt 与 disabledBy', async () => {
  const first = store.listDisabled('c1')[0];
  await new Promise((r) => setTimeout(r, 20)); // 确保时间戳可区分
  store.markDisabled('c1', 'dev', '%', 'bob');
  const rows = store.listDisabled('c1');
  assert.strictEqual(rows.length, 1, '重复标记不得新增条目');
  assert.strictEqual(rows[0].disabledBy, 'bob', '操作人应更新');
  assert.ok(rows[0].disabledAt > first.disabledAt, 'disabledAt 应更新为更晚时间');
});

test('listDisabled 按 clusterId 隔离', () => {
  store.markDisabled('c2', 'dev', '%', 'admin');
  store.markDisabled('c1', 'ops', '10.%', 'admin');
  assert.strictEqual(store.listDisabled('c1').length, 2);
  assert.strictEqual(store.listDisabled('c2').length, 1);
  assert.strictEqual(store.listDisabled('c-none').length, 0);
});

test('clearDisabled 只解除匹配的 user@host，不影响同 user 其他 host 与其他集群', () => {
  store.clearDisabled('c1', 'dev', '%');
  const c1 = store.listDisabled('c1');
  assert.strictEqual(c1.length, 1);
  assert.strictEqual(c1[0].user, 'ops');
  assert.strictEqual(store.listDisabled('c2').length, 1, '其他集群不受影响');
});

test('clearDisabled 对无匹配条目为空操作（不报错、文件结构不变）', () => {
  const before = readRaw();
  store.clearDisabled('c1', 'nobody', '%');
  store.clearDisabled('c-none', 'ops', '10.%');
  assert.deepStrictEqual(readRaw(), before);
});

test('clearDisabledByCluster 清空该集群全部条目，保留其他集群', () => {
  store.clearDisabledByCluster('c1');
  assert.deepStrictEqual(store.listDisabled('c1'), []);
  const c2 = store.listDisabled('c2');
  assert.strictEqual(c2.length, 1);
  assert.strictEqual(c2[0].user, 'dev');
  store.clearDisabledByCluster('c2');
  assert.deepStrictEqual(readRaw(), []);
});

test('坏文件容错：损坏 JSON 时 listDisabled 返回 []，且 markDisabled 可恢复写入', () => {
  fs.writeFileSync(statusFile, '{broken json !!!', 'utf8');
  assert.deepStrictEqual(store.listDisabled('c9'), []);
  store.markDisabled('c9', 'u', '%', 'admin');
  const rows = store.listDisabled('c9');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].disabledBy, 'admin');
  store.clearDisabledByCluster('c9');
});

test('坏文件容错：合法 JSON 但非数组时按空处理', () => {
  fs.writeFileSync(statusFile, '{"not":"an array"}', 'utf8');
  assert.deepStrictEqual(store.listDisabled('c9'), []);
  store.markDisabled('c9', 'u2', '%', 'admin');
  assert.strictEqual(store.listDisabled('c9').length, 1, '非数组内容被丢弃后可正常恢复写入');
  store.clearDisabledByCluster('c9');
});
