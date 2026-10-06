// LINE連携（仕様書 2.2.7 ② / 2.4）：LINEログイン（OAuth 2.0 + OpenID Connect）、LIFF（LINEミニアプリ）、
// Messaging API による注文・出荷通知。チャネル情報は環境変数から受け取り、未設定なら機能を閉じる。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function lineConfigFromEnv(env = process.env, origin) {
  const channelId = env.LINE_CHANNEL_ID || '', channelSecret = env.LINE_CHANNEL_SECRET || '';
  const publicOrigin = (env.PUBLIC_ORIGIN || origin).replace(/\/$/, '');
  return {
    enabled: Boolean(channelId && channelSecret),
    channelId, channelSecret,
    liffId: env.LIFF_ID || '',
    messagingToken: env.LINE_MESSAGING_TOKEN || '',
    scope: env.LINE_SCOPE || 'profile openid',
    publicOrigin,
    callbackUrl: env.LINE_CALLBACK_URL || `${publicOrigin}/api/auth/line/callback`,
    apiBase: (env.LINE_API_BASE || 'https://api.line.me').replace(/\/$/, ''),
    authBase: (env.LINE_AUTH_BASE || 'https://access.line.me').replace(/\/$/, ''),
  };
}

// LINEログインの失敗理由。利用者に返すのはこのコードだけにし、画面の文言はクライアント側で固定する。
export const LINE_ERROR_CODES = ['cancelled', 'expired', 'conflict', 'failed'];
export const LINE_STATE_COOKIE = 'salon_line_state';
const STATE_AGE = 10 * 60 * 1000;
const MAX_STATES = 5000;

export function createLineAuth(auth, config, options = {}) {
  const states = new Map(); // state → { nonce, salonId, staffId, memberId, createdAt }
  const fetchImpl = options.fetch || fetch;
  function fail(message, status = 400, code = 'failed') { const error = new Error(message); error.status = status; error.code = code; throw error; }
  function cleanup() {
    const now = Date.now();
    for (const [key, value] of states) if (now - value.createdAt > STATE_AGE) states.delete(key);
    // 未認証で呼べる開始URLを連打されてもメモリが増え続けないよう、古いものから捨てる。
    while (states.size >= MAX_STATES) states.delete(states.keys().next().value);
  }
  const sameState = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  async function post(url, form, headers = {}) {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) fail(body.error_description || body.error || 'LINEとの通信に失敗しました。', 502);
    return body;
  }
  // IDトークンはLINEの検証エンドポイントで検証する（署名・有効期限・audience・nonce）。
  async function verifyIdToken(idToken, nonce) {
    const payload = await post(`${config.apiBase}/oauth2/v2.1/verify`, { id_token: idToken, client_id: config.channelId, ...(nonce ? { nonce } : {}) });
    if (!payload.sub) fail('LINEの認証情報を確認できませんでした。', 401);
    return payload;
  }
  const demoEmail = sub => `line-${createHash('sha256').update(sub).digest('hex').slice(0, 10)}@example.test`;
  // LINEのユーザーIDで会員を特定する。未登録なら簡略登録、ログイン中の会員がいればそのアカウントに連携する。
  async function resolveMember(payload, currentMember) {
    const existing = auth.findByLineId(payload.sub);
    if (currentMember) {
      if (existing && existing.id !== currentMember.id) fail('このLINEアカウントは別の会員に連携済みです。', 409, 'conflict');
      return existing || auth.linkLine(currentMember.id, payload.sub);
    }
    if (existing) return existing;
    const email = String(payload.email || '').trim().toLowerCase();
    const name = String(payload.name || '').trim().slice(0, 80) || 'LINE会員';
    return auth.createFromLine({ lineId: payload.sub, name, email: /@example\.test$/.test(email) ? email : demoEmail(payload.sub) });
  }
  function frontUrl(params) {
    const url = new URL('/', config.publicOrigin);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
    url.hash = 'catalog';
    return url.href;
  }
  return {
    config: { enabled: config.enabled, liffId: config.liffId, notifications: Boolean(config.messagingToken) },
    // LINEログイン開始：state と nonce を発行し、LINEの認可画面へ送る。QRの店舗・スタッフは state 側に保持する。
    // state は開始したブラウザの Cookie にも保存し、コールバックで照合する（ログインCSRF・連携の乗っ取り対策）。
    start(query, currentMember) {
      if (!config.enabled) fail('LINEログインは未設定です。README の「LINE連携の設定」を参照してください。', 404);
      cleanup();
      const state = randomBytes(16).toString('hex'), nonce = randomBytes(16).toString('hex');
      states.set(state, { nonce, salonId: String(query.get('salon') || '').slice(0, 20), staffId: String(query.get('staff') || '').slice(0, 20), memberId: currentMember?.id || '', createdAt: Date.now() });
      const url = new URL('/oauth2/v2.1/authorize', config.authBase);
      url.search = new URLSearchParams({ response_type: 'code', client_id: config.channelId, redirect_uri: config.callbackUrl, state, scope: config.scope, nonce }).toString();
      return { url: url.href, state };
    },
    async callback(query, browserState) {
      if (!config.enabled) fail('LINEログインは未設定です。', 404);
      cleanup();
      const state = query.get('state') || '';
      if (query.get('error')) { states.delete(state); fail(query.get('error_description') || 'LINEログインがキャンセルされました。', 401, 'cancelled'); }
      const saved = states.get(state);
      if (!saved || !sameState(state, browserState)) fail('ログインの有効期限が切れました。もう一度お試しください。', 400, 'expired');
      states.delete(state);
      const code = query.get('code');
      if (!code) fail('LINEから認証コードを受け取れませんでした。');
      const token = await post(`${config.apiBase}/oauth2/v2.1/token`, { grant_type: 'authorization_code', code, redirect_uri: config.callbackUrl, client_id: config.channelId, client_secret: config.channelSecret });
      if (!token.id_token) fail('LINEからIDトークンを受け取れませんでした。', 502);
      const payload = await verifyIdToken(token.id_token, saved.nonce);
      const current = saved.memberId ? auth.findById(saved.memberId) : null;
      const member = await resolveMember(payload, current);
      return { member, redirect: frontUrl({ shop_id: saved.salonId, staff: saved.staffId, line: current ? 'linked' : 'ok' }) };
    },
    // LIFF（LINEアプリ内）：クライアントが取得したIDトークンを検証してセッションを作る。
    async liff(input, currentMember) {
      if (!config.enabled) fail('LINEログインは未設定です。', 404);
      if (typeof input?.idToken !== 'string' || !input.idToken) fail('LINEのIDトークンがありません。');
      const payload = await verifyIdToken(input.idToken);
      return resolveMember(payload, currentMember);
    },
    // Messaging API：LINE連携済みの会員へテキスト通知。トークン未設定なら何もしない。
    async notify(lineId, text) {
      if (!config.messagingToken || !lineId) return false;
      const response = await fetchImpl(`${config.apiBase}/v2/bot/message/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.messagingToken}` }, body: JSON.stringify({ to: lineId, messages: [{ type: 'text', text: String(text).slice(0, 5000) }] }) });
      if (!response.ok) throw Error('LINE通知の送信に失敗しました: HTTP ' + response.status);
      return true;
    },
    errorRedirect(code) { return frontUrl({ line: 'error', reason: LINE_ERROR_CODES.includes(code) ? code : 'failed' }); },
    pendingStates: () => states.size,
  };
}
