// 加盟店（サロン）の発注画面。スマートフォンと LINE ミニアプリで使う前提の1画面。
import { platform, isPages } from './platform-client.js';
import { supplyStatuses, supplySources, supplyIntervals, addDays } from './supply-core.js';
import { DEMO_OPERATOR_PASSWORD } from './platform-core.js';
import { $, esc, money, date, icon, badge, toast, modal, closeModal, empty, formError } from './ui-kit.js';
import { lineConfig, liffIdToken } from './line-login.js';
import { invoiceHtml, downloadInvoiceCsv, invoiceStatusLabels } from './invoice-view.js';

let operator = null, ws = null, tab = 'order', cart = {}, cartSource = 'manual', requestKey = null, busy = false, line = { enabled: false, orderLiffId: '' }, lineToken = null;
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const productOf = id => ws.products.find(p => p.id === id);
const cartLines = () => Object.entries(cart).map(([id, quantity]) => ({ ...productOf(id), quantity })).filter(p => p.id);
const cartTotal = () => { const subtotal = cartLines().reduce((s, p) => s + p.wholesalePrice * p.quantity, 0); const shipping = subtotal === 0 || subtotal >= 11000 ? 0 : 660; return { subtotal, shipping, total: subtotal + shipping, count: cartLines().reduce((s, p) => s + p.quantity, 0) }; };
const setCart = (next, source = 'manual') => { cart = next; cartSource = source; requestKey = null; };

