export const isPages = document.querySelector('meta[name="site-mode"]')?.content === 'github-pages';
export const storagePlace = isPages ? 'このブラウザ' : 'このPC';
export const cartKey = isPages ? `salon-demo-cart:${new URL('.', import.meta.url).pathname}` : 'salon-cart';
let storePromise;

async function demoApi(route, options) {
  storePromise ??= Promise.all([
    import('./demo-store.js'),
    import('./member-store.js'),
    fetch(new URL('./catalog.json', import.meta.url)).then(response => {
      if (!response.ok) throw Error('商品データを取得できません。');
      return response.json();
    }),
  ]).then(([commerceModule, memberModule, products]) => {
    const path = new URL('.', import.meta.url).pathname;
    const members = memberModule.createMemberStore(localStorage, sessionStorage, `salon-demo-members-v1:${path}`);
    const commerce = commerceModule.createDemoStore(products, localStorage, `salon-demo-state-v1:${path}`, members.current);
    return { members, commerce };
  });
  const store = await storePromise;
  const perform = () => route.startsWith('/auth/')
    ? store.members.request(route, options.method || 'GET', options.body ? JSON.parse(options.body) : undefined)
    : store.commerce(route, options.method || 'GET', options.body ? JSON.parse(options.body) : undefined);
  // Serialize updates across tabs that share this demo's browser storage.
  if (navigator.locks?.request) return navigator.locks.request(`salon-demo:${new URL('.', import.meta.url).pathname}`, perform);
  return perform();
}

export async function api(route, options = {}) {
  if (isPages) return demoApi(route, options);
  const response = await fetch('/api' + route, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || '処理に失敗しました。');
  return body;
}
