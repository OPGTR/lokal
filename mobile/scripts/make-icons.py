"""Makes the Android launcher icons and splash screens from public/lokal-icon.png.
Run: python3 mobile/scripts/make-icons.py  (needs Pillow)"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
RES = os.path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res')
src = Image.open(os.path.join(ROOT, 'public', 'lokal-icon.png')).convert('RGBA')
W = src.width
BG = (10, 10, 10, 255)

# The dark disc without its light rim.
disc_r = int(W * 0.455)
mask = Image.new('L', src.size, 0)
ImageDraw.Draw(mask).ellipse((W / 2 - disc_r, W / 2 - disc_r, W / 2 + disc_r, W / 2 + disc_r), fill=255)
disc = Image.new('RGBA', src.size, (0, 0, 0, 0))
disc.paste(src, (0, 0), mask)
disc = disc.crop((W // 2 - disc_r, W // 2 - disc_r, W // 2 + disc_r, W // 2 + disc_r))
disc_color = src.getpixel((W // 2, int(W * 0.08)))[:3]

def fit(img, size):
    return img.resize((size, size), Image.LANCZOS)

densities = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in densities.items():
    d = os.path.join(RES, f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    legacy = int(48 * k)
    fit(src, legacy).save(os.path.join(d, 'ic_launcher.png'))
    fit(src, legacy).save(os.path.join(d, 'ic_launcher_round.png'))
    # Adaptive foreground: 108dp canvas, the disc at 74% so the whole pin sits in
    # the 66dp safe zone; the background color is the disc's own.
    fg = int(108 * k)
    canvas = Image.new('RGBA', (fg, fg), (0, 0, 0, 0))
    inner = fit(disc, int(fg * 0.74))
    canvas.paste(inner, ((fg - inner.width) // 2, (fg - inner.height) // 2), inner)
    canvas.save(os.path.join(d, 'ic_launcher_foreground.png'))

with open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#%02X%02X%02X</color>\n</resources>\n' % disc_color)

# Splash (before Android 12): the logo centred on the app's dark background.
for folder in os.listdir(RES):
    path = os.path.join(RES, folder, 'splash.png')
    if not os.path.exists(path):
        continue
    w, h = Image.open(path).size
    splash = Image.new('RGBA', (w, h), BG)
    logo = fit(src, int(min(w, h) * 0.28))
    splash.paste(logo, ((w - logo.width) // 2, (h - logo.height) // 2), logo)
    splash.convert('RGB').save(path)
print('icons and splash screens written; disc color #%02X%02X%02X' % disc_color)
