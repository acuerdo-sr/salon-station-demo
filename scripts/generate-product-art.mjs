// ダミー商品・ブランド・おすすめのイラスト（SVG）を作る：node scripts/generate-product-art.mjs
// - 商品：catalog.mjs で image が 'products/○○.svg' の商品。ボトル・ジャーなどの形と、ブランドの色・名前を入れた絵（dist/assets/products/）
// - ブランド：dist/brands.js の各ブランドの商品を、台の上に3つ並べた横長の絵（dist/assets/brands/）
// - おすすめ：dist/brands.js の FEATURES。1つの商品を光の当たる台に置いた縦長の絵（dist/assets/features/）
// ブランド・商品はすべて架空。写真の代わりに、ブランド名の入った落ち着いた絵にする。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { products } from '../catalog.mjs';
import { BRANDS, FEATURES } from '../dist/brands.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = path.join(root, 'dist', 'assets', 'products');
// ブランドの色：背景（上・下）、容器（明・暗）、キャップ、ラベル、文字
const PALETTES = {
  'SENA PROFESSIONAL': { bg: ['#edf2ef', '#d8e4dd'], body: ['#a9c2b5', '#87a596'], cap: ['#f6f6f2', '#d9dbd4'], label: '#f8f8f5', ink: '#4e6c5e' },
  'SENA BOTANICAL': { bg: ['#f3ede4', '#e4d7c4'], body: ['#b8783a', '#8d5523'], cap: ['#3a332e', '#1f1b18'], label: '#f7f0e5', ink: '#5d3b1d' },
  'MIZUHA': { bg: ['#ebeff6', '#d4dcea'], body: ['#3d5a8c', '#263d66'], cap: ['#f1f3f7', '#cfd6e2'], label: '#f5f7fb', ink: '#2c4673' },
  'CALMÉ SCALP': { bg: ['#e8f3f1', '#cde5e1'], body: ['#f3f9f8', '#d4e8e4'], cap: ['#4c9a8f', '#2f7368'], label: '#ffffff', ink: '#2c7368' },
  'NOIR ATELIER': { bg: ['#efeeeb', '#d9d6d0'], body: ['#3a3836', '#1a1918'], cap: ['#c7ad74', '#9b8150'], label: '#262423', ink: '#cdb27a' },
  'HARU ORGANICS': { bg: ['#f6eee6', '#e9dacb'], body: ['#f3e8da', '#ddcbb4'], cap: ['#c06d47', '#94492a'], label: '#fcf7f0', ink: '#9b5536' },
  'IRODORI COLOR': { bg: ['#f3eef7', '#e1d7ee'], body: ['#9478bf', '#6f539e'], cap: ['#f6f2fa', '#d8cfe6'], label: '#fbf8fd', ink: '#6a4e98' },
};
// 商品ごとの形と、ラベルの英字（必要なら色を上書き）
const ART = {
  // 初期の6点（商品は写真。ブランド・おすすめの絵にだけ使う）
  'shampoo-moist': { shape: 'pump', line: 'MOIST REPAIR SHAMPOO' },
  'treatment-repair': { shape: 'jar', line: 'INTENSIVE REPAIR MASK', body: ['#f6f5f1', '#d9d7cf'], cap: ['#d4d7db', '#9aa0a6'] },
  'oil-smooth': { shape: 'dropper', line: 'SMOOTH FINISH OIL' },
  'shampoo-air': { shape: 'pump', line: 'AIRY CARE SHAMPOO', body: ['#c4d6cc', '#9db8aa'] },
  'treatment-daily': { shape: 'jar', line: 'DAILY TREATMENT', body: ['#f6f5f1', '#d9d7cf'], cap: ['#d4d7db', '#9aa0a6'] },
  'oil-rich': { shape: 'dropper', line: 'RICH MOISTURE OIL', body: ['#9a5a26', '#6f3c15'] },
  'sena-mask-deep': { shape: 'jar', line: 'DEEP REPAIR MASK' },
  'sena-milk-heat': { shape: 'tube', line: 'HEAT PROTECT MILK' },
  'botanical-mist': { shape: 'spray', line: 'BOTANICAL MIST', body: ['#d9b07d', '#b9884f'] },
  'botanical-scalp-shampoo': { shape: 'pump', line: 'SCALP SHAMPOO' },
  'mizuha-shampoo': { shape: 'pump', line: 'MOIST SHAMPOO' },
  'mizuha-treatment': { shape: 'pump', line: 'MOIST TREATMENT', body: ['#f2f4f9', '#d3dbe9'], cap: ['#3d5a8c', '#263d66'] },
  'mizuha-camellia-oil': { shape: 'dropper', line: 'CAMELLIA OIL', body: ['#c8435a', '#8e2438'] },
  'mizuha-mask': { shape: 'jar', line: 'RICH HAIR MASK' },
  'calme-scalp-shampoo': { shape: 'pump', line: 'SCALP CLEANSING' },
  'calme-scalp-serum': { shape: 'dropper', line: 'SCALP SERUM', body: ['#7cc1b6', '#4b958a'], cap: ['#f4f8f7', '#d2e2df'] },
  'calme-scalp-gel': { shape: 'tube', line: 'SCALP GEL' },
  'calme-scalp-mist': { shape: 'spray', line: 'COOL SCALP MIST' },
  'noir-wax-soft': { shape: 'tin', line: 'SOFT WAX' },
  'noir-wax-hard': { shape: 'tin', line: 'HARD WAX', body: ['#6b2f2b', '#43191a'] },
  'noir-balm': { shape: 'tin', line: 'STYLING BALM', body: ['#c7ad74', '#9b8150'], cap: ['#3a3836', '#1a1918'], label: '#f4efe4', ink: '#3a3836' },
  'noir-spray': { shape: 'can', line: 'KEEP SPRAY' },
  'noir-styling-oil': { shape: 'dropper', line: 'WET STYLING OIL' },
  'haru-shampoo': { shape: 'pump', line: 'ORGANIC SHAMPOO' },
  'haru-treatment': { shape: 'jar', line: 'ORGANIC TREATMENT' },
  'haru-milk': { shape: 'tube', line: 'ORGANIC HAIR MILK' },
  'irodori-shampoo-purple': { shape: 'pump', line: 'COLOR SHAMPOO PURPLE' },
  'irodori-shampoo-pink': { shape: 'pump', line: 'COLOR SHAMPOO PINK', body: ['#e59ab6', '#c56c8d'], ink: '#a8506f' },
  'irodori-mask': { shape: 'jar', line: 'COLOR KEEP MASK' },
  'irodori-mist': { shape: 'spray', line: 'COLOR KEEP MIST' },
};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ラベル（ブランドの1語目・商品の英字・容量）。w が狭いときは文字を小さくする
function label(x, y, w, h, c, brand, line, size) {
  const word = brand.split(' ')[0], big = Math.min(28, Math.floor((w - 16) / (word.length * 0.95))), small = Math.min(12, Math.floor((w - 12) / (line.length * 0.66)));
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${c.label}" opacity=".96"/>
  <text x="400" y="${y + h * 0.42}" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-size="${big}" letter-spacing="${Math.max(2, big / 5)}" fill="${c.ink}">${esc(word)}</text>
  <rect x="${400 - 14}" y="${y + h * 0.52}" width="28" height="1.6" fill="${c.ink}" opacity=".6"/>
  <text x="400" y="${y + h * 0.68}" text-anchor="middle" font-family="'Helvetica Neue',Arial,sans-serif" font-size="${small}" letter-spacing="1.6" fill="${c.ink}">${esc(line)}</text>
  <text x="400" y="${y + h * 0.88}" text-anchor="middle" font-family="'Helvetica Neue',Arial,sans-serif" font-size="${Math.min(11, small)}" letter-spacing="1.2" fill="${c.ink}" opacity=".75">${esc(size)}</text>`;
}
const shine = (x, y, h) => `<rect x="${x}" y="${y}" width="14" height="${h}" rx="7" fill="#fff" opacity=".26"/>`;
const SHAPES = {
  pump: (c, b, l, s) => `<rect x="310" y="330" width="180" height="310" rx="42" fill="url(#body)"/>${shine(330, 360, 240)}
    <rect x="368" y="292" width="64" height="44" rx="8" fill="url(#cap)"/><rect x="356" y="276" width="88" height="24" rx="7" fill="url(#cap)"/>
    <rect x="392" y="236" width="16" height="44" fill="url(#cap)"/><rect x="350" y="212" width="100" height="30" rx="10" fill="url(#cap)"/>
    <path d="M448 220 h58 a7 7 0 0 1 0 14 h-58 z" fill="url(#cap)"/>${label(330, 420, 140, 160, c, b, l, s)}`,
  jar: (c, b, l, s) => `<rect x="250" y="452" width="300" height="188" rx="36" fill="url(#body)"/>${shine(272, 476, 130)}
    <rect x="238" y="392" width="324" height="72" rx="16" fill="url(#cap)"/><rect x="238" y="452" width="324" height="6" fill="#000" opacity=".08"/>${label(292, 488, 216, 120, c, b, l, s)}`,
  dropper: (c, b, l, s) => `<rect x="325" y="400" width="150" height="240" rx="30" fill="url(#body)"/>${shine(342, 424, 180)}
    <rect x="372" y="360" width="56" height="46" rx="6" fill="url(#cap)"/><rect x="358" y="318" width="84" height="52" rx="10" fill="url(#cap)"/>
    <rect x="378" y="248" width="44" height="80" rx="22" fill="url(#cap)"/>${label(340, 462, 120, 130, c, b, l, s)}`,
  spray: (c, b, l, s) => `<rect x="318" y="340" width="164" height="300" rx="52" fill="url(#body)"/>${shine(338, 372, 220)}
    <rect x="372" y="302" width="56" height="44" rx="6" fill="url(#cap)"/><rect x="354" y="248" width="92" height="60" rx="14" fill="url(#cap)"/>
    <rect x="334" y="264" width="24" height="16" rx="5" fill="url(#cap)"/>${label(336, 420, 128, 150, c, b, l, s)}`,
  tube: (c, b, l, s) => `<path d="M352 586 L330 252 Q330 236 346 236 L454 236 Q470 236 470 252 L448 586 Z" fill="url(#body)"/>${shine(348, 262, 290)}
    <rect x="324" y="210" width="152" height="32" rx="4" fill="url(#body)"/><g opacity=".18" fill="#000"><rect x="324" y="216" width="152" height="2"/><rect x="324" y="224" width="152" height="2"/><rect x="324" y="232" width="152" height="2"/></g>
    <rect x="344" y="578" width="112" height="62" rx="12" fill="url(#cap)"/>${label(352, 330, 96, 170, c, b, l, s)}`,
  tin: (c, b, l, s) => `<rect x="252" y="522" width="296" height="118" rx="24" fill="url(#body)"/><rect x="242" y="470" width="316" height="64" rx="20" fill="url(#cap)"/>
    <rect x="242" y="524" width="316" height="6" fill="#000" opacity=".1"/>${label(300, 540, 200, 86, c, b, l, s)}`,
  can: (c, b, l, s) => `<rect x="326" y="300" width="148" height="340" rx="22" fill="url(#body)"/>${shine(344, 324, 280)}
    <rect x="336" y="270" width="128" height="40" rx="18" fill="url(#cap)"/><rect x="384" y="244" width="32" height="30" rx="6" fill="url(#cap)"/><rect x="414" y="250" width="20" height="10" rx="3" fill="url(#cap)"/>${label(340, 420, 120, 150, c, b, l, s)}`,
};
const colorsOf = (p, art) => ({ ...PALETTES[p.brand], ...Object.fromEntries(['body', 'cap', 'label', 'ink'].filter(k => art[k]).map(k => [k, art[k]])) });
// 商品の絵の部品：defs（グラデーション）と、床（y=646）・中心（x=400）を基準にした形
function productPart(p, art, id) {
  const c = colorsOf(p, art);
  return {
    defs: `<linearGradient id="${id}-body" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c.body[1]}"/><stop offset=".42" stop-color="${c.body[0]}"/><stop offset="1" stop-color="${c.body[1]}"/></linearGradient>
    <linearGradient id="${id}-cap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c.cap[1]}"/><stop offset=".45" stop-color="${c.cap[0]}"/><stop offset="1" stop-color="${c.cap[1]}"/></linearGradient>`,
    body: SHAPES[art.shape](c, p.brand, art.line, p.size).replaceAll('url(#body)', `url(#${id}-body)`).replaceAll('url(#cap)', `url(#${id}-cap)`),
  };
}
// (cx, floor) に、大きさ scale で商品を置く（影つき）
const place = (part, cx, floor, scale) => `<g transform="translate(${cx} ${floor}) scale(${scale}) translate(-400 -646)"><ellipse cx="400" cy="646" rx="150" ry="14" fill="#000" opacity=".22" filter="url(#soft)"/>${part.body}</g>`;
// ブランドごとの撮影の雰囲気：背景・後ろの光・台・葉の色。dark は暗い背景
const SCENES = {
  'SENA PROFESSIONAL': { bg: ['#e3ece6', '#b7cdc0'], sun: '#f7faf8', podium: ['#faf8f3', '#d6d1c4'], leaf: '#7e9e8d', dark: false },
  'SENA BOTANICAL': { bg: ['#3b2a1f', '#6e4a2c'], sun: '#e3b77a', podium: ['#f1e7d7', '#c9b495'], leaf: '#b7894f', dark: true },
  'MIZUHA': { bg: ['#1c2b4a', '#36507f'], sun: '#e6ecf6', podium: ['#f3f5f9', '#c9d2e1'], leaf: '#c8435a', dark: true },
  'CALMÉ SCALP': { bg: ['#d3ebe6', '#8ec3b9'], sun: '#f7fcfb', podium: ['#ffffff', '#cfe3df'], leaf: '#3e8f84', dark: false },
  'NOIR ATELIER': { bg: ['#171615', '#3a3633'], sun: '#c7ad74', podium: ['#34312e', '#141312'], leaf: '#a88f5a', dark: true },
  'HARU ORGANICS': { bg: ['#f0e3d3', '#d6bb9d'], sun: '#fcf5ec', podium: ['#fcf8f2', '#e0cfba'], leaf: '#7f8f52', dark: false },
  'IRODORI COLOR': { bg: ['#2b2140', '#5c4688'], sun: '#efe3fb', podium: ['#f7f2fc', '#d6cae9'], leaf: '#e59ab6', dark: true },
};
const leaf = (x, y, s, r, color, o) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})" opacity="${o}"><path d="M0 0 C40 -48 124 -48 166 0 C124 48 40 48 0 0 Z" fill="${color}"/><path d="M10 0 H154" stroke="#fff" stroke-opacity=".28" stroke-width="2.5"/></g>`;
const podium = (cx, top, w, h, sc) => `<rect x="${cx - w / 2}" y="${top}" width="${w}" height="${h}" fill="url(#pod)"/><ellipse cx="${cx}" cy="${top + h}" rx="${w / 2}" ry="${w * 0.08}" fill="url(#pod)"/><ellipse cx="${cx}" cy="${top}" rx="${w / 2}" ry="${w * 0.08}" fill="${sc.podium[0]}"/>`;
const sceneDefs = sc => `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sc.bg[0]}"/><stop offset="1" stop-color="${sc.bg[1]}"/></linearGradient>
    <linearGradient id="pod" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${sc.podium[1]}"/><stop offset=".45" stop-color="${sc.podium[0]}"/><stop offset="1" stop-color="${sc.podium[1]}"/></linearGradient>
    <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${sc.sun}" stop-opacity="${sc.dark ? '.55' : '.95'}"/><stop offset="1" stop-color="${sc.sun}" stop-opacity="0"/></radialGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${sc.dark ? '.10' : '.35'}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="soft" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="12"/></filter>`;
