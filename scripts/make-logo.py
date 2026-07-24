# -*- coding: utf-8 -*-
# Crop AI-generated DM logo: strip bottom-left watermark, trim to badge, export sizes.
from PIL import Image

SRC = 'assets-src/dm-logo.png'
img = Image.open(SRC).convert('RGBA')
alpha = img.getchannel('A')
w, h = img.size
px = alpha.load()
minx, miny, maxx, maxy = w, h, 0, 0
for y in range(h):
    for x in range(w):
        if px[x, y] > 8 and not (y > 930 and x < 220):
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
print('badge bbox:', minx, miny, maxx, maxy)

# square-crop around badge center with small padding
bw, bh = maxx - minx, maxy - miny
side = max(bw, bh)
cx, cy = (minx + maxx) // 2, (miny + maxy) // 2
pad = int(side * 0.02)
half = side // 2 + pad
left = max(0, cx - half); top = max(0, cy - half)
right = min(w, cx + half); bottom = min(h, cy + half)
badge = img.crop((left, top, right, bottom))
print('cropped:', badge.size)

import os
os.makedirs('web/public', exist_ok=True)
badge.save('assets-src/dm-logo-clean.png')
logo512 = badge.resize((512, 512), Image.LANCZOS)
logo512.save('web/public/logo.png')
fav64 = badge.resize((64, 64), Image.LANCZOS)
fav64.save('web/public/favicon.png')
fav32 = badge.resize((32, 32), Image.LANCZOS)
fav32.save('web/public/favicon-32.png')
print('written: web/public/logo.png, favicon.png, favicon-32.png')
