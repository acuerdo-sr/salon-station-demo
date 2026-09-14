import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberStore, SESSION_AGE } from '../dist/member-store.js';
import { createDemoStore } from '../dist/demo-store.js';
import { products } from '../catalog.mjs';
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };
const profile = email => ({ salon: 'テストサロン', name: 'テスト担当', email, password: 'Demo-Member-2026' });
const order = memberId => ({ memberId, items: [{ id: 'shampoo-moist', price: 2860, quantity: 1 }], requestKey: crypto.randomUUID(), customer: { salon: 'テストサロン', name: 'テスト担当', email: 'test@example.test', address: '架空の住所', note: '' } });

test('Pages membership registration, login, editing, expiry and password handling', async () => {
  const data = memory(), session = memory(); let now = Date.now();
  const members = createMemberStore(data, session, 'members', () => now);
  await assert.rejects(members.request('/auth/register', 'POST', profile('real@example.com')), /example.test/);
  await assert.rejects(members.request('/auth/register', 'POST', { ...profile('a@example.test'), password: 'short' }), /12/);
  const a = (await members.request('/auth/register', 'POST', profile('A@example.test'))).member;
  assert.equal(a.email, 'a@example.test'); assert.equal(a.hash, undefined);
  assert.ok(!data.getItem('members').includes('Demo-Member-2026'));
  await assert.rejects(members.request('/auth/register', 'POST', profile('a@example.test')), /登録済み/);
  assert.equal(createMemberStore(data, session, 'members', () => now).current().id, a.id);
  await members.request('/auth/logout', 'POST'); assert.equal(members.current(), null);
  await assert.rejects(members.request('/auth/profile', 'PATCH', { salon: 'x', name: 'x' }), /ログイン/);
  await assert.rejects(members.request('/auth/login', 'POST', { email: a.email, password: 'Wrong-Password' }), /違います/);
  assert.equal(members.current(), null);
  await members.request('/auth/login', 'POST', profile(a.email));
  const edited = await members.request('/auth/profile', 'PATCH', { salon: '変更後サロン', name: '変更後担当', email: 'b@example.test', id: 'forged' });
  assert.equal(edited.member.id, a.id); assert.equal(edited.member.email, a.email); assert.equal(edited.member.salon, '変更後サロン');
  now += SESSION_AGE + 1; assert.equal(members.current(), null);
});

test('Pages member orders are separated from other members and legacy guest orders', async () => {
  const data = memory(), session = memory();
  const members = createMemberStore(data, session, 'members');
  const store = createDemoStore(products, data, 'commerce', members.current);
  store('/orders', 'POST', order(null));
  const a = (await members.request('/auth/register', 'POST', profile('a@example.test'))).member;
  assert.equal(store('/orders').length, 0);
  const requestA = order(a.id), savedA = store('/orders', 'POST', requestA);
  assert.equal(store('/orders').length, 1);
  const b = (await members.request('/auth/register', 'POST', profile('b@example.test'))).member;
  assert.equal(store('/orders').length, 0);
  assert.throws(() => store('/orders', 'POST', requestA), /ログイン状態/);
  assert.throws(() => store('/orders', 'POST', { ...requestA, memberId: b.id }), /取得できません/);
  assert.equal(store('/products')[0].stock, 22);
  await members.request('/auth/logout', 'POST');
  assert.equal(store('/orders').length, 1); assert.equal(store('/orders')[0].memberId, null);
  await members.request('/auth/login', 'POST', profile(a.email));
  assert.equal(store('/orders')[0].id, savedA.id);
});

test('Pages storage failure does not leave a signed-in phantom member', async () => {
  const session = memory();
  const data = { getItem: () => null, setItem: () => { throw Error('quota'); } };
  const members = createMemberStore(data, session, 'members');
  await assert.rejects(members.request('/auth/register', 'POST', profile('a@example.test')), /保存できません/);
  assert.equal(members.current(), null);
});
