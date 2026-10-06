import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { products } from '../catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs');
await mkdir(path.join(output, 'assets'), { recursive: true });
const scripts=['api-client.js','member-store.js','privacy.js','access-log.js','payment-core.js','catalog-core.js','shipping-csv.js','platform.css','platform-core.js','supply-core.js','platform-client.js','ui-kit.js','storefront.js','admin.js','order.js','invoice-view.js','qr-code.js','line-login.js'];
for (const name of scripts) await copyFile(path.join(root,'dist',name),path.join(output,name));
for(const page of ['index.html','shop.html','admin.html','order.html']){
let html = await readFile(path.join(root, 'dist', page==='index.html'?'shop.html':page), 'utf8');
html = html.replace('<head>', '<head>\n <meta name="site-mode" content="github-pages">\n <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' data:; script-src \'self\'; style-src \'self\'; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">');
await writeFile(path.join(output,page),html);
}
await writeFile(path.join(output, 'catalog.json'), JSON.stringify(products, null, 2) + '\n');
await writeFile(path.join(output, '.nojekyll'), '');
for (const name of ['shampoo.png', 'treatment.png', 'oil.png']) await copyFile(path.join(root, 'dist', 'assets', name), path.join(output, 'assets', name));
const allowed = ['index.html','shop.html','admin.html','order.html',...scripts,'catalog.json','assets','.nojekyll'];
const extra = (await readdir(output)).filter(name => !allowed.includes(name));
if (extra.length) throw Error('Unexpected files in Pages output: ' + extra.join(', '));
console.log('GitHub Pages static demo built in docs/. No database or logs are included.');
