// SHOW GRANTS 结果解析器（纯函数模块，防御式，绝不抛异常）
// 依据 SPEC 5.5：
//   - 按列名容错取值（版本间列有差异）：UserIdentity / GlobalPrivs / CatalogPrivs /
//     DatabasePrivs / TablePrivs / ResourcePrivs / Roles 等
//   - 单元格两种风格都要兼容：
//       a) `internal`.`db1`.*: SELECT_PRIV,LOAD_PRIV; `internal`.`db2`.*: ALTER_PRIV
//       b) SELECT_PRIV: true; DROP_PRIV: false
//   - 真机 Doris 3.x/4.x 追加兼容：无反引号两段式目标（internal.information_schema: Select_priv）、
//     大小写混合权限名（归一化为大写）、Password 列 Yes/No、null 单元格
//   - 解析不出的单元格放入 unparsed: [{field, value}]，不抛异常

// ---------------------------------------------------------------------------
// 常量与正则
// ---------------------------------------------------------------------------

// 布尔风格单元格段：PRIV_NAME: true / PRIV_NAME: false
const BOOL_SEGMENT_RE = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(true|false)\s*$/i;

// 纯星号目标：*.* / *.*.*
const ALL_STAR_RE = /^\*(?:\.\*)*$/;

// RESOURCE 目标前缀
const RESOURCE_PREFIX_RE = /^resource\s+/i;

// WITH GRANT OPTION 短语
const GRANT_OPTION_RE = /\bwith\s+grant\s+option\b/i;

// 字段名 → 隐含层级（列名统一小写后匹配）
const FIELD_LEVELS = {
  globalprivs: 'global',
  catalogprivs: 'catalog',
  databaseprivs: 'database',
  tableprivs: 'table',
  resourceprivs: 'resource',
};

// 命名对象权限列（真机 Doris 3.0.6 已验证格式 `normal: Usage_priv`）：
// 列名（小写）→ { level, nameKey }，解析为 {level, <nameKey>: 名字, privileges:[...]}
const NAMED_GROUP_FIELDS = {
  workloadgroupprivs: { level: 'workload_group', nameKey: 'workloadGroup' },
  computegroupprivs: { level: 'compute_group', nameKey: 'computeGroup' },
  storagevaultprivs: { level: 'storage_vault', nameKey: 'storageVault' },
};

// 本项目不建模、但 Doris 可能返回的列：非空时进 unparsed 供界面展示
// （真机探测：ColPrivs / CloudClusterPrivs / CloudStagePrivs 也不解析，原样透传）
const PASSTHROUGH_FIELDS = [
  'colprivs',
  'cloudclusterprivs',
  'cloudstageprivs',
];

// 裸标识符允许的安全字符（不含点号，点号是路径分隔符）
const BARE_IDENT_RE = /^[A-Za-z0-9_$%-]+$/;

// ---------------------------------------------------------------------------
// 基础解析工具
// ---------------------------------------------------------------------------

/**
 * 权限名规范化：去空白并转大写（Doris 各版本大小写不一，如 Select_priv）
 */
function normPriv(name) {
  return String(name).trim().toUpperCase();
}

/**
 * 解析逗号分隔的权限列表，如 "SELECT_PRIV, LOAD_PRIV"
 * 同时识别尾部的 WITH GRANT OPTION 短语。
 * @returns {{privs: string[], grantOption: boolean} | null} 无法解析返回 null
 */
function parsePrivTokens(text) {
  let s = String(text).trim();
  let grantOption = false;
  if (GRANT_OPTION_RE.test(s)) {
    grantOption = true;
    s = s.replace(GRANT_OPTION_RE, '').trim();
  }
  if (!s) return null;
  const tokens = s.split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  for (const t of tokens) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) return null;
  }
  return { privs: tokens.map(normPriv), grantOption };
}

/**
 * 解析反引号路径目标，如 `internal`.`db1`.* 或 *.*.*
 * @returns {Array<{star?:true, ident?:string}> | null} 失败返回 null
 */
