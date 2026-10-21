import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  normalize, pickFastest, buildTopMessage, buildKeyboard, parseCommand, pushHourly, formatTime, ensureWebhook,
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

function updateMessage(text, { chatId = -100123, userId = 7, chatType = 'supergroup' } = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: userId, is_bot: false, first_name: 'u' },
      chat: { id: chatId, type: chatType, title: '测试群' },
      date: Math.floor(Date.now() / 1000),
      text,
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

/* ---------------- 渲染 ---------------- */

test('buildTopMessage：含奖牌、延迟、统计与站点链接', () => {
  const payload = topPayload(12);
  const text = buildTopMessage(payload, pickFastest(payload, 3), { site: 'https://example.test/' });
  assert.match(text, /🥇/);
  assert.match(text, /🥈/);
  assert.match(text, /🥉/);
  assert.match(text, /999\.example\.com|node1\.example\.com:443/);
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

test('buildKeyboard：每行两个连接按钮 + 刷新/网页行', () => {
  const payload = topPayload(5);
  const keyboard = buildKeyboard(pickFastest(payload, 5), { site: 'https://example.test/' });
  const rows = keyboard.inline_keyboard;
  assert.equal(rows.length, 4); // 2+2+1 按钮行 + 底部行
  assert.equal(rows[0].length, 2);
  assert.equal(rows[0][0].text, '1. 410ms');
  assert.match(rows[0][0].url, /^https:\/\/t\.me\/proxy\?server=/);
  assert.equal(rows[3][0].callback_data, 'refresh:10');
  assert.equal(rows[3][1].url, 'https://example.test/');
});

/* ---------------- 指令 ---------------- */

test('parseCommand：兼容 /cmd@BotName 与参数', () => {
  assert.deepEqual(parseCommand(' /top@mtproxy_bot 20 '), { command: 'top', args: ['20'] });
  assert.equal(parseCommand('hello'), null);
});

test('webhook：secret 不匹配返回 403', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    // 请求头错误
    const res = await callWebhook(updateMessage('/top'), env, { secret: 'wrong' });
    assert.equal(res.status, 403);
    // 路径里也不是正确 secret
    const bad = await worker.fetch(new Request('https://bot.example.test/tg/wrongpath', {
      method: 'POST', body: JSON.stringify(updateMessage('/top')),
    }), env);
    assert.equal(bad.status, 403);
    assert.equal(f.calls.length, 0, '被拒绝时不应调用 Telegram');
  } finally { f.restore(); }
});

test('webhook /top：默认返回 10 条并带键盘', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    const res = await callWebhook(updateMessage('/top'), env);
    assert.equal(res.status, 200);
    const sent = f.calls.find((c) => c.method === 'sendMessage');
    assert.ok(sent, '应调用 sendMessage');
    assert.equal(sent.body.chat_id, -100123);
    assert.equal(sent.body.parse_mode, 'HTML');
    const rows = sent.body.reply_markup.inline_keyboard;
    assert.equal(rows.length, 6, '10 个按钮两两一行 + 底部行');
    const bodyLines = sent.body.text.split('\n').filter((l) => /^(🥇|🥈|🥉|\d+\.)\s/.test(l));
    assert.equal(bodyLines.length, 10);
  } finally { f.restore(); }
});

test('webhook /top 20：限制在 40 以内且按延迟排序', async () => {
  const env = makeEnv();
  const f = installFetch(topPayload(30));
  try {
    await callWebhook(updateMessage('/top 999'), env);
    const sent = f.calls.find((c) => c.method === 'sendMessage');
    const rows = sent.body.reply_markup.inline_keyboard;
    assert.equal(rows.length, 16, '30 个按钮 -> 15 行 + 底部行');
    assert.match(sent.body.text, /最快 30 个代理/);
  } finally { f.restore(); }
});

test('webhook /search：按关键词过滤，无结果时给出提示', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    await callWebhook(updateMessage('/search node3'), env);
    const hit = f.calls.find((c) => c.method === 'sendMessage');
    assert.match(hit.body.text, /搜索「node3」/);
    assert.match(hit.body.text, /node3\.example\.com/);

    f.calls.length = 0;
    await callWebhook(updateMessage('/search notexist'), env);
    const miss = f.calls.find((c) => c.method === 'sendMessage');
    assert.match(miss.body.text, /没找到匹配/);
  } finally { f.restore(); }
});

test('webhook /stats：输出统计与来源', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    await callWebhook(updateMessage('/stats'), env);
    const sent = f.calls.find((c) => c.method === 'sendMessage');
    assert.match(sent.body.text, /测速总数 970 条/);
    assert.match(sent.body.text, /tgmtproxy 900 条/);
  } finally { f.restore(); }
});

test('webhook /bind：管理员绑定成功，普通成员被拒', async () => {
  const env = makeEnv();
  const f = installFetch();
  try {
    await callWebhook(updateMessage('/bind'), env);
    assert.ok(env.STATE._map.has('chat:-100123'), '应写入绑定记录');

    // 换成普通成员
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('api.telegram.org/getChatMember')) {
        return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }));
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      throw new Error('unexpected: ' + url);
    };
    await callWebhook(updateMessage('/bind', { chatId: -100999, userId: 42 }), env);
    assert.equal(env.STATE._map.has('chat:-100999'), false, '普通成员不应被写入');
  } finally { f.restore(); }
});

test('my_chat_member：被拉进群自动绑定并回示例', async () => {
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
    assert.match(sent.body.text, /自动绑定/);
  } finally { f.restore(); }
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

/* ---------------- 管理接口 ---------------- */

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
  } finally { f.restore(); }
});

test('根路径返回服务信息', async () => {
  const res = await worker.fetch(new Request('https://bot.example.test/'), makeEnv());
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.commands.includes('/top'));
});

/* ---------------- 自注册与定时任务 ---------------- */

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
