#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每小时流水线：拉取两个上游数据源 → 去重合并 → 全量测速 → 生成数据文件。

产物（写入 --out-dir，默认仓库根目录）：

  proxies.txt   存活代理链接，按访问速率从快到慢排序（每行一条 t.me 链接）
  proxies.json  全量测速明细（含失效条目、来源标签、分段耗时），供 index.html 渲染
  top40.json    访问速率最快的前 40 个代理

设计要点：

  * 两个上游分别失败互不影响；任一源可取到数据就继续，全部失败则退出且不覆盖旧数据。
  * 存活率低于阈值（默认 5%）视为测速环境异常，直接退出、保留上一轮产物，
    避免一次网络抖动把可用列表清空。
  * 所有产物原子写入（临时文件 + os.replace），任何阶段失败都不会留下半个文件。

用法：

  python3 scripts/update.py                          # 完整流程
  python3 scripts/update.py --limit 60               # 只测前 60 条（调试）
  python3 scripts/update.py --primary-file a.txt \\
                            --secondary-file b.txt   # 离线用本地文件代替上游
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mtproxy_probe import (  # noqa: E402
    DEFAULT_ATTEMPTS,
    DEFAULT_CONCURRENCY,
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_TIMEOUT,
    Target,
    parse_link,
    parse_secret,
    probe_many,
    rank_results,
)

REPO_ROOT = Path(__file__).resolve().parent.parent

# 两个上游数据源。新增源只需往这里追加一项，去重与来源标记自动生效。
SOURCES: list[dict[str, str]] = [
    {
        "id": "tgmtproxy",
        "label": "主源 · tgmtproxy",
        "url": "https://raw.githubusercontent.com/tgmtproxy/telegram-mtproto-proxy-list/main/proxies.txt",
    },
    {
        "id": "dubblebyte",
        "label": "次源 · dubblebyte",
        "url": "https://raw.githubusercontent.com/dubblebyte/free-mtproto-proxies/main/all_proxies.txt",
    },
]

USER_AGENT = "telegram-mtproto-proxy-list/2.0 (+https://github.com/consoleaiden/telegram-mtproto-proxy-list)"
DEFAULT_TOP = 40
MAX_PROXIES = 5000
FETCH_RETRIES = 3

# proxies.json 里每条代理的字段顺序（二维数组存储，控制体积）
FIELDS = (
    "server", "port", "secret", "sources", "alive", "verified",
    "latency_ms", "connect_ms", "tls_ms", "success_rate", "error",
)


# --------------------------------------------------------------------------- #
# 上游抓取与合并
# --------------------------------------------------------------------------- #

def fetch_text(url: str, retries: int = FETCH_RETRIES, timeout: float = 30.0) -> str:
    """下载上游列表，失败按指数退避重试。"""
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
            return payload.decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt + 1 < retries:
                delay = 2 ** attempt
                print("  ! %s 第 %d 次失败（%s），%ds 后重试"
                      % (url, attempt + 1, exc, delay), file=sys.stderr)
                time.sleep(delay)
    raise RuntimeError("下载失败：%s（%s）" % (url, last_error))


def read_source(source: dict[str, str], local_file: str | None) -> str | None:
    """读取单个数据源，失败返回 None（不抛出）。"""
    if local_file:
        print("  · %-10s 读本地文件 %s" % (source["id"], local_file), file=sys.stderr)
        return Path(local_file).read_text(encoding="utf-8")
    try:
        text = fetch_text(source["url"])
    except RuntimeError as exc:
        print("  ! %-10s 不可用：%s" % (source["id"], exc), file=sys.stderr)
        return None
    print("  · %-10s %.1f KB" % (source["id"], len(text) / 1024.0), file=sys.stderr)
    return text


