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

// 商品の入力。categories / dealers は登録済みのもの、concernNames は「お悩み」の一覧（名前）
export function productInput(input, { categories, dealers, concernNames }) {
  const sku = text(input?.sku, 30, '商品コード（SKU）', true).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,29}$/.test(sku)) fail('商品コード（SKU）は英数字とハイフンで3〜30文字にしてください。');
  const category = categories.find(c => c.id === input?.categoryId) || fail('カテゴリを選んでください。');
  const dealer = dealers.find(d => d.id === input?.dealerId) || fail('出荷するディーラーを選んでください。');
  const concerns = Array.isArray(input?.concerns) ? [...new Set(input.concerns.map(String))] : [];
  if (concerns.some(c => !concernNames.includes(c))) fail('お悩みの指定を確認してください。');
  const price = int(input?.price, 1, 1000000, '販売価格'), cost = int(input?.cost, 0, 1000000, '仕入単価'), wholesalePrice = int(input?.wholesalePrice, 0, 1000000, '卸価格');
  if (cost > price) fail('仕入単価は売価以下にしてください。');
  if (wholesalePrice > price) fail('卸価格は売価以下にしてください。');
  if (typeof input?.enabled !== 'boolean') fail('公開設定を確認してください。');
  return {
    sku, brand: text(input?.brand, 100, 'ブランド名', true), name: text(input?.name, 100, '商品名', true), categoryId: category.id, category: category.name, concerns,
    size: text(input?.size, 40, '容量・サイズ'), description: text(input?.description, 1000, '商品説明'), tag: text(input?.tag, 20, 'ラベル'),
    price, cost, wholesalePrice, dealerId: dealer.id, stock: int(input?.stock, 0, 99999, '在庫数'), enabled: input.enabled,
  };
}
// お悩みカテゴリ（仕様書 2.2.8）と、初期データのカテゴリID（表示名は日本語、IDは英字で固定）
export const CONCERN_NAMES = ['ダメージヘア対策', 'エイジングケア', '白髪対策', 'ボリュームアップ', '頭皮ケア', 'カラーケア', 'パーマケア'];
export const CATEGORY_IDS = { シャンプー: 'shampoo', トリートメント: 'treatment', ヘアオイル: 'hair-oil' };
export const seedCategories = products => [...new Set(products.map(p => p.category))].map((name, i) => ({ id: CATEGORY_IDS[name] || `category-${i + 1}`, name, sortOrder: i }));
export const newProductId = () => 'p-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
export const newCategoryId = () => 'cat-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
