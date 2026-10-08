import {spawn} from 'node:child_process';
import {createLocalArena} from '../dev/local-server.mjs';
import {verifiedBinary} from './prepare-phone-test.mjs';
const binary=await verifiedBinary();
if(!binary){console.error('Run npm run phones:setup once before starting phone mode.');process.exit(1);}
let arena;
try{arena=await createLocalArena();}catch(e){console.error(e.code==='EADDRINUSE'?'Port 4173 is in use. Stop the other arena terminal before starting phone mode.':e.message);process.exit(1);}
console.log('Rep Arena is running on your PC. Creating the temporary HTTPS connection…');
const tunnel=spawn(binary,['tunnel','--url',arena.origin,'--no-autoupdate','--protocol','http2'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let publicOrigin=null,registeredAt=null,healthStarted=false,ready=false,buffer='',closing=false,retryTimer=null,healthTimeout=null,healthController=null,retryDelay=2000,lastFailure='No tunnel URL was allocated.';
const deadline=setTimeout(()=>{console.error('The HTTPS connection did not become ready within 180 seconds. '+lastFailure+' Check internet access or VPN settings, then retry.');stop(1);},180000);
function progress(message){if(closing||ready)return;if(message!==lastFailure)console.log(message);lastFailure=message;}
function scheduleFirstHealthCheck(){
 if(closing||healthStarted)return;
 if(publicOrigin&&registeredAt!==null){
  healthStarted=true;
  progress('Tunnel connected. Allowing 15 seconds for DNS publication before checking HTTPS.');
  retryTimer=setTimeout(checkHealth,Math.max(0,registeredAt+15000-Date.now()));
 }else if(publicOrigin)progress('Tunnel address allocated. Waiting for the connection.');
 else if(registeredAt!==null)progress('Tunnel connected. Waiting for its address.');
}
async function checkHealth(){
 if(closing||ready)return;
 retryTimer=null;
 const controller=new AbortController();healthController=controller;
 healthTimeout=setTimeout(()=>controller.abort(),5000);
 try{
  const response=await fetch(publicOrigin+'/local/health',{signal:controller.signal,redirect:'error',cache:'no-store'});
  let health=null;
  if(response.ok)health=await response.json();
  else{progress('HTTPS health endpoint returned HTTP '+response.status+'. Retrying.');await response.body?.cancel();}
  if(health?.ok===true&&health?.local===true&&!closing){
   ready=true;clearTimeout(deadline);
   console.log(`\nOPEN THIS ON BOTH PHONES:\n${publicOrigin}\n\nROOM CODE: ${arena.joinCode}\n\nEnter a different athlete name on each phone.\nChoose the same exercise and LIVE 1V1, then START on both.\nEnable cameras, calibrate, then both tap READY for a shared countdown.\nPush-ups: prop your phone on the floor in front, screen facing you.\nTry PRACTICE first to check counting.\n\nKeep this terminal and PC running. Ctrl+C stops the link.\nThis temporary link changes when restarted. Use a stable tunnel hostname for repeat testing with the same browser profiles.\n`);
  }else if(response.ok)progress('HTTPS endpoint returned an unexpected health response. Retrying.');
 }catch(e){
  const code=e.cause?.code||e.code;
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')progress('Tunnel DNS is not ready on this PC yet. Retrying.');
  else if(e.name==='AbortError')progress('HTTPS health check timed out. Retrying.');
  else progress('HTTPS health check failed ('+(code||e.name)+'). Retrying.');
 }finally{
  clearTimeout(healthTimeout);healthTimeout=null;healthController=null;
  if(!closing&&!ready){retryTimer=setTimeout(checkHealth,retryDelay);retryDelay=Math.min(retryDelay*2,10000);}
 }
}
function output(chunk){
 const text=chunk.toString();buffer=(buffer+text).slice(-16000);
 if(!closing){
  if(!publicOrigin){const match=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);if(match){publicOrigin=match[0];arena.setPublicOrigin(publicOrigin);}}
  if(registeredAt===null&&buffer.includes('Registered tunnel connection'))registeredAt=Date.now();
  scheduleFirstHealthCheck();
 }
 if(/ERR|error|Registered tunnel connection/.test(text))process.stderr.write(text);
}
tunnel.stdout.on('data',output);tunnel.stderr.on('data',output);
async function stop(code=0){if(closing)return;closing=true;clearTimeout(deadline);clearTimeout(retryTimer);clearTimeout(healthTimeout);healthController?.abort();tunnel.kill();await arena.close();process.exitCode=code;}
tunnel.on('error',e=>{console.error(e.message);stop(1);});
tunnel.on('exit',code=>{if(!closing){console.error('The HTTPS connection ended. Restart phone mode to reconnect.');stop(code||1);}});
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
