# ダミー商品・ブランド・おすすめの写真を作る：python scripts/generate-product-photos.py
# 元にする写真は scripts/photo-base の3枚（shampoo.png：ポンプボトル、oil.png：ガラスのポンプボトル、treatment.png：ジャー）。
# 写真から商品だけを切り抜き、容器・キャップ・ラベルの色をブランドごとに塗り替え、ラベルの文字を書き直す。
# - 商品：catalog.mjs で image が 'products/○○.webp' の商品（dist/assets/products/、800×800）
# - ブランド：dist/brands.js の各ブランドの商品を3つ並べた写真（dist/assets/brands/、カード用 1600×900 と一覧の上の横長 2400×900）
# - おすすめ：dist/brands.js の FEATURES（dist/assets/features/、1200×1500）
# 必要なもの：Python 3、Pillow・numpy・opencv-python、Windows の標準フォント（Century Gothic・Bodoni MT・Garamond・Segoe UI Light）
# ブランド・商品はすべて架空。
import json, os, subprocess, sys
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ASSETS = os.path.join(ROOT, 'dist', 'assets')
SOURCE = os.path.join(ROOT, 'scripts', 'photo-base')
FONTS = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
data = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
  "import {products} from './catalog.mjs'; import {BRANDS,FEATURES} from './dist/brands.js'; console.log(JSON.stringify({products,BRANDS,FEATURES}))"], cwd=ROOT))

# ---------- 元の写真：商品の切り抜きと、部品（キャップ・容器・ラベル）の場所 ----------
BASES = {
  # rect は切り抜きの範囲、cap は上の部品（ポンプ・ふた）の下端、floor は商品の底（影の基準）
  # sym は左右対称にそろえる範囲の上端（ポンプの注ぎ口より下）
  'pump': {'file': 'shampoo.png', 'rect': (370, 90, 500, 1100), 'cap': 350, 'floor': 1106, 'sym': 232,
           'text': {'brand': 650, 'rule': 760, 'line': 822, 'size': 1000}},
  'glass': {'file': 'oil.png', 'rect': (430, 140, 380, 960), 'cap': 445, 'floor': 1090, 'sym': 200,
            'text': {'brand': 715, 'rule': 787, 'line': 830, 'size': 918}},
  'jar': {'file': 'treatment.png', 'rect': (230, 380, 800, 600), 'cap': 580, 'floor': 955, 'sym': 0,
          'text': {'brand': 715, 'rule': 776, 'line': 827, 'size': None}},
}
# ラベルの文字を消す：まわりより暗い細い線を探し、その行の帯を、上下の色をつないで塗る（容器の陰影は左右方向なので、上下につなぐと自然）
def erase_text(im, surface, top):
  L = cv2.cvtColor(im, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32); local = cv2.medianBlur(L.astype(np.uint8), 31).astype(np.float32)
  ink = (surface & (L < local - 6)).astype(np.uint8); ink[:top] = 0
  n, cc, st, _ = cv2.connectedComponentsWithStats(ink); keep = np.zeros(n, bool); keep[1:] = st[1:, 4] >= 4; ink = keep[cc]
  rows = np.where(ink.sum(1) >= 2)[0]; out = im.astype(np.float32); rng = np.random.default_rng(1)
  bands = []
  for y in rows:
    if bands and y - bands[-1][1] <= 10: bands[-1][1] = y
    else: bands.append([y, y])
  for y0, y1 in bands:
    y0, y1 = y0 - 12, y1 + 12; xs = np.where(ink[y0:y1].any(0))[0]
    if not len(xs): continue
    x0, x1 = xs.min() - 16, xs.max() + 17
    above, below = np.median(out[y0 - 10:y0 - 2, x0:x1], 0), np.median(out[y1 + 2:y1 + 10, x0:x1], 0)
    above, below = cv2.GaussianBlur(above[None], (0, 0), 3)[0], cv2.GaussianBlur(below[None], (0, 0), 3)[0]
    grain = out[y0 - 16:y0 - 2, x0:x1].std(0).mean() * 0.5
    t = np.linspace(0, 1, y1 - y0)[:, None, None]
    fill = above * (1 - t) + below * t + rng.normal(0, grain, (y1 - y0, x1 - x0, 1))
    m = surface[y0:y1, x0:x1][..., None]; out[y0:y1, x0:x1] = np.where(m, fill, out[y0:y1, x0:x1])
  return np.clip(out, 0, 255).astype(np.uint8)

