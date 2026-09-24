export const API_BASE=import.meta.env.VITE_API_URL||'/api';
export function token(){return localStorage.getItem('inventory_token')||'';}
export class ApiError extends Error{status:number;details:any;constructor(message:string,status:number,details?:any){super(message);this.name='ApiError';this.status=status;this.details=details;}}
export async function api(path:string,options:RequestInit={}){
  const headers:any={...(options.headers||{})};
  if(options.body!==undefined&&!(options.body instanceof FormData)&&!headers['Content-Type'])headers['Content-Type']='application/json';
  if(token())headers.Authorization=`Bearer ${token()}`;
  let response:Response;
  try{response=await fetch(`${API_BASE}${path}`,{...options,headers});}
  catch(error:any){if(error?.name==='AbortError')throw error;throw new Error('NETWORK_ERROR: 网络暂时不可用，请稍后重试');}
  const body=await response.json().catch(()=>({message:'服务响应异常'}));
  if(!response.ok)throw new ApiError(body.message||'请求失败',response.status,body.details);
  return body.data;
}

export function uploadItemImage(itemId:string,file:File,onProgress?:(percent:number)=>void){
  return new Promise<any>((resolve,reject)=>{
    const request=new XMLHttpRequest();
    request.open('POST',`${API_BASE}/items/${itemId}/image`);
    if(token())request.setRequestHeader('Authorization',`Bearer ${token()}`);
    request.upload.onprogress=event=>event.lengthComputable&&onProgress?.(Math.round(event.loaded/event.total*100));
    request.onerror=()=>reject(new Error('图片上传失败，请检查网络后重试'));
    request.onload=()=>{
      let body:any;
      try{body=JSON.parse(request.responseText);}catch{body={message:'服务响应异常'};}
      if(request.status>=200&&request.status<300)resolve(body.data);
      else reject(new Error(body.message||'图片上传失败'));
    };
    const data=new FormData();
    data.append('file',file,file.name);
    request.send(data);
  });
}
export { generateClientId as idempotencyKey } from './client-id';
