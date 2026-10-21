# Telegram MTProto 代理列表 · 中文版

> 每小时自动同步上游数据、保留中文界面的 Telegram MTProxy 在线目录。
> 数据来自两个公开代理列表，合并去重后提供 **970+** 条可直接使用的 `t.me/proxy` 链接。

**🌐 在线站点：[consoleaiden.github.io/telegram-mtproto-proxy-list](https://consoleaiden.github.io/telegram-mtproto-proxy-list/)**
**📄 纯文本列表：[`proxies.txt`](proxies.txt)**

---

## 这是什么

Telegram 在部分网络环境下无法直连，需要 MTProto 代理（MTProxy）中转。本项目是开源代理列表站的**中文分支**：

- 页面全中文（标题、按钮、连接教程、常见问题、结构化数据），由 `translate.py` 自动生成
- 每小时跟随上游刷新代理数据，**汉化不会被上游覆盖**
- `proxies.txt` 在主流列表基础上，额外合并第二个公开源，并按 `server + port + secret` 去重
- 纯静态托管在 GitHub Pages：无后端、无统计脚本、无 Cookie

## 数据源与更新机制

| 角色 | 仓库 | 提供内容 |
|---|---|---|
| 主源 | [tgmtproxy/telegram-mtproto-proxy-list](https://github.com/tgmtproxy/telegram-mtproto-proxy-list) | 页面结构与经握手验证的代理列表（`index.html`、`proxies.txt`） |
| 次源 | [dubblebyte/free-mtproto-proxies](https://github.com/dubblebyte/free-mtproto-proxies) | 额外的公开代理链接（`all_proxies.txt`） |

每小时的流水线（`.github/workflows/sync-upstream.yml`，`cron: 23 * * * *`）：

```
上游主源快照 ──► translate.py 重新汉化 index.html ──► 覆盖 proxies.txt 等数据文件
                                                        │
次源 all_proxies.txt ──► merge_proxies.py 去重合并 ──────┘
                                                        │
                                        有实际变化才 commit ──► Pages 自动重建
```

设计要点：

- **不做 GitHub「Sync fork」**：那会用俄语页面覆盖汉化结果；同步一律走上面的工作流
- **幂等**：`translate.py` 对已汉化页面重跑零变化，`merge_proxies.py` 重复合并零新增，避免空提交
- **失败降级**：次源不可达时只打 warning 并继续发布主列表，不会因单个源故障中断整点更新
- **可观测**：上游若新增未收录的俄语文案，数据照常同步，未译片段以 `WARNING:` 形式出现在 Actions 日志

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 中文落地页（服务器表格、连接教程、FAQ、结构化数据） |
| `proxies.txt` | 合并去重后的代理链接列表，每行一条 `https://t.me/proxy?server=…&port=…&secret=…` |
| `translate.py` | 俄语 → 简体中文本地化脚本（正则模板 + 词典 + 词表兜底） |
| `merge_proxies.py` | 多源代理列表合并（按 `server+port+secret` 去重，刷新表头计数） |
| `.github/workflows/sync-upstream.yml` | 每小时同步 + 重新汉化 + 合并 + 提交 |
| `robots.txt` / `.nojekyll` | Pages 相关配置 |

## 怎么用

1. 打开[在线站点](https://consoleaiden.github.io/telegram-mtproto-proxy-list/)，在表格里点「连接」——Telegram 会自动弹出添加代理的确认框
2. 想批量导入，直接取 [`proxies.txt`](proxies.txt)，逐条点击即可
3. 桌面端：`tg://proxy` 链接由已安装的 Telegram Desktop 接管；若打开空白页，改用页面上的 `t.me` 按钮
4. 连接后在「设置 → 数据和存储 → 代理」确认「使用代理」已勾选

## 本地复现

```bash
# 重新汉化一份上游页面
python3 translate.py upstream.html index.html

# 合并额外列表（可传多个）
python3 merge_proxies.py proxies.txt all_proxies.txt > merged.txt
```

手动跑一次线上同步：仓库 → Actions → **Sync upstream and re-localize index.html** → Run workflow。

## 维护提示

- **上游新增文案**：看 Actions 日志里的 `WARNING: N untranslated fragment(s)`，把原文与译文补进 `translate.py` 的正则或词典
- **上游改版**：若表格结构变化，优先修 `translate.py` 的选择器/正则，而不是手改 `index.html`（下次同步会被覆盖）
- **代理数量**：`index.html` 的表格行来自主源，`proxies.txt` 含合并后的次源条目，两者数量不一致属于预期

## 免责声明

- 所有代理均为互联网公开收集，**可用性、速度与安全性无任何担保**；请勿通过公共代理传输敏感信息
- 本项目仅做公开数据的聚合、翻译与去重，不运营任何代理服务器
- 页面内容与数据结构版权归上游仓库所有；本分支的翻译与自动化脚本同样以开源方式提供

## 致谢

- [tgmtproxy/telegram-mtproto-proxy-list](https://github.com/tgmtproxy/telegram-mtproto-proxy-list) — 主数据源与页面结构
- [dubblebyte/free-mtproto-proxies](https://github.com/dubblebyte/free-mtproto-proxies) — 补充代理列表
- [Telegram](https://telegram.org) — MTProto 协议与 `t.me/proxy` 链接方案
