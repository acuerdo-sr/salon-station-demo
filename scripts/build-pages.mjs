import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { products } from '../catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs');
await mkdir(path.join(output, 'assets'), { recursive: true });
const scripts=['style.css','app.js','api-client.js','demo-store.js','member-store.js','member-ui.js','platform.css','platform-core.js','platform-client.js','ui-kit.js','storefront.js','admin.js','qr-code.js'];
for (const name of scripts) await copyFile(path.join(root,'dist',name),path.join(output,name));
for(const page of ['index.html','shop.html','admin.html']){
let html = await readFile(path.join(root, 'dist', page==='index.html'?'shop.html':page), 'utf8');
html = html.replace('<head>', '<head>\n <meta name="site-mode" content="github-pages">\n <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' data:; script-src \'self\'; style-src \'self\'; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">')
  .replaceAll('ローカルデモ', '公開デモ')
  .replace('サロン向けECサイトのローカル試作。', 'サロン向けECサイトの体験用デモ。')
  .replace('LOCAL DEMO', 'WEB DEMO')
  .replace('ローカル試作サイト・決済や発送は行われません', '購入体験用のサンプル・決済や発送は行われません')
  .replace('架空の商品を使用したローカルECデモです。', '注文・在庫はこのブラウザだけに保存されます。');
await writeFile(path.join(output,page),html);
}
await writeFile(path.join(output, 'catalog.json'), JSON.stringify(products, null, 2) + '\n');
await writeFile(path.join(output, '.nojekyll'), '');
for (const name of ['shampoo.png', 'treatment.png', 'oil.png']) await copyFile(path.join(root, 'dist', 'assets', name), path.join(output, 'assets', name));
const allowed = ['index.html','shop.html','admin.html',...scripts,'catalog.json','assets','.nojekyll'];
const extra = (await readdir(output)).filter(name => !allowed.includes(name));
if (extra.length) throw Error('Unexpected files in Pages output: ' + extra.join(', '));
console.log('GitHub Pages static demo built in docs/. No database or logs are included.');
