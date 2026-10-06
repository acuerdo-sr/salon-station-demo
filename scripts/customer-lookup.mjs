// 保守ツール：会員番号を指定して、お客様1人分の情報を復号して表示する。
// DBを直接開いても個人情報は暗号化された値しか見えないため、問い合わせ対応などで中身が必要なときはこのツールを使う。
// 担当者名と目的は必須で、参照するたびにアクセス記録（data_access_logs）に残る。記録は管理画面の「アクセス記録」で本部と担当サロンが確認できる。
//
//   npm run customer:lookup -- --ref M-1A2B3C4D --by "山田（本部）" --purpose "お問い合わせ対応（配送先の確認）"
import { parseArgs } from 'node:util';
import { genderNames } from '../dist/member-store.js';
import { openStore } from './open-store.mjs';

let db;
try {
  const { values } = parseArgs({ options: { ref: { type: 'string' }, by: { type: 'string' }, purpose: { type: 'string' } } });
  const opened = await openStore({ mustExist: true, createKey: false });
  db = opened.db;
  await opened.store.init();
  const m = await opened.store.lookupMember(values);
  console.log([
    `会員番号：${m.ref}`,
    `お名前：${m.name}${m.kana ? `（${m.kana}）` : ''}`,
    `メール：${m.email}`,
    `電話：${m.phone || '—'}`,
    `性別：${genderNames[m.gender || ''] || '—'}　生年月日：${m.birthday || '—'}`,
    `担当店舗：${m.salonId || '—'}　担当スタッフ：${m.staffId || '指名なし'}　LINE連携：${m.lineLinked ? 'あり' : 'なし'}`,
    `お届け先：${m.address ? `〒${m.address.postal} ${m.address.address}（${m.address.name} 様）` : '—'}`,
    `購入回数：${m.orders} 回`,
    '',
    `この参照はアクセス記録に残りました（担当者：${values.by.trim()}、目的：${values.purpose.trim()}）。`,
  ].join('\n'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await db?.close(); }
