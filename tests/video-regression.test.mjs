import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {RepCounter,validateEvidence} from '../dist/rules.js';
// Private browser-pipeline fixtures are intentionally not committed. Regenerate
// from the owner's originals with scripts/check-videos.mjs.
for(const [name,expected] of [['49',5],['44',3]]) {
  test(`uploaded video ${name}: ${expected} cycles with browser landmarks`,async t=>{
    let clip;
    try{clip=JSON.parse(await readFile(new URL(`../.local/video-checks/WhatsApp Video 2026-09-30 at 12.19.${name} AM.mp4.json`,import.meta.url),'utf8'));}
    catch(e){if(e.code==='ENOENT'){t.skip('Private video fixture not present');return;}throw e;}
    for(const stride of [1,2]){
      const counter=new RepCounter('pushup');
      for(let i=0;i<clip.frames.length;i+=stride){const f=clip.frames[i];counter.update(f.image,f.time,clip.width,clip.height,f.world);}
      assert.equal(counter.count,expected,`sampled at ${30/stride} fps`);
      assert.equal(validateEvidence(counter.events,'pushup'),expected);
    }
  });
}