function loginView(message = '') {
  operator = null;
  $('#app').innerHTML = `<main class="order-login"><div class="brand"><span class="brand-mark">S</span><div class="brand-word">SALON STATION<small>加盟店発注</small></div></div>
    <h1>本部への発注</h1><p class="subtle-note">店販・施術用の商品を、いつでも本部に発注できます。月末にまとめて請求書をお送りします。</p>
    ${message ? `<p class="notice">${esc(message)}</p>` : ''}
    ${isPages ? `<button class="btn line full" data-line-demo>LINEで発注を始める（デモ）</button><p class="subtle-note">公開デモはLINEと通信せず、架空の加盟店「LUMIÈRE 表参道」の担当者としてログインします。</p>` : line.orderLiffId ? '<p class="subtle-note">LINEのトーク画面から開くと、連携済みのアカウントで自動的にログインします。</p>' : ''}
    <form id="login-form" class="stack"><label>メールアドレス<input name="email" type="email" autocomplete="username" value="salon@example.test" required></label><label>パスワード<input name="password" type="password" autocomplete="current-password" value="${esc(DEMO_OPERATOR_PASSWORD)}" required></label><div id="form-error" class="error" role="alert"></div><button class="btn primary full" type="submit">ログイン ${icon('arrow')}</button></form>
    <p class="subtle-note">体験用：加盟店アカウント salon@example.test / ${esc(DEMO_OPERATOR_PASSWORD)}</p></main>`;
}
function shell() {
  const t = cartTotal();
  const tabs = [['order', '発注'], ['history', '履歴'], ['subscriptions', '定期発注'], ['invoices', '請求書']];
  $('#app').innerHTML = `<header class="order-header"><div><b>${esc(ws.salon.name)}</b><small>${esc(operator.name)}</small></div><button class="icon-btn" data-logout aria-label="ログアウト">${icon('logout')}</button></header>
    ${lineToken && !operator.lineLinked ? `<div class="notice order-banner">このLINEアカウントと連携すると、次回からLINEで開くだけでログインできます。<button class="btn line small" data-line-link>LINEと連携</button></div>` : ''}
    <nav class="order-tabs" aria-label="発注メニュー">${tabs.map(([id, label]) => `<button class="${tab === id ? 'active' : ''}" data-tab="${id}">${label}${id === 'order' && t.count ? `<b>${t.count}</b>` : ''}</button>`).join('')}</nav>
    <main class="order-main">${tab === 'order' ? orderTab() : tab === 'history' ? historyTab() : tab === 'subscriptions' ? subscriptionsTab() : invoicesTab()}</main>
    ${tab === 'order' && t.count ? `<div class="order-cartbar"><div><small>${t.count}点${t.shipping ? ` / 送料 ${money(t.shipping)}` : ' / 送料無料'}</small><strong>${money(t.total)}</strong></div><button class="btn primary" data-review>発注内容を確認 ${icon('arrow')}</button></div>` : ''}`;
}
function orderTab() {
  const s = ws.suggestions;
  return `${s.length ? `<section class="order-section"><h2>発注のご提案</h2><p class="subtle-note">いつもの発注の間隔から、そろそろ必要になりそうな商品です。</p>${s.map(x => `<article class="suggest-card"><div><b>${esc(x.name)}</b><small>いつも約${x.averageDays}日ごと・前回 ${esc(x.lastOrderedOn.slice(5).replace('-', '/'))}（${x.daysSince}日前）</small></div><button class="btn soft small" data-suggest="${esc(x.productId)}" data-qty="${x.quantity}">${x.quantity}点を追加</button></article>`).join('')}</section>` : ''}
    <section class="order-section"><h2>商品</h2><p class="subtle-note">卸価格（税込）です。11,000円以上で送料無料。</p>
    ${ws.products.map(p => { const q = cart[p.id] || 0; return `<article class="supply-item"><img src="./assets/${esc(p.image)}" alt=""><div class="supply-copy"><b>${esc(p.name)}</b><small>${esc(p.size)} / 在庫 ${p.stock}</small><span>${money(p.wholesalePrice)}<small> 卸価格・税込（売価 ${money(p.price)}）</small></span></div><div class="qty-control"><button data-step="${esc(p.id)}" data-delta="-1" ${q ? '' : 'disabled'} aria-label="${esc(p.name)}を1点減らす">−</button><span>${q}</span><button data-step="${esc(p.id)}" data-delta="1" ${q >= p.stock ? 'disabled' : ''} aria-label="${esc(p.name)}を1点増やす">＋</button></div></article>`; }).join('')}</section>`;
}
function historyTab() {
  return ws.orders.length ? ws.orders.map(o => `<article class="supply-order"><div class="between"><div><b>${esc(o.id)}</b><small>${date(o.createdAt, true)}・${esc(supplySources[o.source] || '')}</small></div>${badge(o.status, supplyStatuses[o.status])}</div>
    <p class="subtle-note">${o.items.map(i => `${esc(i.name)} × ${i.quantity}`).join('<br>')}</p>
    ${o.tracking ? `<p class="subtle-note">配送：${esc(o.carrier)} / 追跡番号 ${esc(o.tracking)}</p>` : ''}
    <div class="between"><strong>${money(o.total)}</strong><div class="form-actions">${o.status === 'ordered' && !o.invoiceId ? `<button class="btn outline small" data-cancel="${esc(o.id)}">キャンセル</button>` : ''}<button class="btn soft small" data-reorder="${esc(o.id)}">同じ内容で発注</button></div></div></article>`).join('') : empty('発注履歴はまだありません', '「発注」タブから商品を選んでください。');
}
function subscriptionsTab() {
  return `<p class="notice">決まった間隔で自動的に発注します。カートに商品を入れて「発注内容を確認」から登録できます。発注のたびにLINE（連携時）でお知らせします。</p>
    ${ws.subscriptions.length ? ws.subscriptions.map(s => `<article class="supply-order"><div class="between"><b>${esc(supplyIntervals[s.interval])}</b>${badge(s.active ? 'delivered' : 'cancelled', s.active ? '稼働中' : '停止中')}</div>
      <p class="subtle-note">${s.items.map(i => `${esc(productOf(i.id)?.name || i.id)} × ${i.quantity}`).join('<br>')}</p>
      <p class="subtle-note">次回：${esc(s.nextRunOn.replaceAll('-', '/'))}${s.lastResult ? `<br>前回：${esc(s.lastResult)}` : ''}</p>
      <div class="form-actions"><button class="btn ${s.active ? 'outline' : 'primary'} small" data-sub-toggle="${esc(s.id)}" data-active="${!s.active}">${s.active ? '停止する' : '再開する'}</button></div></article>`).join('') : empty('定期発注はまだありません', 'よく使う商品を定期発注にすると、発注の手間が減ります。')}`;
}
function invoicesTab() {
  return ws.invoices.length ? ws.invoices.map(i => `<article class="supply-order"><div class="between"><div><b>${esc(i.month.replace('-', '年'))}月分</b><small>${esc(i.id)}・発注${i.orderCount}件</small></div>${badge(i.status, invoiceStatusLabels[i.status])}</div><div class="between"><span>${money(i.total)}<small class="subtle-note">　支払期限 ${esc(i.dueOn.replaceAll('-', '/'))}</small></span><button class="btn outline small" data-invoice="${esc(i.id)}">請求書を表示</button></div></article>`).join('') : empty('請求書はまだありません', '月末に締めて、翌月に1か月分をまとめてご請求します。');
}
function review() {
  const t = cartTotal();
  modal('発注内容の確認', `<div class="stack">${cartLines().map(p => `<div class="order-line"><div class="line-copy"><strong>${esc(p.name)}</strong><br><small>${money(p.wholesalePrice)} × ${p.quantity}</small></div><span>${money(p.wholesalePrice * p.quantity)}</span></div>`).join('')}
    <div class="total-list"><div><span>商品小計（税込）</span><span>${money(t.subtotal)}</span></div><div><span>送料（税込）</span><span>${t.shipping ? money(t.shipping) : '無料'}</span></div><div class="grand"><span>合計</span><strong>${money(t.total)}</strong></div></div>
    <p class="subtle-note">お届け先：${esc(ws.salon.name)}（${esc(ws.salon.address)}）<br>お支払い：月末締め・翌月末までにお振込み（請求書払い）</p>
    <form id="supply-form" class="stack"><label>本部への連絡（任意）<textarea name="note" maxlength="200" rows="2" placeholder="例：次回の講習会で使います"></textarea></label><div id="form-error" class="error" role="alert"></div><button class="btn primary full" type="submit">この内容で発注する</button></form>
    <details class="subscribe-box"><summary>この内容を定期発注にする</summary><form id="subscription-form" class="stack"><div class="form-grid"><label>間隔<select name="interval">${Object.entries(supplyIntervals).map(([k, v]) => `<option value="${k}" ${k === 'biweekly' ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>初回の発注日<input name="startOn" type="date" min="${today()}" value="${addDays(today(), 1)}" required></label></div><button class="btn outline full" type="submit">定期発注を登録する</button></form></details></div>`);
}
async function load() { ws = await platform('/supply'); for (const id of Object.keys(cart)) if (!productOf(id)) delete cart[id]; }
async function start() {
  line = await lineConfig();
  let { operator: op } = await platform('/operator/me');
  if (!isPages && line.orderLiffId) {
    lineToken = await liffIdToken(line.orderLiffId);
    if (lineToken && !op) { try { op = (await platform('/operator/line', 'POST', { idToken: lineToken })).operator; } catch (error) { return loginView(error.message); } }
  }
  if (!op) return loginView();
  if (op.role !== 'salon') return loginView('この画面は加盟店（美容室）のアカウント専用です。本部・ディーラーは管理画面をご利用ください。');
  operator = op; await load(); shell();
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  try {
    if (b.dataset.tab) { tab = b.dataset.tab; if (tab !== 'order') await load(); shell(); scrollTo({ top: 0 }); }
    if (b.hasAttribute('data-line-demo')) { b.disabled = true; operator = (await platform('/operator/line-demo', 'POST', {})).operator; await load(); shell(); toast('LINEからログインしました（デモ）。'); }
    if (b.hasAttribute('data-line-link')) { operator = (await platform('/operator/line', 'POST', { idToken: lineToken })).operator; shell(); toast('LINEと連携しました。次回からLINEで開くだけでログインできます。'); }
    if (b.hasAttribute('data-logout')) { await platform('/operator/logout', 'POST', {}); setCart({}); loginView(); }
    if (b.dataset.step) { const id = b.dataset.step, next = (cart[id] || 0) + Number(b.dataset.delta), p = productOf(id); const copy = { ...cart }; if (next <= 0) delete copy[id]; else copy[id] = Math.min(next, p.stock, 999); setCart(copy, cartSource); shell(); }
    if (b.dataset.suggest) { const p = productOf(b.dataset.suggest); setCart({ ...cart, [p.id]: Math.min((cart[p.id] || 0) + Number(b.dataset.qty), p.stock) }, 'suggestion'); shell(); toast('提案の数量をカートに追加しました。'); }
    if (b.dataset.reorder) { const o = ws.orders.find(o => o.id === b.dataset.reorder), next = {}, skipped = []; for (const i of o.items) { const p = productOf(i.id); if (p?.stock) next[i.id] = Math.min(i.quantity, p.stock); else skipped.push(i.name); } setCart(next, 'reorder'); tab = 'order'; shell(); toast(skipped.length ? `在庫がない商品を除いて追加しました：${skipped.join('、')}` : '前回と同じ内容をカートに入れました。'); }
    if (b.hasAttribute('data-review')) review();
    if (b.dataset.cancel) { await platform('/supply/orders/' + b.dataset.cancel + '/cancel', 'POST', {}); await load(); shell(); toast('発注をキャンセルしました。'); }
    if (b.dataset.subToggle) { await platform('/supply/subscriptions/' + b.dataset.subToggle, 'PATCH', { active: b.dataset.active === 'true' }); await load(); shell(); toast(b.dataset.active === 'true' ? '定期発注を再開しました。' : '定期発注を停止しました。'); }
    if (b.dataset.invoice) { const inv = await platform('/supply/invoices/' + b.dataset.invoice); modal('請求書', `${invoiceHtml(inv)}<div class="form-actions no-print"><button class="btn outline" data-invoice-csv="${esc(inv.id)}">CSVで保存</button><button class="btn primary" data-print>印刷・PDFで保存</button></div>`, true); $('#modal').dataset.invoice = JSON.stringify(inv); }
    if (b.hasAttribute('data-print')) window.print();
    if (b.dataset.invoiceCsv) downloadInvoiceCsv(JSON.parse($('#modal').dataset.invoice));
  } catch (error) { formError(error); b.disabled = false; }
});
document.addEventListener('submit', async e => {
  const form = e.target; if (!['login-form', 'supply-form', 'subscription-form'].includes(form.id)) return;
  e.preventDefault(); const b = form.querySelector('[type=submit]'); b.disabled = true; const f = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'login-form') { const { operator: op } = await platform('/operator/login', 'POST', f); if (op.role !== 'salon') { await platform('/operator/logout', 'POST', {}); throw Error('この画面は加盟店（美容室）のアカウント専用です。'); } operator = op; await load(); shell(); return; }
    const items = cartLines().map(p => ({ id: p.id, quantity: p.quantity, price: p.wholesalePrice }));
    if (form.id === 'supply-form') {
      if (busy) return; busy = true;
      try { requestKey ??= crypto.randomUUID(); const o = await platform('/supply/orders', 'POST', { requestKey, items, note: f.note, source: cartSource }); setCart({}); await load(); closeModal(); tab = 'history'; shell(); toast(`発注しました（${o.id}）。本部が受け付けるとお知らせします。`); }
      finally { busy = false; }
    }
    if (form.id === 'subscription-form') { await platform('/supply/subscriptions', 'POST', { interval: f.interval, startOn: f.startOn, items: items.map(({ id, quantity }) => ({ id, quantity })) }); setCart({}); await load(); closeModal(); tab = 'subscriptions'; shell(); toast('定期発注を登録しました。'); }
  } catch (error) { formError(error); } finally { b.disabled = false; }
});
start().catch(error => { $('#app').innerHTML = empty('発注画面を読み込めませんでした', error.message, '<button class="btn primary" id="retry">再読み込み</button>'); $('#retry').onclick = () => location.reload(); });
