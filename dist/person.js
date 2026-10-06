// お客様の個人情報の入力ルール（会員・お届け先・注文で共通）。入力の揺れをなくすため、項目を分けて形式を決める。
// ・お名前：姓と名（各20文字以内、数字・記号は不可）。保存は「姓 名」（半角スペース1つで区切る）
// ・フリガナ：セイとメイ（全角カタカナ。ひらがな・半角カナはカタカナに直す）。保存は「セイ メイ」
// ・電話番号：数字10〜11桁（0から始まる）。全角・ハイフン・空白は取り除いて数字だけで保存する
// ・郵便番号：数字7桁（ハイフンなしで保存）
// ・住所：都道府県（47から選ぶ）・市区町村・番地・建物名と部屋番号に分ける
export const PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
export const LIMITS = { namePart: 20, city: 30, street: 60, building: 60 };

const fail = message => { const e = new Error(message); e.status = 400; throw e; };
const clean = value => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
// 姓・名：文字（漢字・かな・英字）と「々・ー・'・.・-」だけ。数字・記号・空白は不可
const NAME_PART = /^[\p{L}\p{M}々〆ー・'’.\-]+$/u;
const KANA_PART = /^[ァ-ヶー・]+$/;
const toKatakana = value => clean(value).replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));

function namePart(value, label) {
  const v = clean(value);
  if (!v) fail(`${label}を入力してください。`);
  if ([...v].length > LIMITS.namePart) fail(`${label}は${LIMITS.namePart}文字以内で入力してください。`);
  if (!NAME_PART.test(v)) fail(`${label}に数字・記号・空白は使えません。`);
  return v;
}
function kanaPart(value, label) {
  const v = toKatakana(value);
  if (!v) fail(`${label}を入力してください。`);
  if ([...v].length > LIMITS.namePart) fail(`${label}は${LIMITS.namePart}文字以内で入力してください。`);
  if (!KANA_PART.test(v)) fail(`${label}は全角カタカナで入力してください。`);
  return v;
}
// 「姓 名」の形で受け取る（画面は姓・名の欄を分け、半角スペースでつないで送る）
export function nameInput(value, label = 'お名前') {
  const parts = clean(value).split(/\s+/).filter(Boolean);
  if (parts.length !== 2) fail(`${label}は姓と名を分けて入力してください。`);
  return `${namePart(parts[0], `${label}（姓）`)} ${namePart(parts[1], `${label}（名）`)}`;
}
export function kanaInput(value, label = 'フリガナ') {
  const parts = toKatakana(value).split(/\s+/).filter(Boolean);
  if (parts.length !== 2) fail(`${label}はセイとメイを分けて入力してください。`);
  return `${kanaPart(parts[0], `${label}（セイ）`)} ${kanaPart(parts[1], `${label}（メイ）`)}`;
}
export const splitName = value => { const [last = '', ...rest] = String(value || '').trim().split(/\s+/); return { last, first: rest.join(' ') }; };
export const isCompleteName = value => { try { nameInput(value); return true; } catch { return false; } };
export const isCompleteKana = value => { try { kanaInput(value); return true; } catch { return false; } };

export function phoneInput(value, { required = false } = {}) {
  const v = clean(value).replace(/[\s\-‐−ー()（）]/g, '');
  if (!v) { if (required) fail('電話番号を入力してください。'); return ''; }
  if (!/^0\d{9,10}$/.test(v)) fail('電話番号は0から始まる10〜11桁の数字で入力してください。');
  return v;
}
// 携帯電話（070・080・090）は 090-1234-5678 の形で表示する。そのほかは数字のまま
export const formatPhone = value => /^0[789]0\d{8}$/.test(String(value || '')) ? `${value.slice(0, 3)}-${value.slice(3, 7)}-${value.slice(7)}` : String(value || '');
export function postalInput(value) {
  const v = clean(value).replace(/[\s\-‐−ー]/g, '');
  if (!/^\d{7}$/.test(v)) fail('郵便番号は7桁の数字で入力してください。');
  return v;
}
export const formatPostal = value => /^\d{7}$/.test(String(value || '')) ? `${value.slice(0, 3)}-${value.slice(3)}` : String(value || '');

const textPart = (value, label, max, required) => {
  const v = clean(value);
  if (!v) { if (required) fail(`${label}を入力してください。`); return ''; }
  if ([...v].length > max) fail(`${label}は${max}文字以内で入力してください。`);
  if (/[<>]/.test(v)) fail(`${label}に「<」「>」は使えません。`);
  return v;
};
export function addressPartsInput(input) {
  const prefecture = clean(input?.prefecture);
  if (!PREFECTURES.includes(prefecture)) fail('都道府県を選んでください。');
  const city = textPart(input?.city, '市区町村', LIMITS.city, true);
  // 番地：ハイフンの表記揺れ（−・ー・‐ など）を「-」にそろえる。番地には数字が必要
  const street = textPart(input?.street, '番地', LIMITS.street, true).replace(/[‐‑‒–—―−ーｰ]/g, (ch, i, s) => /\d/.test(s[i - 1] || '') ? '-' : ch);
  if (!/[0-9一二三四五六七八九十〇]/.test(street)) fail('番地を入力してください（例：1-2-3）。');
  return { prefecture, city, street, building: textPart(input?.building, '建物名・部屋番号', LIMITS.building, false) };
}
export const formatAddress = a => a ? `${a.prefecture || ''}${a.city || ''}${a.street || ''}${a.building ? ` ${a.building}` : ''}` : '';
// DBの住所の列（暗号化）には、項目を分けたまま JSON で保存する。以前の版の住所（1つの文字列）もそのまま読める
export const encodeAddress = a => JSON.stringify({ prefecture: a.prefecture, city: a.city, street: a.street, building: a.building || '' });
export function decodeAddress(value) {
  const text = String(value ?? '');
  if (text.startsWith('{')) { try { const a = JSON.parse(text); const parts = { prefecture: a.prefecture || '', city: a.city || '', street: a.street || '', building: a.building || '' }; return { ...parts, address: formatAddress(parts) }; } catch {} }
  const prefecture = PREFECTURES.find(p => text.startsWith(p)) || '';
  return { prefecture, city: '', street: text.slice(prefecture.length), building: '', address: text };
}
