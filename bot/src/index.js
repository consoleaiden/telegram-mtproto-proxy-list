/**
 * MTProxy 代理榜 · Telegram Bot（Cloudflare Worker）
 *
 * 职责：
 *   1. cron 每小时把「校验通过 + 访问速率最快」的代理推送到已绑定的群；
 *   2. webhook 接收 /top /search /stats 等指令，即时返回代理信息；
 *   3. /admin/setup 自注册 webhook（Worker 在 CF 边缘可直接访问 Telegram，
 *      本地网络可能不通，所以把注册动作放在 Worker 内完成）。
 *
 * 数据来源：与站点同源的 top40.json / proxies.json（GitHub Actions 每小时刷新）。
 * 依赖：仅 fetch + KV，无第三方包。
 */

const DEFAULT_TOP_URL = 'https://consoleaiden.github.io/telegram-mtproto-proxy-list/top40.json';
const DEFAULT_ALL_URL = 'https://consoleaiden.github.io/telegram-mtproto-proxy-list/proxies.json';
const DEFAULT_SITE_URL = 'https://consoleaiden.github.io/telegram-mtproto-proxy-list/';
const TZ = 'Asia/Shanghai';

const DEFAULT_FIELDS = [
  'server', 'port', 'secret', 'sources', 'alive', 'verified',
  'latency_ms', 'connect_ms', 'tls_ms', 'success_rate', 'error',
];

const COMMANDS = [
  { command: 'top', description: '查看最快的代理（默认 10 个，可 /top 20）' },
  { command: 'fast', description: '只看最快的那一个' },
  { command: 'search', description: '按服务器名/端口/密钥前缀搜索' },
  { command: 'stats', description: '本轮测速统计' },
  { command: 'id', description: '显示当前会话 ID' },
  { command: 'bind', description: '把本群设为每小时推送目标' },
  { command: 'unbind', description: '取消本群的每小时推送' },
  { command: 'now', description: '立刻推送一次最快 10 个' },
  { command: 'help', description: '使用说明' },
];

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
      headers: { 'user-agent': 'mtproxy-bot/1.0' },
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

/* ------------------------------------------------------------------ */
/* 消息渲染                                                            */
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
    { text: '🔄 刷新', callback_data: 'refresh:10' },
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
/* 指令处理                                                            */
/* ------------------------------------------------------------------ */

export function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const [head, ...args] = raw.split(/\s+/);
  return { command: head.slice(1).split('@')[0].toLowerCase(), args };
}

const HELP_TEXT = [
  '<b>MTProxy 代理机器人</b>',
  '数据来自每小时全量测速（TCP 建连 + FakeTLS 握手往返），只列出校验通过的代理。',
  '',
  '/top [n] —— 最快 n 个（默认 10，最多 40）',
  '/fast —— 只要最快的那一个',
  '/search 关键词 —— 按服务器名/端口/密钥前缀搜索',
  '/stats —— 本轮测速统计',
  '/bind —— 把本群设为每小时推送目标',
  '/unbind —— 取消本群推送',
  '/now —— 立刻推送一次',
  '/id —— 查看当前会话 ID',
].join('\n');

