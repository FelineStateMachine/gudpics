"""Rasterize the app mark; requires Pillow. AGPL-3.0-or-later."""
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parent.parent
S = 4  # supersample for smooth edges
for n in [192, 512]:
    big = n * S
    im = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = big / 512
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(112 * k), fill='#1a1a1a')
    trap = [(182, 128), (330, 128), (370, 384), (142, 384)]
    d.line([(x * k, y * k) for x, y in trap + trap[:2]], fill='#5e5e5e', width=round(22 * k), joint='curve')
    d.rounded_rectangle([168 * k, 128 * k, 344 * k, 384 * k], radius=round(10 * k), outline='#f0c04a', width=round(26 * k))
    im = im.resize((n, n), Image.LANCZOS)
    im.save(root / f'assets/icon-{n}.png')
