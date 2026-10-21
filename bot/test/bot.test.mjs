import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  normalize, pickFastest, buildTopMessage, buildKeyboard, parseCommand, pushHourly, formatTime, ensureWebhook,
  loadIndex, filterRows, buildPageView, menuAction, buildHelpText, buildStatsText, buildSettingsText,
} from '../src/index.js';

/* ---------------- 测试脚手架 ---------------- */

const FIELDS = [
  'server', 'port', 'secret', 'sources', 'alive', 'verified',
  'latency_ms', 'connect_ms', 'tls_ms', 'success_rate', 'error',
];

function row(index, { alive = true, verified = true, latency = 400 + index * 10 } = {}) {
  return [
    `node${index}.example.com`, 443, `ee${String(index).padStart(2, '0')}deadbeef`,
    ['tgmtproxy'], alive, verified,
    alive ? latency : null, alive ? latency / 2 : null, alive ? latency / 2 : null,
    alive ? 1 : 0, alive ? '' : 'connect_timeout',
  ];
}

function topPayload(count = 12) {
  return {
    generated_at: new Date().toISOString(),
    stats: { tested: 970, alive: 158, verified: 138, fastest_ms: 410, median_ms: 831, sources: { tgmtproxy: 900, dubblebyte: 80 } },
    fields: FIELDS,
    proxies: Array.from({ length: count }, (_, i) => row(i + 1)),
  };
}

/** 混装数据：alive 越多延迟越高，方便断言排序 */
function mixedPayload({ verified = 100, aliveOnly = 20, dead = 17 } = {}) {
  const rows = [];
  let n = 0;
  for (let i = 0; i < verified; i += 1) { n += 1; rows.push(row(n, { latency: 200 + n })); }
  for (let i = 0; i < aliveOnly; i += 1) { n += 1; rows.push(row(n, { verified: false, latency: 900 + n })); }
  for (let i = 0; i < dead; i += 1) { n += 1; rows.push(row(n, { alive: false, verified: false })); }
  return {
    generated_at: new Date().toISOString(),
    stats: { tested: rows.length, alive: verified + aliveOnly, verified, sources: { tgmtproxy: rows.length } },
    fields: FIELDS,
    proxies: rows,
  };
}

function fakeKV() {
  const map = new Map();
  return {
    async put(key, value) { map.set(key, String(value)); },
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async delete(key) { map.delete(key); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cursor: '',
      };
    },
    _map: map,
  };
}

function makeEnv(extra = {}) {
  return {
    BOT_TOKEN: '123:TEST',
    ADMIN_KEY: 'adminkey',
    WEBHOOK_SECRET: 'hooksecret',
    SITE_URL: 'https://example.test/',
    PUSH_LIMIT: '10',
    STATE: fakeKV(),
    ...extra,
  };
}

/** 拦截 fetch：Telegram API 记录调用，数据源返回样例 */
function installFetch(payload = topPayload()) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop();
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      const result = {
        getMe: { id: 1, username: 'mtproxy_test_bot', first_name: 'test' },
        getWebhookInfo: { url: 'https://x/tg/hooksecret', pending_update_count: 0 },
        getChatMember: { status: 'administrator', user: { id: 7 } },
        sendMessage: { message_id: calls.length },
        editMessageText: true,
        answerCallbackQuery: true,
        setWebhook: true,
        setMyCommands: true,
        setChatMenuButton: true,
      }[method];
      return new Response(JSON.stringify({ ok: true, result: result ?? true }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('top40.json') || url.includes('proxies.json')) {
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected fetch: ' + url);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function updateMessage(text, { chatId = -100123, userId = 7, chatType = 'supergroup', replyToBot = false } = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: userId, is_bot: false, first_name: 'u' },
      chat: { id: chatId, type: chatType, title: '测试群' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(replyToBot ? { reply_to_message: { message_id: 9, from: { id: 1, is_bot: true } } } : {}),
    },
  };
}

