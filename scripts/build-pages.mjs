import { mkdir, readdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { products } from '../catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs');
// 画像・動画は毎回作り直す（使わなくなった写真を残さない）
await rm(path.join(output, 'assets'), { recursive: true, force: true });
await mkdir(path.join(output, 'assets'), { recursive: true });
const scripts=['api-client.js','person.js','brands.js','member-store.js','privacy.js','access-log.js','payment-core.js','catalog-core.js','shipping-csv.js','platform.css','platform-core.js','supply-core.js','platform-client.js','ui-kit.js','storefront.js','admin.js','order.js','invoice-view.js','qr-code.js','line-login.js'];
// GitHub Pages は同じファイルを最大10分ブラウザに保存させるため、更新後も前の版が使われることがある。
// ファイルの中身から作った版（短い文字列）を参照に付けて、更新したら必ず新しいファイルが読まれるようにする
const hash = createHash('sha256');
for (const name of scripts) hash.update(await readFile(path.join(root, 'dist', name)));
hash.update(JSON.stringify(products));
const version = hash.digest('hex').slice(0, 10);
const withVersion = text => text
  .replace(/((?:from\s*|import\(\s*)['"])(\.\/[\w.-]+\.js)(['"])/g, `$1$2?v=${version}$3`)
  .replace(/(new URL\(\s*['"])(\.\/catalog\.json)(['"])/g, `$1$2?v=${version}$3`);
for (const name of scripts) {
  const src = path.join(root, 'dist', name);
  if (name.endsWith('.js')) await writeFile(path.join(output, name), withVersion(await readFile(src, 'utf8')));
  else await copyFile(src, path.join(output, name));
}
for(const page of ['index.html','shop.html','admin.html','order.html']){
let html = await readFile(path.join(root, 'dist', page==='index.html'?'shop.html':page), 'utf8');
html = html.replace(/((?:src|href)=["'])(\.\/[\w.-]+\.(?:js|css))(["'])/g, `$1$2?v=${version}$3`);
html = html.replace('<head>', '<head>\n <meta name="site-mode" content="github-pages">\n <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' data:; script-src \'self\'; style-src \'self\'; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">');
await writeFile(path.join(output,page),html);
}
await writeFile(path.join(output, 'catalog.json'), JSON.stringify(products, null, 2) + '\n');
await writeFile(path.join(output, '.nojekyll'), '');
// 商品・ブランド・おすすめの写真（scripts/generate-product-photos.py で作ったもの）
for (const dir of ['products', 'brands', 'features']) {
  await mkdir(path.join(output, 'assets', dir), { recursive: true });
  for (const name of await readdir(path.join(root, 'dist', 'assets', dir))) if (name.endsWith('.webp')) await copyFile(path.join(root, 'dist', 'assets', dir, name), path.join(output, 'assets', dir, name));
}
for (const name of ['salon-film.mp4', 'outfit-latin-wght.woff2', 'OUTFIT-LICENSE.txt']) await copyFile(path.join(root, 'dist', 'assets', name), path.join(output, 'assets', name));
const allowed = ['index.html','shop.html','admin.html','order.html',...scripts,'catalog.json','assets','.nojekyll'];
const extra = (await readdir(output)).filter(name => !allowed.includes(name));
if (extra.length) throw Error('Unexpected files in Pages output: ' + extra.join(', '));
console.log(`GitHub Pages static demo built in docs/ (version ${version}). No database or logs are included.`);
