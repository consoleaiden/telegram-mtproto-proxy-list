/**
 * MTProxy 代理榜 · Telegram Bot（Cloudflare Worker）
 *
 * 职责：
 *   1. cron 每小时把「校验通过 + 访问速率最快」的代理推送到已绑定的群；
 *   2. webhook 接收菜单按钮 / 回调 / 指令，分页浏览全部代理；
 *   3. 自注册 webhook（Worker 在 CF 边缘可直接访问 Telegram，本地网络可能不通）。
 *
 * 交互设计：
 *   · 主入口是「菜单」——内联按钮覆盖全部功能，群聊隐私模式下也能用；
 *   · 列表一律分页（每页 10 条），可以翻完整份代理数据，不只是前几十条；
 *   · 搜索走 ForceReply 回填，群聊里也能收到关键词。
 *
 * 数据来源：与站点同源的 proxies.json（全量）/ top40.json（兜底），每小时刷新。
 * 依赖：仅 fetch + KV，无第三方包。
 */

const DEFAULT_TOP_URL = 'https://consoleaiden.github.io/telegram-mtproto-proxy-list/top40.json';
const DEFAULT_ALL_URL = 'https://consoleaiden.github.io/telegram-mtproto-proxy-list/proxies.json';
const DEFAULT_SITE_URL = 'https://consoleaiden.github.io/telegram-mtproto-proxy-list/';
const TZ = 'Asia/Shanghai';

const PAGE_SIZE = 10;
const MAX_SEARCH_RESULTS = 500;
const INDEX_TTL_MS = 10 * 60 * 1000;
/** 菜单/指令表版本：改动 COMMANDS 或菜单结构时 +1，让已部署实例重新 setMyCommands */
const WEBHOOK_VERSION = 2;

const DEFAULT_FIELDS = [
  'server', 'port', 'secret', 'sources', 'alive', 'verified',
  'latency_ms', 'connect_ms', 'tls_ms', 'success_rate', 'error',
];

const COMMANDS = [
  { command: 'start', description: '打开主菜单' },
  { command: 'top', description: '最快可用代理（可翻页）' },
  { command: 'all', description: '全部代理（可翻页）' },
  { command: 'search', description: '按服务器名/端口/密钥搜索' },
  { command: 'stats', description: '本轮测速统计' },
  { command: 'settings', description: '推送设置' },
  { command: 'help', description: '使用说明' },
];

const SCOPE_TITLES = {
  v: '🚀 最快可用代理',
  l: '📡 存活代理',
  a: '📋 全部代理',
};