function updateCallback(data, { chatId = -100123, userId = 7, chatType = 'supergroup' } = {}) {
  return {
    update_id: 3,
    callback_query: {
      id: 'cb1',
      from: { id: userId, is_bot: false, first_name: 'u' },
      data,
      message: {
        message_id: 20,
        chat: { id: chatId, type: chatType, title: '测试群' },
        date: Math.floor(Date.now() / 1000),
      },
    },
  };
}

async function callWebhook(update, env, { secret = 'hooksecret' } = {}) {
  const request = new Request('https://bot.example.test/tg/hooksecret', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  });
  return worker.fetch(request, env);
}

/** 取最后一次「可见消息」调用（sendMessage / editMessageText） */
function lastRender(calls) {
  return [...calls].reverse().find((c) => ['sendMessage', 'editMessageText'].includes(c.method));
}

/* ---------------- 数据层 ---------------- */

test('normalize：二维数组按 fields 还原为对象', () => {
  const items = normalize(topPayload(3));
  assert.equal(items.length, 3);
  assert.equal(items[0].server, 'node1.example.com');
  assert.equal(items[0].port, 443);
  assert.equal(items[0].verified, true);
  assert.equal(items[2].latency_ms, 430);
});

test('pickFastest：过滤不可用并按延迟升序取前 N', () => {
  const payload = {
    fields: FIELDS,
    proxies: [
      row(1, { latency: 900 }),
      row(2, { alive: false }),
      row(3, { latency: 500 }),
      row(4, { verified: false, latency: 450 }),
      row(5, { latency: 700 }),
    ],
  };
  const items = pickFastest(payload, 10);
  assert.deepEqual(items.map((i) => i.server), ['node3.example.com', 'node5.example.com', 'node1.example.com']);
  assert.equal(pickFastest(payload, 2).length, 2);
});

test('formatTime：按 UTC+8 输出 MM-DD HH:mm', () => {
  assert.equal(formatTime('2026-10-21T06:47:00Z'), '10-21 14:47');
});

test('loadIndex：全量排序为 校验通过 → 存活 → 延迟升序，并写 KV 缓存', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    const index = await loadIndex(env);
    assert.equal(index.rows.length, 137);
    assert.equal(index.rows[0].verified, true);
    assert.equal(index.rows[0].latency_ms, 201);
    const firstDead = index.rows.findIndex((r) => !r.alive);
    assert.ok(firstDead >= 120, '不可用的应排在最后');
    assert.ok(env.STATE._map.has('cache:index:v2'));

    // 第二次命中缓存：数据源不再被请求
    const before = f.calls.length;
    const again = await loadIndex(env);
    assert.equal(again.cached, true);
    assert.equal(f.calls.length, before);
  } finally { f.restore(); }
});

test('filterRows：v/l/a 三种范围', () => {
  const rows = [
    { verified: true, alive: true, latency_ms: 100 },
    { verified: false, alive: true, latency_ms: 200 },
    { verified: false, alive: false, latency_ms: null },
  ];
  assert.equal(filterRows(rows, 'v').length, 1);
  assert.equal(filterRows(rows, 'l').length, 2);
  assert.equal(filterRows(rows, 'a').length, 3);
});

/* ---------------- 分页渲染 ---------------- */

