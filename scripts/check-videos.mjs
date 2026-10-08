// Run with: node scripts/check-videos.mjs <clip.mp4> [...]
// PLAYWRIGHT_MODULE can point to a bundled installation if not installed locally.
import {createLocalArena} from '../dev/local-server.mjs';
import {mkdir, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {basename, resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const clips = process.argv.slice(2);
if (!clips.length) throw new Error('Pass one or more video paths.');
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const temporary = await mkdtemp(join(tmpdir(), 'rep-arena-replay-'));
const arena = await createLocalArena({port:0, dbPath:join(temporary,'test.sqlite'), joinCode:'82645193'});
let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{}), args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await browser.newPage();
  page.on('pageerror', e=>console.error('Browser error:', e.message));
  await mkdir('.local/video-checks', {recursive:true});
  for (const clip of clips) {
    await page.goto(arena.origin + '/replay.html');
    await page.locator('#clip').setInputFiles(resolve(clip));
    await page.waitForFunction(()=>!document.querySelector('#run').disabled);
    const summary = await page.evaluate(async()=>{
      const {checkVideo} = await import('/replay.js');
      return checkVideo({captureLandmarks:true, delegate:'CPU'});
    });
    const output = resolve('.local/video-checks', basename(clip)+'.json');
    await writeFile(output, JSON.stringify(summary));
    console.log(JSON.stringify({clip, count:summary.count, events:summary.events, processed:summary.processed, output}));
  }
} finally { await browser?.close(); await arena.close(); await rm(temporary,{recursive:true,force:true}); }
