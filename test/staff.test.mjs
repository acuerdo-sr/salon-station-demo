// 担当スタッフの管理：美容室は自店、本部は全店舗のスタッフを追加・名前の変更・並び替え・削除できる。
// 名前を変えても担当のお客様は外れず、削除するときは担当のお客様を引き継ぐ。過去の注文の担当者名は残る。ブラウザ版と DB版で同じ規則。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators } from '../dist/platform-core.js';
import { engines, linkMember } from './helpers/engines.mjs';

const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] };
const home = { name: '個人 太郎', postal: '1000001', prefecture: '東京都', city: '千代田区', street: '1-1', phone: '0312345678' };

for (const [name, create] of engines('2026-10-06T03:00:00.000Z')) {
  test(`${name}: salons add, rename, reorder and delete their staff; customers keep or hand over their staff`, async () => {
    const e = await create();
    try {
      const staffOf = async (salonId = 'lumiere') => (await e.call('/admin/snapshot', 'GET', undefined, admin)).salons.find(s => s.id === salonId).staff;
      const url = (id = '') => `/admin/salons/lumiere/staff${id ? '/' + id : ''}`;
      // 追加（美容室は自店だけ。名前は店舗内で重ならない）
      let list = await e.call(url(), 'POST', { name: ' MIKU ' }, salonOp);
      const miku = list.find(s => s.name === 'MIKU');
      assert.deepEqual(list.map(s => s.name), ['HARUKA', 'YUI', 'MIKU']);
      await assert.rejects(e.call(url(), 'POST', { name: 'MIKU' }, salonOp), /同じ名前/);
      await assert.rejects(e.call(url(), 'POST', { name: '' }, salonOp), /スタッフ名を入力/);
      await assert.rejects(e.call(url(), 'POST', { name: 'x'.repeat(41) }, salonOp), /40文字/);
      await assert.rejects(e.call('/admin/salons/atelier/staff', 'POST', { name: 'SORA' }, salonOp), /他店舗/);
      await assert.rejects(e.call(url(), 'POST', { name: 'SORA' }, sena), /権限/);
      assert.ok((await e.call('/admin/salons/atelier/staff', 'POST', { name: 'SORA' }, admin)).some(s => s.name === 'SORA'), '本部はどの店舗にも追加できる');
      // サロンがお客様の担当に設定し、注文に担当者名が残る
      const taro = await e.member('kojin-taro', '個人 太郎'), hanako = await e.member('kojin-hanako', '個人 花子');
      for (const m of [taro, hanako]) { await e.call('/profile', 'PATCH', { salonId: 'lumiere' }, m); await e.call(`/admin/members/${m.member.id}/staff`, 'PATCH', { staffId: miku.id }, salonOp); }
      const before = await e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: [{ id: 'shampoo-moist', quantity: 1, price: 2860 }], customer: home }, taro);
      assert.equal(before.staffName, 'MIKU');
      const summary = await e.call(url(), 'GET', undefined, salonOp);
      assert.deepEqual(summary.staff.map(s => [s.name, s.members]).find(([n]) => n === 'MIKU'), ['MIKU', 2], '発注画面の一覧：担当のお客様の人数');
      assert.ok(summary.unassigned >= 0 && !JSON.stringify(summary).includes('kojin'), 'お客様の情報は含めない');
      await assert.rejects(e.call('/admin/salons/atelier/staff', 'GET', undefined, salonOp), /他店舗/);
      await assert.rejects(e.call(url(), 'GET', undefined, sena), /権限/);
      const stats = (await e.call('/admin/snapshot', 'GET', undefined, salonOp)).staffStats;
      assert.equal(stats.find(x => x.salonId === 'lumiere' && x.staffId === miku.id).members, 2, '担当のお客様の人数');
      assert.ok(!stats.some(x => x.salonId === 'atelier'), '美容室には他店舗の人数を見せない');
      // 名前の変更：IDは変わらず、担当のお客様もそのまま。過去の注文の担当者名は変わらない
      list = await e.call(url(miku.id), 'PATCH', { name: 'MIKU（店長）' }, salonOp);
      assert.equal(list.find(s => s.id === miku.id).name, 'MIKU（店長）');
      await assert.rejects(e.call(url(miku.id), 'PATCH', { name: 'HARUKA' }, salonOp), /同じ名前/);
      assert.equal((await e.call('/profile', 'GET', undefined, taro)).staffId, miku.id);
      assert.equal((await e.call('/orders', 'GET', undefined, taro))[0].staffName, 'MIKU');
      // 並び替え（お客様の選択肢の順番）
      list = await e.call(url(miku.id), 'PATCH', { move: -1 }, salonOp);
      assert.deepEqual(list.map(s => s.name), ['HARUKA', 'MIKU（店長）', 'YUI']);
      await e.call(url(miku.id), 'PATCH', { move: -1 }, salonOp);
      assert.deepEqual((await staffOf()).map(s => s.name), ['MIKU（店長）', 'HARUKA', 'YUI']);
      assert.deepEqual((await e.call(url(miku.id), 'PATCH', { move: -1 }, salonOp)).map(s => s.name), ['MIKU（店長）', 'HARUKA', 'YUI'], '先頭より上には動かない');
      await assert.rejects(e.call(url(miku.id), 'PATCH', { move: 3 }, salonOp), /並び順/);
      // 削除：担当のお客様を引き継ぐ（引き継ぎ先は同じ店舗の別のスタッフか、指名なし）
      await assert.rejects(e.call(url(miku.id), 'DELETE', { transferTo: miku.id }, salonOp), /引き継ぎ先/);
      await assert.rejects(e.call(url(miku.id), 'DELETE', { transferTo: 'mio' }, salonOp), /引き継ぎ先/);
      list = await e.call(url(miku.id), 'DELETE', { transferTo: 'haruka' }, salonOp);
      assert.deepEqual(list.map(s => s.name), ['HARUKA', 'YUI']);
      assert.equal((await e.call('/profile', 'GET', undefined, taro)).staffId, 'haruka');
      assert.equal((await e.call('/profile', 'GET', undefined, hanako)).staffId, 'haruka');
      assert.equal((await e.call('/orders', 'GET', undefined, taro))[0].staffName, 'MIKU', '過去の注文の担当者名は残る');
      await assert.rejects(e.call(`/admin/members/${taro.member.id}/staff`, 'PATCH', { staffId: miku.id }, salonOp), /担当スタッフ/, '削除したスタッフは選べない');
      await assert.rejects(e.call(url(miku.id), 'DELETE', {}, salonOp), /見つかりません/);
      // 指名なしへ引き継ぐ
      await e.call(url('haruka'), 'DELETE', { transferTo: '' }, salonOp);
      assert.equal((await e.call('/profile', 'GET', undefined, taro)).staffId, '');
      const snap = await e.call('/admin/snapshot', 'GET', undefined, admin);
      assert.equal(snap.staffStats.find(x => x.salonId === 'lumiere' && x.staffId === '').members >= 2, true);
      const events = JSON.stringify(snap.events);
      for (const label of ['スタッフを追加（MIKU）', 'スタッフ名を変更（MIKU→MIKU（店長））', 'スタッフの並び順を変更', 'スタッフを削除（MIKU（店長）・担当2人はHARUKAへ）']) assert.ok(events.includes(label), label);
      assert.match(events, /スタッフを削除（HARUKA・担当\d+人は指名なしへ）/, 'サンプル会員を含む人数');
      // 30名まで
      for (let i = (await staffOf()).length; i < 30; i++) await e.call(url(), 'POST', { name: `STAFF ${i}` }, salonOp);
      await assert.rejects(e.call(url(), 'POST', { name: 'STAFF 31' }, salonOp), /30名まで/);
    } finally { await e.close(); }
  });
}
