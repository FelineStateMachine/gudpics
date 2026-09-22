"""Package public assets into dist/.
SPDX-License-Identifier: AGPL-3.0-or-later
"""
from pathlib import Path
import shutil, hashlib
root=Path(__file__).resolve().parent.parent
dist=root/'dist'
dist.mkdir(exist_ok=True)
public=['index.html','perspective.html','style.css','viewport.js','home.mjs','app.mjs','worker.mjs','geometry.mjs','manifest.webmanifest','NOTICE.md','README.md','_headers']
for f in public: shutil.copyfile(root/f,dist/f)
for d in ['assets','LICENSES']: shutil.copytree(root/d,dist/d,dirs_exist_ok=True)
digest=hashlib.sha256()
for p in sorted(dist.rglob('*')):
    if p.is_file() and p.name!='sw.js': digest.update(p.read_bytes())
sw=(root/'sw.js').read_text().replace("gudpics-v1",'gudpics-'+digest.hexdigest()[:12])
(dist/'sw.js').write_text(sw)
print(f'Packaged {sum(1 for p in dist.rglob("*") if p.is_file())} files')
