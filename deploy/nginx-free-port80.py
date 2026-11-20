#!/usr/bin/env python3
"""Move nginx's unused distro default site off port 80.

Used by deploy/linux-deploy.sh when ANOTHER program (Caddy, Apache, ...) already
listens on TCP 80. The Voice Agent Console only needs its own TLS port (533),
but the distro default server block in nginx.conf / sites-enabled/default
claims *:80 and makes nginx fail to start with "bind() to 0.0.0.0:80 failed
(98: Address already in use)" even though `nginx -t` passes.

A server block with NO listen directive also defaults to *:80, so commenting
out the listen lines is not enough. This script rewrites only server blocks
that would listen on port 80 (explicitly or by default) and have no other
listen port, to `listen 127.0.0.1:8080;`. Backups go to BACKUP_DIR, which nginx
never includes: a backup left inside sites-enabled/ would be loaded by nginx
and re-claim :80. Exit status 0 = nothing to do or changed.

Usage: nginx-free-port80.py FILE [FILE ...]
"""
import os
import re
import shutil
import sys

BACKUP_DIR = os.environ.get('VAC_NGINX_BACKUP_DIR', '/etc/nginx/vac-port80-backup')

LISTEN_RE = re.compile(r'^(\s*)listen\s+([^;]+);', re.M)
REPLACEMENT = 'listen 127.0.0.1:8080;'


def strip_comments(text):
    """Blank out comments with spaces so character offsets stay aligned."""
    out = []
    for line in text.split('\n'):
        code, sep, rest = line.partition('#')
        out.append(code + (' ' * (len(sep) + len(rest))))
    return '\n'.join(out)


def find_server_blocks(text):
    """Yield (start, end) of each `server { ... }` block, comment-aware."""
    clean = strip_comments(text)
    for m in re.finditer(r'(?<![\w$])server\s*\{', clean):
        depth, i = 0, m.end() - 1
        while i < len(clean):
            if clean[i] == '{':
                depth += 1
            elif clean[i] == '}':
                depth -= 1
                if depth == 0:
                    yield m.start(), i + 1
                    break
            i += 1


def listen_port(spec):
    addr = spec.split()[0]
    if addr.startswith('unix:'):
        return None
    tail = addr.rsplit(':', 1)[-1] if ':' in addr and not addr.endswith(']') else addr
    return int(tail) if tail.isdigit() else 80


def rewrite_block(block):
    """Return the rewritten block, or None if it must not be touched."""
    clean = strip_comments(block)
    specs = [m.group(2).strip() for m in LISTEN_RE.finditer(clean)]
    ports = {listen_port(s) for s in specs}
    if specs and ports != {80}:
        return None  # listens elsewhere too (e.g. 443 or 533): not the idle default site
    lines = block.split('\n')
    out, replaced = [], False
    for line in lines:
        code = line.split('#', 1)[0]
        if LISTEN_RE.match(code):
            if not replaced:
                indent = re.match(r'^(\s*)', line).group(1)
                out.append(f'{indent}{REPLACEMENT}  # moved off :80 by Voice Agent Console installer')
                replaced = True
            continue  # drop the other :80 / [::]:80 lines
        out.append(line)
    if not replaced:
        # No active listen line: nginx would default to *:80. Insert one.
        first = out[0]
        brace = first.index('{') + 1
        out[0] = first[:brace] + f'\n        {REPLACEMENT}  # moved off :80 by Voice Agent Console installer' + first[brace:]
    return '\n'.join(out)


def process(path):
    try:
        with open(path, encoding='utf-8') as fh:
            text = fh.read()
    except FileNotFoundError:
        return False
    pieces, last, changed = [], 0, False
    for start, end in find_server_blocks(text):
        new = rewrite_block(text[start:end])
        if new is not None and new != text[start:end]:
            pieces.append(text[last:start])
            pieces.append(new)
            last = end
            changed = True
    if not changed:
        return False
    pieces.append(text[last:])
    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup = os.path.join(BACKUP_DIR, path.strip('/').replace('/', '__'))
    if not os.path.exists(backup):  # keep the original pristine copy on re-runs
        shutil.copy2(path, backup)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(''.join(pieces))
    print(f'Moved the unused default nginx site in {path} to 127.0.0.1:8080 (backup: {backup})')
    return True


if __name__ == '__main__':
    for p in sys.argv[1:]:
        process(p)
