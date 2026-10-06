// ログイン試行回数の制限。接続元IPとメールアドレスの組で数えるため、1人の誤入力で全員がロックされることはない。
// トンネルやリバースプロキシの配下では TRUST_PROXY=1 を設定すると X-Forwarded-For の先頭を接続元として扱う。
export function clientIp(req, trustProxy = process.env.TRUST_PROXY === '1') {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || '';
}

export function createLimiter({ max = 10, windowMs = 10 * 60 * 1000, maxEntries = 10000, now = Date.now } = {}) {
  const entries = new Map(); // key → { count, until }
  function prune() {
    const time = now();
    for (const [key, entry] of entries) if (entry.until <= time) entries.delete(key);
    // 期限内の記録が上限を超えた場合は古いものから捨てる（Map は挿入順）。
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  return {
    blocked(key) { const entry = entries.get(key); return Boolean(entry && entry.until > now() && entry.count >= max); },
    fail(key) {
      const entry = entries.get(key);
      if (entry && entry.until > now()) entry.count++;
      else { entries.delete(key); entries.set(key, { count: 1, until: now() + windowMs }); }
      if (entries.size > maxEntries / 2) prune();
    },
    reset(key) { entries.delete(key); },
    size: () => entries.size,
  };
}