test('buildPageView：每页 10 条、排名跨页连续、可翻到末页', () => {
  const rows = Array.from({ length: 137 }, (_, i) => ({
    server: `p${i + 1}.example.com`, port: 443, secret: 'ee00', latency_ms: 100 + i, verified: true, alive: true,
  }));

  const first = buildPageView(rows, { scope: 'v', page: 1 });
  assert.equal(first.total, 14, '137 条 -> 14 页');
  assert.equal(first.items.length, 10);
  assert.match(first.text, /第 1\/14 页/);
  assert.match(first.text, /<b>100ms<\/b>/);
  assert.match(first.text, /🥇 <code>p1\.example\.com:443<\/code>/, '第 1 名用金牌');

  const second = buildPageView(rows, { scope: 'v', page: 2 });
  assert.equal(second.start, 10);
  assert.match(second.text, /第 2\/14 页/);
  assert.match(second.text, /11\. <code>p11\.example\.com:443<\/code>/, '排名应连续');

  const last = buildPageView(rows, { scope: 'v', page: 14 });
  assert.equal(last.items.length, 7);
  assert.match(last.text, /第 14\/14 页/);
  assert.match(last.text, /131\. <code>p131\.example\.com:443<\/code>/);

  // 越界页码被夹到末页
  assert.equal(buildPageView(rows, { scope: 'v', page: 999 }).page, 14);
  assert.equal(buildPageView(rows, { scope: 'v', page: 0 }).page, 1);
});

test('buildPageView：导航按钮回调与边界禁用', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    server: `p${i + 1}.example.com`, port: 443, secret: 'ee00', latency_ms: 100 + i, verified: true, alive: true,
  }));

  const kb1 = buildPageView(rows, { scope: 'v', page: 1 }).keyboard.inline_keyboard;
  assert.equal(kb1.length, 8, '5 行按钮 + 导航 + 筛选 + 底部');
  assert.equal(kb1[5][0].callback_data, 'm:noop', '首页禁用「第一页/上一页」');
  assert.equal(kb1[5][3].callback_data, 'p:v:2');
  assert.equal(kb1[5][2].text, '1/3');

  const lastKb = buildPageView(rows, { scope: 'v', page: 3 }).keyboard.inline_keyboard;
  assert.equal(lastKb.length, 6, '3 行按钮（5 条） + 导航 + 筛选 + 底部');
  const nav = lastKb[3];
  assert.equal(nav[0].callback_data, 'p:v:1');
  assert.equal(nav[3].callback_data, 'm:noop', '末页禁用「下一页/最后一页」');
});

test('buildPageView：不可用条目标 ✖ 且不提供添加链接；筛选项标出当前范围', () => {
  const rows = [
    { server: 'ok.example.com', port: 443, secret: 'eeaa', latency_ms: 120, verified: true, alive: true },
    { server: 'bad.example.com', port: 443, secret: 'eebb', latency_ms: null, verified: false, alive: false },
  ];
  const view = buildPageView(rows, { scope: 'a', page: 1 });
  assert.match(view.text, /ok\.example\.com:443/);
  assert.match(view.text, /bad\.example\.com:443<\/code> — ✖ 不可用/);
  const kb = view.keyboard.inline_keyboard;
  assert.equal(kb[0][0].url.startsWith('https://t.me/proxy?server=ok.example.com'), true);
  assert.equal(kb[0][1].callback_data, 'x', '不可用条目用回调提示，不给添加链接');
  const filterRow = kb[kb.length - 2];
  assert.deepEqual(filterRow.map((b) => b.callback_data), ['f:v', 'f:l', 'f:a']);
  assert.equal(filterRow[2].text.startsWith('• '), true, '当前筛选应标记');
  const bottom = kb[kb.length - 1];
  assert.equal(bottom[0].callback_data, 'r:a:1');
  assert.equal(bottom[2].url, 'https://consoleaiden.github.io/telegram-mtproto-proxy-list/');
});

test('buildPageView：0ms 的坏数据不显示成 0ms', () => {
  // 上游死链的 latency_ms 可能是 0 而不是 null，不能当成「0ms 极快」
  const rows = [
    { server: 'dead.example.com', port: 443, secret: 'eeaa', latency_ms: 0, verified: false, alive: false },
    { server: 'zero.example.com', port: 443, secret: 'eebb', latency_ms: 0, verified: false, alive: true },
  ];
  const view = buildPageView(rows, { scope: 'a', page: 1 });
  assert.doesNotMatch(view.text, /<b>0ms<\/b>/);
  assert.match(view.text, /dead\.example\.com:443<\/code> — ✖ 不可用/);
  assert.match(view.text, /zero\.example\.com:443<\/code> — ✖ 无测速数据/);
  assert.equal(view.keyboard.inline_keyboard[0][0].callback_data, 'x');
  assert.equal(filterRows(rows, 'v').length, 0);
});

