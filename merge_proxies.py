#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Merge extra MTProxy link lists into the main proxies.txt.

Usage:
    python3 merge_proxies.py base.txt extra1.txt [extra2.txt ...] > merged.txt

Both inputs are `https://t.me/proxy?server=...&port=...&secret=...` lists.
Entries are deduplicated by the (server, port, secret) triple, so the same
proxy expressed with a different query-parameter order is not added twice.
The "— N alive" counter in the base header is refreshed to the real total.

The script is idempotent: merging an already-merged extra list changes nothing.
"""

import io
import re
import sys
from urllib.parse import parse_qs, urlparse

LINK_RE = re.compile(r'^https://t\.me/proxy\?')


def key_of(line):
    """(server, port, secret) triple, or None for non-proxy lines."""
    try:
        query = parse_qs(urlparse(line.strip()).query)
        server = (query.get('server') or [''])[0].lower()
        port = (query.get('port') or [''])[0]
        secret = (query.get('secret') or [''])[0]
        return (server, port, secret) if server and secret else None
    except Exception:
        return None


def main():
    base_path = sys.argv[1]
    base = io.open(base_path, encoding='utf-8').read().splitlines()

    seen = set()
    out = []
    for line in base:
        key = key_of(line)
        if key is not None:
            seen.add(key)
        out.append(line)

    added = 0
    for extra_path in sys.argv[2:]:
        for line in io.open(extra_path, encoding='utf-8').read().splitlines():
            line = line.strip()
            if not LINK_RE.match(line):
                continue
            key = key_of(line)
            if key is None or key in seen:
                continue
            seen.add(key)
            out.append(line)
            added += 1

    # refresh the header counter, e.g. "# ... — 900 alive" -> real total
    total = sum(1 for line in out if LINK_RE.match(line))
    for i, line in enumerate(out):
        if line.startswith('#') and re.search(r'— \d+ alive', line):
            out[i] = re.sub(r'— \d+ alive(?: \(incl\. merged sources\))?',
                            '— %d alive (incl. merged sources)' % total, line)
            break

    sys.stdout.write('\n'.join(out).rstrip('\n') + '\n')
    print('merged %d new entr(y|ies) from %d extra list(s); total now %d' % (added, len(sys.argv) - 2, total),
          file=sys.stderr)


if __name__ == '__main__':
    main()
