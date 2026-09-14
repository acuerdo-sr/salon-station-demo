import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

test('local shop: totals, stock, duplicate requests, persistence and origin protection',async t=>{
 const data=await mkdtemp(path.join(os.tmpdir(),'salon-demo-test-'));
 const port=14821,base=`http://127.0.0.1:${port}`;
 let child;
 const start=async()=>{child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),DATA_DIR:data},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(d.toString().includes('local demo:'))resolve();});child.on('error',reject);child.on('exit',code=>reject(Error('server exited: '+code)));});};
 const stop=async()=>{const ended=once(child,'exit');child.kill();await ended;};
 const call=async(route,method='GET',body,origin=base,cookie='')=>{const res=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:body?JSON.stringify(body):undefined});return{status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')};};
 const customer={salon:'テストサロン',name:'テスト担当',email:'test@example.test',address:'架空県 1-2-3',note:''};
 const item=(quantity=1,price=2860)=>({id:'shampoo-moist',price,quantity});
 try{
  await start();
  assert.equal((await call('/products')).body.length,6);
  await t.test('shipping calculation at threshold',async()=>{
   assert.equal((await call('/quote','POST',{items:[item()]})).body.total,3520);
   assert.equal((await call('/quote','POST',{items:[item(4)]})).body.shipping,0);
   await call('/products/shampoo-moist','PATCH',{price:5500,stock:24});
   assert.equal((await call('/quote','POST',{items:[item(2,5500)]})).body.shipping,0);
   await call('/products/shampoo-moist','PATCH',{price:5499,stock:24});
   assert.equal((await call('/quote','POST',{items:[item(2,5499)]})).body.shipping,660);
   await call('/products/shampoo-moist','PATCH',{price:2860,stock:24});
  });
  await t.test('invalid quantity, price tampering, duplicate line, empty cart rejected',async()=>{
   for(const quantity of [-1,0,1.5,'1',100]) assert.equal((await call('/quote','POST',{items:[item(quantity)]})).status,400);
   assert.equal((await call('/quote','POST',{items:[item(1,1)]})).status,409);
   assert.equal((await call('/quote','POST',{items:[item(),item()]})).status,400);
   assert.equal((await call('/quote','POST',{items:[]})).status,400);
  });
  const request={items:[item(2)],customer,requestKey:randomUUID()};let id;
  await t.test('order saves once, decrements stock once',async()=>{
   const first=await call('/orders','POST',request);assert.equal(first.status,201);id=first.body.id;assert.equal(first.body.total,6380);
   assert.equal((await call('/orders','POST',request)).body.id,id);
   assert.equal((await call('/orders')).body.length,1);
   assert.equal((await call('/products')).body[0].stock,22);
  });
  await t.test('failed order leaves stock and orders unchanged',async()=>{
   assert.equal((await call('/orders','POST',{...request,requestKey:randomUUID(),items:[item(23)]})).status,409);
   assert.equal((await call('/orders','POST',{...request,requestKey:randomUUID(),customer:{...customer,email:'bad'}})).status,400);
   assert.equal((await call('/products')).body[0].stock,22);assert.equal((await call('/orders')).body.length,1);
  });
  await t.test('concurrent requests cannot oversell',async()=>{
   await call('/products/shampoo-moist','PATCH',{price:2860,stock:1});
   const results=await Promise.all([1,2].map(()=>call('/orders','POST',{...request,items:[item()],requestKey:randomUUID()})));
   assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal((await call('/products')).body[0].stock,0);
  });
  await t.test('admin validates values and blocks foreign origin',async()=>{
   assert.equal((await call('/products/shampoo-moist','PATCH',{price:10,stock:-1})).status,400);
   assert.equal((await call('/products/shampoo-moist','PATCH',{price:10,stock:2},'https://example.com')).status,403);
   const update=await call('/products/shampoo-moist','PATCH',{price:2990,stock:7});assert.equal(update.body.price,2990);
  });
  await stop();await start();
  await t.test('orders and product changes survive restart',async()=>{
   const orders=(await call('/orders')).body;assert.equal(orders.length,2);assert.ok(orders.some(o=>o.id===id));
   assert.equal((await call('/products')).body[0].price,2990);assert.equal((await call('/products')).body[0].stock,7);
   assert.equal(orders.find(o=>o.id===id).items[0].price,2860);
  });
  let cookieA, memberA;
  await t.test('server sessions isolate member orders, reject forged identity and invalidate logout',async()=>{
   const details=email=>({salon:'テスト会員サロン',name:'会員担当',email,password:'Demo-Member-2026'});
   const a=await call('/auth/register','POST',details('a@example.test'));
   assert.equal(a.status,200);assert.match(a.cookie,/HttpOnly/);assert.match(a.cookie,/SameSite=Strict/);
   cookieA=a.cookie.split(';')[0];memberA=a.body.member;
   assert.equal(memberA.hash,undefined);
   assert.equal((await call('/auth/register','POST',details('A@example.test'))).status,400);
   const memberRequest={...request,requestKey:randomUUID(),memberId:memberA.id,items:[item(1,2990)]};
   assert.equal((await call('/orders','POST',memberRequest,base,cookieA)).status,201);
   assert.equal((await call('/orders','GET',undefined,base,cookieA)).body.length,1);
   const b=await call('/auth/register','POST',details('b@example.test')),cookieB=b.cookie.split(';')[0];
   assert.equal((await call('/orders','GET',undefined,base,cookieB)).body.length,0);
   assert.equal((await call('/orders','POST',memberRequest,base,cookieB)).status,401);
   assert.equal((await call('/orders','POST',{...memberRequest,memberId:b.body.member.id},base,cookieB)).status,403);
   assert.equal((await call('/orders')).body.length,2);
   const edit=await call('/auth/profile','PATCH',{salon:'変更サロン',name:'変更担当',email:'forged@example.test'},base,cookieA);
   assert.equal(edit.body.member.email,memberA.email);
   await call('/auth/logout','POST',{},base,cookieA);
   assert.equal((await call('/auth/me','GET',undefined,base,cookieA)).body.member,null);
   assert.equal((await call('/orders','POST',memberRequest,base,cookieA)).status,401);
   assert.equal((await call('/auth/login','POST',{...details('a@example.test'),password:'Incorrect-password'})).status,400);
   const login=await call('/auth/login','POST',details('a@example.test'));
   assert.equal(login.status,200);assert.notEqual(login.cookie.split(';')[0],cookieA);cookieA=login.cookie.split(';')[0];
  });
  await stop();await start();
  await t.test('server member and session survive restart',async()=>{
   assert.equal((await call('/auth/me','GET',undefined,base,cookieA)).body.member.id,memberA.id);
   assert.equal((await call('/orders','GET',undefined,base,cookieA)).body.length,1);
   assert.equal((await call('/orders')).body.length,2);
  });
 }finally{if(child&&child.exitCode===null)await stop();assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep+'salon-demo-test-'));await rm(data,{recursive:true,force:true});}
});
