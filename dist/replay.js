import {createPoseEngine} from './pose-engine.js';
import {RepCounter, validateEvidence} from './rules.js';
const video = document.querySelector('#video'), input = document.querySelector('#clip');
const run = document.querySelector('#run'), cancel = document.querySelector('#cancel');
const status = document.querySelector('#status'), score = document.querySelector('#score');
let url, cancelled = false, busy = false;
input.onchange = () => {
  if (url) URL.revokeObjectURL(url);
  if (!input.files[0]) return;
  url = URL.createObjectURL(input.files[0]); video.src = url;
  document.querySelector('#result').textContent = ''; score.textContent = '0';
  run.disabled = true; status.textContent = 'Opening video…';
};
video.onloadeddata = () => { run.disabled = false; status.textContent = 'Ready to check.'; };
video.onerror = () => { status.textContent = 'This video could not be decoded. Try an MP4 recorded by your phone.'; run.disabled = true; };
cancel.onclick = () => { cancelled = true; status.textContent = 'Stopping…'; };
function seek(time) {
  if (Math.abs(video.currentTime - time) < .0001 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', failed); };
    const done = () => { cleanup(); resolve(); }, failed = () => { cleanup(); reject(new Error('Video seek failed.')); };
    const timer = setTimeout(failed, 10000);
    video.addEventListener('seeked', done, {once:true}); video.addEventListener('error', failed, {once:true}); video.currentTime = time;
  });
}
// Exported for reproducible browser tests; no network requests contain video frames.
export async function checkVideo({captureLandmarks = false, delegate = 'GPU'} = {}) {
  if (busy) throw new Error('A check is already running.');
  if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 60) throw new Error('Choose a clip up to 60 seconds long.');
  busy = true; cancelled = false; input.disabled = run.disabled = true; cancel.disabled = false; video.controls = false; video.pause();
  const counter = new RepCounter('pushup'), frames = [], changes = [];
  let engine, previous = '', processed = 0;
  try {
    status.textContent = 'Loading pose tracking…'; engine = await createPoseEngine(delegate);
    const width = video.videoWidth, height = video.videoHeight;
    for (let index = 0; index / 30 < video.duration; index++) {
      if (cancelled) break;
      const time = index * 1000 / 30;
      await seek(index / 30);
      const result = engine.detectForVideo(video, time);
      const image = result.landmarks[0] || null, world = result.worldLandmarks?.[0] || null;
      const feedback = counter.update(image, time, width, height, world);
      if (captureLandmarks) frames.push({time, image, world});
      if (feedback.hint !== previous) { changes.push({time:Math.round(time), count:counter.count, hint:feedback.hint}); previous = feedback.hint; }
      score.textContent = counter.count; status.textContent = `${(time/1000).toFixed(1)}s / ${video.duration.toFixed(1)}s · ${feedback.hint}`;
      processed++;
      if (index % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const summary = {cancelled, count:counter.count, events:counter.events, processed, width, height, changes};
    summary.acceptedEvidence = validateEvidence(counter.events, 'pushup');
    if (captureLandmarks) summary.frames = frames;
    document.querySelector('#result').textContent = JSON.stringify({count:summary.count, cancelled, completionsSeconds:counter.events.map(e=>e.t/1000), acceptedEvidence:summary.acceptedEvidence}, null, 2);
    status.textContent = cancelled ? 'Check cancelled. Partial result shown.' : 'Video check complete.';
    return summary;
  } finally { engine?.close(); busy = false; input.disabled = run.disabled = false; cancel.disabled = true; video.controls = true; }
}
run.onclick = () => checkVideo().catch(error => { status.textContent = error.message; });
