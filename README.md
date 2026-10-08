# Rep Arena

A camera-powered push-up and squat arena with a simple game lobby, live 1v1 duels, durable profiles, friend requests, separate Elo ladders, practice, session history, milestones, and consistency shields.

## Run locally

Requires Node.js 24+ (the development database uses `node:sqlite`).

```sh
npm install
npm start
```

Open http://localhost:4173 and join with the eight-digit room code printed in the terminal. Each browser gets its own local athlete identity; data is stored in ignored `.local/arena.sqlite`. Local identities are never included in the production Worker. Production requires the Sites platform's authenticated user header and uses the declared D1 `DB` binding. Published access remains private until the owner changes sharing. Friends must have access to the same Site.

```sh
npm test
npm run build
```

## Test two phones from one PC

The supported phone setup keeps the PC as the local host and database, then uses a temporary Cloudflare HTTPS link so both phones can use camera permissions without opening a router port. It is intended for private testing; the link and room code change whenever the launcher restarts.

Run this once from the `pushup-arena` folder (the launcher keeps the tunnel helper inside the ignored project `.local` directory):

```sh
npm run phones:setup
npm run phones
```

On Windows you can also double-click `Start-Phone-Test.cmd`; it performs setup when needed and starts the room. The terminal prints an `https://…trycloudflare.com` URL and an eight-digit room code after checking the public connection. Open that URL in Safari on iPhone or Chrome on Android and enter a different athlete name and the same room code on each phone.

1. Choose the same exercise, select **Live 1v1**, and press **START** on both phones.
2. Enable each camera. For push-ups, prop the phone in front of you, screen toward you and tilted toward your upper body. Both shoulders must fit in the frame; elbows and hands are not required. Hold the top, do one complete practice rep, then return to the top until **FRONT VIEW READY** appears. This setup rep does not score. Squats still use a side-on full-body view.
3. Both players tap **READY**. A shared five-second countdown leads into the same 60-second round. Your rival’s counted reps update about once a second, subject to connection latency.
4. The server confirms the result and updates the exercise-specific ranks. For a chosen opponent, add their handle under **Friends**, have them accept, then choose **Friend Duel** and use the lobby’s invite button.

Keep the PC awake and the terminal open; `Ctrl+C` stops the room. A new temporary URL is a new browser origin, so old phone cookies do not carry across restarts, even though the PC retains the old records. This is a local test setup, not a production hosting service.

Start with practice to check camera placement and counting on each phone. Use **Switch camera** before a round to choose the front or rear camera. Keep the phone page open during the attempt; screen wake-lock is requested where supported. The model needs internet access on first load. The temporary link can work over Wi-Fi or mobile data; this is not an offline LAN setup. Share both the URL and room code only with your test players.

New tunnel hostnames can take a minute or two to resolve. Wait for **OPEN THIS ON BOTH PHONES** in the terminal before sharing the link. If a browser cached an early DNS error, reopen the verified link in a fresh tab after startup completes. The launcher checks the public HTTPS health endpoint and stops with a diagnostic if it cannot establish access.

For a single-PC browser preview, `npm start` still serves `http://localhost:4173`; it uses the same local database but does not create a phone tunnel. The local room is separate from the published beta and is not backed up or synced to it.

Source UI is in `dist/index.html`, `dist/styles.css`, `dist/app.js`, and `dist/rules.js`. The build embeds these files in the Cloudflare-compatible `dist/server/index.js` Worker, with the generated Drizzle migrations in `dist/.openai/drizzle`. Schema changes go through `db/schema.ts` and `npm run db:generate`; applied migrations must not be rewritten.

## Camera and privacy

MediaPipe Tasks Vision 0.10.14 and its lite pose model load on demand from jsDelivr and Google model hosting. First launch requires internet access. Camera access requires HTTPS or localhost. Frames stay in the browser; only per-rep timing, range summaries, exercise, and scores are stored. No microphone or recording is used. GPU initialization falls back to CPU.

Push-ups use a fixed front-facing camera and only the two image-space shoulder points. A stable top (250 ms) followed by one setup cycle learns shoulder-midpoint vertical travel, normalized by initial shoulder width. Minimum travel is 0.20 shoulder widths; subsequent cycles require at least 70% of the learned range. Two observed depth frames and a return near the starting height complete a cycle. No elbow, wrist, leg, or 3D landmark is required by the counter.

Tracking loss beyond 250 ms cancels the unfinished cycle. Round resets retain calibration but discard countdown motion. Camera processing targets up to 30 checks/second and completed reps update the local display immediately. Keep the phone fixed; switch the camera off and on to recalibrate after moving it.

Version-3 evidence contains shoulder travel, return height, calibrated range and timing, without fabricated angle measurements. Server validation accepts v3 and preserves older v2/legacy clients. This experimental counter measures motion only: bobbing or crouching can count, and it does not verify push-up form.

### Check a recorded video

