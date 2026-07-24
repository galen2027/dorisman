// 全部 API 路由（SPEC 6）
//   - 统一前缀 /api；除 /api/health 与 /api/auth/login 外全部需要 JWT
//   - 错误响应统一 { error: { code, message } }
//   - 写操作先 preview 后 confirm 执行，逐条记录 results，出错即停
//   - 全部写操作与控制台 SQL 写 audit.jsonl
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');
const auth = require('./auth');
const doris = require('./doris');
const sqlgen = require('./sqlgen');
const grantsParser = require('./grantsParser');
const { isValidAccountPassword, generatePassword } = require('./password');
const loginCrypto = require('./loginCrypto');
const config = require('./config');
const { assertNotProtectedUser, checkConsoleSql } = require('./protect');

// Doris 内置角色：禁止删除（SPEC 7.4）
const BUILTIN_ROLES = ['admin', 'operator'];

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 统一错误响应 */
function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/** 包装 async 处理器，统一捕获异常 */
function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      // sqlgen 的输入校验错误按 400 处理；带 status 的错误按指定状态码返回
      if (err && err.isInputError) {
        return fail(res, 400, 'INVALID_INPUT', err.message);
      }
      if (err && err.status) {
        return fail(res, err.status, err.status === 404 ? 'NOT_FOUND' : 'ERROR', err.message);
      }
      console.error(`[routes] ${req.method} ${req.path} 处理失败：`, err);
      return fail(res, 500, 'INTERNAL', `服务器内部错误：${err.message}`);
    });
  };
}

/** sqlgen 抛出的错误统一视为输入错误 */
function genSql(builder) {
  try {
    return builder();
  } catch (err) {
    err.isInputError = true;
    throw err;
  }
}

/** Doris 调用统一错误翻译 */
async function dorisCall(fn) {
  try {
    return await fn();
  } catch (err) {
    const e = new Error(`Doris 访问失败：${err.message}`);
    e.isDorisError = true;
    throw e;
  }
}

/** 包装 Doris 段调用：Doris 错误返回 502 */
function wrapDoris(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err && err.isDorisError) {
        return fail(res, 502, 'DORIS_ERROR', err.message);
      }
      if (err && err.isInputError) {
        return fail(res, 400, 'INVALID_INPUT', err.message);
      }
      if (err && err.status) {
        return fail(res, err.status, err.status === 404 ? 'NOT_FOUND' : 'ERROR', err.message);
      }
      console.error(`[routes] ${req.method} ${req.path} 处理失败：`, err);
      return fail(res, 500, 'INTERNAL', `服务器内部错误：${err.message}`);
    });
  };
}

/** 取集群（已解密），不存在返回 null 并写 404。/c/:clusterId 与 /clusters/:id 两种路由参数名都兼容 */
function getCluster(req, res) {
  let cluster = null;
  try {
    cluster = doris.resolveCluster(req.params.clusterId || req.params.id);
  } catch (err) {
    fail(res, 500, 'INTERNAL', err.message);
    return null;
  }
  if (!cluster) {
    fail(res, 404, 'CLUSTER_NOT_FOUND', '集群不存在');
    return null;
  }
  return cluster;
}

/** 写审计日志 */
function audit(req, cluster, action, sql, ok, error) {
  try {
    store.appendAudit({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      account: req.user ? req.user.username : null,
      accountRole: req.user ? req.user.role : null,
      clusterId: cluster ? cluster.id : null,
      clusterName: cluster ? cluster.name : null,
      action,
      sql,
      ok: !!ok,
      error: error || null,
      ip: req.ip || null,
    });
  } catch (err) {
    console.error('[audit] 写入失败：', err.message);
  }
}

/** 逐条执行 SQL，出错即停；每条写审计 */
async function executeSqlList(req, cluster, action, sqlList) {
  const results = [];
  for (const sql of sqlList) {
    try {
      await doris.query(cluster, sql);
      results.push({ sql, ok: true, error: null });
      audit(req, cluster, action, sql, true, null);
    } catch (err) {
      results.push({ sql, ok: false, error: err.message });
      audit(req, cluster, action, sql, false, err.message);
      break; // 出错即停
    }
  }
  return results;
}

/** 校验 confirm:true，否则 400 */
function requireConfirm(req, res) {
  if (!req.body || req.body.confirm !== true) {
    fail(res, 400, 'CONFIRM_REQUIRED', '写操作必须在请求体中带 confirm:true 确认执行');
    return false;
  }
  return true;
}

