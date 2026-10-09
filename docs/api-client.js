export const isPages = document.querySelector('meta[name="site-mode"]')?.content === 'github-pages';
let membersPromise;

// 公開版（GitHub Pages）の会員機能はブラウザ内の体験用。商品・注文は platform-client.js が扱う。
async function demoApi(route, options) {
  membersPromise ??= import('./member-store.js?v=df0c901379').then(module => module.createMemberStore(localStorage, sessionStorage, `salon-demo-members-v1:${new URL('.', import.meta.url).pathname}`));
  const members = await membersPromise;
  if (!route.startsWith('/auth/')) throw Error('この操作は利用できません。');
  const perform = () => members.request(route, options.method || 'GET', options.body ? JSON.parse(options.body) : undefined);
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
