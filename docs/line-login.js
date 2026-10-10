// LINEログイン・LIFF のクライアント側。ローカル版はサーバーの設定を問い合わせ、公開版（GitHub Pages）は体験用の疑似ログインになる。
import { api, isPages } from './api-client.js?v=de28f620d4';
let configPromise;
export function lineConfig() {
  configPromise ??= isPages ? Promise.resolve({ enabled: true, demo: true, liffId: '', orderLiffId: '', notifications: false }) : api('/auth/line/config').then(c => ({ demo: false, ...c })).catch(() => ({ enabled: false, demo: false, liffId: '' }));
  return configPromise;
}
// LINEログイン開始URL。QRコードのサロンはサーバー側で保持し、登録完了後に紐付ける（担当スタッフはサロンが設定する）。
export function lineStartUrl({ salonId } = {}) {
  const url = new URL('/api/auth/line/start', location.href);
  if (salonId) url.searchParams.set('salon', salonId);
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
// 加盟店の発注画面（LIFF）：LINEアプリ内で開かれたときだけ IDトークンを返す。通常のブラウザでは null。
export async function liffIdToken(liffId) {
  if (!liffId || isPages) return null;
  if (typeof window.liff === 'undefined' && !(await loadSdk())) return null;
  try {
    await window.liff.init({ liffId });
    if (!window.liff.isInClient()) return null;
    if (!window.liff.isLoggedIn()) { window.liff.login({ redirectUri: location.href }); return null; }
    return window.liff.getIDToken() || null;
  } catch (error) { console.error('LIFF:', error.message); return null; }
}
