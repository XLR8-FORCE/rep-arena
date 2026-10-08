// Downloads only the official Cloudflare release and verifies GitHub's SHA-256 asset digest.
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const dir=resolve(import.meta.dirname,'../.local/tools');
export const binary=resolve(dir,'cloudflared.exe');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifiedBinary(){try{const meta=JSON.parse(await readFile(resolve(dir,'cloudflared.json'),'utf8'));return hash(await readFile(binary))===meta.sha256?binary:null;}catch{return null;}}
async function install(){
 if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This setup is for Windows x64. Install cloudflared from the official vendor for your platform.');
 if(await verifiedBinary()){console.log('Verified Cloudflare tunnel helper is already installed for this project.');return;}
 const release=await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest',{headers:{'User-Agent':'rep-arena-local-testing','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
 if(!release.ok)throw new Error('Could not read the official Cloudflare release: '+release.status);
 const meta=await release.json(),asset=meta.assets.find(a=>a.name==='cloudflared-windows-amd64.exe');
 if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw new Error('Official SHA-256 checksum unavailable; automatic installation stopped.');
 const url=new URL(asset.browser_download_url);
 if(url.origin!=='https://github.com'||!url.pathname.startsWith('/cloudflare/cloudflared/releases/download/'))throw new Error('Unexpected download source.');
 console.log('Downloading official cloudflared '+meta.tag_name+'…');
 const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('Cloudflare download failed: '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer()),sha256=hash(bytes);
 if(sha256!==asset.digest.slice(7))throw new Error('Checksum mismatch. Nothing was installed.');
 await mkdir(dir,{recursive:true});await writeFile(binary,bytes);await writeFile(resolve(dir,'cloudflared.json'),JSON.stringify({version:meta.tag_name,sha256,source:url.href},null,2));
 console.log('Verified tunnel helper installed inside .local/tools. No system-wide installation.');
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))install().catch(e=>{console.error(e.message);process.exitCode=1;});
