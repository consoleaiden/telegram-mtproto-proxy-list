# MTProxy 代理榜 · Telegram Bot（Cloudflare Workers）

每小时把「校验通过 + 访问速率最快」的代理推送到群里；所有查询都用**菜单按钮**操作，
列表**分页**浏览完整数据（970 条也能翻到最后一页）。
数据来自本仓库的 `proxies.json` / `top40.json`（GitHub Actions 每小时全量测速后刷新）。

线上实例：`https://mtproxy-bot.84339075.workers.dev` · Bot：[@aidenproxy_bot](https://t.me/aidenproxy_bot)

> **为什么是 Workers 而不是 Pages**：Pages Functions 没有定时触发器（Cron Triggers），
> 而这个机器人必须每小时主动推送。Workers 与 Pages 同属 Cloudflare 边缘网络，
> 免费额度足够（每天 10 万次请求、KV 10 万读/1000 写）。

## 交互：一条 `/start` 出菜单，之后全靠按钮

`/start` 只发**一条**消息，正文是说明，下面是全部功能按钮；后续每次点击都在这条消息里
原地刷新（`editMessageText`），不会刷屏。

```
MTProxy 代理榜
每小时全量测速（TCP 建连 + FakeTLS 握手往返），只把校验通过的代理排在前面。

点下面的按钮操作：
· 🚀 最快榜 / 📋 全部代理 —— 分页浏览全部代理，每页 10 条
· 📡 仅存活 —— 只看握手有响应的
· 🔍 搜索 —— 按服务器名 / 端口 / 密钥片段查
· 📊 测速统计 · ⚙️ 推送设置（群管理员）

[🚀 最快榜]  [📋 全部代理]
[📡 仅存活]  [🔍 搜索]
[📊 测速统计] [⚙️ 推送设置]
[❓ 帮助]     [🌐 网页榜单]
```

列表页长这样，导航按钮跨页连续编号：

```
🚀 最快可用代理 · 第 1/95 页
共 970 条 · 可用 942 条 · 数据 10-21 16:56（UTC+8）
筛选：仅可用（校验通过） · 第 1–10 条

🥇 storagexx.space:443 — 120ms (建连 70ms · 握手 49ms)
🥈 87.248.129.101:443 — 240ms (建连 120ms · 握手 120ms)
...
[1. 120ms] [2. 240ms]   ← 点一下就是 t.me/proxy 深链
...
[⏮] [◀️] [1/95] [▶️] [⏭]
[• ✅ 可用] [📡 存活] [📋 全部]
[🔄 刷新] [🏠 菜单] [🌐 网页]
```

| 按钮 | 作用 |
|---|---|
| 🚀 最快榜 | 校验通过 + 速率排序，分页浏览（当前 942 条 → 95 页） |
| 📋 全部代理 | 含存活 / 不可用，可翻到最后一页（970 条 → 97 页） |
| 📡 仅存活 | 握手有响应的（含未通过校验） |
| ✅ 可用 / 📡 存活 / 📋 全部 | 列表底部的筛选切换，当前项带 `•` |
| ⏮ ◀️ ▶️ ⏭ | 第一页 / 上一页 / 下一页 / 末页，边界自动禁用 |
| 🔄 刷新 | 绕过 10 分钟索引缓存，回源取最新数据 |
| 🔍 搜索 | 弹出 ForceReply，回一条关键词即可（群聊里也能收到） |
| 📊 测速统计 | 总数 / 存活 / 校验通过 / 最快 / 中位 / 数据来源 |
| ⚙️ 推送设置 | 开关本群每小时推送、立刻推一次、查看会话 ID（群管理员） |

指令仍然可用，用于快捷入口和脚本调用：`/start` `/top` `/all` `/search 关键词` `/stats`
`/settings` `/now` `/id` `/help`。群里 Telegram 默认开启隐私模式、收不到普通文字，
所以按钮用内联键盘实现，保证群里也能用；私聊里直接发关键词等同于搜索。

## 实现要点

- **全量分页**：启动时把 `proxies.json` 压成 `server/port/secret/延迟/校验/存活` 六字段
  的索引，排序后写入 KV（`cache:index:v2`，10 分钟过期），之后每次翻页只读索引，
  不再回源、也不重复解析 137KB JSON。
- **搜索分页**：命中结果（上限 500 条）存 KV 并给出一个 token，翻页回调只带
  `p:s.<token>:<页码>`，避免 callback_data 64 字节上限。
- **callback 约定**：`p:<scope>:<page>` 翻页、`r:<scope>:<page>` 强制刷新、
  `f:<scope>` 切筛选、`m:<action>` 菜单动作、`x` 提示条目不可用。
- **原地更新**：带 `message_id` 走 `editMessageText`，遇到 `message is not modified`
  静默忽略；编辑失败退回新消息，不会让用户看不到反馈。
- **0ms 脏数据**：上游死链的 `latency_ms` 可能是 `0` 而不是 `null`，渲染时统一判为
  「✖ 不可用」，不会出现「0ms 最快」这种假象。

## 推送内容（每小时）

```
⚡ MTProxy 每小时速报 · 最快代理
数据时间 10-21 15:25（UTC+8）
本轮测速 970 条 · 存活 959 · 校验通过 942

🥇 storagexx.space:443 — 120ms (建连 70ms · 握手 49ms)
🥈 87.248.129.101:443 — 240ms (建连 120ms · 握手 120ms)
...
```

按钮按排名排布，点一下就是 `https://t.me/proxy?...` 深链；底部有「📋 全部代理」
可直接进入分页列表，继续翻完整份数据。

## 架构

```
GitHub Actions（每小时 :17）
  └─ 合并两源 → 全量 FakeTLS 握手测速 → 提交 proxies.json / top40.json
       └─ GitHub Pages（静态托管）
            └─ Worker
                 ├─ cron :25 → 推送 top10 到 KV 里登记的所有群
                 ├─ webhook  → 菜单回调 / 分页 / 搜索
                 └─ KV 索引  → 10 分钟缓存的全量数据，翻页秒开
```

- **KV 用途**：`chat:<id>` 绑定关系、`cache:index:v2` 全量索引、`search:<token>` 搜索结果、
  `data:*` 上游兜底、`sent:<chat>:<小时>` 同小时去重、`meta:lastRun` / `meta:lastUpdate` 心跳。
- **webhook 安全**：URL 内含随机 secret，且校验 Telegram 的
  `X-Telegram-Bot-Api-Secret-Token` 请求头（带了就必须匹配）。
- **自注册**：cron 首次执行时自动 `setWebhook` + `setMyCommands` + `setChatMenuButton`，
  结果写入 KV，因此即使本地网络访问不了 Telegram，也能靠边缘节点完成注册。

## 本地开发

```bash
cd bot
npm install
cp .dev.vars.example .dev.vars   # 填入 BOT_TOKEN 等
npm test                        # 40 个离线单测（mock fetch + KV）
npx wrangler dev                # 本地起 worker: http://localhost:8787
```

## 部署

```bash
cd bot
npx wrangler login                              # 或 export CLOUDFLARE_API_TOKEN=...
npx wrangler kv namespace create MTPROXY_BOT    # 把返回的 id 填进 wrangler.toml
printf '%s' '<bot token>'      | npx wrangler secret put BOT_TOKEN
printf '%s' '<随机串>'          | npx wrangler secret put ADMIN_KEY
printf '%s' '<随机串>'          | npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

部署后访问一次（浏览器打开即可完成注册）：

```
https://mtproxy-bot.<你的子域>.workers.dev/admin/setup?key=<ADMIN_KEY>
```

返回里能看到 bot 用户名、webhook 状态、已绑定群列表。也可以不访问——cron 首次执行会自动注册。

### 可用端点

| 路径 | 说明 |
|---|---|
| `POST /tg/<WEBHOOK_SECRET>` | Telegram webhook（自动注册时填入） |
| `GET /admin/setup?key=…` | 幂等注册 webhook + 指令菜单，返回状态 |
| `GET /admin/push?key=…` | 立即对所有绑定群强制推送一次（绕过小时去重） |
| `GET /` | 服务自检信息 |

## 已知边界

- 免费版 cron 触发有几分钟的抖动，推送时间不是秒级精确。
- Telegram 对同群消息有频率限制；本 Bot 每小时 1 条，远低于限制。
- 索引缓存 10 分钟：刚推送完想看最新一轮数据，点一次「🔄 刷新」。
- 代理随时失效：推送里只含当轮校验通过的，若某条连不上请换下一条。
