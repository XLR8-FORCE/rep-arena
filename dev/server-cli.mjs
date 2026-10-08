import {createLocalArena} from './local-server.mjs';
const arena=await createLocalArena();
console.log(`Rep Arena is running on this PC: ${arena.origin}\nRoom code: ${arena.joinCode}\nFor phones, run npm run phones instead. Press Ctrl+C to stop.`);
process.once('SIGINT',()=>arena.close().then(()=>process.exit(0)));
