import {build} from 'esbuild';
import {readFile,mkdir,cp} from 'node:fs/promises';
import {resolve} from 'node:path';
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['src/worker.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',loader:{'.html':'text','.css':'text'},plugins:[{name:'raw-source',setup(b){b.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.replace('?raw','')),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));}}]});
await mkdir('dist/.openai',{recursive:true});
try { await cp('.openai/hosting.json','dist/.openai/hosting.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await cp('drizzle','dist/.openai/drizzle',{recursive:true});
console.log('Built Rep Arena Worker and migrations.');
