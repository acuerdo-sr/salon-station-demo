// 顧客データの扱い：お客様の情報は担当サロンのもの。本部の画面には個人を特定できる情報を渡さず、集計値と会員番号だけを渡す。
// ディーラーには発送に必要なお名前・お届け先だけを渡す。ブラウザ版と DB版で同じ結果になることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators } from '../dist/platform-core.js';
import { memberRef, PRIVACY_VERSION, privacyPolicy } from '../dist/privacy.js';
import { formatAddress } from '../dist/person.js';
import { createMemberStore } from '../dist/member-store.js';
import { engines, linkMember } from './helpers/engines.mjs';

const now = '2026-10-06T03:00:00.000Z';
const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] };
const secret = { name: '個人 太郎', postal: '1234567', prefecture: '東京都', city: '秘密市', street: '9-8-7', building: '秘密ハイツ101', phone: '09012345678' };
secret.address = formatAddress(secret);

test('member numbers are stable, pseudonymous and the policy is versioned', () => {
  assert.equal(memberRef('kojin-taro'), 'M-OJINTARO');
  assert.equal(memberRef('3f2a9c1e-0b7d-4e55-9a10-77c2d4e8b901'), 'M-D4E8B901');
  assert.match(PRIVACY_VERSION, /^\d{4}-\d{2}$/); assert.ok(privacyPolicy.length >= 4);
});

test('browser member store: registration requires consent and records the policy version', async () => {
  const mem = () => { const d = new Map(); return { getItem: k => d.get(k) ?? null, setItem: (k, v) => d.set(k, v), removeItem: k => d.delete(k) }; };
  const members = createMemberStore(mem(), mem(), 'm');
  const input = { salon: 'x', name: 'テスト 会員', kana: 'テスト カイイン', email: 'c@example.test', password: 'Demo-Member-2026' };
  await assert.rejects(members.request('/auth/register', 'POST', input), /同意/);
  await assert.rejects(members.request('/auth/register', 'POST', { ...input, agreePrivacy: 'yes' }), /同意/);
  const created = (await members.request('/auth/register', 'POST', { ...input, agreePrivacy: true })).member;
  assert.equal(created.privacyVersion, PRIVACY_VERSION); assert.ok(created.privacyAgreedAt);
  await assert.rejects(members.request('/auth/line/demo', 'POST', {}), /同意/);
});

for (const [name, create] of engines(now)) {
  const run = (title, body) => test(`${name}: ${title}`, async () => { const e = await create(); try { await body(e); } finally { await e.close(); } });

  run('headquarters sees aggregates and member numbers only; the salon sees its customers; dealers see what they need to ship', async e => {
    const customer = await e.member('kojin-taro', secret.name), ref = memberRef('kojin-taro');
    await linkMember(e.call, customer, 'lumiere', 'haruka');
    const order = await e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: [{ id: 'shampoo-moist', quantity: 1, price: 2860 }], customer: secret }, customer);
    await e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: [{ id: 'oil-smooth', quantity: 1, price: 2640 }], customer: secret }, customer);
    const hq = await e.call('/admin/snapshot', 'GET', undefined, admin), hqText = JSON.stringify(hq);
    for (const value of [secret.name, secret.address, secret.city, secret.postal, secret.phone, 'kojin-taro@example.test', '"kojin-taro"']) assert.ok(!hqText.includes(value), `本部に ${value} が渡っています`);
    assert.deepEqual(hq.profiles, []);
    const hqOrder = hq.orders.find(o => o.id === order.id);
    assert.equal(hqOrder.customerRef, ref); assert.equal(hqOrder.customer.name, `会員 ${ref}`); assert.equal(hqOrder.customer.address, ''); assert.equal(hqOrder.memberId, undefined);
    assert.ok(hq.purchaseOrders.filter(p => p.orderId === order.id).every(p => p.customer.ref === ref && !p.customer.address));
    assert.ok(hq.events.some(ev => ev.actor === `会員 ${ref}` && ev.reference === order.id));
    const lumiere = hq.customerStats.find(s => s.salonId === 'lumiere');
    assert.equal(hq.customerStats.length, 3); assert.ok(lumiere.members >= 1); assert.ok(lumiere.purchasers >= 1); assert.ok(lumiere.repeaters >= 1);
    assert.equal(lumiere.repeatRate, Math.round(lumiere.repeaters / lumiere.purchasers * 1000) / 10);
    assert.equal(lumiere.newThisMonth >= 1, true);
    // サロンは自店のお客様の全項目と会員番号を見られる
    const own = await e.call('/admin/snapshot', 'GET', undefined, salonOp), ownText = JSON.stringify(own);
    for (const value of [secret.name, secret.address, 'kojin-taro@example.test']) assert.ok(ownText.includes(value));
    assert.equal(own.profiles.find(p => p.id === 'kojin-taro').ref, ref); assert.equal(own.orders.find(o => o.id === order.id).customerRef, ref);
    assert.deepEqual(own.customerStats.map(s => s.salonId), ['lumiere']);
    // ディーラーは発送に必要なお名前・お届け先だけ。メールアドレスと会員の一覧は渡さない
    const dealer = await e.call('/admin/snapshot', 'GET', undefined, sena), dealerText = JSON.stringify(dealer);
    assert.ok(dealerText.includes(secret.address)); assert.ok(!dealerText.includes('kojin-taro@example.test'));
    assert.deepEqual(dealer.profiles, []); assert.deepEqual(dealer.customerStats, []);
    assert.ok(dealer.purchaseOrders.every(p => p.customer.email === undefined));
  });

  run('headquarters re-links a customer by member number without seeing who it is', async e => {
    const customer = await e.member('kojin-taro', secret.name), ref = memberRef('kojin-taro');
    await linkMember(e.call, customer, 'lumiere', 'haruka');
    await assert.rejects(e.call(`/admin/members/${ref}`, 'PATCH', { salonId: 'atelier', staffId: 'mio' }, salonOp), /権限/);
    await assert.rejects(e.call('/admin/members/M-NOTFOUND', 'PATCH', { salonId: 'atelier' }, admin), /会員番号/);
    const moved = await e.call(`/admin/members/${ref.toLowerCase()}`, 'PATCH', { salonId: 'atelier', staffId: 'mio' }, admin);
    assert.deepEqual(moved, { ref, salonId: 'atelier', staffId: 'mio' });
    assert.equal((await e.call('/profile', 'GET', undefined, customer)).salonId, 'atelier');
    const events = (await e.call('/admin/snapshot', 'GET', undefined, admin)).events;
    assert.ok(events.some(ev => ev.action === '会員の担当店舗を変更' && ev.reference === ref));
    assert.ok(!JSON.stringify(events).includes('kojin-taro'));
  });
}
