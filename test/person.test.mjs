// お客様の個人情報の入力ルール（dist/person.js）：姓・名、セイ・メイ、電話番号・郵便番号は数字だけ、住所は項目を分ける。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameInput, kanaInput, phoneInput, postalInput, addressPartsInput, formatAddress, encodeAddress, decodeAddress, formatPhone, formatPostal, splitName, PREFECTURES } from '../dist/person.js';
import { addressInput } from '../dist/platform-core.js';
import { engines } from './helpers/engines.mjs';

test('names are family and given name; furigana is katakana; digits, symbols and stray spaces are rejected', () => {
  assert.equal(nameInput(' 山田　太郎 '), '山田 太郎');
  assert.equal(nameInput('Smith John'), 'Smith John');
  for (const bad of ['山田太郎', '山田 太 郎', '山田 太郎1', '山田 <b>', '', '山田 ' + 'あ'.repeat(21)]) assert.throws(() => nameInput(bad), /お名前/, bad);
  assert.equal(kanaInput('やまだ たろう'), 'ヤマダ タロウ', 'ひらがなはカタカナに直す');
  assert.equal(kanaInput('ﾔﾏﾀﾞ ﾀﾛｳ'), 'ヤマダ タロウ', '半角カナは全角に直す');
  for (const bad of ['ヤマダタロウ', 'yamada tarou', '山田 タロウ']) assert.throws(() => kanaInput(bad), /フリガナ/, bad);
  assert.deepEqual(splitName('山田 太郎'), { last: '山田', first: '太郎' });
});

test('phone numbers and postal codes are stored as digits; addresses are split into prefecture, city, street and building', () => {
  assert.equal(phoneInput('０９０－１２３４－５６７８'), '09012345678');
  assert.equal(phoneInput('(03) 1234-5678'), '0312345678');
  assert.equal(phoneInput(''), '');
  for (const bad of ['12-3456-7890', '090-1234', '090-1234-56789', 'abc']) assert.throws(() => phoneInput(bad), /電話番号/, bad);
  assert.throws(() => phoneInput('', { required: true }), /電話番号を入力/);
  assert.equal(formatPhone('09012345678'), '090-1234-5678'); assert.equal(formatPhone('0312345678'), '0312345678');
  assert.equal(postalInput('１００－０００１'), '1000001'); assert.equal(formatPostal('1000001'), '100-0001');
  assert.throws(() => postalInput('100-001'), /7桁/);
  assert.equal(PREFECTURES.length, 47);
  const a = addressPartsInput({ prefecture: '東京都', city: ' 千代田区 ', street: '千代田１ー１', building: '' });
  assert.deepEqual(a, { prefecture: '東京都', city: '千代田区', street: '千代田1-1', building: '' }, '全角数字・長音の「ー」を半角のハイフンにそろえる');
  assert.throws(() => addressPartsInput({ prefecture: '架空県', city: 'x', street: '1' }), /都道府県/);
  assert.throws(() => addressPartsInput({ prefecture: '東京都', city: '', street: '1' }), /市区町村/);
  assert.throws(() => addressPartsInput({ prefecture: '東京都', city: '千代田区', street: '番地なし' }), /番地/);
  assert.throws(() => addressPartsInput({ prefecture: '東京都', city: '千代田区', street: '1-1', building: 'x'.repeat(61) }), /建物名/);
  assert.equal(formatAddress({ prefecture: '東京都', city: '千代田区', street: '1-1', building: 'ビル 5F' }), '東京都千代田区1-1 ビル 5F');
  // DBには項目を分けたまま保存し、以前の版の1つの文字列の住所も読める
  assert.deepEqual(decodeAddress(encodeAddress(a)), { ...a, address: '東京都千代田区千代田1-1' });
  assert.deepEqual(decodeAddress('大阪府大阪市北区1-2-3'), { prefecture: '大阪府', city: '', street: '大阪市北区1-2-3', building: '', address: '大阪府大阪市北区1-2-3' });
  // お届け先は電話番号も必須
  assert.throws(() => addressInput({ name: '山田 太郎', postal: '1000001', prefecture: '東京都', city: '千代田区', street: '1-1' }), /電話番号を入力/);
});

for (const [name, create] of engines('2026-10-06T03:00:00.000Z')) {
  test(`${name}: free-text addresses are rejected at checkout and in the address book`, async () => {
    const e = await create();
    try {
      const taro = await e.member('kojin-taro', '個人 太郎'); await e.call('/profile', 'PATCH', { salonId: 'lumiere', staffId: '' }, taro);
      const order = customer => e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: [{ id: 'shampoo-moist', quantity: 1, price: 2860 }], customer }, taro);
      await assert.rejects(order({ name: '個人 太郎', postal: '1000001', address: '東京都千代田区1-1', phone: '0312345678' }), /都道府県/);
      await assert.rejects(order({ name: '個人太郎', postal: '1000001', prefecture: '東京都', city: '千代田区', street: '1-1', phone: '0312345678' }), /姓と名/);
      const placed = await order({ name: '個人　太郎', postal: '100-0001', prefecture: '東京都', city: '千代田区', street: '千代田１－１', building: 'デモビル 3F', phone: '03-1234-5678' });
      assert.deepEqual([placed.customer.name, placed.customer.postal, placed.customer.street, placed.customer.phone, placed.customer.address], ['個人 太郎', '1000001', '千代田1-1', '0312345678', '東京都千代田区千代田1-1 デモビル 3F']);
      await assert.rejects(e.call('/addresses', 'POST', { name: '個人 太郎', postal: '1000001', prefecture: '東京都', city: '千代田区', street: '1-1' }, taro), /電話番号/);
    } finally { await e.close(); }
  });
}
