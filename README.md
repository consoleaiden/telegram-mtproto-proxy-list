# Telegram MTProto 代理榜 · 中文版

> 每小时合并两个公开数据源、对**每一条**代理做真实 MTProto 握手测速，按访问速率排序，
> 输出最快 40 个代理的 JSON，并用这份合并数据重建页面。

**🌐 在线站点：[consoleaiden.github.io/telegram-mtproto-proxy-list](https://consoleaiden.github.io/telegram-mtproto-proxy-list/)**
**⚡ 最快 40 个：[`top40.json`](top40.json)** · **📄 明文列表：[`proxies.txt`](proxies.txt)** · **📊 全量明细：[`proxies.json`](proxies.json)**

---

## 这是什么

Telegram 在部分网络环境下无法直连，需要 MTProto 代理（MTProxy）中转。本项目把两个公开代理列表合并去重后，
每台都亲手握手验一遍，再按**访问速率**排序 —— 你打开页面看到的第 1 名，就是测速节点实测最快的那台。

和上游列表的区别：

| | 上游列表 | 本项目 |
|---|---|---|
| 数据来源 | 单一来源 | 两个来源合并去重（带来源标签） |
| 排序 | 未验证 / 按发现顺序 | 真实握手测速，最快在前 |
| 存活标记 | 部分 | 全量，含失败原因 |
| 交付物 | `proxies.txt` | `proxies.txt` + `proxies.json` + `top40.json` |
| 页面 | 上游生成，靠正则汉化 | 本项目自建，直接渲染合并数据 |

## 数据流

```
主源 tgmtproxy/proxies.txt ─┐
                            ├─ 去重合并（server+port+secret）─ 全量握手测速（并发 128）─ 按速率排序 ─┬─ proxies.txt
次源 dubblebyte/all_proxies.txt ─┘                                                                ├─ proxies.json
                                                                                                  └─ top40.json
                                                                                                        │
                                                                                          有变化才 commit ─→ Pages 重建
```

每小时的流水线见 [`.github/workflows/update.yml`](.github/workflows/update.yml)（`cron: 17 * * * *`）。

## 测速是怎么做的

对每条代理发起一次**真实的 MTProto FakeTLS 握手**，等价于 Telegram 客户端连它的第一步：

1. 用 secret 尾部的伪装域名构造 TLS 1.3 ClientHello；
2. `random` 字段填入 `HMAC-SHA256(密钥, 整条 ClientHello)`，末 4 字节与时间戳异或（服务端据此判断时效）；
3. 读取服务端 `ServerHello` + `ChangeCipherSpec` + `ApplicationData`；
4. 校验服务端摘要 `HMAC-SHA256(密钥, 客户端 random + 服务端整包)`。

产出的三个耗时：

| 字段 | 含义 |
|---|---|
| `connect_ms` | TCP 建连往返 |
| `tls_ms` | 发出 ClientHello 到收齐服务端握手包 |
| `latency_ms` | 排序主指标 = `connect_ms + tls_ms` |

排序规则：**摘要校验通过** → 能握手但校验不过 → 失效；同一档内按 `latency_ms` 升序，
再按成功率降序。每台默认测 2 次取中位数，避免单次抖动。

> `verified: true` 说明服务端确实认识这个 secret。`verified: false` 的机器虽然能回应，
> 但多半密钥已失效（mtg 对不认识的密钥会回一个假握手来迷惑探测），在 Telegram 里连不上 ——
> 所以它们排在后面，页面标「未校验」。

非 FakeTLS 的 secret（`dd` / 裸 16 字节）在不引入加密依赖的前提下无法完成 MTProto 往返校验，
这类条目只测 TCP 建连，`mode` 记为 `tcp`。

## 数据文件

### `top40.json`（对外接口，前 40 名）

```json
{
  "generated_at": "2026-10-21T06:33:05Z",
  "method": "faketls-handshake",
  "stats": { "tested": 970, "alive": 412, "verified": 380, "fastest_ms": 61.2, "median_ms": 189.4 },
  "proxies": [
    {
      "rank": 1,
      "server": "example.com",
      "port": 443,
      "secret": "ee2b6e…",
      "link": "https://t.me/proxy?server=example.com&port=443&secret=ee2b6e…",
      "sources": ["tgmtproxy", "dubblebyte"],
      "alive": true,
      "verified": true,
      "latency_ms": 61.2,
      "connect_ms": 28.4,
      "tls_ms": 32.8,
      "success_rate": 1.0
    }
  ]
}
```

### `proxies.json`（页面数据源，全量）

为了控制体积，`proxies` 是二维数组，字段顺序由同文件的 `fields` 给出：

```
["server","port","secret","sources","alive","verified","latency_ms","connect_ms","tls_ms","success_rate","error"]
```

行序即排名。`error` 为失效原因的短标识（`connect_timeout` / `dns_fail` / `refused` / `no_response` / `bad_handshake` 等）。

### `proxies.txt`

只含存活条目、已按速率排序的明文列表，首两行是注释头（生成时间、存活数、来源分布）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 页面：速度榜 Top 40 + 全量列表（搜索 / 筛选 / 本机检测），运行时读取 `proxies.json` |
| `scripts/mtproxy_probe.py` | 探测引擎：FakeTLS 握手、摘要校验、并发调度、排序（纯标准库） |
| `scripts/update.py` | 流水线：抓取两源 → 去重合并 → 全量测速 → 写出三个数据文件 |
| `tests/test_pipeline.py` | 离线单元测试（secret 解析、ClientHello 结构、摘要校验、合并去重、排序、产物格式） |
| `.github/workflows/update.yml` | 每小时执行一次，有变化才提交 |

## 本地运行

无需任何第三方依赖（Python 3.10+）：

```bash
# 完整流水线（会真的联网测速，约 1–3 分钟）
python3 scripts/update.py

# 只测前 50 条，输出到临时目录
python3 scripts/update.py --limit 50 --out-dir /tmp/proxy-check

# 上游拉不动时，用本地快照代替
python3 scripts/update.py --primary-file primary.txt --secondary-file extra.txt

# 只跑探测，看排序结果
python3 scripts/mtproxy_probe.py proxies.txt --attempts 2 --concurrency 100 --top 20

# 单元测试（离线，不发网络请求）
python3 -m unittest discover -s tests -v
```

页面本地预览（必须走 HTTP，`file://` 会被浏览器拦住读取 `proxies.json`）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000/
```

手动跑一次线上流水线：仓库 → Actions → **每小时更新代理数据（合并 + 全量测速）** → Run workflow，
可以填 `limit`（只测前 N 条）和 `attempts`（每台探测次数）两个参数。

## 维护提示

- **加数据源**：改 `scripts/update.py` 顶部的 `SOURCES` 列表即可，去重与来源标签自动生效。
- **调阈值**：`--min-alive-ratio`（默认 0.05）——一轮测速存活率低于该比例会判定为「runner 出网异常」，
  中止且**不覆盖**上一轮产物，避免一次网络抖动把列表清空。
- **调并发/超时**：`--concurrency`（默认 128）、`--timeout`、`--connect-timeout`。runner 出网慢时适当放大超时。
- **页面改版**：直接改 `index.html`，数据契约见上面的 `proxies.json` / `top40.json` 小节，不再依赖上游 HTML。
- **历史遗留**：`translate.py`（上游俄语页面汉化）与 `merge_proxies.py`（旧合并脚本）已随页面自建而下线，
  功能分别由 `index.html` 自建模板与 `scripts/update.py` 承担。

## 免责声明

- 所有代理均为互联网公开收集，**可用性、速度与安全性无任何担保**；请勿通过公共代理传输敏感信息
- 排行榜耗时来自测速节点（GitHub Actions runner），与你本地网络的体验可能不同，请以页面上的「本机检测」为准
- 本项目仅做公开数据的聚合、测速与排序，不运营任何代理服务器

## 致谢

- [tgmtproxy/telegram-mtproto-proxy-list](https://github.com/tgmtproxy/telegram-mtproto-proxy-list) — 主数据源
- [dubblebyte/free-mtproto-proxies](https://github.com/dubblebyte/free-mtproto-proxies) — 补充数据源
- [9seconds/mtg](https://github.com/9seconds/mtg) — FakeTLS 握手与摘要算法参考实现
- [Telegram](https://telegram.org) — MTProto 协议与 `t.me/proxy` 链接方案
