// 月次請求書の表示・CSV。適格請求書の記載事項（発行者名と登録番号、取引年月日、内容、税率ごとの合計と消費税額、宛名）を含める。
import { esc, money, downloadCSV } from './ui-kit.js?v=52a35508c0';

const day = value => String(value || '').slice(0, 10).replaceAll('-', '/');
const monthLabel = month => { const [y, m] = String(month).split('-'); return `${y}年${Number(m)}月`; };

export function invoiceHtml(inv) {
  const lines = inv.orders.flatMap(o => [
    ...o.items.map(i => `<tr><td>${day(o.orderedOn)}</td><td>${esc(o.id)}</td><td>${esc(i.name)}<small>${esc(i.size || '')}</small></td><td class="num">${i.quantity}</td><td class="num">${money(i.unitPrice)}</td><td class="num">${money(i.amount)}</td></tr>`),
    ...(o.shipping ? [`<tr><td>${day(o.orderedOn)}</td><td>${esc(o.id)}</td><td>送料</td><td class="num">1</td><td class="num">${money(o.shipping)}</td><td class="num">${money(o.shipping)}</td></tr>`] : []),
  ]).join('');
  return `<article class="invoice-sheet" aria-label="請求書 ${esc(inv.id)}">
    <header class="invoice-head"><div><h3>請求書</h3><p class="invoice-to"><strong>${esc(inv.billTo.name)} 御中</strong><br>${esc(inv.salonName)}<br>${esc(inv.billTo.address)}</p></div>
      <dl class="invoice-meta"><dt>請求番号</dt><dd>${esc(inv.id)}</dd><dt>発行日</dt><dd>${day(inv.issuedOn)}</dd><dt>対象期間</dt><dd>${monthLabel(inv.month)}分（月末締め）</dd><dt>お支払期限</dt><dd>${day(inv.dueOn)}</dd></dl></header>
    <div class="invoice-issuer"><strong>${esc(inv.issuer.name)}</strong><br>${esc(inv.issuer.address)}<br>登録番号：${esc(inv.issuer.registrationNumber)}</div>
    <p class="invoice-total">ご請求金額（税込）<strong>${money(inv.total)}</strong></p>
    <div class="table-wrap"><table class="invoice-lines"><thead><tr><th>発注日</th><th>発注番号</th><th>品目</th><th class="num">数量</th><th class="num">単価（税込）</th><th class="num">金額（税込）</th></tr></thead><tbody>${lines}</tbody></table></div>
    <dl class="invoice-sum"><dt>10%対象（税込）</dt><dd>${money(inv.total)}</dd><dt>うち消費税（10%）</dt><dd>${money(inv.taxTotal)}</dd><dt>合計</dt><dd><strong>${money(inv.total)}</strong></dd></dl>
    <p class="invoice-note">お振込先：${esc(inv.issuer.bank)}<br>振込手数料はご負担ください。発注${inv.orderCount}件分をまとめてご請求しています。</p>
    ${inv.ecProceeds ? `<p class="invoice-note subtle-note">参考：同じ月の店販ECでサロンが受け取る見込み額は ${money(inv.ecProceeds)} です（この請求とは別に精算します）。</p>` : ''}
    ${inv.status === 'paid' ? `<p class="invoice-paid">入金確認済み（${day(inv.paidAt)}）</p>` : ''}
  </article>`;
}
export function downloadInvoiceCsv(inv) {
  const rows = inv.orders.flatMap(o => [...o.items.map(i => [inv.id, inv.month, inv.salonName, o.orderedOn, o.id, i.sku, i.name, i.quantity, i.unitPrice, i.amount, '10%']), ...(o.shipping ? [[inv.id, inv.month, inv.salonName, o.orderedOn, o.id, '', '送料', 1, o.shipping, o.shipping, '10%']] : [])]);
  downloadCSV(`請求書_${inv.id}.csv`, ['請求番号', '対象月', '加盟店', '発注日', '発注番号', 'SKU', '品目', '数量', '単価（税込）', '金額（税込）', '税率'], [...rows, [inv.id, inv.month, inv.salonName, '', '', '', '合計（うち消費税 ' + inv.taxTotal + '円）', '', '', inv.total, '']]);
}
export const invoiceStatusLabels = { issued: '請求済み・入金待ち', paid: '入金済み' };
