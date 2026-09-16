// LINEログイン・LIFF のクライアント側。ローカル版はサーバーの設定を問い合わせ、公開版（GitHub Pages）は体験用の疑似ログインになる。
import { api, isPages } from './api-client.js';
let configPromise;
export function lineConfig() {
  configPromise ??= isPages ? Promise.resolve({ enabled: true, demo: true, liffId: '', notifications: false }) : api('/auth/line/config').then(c => ({ demo: false, ...c })).catch(() => ({ enabled: false, demo: false, liffId: '' }));
  return configPromise;
}
// LINEログイン開始URL。QR経由の店舗・担当スタッフはサーバー側で保持し、登録完了後に紐付ける。
export function lineStartUrl({ salonId, staffId } = {}) {
  const url = new URL('/api/auth/line/start', location.href);
  if (salonId) url.searchParams.set('salon', salonId);
  if (staffId) url.searchParams.set('staff', staffId);
  return url.href;
}
function loadSdk() {
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
}
// LIFF（LINEミニアプリ）：LINEアプリ内で開かれたとき、LIFFのIDトークンでサーバーのセッションを作る。
// 通常のブラウザで開かれた場合は何もしない（LINEログインボタンを使う）。
export async function initLiff(liffId) {
  if (!liffId || isPages) return false;
  if (typeof window.liff === 'undefined' && !(await loadSdk())) return false;
  try {
    await window.liff.init({ liffId });
    if (!window.liff.isInClient()) return false;
    if (!window.liff.isLoggedIn()) { window.liff.login({ redirectUri: location.href }); return false; }
    const idToken = window.liff.getIDToken();
    if (!idToken) return false;
    await api('/auth/line/liff', { method: 'POST', body: JSON.stringify({ idToken }) });
    return true;
  } catch (error) {
    console.error('LIFF:', error.message);
    return false;
  }
}
