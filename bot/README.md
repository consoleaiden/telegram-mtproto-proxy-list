# MTProxy 代理榜 · Telegram Bot（Cloudflare Workers）

每小时把「校验通过 + 访问速率最快」的代理推送到群里，同时支持在群内用指令随时查询。
数据来自本仓库的 `top40.json` / `proxies.json`（GitHub Actions 每小时全量测速后刷新）。

线上实例：`https://mtproxy-bot.84339075.workers.dev` · Bot：[@aidenproxy_bot](https://t.me/aidenproxy_bot)

> **为什么是 Workers 而不是 Pages**：Pages Functions 没有定时触发器（Cron Triggers），
> 而这个机器人必须每小时主动推送。Workers 与 Pages 同属 Cloudflare 边缘网络，
> 免费额度足够（每天 10 万次请求、KV 10 万读/1000 写）。

## 指令

| 指令 | 作用 |
|---|---|
| `/top [n]` | 最快 n 个代理（默认 10，最多 40），每条带「连接」按钮 |
| `/fast` | 只要最快的那一个 |
| `/search 关键词` | 按服务器名 / 端口 / 密钥前缀搜索，最多 10 条 |
| `/stats` | 本轮测速统计（总数、存活、校验通过、最快、中位、来源） |
| `/bind` | 把当前群设为每小时推送目标（需群管理员） |
| `/unbind` | 取消当前群的推送 |
| `/now` | 立刻推送一次最快 10 个 |
| `/id` | 查看当前会话 ID（排查绑定问题用） |
| `/help` | 使用说明 |

拉进群会**自动绑定**并回一条示例消息，无需手动 `/bind`。

## 推送内容

```
⚡ MTProxy 每小时速报 · 最快代理
数据时间 10-21 15:25（UTC+8）
本轮测速 970 条 · 存活 158 · 校验通过 138

🥇 179.237.76.190:443 — 493ms (建连 246ms · 握手 248ms)
🥈 179.237.76.238:443 — 495ms (建连 246ms · 握手 248ms)
...
```

按钮按排名排布，点一下就是 `https://t.me/proxy?...` 深链，Telegram 会弹窗确认添加。

## 架构

```
GitHub Actions（每小时 :17）
  └─ 合并两源 → 全量 FakeTLS 握手测速 → 提交 proxies.json / top40.json
       └─ GitHub Pages（静态托管）
            └─ Worker 读取 top40.json
                 ├─ cron :25 → 推送到 KV 里登记的所有群
                 └─ webhook   → 处理 /top /search 等指令
```

- **KV 用途**：`chat:<id>` 绑定关系、`data:*` 数据兜底缓存（上游挂了用上次的）、
  `sent:<chat>:<小时>` 同一小时去重、`meta:lastRun` / `meta:lastUpdate` 运行心跳。
- **webhook 安全**：URL 内含随机 secret，且校验 Telegram 的
  `X-Telegram-Bot-Api-Secret-Token` 请求头（带了就必须匹配）。
- **自注册**：cron 首次执行时自动 `setWebhook` + `setMyCommands`，结果写入 KV，
  因此即使本地网络访问不了 Telegram，也能靠边缘节点完成注册。

## 本地开发

```bash
cd bot
npm install
cp .dev.vars.example .dev.vars   # 填入 BOT_TOKEN 等
npm test                        # 21 个离线单测（mock fetch + KV）
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
- 代理随时失效：推送里只含当轮校验通过的，若某条连不上请换下一条。