test('buildPageView：搜索结果不带筛选行，标题显示关键词', () => {
  const rows = [{ server: 'a.example.com', port: 443, secret: 'ee', latency_ms: 300, verified: true, alive: true }];
  const view = buildPageView(rows, { scope: 'a', page: 1, search: 'meow', title: '🔍 搜索「meow」' });
  assert.match(view.text, /搜索「meow」/);
  assert.match(view.text, /命中 1 条/);
  const kb = view.keyboard.inline_keyboard;
  assert.equal(kb.length, 3, '按钮行 + 导航 + 底部（无筛选行）');
});

/* ---------------- 菜单 ---------------- */

test('menuAction：按钮文案与裸关键词都能识别', () => {
  assert.equal(menuAction('🚀 最快榜'), 'top');
  assert.equal(menuAction('📋 全部代理'), 'all');
  assert.equal(menuAction('📡 仅存活'), 'alive');
  assert.equal(menuAction('🔍 搜索'), 'search');
  assert.equal(menuAction('📊 统计'), 'stats');
  assert.equal(menuAction('⚙️ 设置'), 'settings');
  assert.equal(menuAction('帮助'), 'help');
  assert.equal(menuAction('/top'), null, '指令交给 parseCommand');
  assert.equal(menuAction('随便聊聊'), null);
});

test('webhook /start：只发一条消息，正文带菜单且按钮齐全', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    await callWebhook(updateMessage('/start', { chatType: 'private', chatId: 555 }), env);
    const sends = f.calls.filter((c) => c.method === 'sendMessage');
    assert.equal(sends.length, 1, '不要第二条消息');
    assert.equal(f.calls.filter((c) => c.method === 'editMessageText').length, 0);
    assert.equal(sends[0].body.reply_markup.keyboard, undefined, '不要再附带常驻键盘');
    const kb = sends[0].body.reply_markup.inline_keyboard;
    assert.equal(kb.length, 4);
    assert.equal(kb[0][0].callback_data, 'm:top');
    assert.match(sends[0].body.text, /MTProxy 代理榜/);
    assert.match(sends[0].body.text, /全部代理/);
  } finally { f.restore(); }
});

test('webhook：点击「全部代理」按钮 -> 分页第一页（含不可用）', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('m:all'), env);
    const edited = f.calls.find((c) => c.method === 'editMessageText');
    assert.ok(edited, '应原地编辑而不是再发一条');
    assert.equal(edited.body.message_id, 20);
    assert.match(edited.body.text, /全部代理 · 第 1\/14 页/);
    assert.equal(edited.body.reply_markup.inline_keyboard[0].length, 2);
    const answers = f.calls.filter((c) => c.method === 'answerCallbackQuery');
    assert.equal(answers.length, 1);
  } finally { f.restore(); }
});

test('webhook：翻页回调 p:a:3 展示第 3 页且排名连续', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('p:a:3'), env);
    const edited = f.calls.find((c) => c.method === 'editMessageText');
    assert.match(edited.body.text, /第 3\/14 页/);
    assert.match(edited.body.text, /21\. /);
    assert.equal(edited.body.reply_markup.inline_keyboard[5][3].callback_data, 'p:a:4');
  } finally { f.restore(); }
});

test('webhook：切换筛选 f:v 只显示可用代理', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('f:v'), env);
    const edited = f.calls.find((c) => c.method === 'editMessageText');
    assert.match(edited.body.text, /最快可用代理 · 第 1\/10 页/, '100 条可用 -> 10 页');
    assert.match(edited.body.text, /筛选：仅可用/);
  } finally { f.restore(); }
});