def merge_sources(
    payloads: list[tuple[str, str]],
) -> tuple[list[Target], dict[str, int], int]:
    """合并多个来源的链接，按 (server, port, secret) 去重并记录来源标签。"""
    order: list[tuple[str, int, str]] = []
    meta: dict[tuple[str, int, str], dict[str, Any]] = {}
    dropped = 0

    for source_id, text in payloads:
        for line in text.splitlines():
            target = parse_link(line)
            if target is None:
                continue
            if parse_secret(target.secret).kind == "invalid":
                dropped += 1
                continue
            if not all(c.isalnum() or c in "-._:" for c in target.server):
                dropped += 1
                continue
            key = target.key
            if key not in meta:
                if len(meta) >= MAX_PROXIES:
                    break
                meta[key] = {"target": target, "sources": []}
                order.append(key)
            sources = meta[key]["sources"]
            if source_id not in sources:
                sources.append(source_id)

    # 每个来源贡献的「去重后」条目数，而不是原始行数
    per_source: Counter = Counter()
    for value in meta.values():
        for source_id in value["sources"]:
            per_source[source_id] += 1

    targets = [
        Target(
            server=meta[key]["target"].server,
            port=meta[key]["target"].port,
            secret=meta[key]["target"].secret,
            sources=tuple(meta[key]["sources"]),
        )
        for key in order
    ]
    return targets, dict(per_source), dropped


# --------------------------------------------------------------------------- #
# 产物生成
# --------------------------------------------------------------------------- #