async function reply(env, chatId, text, extra = {}) {
  return safeTg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function isGroupAdmin(env, chatId, userId) {
  if (!userId) return false;
  const member = await safeTg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
  if (!member) return true; // API 出错时不阻塞绑定，避免群里用不了
  return ['creator', 'administrator'].includes(member.status);
}

async function handleCommand(env, msg) {
  const chat = msg.chat;
  const parsed = parseCommand(msg.text);
  if (!parsed) return;
  const { command, args } = parsed;

  switch (command) {
    case 'start':
    case 'help':
      return reply(env, chat.id, HELP_TEXT);

    case 'id':
      return reply(env, chat.id, `<code>${chat.id}</code>\n类型：${esc(chat.type)}`);

    case 'top':
    case 'best':
    case 'fast': {
      const wanted = command === 'fast' ? 1 : Math.min(40, Math.max(1, Number(args[0]) || 10));
      const payload = await loadData(env, 'top');
      const items = pickFastest(payload, wanted);
      return reply(env, chat.id, buildTopMessage(payload, items, {
        site: env.SITE_URL,
        title: wanted === 1 ? '⚡ 当前最快的代理' : `⚡ 最快 ${items.length} 个代理`,
      }), { reply_markup: buildKeyboard(items, { site: env.SITE_URL }) });
    }

    case 'search': {
      const keyword = args.join(' ').trim().toLowerCase();
      if (!keyword) return reply(env, chat.id, '用法：<code>/search 关键词</code>，例如 <code>/search 443</code>');
      const payload = await loadData(env, 'all');
      const matched = pickFastest(payload, 1000).filter((item) => {
        const hay = `${item.server}:${item.port} ${item.secret || ''}`.toLowerCase();
        return hay.includes(keyword);
      }).slice(0, 10);
      if (!matched.length) return reply(env, chat.id, `没找到匹配「${esc(keyword)}」的可用代理。`);
      return reply(env, chat.id, buildTopMessage(payload, matched, {
        site: env.SITE_URL,
        title: `🔍 搜索「${keyword}」· ${matched.length} 个结果`,
      }), { reply_markup: buildKeyboard(matched, { site: env.SITE_URL }) });
    }

    case 'stats': {
      const payload = await loadData(env, 'top');
      const stats = payload.stats || {};
      const lines = [
        '<b>本轮测速统计</b>',
        `数据时间 ${formatTime(payload.generated_at)}（UTC+8）`,
        `测速总数 ${stats.tested ?? '—'} 条`,
        `存活 ${stats.alive ?? '—'} 条`,
        `校验通过 ${stats.verified ?? '—'} 条`,
        stats.fastest_ms ? `最快 ${Math.round(stats.fastest_ms)}ms` : '',
        stats.median_ms ? `中位 ${Math.round(stats.median_ms)}ms` : '',
      ].filter(Boolean);
      const sources = stats.sources || {};
      const sourceText = Object.entries(sources).map(([k, v]) => `${k} ${v} 条`).join(' · ');
      if (sourceText) lines.push(`来源：${esc(sourceText)}`);
      if (payload._stale) lines.push('⚠️ 当前使用缓存数据');
      return reply(env, chat.id, lines.join('\n'));
    }

    case 'bind': {
      if (chat.type === 'private') {
        return reply(env, chat.id, '私聊已经默认可用；<code>/bind</code> 用于把群设为每小时推送目标。');
      }
      const allowed = await isGroupAdmin(env, chat.id, msg.from && msg.from.id);
      if (!allowed) return reply(env, chat.id, '只有群管理员可以设置推送。');
      const saved = await saveChat(env, chat);
      if (!saved) return reply(env, chat.id, '存储未配置，无法保存绑定。');
      return reply(env, chat.id, `✅ 已绑定本群，每小时推送最快 10 个代理。\n先用 <code>/now</code> 看一条示例。`);
    }

    case 'unbind': {
      const removed = await removeChat(env, chat.id);
      return reply(env, chat.id, removed ? '已取消本群的每小时推送。' : '存储未配置，无需取消。');
    }

    case 'now': {
      const payload = await loadData(env, 'top');
      const items = pickFastest(payload, 10);
      return reply(env, chat.id, buildTopMessage(payload, items, { site: env.SITE_URL }), {
        reply_markup: buildKeyboard(items, { site: env.SITE_URL }),
      });
    }

    default:
      return reply(env, chat.id, `未知指令。\n\n${HELP_TEXT}`);
  }
}

async function handleCallback(env, query) {
  const data = String(query.data || '');
  const chatId = query.message && query.message.chat && query.message.chat.id;
  await safeTg(env, 'answerCallbackQuery', {
    callback_query_id: query.id,
    text: data.startsWith('refresh') ? '正在刷新…' : undefined,
  });
  if (!chatId) return;

  if (data.startsWith('refresh')) {
    const limit = Math.min(40, Math.max(1, Number(data.split(':')[1]) || 10));
    try {
      const payload = await loadData(env, 'top');
      const items = pickFastest(payload, limit);
      await safeTg(env, 'editMessageText', {
        chat_id: chatId,
        message_id: query.message.message_id,
        text: buildTopMessage(payload, items, { site: env.SITE_URL, title: `⚡ 最快 ${items.length} 个代理` }),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildKeyboard(items, { site: env.SITE_URL }),
      });
    } catch (err) {
      await reply(env, chatId, `刷新失败：${esc(err.message)}`);
    }
  }
}

/** 被拉进群时自动绑定，并回一条示例 */
async function handleMyChatMember(env, update) {
  const member = update.my_chat_member;
  const chat = member && member.chat;
  const status = member && member.new_chat_member && member.new_chat_member.status;
  if (!chat || !['member', 'administrator'].includes(status)) return;
  await saveChat(env, chat);
  await reply(env, chat.id, '👋 已加入并自动绑定，每小时推送最快 10 个代理。\n发 /top 立即查看，/help 看全部指令。');
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
      if (record.url === hookUrl) return { ...record, cached: true };
    } catch { /* 坏数据重新注册 */ }
  }

  await tg(env, 'setWebhook', {
    url: hookUrl,
    secret_token: env.WEBHOOK_SECRET || undefined,
    allowed_updates: ['message', 'callback_query', 'my_chat_member', 'channel_post'],
    drop_pending_updates: true,
  });
  await safeTg(env, 'setMyCommands', { commands: COMMANDS });
  const me = await safeTg(env, 'getMe');
  const record = { url: hookUrl, at: new Date().toISOString(), bot: me && me.username };
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
        command: msgForLog && msgForLog.text ? String(msgForLog.text).slice(0, 40) : '',
        chat: msgForLog && msgForLog.chat ? { id: msgForLog.chat.id, type: msgForLog.chat.type, title: msgForLog.chat.title || '' } : null,
      };
      if (env.STATE) {
        const write = env.STATE.put('meta:lastUpdate', JSON.stringify(heartbeat), { expirationTtl: 86400 }).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;
      }

      // 立刻 200，业务异步执行（Telegram 有 60s 超时，但避免重复投递）
      try {
        if (update.my_chat_member) await handleMyChatMember(env, update);
        else if (update.callback_query) await handleCallback(env, update.callback_query);
        else {
          const msg = update.message || update.channel_post;
          if (msg && msg.text && msg.text.trim().startsWith('/')) await handleCommand(env, msg);
        }
      } catch (err) {
        console.error('handle update failed', err && err.stack);
        const chatId = update.message?.chat?.id || update.channel_post?.chat?.id;
        if (chatId) await reply(env, chatId, `出错了：${esc(err.message)}`);
      }
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
