// 加盟店（サロン）の仕入れ画面。パソコン・スマートフォン・LINE ミニアプリで使う。
// ログイン前はブランドを伝える画面（映像）。ログイン後は「前回と同じ内容で発注」「いつもの商品」「品番でまとめて発注」
// 「最近買った商品」「発注履歴」「発送状況」を一番上に置き、少ない操作ですぐ発注できるようにする。新製品はその下。
import { platform, isPages } from './platform-client.js?v=25e99ea580';
import { supplyStatuses, supplySources, supplyIntervals, addDays, stockState, shipEstimate } from './supply-core.js?v=25e99ea580';
import { DEMO_OPERATOR_PASSWORD } from './platform-core.js?v=25e99ea580';
import { $, esc, money, date, icon, badge, toast, modal, closeModal, empty, formError, imageUrl, keepTabVisible } from './ui-kit.js?v=25e99ea580';
import { lineConfig, liffIdToken } from './line-login.js?v=25e99ea580';
import { invoiceHtml, downloadInvoiceCsv, invoiceStatusLabels } from './invoice-view.js?v=25e99ea580';

let operator = null, ws = null, staff = null, page = 'home', cart = {}, cartSource = 'manual', requestKey = null, busy = false, line = { enabled: false, orderLiffId: '' }, lineToken = null;
let query = '', category = '', onlyFavorites = false, hideOut = false;
const PAGES = [['home', 'ホーム'], ['products', '商品一覧'], ['history', '発注履歴'], ['subscriptions', '定期発注'], ['invoices', '請求書'], ['ec', '店販EC'], ['staff', 'スタッフ']];
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const productOf = id => ws.products.find(p => p.id === id);
const cartLines = () => Object.entries(cart).map(([id, quantity]) => ({ ...productOf(id), quantity })).filter(p => p.id);
const cartTotal = () => { const subtotal = cartLines().reduce((s, p) => s + p.wholesalePrice * p.quantity, 0); const shipping = subtotal === 0 || subtotal >= 11000 ? 0 : 660; return { subtotal, shipping, total: subtotal + shipping, count: cartLines().reduce((s, p) => s + p.quantity, 0) }; };
const setCart = (next, source = 'manual') => { cart = next; cartSource = source; requestKey = null; };
const addToCart = (p, n) => { const q = Math.min((cart[p.id] || 0) + n, p.stock, 999); setCart({ ...cart, [p.id]: q }, cartSource); return q; };

