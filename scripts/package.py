"""Package public assets into dist/ with content-hashed filenames.
SPDX-License-Identifier: AGPL-3.0-or-later

Scripts, styles and wasm land in dist/static/ as name.<hash>.ext and every
reference to them is rewritten, so browsers and the service worker can cache
them forever while HTML pages are always fetched fresh.
"""
from pathlib import Path
import shutil, hashlib, re
root = Path(__file__).resolve().parent.parent
dist = root / 'dist'
if dist.exists(): shutil.rmtree(dist)
(dist / 'static').mkdir(parents=True)

# Hashed files in dependency order: leaves first, so a file's hash covers its rewritten references.
LUTS = sorted(p.relative_to(root).as_posix() for p in (root / 'assets' / 'luts').glob('*.png'))
HASHED = ['assets/core.wasm', 'assets/core.mjs', 'assets/raw.wasm', 'assets/raw.mjs'] + LUTS + ['geometry.mjs', 'worker.mjs', 'app.mjs', 'raf.mjs', 'lens.mjs', 'rawworker.mjs', 'fuji.mjs', 'home.mjs', 'viewport.js', 'style.css']
# Fixed-name text files that reference hashed ones.
PAGES = ['index.html', 'perspective.html', 'fuji.html']
FIXED = ['manifest.webmanifest', 'NOTICE.md', 'README.md', '_headers']
DIRS = ['LICENSES']
ICONS = ['assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png']

def digest(data): return hashlib.sha256(data).hexdigest()[:10]
mapping = {}  # source path -> dist path (relative to dist)

def rewrite(text, at_dir):
    """Replace './<source path>' references with the hashed dist path relative to at_dir."""
    for src, dst in mapping.items():
        rel = Path(dst).relative_to(at_dir) if Path(dst).is_relative_to(at_dir) else Path('..') / dst
        text = text.replace("'./" + src + "'", "'./" + rel.as_posix() + "'").replace('"./' + src + '"', '"./' + rel.as_posix() + '"')
    return text

for src in HASHED:
    p = root / src
    data = p.read_bytes()
    if p.suffix not in ('.wasm', '.png'):
        text = rewrite(data.decode(), 'static')
        if src in ('assets/core.mjs', 'assets/raw.mjs'):  # emscripten loader refers to its binary by bare name
            wasm = src.replace('.mjs', '.wasm'); text = text.replace('"' + Path(wasm).name + '"', '"' + Path(mapping[wasm]).name + '"')
        data = text.encode()
    name = f'{p.stem}.{digest(data)}{p.suffix}'
    mapping[src] = f'static/{name}'
    (dist / 'static' / name).write_bytes(data)

for src in PAGES + FIXED:
    (dist / src).parent.mkdir(parents=True, exist_ok=True)
    text = (root / src).read_text()
    if src.endswith('.html'): text = rewrite(text, '.')
    (dist / src).write_text(text)
for d in DIRS: shutil.copytree(root / d, dist / d)
(dist / 'assets').mkdir(exist_ok=True)
for src in ICONS: shutil.copyfile(root / src, dist / src)

# Service worker: precache list and a cache name derived from everything in dist.
precache = ['./', './perspective', './fuji'] + ['./' + v for v in mapping.values()] + ['./' + f for f in ['manifest.webmanifest', 'NOTICE.md'] + ICONS] + ['./LICENSES/' + p.name for p in sorted((root / 'LICENSES').iterdir()) if p.is_file()]
h = hashlib.sha256()
for p in sorted(dist.rglob('*')):
    if p.is_file(): h.update(p.read_bytes())
sw = (root / 'sw.js').read_text().replace('__CACHE__', 'gudpics-' + h.hexdigest()[:12]).replace('__FILES__', ','.join(f"'{f}'" for f in precache))
(dist / 'sw.js').write_text(sw)
print(f'Packaged {sum(1 for p in dist.rglob("*") if p.is_file())} files; ' + ', '.join(Path(v).name for v in mapping.values()))
