const BASE=import.meta.env.VITE_API_URL||'/api';
export function token(){return localStorage.getItem('inventory_token')||'';}
export async function api(path:string,options:RequestInit={}){const headers:any={'Content-Type':'application/json',...(options.headers||{})};if(token())headers.Authorization=`Bearer ${token()}`;const response=await fetch(`${BASE}${path}`,{...options,headers});const body=await response.json().catch(()=>({message:'服务响应异常'}));if(!response.ok)throw new Error(body.message||'请求失败');return body.data;}
export const idempotencyKey=()=>crypto.randomUUID();
