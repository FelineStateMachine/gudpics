"""Local dev server for dist/ that serves extensionless routes like Cloudflare does.
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import sys, http.server, functools
from pathlib import Path
root = Path(__file__).resolve().parent.parent / 'dist'
class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = super().translate_path(path)
        q = Path(p)
        if not q.exists() and q.with_suffix('.html').exists(): return str(q.with_suffix('.html'))
        return p
    def guess_type(self, path):
        if path.endswith('.mjs'): return 'text/javascript'
        if path.endswith('.wasm'): return 'application/wasm'
        if path.endswith('.webmanifest'): return 'application/manifest+json'
        return super().guess_type(path)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=str(root))).serve_forever()