The push-up screen draws only two shoulders and their connecting line. The **SHOULDERS ONLY** panel shows missing shoulders, setup progress, travel and return-to-top feedback. MediaPipe still estimates a full pose internally, but only the shoulders affect push-up counting. Squats retain their full-body view.

Choose **CHECK A VIDEO** in the lobby (or open `/replay.html`). Select a clip up to 60 seconds, then press **CHECK VIDEO**. The replay and live camera import the exact same MediaPipe Tasks Vision loader and counter. Video is decoded locally; only the model assets are downloaded. Replay includes the calibration rep in its total, unlike the pre-match setup, and never submits a score.

For reproducible browser checks, install Playwright as a development tool or set `PLAYWRIGHT_MODULE` to an existing `playwright/index.mjs`, then run `node scripts/check-videos.mjs "path/to/video.mp4"`. Set `BROWSER_CHANNEL=msedge` or `chrome` to use an installed browser. Private landmark fixtures are written under ignored `.local/video-checks/`. `node scripts/check-landmarks.mjs` replays those fixtures against the current counter. The private-video regression tests skip when the owner's fixtures are absent.

The two supplied clips were checked using the website's browser model on its CPU delegate: 5 and 3 completed cycles. Cached pose playback also passes at 30 and 15 samples/second. These two clips are calibration evidence, not a general accuracy percentage; other people, bad-form recordings, different lighting and real phone GPU performance still need testing.

Front view cannot reliably verify a straight plank, knees off the floor, or physical liveness; a face-only image is insufficient. Squats retain the clearer-side full-body 2D knee-angle check. No front-view squat support is implied.

Counting heuristics are an initial approximation, not a medical assessment or a validated sports officiating system. Real-world accuracy needs testing across bodies, clothing, cameras and lighting. Rankings are explicitly labelled a camera-scored beta: clients can fabricate telemetry, so this release must not be used for monetary prizes or represented as cheat-proof. Server timing and evidence validation reject obvious malformed attempts but do not establish physical liveness.

## Competitive rules

- Separate push-up and squat ratings begin at 600. First five matches are placements. Tiers: Iron, Bronze, Silver, Gold, Platinum, Diamond, Apex.
- Live ranked rounds require both players to ready up. The server starts a shared five-second countdown and 60-second round. Scores are visible during play. More reps wins, equal scores draw. Elo K=24. Queue uses a 300-rating window; friend duels allow any rating.
- One active live room per athlete. A pair can complete at most two ranked matches per ladder per 24 hours. Rejoining preserves the same server clock and accepted reps; it never creates a fresh attempt. Final score delivery has a ten-second grace period, and settlement is idempotent.
- Cancelling before the round starts does not change rank. Leaving after the start or disconnecting for more than ten seconds while the other player remains connected forfeits the match. Both disconnected means no contest. Forfeits do not use shields or grant activity rewards. Keep the app foregrounded; phone backgrounding can interrupt tracking and connectivity.
- Existing asynchronous matches remain supported so old attempts/history are not discarded. The lobby launches only the new live flow. Legacy practice/result retry behavior remains available for existing attempts.
- Five distinct active days in a ladder earns one shield; a camera session with at least five reps counts. At most one shield earned per UTC week, at most two held. Days carry over and do not need to be consecutive. One shield use per UTC day cushions half a loss, at most six points. Shields never expire. The winner gets normal Elo; protection causes a small capped rating inflation.
- No paid currency, passes, skins, daily streak resets or inactivity decay. Milestones and personal bests are derived from saved records.

## Verification

Tests cover Elo, shield rules, rep-evidence validation, front-view calibration/full cycles/partials/occlusion/camera movement, side-view squat transitions, identity checks, cross-site writes, private friend acceptance, independent ladders, shared countdown, live score monotonicity, disconnect forfeits, one-time settlement, concurrent submission replay, activity deduplication and ranked attempt limits. Client checks cover countdown heartbeat payloads, finish retries and stale responses. Camera hardware accuracy cannot be established by synthetic tests.

API boundary: authenticated user headers must be supplied and protected by Sites dispatch. Do not expose the Worker directly behind a proxy that accepts caller-supplied identity headers. Local preview listens only on loopback. Production errors fail closed and do not use local identities. D1 batches enforce atomic score recording and idempotent settlement.

Pose API reference: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js
### Optional manual shoulder calibration
Below the camera, tap SET TOP, hold your top pose through the three-second countdown, then repeat SET BOTTOM at your low pose. Return to the top to become ready; no setup rep is needed. Yellow and blue shaded guides show tolerance zones. Bottom tolerance is 15% of your saved travel; top tolerance scales with travel with a narrow tracking cap. Positions need enough separation to reject noise. Reset positions to start over. Calibration is locked during a round or after readying for a duel and cleared when reconnecting the camera. This is motion tolerance, not a guarantee of safe exercise form.

## Development approach

Built with AI assistance and iterative prompting. This portfolio copy excludes local databases, private video fixtures, deployment identifiers and generated Worker bundles. Existing deployment configuration is not included.