const SCOPE_FILTER_LABEL = {
  v: '仅可用（校验通过）',
  l: '仅存活（含未通过校验）',
  a: '全部（含不可用）',
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** 把 proxies.json 的二维数组还原成对象数组 */
export function normalize(payload) {
  if (!payload || !Array.isArray(payload.proxies)) return [];
  const fields = Array.isArray(payload.fields) && payload.fields.length ? payload.fields : DEFAULT_FIELDS;
  return payload.proxies.map((row) => {
    if (!Array.isArray(row)) return row || {};
    const item = {};
    fields.forEach((field, index) => { item[field] = row[index]; });
    return item;
  });
}

/** 可用 = 存活 + 摘要校验通过 + 有延迟数据；按延迟升序 */
export function pickFastest(payload, limit = 10) {
  const items = normalize(payload).filter(
    (item) => item.alive !== false && item.verified !== false && Number.isFinite(Number(item.latency_ms)),
  );
  items.sort((a, b) => Number(a.latency_ms) - Number(b.latency_ms));
  return items.slice(0, Math.max(0, limit));
}

export function formatTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '未知';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function ageHours(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600000;
}

function medal(rank) {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
}

export function proxyLink(item) {
  if (item.link) return String(item.link);
  const server = item.server || '';
  const port = item.port || 443;
  const secret = item.secret || '';
  return `https://t.me/proxy?server=${encodeURIComponent(server)}&port=${port}&secret=${encodeURIComponent(secret)}`;
}

function token(len = 10) {
  const raw = globalThis.crypto && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return raw.slice(0, len);
}

/* ------------------------------------------------------------------ */
/* Telegram API                                                        */
/* ------------------------------------------------------------------ */

async function tg(env, method, payload) {
  if (!env.BOT_TOKEN) throw new Error('缺少 BOT_TOKEN');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(`${method}: ${data.description || 'unknown error'}`);
  return data.result;
}

function safeTg(env, method, payload) {
  return tg(env, method, payload).catch((err) => {
    console.error('telegram call failed', method, err && err.message);
    return null;
  });
}

/* ------------------------------------------------------------------ */
/* 数据读取（带 KV 兜底）                                               */
/* ------------------------------------------------------------------ */

async function loadData(env, kind) {
  const url = kind === 'top'
    ? (env.TOP_URL || DEFAULT_TOP_URL)
    : (env.ALL_URL || DEFAULT_ALL_URL);
  const key = `data:${kind}`;

  try {
    const separator = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${separator}v=${Date.now()}`, {
      cf: { cacheTtl: 60, cacheEverything: true },
      headers: { 'user-agent': 'mtproxy-bot/1.1' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!payload || !Array.isArray(payload.proxies)) throw new Error('数据格式不正确');
    if (env.STATE) {
      await env.STATE.put(key, JSON.stringify(payload), { expirationTtl: 86400 }).catch(() => {});
    }
    return payload;
  } catch (err) {
    const cached = env.STATE ? await env.STATE.get(key).catch(() => null) : null;
    if (cached) {
      const payload = JSON.parse(cached);
      payload._stale = true;
      return payload;
    }
    throw err;
  }
}

/** 排序：校验通过 → 存活 → 延迟升序 → 名称 */
function sortRows(rows) {
  return rows.sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const la = a.latency_ms == null ? Infinity : a.latency_ms;
    const lb = b.latency_ms == null ? Infinity : b.latency_ms;
    if (la !== lb) return la - lb;
    return String(a.server).localeCompare(String(b.server));
  });
}

/**
 * 全量索引：一次性把 proxies.json 压成分页需要的最小字段，按速率排好序存 KV。
 * 有缓存（10 分钟）就直接用，翻页不再回源。
 */
export async function loadIndex(env, { force = false } = {}) {
  const key = 'cache:index:v2';
  if (env.STATE && !force) {
    const cached = await env.STATE.get(key).catch(() => null);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        if (Array.isArray(data.rows) && Date.now() - data.at < INDEX_TTL_MS) return { ...data, cached: true };
      } catch { /* 坏数据重建 */ }
    }
  }

  let payload;
  try {
    payload = await loadData(env, 'all');
  } catch (err) {
    payload = await loadData(env, 'top');
  }

  const rows = sortRows(normalize(payload).filter((item) => item && item.server).map((item) => ({
    server: String(item.server),
    port: Number(item.port) || 443,
    secret: String(item.secret || ''),
    latency_ms: Number.isFinite(Number(item.latency_ms)) ? Math.round(Number(item.latency_ms)) : null,
    connect_ms: Number.isFinite(Number(item.connect_ms)) ? Math.round(Number(item.connect_ms)) : null,
    tls_ms: Number.isFinite(Number(item.tls_ms)) ? Math.round(Number(item.tls_ms)) : null,
    verified: item.verified === true,
    alive: item.alive === true,
  })));

  const index = {
    at: Date.now(),
    generated_at: payload.generated_at || null,
    stats: payload.stats || {},
    stale: !!payload._stale,
    rows,
  };
  if (env.STATE) {
    await env.STATE.put(key, JSON.stringify(index), { expirationTtl: 1800 }).catch(() => {});
  }
  return index;
}

/** 按筛选范围取行：v=仅可用 l=仅存活 a=全部 */
export function filterRows(rows, scope) {
  if (scope === 'v') return rows.filter((r) => r.verified && r.alive && r.latency_ms != null && r.latency_ms > 0);
  if (scope === 'l') return rows.filter((r) => r.alive);
  return rows;
}

/** 有意义的延迟：存活且测出正数（死链在数据里可能是 0 或 null） */
function measureOf(item) {
  if (!item.alive) return null;
  const value = Number(item.latency_ms);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* 菜单 / 分页渲染                                                      */
/* ------------------------------------------------------------------ */

export function menuKeyboard(site = DEFAULT_SITE_URL) {
  return {
    inline_keyboard: [
      [{ text: '🚀 最快榜', callback_data: 'm:top' }, { text: '📋 全部代理', callback_data: 'm:all' }],
      [{ text: '📡 仅存活', callback_data: 'f:l' }, { text: '🔍 搜索', callback_data: 'm:search' }],
      [{ text: '📊 测速统计', callback_data: 'm:stats' }, { text: '⚙️ 推送设置', callback_data: 'm:settings' }],
      [{ text: '❓ 帮助', callback_data: 'm:help' }, { text: '🌐 网页榜单', url: site }],
    ],
  };
}

export function menuText() {
  return [
    '<b>MTProxy 代理榜</b>',
    '每小时全量测速（TCP 建连 + FakeTLS 握手往返），只把校验通过的代理排在前面。',
    '',
    '点下面的按钮操作：',
    '· 🚀 <b>最快榜</b> / 📋 <b>全部代理</b> —— 分页浏览<u>全部</u>代理，每页 10 条',
    '· 📡 <b>仅存活</b> —— 只看握手有响应的',
    '· 🔍 <b>搜索</b> —— 按服务器名 / 端口 / 密钥片段查',
    '· 📊 <b>测速统计</b> · ⚙️ <b>推送设置</b>（群管理员）',
  ].join('\n');
}

/**
 * 常驻键盘仅作私聊备用入口。
 * 注意：一条消息只能带一种 reply_markup，所以 /start 只发内联菜单，
 * 不再额外发一条「常驻键盘」消息——一条消息就能用全部功能。
 */
export function replyMenu() {
  return {
    keyboard: [
      [{ text: '🚀 最快榜' }, { text: '📋 全部代理' }],
      [{ text: '📡 仅存活' }, { text: '🔍 搜索' }],
      [{ text: '📊 统计' }, { text: '⚙️ 设置' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: '点按钮，或直接发关键词搜索',
  };
}

const MENU_ACTIONS = [
  [/最快|top|榜/i, 'top'],
  [/全部|所有|列表|all/i, 'all'],
  [/存活|在线/i, 'alive'],
  [/搜索|查找|search/i, 'search'],
  [/统计|stats?/i, 'stats'],
  [/设置|推送|setting/i, 'settings'],
  [/帮助|说明|help/i, 'help'],
  [/菜单|主页|menu|start/i, 'home'],
];

export function menuAction(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('/')) return null;
  for (const [pattern, action] of MENU_ACTIONS) {
    if (pattern.test(raw)) return action;
  }
  return null;
}

/**
 * 生成一页列表：正文 + 内联键盘。
 * 排名跨页连续（第 2 页从 11 开始），翻页时用 ⏮ ◀️ ▶️ ⏭。
 */
export function buildPageView(rows, options = {}) {
  const scope = options.scope || 'v';
  const pageSize = options.pageSize || PAGE_SIZE;
  const meta = options.meta || {};
  const title = options.title || SCOPE_TITLES[scope] || '代理列表';
  const search = options.search || '';

  const total = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, Number(options.page) || 1), total);
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize);

  const lines = [];
  lines.push(`<b>${esc(title)} · 第 ${page}/${total} 页</b>`);

  const stats = meta.stats || {};
  const head = [];
  if (search) head.push(`“${esc(search)}” 命中 ${rows.length} 条`);
  else if (stats.tested) head.push(`共 ${stats.tested} 条 · 可用 ${stats.verified ?? '—'} 条`);
  else head.push(`共 ${rows.length} 条`);
  if (meta.generated_at) head.push(`数据 ${formatTime(meta.generated_at)}（UTC+8）`);
  if (meta.stale) head.push('⚠️ 缓存数据');
  lines.push(head.join(' · '));
  if (!search) {
    lines.push(`筛选：${SCOPE_FILTER_LABEL[scope] || '全部'} · 第 ${start + 1}–${start + items.length} 条`);
  }
  if (ageHours(meta.generated_at) > 3) {
    lines.push('⚠️ 数据超过 3 小时未更新，可能上游链路异常');
  }
  lines.push('');

  if (!items.length) {
    lines.push('暂无数据。');
  }
  items.forEach((item, offset) => {
    const rank = start + offset + 1;
    const label = medal(rank);
    const ms = measureOf(item);
    if (ms == null) {
      const why = item.alive ? '无测速数据' : '不可用';
      lines.push(`${label} <code>${esc(item.server)}:${item.port}</code> — ✖ ${why}`);
      return;
    }
    const detail = [];
    if (item.connect_ms != null) detail.push(`建连 ${Math.round(item.connect_ms)}ms`);
    if (item.tls_ms != null) detail.push(`握手 ${Math.round(item.tls_ms)}ms`);
    const mark = item.verified ? '' : ' <i>(未通过校验)</i>';
    const tail = detail.length ? ` <i>(${detail.join(' · ')})</i>` : '';
    lines.push(`${label} <code>${esc(item.server)}:${item.port}</code> — <b>${ms}ms</b>${tail}${mark}`);
  });

  const keyboard = [];
  for (let i = 0; i < items.length; i += 2) {
    const row = items.slice(i, i + 2).map((item, k) => {
      const rank = start + i + k + 1;
      const ms = measureOf(item);
      if (ms == null) return { text: `${rank}. ✖ 不可用`, callback_data: 'x' };
      return { text: `${rank}. ${ms}ms`, url: proxyLink(item) };
    });
    keyboard.push(row);
  }

  const atFirst = page <= 1;
  const atLast = page >= total;
  keyboard.push([
    { text: '⏮', callback_data: atFirst ? 'm:noop' : `p:${scope}:1` },
    { text: '◀️', callback_data: atFirst ? 'm:noop' : `p:${scope}:${page - 1}` },
    { text: `${page}/${total}`, callback_data: 'm:noop' },
    { text: '▶️', callback_data: atLast ? 'm:noop' : `p:${scope}:${page + 1}` },
    { text: '⏭', callback_data: atLast ? 'm:noop' : `p:${scope}:${total}` },
  ]);

  if (!search) {
    keyboard.push(['v', 'l', 'a'].map((s) => ({
      text: `${s === scope ? '• ' : ''}${s === 'v' ? '✅ 可用' : s === 'l' ? '📡 存活' : '📋 全部'}`,
      callback_data: `f:${s}`,
    })));
  }

  keyboard.push([
    { text: '🔄 刷新', callback_data: `r:${scope}:${page}` },
    { text: '🏠 菜单', callback_data: 'm:home' },
    { text: '🌐 网页', url: options.site || DEFAULT_SITE_URL },
  ]);

  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard }, page, total, start, items };
}

/* ------------------------------------------------------------------ */
/* 每小时推送用的消息                                                   */
/* ------------------------------------------------------------------ */

export function buildTopMessage(payload, items, options = {}) {
  const site = options.site || DEFAULT_SITE_URL;
  const stale = payload && payload._stale;
  const stats = (payload && payload.stats) || {};
  const lines = [];

  lines.push(`<b>${esc(options.title || '⚡ MTProxy 每小时速报 · 最快代理')}</b>`);
  lines.push(`数据时间 ${formatTime(payload && payload.generated_at)}（UTC+8）${stale ? ' · ⚠️ 缓存数据' : ''}`);

  if (stats.tested) {
    lines.push(`本轮测速 ${stats.tested} 条 · 存活 ${stats.alive ?? '—'} · 校验通过 ${stats.verified ?? '—'}`);
  }
  if (ageHours(payload && payload.generated_at) > 3) {
    lines.push('⚠️ 数据超过 3 小时未更新，可能上游链路异常');
  }
  lines.push('');

  items.forEach((item, index) => {
    const latency = Math.round(Number(item.latency_ms));
    const detail = [];
    if (Number.isFinite(Number(item.connect_ms))) detail.push(`建连 ${Math.round(Number(item.connect_ms))}ms`);
    if (Number.isFinite(Number(item.tls_ms))) detail.push(`握手 ${Math.round(Number(item.tls_ms))}ms`);
    const tail = detail.length ? ` <i>(${detail.join(' · ')})</i>` : '';
    lines.push(`${medal(index + 1)} <code>${esc(item.server)}:${item.port}</code> — <b>${latency}ms</b>${tail}`);
  });

  if (!items.length) lines.push('暂无可用代理，稍后再试。');
  lines.push('');
  lines.push(`<a href="${esc(site)}">完整榜单与测速明细</a>`);

  return lines.join('\n');
}

export function buildKeyboard(items, options = {}) {
  const site = options.site || DEFAULT_SITE_URL;
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const row = items.slice(i, i + 2).map((item, offset) => {
      const rank = i + offset + 1;
      const latency = Math.round(Number(item.latency_ms));
      return { text: `${rank}. ${latency}ms`, url: proxyLink(item) };
    });
    rows.push(row);
  }
  rows.push([
    { text: '📋 全部代理', callback_data: 'm:all' },
    { text: '🌐 网页榜单', url: site },
  ]);
  return { inline_keyboard: rows };
}

/* ------------------------------------------------------------------ */
/* KV：绑定与去重                                                       */
/* ------------------------------------------------------------------ */

async function saveChat(env, chat) {
  if (!env.STATE) return false;
  const id = String(chat.id);
  const record = {
    id: chat.id,
    title: chat.title || chat.username || chat.first_name || id,
    type: chat.type || 'unknown',
    boundAt: new Date().toISOString(),
  };
  await env.STATE.put(`chat:${id}`, JSON.stringify(record));
  return true;
}

async function removeChat(env, chatId) {
  if (!env.STATE) return false;
  await env.STATE.delete(`chat:${String(chatId)}`);
  return true;
}

async function isBound(env, chatId) {
  if (!env.STATE) return false;
  return !!(await env.STATE.get(`chat:${String(chatId)}`).catch(() => null));
}

/** 用户主动关掉推送的标记：有它就不要再自动绑定 */
async function isOptOut(env, chatId) {
  if (!env.STATE) return false;
  return !!(await env.STATE.get(`optout:${String(chatId)}`).catch(() => null));
}

/**
 * 兜底自动绑定。
 * my_chat_member 有时收不到（加入时机早于 webhook 注册、或频道场景），
 * 所以只要有人在本群/本频道用过指令或菜单，就补一次绑定；显式关过的除外。
 */
async function ensureBound(env, chat) {
  if (!chat || chat.type === 'private' || !env.STATE) return false;
  if (await isOptOut(env, chat.id)) return false;
  if (await isBound(env, chat.id)) return false;
  return saveChat(env, chat);
}

export async function listChats(env) {
  if (!env.STATE) return [];
  const chats = [];
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: 'chat:', cursor });
    for (const key of page.keys) {
      const raw = await env.STATE.get(key.name);
      if (!raw) continue;
      try { chats.push(JSON.parse(raw)); } catch { /* 跳过坏数据 */ }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return chats;
}

function hourBucket(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}`;
}

/* ------------------------------------------------------------------ */
/* 页面渲染（菜单 / 统计 / 设置 / 帮助）                                 */
/* ------------------------------------------------------------------ */

export function buildStatsText(index) {
  const stats = index.stats || {};
  const lines = [
    '<b>📊 本轮测速统计</b>',
    `数据时间 ${formatTime(index.generated_at)}（UTC+8）`,
    `测速总数 ${stats.tested ?? '—'} 条`,
    `存活 ${stats.alive ?? '—'} 条`,
    `校验通过 ${stats.verified ?? '—'} 条`,
    stats.fastest_ms ? `最快 ${Math.round(stats.fastest_ms)}ms` : '',
    stats.median_ms ? `中位 ${Math.round(stats.median_ms)}ms` : '',
  ].filter(Boolean);
  const sources = stats.sources || {};
  const sourceText = Object.entries(sources).map(([k, v]) => `${k} ${v} 条`).join(' · ');
  if (sourceText) lines.push(`来源：${esc(sourceText)}`);
  if (index.stale) lines.push('⚠️ 当前使用缓存数据');
  lines.push('', `本机器人共收录 ${index.rows.length} 条代理记录，可翻页查看全部。`);
  return lines.join('\n');
}

export function buildSettingsText(chat, bound) {
  const isPrivate = chat.type === 'private';
  const lines = ['<b>⚙️ 推送设置</b>', ''];
  if (isPrivate) {
    lines.push('私聊不参与每小时群推送。');
    lines.push('把机器人拉进群后会自动开启推送；也可以随时在这里关掉。');
  } else {
    lines.push(`当前会话：${esc(chat.title || chat.id)}`);
    lines.push(`每小时推送：${bound ? '✅ 已开启' : '⛔️ 未开启'}`);
  }
  lines.push('', '推送内容：校验通过且速率最快的前 10 个代理，附一键添加按钮。');
  return lines.join('\n');
}

export function settingsKeyboard(chat, bound) {
  const rows = [];
  if (chat.type !== 'private') {
    rows.push([bound
      ? { text: '🔕 关闭每小时推送', callback_data: 'm:off' }
      : { text: '🔔 开启每小时推送', callback_data: 'm:on' }]);
  }
  rows.push([{ text: '📤 立刻推一次', callback_data: 'm:now' }, { text: '🆔 会话 ID', callback_data: 'm:id' }]);
  rows.push([{ text: '🏠 返回菜单', callback_data: 'm:home' }]);
  return { inline_keyboard: rows };
}

export function buildHelpText() {
  return [
    '<b>MTProxy 代理榜 · 使用说明</b>',
    '',
    '全部功能都在按钮里，不用记指令：',
    '· 🚀 <b>最快榜</b> —— 校验通过 + 速率排序，分页浏览',
    '· 📋 <b>全部代理</b> —— 含存活与不可用，同样可翻页到最后一页',
    '· 📡 <b>仅存活</b> —— 只看握手有响应的',
    '· 🔍 <b>搜索</b> —— 服务器名 / 端口 / 密钥片段',
    '· 📊 <b>测速统计</b> · ⚙️ <b>推送设置</b>',
    '',
    '排名的依据是真实握手耗时：TCP 建连 + FakeTLS 往返，每台测 2 次取中位数。',
    '"✖ 不可用" 表示当前连不上，或服务端不认这个密钥（返回了假握手）。',
    '',
    '指令仍然可用：/top /all /search 关键词 /stats /settings /now /id',
  ].join('\n');
}

function helpKeyboard(site = DEFAULT_SITE_URL) {
  return {
    inline_keyboard: [
      [{ text: '🚀 最快榜', callback_data: 'm:top' }, { text: '📋 全部代理', callback_data: 'm:all' }],
      [{ text: '🏠 菜单', callback_data: 'm:home' }, { text: '🌐 网页榜单', url: site }],
    ],
  };
}

async function reply(env, chatId, text, extra = {}) {
  return safeTg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

/** 有 messageId 就原地编辑，否则发新消息 */
async function render(env, chatId, messageId, payload) {
  const body = {
    chat_id: chatId,
    text: payload.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (payload.keyboard) body.reply_markup = payload.keyboard;

  if (messageId) {
    try {
      await tg(env, 'editMessageText', { ...body, message_id: messageId });
      return true;
    } catch (err) {
      if (/not modified/i.test(err.message)) return true;
      console.error('edit failed, fallback to send', err.message);
    }
  }
  await safeTg(env, 'sendMessage', body);
  return true;
}

/* ------------------------------------------------------------------ */
/* 分页核心                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析某一页的数据源。
 * scope: v / l / a，或 s.<token>（搜索结果，存在 KV 里，1 小时过期）
 */
async function resolveRows(env, scope, { force = false } = {}) {
  if (scope && scope.startsWith('s.')) {
    const key = `search:${scope.slice(2)}`;
    const raw = env.STATE ? await env.STATE.get(key).catch(() => null) : null;
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw);
      return { rows: saved.rows || [], meta: { generated_at: saved.generated_at, stats: saved.stats, stale: saved.stale }, search: saved.q || '' };
    } catch {
      return null;
    }
  }
  const index = await loadIndex(env, { force });
  const safeScope = ['v', 'l', 'a'].includes(scope) ? scope : 'v';
  return { rows: filterRows(index.rows, safeScope), meta: index, search: '' };
}

async function showPage(env, chatId, scope, page, { messageId = null, force = false } = {}) {
  const resolved = await resolveRows(env, scope, { force });
  if (!resolved) {
    await reply(env, chatId, '这页搜索结果已过期，请重新搜索。', {
      reply_markup: { inline_keyboard: [[{ text: '🔍 重新搜索', callback_data: 'm:search' }]] },
    });
    return null;
  }
  const view = buildPageView(resolved.rows, {
    scope: resolved.search ? 'a' : scope,
    page,
    meta: resolved.meta,
    site: env.SITE_URL,
    title: resolved.search ? `🔍 搜索「${resolved.search}」` : undefined,
    search: resolved.search,
  });
  await render(env, chatId, messageId, { text: view.text, keyboard: view.keyboard });
  return view;
}

/** 搜索：结果落到 KV，翻页只带 token */
async function doSearch(env, chat, keyword, { messageId = null } = {}) {
  const q = String(keyword || '').trim();
  if (!q) {
    return reply(env, chat.id, '请输入关键词，例如 <code>443</code> 或 <code>meow</code>。', {
      reply_markup: { force_reply: true, input_field_placeholder: '服务器名 / 端口 / 密钥片段' },
    });
  }
  if (!env.STATE) return reply(env, chat.id, '存储未配置，暂时无法搜索。');

  const index = await loadIndex(env);
  const needle = q.toLowerCase();
  const hits = index.rows.filter((row) => `${row.server}:${row.port} ${row.secret}`.toLowerCase().includes(needle));
  if (!hits.length) {
    return reply(env, chat.id, `没找到匹配「${esc(q)}」的代理。`, {
      reply_markup: { inline_keyboard: [[{ text: '🏠 返回菜单', callback_data: 'm:home' }]] },
    });
  }

  const capped = hits.slice(0, MAX_SEARCH_RESULTS);
  const key = token(10);
  await env.STATE.put(`search:${key}`, JSON.stringify({
    q,
    at: Date.now(),
    generated_at: index.generated_at,
    stats: index.stats,
    stale: index.stale,
    rows: capped,
  }), { expirationTtl: 3600 }).catch(() => {});

  return showPage(env, chat.id, `s.${key}`, 1, { messageId });
}

/* ------------------------------------------------------------------ */
/* 指令与菜单分发                                                       */
/* ------------------------------------------------------------------ */

export function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const [head, ...args] = raw.split(/\s+/);
  return { command: head.slice(1).split('@')[0].toLowerCase(), args };
}

async function isGroupAdmin(env, chatId, userId) {
  if (!userId) return false;
  const member = await safeTg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
  if (!member) return true; // API 出错时不阻塞绑定，避免群里用不了
  return ['creator', 'administrator'].includes(member.status);
}

/** 菜单动作统一入口（内联按钮与常驻键盘共用） */
async function runAction(env, chat, action, { messageId = null, userId = null } = {}) {
  switch (action) {
    case 'home':
      return render(env, chat.id, messageId, { text: menuText(), keyboard: menuKeyboard(env.SITE_URL || DEFAULT_SITE_URL) });

    case 'top':
      return showPage(env, chat.id, 'v', 1, { messageId });

    case 'all':
      return showPage(env, chat.id, 'a', 1, { messageId });

    case 'alive':
      return showPage(env, chat.id, 'l', 1, { messageId });

    case 'stats':
      return render(env, chat.id, messageId, {
        text: buildStatsText(await loadIndex(env)),
        keyboard: {
          inline_keyboard: [
            [{ text: '📊 刷新', callback_data: 'm:stats' }, { text: '🏠 菜单', callback_data: 'm:home' }],
            [{ text: '📋 全部代理', callback_data: 'm:all' }, { text: '🌐 网页榜单', url: env.SITE_URL || DEFAULT_SITE_URL }],
          ],
        },
      });

    case 'settings': {
      const bound = await isBound(env, chat.id);
      return render(env, chat.id, messageId, {
        text: buildSettingsText(chat, bound),
        keyboard: settingsKeyboard(chat, bound),
      });
    }

    case 'help':
      return render(env, chat.id, messageId, {
        text: buildHelpText(),
        keyboard: helpKeyboard(env.SITE_URL || DEFAULT_SITE_URL),
      });

    case 'search':
      return reply(env, chat.id, '请输入关键词（服务器名 / 端口 / 密钥片段），支持部分匹配。', {
        reply_markup: { force_reply: true, input_field_placeholder: '例如 meow 或 443' },
      });

    case 'on': {
      if (chat.type === 'private') {
        return reply(env, chat.id, '私聊无需绑定；把机器人拉进群就会自动开启推送。');
      }
      const allowed = await isGroupAdmin(env, chat.id, userId);
      if (!allowed) return reply(env, chat.id, '只有群管理员可以修改推送设置。');
      if (env.STATE) await env.STATE.delete(`optout:${chat.id}`).catch(() => {});
      const saved = await saveChat(env, chat);
      if (!saved) return reply(env, chat.id, '存储未配置，无法保存绑定。');
      return render(env, chat.id, messageId, {
        text: `${buildSettingsText(chat, true)}\n\n✅ 已开启，下一次整点推送。`,
        keyboard: settingsKeyboard(chat, true),
      });
    }

    case 'off': {
      if (chat.type !== 'private') {
        const allowed = await isGroupAdmin(env, chat.id, userId);
        if (!allowed) return reply(env, chat.id, '只有群管理员可以修改推送设置。');
        // 记一个 30 天的拒绝标记，避免后续有人点一下就又被自动绑回来
        if (env.STATE) await env.STATE.put(`optout:${chat.id}`, '1', { expirationTtl: 30 * 86400 }).catch(() => {});
      }
      await removeChat(env, chat.id);
      return render(env, chat.id, messageId, {
        text: `${buildSettingsText(chat, false)}\n\n🔕 已关闭本群的每小时推送。`,
        keyboard: settingsKeyboard(chat, false),
      });
    }

    case 'now': {
      const payload = await loadData(env, 'top');
      const items = pickFastest(payload, Number(env.PUSH_LIMIT) || 10);
      return reply(env, chat.id, buildTopMessage(payload, items, { site: env.SITE_URL }), {
        reply_markup: buildKeyboard(items, { site: env.SITE_URL }),
      });
    }

    case 'id':
      return reply(env, chat.id, `<code>${chat.id}</code>\n类型：${esc(chat.type)}`);

    default:
      return render(env, chat.id, messageId, { text: menuText(), keyboard: menuKeyboard(env.SITE_URL || DEFAULT_SITE_URL) });
  }
}

async function handleCommand(env, msg) {
  const chat = msg.chat;
  const parsed = parseCommand(msg.text);
  if (!parsed) return;
  const { command, args } = parsed;

  switch (command) {
    case 'start':
      // 一条消息搞定：菜单正文 + 全部功能按钮，后续操作都在这条消息里原地翻页
      return render(env, chat.id, null, { text: menuText(), keyboard: menuKeyboard(env.SITE_URL || DEFAULT_SITE_URL) });

    case 'menu':
    case 'help':
      return runAction(env, chat, 'home');

    case 'top':
    case 'best':
      return runAction(env, chat, 'top');

    case 'all':
    case 'list':
      return runAction(env, chat, 'all');

    case 'alive':
      return runAction(env, chat, 'alive');

    case 'stats':
      return runAction(env, chat, 'stats');

    case 'settings':
    case 'bind':
    case 'unbind': {
      if (command === 'bind' && chat.type !== 'private') return runAction(env, chat, 'on', { userId: msg.from && msg.from.id });
      if (command === 'unbind') return runAction(env, chat, 'off', { userId: msg.from && msg.from.id });
      return runAction(env, chat, 'settings');
    }

    case 'now':
      return runAction(env, chat, 'now');

    case 'id':
      return runAction(env, chat, 'id');

    case 'search': {
      const keyword = args.join(' ').trim();
      return doSearch(env, chat, keyword);
    }

    default:
      return render(env, chat.id, null, { text: menuText(), keyboard: menuKeyboard(env.SITE_URL || DEFAULT_SITE_URL) });
  }
}

/** 普通文本：先看是不是菜单按钮，私聊 / 回复机器人时再当搜索关键词 */
async function handleText(env, msg) {
  const text = String(msg.text || '').trim();
  if (!text) return;
  const isCommand = text.startsWith('/');
  const action = isCommand ? null : menuAction(text);

  // 在群里用过指令或菜单 -> 顺手绑定（显式关闭过的不动）
  if ((isCommand || action) && !/^\/(unbind|stop|off)\b/i.test(text)) {
    await ensureBound(env, msg.chat);
  }

  if (isCommand) return handleCommand(env, msg);
  if (action) return runAction(env, msg.chat, action, { userId: msg.from && msg.from.id });

  const repliedToBot = !!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot);
  if (repliedToBot || msg.chat.type === 'private') {
    return doSearch(env, msg.chat, text);
  }
  // 群里的普通聊天不打扰
}

