// config.js 命令行参数解析与构建时间字段测试
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');

test('argValue 支持 --name=value 形式', () => {
  const old = process.argv;
  process.argv = ['node', 'dorisman', '--port=9090'];
  try {
    assert.strictEqual(config.argValue('port'), '9090');
  } finally {
    process.argv = old;
  }
});

test('argValue 支持 --name value 形式', () => {
  const old = process.argv;
  process.argv = ['node', 'dorisman', '--data', '/opt/dorisman/data'];
  try {
    assert.strictEqual(config.argValue('data'), '/opt/dorisman/data');
  } finally {
    process.argv = old;
  }
});

test('argValue 未传参时返回 undefined', () => {
  const old = process.argv;
  process.argv = ['node', 'dorisman'];
  try {
    assert.strictEqual(config.argValue('port'), undefined);
    assert.strictEqual(config.argValue('host'), undefined);
  } finally {
    process.argv = old;
  }
});

test('config 暴露 VERSION 与 BUILD_TIME 字段', () => {
  assert.match(config.VERSION, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(typeof config.BUILD_TIME, 'string'); // 开发模式为空串，打包后为构建时间
});

test('默认端口为 9197', () => {
  const old = process.argv;
  const oldEnv = process.env.PORT;
  process.argv = ['node', 'dorisman'];
  delete process.env.PORT;
  try {
    // config 在 require 时已解析，此处通过重新 require 验证默认值
    delete require.cache[require.resolve('../src/config')];
    const fresh = require('../src/config');
    assert.strictEqual(fresh.PORT, 9197);
  } finally {
    process.argv = old;
    if (oldEnv !== undefined) process.env.PORT = oldEnv;
    delete require.cache[require.resolve('../src/config')];
  }
});