function splitTargetPath(s) {
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '*') {
      tokens.push({ star: true });
      i++;
    } else if (ch === '`') {
      i++;
      let buf = '';
      let closed = false;
      while (i < n) {
        if (s[i] === '`') {
          // 双反引号是转义的反引号
          if (s[i + 1] === '`') {
            buf += '`';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        buf += s[i];
        i++;
      }
      if (!closed) return null;
      tokens.push({ ident: buf });
    } else if (ch === '.' || ch === ' ' || ch === '\t') {
      i++; // 分隔符与空白直接跳过
    } else {
      return null; // 非法字符
    }
  }
  return tokens.length > 0 ? tokens : null;
}

/**
 * 解析单引号 / 反引号包裹的名字（用于 RESOURCE 'name'）
 */
function parseQuotedName(s) {
  const t = s.trim();
  if (t === '*') return '*';
  if (t.startsWith("'")) {
    // 单引号字符串，处理 \' 与 \\ 转义
    let buf = '';
    for (let i = 1; i < t.length; i++) {
      const c = t[i];
      if (c === '\\' && i + 1 < t.length) {
        buf += t[i + 1];
        i++;
        continue;
      }
      if (c === "'") {
        // 必须正好结束
        return t.slice(i + 1).trim() === '' ? buf : null;
      }
      buf += c;
    }
    return null;
  }
  if (t.startsWith('`')) {
    const m = t.match(/^`((?:[^`]|``)*)`$/);
    if (!m) return null;
    return m[1].replace(/``/g, '`');
  }
  // 裸名
  if (/^[A-Za-z0-9_$.%-]+$/.test(t)) return t;
  return null;
}

/**
 * 生成一条授权项骨架
 */
function makeGrant(level, parts) {
  return {
    level,
    catalog: parts.catalog != null ? parts.catalog : null,
    database: parts.database != null ? parts.database : null,
    table: parts.table != null ? parts.table : null,
    resource: parts.resource != null ? parts.resource : null,
    workloadGroup: parts.workloadGroup != null ? parts.workloadGroup : null,
    computeGroup: parts.computeGroup != null ? parts.computeGroup : null,
    storageVault: parts.storageVault != null ? parts.storageVault : null,
    privileges: parts.privileges || [],
    grantOption: !!parts.grantOption,
  };
}

/**
 * 解析无反引号的裸路径目标（真机 Doris 3.x/4.x 真实格式）
 * 真机探测样例：
 *   - DatabasePrivs: "internal.information_schema"（两段式 catalog.db，无 .* 后缀）
 *   - TablePrivs:    "internal.db1.t1"（三段式）
 *   - CatalogPrivs:  "hive"（单段）
 * 星号段只允许出现在末尾（如 internal.db.*），其余情况判为无法解析。
 * @param {string} t 目标串（已 trim）
 * @param {string} impliedLevel 字段隐含层级
 * @returns 授权项骨架或 null
 */
function parseBareTarget(t, impliedLevel) {
  if (t === '' || t.includes('`') || t.includes("'")) return null;
  const segs = t.split('.').map((s) => s.trim());
  // 去掉末尾的 * 段（通配后缀）
  while (segs.length > 0 && segs[segs.length - 1] === '*') segs.pop();
  if (segs.length === 0) return null; // 纯星号在上层已处理
  // 中间不允许再出现 *，且每段必须是合法裸标识符
  for (const s of segs) {
    if (s === '*' || !BARE_IDENT_RE.test(s)) return null;
  }
  // 按字段隐含层级解释段数
  if (impliedLevel === 'database') {
    if (segs.length === 2) return makeGrant('database', { catalog: segs[0], database: segs[1] });
    if (segs.length === 1) return makeGrant('database', { catalog: null, database: segs[0] });
    return null;
  }
  if (impliedLevel === 'table') {
    if (segs.length === 3) {
      return makeGrant('table', { catalog: segs[0], database: segs[1], table: segs[2] });
    }
    if (segs.length === 2) return makeGrant('table', { catalog: null, database: segs[0], table: segs[1] });
    return null;
  }
  if (impliedLevel === 'catalog') {
    if (segs.length === 1) return makeGrant('catalog', { catalog: segs[0] });
    return null;
  }
  return null;
}