_cache = {}
def base(kind):
  if kind in _cache: return _cache[kind]
  b = BASES[kind]; im = cv2.imread(os.path.join(SOURCE, b['file']))
  small = cv2.resize(im, None, fx=0.5, fy=0.5); m = np.zeros(small.shape[:2], np.uint8)
  x, y, w, h = b['rect']
  cv2.grabCut(small, m, (x // 2, y // 2, w // 2, h // 2), np.zeros((1, 65)), np.zeros((1, 65)), 8, cv2.GC_INIT_WITH_RECT)
  fg = np.where((m == 1) | (m == 3), 255, 0).astype(np.uint8)
  fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
  fg = cv2.resize(fg, (im.shape[1], im.shape[0]), interpolation=cv2.INTER_LINEAR)
  # 輪郭をなめらかにし、背景の色がにじまないよう1〜2px内側にする
  fg = np.where(cv2.GaussianBlur(fg, (0, 0), 4) > 150, 255, 0).astype(np.uint8)
  alpha = cv2.GaussianBlur(fg, (0, 0), 1.2).astype(np.float32) / 255
  # 容器は左右対称：行ごとの左右の端から中心と半幅を求め、なめらかにして描き直す（切り抜きのギザギザを消す）
  rows = [y for y in range(b['sym'], fg.shape[0]) if (fg[y] > 128).any()]
  le = np.array([np.where(fg[y] > 128)[0].min() for y in rows], float); ri = np.array([np.where(fg[y] > 128)[0].max() + 1 for y in rows], float)
  c = np.median((le + ri) / 2); hw = np.minimum(c - le, ri - c) - 1
  pad = np.pad(hw, 4, mode='edge'); hw = np.median(np.lib.stride_tricks.sliding_window_view(pad, 9), 1)
  xs = np.arange(fg.shape[1])[None, :]
  alpha[rows] = np.clip(hw[:, None] - np.abs(xs + 0.5 - c) + 0.5, 0, 1)
  fg = np.where(alpha > 0.5, 255, 0).astype(np.uint8)
  lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB).astype(np.float32)
  H, W = fg.shape; yy = np.arange(H)[:, None].repeat(W, 1)
  inside = fg > 128
  parts = {'cap': inside & (yy < b['cap']), 'body': inside & (yy >= b['cap'])}
  if kind == 'glass':  # ガラスに貼ったラベル（明るく色の薄い四角。右へいくほど陰になる）
    light = ((lab[..., 0] > 165) & (np.hypot(lab[..., 1] - 128, lab[..., 2] - 128) < 14)).astype(np.uint8)
    _, cc, box, _ = cv2.connectedComponentsWithStats(light); x0, y0, w0, h0 = box[cc[(b['text']['brand'] + b['text']['line']) // 2, 628]][:4]
    x1, y1 = x0 + w0, y0 + h0; label = np.zeros_like(inside); label[y0 + 1:y1 - 1, x0 + 1:x1 - 1] = True
    parts['label'] = label & inside; parts['body'] = parts['body'] & ~label; b['label_box'] = (x0, y0, x1, y1)
  clean = erase_text(im, parts.get('label', parts['body']), b['cap'] + 40)
  lab = cv2.cvtColor(clean, cv2.COLOR_BGR2LAB).astype(np.float32)
  # 背景：商品を消して、ぼかした「何もない台紙」を作る（影の濃さを測るため）
  hole = cv2.dilate(fg, np.ones((25, 25), np.uint8))
  plate = cv2.inpaint(cv2.resize(clean, None, fx=0.25, fy=0.25), cv2.resize(hole, None, fx=0.25, fy=0.25), 15, cv2.INPAINT_TELEA)
  plate = cv2.GaussianBlur(cv2.resize(plate, (W, H)), (0, 0), 20)
  pl = cv2.cvtColor(plate, cv2.COLOR_BGR2LAB).astype(np.float32)[..., 0]
  shade = np.clip(lab[..., 0] / np.maximum(pl, 1), 0, 1.05)  # 1 = 影なし、小さいほど影
  shade = np.where(inside, 1, shade); shade = np.minimum(shade, 1)
  stats = {k: (lab[v][:, 0].mean(), lab[v][:, 1].mean(), lab[v][:, 2].mean()) for k, v in parts.items()}
  _cache[kind] = r = {'lab': lab, 'alpha': alpha, 'parts': parts, 'shade': shade, 'stats': stats, 'b': b, 'size': (W, H)}
  return r

# ---------- 色の塗り替え（明るさの陰影はそのまま、色だけ変える） ----------
def hex_lab(h):
  rgb = np.uint8([[[int(h[5:7], 16), int(h[3:5], 16), int(h[1:3], 16)]]])
  return cv2.cvtColor(rgb, cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)
def recolor(lab, mask, mean, target, contrast=1.0, chroma=0.35, finish=None):
  t = hex_lab(target); L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
  k = contrast * (0.55 + 0.45 * t[0] / 255) if t[0] < 110 else contrast
  out = lab.copy()
  out[..., 0] = np.where(mask, np.clip(t[0] + (L - mean[0]) * k, 0, 255), L)
  out[..., 1] = np.where(mask, t[1] + (a - mean[1]) * chroma, a)
  out[..., 2] = np.where(mask, t[2] + (b - mean[2]) * chroma, b)
  if finish == 'metal':  # 金属：明るいところをより明るく
    hi = np.clip((L - mean[0]) / 60, 0, 1)
    out[..., 0] = np.where(mask, np.clip(out[..., 0] + hi * 30, 0, 255), out[..., 0])
  return out
def tint_glass(lab, mask, target, strength=1.0, lift=0.0):
  # 琥珀色のガラスの色合いを、別の色のガラスへ。色の濃さ（琥珀の強さ）を保ったまま向きを変える
  a, b = lab[..., 1] - 128, lab[..., 2] - 128; s = np.sqrt(a * a + b * b)
  t = hex_lab(target); ta, tb = t[1] - 128, t[2] - 128; tn = max(np.hypot(ta, tb), 1e-3)
  out = lab.copy(); scale = strength * tn / 60
  out[..., 1] = np.where(mask, 128 + s * ta / tn * scale, lab[..., 1])
  out[..., 2] = np.where(mask, 128 + s * tb / tn * scale, lab[..., 2])
  L = lab[..., 0]; out[..., 0] = np.where(mask, np.clip(L + lift * (255 - L) * 0.6 + (t[0] - 120) * 0.25, 0, 255), L)
  return out

# ---------- ラベルの文字 ----------
FACE = {'gothic': 'GOTHIC.TTF', 'bodoni': 'BOD_R.TTF', 'garamond': 'GARA.TTF', 'light': 'segoeuil.ttf'}
def font(face, size): return ImageFont.truetype(os.path.join(FONTS, FACE[face]), size)
def spaced(draw, cx, cy, text, f, fill, track):
  widths = [draw.textlength(ch, font=f) for ch in text]; total = sum(widths) + track * (len(text) - 1)
  x = cx - total / 2; asc, desc = f.getmetrics()
  for ch, w in zip(text, widths): draw.text((x, cy - (asc - desc) / 2 - desc * 0.2), ch, font=f, fill=fill); x += w + track
  return total
def fit(draw, text, face, size, track, width):
  while size > 10:
    f = font(face, size)
    if sum(draw.textlength(ch, font=f) for ch in text) + track * size * (len(text) - 1) <= width: return f, track * size
    size -= 2
  return font(face, size), track * size

# ---------- ブランドの色と文字の雰囲気 ----------
# body：容器、cap：ポンプ・ふた、label：ガラスに貼るラベル、ink：文字、glass：ガラスの色（oil の写真を使うもの）
STYLE = {
  'SENA PROFESSIONAL': {'face': 'gothic', 'word': 'SENA', 'sub': '', 'ink': '#3c4a44'},
  'SENA BOTANICAL': {'face': 'gothic', 'word': 'SENA', 'sub': 'BOTANICAL', 'ink': '#3d2f22'},
  'MIZUHA': {'face': 'bodoni', 'word': 'MIZUHA', 'sub': '', 'ink': '#f4f6fa'},
  'CALMÉ SCALP': {'face': 'light', 'word': 'CALMÉ', 'sub': 'SCALP', 'ink': '#2b6d63'},
  'NOIR ATELIER': {'face': 'bodoni', 'word': 'NOIR', 'sub': 'ATELIER', 'ink': '#d8c08a'},
  'HARU ORGANICS': {'face': 'garamond', 'word': 'HARU', 'sub': 'ORGANICS', 'ink': '#8a4a2c'},
  'IRODORI COLOR': {'face': 'light', 'word': 'IRODORI', 'sub': 'COLOR', 'ink': '#ffffff'},
}
# 商品ごと：元の写真（pump / glass / jar）・ラベルの英字・色
LOOK = {
  'shampoo-moist': {'base': 'pump', 'line': 'MOIST REPAIR SHAMPOO', 'body': '#a3bdb3', 'cap': '#9db7ad'},
  'shampoo-air': {'base': 'pump', 'line': 'AIRY CARE SHAMPOO', 'body': '#e9eeec', 'cap': '#e3e8e6'},
  'treatment-repair': {'base': 'jar', 'line': 'INTENSIVE REPAIR MASK', 'body': '#efebe6', 'cap': 'chrome'},
  'treatment-daily': {'base': 'pump', 'line': 'DAILY CARE TREATMENT', 'body': '#d5dfd9', 'cap': '#bccbc3'},
  'oil-smooth': {'base': 'glass', 'line': 'SMOOTH FINISH OIL', 'glass': 'amber', 'label': '#f1ede4'},
  'oil-rich': {'base': 'glass', 'line': 'RICH MOISTURE OIL', 'glass': '#5a3416', 'label': '#2b2420', 'ink': '#e9dcc6'},
  'sena-mask-deep': {'base': 'jar', 'line': 'DEEP REPAIR MASK', 'body': '#9fb9ad', 'cap': 'chrome'},
  'sena-milk-heat': {'base': 'pump', 'line': 'HEAT PROTECT MILK', 'body': '#f3f1ec', 'cap': '#a3bdb3'},
  'botanical-mist': {'base': 'glass', 'line': 'BOTANICAL HAIR MIST', 'glass': '#b98a4b', 'label': '#f4ecdf'},
  'botanical-scalp-shampoo': {'base': 'pump', 'line': 'SCALP SHAMPOO', 'body': '#b98d5f', 'cap': '#3a312b'},
  'mizuha-shampoo': {'base': 'pump', 'line': 'MOIST SHAMPOO', 'body': '#2c4672', 'cap': '#2a426b'},
  'mizuha-treatment': {'base': 'pump', 'line': 'MOIST TREATMENT', 'body': '#e8ecf3', 'cap': '#2c4672', 'ink': '#2c4672'},
  'mizuha-camellia-oil': {'base': 'glass', 'line': 'CAMELLIA HAIR OIL', 'glass': '#a3203a', 'label': '#f5f2ec', 'ink': '#2c4672'},
  'mizuha-mask': {'base': 'jar', 'line': 'RICH HAIR MASK', 'body': '#2c4672', 'cap': 'chrome'},
  'calme-scalp-shampoo': {'base': 'pump', 'line': 'SCALP CLEANSING', 'body': '#f2f5f4', 'cap': '#3f8e83'},
  'calme-scalp-serum': {'base': 'glass', 'line': 'SCALP SERUM', 'glass': '#2f8a7d', 'label': '#ffffff'},
  'calme-scalp-gel': {'base': 'jar', 'line': 'SCALP CLEANSING GEL', 'body': '#e9f3f1', 'cap': '#3f8e83'},
  'calme-scalp-mist': {'base': 'glass', 'line': 'COOL SCALP MIST', 'glass': '#7fb9c9', 'label': '#ffffff', 'lift': 0.35},
  'noir-wax-soft': {'base': 'jar', 'line': 'SOFT WAX', 'body': '#2a2827', 'cap': 'black'},
  'noir-wax-hard': {'base': 'jar', 'line': 'HARD WAX', 'body': '#5a2624', 'cap': 'black'},
  'noir-balm': {'base': 'jar', 'line': 'STYLING BALM', 'body': '#c2a874', 'cap': 'black', 'ink': '#2a2827'},
  'noir-spray': {'base': 'pump', 'line': 'KEEP SPRAY', 'body': '#272524', 'cap': '#b79a62'},
  'noir-styling-oil': {'base': 'glass', 'line': 'WET STYLING OIL', 'glass': '#3b3a38', 'label': '#1f1d1c'},
  'haru-shampoo': {'base': 'pump', 'line': 'ORGANIC SHAMPOO', 'body': '#efe5d7', 'cap': '#b9663f'},
  'haru-treatment': {'base': 'jar', 'line': 'ORGANIC TREATMENT', 'body': '#efe5d7', 'cap': 'gold'},
  'haru-milk': {'base': 'pump', 'line': 'ORGANIC HAIR MILK', 'body': '#d9c3a6', 'cap': '#f3ece2'},
  'irodori-shampoo-purple': {'base': 'pump', 'line': 'COLOR SHAMPOO PURPLE', 'body': '#6c4f9c', 'cap': '#5f448c'},
  'irodori-shampoo-pink': {'base': 'pump', 'line': 'COLOR SHAMPOO PINK', 'body': '#d98aa6', 'cap': '#cf7c99'},
  'irodori-mask': {'base': 'jar', 'line': 'COLOR KEEP MASK', 'body': '#6c4f9c', 'cap': 'chrome'},
  'irodori-mist': {'base': 'glass', 'line': 'COLOR KEEP MIST', 'glass': '#7b5bb0', 'label': '#f7f3fb', 'ink': '#5c4290'},
}
METALS = {'chrome': None, 'gold': '#c9a96a', 'black': '#2a2928'}
BACKDROP = '#efeeec'  # 商品写真の背景（明るいグレー）

def ink_for(look, st, surface):
  # 文字の色：商品の指定 → ブランドの色。容器の色と近すぎて読めないときは、白か濃い色にする
  ink = look.get('ink') or st['ink']
  if abs(hex_lab(ink)[0] - hex_lab(surface)[0]) < 80: ink = '#f5f3ef' if hex_lab(surface)[0] < 128 else '#2f2b28'
  return ink

def render_product(p, backdrop=BACKDROP):
  """商品の写真（RGBA の切り抜き付き）を作る。戻り値：(背景つき画像, 切り抜き, 影の濃さ)"""
  look = LOOK[p['id']]; st = STYLE[p['brand']]; kind = look['base']; B = base(kind); b = B['b']
  lab = B['lab'].copy(); parts = B['parts']; stats = B['stats']
  # 容器
  if kind == 'glass':
    if look['glass'] != 'amber': lab = tint_glass(lab, parts['body'], look['glass'], lift=look.get('lift', 0))
    lab = recolor(lab, parts['label'], stats['label'], look['label'], chroma=0.2)
    surface = look['label']
  else:
    lab = recolor(lab, parts['body'], stats['body'], look['body'], contrast=1.0 if kind == 'pump' else 1.1)
    surface = look['body']
  # ポンプ・ふた
  cap = look.get('cap')
  if kind == 'jar':
    if cap in ('gold', 'black'): lab = recolor(lab, parts['cap'], stats['cap'], METALS[cap], contrast=1.0 if cap == 'gold' else 0.55, chroma=0.2, finish='metal' if cap == 'gold' else None)
  elif kind == 'pump' and cap:
    lab = recolor(lab, parts['cap'], stats['cap'], cap)
  img = cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
  # 背景を明るいグレーに（影はそのまま）
  W, H = B['size']; t = hex_lab(backdrop)
  bg = np.zeros((H, W, 3), np.float32); bg[..., 0] = t[0] * B['shade']; bg[..., 1] = t[1]; bg[..., 2] = t[2]
  bg = cv2.cvtColor(np.clip(bg, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
  a = B['alpha'][..., None]; comp = (img * a + bg * (1 - a)).astype(np.uint8)
  # 文字
  pil = Image.fromarray(cv2.cvtColor(comp, cv2.COLOR_BGR2RGB)); d = ImageDraw.Draw(pil)
  T = b['text']; ink = ink_for(look, st, surface)
  width = (b['label_box'][2] - b['label_box'][0]) * 0.74 if kind == 'glass' else (250 if kind == 'pump' else 420)
  f, tr = fit(d, st['word'], st['face'], 62 if kind != 'jar' else 70, 0.42 if st['face'] != 'bodoni' else 0.3, width)
  spaced(d, 628, T['brand'], st['word'], f, ink, tr); below = T['brand'] + f.size * 0.42
  if st['sub']:
    fs, ts = fit(d, st['sub'], 'gothic', 16 if kind != 'jar' else 18, 0.5, width); ys = below + 14 + fs.size * 0.5
    spaced(d, 628, ys, st['sub'], fs, ink, ts); below = ys + fs.size * 0.5
  rule = max(T['rule'], below + 30); line = rule + (T['line'] - T['rule'])
  d.line([(612, rule), (644, rule)], fill=ink, width=2)
  fl, tl = fit(d, look['line'], 'gothic', 21, 0.28, width + 20); spaced(d, 628, line, look['line'], fl, ink, tl)
  if T['size']:
    fz = font('gothic', 19); spaced(d, 628, T['size'], p['size'].replace('mL', 'mL'), fz, ink, 3)
  out = np.array(pil)[..., ::-1].copy()
  # 文字を容器になじませる（容器の外には描かない）
  out = np.where(B['alpha'][..., None] > 0.5, out, comp)
  cut = np.dstack([out, (B['alpha'] * 255).astype(np.uint8)])
  return out, cut, B

def save(img_bgr, rel, size):
  im = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)).resize(size, Image.LANCZOS)
  path = os.path.join(ASSETS, rel); os.makedirs(os.path.dirname(path), exist_ok=True)
  im.save(path, 'WEBP', quality=84, method=6)

# ---------- 撮影の雰囲気（ブランド・おすすめ） ----------
SCENES = {
  'SENA PROFESSIONAL': {'wall': '#dfe6e1', 'floor': '#cfd8d2', 'leaf': 0.16},
  'SENA BOTANICAL': {'wall': '#e6d8c5', 'floor': '#d6c4ab', 'leaf': 0.18},
  'MIZUHA': {'wall': '#d9dfe9', 'floor': '#c5cedd', 'leaf': 0.15},
  'CALMÉ SCALP': {'wall': '#dcebe7', 'floor': '#c8dfd9', 'leaf': 0.15},
  'NOIR ATELIER': {'wall': '#3b3835', 'floor': '#2a2826', 'leaf': 0.3},
  'HARU ORGANICS': {'wall': '#ecdfcf', 'floor': '#dccab4', 'leaf': 0.17},
  'IRODORI COLOR': {'wall': '#e3dcee', 'floor': '#d2c8e3', 'leaf': 0.15},
}
def rgb(h): return np.array([int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)], np.float32)
def leaf_shadow(W, H, seed, count=4):
  # 窓辺の植物の影（ぼかした葉の形）
  rng = np.random.default_rng(seed); m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
  for _ in range(count):
    cx, cy = rng.uniform(0.05, 0.95) * W, rng.uniform(-0.15, 0.3) * H; ang = rng.uniform(0.3, np.pi - 0.3); stem = rng.uniform(0.3, 0.55) * H
    for k in range(7):
      t = 0.15 + k / 7; px, py = cx + np.cos(ang) * stem * t, cy + np.sin(ang) * stem * t
      for side in (-1, 1):
        la = ang + side * rng.uniform(0.5, 0.9); ln = rng.uniform(0.1, 0.17) * H; wd = ln * 0.26
        pts = []
        for s in np.linspace(0, 1, 14):
          r = np.sin(np.pi * s) * wd
          pts.append((px + np.cos(la) * ln * s - np.sin(la) * r, py + np.sin(la) * ln * s + np.cos(la) * r))
        for s in np.linspace(1, 0, 14):
          r = -np.sin(np.pi * s) * wd
          pts.append((px + np.cos(la) * ln * s - np.sin(la) * r, py + np.sin(la) * ln * s + np.cos(la) * r))
        d.polygon(pts, fill=255)
    d.line([(cx, cy), (cx + np.cos(ang) * stem, cy + np.sin(ang) * stem)], fill=255, width=max(3, W // 300))
  return np.array(m.filter(ImageFilter.GaussianBlur(max(W, H) / 260)), np.float32) / 255
def backdrop(W, H, sc, horizon, light_x, seed):
  y = np.linspace(0, 1, H)[:, None]; x = np.linspace(0, 1, W)[None, :]
  wall, floor = rgb(sc['wall']), rgb(sc['floor'])
  t = np.clip((y - horizon) / 0.03 + 0.5, 0, 1)[..., None]  # 壁と床のつなぎ目（やわらかく）
  img = wall * (1 - t) + floor * t
  glow = np.exp(-(((x - light_x) / 0.38) ** 2 + ((y - horizon * 0.75) / 0.55) ** 2))[..., None]
  dark = sc['wall'] in ('#3b3835',)
  img = img * (0.86 + 0.22 * glow) if not dark else img * (0.8 + 0.55 * glow)
  vign = 1 - 0.12 * (((x - 0.5) / 0.7) ** 2 + ((y - 0.5) / 0.8) ** 2)[..., None]; img = img * vign
  sh = leaf_shadow(W, H, seed)[..., None]; img = img * (1 - sc['leaf'] * sh)
  noise = np.random.default_rng(seed).normal(0, 1.6, (H, W, 1)); img = img + noise
  return np.clip(img, 0, 255)
def plinth(img, cx, top, w, h, sc):
  # 円柱の台（左から光が当たる陰影）
  H, W = img.shape[:2]; ry = w * 0.075; base_col = rgb(sc['floor']) * 1.08 if sc['wall'] != '#3b3835' else rgb('#4a4744')
  xs = np.arange(int(cx - w / 2), int(cx + w / 2)); u = (xs - cx) / (w / 2)
  shadev = 0.78 + 0.3 * np.cos((u + 0.35) * np.pi / 2.2) ** 2
  for x, s in zip(xs, shadev):
    yt = top + ry * np.sqrt(max(0, 1 - ((x - cx) / (w / 2)) ** 2)); yb = top + h + ry * np.sqrt(max(0, 1 - ((x - cx) / (w / 2)) ** 2))
    y0, y1 = int(max(0, yt)), int(min(H, yb))
    if 0 <= x < W and y1 > y0: img[y0:y1, x] = np.clip(base_col * s, 0, 255)
  top_img = Image.new('L', (W, H), 0); ImageDraw.Draw(top_img).ellipse([cx - w / 2, top - ry, cx + w / 2, top + ry], fill=255)
  m = np.array(top_img, np.float32)[..., None] / 255; img[:] = img * (1 - m) + np.clip(base_col * 1.13, 0, 255) * m
  return img
def shadow_under(img, cx, floor, w, strength=0.35):
  H, W = img.shape[:2]; m = Image.new('L', (W, H), 0)
  ImageDraw.Draw(m).ellipse([cx - w * 0.55, floor - w * 0.05, cx + w * 0.55, floor + w * 0.06], fill=255)
  m = np.array(m.filter(ImageFilter.GaussianBlur(w * 0.06)), np.float32)[..., None] / 255
  img[:] = img * (1 - strength * m)
  # 右後ろへ伸びるやわらかい影
  m2 = Image.new('L', (W, H), 0); ImageDraw.Draw(m2).ellipse([cx - w * 0.2, floor - w * 0.12, cx + w * 1.1, floor + w * 0.02], fill=255)
  m2 = np.array(m2.filter(ImageFilter.GaussianBlur(w * 0.12)), np.float32)[..., None] / 255
  img[:] = img * (1 - strength * 0.45 * m2)
def paste(img, cut_bgra, B, cx, floor, height):
  # 切り抜いた商品を、底の中心が (cx, floor)、高さが height になるように置く
  a = cut_bgra[..., 3]; ys, xs = np.where(a > 20); y0, y1, x0, x1 = ys.min(), B['b']['floor'], xs.min(), xs.max() + 1
  crop = cut_bgra[y0:y1 + 6, x0:x1]; s = height / (y1 - y0)
  crop = cv2.resize(crop, (max(1, int(crop.shape[1] * s)), max(1, int(crop.shape[0] * s))), interpolation=cv2.INTER_AREA)
  h, w = crop.shape[:2]; ox = int(cx - w / 2 - (x0 + (x1 - x0) / 2 - (x0 + x1) / 2) * s); oy = int(floor - (y1 - y0) * s)
  shadow_under(img, cx, floor, w * 0.9)
  H, W = img.shape[:2]; sx0, sy0 = max(0, ox), max(0, oy); sx1, sy1 = min(W, ox + w), min(H, oy + h)
  part = crop[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox].astype(np.float32); al = part[..., 3:4] / 255
  img[sy0:sy1, sx0:sx1] = img[sy0:sy1, sx0:sx1] * (1 - al) + part[..., :3][..., ::-1] * al
  return w

def brand_scene(name, items, wide):
  W, H = (2400, 900) if wide else (1600, 900); sc = SCENES[name]; dx = 720 if wide else 0
  img = backdrop(W, H, sc, 0.66, (800 + dx) / W, len(name) * 7 + (1 if wide else 0))
  slots = [(800, 610, 330, 175, 470), (470, 690, 270, 95, 360), (1130, 720, 260, 65, 330)]
  order = [0, 1, 2][:len(items)]
  for i in sorted(order, key=lambda i: slots[i][1]):
    cx, top, w, h, ph = slots[i]; cx += dx; p = items[i]; _, cut, B = render_product(p)
    kind = LOOK[p['id']]['base']; ph = ph * (0.58 if kind == 'jar' else 1.0)
    plinth(img, cx, top, w, h, sc); paste(img, cut, B, cx, top + w * 0.03, ph)
  return img.astype(np.uint8)
def feature_scene(p):
  W, H = 1200, 1500; sc = SCENES[p['brand']]; img = backdrop(W, H, sc, 0.7, 0.5, len(p['id']) * 11)
  kind = LOOK[p['id']]['base']; plinth(img, 600, 1060, 540, 300, sc)
  _, cut, B = render_product(p); paste(img, cut, B, 600, 1060 + 540 * 0.03, 470 if kind == 'jar' else 820)
  return img.astype(np.uint8)

def main():
  products = data['products']; byid = {p['id']: p for p in products}; n = 0
  for p in products:
    img = p.get('image', '')
    if not (img.startswith('products/') and img.endswith('.webp')): continue
    if p['id'] not in LOOK: sys.exit(f'写真の設定がありません：{p["id"]}')
    out, _, _ = render_product(p); save(out, img, (800, 800)); n += 1
  print(f'商品の写真を {n} 点作りました（dist/assets/products/）。')
  nb = 0
  for name, info in data['BRANDS'].items():
    mine = [p for p in products if p['brand'] == name and p['id'] in LOOK]; picked = []
    for p in mine:
      if len(picked) < 3 and LOOK[p['id']]['base'] not in [LOOK[x['id']]['base'] for x in picked]: picked.append(p)
    for p in mine:
      if len(picked) < 3 and p not in picked: picked.append(p)
    if not picked: sys.exit(f'ブランドの写真に使う商品がありません：{name}')
    # 真ん中（いちばん高い台）にポンプボトル、左右に低いもの
    picked.sort(key=lambda p: {'pump': 0, 'glass': 1, 'jar': 2}[LOOK[p['id']]['base']])
    if info.get('image'): save(cv2.cvtColor(brand_scene(name, picked, False), cv2.COLOR_RGB2BGR), info['image'], (1600, 900)); nb += 1
    if info.get('hero'): save(cv2.cvtColor(brand_scene(name, picked, True), cv2.COLOR_RGB2BGR), info['hero'], (2400, 900))
  for f in data['FEATURES']:
    p = byid.get(f['product'])
    if not p or p['id'] not in LOOK: sys.exit(f'おすすめの商品がありません：{f["product"]}')
    save(cv2.cvtColor(feature_scene(p), cv2.COLOR_RGB2BGR), f['image'], (1200, 1500))
  print(f'ブランドの写真を {nb} 点（一覧の上の横長 {nb} 点）、おすすめの写真を {len(data["FEATURES"])} 点作りました。')

if __name__ == '__main__': main()