async function handleCallback(env, query) {
  const data = String(query.data || '');
  const message = query.message || {};
  const chatId = message.chat && message.chat.id;
  const messageId = message.message_id;
  const chat = message.chat;
  const userId = query.from && query.from.id;

  const answer = (text) => safeTg(env, 'answerCallbackQuery', {
    callback_query_id: query.id,
    text: text || undefined,
  });

  if (!chatId) { await answer(); return; }
  if (data === 'x') { await answer('该代理当前不可用'); return; }
  if (data === 'm:noop') { await answer(); return; }

  // 有人在这个群/频道里点按钮，说明在用 -> 顺手绑定（开关动作由 runAction 自己按管理员校验）
  if (!['m:on', 'm:off'].includes(data)) await ensureBound(env, chat);

  const [kind, ...rest] = data.split(':');

  try {
    if (kind === 'p' || kind === 'r') {
      const scope = rest[0] || 'v';
      const page = Number(rest[1]) || 1;
      await answer(kind === 'r' ? '正在刷新…' : undefined);
      await showPage(env, chatId, scope, page, { messageId, force: kind === 'r' });
      return;
    }

    if (kind === 'f') {
      await answer();
      await showPage(env, chatId, rest[0] || 'v', 1, { messageId });
      return;
    }

    if (kind === 'm') {
      const action = rest[0];
      if (action === 'now') {
        await answer('正在推送…');
        await runAction(env, chat, 'now', { messageId: null, userId });
        return;
      }
      if (action === 'id') {
        await answer(`会话 ID：${chatId}`);
        return;
      }
      if (action === 'off' || action === 'on') {
        await answer(action === 'on' ? '已开启' : '已关闭');
        await runAction(env, chat, action, { messageId, userId });
        return;
      }
      await answer();
      await runAction(env, chat, action, { messageId, userId });
      return;
    }

    await answer();
  } catch (err) {
    console.error('callback failed', data, err && err.message);
    await answer('操作失败，请重试');
  }
}

