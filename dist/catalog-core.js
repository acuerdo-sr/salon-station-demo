// 商品とカテゴリの登録・編集（仕様書 2.1.1 商品管理：商品登録・編集、カテゴリ管理）。ブラウザ版・DB版・管理画面で共有する。
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const text = (value, max, label, need = false) => {
  const v = value == null ? '' : String(value).trim();
  if ((need && !v) || v.length > max) fail(`${label}を${need ? '入力し、' : ''}${max}文字以内にしてください。`);
  return v;
};
const int = (value, min, max, label) => { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) fail(`${label}は${min}〜${max}の整数で入力してください。`); return n; };

// 画像：JPEG・PNG・WebP。サーバー版はファイルに保存し、公開デモはブラウザ内に保存するため小さめに制限する
export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 1536 * 1024;
export const MAX_DEMO_IMAGE_BYTES = 400 * 1024;
const MAGIC = { jpg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, png: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, webp: b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 };
// data URL（data:image/jpeg;base64,...）を確かめて { type, ext, bytes } を返す。中身の先頭バイトで形式を確認する
export function decodeImage(dataUrl, maxBytes = MAX_IMAGE_BYTES) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) fail('画像は JPEG・PNG・WebP を選んでください。');
  let binary;
  try { binary = atob(match[2]); } catch { fail('画像を読み込めません。'); }
  if (binary.length > maxBytes) fail(`画像は${Math.floor(maxBytes / 1024)}KB以下にしてください。`);
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0)), ext = IMAGE_TYPES[match[1]];
  if (bytes.length < 12 || !MAGIC[ext](bytes)) fail('画像の形式が正しくありません。');
  return { type: match[1], ext, bytes };
}

export function categoryInput(input) { return { name: text(input?.name, 30, 'カテゴリ名', true) }; }

// 価格（税込）。仕入単価・卸価格は売価以下
export function priceInput(input) {
  const price = int(input?.price, 1, 1000000, '販売価格'), cost = int(input?.cost, 0, 1000000, '仕入単価'), wholesalePrice = int(input?.wholesalePrice, 0, 1000000, '卸価格');
  if (cost > price) fail('仕入単価は売価以下にしてください。');
  if (wholesalePrice > price) fail('卸価格は売価以下にしてください。');
  return { price, cost, wholesalePrice };
}

// 商品の入力。categories / dealers は登録済みのもの、concernNames は「お悩み」の一覧（名前）。
// 商品コード（SKU）は登録時に自動で付ける（nextSku）ため、入力からは受け取らない
export function productInput(input, { categories, dealers, concernNames }) {
  const category = categories.find(c => c.id === input?.categoryId) || fail('カテゴリを選んでください。');
  const dealer = dealers.find(d => d.id === input?.dealerId) || fail('出荷するディーラーを選んでください。');
  const concerns = Array.isArray(input?.concerns) ? [...new Set(input.concerns.map(String))] : [];
  if (concerns.some(c => !concernNames.includes(c))) fail('お悩みの指定を確認してください。');
  const { price, cost, wholesalePrice } = priceInput(input);
  if (typeof input?.enabled !== 'boolean') fail('公開設定を確認してください。');
  return {
    brand: text(input?.brand, 100, 'ブランド名', true), name: text(input?.name, 100, '商品名', true), categoryId: category.id, category: category.name, concerns,
    size: text(input?.size, 40, '容量・サイズ'), summary: text(input?.summary, 60, '一覧の説明'), description: text(input?.description, 1000, '商品説明'), tag: text(input?.tag, 20, 'ラベル'),
    price, cost, wholesalePrice, dealerId: dealer.id, stock: int(input?.stock, 0, 99999, '在庫数'), enabled: input.enabled,
  };
}
// 商品コードの自動採番：P-00001 の形。seq はこれまでに付けた番号、skus は登録済みの商品コード（初期データの SN-SH-050 などはそのまま）
const SKU_NUMBER = /^P-(\d+)$/;
export function nextSku(seq, skus) {
  const used = new Set(skus);
  let n = Math.max(Number(seq) || 0, ...skus.map(s => Number(SKU_NUMBER.exec(s)?.[1] || 0))) + 1;
  while (used.has('P-' + String(n).padStart(5, '0'))) n++;
  return { sku: 'P-' + String(n).padStart(5, '0'), seq: n };
}

// 価格の一括更新（管理画面の表）。before は画面を開いたときの値で、その後に他の担当者が変えていたら保存しない
export const MAX_PRICE_ROWS = 1000;
const PRICE_KEYS = ['price', 'cost', 'wholesalePrice'], PRICE_NAMES = { price: '売価', cost: '仕入', wholesalePrice: '卸' };
export function priceRowsInput(input) {
  const rows = Array.isArray(input?.items) ? input.items : [];
  if (!rows.length) fail('変更した商品がありません。');
  if (rows.length > MAX_PRICE_ROWS) fail(`一度に保存できるのは${MAX_PRICE_ROWS}件までです。`);
  const ids = rows.map(r => String(r?.id ?? ''));
  if (new Set(ids).size !== ids.length) fail('同じ商品が2回含まれています。');
  return rows.map((r, i) => ({ id: ids[i], before: r?.before && typeof r.before === 'object' ? r.before : null, ...Object.fromEntries(PRICE_KEYS.filter(k => r?.[k] !== undefined).map(k => [k, r[k]])) }));
}
// 1件分の確認。current は登録済みの商品。誤りには「商品コード（商品名）：」を付けて、どの行か分かるようにする
export function applyPriceRow(row, current) {
  const label = `${current.sku}（${current.name}）：`;
  if (row.before && PRICE_KEYS.some(k => Number(row.before[k]) !== current[k])) fail(`${label}他の担当者が価格を変更しました。画面を読み込み直してから、もう一度保存してください。`, 409);
  let next;
  try { next = priceInput({ ...Object.fromEntries(PRICE_KEYS.map(k => [k, current[k]])), ...row }); } catch (error) { error.message = label + error.message; throw error; }
  const changed = PRICE_KEYS.filter(k => next[k] !== current[k]);
  return { ...next, changed, summary: changed.map(k => `${PRICE_NAMES[k]} ${current[k].toLocaleString('ja-JP')}→${next[k].toLocaleString('ja-JP')}`).join(' / ') };
}

// お悩みカテゴリ（仕様書 2.2.8）と、初期データのカテゴリID（表示名は日本語、IDは英字で固定）
export const CONCERN_NAMES = ['ダメージヘア対策', 'エイジングケア', '白髪対策', 'ボリュームアップ', '頭皮ケア', 'カラーケア', 'パーマケア'];
export const CATEGORY_IDS = { シャンプー: 'shampoo', トリートメント: 'treatment', ヘアオイル: 'hair-oil', ヘアマスク: 'hair-mask', 'ヘアミルク・ミスト': 'hair-milk-mist', スカルプケア: 'scalp-care', ヘアスタイリング: 'hair-styling' };
// 初期の品ぞろえの版。2：ダミー商品を30点（7カテゴリ・7ブランド）に増やした
export const CATALOG_VERSION = 3;
// 版3で作り直した初期商品の写真。以前の既定の写真のままの商品だけ、新しい写真に替える（管理画面で替えた写真はそのまま）
export const legacyImages = id => [`products/${id}.svg`, 'shampoo.png', 'treatment.png', 'oil.png'];
export const seedCategories = products => [...new Set(products.map(p => p.category))].map((name, i) => ({ id: CATEGORY_IDS[name] || `category-${i + 1}`, name, sortOrder: i }));
export const newProductId = () => 'p-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
export const newCategoryId = () => 'cat-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
