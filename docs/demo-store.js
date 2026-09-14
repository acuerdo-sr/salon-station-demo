// GitHub Pages only: simulated commerce state stays in the visitor's browser.
export function createDemoStore(initialProducts, storage, key, currentMember = () => null) {
  function read() {
    const raw = storage.getItem(key);
    if (!raw) return { version: 1, overrides: {}, orders: [] };
    let state;
    try { state = JSON.parse(raw); } catch { throw Error('保存データを読み込めません。ブラウザのサイトデータをご確認ください。'); }
    if (state?.version !== 1 || !state.overrides || !Array.isArray(state.orders)) throw Error('保存データの形式が正しくありません。');
    return state;
  }
  function write(state) {
    try { storage.setItem(key, JSON.stringify(state)); }
    catch { throw Error('ブラウザに保存できません。サイトデータの保存を許可してからお試しください。'); }
  }
  function catalog(state) {
    return initialProducts.map(p => {
      const override = state.overrides[p.id];
      if (override && (!Number.isInteger(override.price) || override.price < 1 || override.price > 1000000 || !Number.isInteger(override.stock) || override.stock < 0 || override.stock > 99999)) throw Error('商品の保存データが正しくありません。');
      return { ...p, ...(override ? { price: override.price, stock: override.stock } : {}) };
    });
  }
  function quote(input, state) {
    if (!Array.isArray(input?.items) || !input.items.length || input.items.length > 50) throw Error('カートに商品を追加してください。');
    const seen = new Set();
    const products = catalog(state);
    const items = input.items.map(item => {
      if (!item || seen.has(item.id)) throw Error('商品指定が正しくありません。');
      seen.add(item.id);
      const p = products.find(p => p.id === item.id);
      if (!p) throw Error('商品が見つかりません。');
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw Error('数量は1〜99の整数で指定してください。');
      if (item.quantity > p.stock) throw Error(`${p.name}の在庫が不足しています（残り${p.stock}点）。`);
      if (item.price !== p.price) throw Error(`${p.name}の価格が変更されました。カートから確認し直してください。`);
      return { id: p.id, name: p.name, size: p.size, image: p.image, price: p.price, quantity: item.quantity };
    });
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = subtotal >= 11000 ? 0 : 660;
    return { items, subtotal, shipping, total: subtotal + shipping };
  }
  function customer(value) {
    const result = {};
    for (const [name, max] of Object.entries({ salon: 80, name: 80, email: 150, address: 250, note: 500 })) {
      if (typeof value?.[name] !== 'string' || value[name].length > max || (!value[name].trim() && name !== 'note')) throw Error('お届け先の入力内容を確認してください。');
      result[name] = value[name].trim();
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw Error('メールアドレスの形式を確認してください。');
    return result;
  }
  return function request(route, method = 'GET', input) {
    const state = read();
    const memberId = currentMember()?.id ?? null;
    if (route === '/products' && method === 'GET') return catalog(state);
    if (route === '/orders' && method === 'GET') return state.orders.filter(order => (order.memberId ?? null) === memberId).map(({ requestKey, ...order }) => order).reverse();
    if (route === '/quote' && method === 'POST') return quote(input, state);
    if (route === '/orders' && method === 'POST') {
      if (input?.memberId !== undefined && input.memberId !== memberId) throw Error('ログイン状態が変わりました。カートから確認し直してください。');
      if (!/^[a-f0-9-]{36}$/.test(input?.requestKey || '')) throw Error('注文の識別子が不正です。');
      const existing = state.orders.find(o => o.requestKey === input.requestKey);
      if (existing) { if ((existing.memberId ?? null) !== memberId) throw Error('この注文は取得できません。'); const { requestKey, ...order } = existing; return order; }
      const details = quote(input, state);
      const order = { id: 'DEMO-' + crypto.randomUUID().slice(0, 8).toUpperCase(), createdAt: new Date().toISOString(), status: 'テスト注文受付', memberId, customer: customer(input.customer), ...details };
      const products = catalog(state);
      for (const item of details.items) {
        const p = products.find(p => p.id === item.id);
        state.overrides[item.id] = { price: p.price, stock: p.stock - item.quantity };
      }
      state.orders.push({ ...order, requestKey: input.requestKey });
      write(state);
      return order;
    }
    if (route.startsWith('/products/') && method === 'PATCH') {
      const id = route.slice('/products/'.length);
      if (!initialProducts.some(p => p.id === id)) throw Error('商品が見つかりません。');
      if (!Number.isInteger(input?.price) || input.price < 1 || input.price > 1000000 || !Number.isInteger(input.stock) || input.stock < 0 || input.stock > 99999) throw Error('価格・在庫に有効な整数を入力してください。');
      state.overrides[id] = { price: input.price, stock: input.stock };
      write(state);
      return catalog(state).find(p => p.id === id);
    }
    throw Error('この操作は利用できません。');
  };
}