/**
 * 解析目标字符串为授权项骨架（不含权限）
 * @param {string} targetStr 目标串，如 `internal`.`db1`.* / internal.db1 / RESOURCE 'r' / *.*.*
 * @param {string} impliedLevel 字段隐含层级（用于裸名单标识符等兜底场景）
 */
function parseTarget(targetStr, impliedLevel) {
  const t = String(targetStr).trim();

  // 全局：*.*.* / *.*
  if (ALL_STAR_RE.test(t)) {
    return makeGrant('global', {});
  }

  // RESOURCE 'name' / RESOURCE `name` / RESOURCE name
  if (RESOURCE_PREFIX_RE.test(t)) {
    const name = parseQuotedName(t.replace(RESOURCE_PREFIX_RE, ''));
    if (name == null) return null;
    return makeGrant('resource', { resource: name });
  }

  // 反引号路径
  const tokens = splitTargetPath(t);
  if (!tokens) {
    // 真机格式回退：无反引号的裸路径（internal.db / internal.db.tbl / hive）
    return parseBareTarget(t, impliedLevel);
  }

  const idents = tokens.filter((x) => x.ident !== undefined).map((x) => x.ident);
  const stars = tokens.filter((x) => x.star).length;

  if (tokens.length === 3) {
    if (idents.length === 1 && stars === 2) {
      return makeGrant('catalog', { catalog: idents[0] });
    }
    if (idents.length === 2 && stars === 1) {
      return makeGrant('database', { catalog: idents[0], database: idents[1] });
    }
    if (idents.length === 3 && stars === 0) {
      return makeGrant('table', { catalog: idents[0], database: idents[1], table: idents[2] });
    }
    return null;
  }
  if (tokens.length === 2 && idents.length === 1 && stars === 1) {
    // 老版本两段式 `db`.*：按数据库层级处理，catalog 置空
    return makeGrant('database', { catalog: null, database: idents[0] });
  }
  if (tokens.length === 1 && idents.length === 1) {
    // 裸单标识符：仅在资源字段中视为资源名
    if (impliedLevel === 'resource') {
      return makeGrant('resource', { resource: idents[0] });
    }
    return null;
  }
  if (tokens.length >= 1 && stars === tokens.length) {
    return makeGrant('global', {});
  }
  return null;
}

/**
 * 在字符串中寻找"顶层"冒号位置（跳过引号与反引号内的内容）
 * @returns 找不到返回 -1
 */
function findTopColon(s) {
  let inBacktick = false;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\') {
        i++; // 跳过转义字符
      } else if (c === "'") {
        inQuote = false;
      }
      continue;
    }
    if (inBacktick) {
      if (c === '`') {
        if (s[i + 1] === '`') {
          i++; // 双反引号转义
        } else {
          inBacktick = false;
        }
      }
      continue;
    }
    if (c === '`') inBacktick = true;
    else if (c === "'") inQuote = true;
    else if (c === ':') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 单元格解析
// ---------------------------------------------------------------------------

/**
 * 把权限并入一条"隐含层级"授权项（用于布尔风格 / 纯权限列表等无目标信息的场景）
 * 同一隐含层级的项会合并权限列表。
 */
function mergeImpliedGrant(grants, level, privs, grantOption) {
  const existing = grants.find(
    (g) =>
      g.level === level &&
      g.catalog == null &&
      g.database == null &&
      g.table == null &&
      g.resource == null
  );
  if (existing) {
    // 保留原始出现顺序，仅做去重追加（集合语义交给 sqlgen 的 diff 处理）
    for (const p of privs) {
      if (!existing.privileges.includes(p)) existing.privileges.push(p);
    }
    existing.grantOption = existing.grantOption || grantOption;
  } else {
    grants.push(makeGrant(level, { privileges: privs.slice(), grantOption }));
  }
}

/**
 * 解析一个权限单元格（GlobalPrivs / CatalogPrivs / DatabasePrivs / TablePrivs / ResourcePrivs）
 * @param {string} field 原始列名（用于 unparsed 记录）
 * @param {*} rawValue 单元格原始值
 * @param {string} impliedLevel 字段隐含层级
 * @param {{grants: Array, unparsed: Array}} out 输出容器
 */
