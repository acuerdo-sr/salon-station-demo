import { api, isPages } from './api-client.js?v=d64b90157f';
import { createPlatform, platformRequest, migrate, demoOperators, DEMO_OPERATOR_PASSWORD } from './platform-core.js?v=d64b90157f';
import { runSubscriptions } from './supply-core.js?v=d64b90157f';
import { SESSION_IDLE } from './member-store.js?v=d64b90157f';
export { api, isPages };
const base=new URL('.',import.meta.url).pathname,key=`salon-platform-v1:${base}`,opKey=key+':operator';
let catalogPromise;
export async function platform(route,method='GET',input){
  if(!isPages){const response=await fetch('/api/platform'+route,{method,headers:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});const data=await response.json();if(!response.ok)throw Error(data.error||'処理に失敗しました。');return data;}
  const perform=async()=>{
    let operator;try{operator=JSON.parse(sessionStorage.getItem(opKey)||'null');}catch{}
    if(operator?.expiresAt<=Date.now()){operator=null;sessionStorage.removeItem(opKey);}
    operator=operator?demoOperators.find(o=>o.id===operator.id):null;
    // 管理者のセッションも最後の操作から30分で切れる。操作のたびに延ばす
    if(operator)sessionStorage.setItem(opKey,JSON.stringify({id:operator.id,expiresAt:Date.now()+SESSION_IDLE}));
    if(route==='/operator/me')return {operator};
    if(route==='/operator/logout'){sessionStorage.removeItem(opKey);return {operator:null};}
    // 公開デモ専用：LINEから開いた発注画面の体験。LINEとは通信せず、LUMIÈRE の店舗担当としてログインする。
    if(route==='/operator/line-demo'){const selected=demoOperators.find(o=>o.role==='salon');sessionStorage.setItem(opKey,JSON.stringify({id:selected.id,expiresAt:Date.now()+SESSION_IDLE}));return {operator:{...selected,lineLinked:true}};}
    if(route==='/operator/login'){
      const selected=demoOperators.find(o=>o.email===String(input.email).trim().toLowerCase());if(!selected||input.password!==DEMO_OPERATOR_PASSWORD)throw Error('メールアドレスまたはパスワードが違います。');
      sessionStorage.setItem(opKey,JSON.stringify({id:selected.id,expiresAt:Date.now()+SESSION_IDLE}));return {operator:selected};
    }
    catalogPromise??=fetch(new URL('./catalog.json?v=d64b90157f',import.meta.url)).then(r=>{if(!r.ok)throw Error('商品データを取得できません。');return r.json();});
    let state,raw=localStorage.getItem(key);if(raw){try{state=JSON.parse(raw);}catch{throw Error('保存データを読み込めません。');}if(migrate(state,await catalogPromise))raw=null;}else state=createPlatform(await catalogPromise);
    const {member}=await api('/auth/me');
    // 期日を迎えた定期発注を作成する（サーバー版では一定間隔で自動実行）
    const due=runSubscriptions(state,new Date().toISOString());if(due.created.length||due.failed.length){state.revision++;raw=null;}
    const lastAccess=state.accessLogs?.[0]?.id;
    const result=platformRequest(state,route,method,input,{operator,member});
    // 美容室が会員情報を編集したら、公開デモの会員データ（ブラウザ内）にも反映する
    if(/^\/admin\/customers\/[^/]+$/.test(route)&&method==='PATCH')await api('/auth/admin-profile',{method:'PATCH',body:JSON.stringify({id:result.id,name:result.name,kana:result.kana,phone:result.phone,gender:result.gender,birthday:result.birthday})});
    // 個人情報を含む画面を開いた記録（アクセス記録）は、読み出しでも保存する
    if(state.accessLogs?.[0]?.id!==lastAccess)raw=null;
    // 変更を伴う処理は保存する。カート・お気に入り・出力の記録は他の画面の再読み込みを促さない（更新番号を上げない）。
    const readOnly=method==='GET'||['/quote','/admin/sales'].includes(route),quiet=['/cart','/favorites','/supply/favorites','/admin/exports','/admin/shipping-csv'].includes(route)||/^\/(addresses|payment-methods)(\/|$)/.test(route);
    if(!raw||!readOnly){if(!readOnly&&!quiet)state.revision++;try{localStorage.setItem(key,JSON.stringify(state));}catch{throw Error('保存できません。ブラウザの保存設定を確認してください。');}}
    return result;
  };
  // Use a separate lock from membership to avoid nesting the same lock.
  return navigator.locks?.request?navigator.locks.request(key,perform):perform();
}
