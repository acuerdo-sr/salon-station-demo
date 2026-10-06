// 出荷指示CSV（仕様書 2.5 RP-004「出荷指示CSV：佐川急便連携用」）。ブラウザ版・DB版・管理画面で共有する。
// 佐川急便の送り状発行システム「e飛伝Ⅲ」に取り込む前提の列構成。列の並びと文字数の上限は、
// e飛伝Ⅲ の「取込レイアウト登録」で合わせる（住所は既定で1列16文字ずつ、3列に分けて出力する）。
export const SHIPPING_COLUMNS = ['お客様管理番号', 'お届け先電話番号', 'お届け先郵便番号', 'お届け先住所1', 'お届け先住所2', 'お届け先住所3', 'お届け先名称1', 'お届け先名称2',
  'ご依頼主電話番号', 'ご依頼主郵便番号', 'ご依頼主住所1', 'ご依頼主住所2', 'ご依頼主名称1', '品名1', '品名2', '品名3', '品名4', '品名5', '出荷個数', '便種', '記事'];
export const ADDRESS_FIELD_LENGTH = 16;
export const SERVICE = '飛脚宅配便';

// 文字列を size 文字ずつ parts 列に分ける（入りきらない分は最後の列に続ける）
export function splitText(value, size = ADDRESS_FIELD_LENGTH, parts = 3) {
  const chars = [...String(value || '').trim()], out = [];
  for (let i = 0; i < parts; i++) out.push(i === parts - 1 ? chars.slice(i * size).join('') : chars.slice(i * size, (i + 1) * size).join(''));
  return out;
}
const digits = value => String(value || '').replace(/[^0-9]/g, '');
const phone = value => String(value || '').replace(/[^0-9-]/g, '');
// 品名は5行まで。6品目以上は5行目に「ほかN点」とまとめる
function itemLines(items) {
  const lines = items.map(i => `${i.name} ×${i.quantity}`);
  return Array.from({ length: 5 }, (_, i) => i < 4 || lines.length <= 5 ? (lines[i] || '') : `${lines[4]} ほか${lines.length - 5}点`);
}
// to / from：{ name, postal, address, phone }
export function shippingRow({ reference, to, from, items, note = '' }) {
  return [reference, phone(to.phone), digits(to.postal), ...splitText(to.address), to.name, '',
    phone(from.phone), digits(from.postal), ...splitText(from.address, ADDRESS_FIELD_LENGTH, 2), from.name, ...itemLines(items), 1, SERVICE, note];
}
export const shippingFileName = (kind, today) => `出荷指示_${kind === 'supplyOrders' ? '加盟店発注' : 'EC注文'}_${today.replaceAll('-', '')}.csv`;
// 出荷前（受付待ち・出荷準備中）のものだけを出力する
export const SHIPPABLE = ['pending', 'accepted'];
export const SUPPLY_SHIPPABLE = ['ordered', 'accepted'];
export function shippingInput(input) {
  const kind = input?.kind === 'supplyOrders' ? 'supplyOrders' : input?.kind === 'purchaseOrders' ? 'purchaseOrders' : null;
  const ids = Array.isArray(input?.ids) ? [...new Set(input.ids.filter(id => typeof id === 'string' && id.length <= 80))] : null;
  if (!kind || !ids || !ids.length || ids.length > 1000) { const e = new Error('出荷指示を出す発注を選んでください。'); e.status = 400; throw e; }
  return { kind, ids };
}