test('webhook：群里的菜单按钮文字也能触发（不依赖隐私模式）', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateMessage('📡 仅存活'), env);
    const sent = lastRender(f.calls);
    assert.match(sent.body.text, /存活代理 · 第 1\/12 页/, '120 条存活 -> 12 页');
  } finally { f.restore(); }
});

test('webhook：不可用条目的 x 回调给出提示', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('x'), env);
    const answer = f.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.match(answer.body.text, /不可用/);
    assert.equal(f.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).length, 0);
  } finally { f.restore(); }
});

test('webhook：m:noop 与首页上一页不产生消息', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('m:noop'), env);
    assert.equal(f.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).length, 0);
  } finally { f.restore(); }
});

/* ---------------- 搜索 ---------------- */

test('webhook /search：结果可分页，token 存 KV', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateMessage('/search node1'), env);
    const sent = lastRender(f.calls);
    assert.match(sent.body.text, /搜索「node1」/);
    assert.match(sent.body.text, /node1\.example\.com/);
    const stored = [...env.STATE._map.keys()].filter((k) => k.startsWith('search:'));
    assert.equal(stored.length, 1);

    const token = stored[0].slice('search:'.length);
    const nav = sent.body.reply_markup.inline_keyboard;
    const nextBtn = nav.find((row) => row.some((b) => /^p:s\./.test(b.callback_data || '')));
    assert.ok(nextBtn || nav.length >= 2, '搜索页也要有导航');

    f.calls.length = 0;
    const pageData = JSON.parse(env.STATE._map.get(stored[0]));
    assert.ok(pageData.rows.length >= 1);
    await callWebhook(updateCallback(`p:s.${token}:1`), env);
    assert.match(lastRender(f.calls).body.text, /搜索「node1」/);
  } finally { f.restore(); }
});

test('webhook /search：无结果与空关键词的提示', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateMessage('/search notexist'), env);
    assert.match(lastRender(f.calls).body.text, /没找到匹配/);

    f.calls.length = 0;
    await callWebhook(updateMessage('/search'), env);
    assert.match(lastRender(f.calls).body.text, /请输入关键词/);
    assert.equal(lastRender(f.calls).body.reply_markup.force_reply, true);
  } finally { f.restore(); }
});

test('webhook：私聊里直接发文字 = 搜索；群里普通聊天不打扰', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateMessage('node2', { chatType: 'private', chatId: 777 }), env);
    assert.match(lastRender(f.calls).body.text, /搜索「node2」/);

    f.calls.length = 0;
    await callWebhook(updateMessage('今天天气不错'), env);
    assert.equal(f.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).length, 0);
  } finally { f.restore(); }
});

test('webhook：搜索 token 过期给出重试入口', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('p:s.deadbeef:2'), env);
    const sent = lastRender(f.calls);
    assert.match(sent.body.text, /已过期/);
    assert.equal(sent.body.reply_markup.inline_keyboard[0][0].callback_data, 'm:search');
  } finally { f.restore(); }
});

/* ---------------- 统计 / 设置 / 帮助 ---------------- */

test('webhook：统计与设置菜单可编辑展示', async () => {
  const env = makeEnv();
  await env.STATE.put('chat:-100123', JSON.stringify({ id: -100123, title: 'A', type: 'supergroup' }));
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('m:stats'), env);
    let edited = f.calls.find((c) => c.method === 'editMessageText');
    assert.match(edited.body.text, /测速总数 137 条/);
    assert.match(edited.body.text, /tgmtproxy 137 条/);
    assert.match(edited.body.text, /共收录 137 条代理记录/);

    f.calls.length = 0;
    await callWebhook(updateCallback('m:settings'), env);
    edited = f.calls.find((c) => c.method === 'editMessageText');
    assert.match(edited.body.text, /每小时推送：✅ 已开启/);
    assert.equal(edited.body.reply_markup.inline_keyboard[0][0].callback_data, 'm:off');
  } finally { f.restore(); }
});

