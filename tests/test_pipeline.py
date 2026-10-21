#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线单元测试：只用纯函数，不发起任何网络请求。

运行：python -m unittest discover -s tests -v
"""

from __future__ import annotations

import hashlib
import hmac
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import mtproxy_probe as probe  # noqa: E402
import update  # noqa: E402


# 构造测试用的合法 FakeTLS secret：ee + 16 字节密钥 + 伪装域名（hex）
KEY = bytes.fromhex("2b6eb790d613a1725557ce33b9a87b30")
DOMAIN = "xapi.ozon.ru"
SECRET_HEX = "ee" + KEY.hex() + DOMAIN.encode().hex()
LINK = "https://t.me/proxy?server=mirage.example.com&port=443&secret=" + SECRET_HEX


def make_server_packet(client_random: bytes, key: bytes = KEY) -> bytes:
    """按 mtg 的算法合成一个服务端握手包，用于校验 verify_server_digest。"""
    hello_payload = (
        b"\x03\x03" + b"\x00" * 32 + b"\x20" + b"\x11" * 32 +
        b"\xc0\x2f" + b"\x00" + b"\x00\x2e" + b"\x00\x2b\x00\x02\x03\x04"
    )
    handshake = b"\x02" + struct.pack(">I", len(hello_payload))[1:] + hello_payload
    record = b"\x16\x03\x03" + struct.pack(">H", len(handshake)) + handshake
    ccs = b"\x14\x03\x03\x00\x01\x01"
    noise = b"\x17\x03\x03" + struct.pack(">H", 300) + b"\x42" * 300
    packet = bytearray(record + ccs + noise)
    zeroed = bytes(packet[:probe.DIGEST_POS]) + b"\x00" * probe.DIGEST_LEN + \
        bytes(packet[probe.DIGEST_POS + probe.DIGEST_LEN:])
    digest = hmac.new(key, client_random + zeroed, hashlib.sha256).digest()
    packet[probe.DIGEST_POS:probe.DIGEST_POS + probe.DIGEST_LEN] = digest
    return bytes(packet)


class SecretParsingTest(unittest.TestCase):
    def test_faketls_hex(self):
        secret = probe.parse_secret(SECRET_HEX)
        self.assertEqual(secret.kind, "faketls")
        self.assertEqual(secret.key, KEY)
        self.assertEqual(secret.domain, DOMAIN)

    def test_faketls_base64(self):
        import base64
        encoded = base64.urlsafe_b64encode(bytes.fromhex(SECRET_HEX)).decode().rstrip("=")
        secret = probe.parse_secret(encoded)
        self.assertEqual(secret.kind, "faketls")
        self.assertEqual(secret.domain, DOMAIN)

    def test_obfuscated_and_plain(self):
        self.assertEqual(probe.parse_secret("dd" + "ab" * 16).kind, "obfuscated")
        self.assertEqual(probe.parse_secret("ab" * 16).kind, "plain")

    def test_invalid(self):
        self.assertEqual(probe.parse_secret("").kind, "invalid")
        self.assertEqual(probe.parse_secret("zzzz").kind, "invalid")
        # ee 前缀但缺少域名
        self.assertEqual(probe.parse_secret("ee" + KEY.hex()).kind, "invalid")


class LinkParsingTest(unittest.TestCase):
    def test_https_link(self):
        target = probe.parse_link(LINK)
        self.assertIsNotNone(target)
        self.assertEqual(target.server, "mirage.example.com")
        self.assertEqual(target.port, 443)
        self.assertEqual(target.secret, SECRET_HEX)
        self.assertEqual(target.link, LINK)

    def test_tg_scheme_and_comments(self):
        target = probe.parse_link(
            "tg://proxy?server=a.example&port=8443&secret=" + SECRET_HEX)
        self.assertEqual((target.server, target.port), ("a.example", 8443))
        self.assertIsNone(probe.parse_link("# 注释"))
        self.assertIsNone(probe.parse_link("https://example.com/"))
        self.assertIsNone(probe.parse_link("https://t.me/proxy?server=x&port=abc&secret=ee11"))


class ClientHelloTest(unittest.TestCase):
    def test_structure(self):
        hello = probe.build_client_hello(DOMAIN)
        self.assertEqual(bytes(hello[0:3]), b"\x16\x03\x01")
        self.assertEqual(hello[5], probe.HS_CLIENT_HELLO)
        self.assertEqual(len(hello), 517)
        body_len = struct.unpack(">I", b"\x00" + bytes(hello[6:9]))[0]
        self.assertEqual(body_len + 9, len(hello))
        # 抹零状态下 digest 区域必须全零
        self.assertEqual(bytes(hello[probe.DIGEST_POS:probe.DIGEST_POS + probe.DIGEST_LEN]),
                         b"\x00" * probe.DIGEST_LEN)
        # SNI 里必须带伪装域名
        self.assertIn(DOMAIN.encode(), bytes(hello))

    def test_digest_patch_is_deterministic(self):
        hello = probe.build_client_hello(DOMAIN)
        zeroed = bytes(hello)
        manual = hmac.new(KEY, zeroed, hashlib.sha256).digest()
        packet = probe.apply_client_digest(hello, KEY, timestamp=1700000000)
        self.assertEqual(len(packet), len(hello))
        # 前 28 字节等于 HMAC，后 4 字节与时间戳异或
        self.assertEqual(packet[probe.DIGEST_POS:probe.DIGEST_POS + 28], manual[:28])
        expected_tail = bytes(a ^ b for a, b in zip(
            manual[28:], struct.pack("<I", 1700000000)))
        self.assertEqual(packet[probe.DIGEST_POS + 28:probe.DIGEST_POS + 32], expected_tail)


class ServerDigestTest(unittest.TestCase):
    def test_valid_packet(self):
        hello = probe.build_client_hello(DOMAIN)
        packet = probe.apply_client_digest(hello, KEY)
        random_field = probe.client_random(packet)
        server_packet = make_server_packet(random_field)
        self.assertTrue(probe.verify_server_digest(KEY, random_field, server_packet))

    def test_wrong_key_and_tampering(self):
        hello = probe.build_client_hello(DOMAIN)
        packet = probe.apply_client_digest(hello, KEY)
        random_field = probe.client_random(packet)
        server_packet = make_server_packet(random_field)

        self.assertFalse(probe.verify_server_digest(b"\x00" * 16, random_field, server_packet))
        tampered = bytearray(server_packet)
        tampered[probe.DIGEST_POS] ^= 0xFF
        self.assertFalse(probe.verify_server_digest(KEY, random_field, bytes(tampered)))
        self.assertFalse(probe.verify_server_digest(KEY, random_field, b"\x16\x03\x03"))
        # 用错客户端随机数（模拟回落到了伪装网站）
        self.assertFalse(probe.verify_server_digest(KEY, b"\x01" * 32, server_packet))


class RecordParsingTest(unittest.TestCase):
    def test_partial_record_is_buffered(self):
        hello = probe.build_client_hello(DOMAIN)
        packet = probe.apply_client_digest(hello, KEY)
        server_packet = make_server_packet(probe.client_random(packet))

        records, consumed = probe.parse_records(server_packet)
        self.assertEqual([rtype for rtype, _ in records], [0x16, 0x14, 0x17])
        self.assertEqual(consumed, len(server_packet))

        truncated = server_packet[:-10]
        records, consumed = probe.parse_records(truncated)
        self.assertEqual([rtype for rtype, _ in records], [0x16, 0x14])
        self.assertLess(consumed, len(truncated))


class MergeTest(unittest.TestCase):
    def test_dedupe_and_source_tags(self):
        primary = "\n".join([
            "# 主源注释",
            LINK,
            "https://t.me/proxy?server=dup.example.com&port=443&secret=" + SECRET_HEX,
        ])
        secondary = "\n".join([
            "https://t.me/proxy?server=extra.example.com&port=8443&secret=" + SECRET_HEX,
            "https://t.me/proxy?server=dup.example.com&port=443&secret=" + SECRET_HEX,
            "https://t.me/proxy?server=bad.example.com&port=443&secret=ffff",
        ])
        targets, per_source, dropped = update.merge_sources(
            [("tgmtproxy", primary), ("dubblebyte", secondary)])

        self.assertEqual([t.server for t in targets],
                         ["mirage.example.com", "dup.example.com", "extra.example.com"])
        self.assertEqual(targets[1].sources, ("tgmtproxy", "dubblebyte"))
        self.assertEqual(targets[2].sources, ("dubblebyte",))
        self.assertEqual(per_source, {"tgmtproxy": 2, "dubblebyte": 2})
        self.assertEqual(dropped, 1)  # secret=ffff 不是合法代理

    def test_max_proxies_guard(self):
        lines = "\n".join(
            "https://t.me/proxy?server=h%d.example.com&port=443&secret=%s" % (i, SECRET_HEX)
            for i in range(5)
        )
        original = update.MAX_PROXIES
        update.MAX_PROXIES = 3
        try:
            targets, _, _ = update.merge_sources([("s", lines)])
        finally:
            update.MAX_PROXIES = original
        self.assertEqual(len(targets), 3)


class ProbeTargetTest(unittest.TestCase):
    """回归：非 FakeTLS 目标没有 tls 耗时，聚合时不能因 median([]) 抛错。"""

    def test_plain_secret_reports_no_tls_metric(self):
        import asyncio

        async def handler(reader, writer):
            writer.close()

        async def scenario():
            server = await asyncio.start_server(handler, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            target = probe.Target("127.0.0.1", port, "ab" * 16)
            try:
                return await probe.probe_target(
                    target, attempts=2, connect_timeout=2, handshake_timeout=2)
            finally:
                server.close()
                await server.wait_closed()

        result = asyncio.run(scenario())
        self.assertTrue(result["alive"])
        self.assertEqual(result["mode"], "plain")
        self.assertIsNone(result["tls_ms"])
        self.assertEqual(result["latency_ms"], result["connect_ms"])
        self.assertEqual(result["success_rate"], 1.0)


def sample_results():
    return [
        {"server": "slow.example.com", "port": 443, "secret": SECRET_HEX, "sources": ["tgmtproxy"],
         "alive": True, "verified": True, "mode": "faketls", "latency_ms": 240.0,
         "connect_ms": 120.0, "tls_ms": 120.0, "success_rate": 1.0, "samples": 2, "error": ""},
        {"server": "fast.example.com", "port": 443, "secret": SECRET_HEX, "sources": ["dubblebyte"],
         "alive": True, "verified": False, "mode": "faketls", "latency_ms": 41.5,
         "connect_ms": 20.0, "tls_ms": 21.5, "success_rate": 1.0, "samples": 2, "error": ""},
        {"server": "dead.example.com", "port": 443, "secret": SECRET_HEX, "sources": ["tgmtproxy"],
         "alive": False, "verified": False, "mode": "faketls", "latency_ms": None,
         "connect_ms": None, "tls_ms": None, "success_rate": 0.0, "samples": 2,
         "error": "connect_timeout"},
    ]


class RankingTest(unittest.TestCase):
    def test_verified_first_then_latency_then_dead(self):
        ranked = probe.rank_results(sample_results())
        self.assertEqual([item["server"] for item in ranked],
                         ["slow.example.com", "fast.example.com", "dead.example.com"])
        self.assertEqual([item["rank"] for item in ranked], [1, 2, 3])
        self.assertTrue(ranked[0]["link"].startswith("https://t.me/proxy?server=slow.example.com"))

    def test_latency_orders_within_same_tier(self):
        items = [dict(item) for item in sample_results()[:2]]
        items[0]["verified"] = items[1]["verified"] = True
        ranked = probe.rank_results(items)
        self.assertEqual(ranked[0]["server"], "fast.example.com")

    def test_tie_break_prefers_success_rate(self):
        a = dict(sample_results()[0])
        b = dict(sample_results()[0])
        a.update(server="a.example.com", latency_ms=100.0, success_rate=0.5)
        b.update(server="b.example.com", latency_ms=100.0, success_rate=1.0)
        ranked = probe.rank_results([a, b])
        self.assertEqual(ranked[0]["server"], "b.example.com")


class PayloadTest(unittest.TestCase):
    def setUp(self):
        self.ranked = probe.rank_results(sample_results())
        self.full, self.top, self.top_list = update.build_payload(
            self.ranked, generated_at="2026-10-21T06:17:00Z",
            per_source={"tgmtproxy": 2, "dubblebyte": 1}, top_n=2)

    def test_stats(self):
        stats = self.full["stats"]
        self.assertEqual(stats["tested"], 3)
        self.assertEqual(stats["alive"], 2)
        self.assertEqual(stats["verified"], 1)
        self.assertEqual(stats["fastest_ms"], 240.0)  # 只统计校验通过的，与榜首一致
        self.assertEqual(stats["median_ms"], 140.75)

    def test_compact_rows_follow_field_order(self):
        self.assertEqual(tuple(self.full["fields"]), update.FIELDS)
        first = self.full["proxies"][0]
        self.assertIsInstance(first, list)
        self.assertEqual(len(first), len(update.FIELDS))
        self.assertEqual(dict(zip(self.full["fields"], first))["server"], "slow.example.com")

    def test_top_payload_only_alive(self):
        self.assertEqual(len(self.top["proxies"]), 2)
        self.assertEqual([item["rank"] for item in self.top["proxies"]], [1, 2])
        self.assertNotIn("dead.example.com", [item["server"] for item in self.top["proxies"]])
        self.assertTrue(all("link" in item for item in self.top["proxies"]))
        # 校验通过的排在前面，哪怕延迟略高
        self.assertEqual(self.top["proxies"][0]["server"], "slow.example.com")

    def test_top_truncates(self):
        _, top, _ = update.build_payload(self.ranked, generated_at="x",
                                         per_source={}, top_n=1)
        self.assertEqual(len(top["proxies"]), 1)

    def test_proxies_txt_sorted_alive_only(self):
        text = update.build_proxies_txt(
            [item for item in self.ranked if item["alive"]], "2026-10-21T06:17:00Z",
            {"tgmtproxy": 2})
        lines = text.splitlines()
        self.assertTrue(lines[0].startswith("# MTProxy list"))
        self.assertIn("存活 2 条", lines[1])
        links = [line for line in lines if line.startswith("https://")]
        self.assertEqual(len(links), 2)
        self.assertIn("slow.example.com", links[0])
        self.assertIn("fast.example.com", links[1])


class WriteAtomicTest(unittest.TestCase):
    def test_writes_and_replaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.json"
            update.write_atomic(path, '{"a":1}\n')
            update.write_atomic(path, '{"a":2}\n')
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"a": 2})
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["out.json"])


class SiteTemplateTest(unittest.TestCase):
    """index.html 必须从合并数据文件渲染，而不是写死上游表格。"""

    def test_index_reads_generated_data(self):
        html = (Path(__file__).resolve().parent.parent / "index.html").read_text(encoding="utf-8")
        self.assertIn("proxies.json", html)
        self.assertIn("top40.json", html)
        self.assertNotIn("<tbody><tr class=\"ours\"", html)
        self.assertLess(len(html), 60000)


if __name__ == "__main__":
    unittest.main()
