// メール送信（パスワード再設定など）。SMTP_URL があれば SMTP で送り、なければ送らずに mail_outbox に保存して
// サーバーの画面に表示する（ローカル版）。宛先と本文は暗号化して保存し、SMTP で送った場合は本文を保存しない。
import { createFieldCrypto } from './db/crypto.mjs';

export function createMailer(db, { fieldCrypto, env = process.env, log = console.log } = {}) {
  const c = fieldCrypto || createFieldCrypto(null);
  const from = env.MAIL_FROM || 'SALON STATION <no-reply@example.test>';
  const record = (to, subject, body, transport, status, error = '') => db.run('INSERT INTO mail_outbox (to_address, subject, body, transport, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.encrypt(to), subject, c.encrypt(body), transport, status, String(error).slice(0, 300), new Date().toISOString()]);
  let transport;
  async function smtp() {
    if (!transport) {
      let nodemailer;
      try { nodemailer = (await import('nodemailer')).default; } catch { throw Error('SMTP で送るには `npm install nodemailer` を実行してください。'); }
      transport = nodemailer.createTransport(env.SMTP_URL);
    }
    return transport;
  }
  return {
    mode: env.SMTP_URL ? 'smtp' : 'outbox',
    async send({ to, subject, text }) {
      if (!env.SMTP_URL) {
        await record(to, subject, text, 'outbox', 'saved');
        log(`[メール：ローカル版のため送信していません] 宛先 ${to} / 件名 ${subject}\n${text}`);
        return;
      }
      try { await (await smtp()).sendMail({ from, to, subject, text }); await record(to, subject, '', 'smtp', 'sent'); }
      catch (error) { await record(to, subject, '', 'smtp', 'failed', error.message); throw error; }
    },
  };
}
