import { api, isPages } from './api-client.js';
import { createPlatform, platformRequest, migrate, demoOperators, DEMO_OPERATOR_PASSWORD } from './platform-core.js';
export { api, isPages };
const base=new URL('.',import.meta.url).pathname,key=`salon-platform-v1:${base}`,opKey=key+':operator';
let catalogPromise;
export async function platform(route,method='GET',input){
  if(!isPages){const response=await fetch('/api/platform'+route,{method,headers:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});const data=await response.json();if(!response.ok)throw Error(data.error||'処理に失敗しました。');return data;}
  const perform=async()=>{
    let operator;try{operator=JSON.parse(sessionStorage.getItem(opKey)||'null');}catch{}
    if(operator?.expiresAt<=Date.now())operator=null;
    operator=operator?demoOperators.find(o=>o.id===operator.id):null;
    if(route==='/operator/me')return {operator};
    if(route==='/operator/logout'){sessionStorage.removeItem(opKey);return {operator:null};}
    if(route==='/operator/login'){
      const selected=demoOperators.find(o=>o.email===String(input.email).trim().toLowerCase());if(!selected||input.password!==DEMO_OPERATOR_PASSWORD)throw Error('メールアドレスまたはパスワードが違います。');
      sessionStorage.setItem(opKey,JSON.stringify({id:selected.id,expiresAt:Date.now()+86400000}));return {operator:selected};
    }
    catalogPromise??=fetch(new URL('./catalog.json',import.meta.url)).then(r=>{if(!r.ok)throw Error('商品データを取得できません。');return r.json();});
    let state,raw=localStorage.getItem(key);if(raw){try{state=JSON.parse(raw);}catch{throw Error('保存データを読み込めません。');}if(migrate(state,await catalogPromise))raw=null;}else state=createPlatform(await catalogPromise);
    const {member}=await api('/auth/me');
    const result=platformRequest(state,route,method,input,{operator,member});
    // 変更を伴う処理は保存する。カート・お気に入りは他の画面の再読み込みを促さない（更新番号を上げない）。
    const readOnly=method==='GET'||['/quote','/admin/sales'].includes(route),quiet=['/cart','/favorites'].includes(route);
    if(!raw||!readOnly){if(!readOnly&&!quiet)state.revision++;try{localStorage.setItem(key,JSON.stringify(state));}catch{throw Error('保存できません。ブラウザの保存設定を確認してください。');}}
    return result;
  };
  // Use a separate lock from membership to avoid nesting the same lock.
  return navigator.locks?.request?navigator.locks.request(key,perform):perform();
}
