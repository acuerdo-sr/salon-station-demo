import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberStore, SESSION_AGE } from '../dist/member-store.js';
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };
const profile = email => ({ salon: 'テストサロン', name: 'テスト担当', email, password: 'Demo-Member-2026', agreePrivacy: true });

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

test('Pages storage failure does not leave a signed-in phantom member', async () => {
  const session = memory();
  const data = { getItem: () => null, setItem: () => { throw Error('quota'); } };
  const members = createMemberStore(data, session, 'members');
  await assert.rejects(members.request('/auth/register', 'POST', profile('a@example.test')), /保存できません/);
  assert.equal(members.current(), null);
});