/** 被拉进群时自动绑定，并给一个菜单入口 */
async function handleMyChatMember(env, update) {
  const member = update.my_chat_member;
  const chat = member && member.chat;
  const status = member && member.new_chat_member && member.new_chat_member.status;
  if (!chat || !['member', 'administrator'].includes(status)) return;
  await saveChat(env, chat);
  await reply(env, chat.id, '👋 已加入并自动开启每小时推送（最快 10 个代理）。\n点下面的按钮随时查询：', {
    reply_markup: menuKeyboard(env.SITE_URL || DEFAULT_SITE_URL),
  });
}

/* ------------------------------------------------------------------ */
/* 定时推送                                                            */
/* ------------------------------------------------------------------ */

export async function pushHourly(env, options = {}) {
  const payload = await loadData(env, 'top');
  const items = pickFastest(payload, Number(env.PUSH_LIMIT) || 10);
  const chats = await listChats(env);
  const bucket = hourBucket();
  const result = { chats: chats.length, sent: 0, skipped: 0, failed: 0 };

  if (!items.length) {
    for (const chat of chats) {
      await reply(env, chat.id, '⚠️ 本轮没有可用代理，稍后自动重试。');
    }
    return { ...result, empty: true };
  }

  for (const chat of chats) {
    const dedupeKey = `sent:${chat.id}:${bucket}`;
    if (env.STATE && !options.force) {
      const already = await env.STATE.get(dedupeKey).catch(() => null);
      if (already) { result.skipped += 1; continue; }
    }
    try {
      await reply(env, chat.id, buildTopMessage(payload, items, { site: env.SITE_URL }), {
        reply_markup: buildKeyboard(items, { site: env.SITE_URL }),
      });
      if (env.STATE) await env.STATE.put(dedupeKey, '1', { expirationTtl: 7200 }).catch(() => {});
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      // 群被踢/被删：清理绑定
      if (/chat not found|kicked|deactivated/i.test(err.message)) {
        await removeChat(env, chat.id);
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 管理接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 幂等注册 webhook：cron 每次执行前调用，KV 里有记录就跳过。
 * 放在 Worker 内执行的目的：CF 边缘能直连 Telegram，本地网络可能不通。
 */
export async function ensureWebhook(env, host) {
  const hookUrl = `https://${host}/tg/${env.WEBHOOK_SECRET || 'hook'}`;
  const cached = env.STATE ? await env.STATE.get('meta:webhook').catch(() => null) : null;
  if (cached) {
    try {
      const record = JSON.parse(cached);
      if (record.url === hookUrl && record.v === WEBHOOK_VERSION) return { ...record, cached: true };
    } catch { /* 坏数据重新注册 */ }
  }

  await tg(env, 'setWebhook', {
    url: hookUrl,
    secret_token: env.WEBHOOK_SECRET || undefined,
    allowed_updates: ['message', 'callback_query', 'my_chat_member', 'channel_post'],
    drop_pending_updates: true,
  });
  await safeTg(env, 'setMyCommands', { commands: COMMANDS });
  await safeTg(env, 'setChatMenuButton', { menu_button: { type: 'commands' } });
  const me = await safeTg(env, 'getMe');
  const record = { url: hookUrl, at: new Date().toISOString(), bot: me && me.username, v: WEBHOOK_VERSION };
  if (env.STATE) await env.STATE.put('meta:webhook', JSON.stringify(record), { expirationTtl: 7 * 86400 }).catch(() => {});
  return record;
}

async function adminSetup(env, url) {
  const record = await ensureWebhook(env, url.host);
  const me = await tg(env, 'getMe');
  const info = await tg(env, 'getWebhookInfo');
  return json({
    ok: true,
    hookUrl: record.url,
    bot: { id: me.id, username: me.username, name: me.first_name },
    webhook: { url: info.url, pending: info.pending_update_count, lastError: info.last_error_message || null },
    chats: (await listChats(env)).map((c) => ({ id: c.id, title: c.title })),
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram webhook
    if (url.pathname.startsWith('/tg/')) {
      if (env.WEBHOOK_SECRET) {
        const pathSecret = url.pathname.slice(4);
        const headerSecret = request.headers.get('x-telegram-bot-api-secret-token');
        // Telegram 一定会带 secret 请求头：带了就必须匹配；没带则退回路径校验
        const authorized = headerSecret ? headerSecret === env.WEBHOOK_SECRET : pathSecret === env.WEBHOOK_SECRET;
        if (!authorized) return new Response('forbidden', { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('bad request', { status: 400 }); }

      // 记一条心跳，便于在不方便直连 Worker 时远程确认 webhook 是否真的送达
      const msgForLog = update.message || update.channel_post;
      const heartbeat = {
        at: new Date().toISOString(),
        kind: update.my_chat_member ? 'my_chat_member' : update.callback_query ? 'callback' : 'message',
        command: (update.callback_query && update.callback_query.data) || (msgForLog && msgForLog.text ? String(msgForLog.text).slice(0, 40) : ''),
        chat: msgForLog && msgForLog.chat ? { id: msgForLog.chat.id, type: msgForLog.chat.type, title: msgForLog.chat.title || '' } : null,
      };
      if (env.STATE) {
        const write = env.STATE.put('meta:lastUpdate', JSON.stringify(heartbeat), { expirationTtl: 86400 }).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;
      }

      // 立刻 200，业务异步执行（Telegram 有 60s 超时，但避免重复投递）
      const work = (async () => {
        if (update.my_chat_member) return handleMyChatMember(env, update);
        if (update.callback_query) return handleCallback(env, update.callback_query);
        const msg = update.message || update.channel_post;
        if (msg && msg.text) return handleText(env, msg);
      })().catch(async (err) => {
        console.error('handle update failed', err && err.stack);
        const chatId = update.message?.chat?.id || update.channel_post?.chat?.id;
        if (chatId) await reply(env, chatId, `出错了：${esc(err.message)}`);
      });

      if (ctx && ctx.waitUntil) ctx.waitUntil(work);
      else await work;
      return new Response('ok');
    }

    // 管理：注册 webhook / 查看状态
    if (url.pathname === '/admin/setup') {
      const key = url.searchParams.get('key') || request.headers.get('x-admin-key');
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'forbidden' }, 403);
      try { return await adminSetup(env, url); } catch (err) { return json({ ok: false, error: err.message }, 500); }
    }

    if (url.pathname === '/admin/push') {
      const key = url.searchParams.get('key') || request.headers.get('x-admin-key');
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'forbidden' }, 403);
      try { return json({ ok: true, ...(await pushHourly(env, { force: true })) }); } catch (err) { return json({ ok: false, error: err.message }, 500); }
    }

    if (url.pathname === '/') {
      return json({
        ok: true,
        service: 'mtproxy-bot',
        ui: 'menu + pagination',
        commands: COMMANDS.map((c) => `/${c.command}`),
        endpoints: ['/tg/<secret> (webhook)', '/admin/setup?key=…', '/admin/push?key=…'],
      });
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const task = (async () => {
      // 首次执行时自动注册 webhook（幂等，之后走 KV 缓存）
      try {
        await ensureWebhook(env, env.WORKER_HOST || 'mtproxy-bot.84339075.workers.dev');
      } catch (err) {
        console.error('ensureWebhook failed', err && err.message);
      }

      const result = await pushHourly(env);
      // 把运行结果写进 KV，便于用 `wrangler kv key get` 远程核对
      if (env.STATE) {
        await env.STATE.put('meta:lastRun', JSON.stringify({
          at: new Date().toISOString(),
          cron: event && event.cron,
          ...result,
        }), { expirationTtl: 7 * 86400 }).catch(() => {});
      }
      console.log('hourly push', JSON.stringify(result));
    })().catch((err) => {
      console.error('hourly push failed', err && err.stack);
      if (env.STATE) {
        env.STATE.put('meta:lastError', JSON.stringify({
          at: new Date().toISOString(), error: String(err && err.message),
        }), { expirationTtl: 7 * 86400 }).catch(() => {});
      }
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(task);
    else await task;
  },
};