function parsePrivsCell(field, rawValue, impliedLevel, out) {
  if (rawValue == null) return;
  const cell = String(rawValue).trim();
  if (cell === '' || cell.toUpperCase() === 'NULL') return;

  const segments = cell.split(';').map((s) => s.trim()).filter((s) => s !== '');
  if (segments.length === 0) return;

  // 风格 b：整格都是 "PRIV: true/false" 布尔段
  if (segments.every((s) => BOOL_SEGMENT_RE.test(s))) {
    const privs = [];
    for (const s of segments) {
      const m = s.match(BOOL_SEGMENT_RE);
      if (m[2].toLowerCase() === 'true') privs.push(normPriv(m[1]));
    }
    if (privs.length > 0) mergeImpliedGrant(out.grants, impliedLevel, privs, false);
    return;
  }

  // 风格 a 与混合格式：逐段处理
  for (const seg of segments) {
    // 混合情况下的布尔段：true 的权限并入隐含层级
    const boolMatch = seg.match(BOOL_SEGMENT_RE);
    if (boolMatch) {
      if (boolMatch[2].toLowerCase() === 'true') {
        mergeImpliedGrant(out.grants, impliedLevel, [normPriv(boolMatch[1])], false);
      }
      continue;
    }

    const colonIdx = findTopColon(seg);
    if (colonIdx === -1) {
      // 无目标前缀：纯权限列表（如 GlobalPrivs: SELECT_PRIV,LOAD_PRIV）
      const parsed = parsePrivTokens(seg);
      if (parsed) {
        mergeImpliedGrant(out.grants, impliedLevel, parsed.privs, parsed.grantOption);
      } else {
        out.unparsed.push({ field, value: seg });
      }
      continue;
    }

    const targetStr = seg.slice(0, colonIdx).trim();
    const privStr = seg.slice(colonIdx + 1).trim();
    const target = parseTarget(targetStr, impliedLevel);
    const parsed = parsePrivTokens(privStr);
    if (!target || !parsed) {
      out.unparsed.push({ field, value: seg });
      continue;
    }
    target.privileges = parsed.privs;
    target.grantOption = parsed.grantOption;
    out.grants.push(target);
  }
}

/**
 * 解析命名对象权限单元格（WorkloadGroupPrivs / ComputeGroupPrivs / StorageVaultPrivs）
 * 真机 Doris 3.0.6 已验证格式：`normal: Usage_priv`（名字: 权限列表；多段以 ; 分隔）。
 * 解析结果：{level, <nameKey>: 名字, privileges:[...], grantOption:false}，不再进 unparsed。
 * @param {string} field 原始列名（用于 unparsed 记录）
 * @param {*} rawValue 单元格原始值
 * @param {{level:string, nameKey:string}} spec 目标层级与字段名
 * @param {{grants: Array, unparsed: Array}} out 输出容器
 */
function parseNamedPrivsCell(field, rawValue, spec, out) {
  if (rawValue == null) return;
  const cell = String(rawValue).trim();
  if (cell === '' || cell.toUpperCase() === 'NULL') return;

  const segments = cell.split(';').map((s) => s.trim()).filter((s) => s !== '');
  for (const seg of segments) {
    const colonIdx = findTopColon(seg);
    if (colonIdx === -1) {
      // 无 "名字: 权限" 结构，无法解析
      out.unparsed.push({ field, value: seg });
      continue;
    }
    const name = parseQuotedName(seg.slice(0, colonIdx).trim());
    const parsed = parsePrivTokens(seg.slice(colonIdx + 1).trim());
    if (name == null || name === '*' || !parsed) {
      out.unparsed.push({ field, value: seg });
      continue;
    }
    out.grants.push(
      makeGrant(spec.level, {
        [spec.nameKey]: name,
        privileges: parsed.privs,
        grantOption: parsed.grantOption,
      })
    );
  }
}

/**
 * 解析 Roles 单元格：形如 `role1`,`role2` 或 role1, role2
 * @returns {string[]} 角色名数组
 */
