// 商品画像の保存（管理画面から登録した画像）。データフォルダの uploads/products に乱数のファイル名で保存し、
// サーバーは /uploads/products/<ファイル名> として配信する。形式と中身の確認は dist/catalog-core.js の decodeImage で行う。
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const UPLOAD_PATH = /^\/uploads\/products\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
export function createImageStore(root) {
  const dir = path.join(root, 'products');
  return {
    dir,
    save(bytes, ext) {
      mkdirSync(dir, { recursive: true });
      const name = `${randomUUID()}.${ext}`;
      writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
      return `uploads/products/${name}`;
    },
  };
}