// ブランド：横長（1600×900）。ブランドの商品を3つ、高さの違う台に並べる。
// wide は商品一覧の上に出す大きな絵（2400×900）。左側に紹介文を重ねるので、商品を右に寄せて左を空ける
function brandScene(name, items, wide = false) {
  const sc = SCENES[name], parts = items.map((p, i) => productPart(p, ART[p.id], `b${i}`)), W = wide ? 2400 : 1600, dx = wide ? 720 : 0;
  const slots = [[800, 570, 320, 230, 1.0], [460, 650, 270, 150, 0.84], [1140, 680, 260, 120, 0.8]];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 900" role="img" aria-label="${esc(name)}">
  <defs>${sceneDefs(sc)}${parts.map(x => x.defs).join('')}</defs>
  <rect width="${W}" height="900" fill="url(#bg)"/>
  <circle cx="${820 + dx}" cy="400" r="430" fill="url(#sun)"/>
  <polygon points="${980 + dx},0 ${1260 + dx},0 ${760 + dx},900 ${480 + dx},900" fill="url(#beam)"/>
  ${leaf(1060 + dx, 330, 1.5, -28, sc.leaf, 0.55)}${leaf(560 + dx, 420, 1.2, 205, sc.leaf, 0.45)}${leaf(1240 + dx, 520, 0.9, 18, sc.leaf, 0.35)}
  ${wide ? '' : `<text x="70" y="860" font-family="Georgia,'Times New Roman',serif" font-size="150" letter-spacing="18" fill="${sc.dark ? '#fff' : '#000'}" opacity=".06">${esc(name.split(' ')[0])}</text>`}
  ${parts.map((part, i) => { const [cx, top, w, h, s] = slots[i]; return podium(cx + dx, top, w, h, sc) + place(part, cx + dx, top, s); }).join('')}
</svg>
`;
}
// おすすめ：縦長（1200×1500）。1つの商品を、後ろから光の当たる台に置く
function featureScene(p) {
  const sc = SCENES[p.brand], part = productPart(p, ART[p.id], 'f');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1500" role="img" aria-label="${esc(p.brand)} ${esc(p.name)}">
  <defs>${sceneDefs(sc)}${part.defs}</defs>
  <rect width="1200" height="1500" fill="url(#bg)"/>
  <circle cx="600" cy="700" r="560" fill="url(#sun)"/>
  <polygon points="760,0 1060,0 520,1500 220,1500" fill="url(#beam)"/>
  ${leaf(700, 560, 2.3, -32, sc.leaf, 0.55)}${leaf(380, 760, 1.8, 200, sc.leaf, 0.45)}${leaf(860, 900, 1.3, 12, sc.leaf, 0.35)}${leaf(250, 1180, 1.1, 160, sc.leaf, 0.3)}
  ${podium(600, 960, 560, 300, sc)}${place(part, 600, 960, ['jar', 'tin'].includes(ART[p.id].shape) ? 1.8 : 1.36)}
</svg>
`;
}
function svg(p, art) {
  const c = colorsOf(p, art);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" role="img" aria-label="${esc(p.brand)} ${esc(p.name)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.bg[0]}"/><stop offset="1" stop-color="${c.bg[1]}"/></linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c.body[1]}"/><stop offset=".42" stop-color="${c.body[0]}"/><stop offset="1" stop-color="${c.body[1]}"/></linearGradient>
    <linearGradient id="cap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c.cap[1]}"/><stop offset=".45" stop-color="${c.cap[0]}"/><stop offset="1" stop-color="${c.cap[1]}"/></linearGradient>
    <filter id="soft" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="12"/></filter>
  </defs>
  <rect width="800" height="800" fill="url(#bg)"/>
  <g transform="translate(400 690) scale(1.3) translate(-400 -646)">
  <ellipse cx="400" cy="646" rx="170" ry="16" fill="#000" opacity=".16" filter="url(#soft)"/>
  ${SHAPES[art.shape](c, p.brand, art.line, p.size)}
  </g>
</svg>
`;
}

await mkdir(out, { recursive: true });
let count = 0;
for (const p of products) {
  const m = /^products\/([\w-]+)\.svg$/.exec(p.image || ''); if (!m) continue;
  const art = ART[p.id]; if (!art) throw Error(`絵の設定がありません：${p.id}`);
  await writeFile(path.join(out, `${m[1]}.svg`), svg(p, art)); count++;
}
console.log(`商品のイラストを ${count} 点作りました（dist/assets/products/）。`);
// ブランドの絵：形の違う商品を優先して3つ選ぶ
await mkdir(path.join(root, 'dist', 'assets', 'brands'), { recursive: true });
for (const [name, info] of Object.entries(BRANDS)) {
  if (!info.image) continue;
  const mine = products.filter(p => p.brand === name && ART[p.id]), picked = [];
  for (const p of mine) if (picked.length < 3 && !picked.some(x => ART[x.id].shape === ART[p.id].shape)) picked.push(p);
  for (const p of mine) if (picked.length < 3 && !picked.includes(p)) picked.push(p);
  if (!picked.length) throw Error(`ブランドの絵に使う商品がありません：${name}`);
  await writeFile(path.join(root, 'dist', 'assets', info.image), brandScene(name, picked));
  if (info.hero) await writeFile(path.join(root, 'dist', 'assets', info.hero), brandScene(name, picked, true));
}
await mkdir(path.join(root, 'dist', 'assets', 'features'), { recursive: true });
for (const f of FEATURES) {
  const p = products.find(x => x.id === f.product); if (!p || !ART[p.id]) throw Error(`おすすめの商品がありません：${f.product}`);
  await writeFile(path.join(root, 'dist', 'assets', f.image), featureScene(p));
}
console.log(`ブランドの絵を ${Object.values(BRANDS).filter(b => b.image).length} 点（一覧の上の大きな絵 ${Object.values(BRANDS).filter(b => b.hero).length} 点）、おすすめの絵を ${FEATURES.length} 点作りました。`);