function parseRolesCell(rawValue) {
  if (rawValue == null) return [];
  const cell = String(rawValue).trim();
  if (cell === '' || cell.toUpperCase() === 'NULL') return [];
  const roles = [];
  for (const part of cell.split(',')) {
    let t = part.trim();
    if (!t) continue;
    // 去掉成对的反引号或引号
    const backtick = t.match(/^`((?:[^`]|``)*)`$/);
    const quote = t.match(/^'((?:[^'\\]|\\.)*)'$/);
    if (backtick) t = backtick[1].replace(/``/g, '`');
    else if (quote) t = quote[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    t = t.trim();
    if (t) roles.push(t);
  }
  return roles;
}

/**
 * 解析 UserIdentity，如 'devuser'@'10.%'
 * @returns {{user: string|null, host: string|null}}
 */
function parseUserIdentity(identity) {
  const s = String(identity || '');
  const m = s.match(/^\s*'((?:[^'\\]|\\.)*)'\s*@\s*'((?:[^'\\]|\\.)*)'\s*$/);
  if (!m) return { user: null, host: null };
  const unescape = (v) => v.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  return { user: unescape(m[1]), host: unescape(m[2]) };
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 解析一行 SHOW GRANTS / SHOW ALL GRANTS 记录（列名大小写不敏感，防御式，不抛异常）
 * @param {Object} row mysql2 返回的行对象
 * @returns {{userIdentity: string|null, user: string|null, host: string|null,
 *           roles: string[], grants: Array, unparsed: Array<{field:string, value:string}>}}
 */
function parseShowGrantsRow(row) {
  const result = {
    userIdentity: null,
    user: null,
    host: null,
    roles: [],
    grants: [],
    unparsed: [],
  };
  try {
    if (!row || typeof row !== 'object') return result;

    // 建立小写列名索引，兼容版本间列名大小写差异
    const lower = {};
    for (const k of Object.keys(row)) {
      lower[String(k).toLowerCase()] = row[k];
    }

    // 用户标识
    if (lower.useridentity != null) {
      result.userIdentity = String(lower.useridentity);
      const { user, host } = parseUserIdentity(result.userIdentity);
      result.user = user;
      result.host = host;
    }

    // 各权限列
    for (const [fieldKey, level] of Object.entries(FIELD_LEVELS)) {
      if (lower[fieldKey] != null) {
        // unparsed 中记录原始列名，尽量用 row 里实际出现的 key
        const originalKey =
          Object.keys(row).find((k) => String(k).toLowerCase() === fieldKey) || fieldKey;
        parsePrivsCell(originalKey, lower[fieldKey], level, result);
      }
    }

    // 命名对象权限列（负载组 / 计算组 / 存储库）：解析为对应 level 的授权项
    for (const [fieldKey, spec] of Object.entries(NAMED_GROUP_FIELDS)) {
      if (lower[fieldKey] != null) {
        const originalKey =
          Object.keys(row).find((k) => String(k).toLowerCase() === fieldKey) || fieldKey;
        parseNamedPrivsCell(originalKey, lower[fieldKey], spec, result);
      }
    }

    // 不建模的列：非空则进 unparsed 供界面展示原始值
    for (const f of PASSTHROUGH_FIELDS) {
      const v = lower[f];
      if (v != null && String(v).trim() !== '') {
        const originalKey = Object.keys(row).find((k) => String(k).toLowerCase() === f) || f;
        result.unparsed.push({ field: originalKey, value: String(v) });
      }
    }

    // 角色列
    if (lower.roles != null) {
      result.roles = parseRolesCell(lower.roles);
      if (result.roles.length === 0 && String(lower.roles).trim() !== '') {
        result.unparsed.push({ field: 'Roles', value: String(lower.roles) });
      }
    }
  } catch (err) {
    // 防御式兜底：任何意外都不抛出，原始行进 unparsed
    result.unparsed.push({ field: '__row__', value: safeStringify(row) });
  }
  return result;
}

/** 安全的 JSON 序列化（防止循环引用等异常情况） */
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return String(obj);
  }
}

module.exports = {
  parseShowGrantsRow,
  // 导出内部工具便于测试
  parsePrivTokens,
  parseTarget,
  parseRolesCell,
  parseUserIdentity,
};
