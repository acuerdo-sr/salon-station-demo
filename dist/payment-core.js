// 決済方法（仕様書 2.1.3「多彩な決済方法」「支払方法管理」）。ブラウザ版・DB版・画面で共有する。
// 本番は決済代行会社と契約し、カード番号は決済代行のカード入力欄（トークン化）で扱う。このシステムはカード番号を受け取らず、
// トークンとブランド・下4桁・有効期限だけを保存する。ここでは決済代行の「テスト環境」を模した動きで、実際の請求は行わない。
export const PAYMENT_METHODS = { card: 'クレジットカード', cod: '代金引換', bank: '銀行振込（前払い）', konbini: 'コンビニ払い（前払い）' };
export const COD_FEE = 330;
export const PAYMENT_DUE_DAYS = { bank: 7, konbini: 3 };
export const MAX_CARDS = 5;
// 支払状態：pending（入金待ち・代引きは配達時）、captured（決済完了）、refunded（返金済み）、voided（取消）
export const paymentStatusNames = { pending: '入金待ち', captured: '決済完了', refunded: '返金済み', voided: '取消' };
export const cardBrands = { visa: 'Visa', mastercard: 'Mastercard', jcb: 'JCB', amex: 'American Express' };
// 振込先（架空）。本番は決済代行のバーチャル口座、または本部の口座に置き換える。
export const BANK_ACCOUNT = 'デモ銀行 本店 普通 0000000 サロンステーション（架空）';

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
export const paymentFeeOf = method => method === 'cod' ? COD_FEE : 0;
export const initialPaymentStatus = method => method === 'card' ? 'captured' : 'pending';
// 入金を確認するまで出荷しない決済方法（前払い）
export const prepaid = method => method === 'bank' || method === 'konbini';
export const orderPlacedLabel = method => ({ card: 'ご注文・カード決済完了（テスト）', cod: 'ご注文を受け付けました（代金引換）', bank: 'ご注文を受け付けました（銀行振込のご入金待ち）', konbini: 'ご注文を受け付けました（コンビニ払いのご入金待ち）' }[method]);
export const COD_SPLIT_MESSAGE = '代金引換は、1か所から発送するご注文でご利用いただけます。ほかのお支払い方法をお選びください。';
// キャンセル・返品のときの支払状態：決済済みなら返金、未入金なら取消
export const paymentAfterCancel = status => status === 'captured' ? 'refunded' : 'voided';
export function paymentLabel(method, status) {
  const name = PAYMENT_METHODS[method] || PAYMENT_METHODS.card;
  if (method === 'cod' && status === 'pending') return `${name}（お届け時にお支払い）`;
  return `${name}・${paymentStatusNames[status] || status}`;
}

// 注文時の支払方法。card は登録済みカード（cardId）か、新しいカードのトークン（card.token）を使う。
export function paymentInput(input) {
  const p = input?.payment ?? { method: 'card' };
  if (!PAYMENT_METHODS[p?.method]) fail('お支払い方法を選んでください。');
  if (p.method !== 'card') return { method: p.method };
  if (typeof p.cardId === 'string' && p.cardId) return { method: 'card', cardId: p.cardId };
  if (p.card) return { method: 'card', card: cardInput(p.card), saveCard: p.saveCard === true };
  // 登録カードもトークンもない場合は、決済代行のテスト決済として扱う（デモ・テスト用）
  return { method: 'card', test: true };
}
// トークン化済みのカード情報（カード番号は含まない）
export function cardInput(card, now = new Date()) {
  const token = String(card?.token || '');
  if (!/^tok_test_[a-z0-9_]{16,64}$/.test(token)) fail('カード情報を確認してください。');
  if (!cardBrands[card.brand] || !/^\d{4}$/.test(String(card.last4 || ''))) fail('カード情報を確認してください。');
  const month = Number(card.expMonth), year = Number(card.expYear);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) fail('有効期限を確認してください。');
  if (year * 12 + month < now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) fail('有効期限が切れています。');
  return { token, brand: card.brand, last4: String(card.last4), expMonth: month, expYear: year };
}
// 決済代行のテスト環境を模した与信・売上確定。「承認されないカード」のトークンは失敗する。
export function testCharge(token, amount) {
  if (String(token).includes('_decline_')) fail('カードが承認されませんでした。別のカードをお使いください。', 402);
  if (!Number.isInteger(amount) || amount <= 0) fail('お支払い金額を確認してください。');
  return { provider: 'test', id: 'test_ch_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20) };
}
// 前払い（銀行振込・コンビニ払い）のお支払い番号と期限（日本時間の日付）
export function paymentInstructions(method, orderId, now) {
  if (!prepaid(method)) return { reference: '', dueOn: '' };
  const due = new Date(Date.parse(now) + 9 * 3600000 + PAYMENT_DUE_DAYS[method] * 86400000).toISOString().slice(0, 10);
  const reference = method === 'konbini' ? 'KB' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0') : orderId.replace(/[^0-9A-Z]/g, '').slice(-8);
  return { reference, dueOn: due };
}

// ---- 画面側：決済代行のカード入力欄（トークン化）の代わり。公開されているテスト用カード番号だけを受け付け、番号はサーバーに送らない
const TEST_CARDS = { '4242424242424242': ['visa', false], '5555555555554444': ['mastercard', false], '3530111333300000': ['jcb', false], '4000000000000002': ['visa', true] };
export function demoTokenize({ number, expMonth, expYear }) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  const known = TEST_CARDS[digits];
  if (!known) fail('テスト用カード番号（例：4242 4242 4242 4242）を入力してください。実在のカード番号は使えません。');
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return { token: `tok_test_${known[1] ? 'decline_' : ''}${random}`, brand: known[0], last4: digits.slice(-4), expMonth: Number(expMonth), expYear: Number(expYear) };
}
