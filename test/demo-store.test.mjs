import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../dist/demo-store.js';
import { products } from '../catalog.mjs';

const memory = () => {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
};
const customer = { salon: 'テストサロン', name: 'テスト担当', email: 'salon@example.test', address: '架空の住所', note: '' };
const payload = (quantity = 1) => ({ items: [{ id: 'shampoo-moist', quantity, price: 2860 }], customer, requestKey: crypto.randomUUID() });

test('Pages demo saves orders, preserves prices, survives reload and isolates visitors', () => {
  const storage = memory();
  const api = createDemoStore(products, storage, 'shop');
  const orderInput = payload(2);
  const first = api('/orders', 'POST', orderInput);
  assert.equal(first.total, 6380);
  assert.equal(api('/orders', 'POST', orderInput).id, first.id);
  assert.equal(api('/orders').length, 1);
  assert.equal(api('/products')[0].stock, 22);
  api('/products/shampoo-moist', 'PATCH', { price: 3000, stock: 22 });
  const reload = createDemoStore(products, storage, 'shop');
  assert.equal(reload('/products')[0].price, 3000);
  assert.equal(reload('/orders')[0].items[0].price, 2860);
  const anotherVisitor = createDemoStore(products, memory(), 'shop');
  assert.equal(anotherVisitor('/orders').length, 0);
  assert.equal(anotherVisitor('/products')[0].stock, 24);
});

test('Pages rejects invalid and oversold orders without partial writes', () => {
  const api = createDemoStore(products, memory(), 'shop');
  for (const qty of [0, -1, 1.5, 25, '1']) assert.throws(() => api('/orders', 'POST', payload(qty)));
  assert.throws(() => api('/orders', 'POST', { ...payload(), customer: { ...customer, email: 'invalid' } }));
  assert.throws(() => api('/quote', 'POST', { items: [{ id: 'shampoo-moist', quantity: 1, price: 1 }] }));
  assert.equal(api('/products')[0].stock, 24);
  assert.equal(api('/orders').length, 0);
  assert.equal(api('/quote', 'POST', payload(4)).shipping, 0);
  api('/products/shampoo-moist', 'PATCH', { price: 2860, stock: 1 });
  api('/orders', 'POST', payload());
  assert.throws(() => api('/orders', 'POST', payload()));
});

test('Pages storage errors never report a saved order', () => {
  const storage = { getItem: () => null, setItem: () => { throw Error('Quota'); } };
  const api = createDemoStore(products, storage, 'shop');
  assert.throws(() => api('/orders', 'POST', payload()), /保存できません/);
  assert.equal(api('/orders').length, 0);
  assert.equal(api('/products')[0].stock, 24);
});