test('webhook：设置里开关推送，管理员生效、普通成员被拒', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    await callWebhook(updateCallback('m:on'), env);
    assert.ok(env.STATE._map.has('chat:-100123'), '管理员应能开启');
    assert.match(lastRender(f.calls).body.text, /已开启/);

    await callWebhook(updateCallback('m:off'), env);
    assert.equal(env.STATE._map.has('chat:-100123'), false, '应能关闭');

    // 普通成员
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/getChatMember')) {
        return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }));
      }
      if (url.includes('api.telegram.org')) {
        const method = url.split('/').pop();
        return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true }));
      }
      throw new Error('unexpected: ' + url);
    };
    await callWebhook(updateCallback('m:on', { chatId: -100999, userId: 42 }), env);
    assert.equal(env.STATE._map.has('chat:-100999'), false, '普通成员不应被写入');
  } finally { f.restore(); }
});

test('自动绑定：频道里用一次指令就补上绑定，关掉后不再自动绑', async () => {
  const env = makeEnv();
  const f = installFetch(mixedPayload());
  try {
    // 频道里发 /stats：之前没绑定（模拟 my_chat_member 丢失）
    await callWebhook(updateMessage('/stats', { chatId: -1004416781529, chatType: 'channel' }), env);
    assert.ok(env.STATE._map.has('chat:-1004416781529'), '应在指令使用时补齐绑定');

    // 点翻页按钮也算在用
    await callWebhook(updateCallback('m:all', { chatId: -100555, chatType: 'supergroup' }), env);
    assert.ok(env.STATE._map.has('chat:-100555'));

    // 管理员关掉推送后写入 optout，后续再用也不自动绑
    await callWebhook(updateCallback('m:off', { chatId: -100555 }), env);
    assert.equal(env.STATE._map.has('chat:-100555'), false);
    assert.ok(env.STATE._map.has('optout:-100555'));

    await callWebhook(updateMessage('/top', { chatId: -100555 }), env);
    assert.equal(env.STATE._map.has('chat:-100555'), false, '显式关闭后不应被自动绑回');

    // 重新开启会清掉 optout
    await callWebhook(updateCallback('m:on', { chatId: -100555 }), env);
    assert.ok(env.STATE._map.has('chat:-100555'));
    assert.equal(env.STATE._map.has('optout:-100555'), false);
  } finally { f.restore(); }
});

test('buildHelpText / buildStatsText / buildSettingsText 文案完整', () => {
  assert.match(buildHelpText(), /分页|翻页/);
  assert.match(buildHelpText(), /全部代理/);
  const stats = buildStatsText({
    generated_at: new Date().toISOString(),
    stats: { tested: 10, alive: 8, verified: 6, fastest_ms: 410, median_ms: 800, sources: { a: 5, b: 5 } },
    rows: new Array(10),
  });
  assert.match(stats, /最快 410ms/);
  assert.match(stats, /来源：a 5 条 · b 5 条/);
  assert.match(buildSettingsText({ id: -1, type: 'private' }, false), /私聊/);
  assert.match(buildSettingsText({ id: -2, type: 'supergroup', title: 'T' }, true), /✅ 已开启/);
});

/* ---------------- 兼容：指令仍可用 ---------------- */

test('parseCommand：兼容 /cmd@BotName 与参数', () => {
  assert.deepEqual(parseCommand(' /top@mtproxy_bot 20 '), { command: 'top', args: ['20'] });
  assert.equal(parseCommand('hello'), null);
});

