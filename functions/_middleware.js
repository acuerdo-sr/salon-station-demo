// Cloudflare Pages の確認用サイトに ID・パスワードをかける（ベーシック認証）。すべてのページ・画像・動画が対象。
// ID とパスワードは Cloudflare の管理画面で、環境変数（暗号化）SITE_USER / SITE_PASSWORD として登録する。このファイルには書かない。
// どちらかが未設定のときは、誰にも見せない（503）。検索エンジンにも載せない（X-Robots-Tag）。
const encoder = new TextEncoder();
const text = (body, status, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...headers } });

// 入力の長さや一致した位置で処理時間が変わらないよう、ハッシュどうしを最後まで比べる
async function same(a, b) {
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', encoder.encode(String(v)))));
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}
// Authorization: Basic base64(ID:パスワード)。日本語のパスワードも読めるよう UTF-8 として読む
export function credentials(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header || '');
  if (!m) return null;
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(m[1]), c => c.charCodeAt(0))); } catch { return null; }
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export async function onRequest({ request, env, next }) {
  const user = env?.SITE_USER, pass = env?.SITE_PASSWORD;
  if (!user || !pass) return text('確認用サイトのIDとパスワードが、まだ設定されていません。', 503);
  const given = credentials(request.headers.get('Authorization'));
  const okUser = given ? await same(given.user, user) : false, okPass = given ? await same(given.pass, pass) : false;
  if (!okUser || !okPass) return text('この確認用サイトを見るには、IDとパスワードが必要です。', 401, { 'WWW-Authenticate': 'Basic realm="SALON STATION preview", charset="UTF-8"' });
  const response = await next();
  const res = new Response(response.body, response);
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return res;
}
