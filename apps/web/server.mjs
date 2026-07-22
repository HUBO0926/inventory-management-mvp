import { createServer, request as proxyRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'dist');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const apiTarget = new URL(process.env.API_PROXY_TARGET || 'http://api:3001');

createServer((request,response)=>{
  const pathname=decodeURIComponent((request.url||'/').split('?')[0]);
  if(pathname==='/api'||pathname.startsWith('/api/')){
    const upstream=proxyRequest({hostname:apiTarget.hostname,port:apiTarget.port||80,path:request.url,method:request.method,headers:{...request.headers,host:apiTarget.host}},upstreamResponse=>{
      response.writeHead(upstreamResponse.statusCode||502,upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify({code:'BAD_GATEWAY',message:'API 服务暂不可用'}));});
    request.pipe(upstream);return;
  }
  const candidate=normalize(join(root,pathname));
  let file=candidate.startsWith(root)&&existsSync(candidate)&&statSync(candidate).isFile()?candidate:join(root,'index.html');
  response.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');
  response.setHeader('Cache-Control',file.endsWith('index.html')?'no-cache':'public, max-age=31536000, immutable');
  createReadStream(file).pipe(response);
}).listen(80,'0.0.0.0',()=>console.log('Web listening on 0.0.0.0:80'));