test('webhook /top：走菜单同一套分页视图', async () => {
  const env = makeEnv();
  const f = installFetch(topPayload(12));
  try {
    await callWebhook(updateMessage('/top'), env);
    const sent = lastRender(f.calls);
    assert.match(sent.body.text, /最快可用代理 · 第 1\/2 页/);
    assert.equal(sent.body.reply_markup.inline_keyboard.length, 8, '5 行按钮 + 导航 + 筛选 + 底部');
  } finally { f.restore(); }
});

test('未知指令回到菜单', async () => {
  const env = makeEnv();
  const f = installFetch(topPayload(5));
  try {
    await callWebhook(updateMessage('/nonsense'), env);
    assert.match(lastRender(f.calls).body.text, /点下面的按钮操作/);
  } finally { f.restore(); }
});

/* ---------------- 渲染（每小时推送） ---------------- */

test('buildTopMessage：含奖牌、延迟、统计与站点链接', () => {
  const payload = topPayload(12);
  const text = buildTopMessage(payload, pickFastest(payload, 3), { site: 'https://example.test/' });
  assert.match(text, /🥇/);
  assert.match(text, /🥈/);
  assert.match(text, /🥉/);
  assert.match(text, /node1\.example\.com:443/);
  assert.match(text, /本轮测速 970 条/);
  assert.match(text, /https:\/\/example\.test\//);
  assert.doesNotMatch(text, /4\. /, '只应列出 3 条');
});

test('buildTopMessage：缓存数据带警示', () => {
  const payload = { ...topPayload(2), _stale: true, generated_at: new Date(Date.now() - 5 * 3600e3).toISOString() };
  const text = buildTopMessage(payload, pickFastest(payload, 2));
  assert.match(text, /缓存数据/);
  assert.match(text, /超过 3 小时/);
});

test('buildKeyboard：每行两个连接按钮 + 全部代理/网页行', () => {
  const payload = topPayload(5);
  const keyboard = buildKeyboard(pickFastest(payload, 5), { site: 'https://example.test/' });
  const rows = keyboard.inline_keyboard;
  assert.equal(rows.length, 4); // 2+2+1 + 底部行
  assert.equal(rows[0].length, 2);
  assert.equal(rows[0][0].text, '1. 410ms');
  assert.match(rows[0][0].url, /^https:\/\/t\.me\/proxy\?server=/);
  assert.equal(rows[3][0].callback_data, 'm:all');
  assert.equal(rows[3][1].url, 'https://example.test/');
});

/* ---------------- 定时推送 ---------------- */

test('pushHourly：向已绑定群推送 10 条，同小时去重', async () => {
  const env = makeEnv();
  await env.STATE.put('chat:-100123', JSON.stringify({ id: -100123, title: 'A', type: 'supergroup' }));
  await env.STATE.put('chat:-100456', JSON.stringify({ id: -100456, title: 'B', type: 'supergroup' }));
  const f = installFetch();
  try {
    const first = await pushHourly(env);
    assert.equal(first.chats, 2);
    assert.equal(first.sent, 2);
    const sends = f.calls.filter((c) => c.method === 'sendMessage');
    assert.equal(sends.length, 2);
    assert.equal(sends[0].body.reply_markup.inline_keyboard.length, 6);
    assert.equal(sends[0].body.reply_markup.inline_keyboard[5][0].callback_data, 'm:all');

    const second = await pushHourly(env);
    assert.equal(second.sent, 0, '同一小时不应重复推送');
    assert.equal(second.skipped, 2);
  } finally { f.restore(); }
});

test('pushHourly：force 可绕过去重', async () => {
  const env = makeEnv();
  await env.STATE.put('chat:-100123', JSON.stringify({ id: -100123, title: 'A', type: 'supergroup' }));
  const f = installFetch();
  try {
    await pushHourly(env);
    const forced = await pushHourly(env, { force: true });
    assert.equal(forced.sent, 1);
  } finally { f.restore(); }
});

test('pushHourly：无可绑定群时安全返回', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    const res = await pushHourly(env);
    assert.deepEqual({ chats: res.chats, sent: res.sent }, { chats: 0, sent: 0 });
  } finally { f.restore(); }
});