def write_atomic(path: Path, text: str) -> None:
    """先写临时文件再原子替换，避免中断留下残缺文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def build_payload(
    ranked: list[dict[str, Any]],
    *,
    generated_at: str,
    per_source: dict[str, int],
    top_n: int = DEFAULT_TOP,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    """组装 proxies.json / top40.json 的数据结构。

    proxies.json 给页面用，按 FIELDS 顺序存成二维数组，体积约为对象格式的 1/3；
    top40.json 是对外接口，保留完整字段名与现成的 link，方便直接消费。
    """
    alive = [item for item in ranked if item["alive"]]
    verified = [item for item in alive if item["verified"]]
    # 排行榜以「校验通过」为前提，统计里也用它算最快延迟，避免和榜首对不上
    fast_pool = [item["latency_ms"] for item in (verified or alive)]
    latencies = [item["latency_ms"] for item in alive]
    fastest = min(fast_pool) if fast_pool else None
    median_ms = statistics.median(latencies) if latencies else None

    for index, item in enumerate(ranked, start=1):
        item["rank"] = index

    stats = {
        "tested": len(ranked),
        "alive": len(alive),
        "verified": len(verified),
        "fastest_ms": fastest,
        "median_ms": median_ms,
        "sources": per_source,
    }
    full = {
        "generated_at": generated_at,
        "method": "faketls-handshake",
        "fields": list(FIELDS),
        "stats": stats,
        "proxies": [[item.get(name) for name in FIELDS] for item in ranked],
    }

    top: list[dict[str, Any]] = []
    for item in ranked:
        if len(top) >= top_n:
            break
        if not item["alive"]:
            continue
        entry = dict(item)
        entry["rank"] = len(top) + 1
        top.append(entry)
    top_payload = {
        "generated_at": generated_at,
        "method": "faketls-handshake",
        "note": "访问速率（TCP 建连 + FakeTLS 握手往返）最快的前 %d 个代理" % len(top),
        "stats": stats,
        "proxies": top,
    }
    return full, top_payload, top


def build_proxies_txt(
    alive_ranked: Iterable[dict[str, Any]], generated_at: str, per_source: dict[str, int]
) -> str:
    """存活代理按速率排序的纯文本列表。"""
    items = list(alive_ranked)
    header = (
        "# MTProxy list — %s\n"
        "# 按访问速率（TCP+FakeTLS 握手往返）从快到慢排序 · 存活 %d 条 · 来源 %s\n"
        % (
            generated_at,
            len(items),
            " + ".join("%s(%d)" % (name, count) for name, count in per_source.items()),
        )
    )
    return header + "".join(item["link"] + "\n" for item in items)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="拉取合并上游代理并全量测速")
    parser.add_argument("--out-dir", default=str(REPO_ROOT), help="产物输出目录")
    parser.add_argument("--top", type=int, default=DEFAULT_TOP, help="top40.json 条数")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--attempts", type=int, default=DEFAULT_ATTEMPTS)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="握手超时（秒）")
    parser.add_argument("--connect-timeout", type=float, default=DEFAULT_CONNECT_TIMEOUT)
    parser.add_argument("--limit", type=int, default=0, help="只测前 N 条（调试用）")
    parser.add_argument("--min-alive-ratio", type=float, default=0.05,
                        help="存活率低于该比例则中止，不覆盖旧产物")
    parser.add_argument("--primary-file", help="用本地文件代替主源（离线调试）")
    parser.add_argument("--secondary-file", help="用本地文件代替次源（离线调试）")
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir).resolve()
    started = time.monotonic()
    print("[1/4] 拉取上游数据源", file=sys.stderr)
    locals_by_id = {
        "tgmtproxy": args.primary_file,
        "dubblebyte": args.secondary_file,
    }
    payloads: list[tuple[str, str]] = []
    failed: list[str] = []
    for source in SOURCES:
        text = read_source(source, locals_by_id.get(source["id"]))
        if text is None:
            failed.append(source["id"])
        else:
            payloads.append((source["id"], text))

    if not payloads:
        print("所有上游数据源都不可用，保留上一轮产物并退出", file=sys.stderr)
        return 1

    print("[2/4] 去重合并", file=sys.stderr)
    targets, per_source, dropped = merge_sources(payloads)
    if not targets:
        print("合并后没有任何合法代理，退出", file=sys.stderr)
        return 2
    if args.limit:
        targets = targets[: args.limit]
        print("  （调试模式：只测前 %d 条）" % len(targets), file=sys.stderr)
    print("  %d 个唯一代理 · 丢弃非法条目 %d 条 · 来源分布 %s"
          % (len(targets), dropped, per_source), file=sys.stderr)

    print("[3/4] 全量测速（并发 %d，每台 %d 次）" % (args.concurrency, args.attempts),
          file=sys.stderr)
    raw_results = asyncio.run(probe_many(
        targets,
        concurrency=args.concurrency,
        attempts=args.attempts,
        connect_timeout=args.connect_timeout,
        handshake_timeout=args.timeout,
    ))
    ranked = rank_results(raw_results)
    alive = [item for item in ranked if item["alive"]]
    alive_ratio = len(alive) / len(ranked) if ranked else 0.0
    print("  存活 %d/%d（%.1f%%）· 摘要校验通过 %d"
          % (len(alive), len(ranked), alive_ratio * 100,
             sum(1 for item in alive if item["verified"])), file=sys.stderr)

    if alive_ratio < args.min_alive_ratio:
        print("存活率 %.1f%% 低于阈值 %.1f%%，判定为测速环境异常："
              "不覆盖旧产物，请检查 runner 出网情况"
              % (alive_ratio * 100, args.min_alive_ratio * 100), file=sys.stderr)
        return 3

    print("[4/4] 写出产物", file=sys.stderr)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    full, top_payload, top = build_payload(
        ranked, generated_at=generated_at, per_source=per_source, top_n=args.top
    )

    write_atomic(out_dir / "proxies.txt",
                 build_proxies_txt(alive, generated_at, per_source))
    write_atomic(out_dir / "proxies.json",
                 json.dumps(full, ensure_ascii=False, separators=(",", ":")) + "\n")
    write_atomic(out_dir / f"top{args.top}.json",
                 json.dumps(top_payload, ensure_ascii=False, indent=2) + "\n")

    print("  proxies.txt  %d 条存活" % len(alive), file=sys.stderr)
    print("  proxies.json %d 条明细" % len(ranked), file=sys.stderr)
    print("  top%d.json  %d 条" % (args.top, len(top)), file=sys.stderr)

    print("\n最快的前 %d 个代理：" % min(10, len(top)), file=sys.stderr)
    for item in top[:10]:
        print("  %2d. %-38s %7.1f ms  %s"
              % (item["rank"], "%s:%d" % (item["server"], item["port"]),
                 item["latency_ms"], "/".join(item["sources"])), file=sys.stderr)
    print("耗时 %.1fs" % (time.monotonic() - started), file=sys.stderr)

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write("### 代理测速结果\n\n")
            handle.write("| 指标 | 数值 |\n|---|---|\n")
            handle.write("| 合并去重后 | %d |\n" % len(ranked))
            handle.write("| 存活 | %d |\n" % len(alive))
            handle.write("| 摘要校验通过 | %d |\n"
                         % sum(1 for item in alive if item["verified"]))
            handle.write("| 最快 | %s ms |\n"
                         % (alive[0]["latency_ms"] if alive else "—"))
            if failed:
                handle.write("| 失败数据源 | %s |\n" % ", ".join(failed))
            handle.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