/** 平台账号公开视图（不带密码哈希） */
function accountView(a) {
  return { username: a.username, role: a.role, createdAt: a.createdAt };
}

/** 校验平台账号角色 */
function isValidRole(role) {
  return role === 'admin' || role === 'readonly';
}

// ---------------------------------------------------------------------------
// 路由工厂
// ---------------------------------------------------------------------------

function createRouter() {
  const r = express.Router();

  // ---------------- 6.1 基础 ----------------
  r.get('/health', (req, res) => {
    res.json({ ok: true, version: config.VERSION, buildTime: config.BUILD_TIME || null });
  });

  // ---------------- 6.2 认证 ----------------
  // 登录公钥（无需鉴权）：ephemeral RSA-2048，前端用 RSA-OAEP/SHA-256 加密密码
  r.get('/auth/pubkey', (req, res) => {
    res.json(loginCrypto.getPublicKey());
  });

  r.post('/auth/login', auth.login);

  r.get('/auth/me', auth.requireAuth, (req, res) => {
    res.json({ username: req.user.username, role: req.user.role });
  });

  r.post(
    '/auth/change-password',
    auth.requireAuth,
    wrap(async (req, res) => {
      const { oldPassword, newPassword } = req.body || {};
      if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
        return fail(res, 400, 'INVALID_INPUT', '旧密码与新密码不能为空');
      }
      if (!isValidAccountPassword(newPassword)) {
        return fail(res, 400, 'WEAK_PASSWORD', '新密码至少 8 位，且需同时包含字母和数字');
      }
      const accounts = store.getAccounts();
      const account = accounts.find((a) => a.username === req.user.username);
      if (!account || !bcrypt.compareSync(oldPassword, account.passwordHash)) {
        return fail(res, 400, 'BAD_CREDENTIALS', '旧密码不正确');
      }
      account.passwordHash = bcrypt.hashSync(newPassword, 10);
      store.saveAccounts(accounts);
      res.json({ ok: true });
    })
  );

  // ---------------- 6.3 平台账号（requireAdmin） ----------------
  r.get('/accounts', auth.requireAuth, auth.requireAdmin, (req, res) => {
    res.json(store.getAccounts().map(accountView));
  });

  r.post(
    '/accounts',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const { username, password, role } = req.body || {};
      if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
        return fail(res, 400, 'INVALID_INPUT', '用户名仅允许字母、数字、_ . -，长度 1-64');
      }
      if (!isValidAccountPassword(password)) {
        return fail(res, 400, 'WEAK_PASSWORD', '密码至少 8 位，且需同时包含字母和数字');
      }
      if (!isValidRole(role)) {
        return fail(res, 400, 'INVALID_INPUT', '角色必须是 admin 或 readonly');
      }
      const accounts = store.getAccounts();
      if (accounts.some((a) => a.username === username)) {
        return fail(res, 409, 'DUPLICATE', `账号 ${username} 已存在`);
      }
      const account = {
        username,
        passwordHash: bcrypt.hashSync(password, 10),
        role,
        createdAt: new Date().toISOString(),
      };
      accounts.push(account);
      store.saveAccounts(accounts);
      res.status(201).json(accountView(account));
    })
  );

  r.put(
    '/accounts/:username',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const target = req.params.username;
      const accounts = store.getAccounts();
      const account = accounts.find((a) => a.username === target);
      if (!account) {
        return fail(res, 404, 'NOT_FOUND', `账号 ${target} 不存在`);
      }
      const { password, role } = req.body || {};
      // 角色变更校验
      if (role !== undefined) {
        if (!isValidRole(role)) {
          return fail(res, 400, 'INVALID_INPUT', '角色必须是 admin 或 readonly');
        }
        if (target === req.user.username && role !== 'admin') {
          return fail(res, 400, 'FORBIDDEN', '不能把自己改成 readonly');
        }
        if (account.role === 'admin' && role !== 'admin') {
          const adminCount = accounts.filter((a) => a.role === 'admin').length;
          if (adminCount <= 1) {
            return fail(res, 400, 'FORBIDDEN', '至少保留一个 admin 账号');
          }
        }
        account.role = role;
      }
      // 密码重置
      if (password !== undefined && password !== null && password !== '') {
        if (!isValidAccountPassword(password)) {
          return fail(res, 400, 'WEAK_PASSWORD', '密码至少 8 位，且需同时包含字母和数字');
        }
        account.passwordHash = bcrypt.hashSync(password, 10);
      }
      store.saveAccounts(accounts);
      res.json({ ok: true });
    })
  );

  r.delete(
    '/accounts/:username',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const target = req.params.username;
      if (target === req.user.username) {
        return fail(res, 400, 'FORBIDDEN', '不能删除当前登录账号（自己）');
      }
      const accounts = store.getAccounts();
      const account = accounts.find((a) => a.username === target);
      if (!account) {
        return fail(res, 404, 'NOT_FOUND', `账号 ${target} 不存在`);
      }
      if (account.role === 'admin') {
        const adminCount = accounts.filter((a) => a.role === 'admin').length;
        if (adminCount <= 1) {
          return fail(res, 400, 'FORBIDDEN', '至少保留一个 admin 账号');
        }
      }
      store.saveAccounts(accounts.filter((a) => a.username !== target));
      res.json({ ok: true });
    })
  );

  // ---------------- 6.4 集群管理 ----------------
  // 列表（readonly 可用；永不返回密码）
  r.get('/clusters', auth.requireAuth, (req, res) => {
    const list = store.getClusters().map((c) => ({
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      createdAt: c.createdAt,
    }));
    res.json(list);
  });

  /** 校验集群表单字段 */
  function validateClusterInput(body, partial) {
    const out = {};
    if (!partial || body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return { error: '集群名称不能为空' };
      }
      out.name = body.name.trim();
    }
    if (!partial || body.host !== undefined) {
      if (typeof body.host !== 'string' || !/^[A-Za-z0-9_.:-]{1,255}$/.test(body.host)) {
        return { error: '主机地址格式不正确' };
      }
      out.host = body.host;
    }
    if (!partial || body.port !== undefined) {
      const port = Number(body.port === undefined ? 9030 : body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: '端口必须是 1-65535 的整数' };
      }
      out.port = port;
    }
    if (!partial || body.username !== undefined) {
      if (typeof body.username !== 'string' || !body.username) {
        return { error: '连接用户名不能为空' };
      }
      out.username = body.username;
    }
    if (!partial || body.password !== undefined) {
      if (typeof body.password !== 'string') {
        return { error: '连接密码格式不正确' };
      }
      out.password = body.password;
    }
    return { value: out };
  }

  r.post(
    '/clusters',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const { value, error } = validateClusterInput(req.body || {}, false);
      if (error) return fail(res, 400, 'INVALID_INPUT', error);

      // 创建前实测连接，失败返回 400 与中文原因
      const test = await doris.testConnection(value);
      if (!test.ok) {
        return fail(res, 400, 'CONNECT_FAILED', `无法连接到 Doris（${value.host}:${value.port}）：${test.error}`);
      }

      const cluster = {
        id: crypto.randomUUID(),
        name: value.name,
        host: value.host,
        port: value.port,
        username: value.username,
        passwordEnc: store.encryptPassword(value.password),
        createdAt: new Date().toISOString(),
      };
      const clusters = store.getClusters();
      clusters.push(cluster);
      store.saveClusters(clusters);
      res.status(201).json({
        id: cluster.id,
        name: cluster.name,
        host: cluster.host,
        port: cluster.port,
        username: cluster.username,
        createdAt: cluster.createdAt,
      });
    })
  );

  r.put(
    '/clusters/:id',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const clusters = store.getClusters();
      const cluster = clusters.find((c) => c.id === req.params.id);
      if (!cluster) return fail(res, 404, 'NOT_FOUND', '集群不存在');

      const { value, error } = validateClusterInput(req.body || {}, true);
      if (error) return fail(res, 400, 'INVALID_INPUT', error);

      // 连接信息是否变化（变了需要重测连接并重建连接池）
      const connChanged =
        value.host !== undefined ||
        value.port !== undefined ||
        value.username !== undefined ||
        value.password !== undefined;

      if (connChanged) {
        const merged = {
          host: value.host !== undefined ? value.host : cluster.host,
          port: value.port !== undefined ? value.port : cluster.port,
          username: value.username !== undefined ? value.username : cluster.username,
          password:
            value.password !== undefined ? value.password : store.decryptPassword(cluster.passwordEnc),
        };
        const test = await doris.testConnection(merged);
        if (!test.ok) {
          return fail(res, 400, 'CONNECT_FAILED', `无法连接到 Doris（${merged.host}:${merged.port}）：${test.error}`);
        }
        await doris.destroyPool(cluster.id); // 旧池销毁，下次用新信息重建
        cluster.host = merged.host;
        cluster.port = merged.port;
        cluster.username = merged.username;
        if (value.password !== undefined) {
          cluster.passwordEnc = store.encryptPassword(value.password);
        }
      }
      if (value.name !== undefined) cluster.name = value.name;

      store.saveClusters(clusters);
      res.json({
        id: cluster.id,
        name: cluster.name,
        host: cluster.host,
        port: cluster.port,
        username: cluster.username,
        createdAt: cluster.createdAt,
      });
    })
  );

  r.delete(
    '/clusters/:id',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const clusters = store.getClusters();
      const cluster = clusters.find((c) => c.id === req.params.id);
      if (!cluster) return fail(res, 404, 'NOT_FOUND', '集群不存在');
      await doris.destroyPool(cluster.id); // 删除时销毁连接池
      store.saveClusters(clusters.filter((c) => c.id !== cluster.id));
      store.clearDisabledByCluster(cluster.id); // 集群删除后清空其全部禁用标记
      res.json({ ok: true });
    })
  );

  // 测试连接（readonly 可用）
  r.post(
    '/clusters/:id/test',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const result = await doris.testConnection(cluster);
      if (result.ok) {
        // 向后兼容：保留 version（协议版本），新增 dorisVersion（真实 Doris 版本）
        res.json({ ok: true, version: result.version, dorisVersion: result.dorisVersion });
      } else {
        res.json({ ok: false, error: result.error });
      }
    })
  );

  // ---------------- 6.5 Doris 元数据 ----------------
  r.get(
    '/c/:clusterId/catalogs',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const list = await dorisCall(() => doris.showCatalogs(cluster));
      res.json(list);
    })
  );

  r.get(
    '/c/:clusterId/databases',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const catalog = req.query.catalog;
      if (!catalog) return fail(res, 400, 'INVALID_INPUT', '缺少 catalog 查询参数');
      const list = await dorisCall(() => doris.showDatabases(cluster, catalog));
      res.json(list);
    })
  );

  r.get(
    '/c/:clusterId/tables',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { catalog, db } = req.query;
      if (!catalog || !db) return fail(res, 400, 'INVALID_INPUT', '缺少 catalog 或 db 查询参数');
      const list = await dorisCall(() => doris.showTables(cluster, catalog, db));
      res.json(list);
    })
  );

  // ---------------- 6.6 用户管理 ----------------
  // 用户列表：SHOW ALL GRANTS 按用户名分组；失败降级 mysql.user
  r.get(
    '/c/:clusterId/users',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;

      let rows = null;
      let degraded = false;
      try {
        rows = await doris.showAllGrants(cluster);
      } catch (err) {
        degraded = true; // 降级路径
      }

      const byUser = new Map();
      if (!degraded) {
        for (const raw of rows) {
          const parsed = grantsParser.parseShowGrantsRow(raw);
          // 无法解析出用户名时跳过（防御）
          if (!parsed.user) continue;
          if (!byUser.has(parsed.user)) byUser.set(parsed.user, []);
          byUser.get(parsed.user).push({
            host: parsed.host,
            roles: parsed.roles,
            grantCount: parsed.grants.length,
            raw,
          });
        }
      } else {
        // 降级：SELECT User, Host FROM mysql.user，只取 User/Host
        try {
          const fallbackRows = await doris.mysqlUserFallback(cluster);
          for (const raw of fallbackRows) {
            const user = raw.User != null ? String(raw.User) : null;
            const host = raw.Host != null ? String(raw.Host) : null;
            if (!user) continue;
            if (!byUser.has(user)) byUser.set(user, []);
            byUser.get(user).push({ host, roles: [], grantCount: 0, raw });
          }
        } catch (err) {
          return fail(res, 502, 'DORIS_ERROR', `获取用户列表失败：${err.message}`);
        }
      }

      // 合并本地禁用状态（与前端 Core06 契约：disabled / disabledAt / disabledBy，
      // 按 clusterId+user+host 匹配；未禁用的条目 disabled=false，其余为 null）
      const disabledMap = new Map();
      for (const d of store.listDisabled(cluster.id)) {
        if (d && d.user != null && d.host != null) {
          disabledMap.set(`${d.user}\n${d.host}`, d);
        }
      }
      const list = [...byUser.entries()]
        .map(([user, hosts]) => ({
          user,
          hosts: hosts.map((h) => {
            const d = disabledMap.get(`${user}\n${h.host}`);
            return {
              ...h,
              disabled: !!d,
              disabledAt: d ? d.disabledAt || null : null,
              disabledBy: d ? d.disabledBy || null : null,
            };
          }),
        }))
        .sort((a, b) => a.user.localeCompare(b.user));
      res.json(list);
    })
  );

  // 用户授权详情（解析结构 + raw）
  r.get(
    '/c/:clusterId/users/:user/:host/grants',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user, host } = req.params;
      const rows = await dorisCall(() => doris.showGrantsFor(cluster, user, host));
      if (!rows || rows.length === 0) {
        return fail(res, 404, 'NOT_FOUND', `用户 '${user}'@'${host}' 不存在或无授权信息`);
      }
      const parsed = grantsParser.parseShowGrantsRow(rows[0]);
      parsed.raw = rows[0];
      res.json(parsed);
    })
  );

  // 用户属性（真机探测：SHOW PROPERTY 只支持按用户名，不支持 'user'@'host'）
  r.get(
    '/c/:clusterId/users/:user/:host/property',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user } = req.params;
      const rows = await dorisCall(() => doris.showPropertyFor(cluster, user));
      res.json(rows);
    })
  );

  // 用户属性更新预览（纯计算，不触碰 Doris 写路径）
  r.post(
    '/c/:clusterId/users/:user/:host/property/preview',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user } = req.params;
      assertNotProtectedUser(user); // 内置账号 root/admin 仅可查看（属性按用户名生效）
      const sql = genSql(() => sqlgen.buildSetPropertySql(user, req.body.properties || {}));
      res.json({ sql });
    })
  );

  // 用户属性更新执行（confirm:true，逐条执行并写审计）
  r.put(
    '/c/:clusterId/users/:user/:host/property',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user } = req.params;
      assertNotProtectedUser(user); // 内置账号 root/admin 仅可查看（属性按用户名生效）
      if (!requireConfirm(req, res)) return;
      const sql = genSql(() => sqlgen.buildSetPropertySql(user, req.body.properties || {}));
      if (sql.length === 0) return res.json({ results: [] });
      const results = await dorisCall(() => executeSqlList(req, cluster, 'set_property', sql));
      res.json({ results });
    })
  );

  // 创建用户预览（纯计算，不触碰 Doris 写路径）
  r.post(
    '/c/:clusterId/users/preview',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const sql = genSql(() =>
        sqlgen.buildCreateUserSql({
          user: req.body.user,
          hosts: req.body.hosts,
          password: req.body.password,
          roles: req.body.roles || [],
          grants: req.body.grants || [],
        })
      );
      res.json({ sql });
    })
  );

  // 创建用户执行（confirm:true）
  r.post(
    '/c/:clusterId/users',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      assertNotProtectedUser(req.body && req.body.user); // 内置账号 root/admin 禁止平台内创建/重建
      if (!requireConfirm(req, res)) return;
      const sql = genSql(() =>
        sqlgen.buildCreateUserSql({
          user: req.body.user,
          hosts: req.body.hosts,
          password: req.body.password,
          roles: req.body.roles || [],
          grants: req.body.grants || [],
        })
      );
      const results = await dorisCall(() => executeSqlList(req, cluster, 'create_user', sql));
      // 同 user@host 重建视为启用：成功后清除其本地禁用标记
      if (results.every((x) => x.ok) && Array.isArray(req.body.hosts)) {
        for (const h of req.body.hosts) {
          store.clearDisabled(cluster.id, req.body.user, h);
        }
      }
      res.json({ results });
    })
  );

  /**
   * 更新授权预览：服务器先 SHOW GRANTS 取当前值，再 diff
   * 注意防御：body 中 roles / grants 缺省（null/undefined）时视为"不修改该项"，
   * 避免只想改密码却误清空全部授权。
   */
  async function buildUserUpdate(req, cluster, user, host) {
    const rows = await dorisCall(() => doris.showGrantsFor(cluster, user, host));
    if (!rows || rows.length === 0) {
      const err = new Error(`用户 '${user}'@'${host}' 不存在或无授权信息`);
      err.status = 404;
      throw err;
    }
    const current = grantsParser.parseShowGrantsRow(rows[0]);
    const desired = {
      roles: Array.isArray(req.body.roles) ? req.body.roles : current.roles,
      grants: Array.isArray(req.body.grants) ? req.body.grants : current.grants,
    };
    const password =
      typeof req.body.password === 'string' && req.body.password !== '' ? req.body.password : null;
    const sql = genSql(() =>
      sqlgen.buildUpdateUserSql({ user, host, current, desired, password })
    );
    return { sql, current };
  }

  r.post(
    '/c/:clusterId/users/:user/:host/preview-update',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user, host } = req.params;
      assertNotProtectedUser(user); // 内置账号 root/admin 仅可查看
      const { sql, current } = await buildUserUpdate(req, cluster, user, host);
      res.json({ sql, current });
    })
  );

  r.put(
    '/c/:clusterId/users/:user/:host',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user, host } = req.params;
      assertNotProtectedUser(user); // 内置账号 root/admin 仅可查看
      if (!requireConfirm(req, res)) return;
      // 改密 = 启用：仅当本次请求携带新密码时，成功后解除本地禁用标记
      const hasNewPassword = typeof req.body.password === 'string' && req.body.password !== '';
      const { sql } = await buildUserUpdate(req, cluster, user, host);
      if (sql.length === 0) return res.json({ results: [] });
      const results = await dorisCall(() => executeSqlList(req, cluster, 'update_user', sql));
      if (hasNewPassword && results.every((x) => x.ok)) {
        store.clearDisabled(cluster.id, user, host);
      }
      res.json({ results });
    })
  );

  // 重置密码：dryRun:true 时只返回 sql 不执行
  r.post(
    '/c/:clusterId/users/:user/:host/password',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user, host } = req.params;
      assertNotProtectedUser(user); // 内置账号 root/admin 禁止平台内改密
      const { password, dryRun } = req.body || {};
      const sql = genSql(() => sqlgen.buildChangePasswordSql(user, host, password));
      if (dryRun === true) {
        return res.json({ sql });
      }
      const results = await dorisCall(() => executeSqlList(req, cluster, 'alter_password', sql));
      // 改密 = 启用：成功后解除本地禁用标记
      if (results.every((x) => x.ok)) {
        store.clearDisabled(cluster.id, user, host);
      }
      res.json({ results });
    })
  );

  // 删除用户（confirm:true）
  r.delete(
    '/c/:clusterId/users/:user/:host',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user, host } = req.params;
      assertNotProtectedUser(user); // 内置账号 root/admin 禁止删除
      if (!requireConfirm(req, res)) return;
      const sql = genSql(() => sqlgen.buildDropUserSql(user, host));
      const results = await dorisCall(() => executeSqlList(req, cluster, 'drop_user', sql));
      // 用户已删除：清理其本地禁用标记
      if (results.every((x) => x.ok)) {
        store.clearDisabled(cluster.id, user, host);
      }
      res.json({ results });
    })
  );

  // 禁用登录（admin）：Doris 3.0.6 无 ACCOUNT LOCK 语法，
  // 等效方案 = 服务器侧生成 16 位随机强密码并 SET PASSWORD。
  // 密码不返回、不写日志明文（审计 SQL 经 store 统一出口脱敏）。
  r.post(
    '/c/:clusterId/users/:user/:host/disable',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { user, host } = req.params;
      assertNotProtectedUser(user); // 内置账号 root/admin 禁止禁用（等效随机改密）
      const randomPwd = generatePassword(); // 16 位强随机密码，用后即弃
      const sql = genSql(() => sqlgen.buildChangePasswordSql(user, host, randomPwd));
      const results = await dorisCall(() => executeSqlList(req, cluster, 'disable_login', sql));
      if (!results.every((x) => x.ok)) {
        return fail(res, 502, 'DORIS_ERROR', `禁用登录失败：${(results.find((x) => !x.ok) || {}).error || '未知错误'}`);
      }
      // Doris 无禁用标记，平台本地记录禁用状态（by = 当前登录账号）
      store.markDisabled(cluster.id, user, host, req.user.username);
      res.json({ ok: true, message: '已禁用登录，密码已随机化。启用请使用「重置密码」' });
    })
  );

  // ---------------- 6.7 角色管理 ----------------
  r.get(
    '/c/:clusterId/roles',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const rows = await dorisCall(() => doris.showRoles(cluster));
      res.json(rows);
    })
  );

  /**
   * 从 SHOW ROLES 结果中找指定角色行（Doris 3.0.6 没有 SHOW GRANTS FOR ROLE 语法，
   * 角色授权只能解析 SHOW ROLES 中该角色那一行的各 Privs 列）。
   * 角色名大小写不敏感匹配；找不到返回 null。
   */
  async function findRoleRow(cluster, role) {
    const rows = await dorisCall(() => doris.showRoles(cluster));
    const target = String(role).toLowerCase();
    for (const row of rows || []) {
      const nameKey = Object.keys(row).find((k) => String(k).toLowerCase() === 'name');
      const name = nameKey != null ? row[nameKey] : null;
      if (name != null && String(name).toLowerCase() === target) return row;
    }
    return null;
  }

  /** 把 SHOW ROLES 的角色行解析成与用户授权详情相同的结构（roles 字段对该接口无意义，恒为空） */
  function parseRoleRow(row) {
    const parsed = grantsParser.parseShowGrantsRow(row);
    parsed.roles = [];
    parsed.raw = row;
    return parsed;
  }

  r.get(
    '/c/:clusterId/roles/:role/grants',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const row = await findRoleRow(cluster, req.params.role);
      if (!row) {
        return fail(res, 404, 'NOT_FOUND', `角色 '${req.params.role}' 不存在或无授权信息`);
      }
      res.json(parseRoleRow(row));
    })
  );

  // 角色成员：扫描 SHOW ALL GRANTS 的 Roles 列
  r.get(
    '/c/:clusterId/roles/:role/members',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const target = String(req.params.role).toLowerCase();
      const rows = await dorisCall(() => doris.showAllGrants(cluster));
      const members = [];
      for (const raw of rows) {
        const parsed = grantsParser.parseShowGrantsRow(raw);
        if (parsed.roles.some((r) => r.toLowerCase() === target)) {
          members.push(parsed.userIdentity);
        }
      }
      res.json(members);
    })
  );

  r.post(
    '/c/:clusterId/roles/preview',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const sql = genSql(() =>
        sqlgen.buildCreateRoleSql({
          role: req.body.role,
          comment: req.body.comment || '',
          grants: req.body.grants || [],
        })
      );
      res.json({ sql });
    })
  );

  r.post(
    '/c/:clusterId/roles',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      if (!requireConfirm(req, res)) return;
      const sql = genSql(() =>
        sqlgen.buildCreateRoleSql({
          role: req.body.role,
          comment: req.body.comment || '',
          grants: req.body.grants || [],
        })
      );
      const results = await dorisCall(() => executeSqlList(req, cluster, 'create_role', sql));
      res.json({ results });
    })
  );

  /** 角色更新 diff：当前值来自 SHOW ROLES 中该角色行（3.0.6 无 SHOW GRANTS FOR ROLE） */
  async function buildRoleUpdate(req, cluster, role) {
    const row = await findRoleRow(cluster, role);
    if (!row) {
      const err = new Error(`角色 '${role}' 不存在或无授权信息`);
      err.status = 404;
      throw err;
    }
    const current = parseRoleRow(row);
    const desiredGrants = Array.isArray(req.body.grants) ? req.body.grants : current.grants;
    const sql = genSql(() =>
      sqlgen.buildUpdateRoleSql({ role, current, desired: { grants: desiredGrants } })
    );
    return { sql, current };
  }

  r.post(
    '/c/:clusterId/roles/:role/preview-update',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const { sql, current } = await buildRoleUpdate(req, cluster, req.params.role);
      res.json({ sql, current });
    })
  );

  r.put(
    '/c/:clusterId/roles/:role',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      if (!requireConfirm(req, res)) return;
      const { sql } = await buildRoleUpdate(req, cluster, req.params.role);
      if (sql.length === 0) return res.json({ results: [] });
      const results = await dorisCall(() => executeSqlList(req, cluster, 'update_role', sql));
      res.json({ results });
    })
  );

  r.delete(
    '/c/:clusterId/roles/:role',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const role = req.params.role;
      // 内置角色禁止删除（后端拦截，与前端禁用双重保障）
      if (BUILTIN_ROLES.includes(String(role).toLowerCase())) {
        return fail(res, 400, 'FORBIDDEN', `内置角色 ${role} 禁止删除`);
      }
      if (!requireConfirm(req, res)) return;
      const sql = genSql(() => sqlgen.buildDropRoleSql(role));
      const results = await dorisCall(() => executeSqlList(req, cluster, 'drop_role', sql));
      res.json({ results });
    })
  );

  // ---------------- 6.7b 权限项清单（readonly 可用） ----------------
  // SHOW PRIVILEGES → 原始行数组 [{Privilege, Context, Comment}]（Doris 3.0.6 返回 12 行）
  r.get(
    '/c/:clusterId/privileges',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const rows = await dorisCall(() => doris.showPrivileges(cluster));
      res.json(rows);
    })
  );

  // ---------------- 6.7c 负载组清单（readonly 可用） ----------------
  // SHOW WORKLOAD GROUPS → 名字数组 ["normal", ...]（与前端 Core04 契约，结构不变）
  r.get(
    '/c/:clusterId/workload-groups',
    auth.requireAuth,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      const list = await dorisCall(() => doris.showWorkloadGroups(cluster));
      res.json(list);
    })
  );

  // ---------------- 6.8 SQL 控制台（requireAdmin） ----------------
  r.post(
    '/c/:clusterId/execute',
    auth.requireAuth,
    auth.requireAdmin,
    wrapDoris(async (req, res) => {
      const cluster = getCluster(req, res);
      if (!cluster) return;
      let { sql } = req.body || {};
      if (typeof sql !== 'string' || !sql.trim()) {
        return fail(res, 400, 'INVALID_INPUT', 'SQL 不能为空');
      }
      // 仅允许单条语句：去掉末尾分号后不允许再出现分号
      sql = sql.trim().replace(/;+\s*$/, '');
      if (sql.includes(';')) {
        return fail(res, 400, 'MULTI_STATEMENT', 'SQL 控制台一次只能执行一条语句');
      }
      // 内置账号 root/admin 保护：拦截针对其的授权/改密/生命周期/属性语句（403）
      checkConsoleSql(sql);

      const start = Date.now();
      try {
        const { rows, fields } = await doris.queryWithFields(cluster, sql);
        const durationMs = Date.now() - start;
        if (Array.isArray(rows)) {
          // 查询类：整理列名与行数组，超过 1000 行截断
          let columns = [];
          if (Array.isArray(fields) && fields.length > 0) {
            columns = fields.map((f) => f.name);
          } else if (rows.length > 0) {
            columns = Object.keys(rows[0]);
          }
          const truncated = rows.length > config.CONSOLE_ROW_LIMIT;
          const limited = truncated ? rows.slice(0, config.CONSOLE_ROW_LIMIT) : rows;
          const rowArrays = limited.map((row) => columns.map((c) => row[c]));
          audit(req, cluster, 'sql_console', sql, true, null);
          return res.json({ ok: true, kind: 'result', columns, rows: rowArrays, truncated, durationMs });
        }
        // 执行类：OK 包
        audit(req, cluster, 'sql_console', sql, true, null);
        return res.json({
          ok: true,
          kind: 'exec',
          affectedRows: rows.affectedRows != null ? rows.affectedRows : 0,
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - start;
        audit(req, cluster, 'sql_console', sql, false, err.message);
        // 失败也返回 HTTP 200，错误放 body 由前端展示
        return res.json({ ok: false, error: err.message, durationMs });
      }
    })
  );

  // ---------------- 6.9 审计日志（requireAdmin） ----------------
  r.get(
    '/audit',
    auth.requireAuth,
    auth.requireAdmin,
    wrap(async (req, res) => {
      const { clusterId, account } = req.query;
      let page = parseInt(req.query.page || '1', 10);
      let size = parseInt(req.query.size || '50', 10);
      if (!Number.isInteger(page) || page < 1) page = 1;
      if (!Number.isInteger(size) || size < 1 || size > 500) size = 50;

      let items = store.readAudit();
      if (clusterId) items = items.filter((it) => it.clusterId === clusterId);
      if (account) items = items.filter((it) => it.account === account);
      // 时间倒序
      items.sort((a, b) => String(b.time).localeCompare(String(a.time)));

      const total = items.length;
      const start = (page - 1) * size;
      res.json({ total, items: items.slice(start, start + size) });
    })
  );

  return r;
}

module.exports = createRouter;