/* ---------------- webhook 鉴权 / 管理接口 ---------------- */

test('webhook：secret 不匹配返回 403', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    const res = await callWebhook(updateMessage('/top'), env, { secret: 'wrong' });
    assert.equal(res.status, 403);
    const bad = await worker.fetch(new Request('https://bot.example.test/tg/wrongpath', {
      method: 'POST', body: JSON.stringify(updateMessage('/top')),
    }), env);
    assert.equal(bad.status, 403);
    assert.equal(f.calls.length, 0, '被拒绝时不应调用 Telegram');
  } finally { f.restore(); }
});

test('admin/setup：无 key 拒绝，正确 key 注册 webhook', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    const denied = await worker.fetch(new Request('https://bot.example.test/admin/setup'), env);
    assert.equal(denied.status, 403);

    const res = await worker.fetch(new Request('https://bot.example.test/admin/setup?key=adminkey'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.hookUrl, 'https://bot.example.test/tg/hooksecret');
    const setWebhook = f.calls.find((c) => c.method === 'setWebhook');
    assert.equal(setWebhook.body.secret_token, 'hooksecret');
    assert.deepEqual(setWebhook.body.allowed_updates.includes('callback_query'), true);
    assert.ok(f.calls.find((c) => c.method === 'setMyCommands'), '应设置指令菜单');
    assert.ok(f.calls.find((c) => c.method === 'setChatMenuButton'), '应设置左下角菜单按钮');
  } finally { f.restore(); }
});

test('根路径返回服务信息', async () => {
  const res = await worker.fetch(new Request('https://bot.example.test/'), makeEnv());
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.ui, 'menu + pagination');
  assert.ok(data.commands.includes('/top'));
});

test('ensureWebhook：首次注册，第二次走 KV 缓存', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    const first = await ensureWebhook(env, 'bot.example.test');
    assert.equal(first.url, 'https://bot.example.test/tg/hooksecret');
    assert.equal(f.calls.filter((c) => c.method === 'setWebhook').length, 1);
    assert.ok(env.STATE._map.has('meta:webhook'));

    const second = await ensureWebhook(env, 'bot.example.test');
    assert.equal(second.cached, true);
    assert.equal(f.calls.filter((c) => c.method === 'setWebhook').length, 1, '不应重复注册');
  } finally { f.restore(); }
});

test('scheduled：注册 webhook 并写入 meta:lastRun', async () => {
  const env = makeEnv({ WORKER_HOST: 'bot.example.test' });
  await env.STATE.put('chat:-100123', JSON.stringify({ id: -100123, title: 'A', type: 'supergroup' }));
  const f = installFetch();
  try {
    let pending;
    await worker.scheduled({ cron: '0 * * * *' }, env, { waitUntil: (p) => { pending = p; } });
    await pending;
    assert.ok(env.STATE._map.has('meta:webhook'));
    const lastRun = JSON.parse(env.STATE._map.get('meta:lastRun'));
    assert.equal(lastRun.chats, 1);
    assert.equal(lastRun.sent, 1);
    assert.equal(lastRun.cron, '0 * * * *');
  } finally { f.restore(); }
});

test('my_chat_member：被拉进群自动绑定并给出菜单', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    await callWebhook({
      update_id: 2,
      my_chat_member: {
        chat: { id: -100777, type: 'supergroup', title: '新群' },
        from: { id: 9, first_name: 'x' },
        new_chat_member: { status: 'member', user: { id: 1 } },
      },
    }, env);
    assert.ok(env.STATE._map.has('chat:-100777'));
    const sent = f.calls.find((c) => c.method === 'sendMessage');
    assert.match(sent.body.text, /自动开启每小时推送/);
    assert.equal(sent.body.reply_markup.inline_keyboard[0][0].callback_data, 'm:top');
  } finally { f.restore(); }
});
