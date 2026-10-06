// 顧客データの扱い：お客様の情報は担当サロンのもの。本部は店舗ごとの集計値と、個人を特定できない会員番号だけを扱う。
// ディーラーは発送に必要なお名前・お届け先だけを受け取る。ブラウザ版・DB版・画面で共有する。
export const PRIVACY_VERSION = '2026-10';
export const privacyPolicy = [
  ['お客様情報の管理者', 'お名前・連絡先・購入履歴などの会員情報は、ご利用のサロン（担当店舗）が管理します。'],
  ['運営本部が扱う情報', '運営本部はシステムの運営のために情報をお預かりしますが、本部の管理画面には個人を特定できる情報を表示せず、店舗ごとの会員数や購入件数などの集計値だけを扱います。'],
  ['配送のための提供', '商品をお届けするため、お名前とお届け先を配送を担当する事業者（ディーラー）にお伝えします。メールアドレスや電話番号はお伝えしません。'],
  ['LINE連携', 'LINEと連携した場合は、LINEのユーザー識別子を保存し、ご注文や配送のお知らせに使います。'],
  ['担当サロンの変更・お問い合わせ', '担当サロンの変更や会員情報についてのご相談は、ご利用のサロンまたは運営本部にご連絡ください。その際は会員番号をお伝えください。'],
];
// 会員番号（本部やサロンとのやり取りに使う、個人を特定しない番号）
export const memberRef = id => 'M-' + String(id || '').replace(/[^0-9a-zA-Z]/g, '').slice(-8).toUpperCase();
// 操作履歴に残す名前：管理アカウントは名前、お客様は会員番号（本部の画面に氏名を残さない）
export const actorLabel = actor => actor?.role ? actor.name : actor?.id ? `会員 ${memberRef(actor.id)}` : (actor?.name || '会員');
// 役割ごとのお届け先情報：サロンは全項目、ディーラーは発送に必要な項目だけ、本部は会員番号だけ
export function customerFor(role, customer, memberId) {
  if (role === 'salon') return customer;
  if (role === 'dealer') return { name: customer.name, postal: customer.postal, address: customer.address };
  return { name: `会員 ${memberRef(memberId)}`, ref: memberRef(memberId), postal: '', address: '', email: '' };
}
// 本部向けの注文：お客様情報を会員番号に置き換え、内部IDも外す
export function orderForRole(role, order) {
  if (role === 'salon') return { ...order, customerRef: memberRef(order.memberId) };
  const { memberId, ...rest } = order;
  return { ...rest, customerRef: memberRef(memberId), customer: customerFor(role, order.customer, memberId) };
}
// 店舗ごとの会員の集計（本部が見る値）
export function summarizeCustomers(salons, members, orders, month) {
  return salons.map(s => {
    const own = members.filter(m => m.salonId === s.id), counts = new Map();
    for (const o of orders) if (o.salonId === s.id && !['cancelled', 'returned'].includes(o.status)) counts.set(o.memberId, (counts.get(o.memberId) || 0) + 1);
    const purchasers = counts.size, repeaters = [...counts.values()].filter(n => n >= 2).length;
    return { salonId: s.id, salonName: s.name, members: own.length, lineLinked: own.filter(m => m.lineLinked).length, newThisMonth: own.filter(m => m.joinedMonth === month).length, purchasers, repeaters, repeatRate: purchasers ? Math.round(repeaters / purchasers * 1000) / 10 : 0 };
  });
}
export function privacyConsent(input) { if (input?.agreePrivacy !== true) throw Object.assign(new Error('お客様情報の取り扱いへの同意が必要です。'), { status: 400 }); return { version: PRIVACY_VERSION }; }
