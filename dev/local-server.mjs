import http from 'node:http';
import https from 'node:https';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {database} from './database.mjs';
import {createLocalAuth} from './local-auth.mjs';
import {handleAPI} from '../src/api.js';

const root=resolve(import.meta.dirname,'..');
const files={'/':['dist/index.html','text/html; charset=utf-8'],'/index.html':['dist/index.html','text/html; charset=utf-8'],'/styles.css':['dist/styles.css','text/css'],'/app.js':['dist/app.js','text/javascript'],'/rules.js':['dist/rules.js','text/javascript'],'/live-session.js':['dist/live-session.js','text/javascript'],'/local/join.js':['dev/join.js','text/javascript']};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
for(const name of ['pose-engine.js','front-counter.js','replay.js','replay.html'])files['/'+name]=['dist/'+name,name.endsWith('.html')?'text/html; charset=utf-8':'text/javascript'];
const fail=(message,status)=>{throw Object.assign(new Error(message),{status});};
export async function createLocalArena({port=4173,host='127.0.0.1',dbPath=resolve(root,'.local/arena.sqlite'),publicOrigin=null,tls=null,joinCode,clock}={}){
 if(host!=='127.0.0.1'&&!tls)throw new Error('LAN camera mode requires a trusted TLS certificate. Use the phone launcher for a temporary HTTPS link.');
 await mkdir(dirname(dbPath),{recursive:true});
 const {DB,sqlite}=await database(dbPath);
 const auth=createLocalAuth(sqlite,{secure:false,joinCode,clock});
 let externalOrigin=null,localOrigin,mutations=Promise.resolve();
 const mutate=fn=>{const result=mutations.then(fn,fn);mutations=result.catch(()=>{});return result;};
 function setPublicOrigin(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Public origin must be an HTTPS origin.');externalOrigin=url.origin;}
 if(publicOrigin)setPublicOrigin(publicOrigin);
 function originFor(req){
  const requestHost=req.headers.host;
  if(externalOrigin&&requestHost===new URL(externalOrigin).host)return externalOrigin;
  const address=server.address(),scheme=tls?'https':'http';
  if(requestHost===`localhost:${address.port}`||requestHost===`127.0.0.1:${address.port}`)return `${scheme}://${requestHost}`;
  fail('This host is not enabled for the local arena.',421);
 }
 async function body(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>30000)fail('Request too large.',413);chunks.push(chunk);}return Buffer.concat(chunks);}
 function verifiedHeaders(req,identity){const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(!key.startsWith('oai-authenticated-')&&!['host','cookie','content-length'].includes(key)&&typeof value==='string')headers.set(key,value);if(identity)headers.set('oai-authenticated-user-id',identity.userId);return headers;}
 function cookie(token,origin){return auth.cookie(token)+(origin.startsWith('https:')?'; Secure':'');}
 async function respond(req){
  const origin=originFor(req);if(!req.url?.startsWith('/')||req.url.startsWith('//'))fail('Invalid request path.',400);
  const url=new URL(req.url,origin),path=url.pathname;
  if(req.method==='POST'&&((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'))fail('Cross-site request rejected.',403);
  const identity=auth.authenticate(req.headers.cookie||'');
  if(path==='/local/health'&&req.method==='GET')return json({ok:true,local:true});
  if(path==='/local/join'&&req.method==='POST'){
   if(identity)return json({ok:true,name:identity.name});
   if(!req.headers['content-type']?.includes('application/json'))fail('JSON required.',415);
   let data;try{data=JSON.parse((await body(req)).toString());}catch(e){if(e.status)throw e;fail('Invalid JSON.',400);}
   // No browser-supplied identity or forwarded user headers are trusted locally.
   const peer=externalOrigin&&origin===externalOrigin&&!tls?String(req.headers['cf-connecting-ip']||req.socket.remoteAddress):req.socket.remoteAddress;
   const session=auth.join(data,peer);
   const boot=await handleAPI(new Request(origin+'/api/state',{headers:{'oai-authenticated-user-id':session.userId}}),{DB});
   if(!boot.ok){auth.revoke(auth.cookie(session.token));fail('Could not create this athlete. Please try again.',503);}
   sqlite.prepare('UPDATE users SET name=? WHERE id=?').run(session.name,session.userId);
   const response=json({ok:true,name:session.name});response.headers.set('Set-Cookie',cookie(session.token,origin));return response;
  }
  if(path==='/local/leave'&&req.method==='POST'){auth.revoke(req.headers.cookie||'');const response=json({ok:true});response.headers.set('Set-Cookie',auth.clearCookie()+(origin.startsWith('https:')?'; Secure':''));return response;}
  if(path.startsWith('/api/')){
   if(!identity)return json({error:'Join this PC’s test room to save rounds and compete.',code:'LOCAL_JOIN_REQUIRED'},401);
   const request=new Request(url,{method:req.method,headers:verifiedHeaders(req,identity),body:['GET','HEAD'].includes(req.method)?undefined:await body(req)});
   const response=await(req.method==='POST'?mutate(()=>handleAPI(request,{DB})):handleAPI(request,{DB}));
   if(path==='/api/state'&&response.ok){const state=await response.json();state.local={enabled:true};return json(state);}
   return response;
  }
  if(!['GET','HEAD'].includes(req.method))return json({error:'Method not allowed.'},405);
  if((path==='/'||path==='/index.html'||path==='/local/join')&&!identity)return new Response(await readFile(resolve(root,'dev/join.html')),{headers:{'content-type':'text/html; charset=utf-8'}});
  if(path==='/local/join')return new Response(null,{status:303,headers:{location:'/'}});
  if(files[path])return new Response(await readFile(resolve(root,files[path][0])),{headers:{'content-type':files[path][1]}});
  return new Response('Not found',{status:404});
 }
 const listener=async(req,res)=>{
  try{const response=await respond(req);response.headers.set('cache-control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');response.headers.set('Permissions-Policy','camera=(self), microphone=()');res.writeHead(response.status,Object.fromEntries(response.headers));res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));}
  catch(e){res.writeHead(e.status||500,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:e.status?e.message:'Local arena error. Check the PC terminal.'}));if(!e.status)console.error(e);}
 };
 const server=tls?https.createServer({key:await readFile(tls.key),cert:await readFile(tls.cert)},listener):http.createServer(listener);
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 localOrigin=`${tls?'https':'http'}://127.0.0.1:${server.address().port}`;
 return {server,sqlite,joinCode:auth.joinCode,origin:localOrigin,setPublicOrigin,async close(){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));sqlite.close();}};
}
