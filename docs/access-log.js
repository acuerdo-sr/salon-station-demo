// お客様の個人情報へのアクセス記録。ブラウザ版（platform-core.js）と DB版（db/platform-store.mjs）、管理画面で共有する。
// 記録するのは「誰が・いつ・どの店舗のお客様の情報を・何件・何のために」で、氏名や住所などの値そのものは記録しない。
// 記録の対象：個人情報を含む画面データの受け取り（表示）、CSV出力、保守ツールでの参照（復号）。
// DBを直接開いても読めるよう、役割・操作・対象・経路は日本語で保存する。
export const ACCESS_VIEW_INTERVAL_MS = 30 * 60 * 1000;
export const ACCESS_LOG_LIMIT = 300;
export const accessActions = { view: '表示', export: 'CSV出力', lookup: '保守ツールで参照' };
export const accessRoles = { admin: '運営本部', salon: '美容室', dealer: 'ディーラー', maintenance: 'DB保守' };
export const accessChannels = { console: '管理画面', maintenance: '保守ツール' };
export const accessTargets = {
  salonCustomers: '会員一覧・注文のお客様情報',
  shipping: '発送先（お名前・郵便番号・住所）',
  ordersCsv: '受注一覧（お客様名）',
  membersCsv: '会員一覧（全項目）',
  member: '会員情報（暗号化を解除して参照）',
};
const exportTargets = { orders: 'ordersCsv', members: 'membersCsv' };

// 役割ごとに見られる範囲（管理画面の「アクセス記録」に表示する）
export const accessScopes = [
  ['担当サロン', '自店のお客様の氏名・メール・電話・お届け先・購入履歴。会員一覧と受注を開くと記録します。'],
  ['運営本部', '店舗ごとの集計値と会員番号だけ。個人情報は受け取らないため記録の対象外です。'],
  ['ディーラー', '発送に必要なお名前・郵便番号・お届け先だけ。発注一覧を開くと、店舗ごとに記録します。'],
  ['DBの保守担当', 'お客様の個人情報は暗号化された値しか見えません。復号できるのは保守ツールだけで、目的を入力して1件ずつ参照し、必ず記録します。'],
];

// 管理画面のデータに含めた個人情報を、店舗ごとの「表示」の記録にまとめる。
// members：サロンの会員ID、orders / shipments：{ salonId, memberId }
export function viewEntries(op, { members = [], orders = [], shipments = [] }) {
  if (op.role === 'salon') {
    const ids = new Set([...members, ...orders.map(o => o.memberId)]);
    return ids.size ? [{ salonId: op.salonId, target: accessTargets.salonCustomers, count: ids.size }] : [];
  }
  if (op.role === 'dealer') {
    const bySalon = new Map();
    for (const s of shipments) { if (!bySalon.has(s.salonId)) bySalon.set(s.salonId, new Set()); bySalon.get(s.salonId).add(s.memberId); }
    return [...bySalon.keys()].sort().map(salonId => ({ salonId, target: accessTargets.shipping, count: bySalon.get(salonId).size }));
  }
  return [];
}
// 管理画面は15秒ごとに再読み込みするため、同じ担当者・同じ対象・同じ件数の表示は30分に1回だけ記録する
export const shouldRecordView = (last, entry, now) => !last || Number(last.count) !== entry.count || Date.parse(now) - Date.parse(last.at) >= ACCESS_VIEW_INTERVAL_MS;

// CSV出力の記録。出力する行のIDを受け取り、担当店舗の範囲内であることを確認してから件数を記録する。
export function exportInput(input) {
  const target = accessTargets[exportTargets[input?.kind]];
  if (!target) { const e = new Error('出力する一覧を確認してください。'); e.status = 400; throw e; }
  const ids = input.ids;
  if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !id || id.length > 80)) { const e = new Error('出力する対象を確認してください。'); e.status = 400; throw e; }
  return { kind: input.kind, target, ids: [...new Set(ids)] };
}
// 保守ツールでの参照：担当者名と目的は必須
export function lookupInput({ ref, by, purpose } = {}) {
  const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : null;
  const r = text(ref, 3, 20), b = text(by, 1, 60), p = text(purpose, 4, 200);
  if (!r || !b || !p) { const e = new Error('会員番号・担当者名・目的（4文字以上）を指定してください。'); e.status = 400; throw e; }
  return { ref: r.toUpperCase(), by: b, purpose: p };
}

// 記録を見られる範囲：本部はすべて、美容室は自店のお客様に関する記録、ディーラーは自分の記録
export const accessLogVisible = (op, row) => op.role === 'admin' || (op.role === 'salon' ? row.salonId === op.salonId : row.actorId === (op.id || ''));
// 画面に渡す形。接続元のIPアドレスは本部にだけ渡す。
export function accessLogView(op, row) {
  const { actorId, ip, ...rest } = row;
  return op.role === 'admin' ? { ...rest, actorId, ip } : rest;
}