// ---- 発注のデータから作る一覧（新しい発注が先）
const activeOrders = () => ws.orders.filter(o => o.status !== 'cancelled').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const isFavorite = id => ws.favorites.includes(id);
const favorites = () => ws.favorites.map(productOf).filter(Boolean);
function recentProducts() { const ids = []; for (const o of activeOrders()) for (const i of o.items) if (!ids.includes(i.id)) ids.push(i.id); return ids.map(productOf).filter(Boolean).slice(0, 8); }
function frequentProducts() { const n = new Map(); for (const o of activeOrders()) for (const i of o.items) n.set(i.id, (n.get(i.id) || 0) + i.quantity); return [...n].sort((a, b) => b[1] - a[1]).map(([id]) => productOf(id)).filter(Boolean); }
const movingOrders = () => activeOrders().filter(o => ['ordered', 'accepted', 'shipped'].includes(o.status)).slice(0, 4);
const newProducts = () => ws.products.filter(p => /new/i.test(p.tag || ''));
function monthSummary() { const month = today().slice(0, 7), rows = activeOrders().filter(o => o.orderedOn?.startsWith(month)); return { count: rows.length, total: rows.reduce((s, o) => s + o.total, 0) }; }
const shortDate = iso => date(iso).replace(/^\d+\//, '');

// ---- 部品
const secHead = (en, ja, extra = '') => `<div class="fc-sec-head"><h2>${en}</h2><span>${ja}</span>${extra}</div>`;
function qtyControl(p) { const q = cart[p.id] || 0; return `<div class="qty-control"><button data-step="${esc(p.id)}" data-delta="-1" ${q ? '' : 'disabled'} aria-label="${esc(p.name)}を1点減らす">−</button><span>${q}</span><button data-step="${esc(p.id)}" data-delta="1" ${q >= p.stock ? 'disabled' : ''} aria-label="${esc(p.name)}を1点増やす">＋</button></div>`; }
const stockTags = p => { const s = stockState(p.stock); return `<span class="fc-stock ${s.code}">${esc(s.label)}</span><span class="fc-ship">出荷予定：${esc(shipEstimate(p.stock).label)}</span>`; };
const favButton = p => { const on = isFavorite(p.id); return `<button class="b2b-fav${on ? ' on' : ''}" data-fav="${esc(p.id)}" aria-pressed="${on}" aria-label="${esc(p.name)}を${on ? 'いつもの商品から外す' : 'いつもの商品に登録する'}">${on ? '★' : '☆'}</button>`; };
const productRow = p => `<article class="b2b-row"><img src="${esc(imageUrl(p.image))}" alt=""><div class="b2b-row-copy"><small class="fc-brand">${esc(p.brand)}</small><b>${esc(p.name)}</b><small class="fc-meta">品番 ${esc(p.sku)}　${esc(p.size)}</small><div class="b2b-tags">${stockTags(p)}</div></div><div class="b2b-row-price"><b>${money(p.wholesalePrice)}</b><small>卸価格・税込<br>売価 ${money(p.price)}</small></div><div class="b2b-row-actions">${favButton(p)}${qtyControl(p)}</div></article>`;
function productCard(p) { const q = cart[p.id] || 0, s = stockState(p.stock); return `<article class="fc-card"><div class="fc-card-photo"><img src="${esc(imageUrl(p.image))}" alt="">${p.tag ? `<span class="fc-card-tag">${esc(p.tag)}</span>` : ''}</div><small class="fc-brand">${esc(p.brand)}</small><b>${esc(p.name)}</b><small class="fc-meta">品番 ${esc(p.sku)}　${esc(p.size)}</small><span class="fc-stock ${s.code}">${esc(s.label)}</span><div class="fc-card-foot"><span>${money(p.wholesalePrice)}<small>税込</small></span><button class="btn small ${q ? 'soft' : 'primary'}" data-add="${esc(p.id)}" ${p.stock > q ? '' : 'disabled'}>${!p.stock ? '欠品中' : q ? `＋1（${q}点）` : 'カートへ'}</button></div></article>`; }
const STEPS = ['ordered', 'accepted', 'shipped', 'delivered'];
const shipLine = o => `<article class="fc-ship-line"><div class="between"><div><b>${esc(o.id)}</b><small>${date(o.createdAt, true)}・${o.items.length}商品・${money(o.total)}</small></div>${badge(o.status, supplyStatuses[o.status])}</div><ol class="fc-steps">${STEPS.map((s, i) => `<li class="${STEPS.indexOf(o.status) >= i ? 'done' : ''}">${supplyStatuses[s]}</li>`).join('')}</ol>${o.tracking ? `<small>配送：${esc(o.carrier)}　追跡番号 ${esc(o.tracking)}</small>` : ''}</article>`;
const suggestLine = x => `<article class="suggest-card"><div><b>${esc(x.name)}</b><small>いつも約${x.averageDays}日ごと・前回 ${esc(x.lastOrderedOn.slice(5).replace('-', '/'))}（${x.daysSince}日前）</small></div><button class="btn soft small" data-suggest="${esc(x.productId)}" data-qty="${x.quantity}">${x.quantity}点を追加</button></article>`;

// ---- ログイン前：ブランドを伝える画面
function loginView(message = '') {
  operator = null;
  $('#app').innerHTML = `<div class="b2b-topbar">加盟サロン様専用の仕入れサイトです</div>
    <header class="b2b-header"><div class="b2b-head-main"><span class="b2b-logo">SALON STATION<small>加盟店 仕入れ</small></span></div></header>
    <section class="store-film b2b-film" aria-label="サロンのケアの映像"><video class="film-video" src="./assets/salon-film.mp4" muted loop playsinline preload="metadata" aria-hidden="true"></video><div class="b2b-film-copy"><div class="film-eyebrow">FOR SALON PARTNERS</div><h1>サロンの仕入れを、<br>もっとかんたんに。</h1><p>いつもの商品を、すぐに発注。<br>前回と同じ内容や、品番でのまとめ発注にも対応しています。</p></div></section>
    <main class="b2b-login"><section class="b2b-login-card"><h2>ログイン</h2><p class="subtle-note">店販・施術用の商品を、いつでも本部に発注できます。月末にまとめて請求書をお送りします。</p>
      ${message ? `<p class="notice">${esc(message)}</p>` : ''}
      ${isPages ? `<button class="btn line full" data-line-demo>LINEで発注を始める（デモ）</button><p class="subtle-note">公開デモはLINEと通信せず、架空の加盟店「LUMIÈRE 表参道」の担当者としてログインします。</p>` : line.orderLiffId ? '<p class="subtle-note">LINEのトーク画面から開くと、連携済みのアカウントで自動的にログインします。</p>' : ''}
      <form id="login-form" class="stack"><label>メールアドレス<input name="email" type="email" autocomplete="username" value="salon@example.test" required></label><label>パスワード<input name="password" type="password" autocomplete="current-password" value="${esc(DEMO_OPERATOR_PASSWORD)}" required></label><div id="form-error" class="error" role="alert"></div><button class="btn primary full" type="submit">ログイン ${icon('arrow')}</button></form>
      <p class="subtle-note">体験用：加盟店アカウント salon@example.test / ${esc(DEMO_OPERATOR_PASSWORD)}</p></section></main>
    <section class="fc-service" aria-label="ご利用の特典">${[['truck', '当日出荷', '平日15時までのご注文は<br>当日出荷します（デモ設定）'], ['bag', '送料無料', '11,000円（税込）以上で<br>送料無料です'], ['wallet', '請求書払い', '月末締め・翌月末までに<br>お振込みください'], ['refresh', 'かんたん再注文', '前回と同じ内容を<br>ワンタップで発注']].map(([i, t, d]) => `<div>${icon(i)}<b>${t}</b><p>${d}</p></div>`).join('')}</section>`;
  // 映像は音声なしで再生する（「視差効果を減らす」設定では再生しない）
  const v = $('.b2b-film video'); if (v && !matchMedia('(prefers-reduced-motion: reduce)').matches) v.play().catch(() => {});
}

// ---- ログイン後
function shell() {
  const tabScroll = $('.b2b-tabs')?.scrollLeft || 0, t = cartTotal(), cats = [...new Set(ws.products.map(p => p.category))];
  $('#app').innerHTML = `<div class="b2b-topbar">11,000円（税込）以上で送料無料 ／ 平日15時までのご注文は当日出荷（デモ設定） ／ 月末締め・請求書払い</div>
    <header class="b2b-header"><div class="b2b-head-main"><button class="b2b-logo" data-page="home">SALON STATION<small>加盟店 仕入れ</small></button>
      <nav class="b2b-links" aria-label="主なメニュー"><button data-page="products">商品一覧</button><button data-page="history">発注履歴</button><button data-page="invoices">請求書</button></nav>
      <div class="b2b-account"><span class="b2b-salon">${esc(ws.salon.name)} 様<small>${esc(operator.name)}</small></span><button class="b2b-cart" data-review ${t.count ? '' : 'disabled'} aria-label="発注内容を確認（${t.count}点）">${icon('bag')}<b>${t.count}</b></button><button class="icon-btn" data-logout aria-label="ログアウト">${icon('logout')}</button></div></div>
      <div class="b2b-head-sub"><div class="b2b-cats">${cats.map(c => `<button data-category-jump="${esc(c)}">${esc(c)}</button>`).join('')}</div><form id="search-form" class="b2b-search" role="search"><input name="q" value="${esc(query)}" placeholder="品番・商品名で探す" aria-label="品番・商品名で探す" enterkeyhint="search">${icon('search')}</form></div></header>
    ${lineToken && !operator.lineLinked ? `<div class="notice order-banner">このLINEアカウントと連携すると、次回からLINEで開くだけでログインできます。<button class="btn line small" data-line-link>LINEと連携</button></div>` : ''}
    <nav class="b2b-tabs" aria-label="仕入れメニュー">${PAGES.map(([id, label]) => `<button class="${page === id ? 'active' : ''}" data-page="${id}">${label}</button>`).join('')}</nav>
    <main class="b2b-main">${page === 'home' ? homePage() : page === 'products' ? productsPage() : page === 'ec' ? ecTab() : page === 'history' ? historyTab() : page === 'subscriptions' ? subscriptionsTab() : page === 'staff' ? staffTab() : invoicesTab()}</main>
    ${t.count ? `<div class="order-cartbar"><div><small>${t.count}点${t.shipping ? ` / 送料 ${money(t.shipping)}` : ' / 送料無料'}・出荷予定 ${esc(shipEstimate(1).label)}</small><strong>${money(t.total)}</strong></div><button class="btn primary" data-review>発注内容を確認 ${icon('arrow')}</button></div>` : ''}`;
  keepTabVisible($('.b2b-tabs'), tabScroll);
}
function homePage() {
  const last = activeOrders()[0], fav = favorites(), usual = fav.length ? fav : frequentProducts().slice(0, 6), recent = recentProducts(), moving = movingOrders(), news = newProducts(), month = monthSummary();
  const tile = (ic, label, sub, attrs) => `<button class="fc-tile" ${attrs}><span class="fc-tile-icon">${icon(ic)}</span><b>${label}</b><small>${sub}</small></button>`;
  return `<section class="b2b-hello"><div><small>${esc(ws.salon.name)} 様</small><b>いつもの発注を、すぐに。</b></div><p>今月のご発注 ${month.count}件・${money(month.total)}</p></section>
    <section class="fc-tiles" aria-label="よく使う操作">
      ${tile('refresh', '前回と同じ内容で発注', last ? `${shortDate(last.createdAt)}・${last.items.length}商品` : '発注履歴はまだありません', last ? `data-reorder="${esc(last.id)}"` : 'disabled')}
      ${tile('heart', 'いつもの商品', fav.length ? `お気に入り ${fav.length}商品` : '☆を押して登録できます', 'data-jump="usual"')}
      ${tile('grid', '品番でまとめて発注', '品番と数量を入力・貼り付け', 'data-quick')}
      ${tile('clock', '最近買った商品', recent.length ? `${recent.length}商品` : 'まだありません', recent.length ? 'data-jump="recent"' : 'disabled')}
      ${tile('bag', '発注履歴', `${activeOrders().length}件`, 'data-page="history"')}
      ${tile('truck', '発送状況', moving.length ? `${moving.length}件が進行中` : '進行中の発注はありません', moving.length ? 'data-jump="shipping"' : 'data-page="history"')}
    </section>
    ${moving.length ? `<section class="fc-sec" id="shipping">${secHead('Shipping', '発送状況')}${moving.map(shipLine).join('')}</section>` : ''}
    <section class="fc-sec" id="usual">${secHead('Usual', 'いつもの商品', `<button class="text-link" data-page="products">すべての商品を見る ${icon('arrow')}</button>`)}
      ${fav.length ? '' : `<p class="subtle-note">${usual.length ? 'よく発注する商品です。' : ''}商品の ☆ を押すと「いつもの商品」に登録できます。</p>`}
      ${usual.length ? usual.map(productRow).join('') : empty('まだ発注がありません', '「商品一覧」から商品を選んでください。', `<button class="btn primary" data-page="products">商品一覧へ</button>`)}</section>
    ${ws.suggestions.length ? `<section class="fc-sec">${secHead('Suggest', '発注のご提案')}<p class="subtle-note">いつもの発注の間隔から、そろそろ必要になりそうな商品です。</p>${ws.suggestions.map(suggestLine).join('')}</section>` : ''}
    ${recent.length ? `<section class="fc-sec" id="recent">${secHead('Recent', '最近買った商品')}<div class="fc-cards">${recent.map(productCard).join('')}</div></section>` : ''}
    ${news.length ? `<section class="fc-sec">${secHead('New', '新製品')}<p class="subtle-note">新しく入った商品です。</p><div class="fc-cards">${news.map(productCard).join('')}</div></section>` : ''}
    ${ecGlance()}`;
}
function productsPage() {
  const cats = [...new Set(ws.products.map(p => p.category))], q = query.normalize('NFKC').toLowerCase();
  const rows = ws.products.filter(p => (!category || p.category === category) && (!onlyFavorites || isFavorite(p.id)) && (!hideOut || p.stock > 0) && (!q || `${p.sku} ${p.name} ${p.brand}`.toLowerCase().includes(q)));
  return `<section class="fc-sec">${secHead('Products', '商品一覧', `<button class="btn outline small" data-quick>品番でまとめて発注</button>`)}
    <div class="b2b-filters"><div class="fc-chips">${[['', 'すべて'], ...cats.map(c => [c, c])].map(([v, l]) => `<button class="${category === v ? 'active' : ''}" data-category="${esc(v)}">${esc(l)}</button>`).join('')}</div><label class="check-label"><input type="checkbox" id="only-fav" ${onlyFavorites ? 'checked' : ''}>いつもの商品だけ</label><label class="check-label"><input type="checkbox" id="hide-out" ${hideOut ? 'checked' : ''}>欠品中の商品を隠す</label></div>
    <p class="subtle-note">${query ? `「${esc(query)}」の検索結果　` : ''}${rows.length}商品・卸価格（税込）。11,000円以上で送料無料。</p>
    ${rows.length ? rows.map(productRow).join('') : empty('該当する商品がありません', '条件を変えてお試しください。')}</section>`;
}
// 品番でまとめて発注：1行に「品番 数量」。Excel からの貼り付け（タブ区切り）にも対応
function quickOrder() {
  modal('品番でまとめて発注', `<form id="quick-form" class="stack"><label>品番と数量（1行に1商品）<textarea name="lines" rows="7" placeholder="SN-SH-050 3&#10;SN-TR-025 2" autocomplete="off"></textarea></label><p class="subtle-note">品番と数量は、空白・タブ・カンマのどれで区切っても読み取れます。数量を省くと1点です。Excelの表をコピーして貼り付けることもできます。</p>
    <details class="subscribe-box"><summary>品番の一覧を見る</summary><p class="subtle-note">${ws.products.map(p => `${esc(p.sku)}　${esc(p.name)}（${esc(stockState(p.stock).label)}）`).join('<br>')}</p></details>
    <div id="form-error" class="error" role="alert"></div><button class="btn primary full" type="submit">カートに入れる</button></form>`);
}
function applyQuickOrder(text) {
  const unknown = [], out = [], short = []; let added = 0;
  for (const raw of String(text).normalize('NFKC').split(/\r?\n/)) {
    const [code, qty] = raw.trim().split(/[\s,，、\t]+/); if (!code) continue;
    const p = ws.products.find(x => x.sku.toUpperCase() === code.toUpperCase()); if (!p) { unknown.push(code); continue; }
    const want = Math.max(1, Math.min(999, Math.floor(Number(qty)) || 1)); if (!p.stock) { out.push(p.sku); continue; }
    const before = cart[p.id] || 0, after = addToCart(p, want); if (after - before < want) short.push(`${p.sku}（${p.stock}点まで）`); if (after > before) added++;
  }
  return { added, unknown, out, short };
}
// ---- 店販EC：貴店を選んでいるお客様がECで買った分の集計（お客様の名前は受け取らない）
const monthLabel = month => `${Number(month.slice(5))}月`;
const changeText = e => e.change === null ? '前月の実績なし' : `前月比 ${e.change >= 0 ? '+' : '−'}${Math.abs(e.change)}%`;
function ecGlance() {
  const e = ws.ec;
  return `<button class="ec-glance" data-page="ec" aria-label="店販ECの詳細を見る"><span><small>${monthLabel(e.month)}の店販EC</small><b>${money(e.current.sales)}</b></span><span><small>取り分（見込み）</small><b>${money(e.current.proceeds)}</b></span><span class="ec-change">${changeText(e)}${icon('chevron')}</span></button>`;
}
function ecTab() {
  const e = ws.ec, c = e.current, p = e.previous, prev = monthLabel(e.previousMonth);
  return `${secHead('Salon EC', '店販EC')}<p class="notice">貴店を選んでいるお客様が、ECで購入した分の集計です（${monthLabel(e.month)}1日〜今日。商品代・税込で、送料は含みません）。お客様のお名前は表示しません。お客様ごとの内訳は管理画面の「受注管理」で確認できます。</p>
    <section class="ec-metrics">
      <article class="metric"><div class="metric-top">店販EC売上</div><div class="metric-value">${money(c.sales)}</div><div class="metric-bottom">${changeText(e)}<br>${prev} ${money(p.sales)}</div></article>
      <article class="metric"><div class="metric-top">サロンの取り分（見込み）</div><div class="metric-value">${money(c.proceeds)}</div><div class="metric-bottom">${prev} ${money(p.proceeds)}</div></article>
      <article class="metric"><div class="metric-top">注文</div><div class="metric-value">${c.orders}<small>件</small></div><div class="metric-bottom">購入されたお客様 ${c.customers}人<br>${prev} ${p.orders}件</div></article>
      <article class="metric"><div class="metric-top">会員</div><div class="metric-value">${e.members.total}<small>人</small></div><div class="metric-bottom">今月の新規 ${e.members.newThisMonth}人<br>LINE連携 ${e.members.lineLinked}人</div></article>
    </section>
    <section class="order-section"><h2>よく売れている商品（${monthLabel(e.month)}）</h2><p class="subtle-note">店頭の在庫や、次の発注の目安にご利用ください。</p>
    ${e.topProducts.length ? e.topProducts.map((t, i) => { const product = productOf(t.productId); return `<article class="supply-order ec-rank"><span class="rank-num">${i + 1}</span><div><b>${esc(t.name)}</b><small>${t.quantity}点・${money(t.sales)}</small></div>${product && product.stock > (cart[product.id] || 0) ? `<button class="btn soft small" data-ec-add="${esc(product.id)}">発注に追加</button>` : ''}</article>`; }).join('') : empty('今月のEC注文はまだありません', 'QRコードや紹介リンクから、お客様にECをご案内ください。')}</section>
    <p class="subtle-note">取り分は「商品売上 − 仕入原価 − 運用料（${ws.salon.feeRate}%）」の見込みです。本部からのお支払いや、請求書との相殺の方法は別途ご案内します。キャンセル・返品済みの注文は含みません。お客様の担当店舗が後から変わっても、売れたときの店舗の実績として数えます。</p>`;
}
// ---- 担当スタッフ：お客様が会員登録・マイページで選ぶスタッフの追加・名前の変更・並び替え・削除（管理画面の「担当スタッフ」と同じ操作）
const staffUrl = (id = '') => `/admin/salons/${encodeURIComponent(operator.salonId)}/staff${id ? '/' + encodeURIComponent(id) : ''}`;
async function loadStaff() { staff = await platform(staffUrl()); }
const staffOf = id => staff.staff.find(s => s.id === id);
function staffTab() {
  const list = staff?.staff || [];
  return `${secHead('Staff', '担当スタッフ')}<p class="notice">お客様が会員登録・マイページで選ぶ「担当スタッフ」です。上から順にお客様の選択肢に表示されます。名前を変えても、担当のお客様はそのまま引き継がれます。</p>
    <form id="staff-form" class="supply-order staff-add"><label>新しいスタッフの名前<input name="name" maxlength="40" required placeholder="例：HARUKA" autocomplete="off"></label><button class="btn primary" type="submit">追加する</button></form>
    ${list.length ? list.map((s, i) => `<article class="supply-order staff-row"><div class="between"><div><b>${esc(s.name)}</b><small>担当のお客様 ${s.members}人</small></div><div class="staff-order"><button class="icon-btn" data-staff-move="${esc(s.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="${esc(s.name)}を上へ">↑</button><button class="icon-btn" data-staff-move="${esc(s.id)}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="${esc(s.name)}を下へ">↓</button></div></div>
      <div class="form-actions"><button class="btn outline small" data-staff-rename="${esc(s.id)}">名前を変更</button><button class="btn outline small" data-staff-delete="${esc(s.id)}">削除</button></div></article>`).join('') : empty('スタッフが登録されていません', '上の欄から追加してください。')}
    <p class="subtle-note">指名なしのお客様：${staff?.unassigned ?? 0}人。スタッフを削除しても、過去の注文には注文時の担当者名が残ります。</p>`;
}
function historyTab() {
  const rows = [...ws.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `${secHead('History', '発注履歴')}${rows.length ? rows.map(o => `<article class="supply-order"><div class="between"><div><b>${esc(o.id)}</b><small>${date(o.createdAt, true)}・${esc(supplySources[o.source] || '')}</small></div>${badge(o.status, supplyStatuses[o.status])}</div>
    ${o.status !== 'cancelled' ? `<ol class="fc-steps">${STEPS.map((s, i) => `<li class="${STEPS.indexOf(o.status) >= i ? 'done' : ''}">${supplyStatuses[s]}</li>`).join('')}</ol>` : ''}
    <p class="subtle-note">${o.items.map(i => `${esc(i.name)} × ${i.quantity}`).join('<br>')}</p>
    ${o.tracking ? `<p class="subtle-note">配送：${esc(o.carrier)} / 追跡番号 ${esc(o.tracking)}</p>` : ''}
    <div class="between"><strong>${money(o.total)}</strong><div class="form-actions">${o.status === 'ordered' && !o.invoiceId ? `<button class="btn outline small" data-cancel="${esc(o.id)}">キャンセル</button>` : ''}<button class="btn soft small" data-reorder="${esc(o.id)}">同じ内容で発注</button></div></div></article>`).join('') : empty('発注履歴はまだありません', '「商品一覧」から商品を選んでください。')}`;
}
function subscriptionsTab() {
  return `${secHead('Subscription', '定期発注')}<p class="notice">決まった間隔で自動的に発注します。カートに商品を入れて「発注内容を確認」から登録できます。発注のたびにLINE（連携時）でお知らせします。</p>
    ${ws.subscriptions.length ? ws.subscriptions.map(s => `<article class="supply-order"><div class="between"><b>${esc(supplyIntervals[s.interval])}</b>${badge(s.active ? 'delivered' : 'cancelled', s.active ? '稼働中' : '停止中')}</div>
      <p class="subtle-note">${s.items.map(i => `${esc(productOf(i.id)?.name || i.id)} × ${i.quantity}`).join('<br>')}</p>
      <p class="subtle-note">次回：${esc(s.nextRunOn.replaceAll('-', '/'))}${s.lastResult ? `<br>前回：${esc(s.lastResult)}` : ''}</p>
      <div class="form-actions"><button class="btn ${s.active ? 'outline' : 'primary'} small" data-sub-toggle="${esc(s.id)}" data-active="${!s.active}">${s.active ? '停止する' : '再開する'}</button></div></article>`).join('') : empty('定期発注はまだありません', 'よく使う商品を定期発注にすると、発注の手間が減ります。')}`;
}
function invoicesTab() {
  return `${secHead('Invoice', '請求書')}${ws.invoices.length ? ws.invoices.map(i => `<article class="supply-order"><div class="between"><div><b>${esc(i.month.replace('-', '年'))}月分</b><small>${esc(i.id)}・発注${i.orderCount}件</small></div>${badge(i.status, invoiceStatusLabels[i.status])}</div><div class="between"><span>${money(i.total)}<small class="subtle-note">　支払期限 ${esc(i.dueOn.replaceAll('-', '/'))}</small></span><button class="btn outline small" data-invoice="${esc(i.id)}">請求書を表示</button></div></article>`).join('') : empty('請求書はまだありません', '月末に締めて、翌月に1か月分をまとめてご請求します。')}`;
}
function review() {
  const t = cartTotal();
  modal('発注内容の確認', `<div class="stack">${cartLines().map(p => `<div class="order-line"><div class="line-copy"><strong>${esc(p.name)}</strong><br><small>品番 ${esc(p.sku)}・${money(p.wholesalePrice)} × ${p.quantity}</small></div><span>${money(p.wholesalePrice * p.quantity)}</span></div>`).join('')}
    <div class="total-list"><div><span>商品小計（税込）</span><span>${money(t.subtotal)}</span></div><div><span>送料（税込）</span><span>${t.shipping ? money(t.shipping) : '無料'}</span></div><div class="grand"><span>合計</span><strong>${money(t.total)}</strong></div></div>
    <p class="subtle-note">出荷予定：${esc(shipEstimate(1).label)}（デモ設定。平日15時までのご注文は当日出荷）<br>お届け先：${esc(ws.salon.name)}（${esc(ws.salon.address)}）<br>お支払い：月末締め・翌月末までにお振込み（請求書払い）</p>
    <form id="supply-form" class="stack"><label>本部への連絡（任意）<textarea name="note" maxlength="200" rows="2" placeholder="例：次回の講習会で使います"></textarea></label><div id="form-error" class="error" role="alert"></div><button class="btn primary full" type="submit">この内容で発注する</button></form>
    <details class="subscribe-box"><summary>この内容を定期発注にする</summary><form id="subscription-form" class="stack"><div class="form-grid"><label>間隔<select name="interval">${Object.entries(supplyIntervals).map(([k, v]) => `<option value="${k}" ${k === 'biweekly' ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>初回の発注日<input name="startOn" type="date" min="${today()}" value="${addDays(today(), 1)}" required></label></div><button class="btn outline full" type="submit">定期発注を登録する</button></form></details></div>`);
}
async function load() { ws = await platform('/supply'); ws.favorites ||= []; for (const id of Object.keys(cart)) if (!productOf(id)) delete cart[id]; }
async function go(next) { page = next; if (page === 'staff') await loadStaff(); else if (page !== 'home' && page !== 'products') await load(); shell(); scrollTo({ top: 0 }); }
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
    if (b.dataset.page) await go(b.dataset.page);
    if (b.dataset.categoryJump !== undefined) { category = b.dataset.categoryJump; query = ''; await go('products'); }
    if (b.dataset.category !== undefined) { category = b.dataset.category; shell(); }
    if (b.dataset.jump) document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (b.hasAttribute('data-quick')) quickOrder();
    if (b.dataset.fav) { const id = b.dataset.fav, next = isFavorite(id) ? ws.favorites.filter(x => x !== id) : [...ws.favorites, id]; ws.favorites = (await platform('/supply/favorites', 'PUT', { ids: next })).ids; shell(); toast(isFavorite(id) ? '「いつもの商品」に登録しました。' : '「いつもの商品」から外しました。'); }
    if (b.dataset.add) { const p = productOf(b.dataset.add); addToCart(p, 1); shell(); toast(`${p.name}をカートに入れました。`); }
    if (b.dataset.staffMove) { await platform(staffUrl(b.dataset.staffMove), 'PATCH', { move: Number(b.dataset.dir) }); await loadStaff(); shell(); }
    if (b.dataset.staffRename) { const s = staffOf(b.dataset.staffRename); modal('スタッフ名の変更', `<form id="staff-rename-form" data-staff-id="${esc(s.id)}" class="stack"><label>スタッフ名<input name="name" value="${esc(s.name)}" maxlength="40" required></label><p class="subtle-note">担当のお客様（${s.members}人）はそのまま引き継がれます。過去の注文の担当者名は変わりません。</p><div id="form-error" class="error" role="alert"></div><button class="btn primary" type="submit">変更する</button></form>`); }
    if (b.dataset.staffDelete) { const s = staffOf(b.dataset.staffDelete), others = staff.staff.filter(x => x.id !== s.id); modal('スタッフの削除', `<form id="staff-delete-form" data-staff-id="${esc(s.id)}" class="stack"><p>「${esc(s.name)}」を担当スタッフから削除します。お客様の選択肢にも表示されなくなります。</p>${s.members ? `<label>担当のお客様 ${s.members}人の引き継ぎ先<select name="transferTo"><option value="">指名なし</option>${others.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>` : '<p class="subtle-note">担当のお客様はいません。</p>'}<p class="subtle-note">過去の注文には、注文時の担当者名が残ります。お客様はマイページで担当スタッフを選び直せます。</p><div id="form-error" class="error" role="alert"></div><button class="btn danger" type="submit">削除する</button></form>`); }
    if (b.hasAttribute('data-line-demo')) { b.disabled = true; operator = (await platform('/operator/line-demo', 'POST', {})).operator; await load(); shell(); toast('LINEからログインしました（デモ）。'); }
    if (b.hasAttribute('data-line-link')) { operator = (await platform('/operator/line', 'POST', { idToken: lineToken })).operator; shell(); toast('LINEと連携しました。次回からLINEで開くだけでログインできます。'); }
    if (b.hasAttribute('data-logout')) { await platform('/operator/logout', 'POST', {}); setCart({}); page = 'home'; loginView(); }
    if (b.dataset.step) { const id = b.dataset.step, next = (cart[id] || 0) + Number(b.dataset.delta), p = productOf(id); const copy = { ...cart }; if (next <= 0) delete copy[id]; else copy[id] = Math.min(next, p.stock, 999); setCart(copy, cartSource); shell(); }
    if (b.dataset.ecAdd) { const p = productOf(b.dataset.ecAdd); addToCart(p, 1); shell(); toast(`${p.name}をカートに入れました。`); }
    if (b.dataset.suggest) { const p = productOf(b.dataset.suggest); setCart({ ...cart, [p.id]: Math.min((cart[p.id] || 0) + Number(b.dataset.qty), p.stock) }, 'suggestion'); shell(); toast('提案の数量をカートに入れました。'); }
    if (b.dataset.reorder) { const o = ws.orders.find(o => o.id === b.dataset.reorder), next = {}, skipped = [], replaced = cartTotal().count > 0; for (const i of o.items) { const p = productOf(i.id); if (p?.stock) next[i.id] = Math.min(i.quantity, p.stock); else skipped.push(i.name); } setCart(next, 'reorder'); shell(); if (Object.keys(next).length) review(); toast(`${replaced ? 'カートの中身を、' : ''}${o.id} と同じ内容${replaced ? 'に入れ替えました' : 'をカートに入れました'}。${skipped.length ? `欠品中の商品は除いています：${skipped.join('、')}` : '内容を確認して発注してください。'}`); }
    if (b.hasAttribute('data-review')) review();
    if (b.dataset.cancel) { await platform('/supply/orders/' + b.dataset.cancel + '/cancel', 'POST', {}); await load(); shell(); toast('発注をキャンセルしました。'); }
    if (b.dataset.subToggle) { await platform('/supply/subscriptions/' + b.dataset.subToggle, 'PATCH', { active: b.dataset.active === 'true' }); await load(); shell(); toast(b.dataset.active === 'true' ? '定期発注を再開しました。' : '定期発注を停止しました。'); }
    if (b.dataset.invoice) { const inv = await platform('/supply/invoices/' + b.dataset.invoice); modal('請求書', `${invoiceHtml(inv)}<div class="form-actions no-print"><button class="btn outline" data-invoice-csv="${esc(inv.id)}">CSVで保存</button><button class="btn primary" data-print>印刷・PDFで保存</button></div>`, true); $('#modal').dataset.invoice = JSON.stringify(inv); }
    if (b.hasAttribute('data-print')) window.print();
    if (b.dataset.invoiceCsv) downloadInvoiceCsv(JSON.parse($('#modal').dataset.invoice));
  } catch (error) { formError(error); b.disabled = false; }
});
document.addEventListener('change', e => {
  if (e.target.id === 'only-fav') { onlyFavorites = e.target.checked; shell(); }
  if (e.target.id === 'hide-out') { hideOut = e.target.checked; shell(); }
});
document.addEventListener('submit', async e => {
  const form = e.target; if (!['login-form', 'supply-form', 'subscription-form', 'staff-form', 'staff-rename-form', 'staff-delete-form', 'search-form', 'quick-form'].includes(form.id)) return;
  e.preventDefault(); const b = form.querySelector('[type=submit]'); if (b) b.disabled = true; const f = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'search-form') { query = String(f.q || '').trim(); category = ''; await go('products'); return; }
    if (form.id === 'quick-form') {
      const r = applyQuickOrder(f.lines); if (!r.added && !r.unknown.length && !r.out.length) throw Error('品番と数量を入力してください。');
      const notes = [r.unknown.length && `見つからない品番：${r.unknown.join('、')}`, r.out.length && `欠品中：${r.out.join('、')}`, r.short.length && `在庫の数までにしました：${r.short.join('、')}`].filter(Boolean);
      if (!r.added) throw Error(notes.join('　'));
      closeModal(); shell(); toast(`${r.added}商品をカートに入れました。${notes.join('　')}`); return;
    }
    if (form.id === 'login-form') { const { operator: op } = await platform('/operator/login', 'POST', f); if (op.role !== 'salon') { await platform('/operator/logout', 'POST', {}); throw Error('この画面は加盟店（美容室）のアカウント専用です。'); } operator = op; page = 'home'; await load(); shell(); return; }
    if (form.id === 'staff-form') { await platform(staffUrl(), 'POST', { name: f.name }); await loadStaff(); shell(); toast(`${f.name.trim()} を追加しました。お客様の選択肢に表示されます。`); return; }
    if (form.id === 'staff-rename-form') { await platform(staffUrl(form.dataset.staffId), 'PATCH', { name: f.name }); await loadStaff(); closeModal(); shell(); toast('スタッフ名を変更しました。'); return; }
    if (form.id === 'staff-delete-form') { await platform(staffUrl(form.dataset.staffId), 'DELETE', { transferTo: f.transferTo || '' }); await loadStaff(); closeModal(); shell(); toast('スタッフを削除しました。'); return; }
    const items = cartLines().map(p => ({ id: p.id, quantity: p.quantity, price: p.wholesalePrice }));
    if (form.id === 'supply-form') {
      if (busy) return; busy = true;
      try { requestKey ??= crypto.randomUUID(); const o = await platform('/supply/orders', 'POST', { requestKey, items, note: f.note, source: cartSource }); setCart({}); await load(); closeModal(); page = 'home'; shell(); scrollTo({ top: 0 }); toast(`発注しました（${o.id}）。本部が受け付けるとお知らせします。`); }
      finally { busy = false; }
    }
    if (form.id === 'subscription-form') { await platform('/supply/subscriptions', 'POST', { interval: f.interval, startOn: f.startOn, items: items.map(({ id, quantity }) => ({ id, quantity })) }); setCart({}); await load(); closeModal(); page = 'subscriptions'; shell(); toast('定期発注を登録しました。'); }
  } catch (error) { formError(error); } finally { if (b) b.disabled = false; }
});
start().catch(error => { $('#app').innerHTML = empty('発注画面を読み込めませんでした', error.message, '<button class="btn primary" id="retry">再読み込み</button>'); $('#retry').onclick = () => location.reload(); });
