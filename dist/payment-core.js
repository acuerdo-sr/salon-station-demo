// お支払い（仕様書 2.1.3「決済方法」「支払方法管理」）。お支払いはクレジットカードのみ。ブラウザ版・DB版・画面で共有する。
// 本番は決済代行会社と契約し、カード番号は決済代行のカード入力欄（トークン化）で扱う。EMV 3-Dセキュア（本人認証）も決済代行の機能を使う。
// このシステムはカード番号を受け取らず、トークンとブランド・下4桁・有効期限だけを保存する。
// ここでは決済代行の「テスト環境」を模した動きで、実際の請求は行わない。
export const PAYMENT_METHODS = { card: 'クレジットカード' };
export const MAX_CARDS = 5;
// 支払状態：captured（決済完了）、refunded（返金済み）。pending・voided は以前の版の注文の表示用
export const paymentStatusNames = { pending: '入金待ち', captured: '決済完了', refunded: '返金済み', voided: '取消' };
export const cardBrands = { visa: 'Visa', mastercard: 'Mastercard', jcb: 'JCB', amex: 'American Express' };
export const ORDER_PLACED_LABEL = 'ご注文・カード決済完了（テスト）';

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
export const paymentLabel = (method, status) => `${PAYMENT_METHODS[method] || PAYMENT_METHODS.card}・${paymentStatusNames[status] || status}`;
// キャンセル・返品のときの支払状態：決済済みなら返金、未決済（以前の版の注文）なら取消
export const paymentAfterCancel = status => status === 'captured' ? 'refunded' : 'voided';

// 注文時のお支払い：登録済みカード（cardId）か、新しいカードのトークン（card.token）を使う
export function paymentInput(input) {
  const p = input?.payment ?? { method: 'card' };
  if (p?.method !== 'card') fail('お支払いはクレジットカードのみです。');
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

// ---- 画面側：決済代行のカード入力欄（トークン化）の代わり。公開されているテスト用カード番号だけを受け付け、番号はサーバーに送らない
const TEST_CARDS = { '4242424242424242': ['visa', false], '5555555555554444': ['mastercard', false], '3530111333300000': ['jcb', false], '4000000000000002': ['visa', true] };
export function demoTokenize({ number, expMonth, expYear }) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  const known = TEST_CARDS[digits];
  if (!known) fail('テスト用カード番号（例：4242 4242 4242 4242）を入力してください。実在のカード番号は使えません。');
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return { token: `tok_test_${known[1] ? 'decline_' : ''}${random}`, brand: known[0], last4: digits.slice(-4), expMonth: Number(expMonth), expYear: Number(expYear) };
}
