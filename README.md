# Fountain

Drop in a song (MP3 / WAV / M4A) and Fountain designs a night-time musical fountain show for it,
Dubai Fountain / Bellagio style: water jets, underwater lights, a mist screen and lasers,
choreographed to the song's beats, melody and structure. You can then export the show as an MP4
with the song's audio for X/Twitter or anywhere else.

This isn't an audio visualizer that bounces to volume. The app listens to the whole song first,
works out its structure (intro, verse, build, drop, breakdown, outro), then plans a show the way a
human designer would: one look per section, hits on the downbeats, the melody sung by swaying
jets, and a build that pays off in one big drop.

## Setup

Requires Node 20+ and a modern desktop browser (Chrome/Edge 120+ recommended; Safari 17+ works).

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (open with `npm run preview` or any static host)
```

## Using it

1. **Drop a song** anywhere on the page (or click *Choose a file*).
2. Fountain decodes the full file and analyses it in a Web Worker ("listening to your song…").
   A 4-minute song takes a few seconds. The result is cached by file hash in IndexedDB, so the
   same file loads instantly next time and always gets **the same show**.
3. The show plays. The timeline at the bottom shows the sections as colored blocks, the energy
   curve, build-ups (orange ramps) and every cue in lanes: shooters, ring ripples, oarsman
   snaps, hat bursts. Drops (red) and accents (white) are marked with triangles.
4. **Export video**: choose the size and fps in the *Export* panel, optionally select a clip,
   then click *⬇ Export video*.

### Controls

| Key / action | What it does |
|---|---|
| `Space` | Play / pause |
| `H` | Hide / show the UI (hover the bottom edge to bring the timeline back) |
| `←` / `→` | Scrub 5 s (hold `Shift` for 1 s) |
| `Home` | Back to the start |
| Click / drag timeline | Seek |
| `Shift` + drag timeline | Select an export clip; drag the cyan handles to adjust it |
| `[ In` / `Out ]` | Set the clip start / end at the playhead |
| `★ Best 30 s` | Picks ~30 s around the first drop (or the biggest chorus), snapped to a bar |

Settings panel (top right):

- **Jet intensity**: global height multiplier. Timing still lands on the beat, because the fire
  time is recomputed from the final height.
- **Palette theme**: classic white/gold, neon, sunset, monochrome. Each section picks a
  different palette from the theme.
- **Lasers / Mist screen**: toggle each on or off.
- **Water particles**: Low 65k, Medium 131k, High 262k, Ultra 393k droplets.
- **Bloom**: glow strength.
- **Camera**: *Auto* (the choreographer directs the camera) or *Manual orbit* (drag to orbit,
  scroll to zoom).

## Export

- Rendering runs **offline with a fixed timestep** (1/120 s simulation steps, exact ballistic
  integration), not in real time. Every frame comes out the same and the motion is smooth even on
  a slow machine; it just takes longer there. A progress bar shows an ETA.
- Presets: **1920×1080 (16:9)**, **1080×1920 (9:16)**, **1080×1080 (1:1)**, each at **30 or 60 fps**.
  Portrait and square frames widen the vertical field of view, so the 60 m shooters stay in frame.
- Output: **H.264 High profile + AAC-LC 48 kHz stereo in MP4** with the moov atom at the front
  ("fast start"), encoded with WebCodecs and muxed with `mp4-muxer`. The audio covers exactly the
  video's span, with short fades at the clip edges.
- **A/V sync**: every video frame is time-stamped from the same show clock the simulation uses.
  AAC encoders add "priming" samples that most players don't trim, which can make audio up to
  ~45 ms late. Fountain measures the encoder's delay once (it encodes a click and decodes it
  back) and compensates for it.
- **Browser support for AAC**: Chrome/Edge on macOS and Windows, and Safari, encode AAC. Chromium
  on Linux usually can't. There Fountain falls back to Opus audio and warns you; that file plays
  in browsers and VLC, but for QuickTime and X, export from macOS/Windows Chrome or Safari.
- **Browser support for H.264**: if a browser has no H.264 encoder (some Linux Chromium builds),
  Fountain exports VP9 in MP4 instead and says so. That file plays in browsers and VLC, but X
  and QuickTime need the H.264 version.
- X accepts these files directly (H.264 High, AAC, ≤60 fps, 16:9 / 9:16 / 1:1). For the best
  quality on X, keep clips under 2:20 and prefer 1080p 30 fps unless the song is very fast.

## Tips for picking songs

- **Songs with a clear structure make the best shows.** EDM with a real build and drop is the
  showpiece: the jets rise with the build, the lights drain to white, the laser fan sweeps up, and
  then all 87 jets peak together on the drop.
- **Pop and rock** get verse/chorus contrast: grooving oarsmen in the verses, full curtains and
  chasing shooters in the choruses.
- **Slow piano, strings and ambient** get the graceful treatment: slow swaying, the jets follow
  the melody, soft ring ripples on the notes, a glowing mist screen, and at most one or two
  tall columns at the climax.
- Avoid very long silences and spoken-word intros; the fountain sleeps through silence.
- For social clips, use *★ Best 30 s*: it frames the build-up and the first drop.
- Loud, well-mastered files analyse best. Low-bitrate MP3s are fine.

## How it works

```
src/
  analysis/          whole-song analysis (runs in a Web Worker)
    fft.ts           radix-2 FFT
    features.ts      STFT → band fluxes (kick <150 Hz, body 150 Hz–2 kHz, air >6 kHz), RMS,
                     centroid, chroma, MFCC, melody salience, "drumness" of spectral change
    beats.ts         onset picking, tempo (autocorrelation + prior), Ellis DP beat tracker,
                     kick-based half-beat phase correction, Viterbi downbeats (3/4 or 4/4)
    structure.ts     self-similarity matrix (chroma + MFCC) → checkerboard novelty → sections,
                     section labels, build-up/drop detection, silence and fade-out
    analyze.ts       pipeline + 50 Hz curves (energy, brightness, melody, percussion)
    index.ts         decode (OfflineAudioContext), SHA-256 hash, IndexedDB cache, worker
  choreographer.ts   music → show rules (sections → looks, hits, drops, camera, mist, lasers)
  patterns.ts        pattern library (29 named patterns)
  show.ts            timeline player: evaluates every jet's target at any time t; audio clock
  fountain/
    layout.ts        the installation: pool arc, 7 shooters, 24 oarsmen, 16-jet ring, 40-jet fan
    physics.ts       ballistic water with linear drag: apex height ↔ launch speed ↔ rise time
    nozzles.ts       valves (80 ms ramp), pump pressure slew, pivot springs, emission ring buffers
    particles.ts     GPGPU droplets (GPUComputationRenderer) + velocity-aligned streak rendering
  lights.ts          palettes/themes, per-jet underwater lamps, light pools on the water
  pool.ts            reflective lake: planar reflection + normal maps + impact ripples
  mist.ts            mist screen: layered noise volume, projections, lamp spill
  lasers.ts          beams that are only visible inside the mist
  sky.ts             night sky, stars, city glow, procedural skyline, aviation beacons
  camera.ts          cinematic presets + scheduled director with slow blends
  stage.ts           renderer, bloom/ACES, fixed-timestep simulation (shared by export)
  exporter.ts        offline render → WebCodecs H.264/AAC → mp4-muxer
  ui.ts, main.ts     interface and app wiring
tools/               Node test harness (synthetic songs, analysis/choreography checks, browser tests)
```

### Timing: jets peak on the beat, they don't launch on it

Water takes time to rise. A 60 m shooter needs about 39 m/s at the nozzle and about **3.3 s** to
reach its apex (with drag). Every burst is stored as *(peak time, apex height, hold)*. At playback
the valve opens at `peak − riseTime(height × intensity) − valveLag`, so the top of the column
arrives at its apex on the beat. Continuous patterns are evaluated slightly ahead of time for the
same reason. Valves ramp over 80 ms and never switch instantly. When a jet cuts, water already in
the air keeps flying and falls into the pool, then splashes and sends out ripples.

### Choreography rules (summary)

- **Sections → looks.** Each section gets a tier (calm / medium / intense) from its loudness,
  drum density and label. It then gets a new look: an oarsman pattern, fan pattern, ring pattern,
  shooter pattern, palette, color mode, mist projection mode, laser mode and camera shot. Every
  component differs from the previous section's.
- **Kicks on downbeats** in energetic sections fire the shooters: center, outside-in, inside-out,
  left→right chase, right→left chase, pairs, all, or alternate.
- **Snares** fire a ring ripple around the central shooter, or snap the oarsmen to a new angle.
  With a solid beat, only on-grid snares count.
- **Hats** drive short pressure pulses on alternating halves of the oarsmen.
- **Melody** steers the oarsmen in the *sing* pattern. Higher notes lean one way, with smooth
  spring easing.
- **Energy** scales heights. Quiet passages stay low and gentle.
- **Build-ups** ramp heights steadily, desaturate the lights to white, thicken the mist, sweep a
  laser fan upward and speed up the oarsman snaps.
- **Drops**: every jet peaks on the drop downbeat (60 m shooters, full curtain, vertical oarsmen,
  full ring). Lights flash and switch palette instantly, lasers burst, and the camera cranes up.
  In songs with drops, only the drops get the intense tier, so a drop is always the biggest moment.
- **Breakdowns** get a slow swaying fan, a glowing mist screen and soft colors.
- **Intro**: the fountain starts dark and wakes up family by family (ring, oarsmen, curtain,
  shooters). **Outro**: heights taper, one farewell column rises on the last strong note, all
  valves close, and the lights fade after the last water lands.
- Every choice goes through a seeded PRNG (seed = file hash), so the same song always gets the
  same show.

### Quality checklist (three very different songs)

`tools/make-songs.mjs` synthesizes the three test songs. `tools/show-test.ts` prints the
analysis and the plan for each one:

```bash
node tools/make-songs.mjs tools/out
npx tsx tools/analyze-test.ts tools/out/edm.wav tools/out/piano.wav tools/out/pop.wav
npx tsx tools/show-test.ts tools/out/edm.wav tools/out/piano.wav tools/out/pop.wav
```

- **EDM, 128 BPM, 2 builds and drops.** Beats land within 6 ms of ground truth in the drum
  sections, and downbeats are correct. Sections are found exactly (intro 0 s, verse 15 s,
  build 45–60 s, drop 60 s, breakdown 90 s, build 105–120 s, drop 120 s, outro 150 s). Both drops
  are the only intense sections, and the only times all 87 jets peak together.
- **Slow piano, 66 BPM with rubato.** Drum-less, so every section is calm: slow patterns,
  melody-following oarsmen, gentle 65 ms-per-jet ring ripples, and one slow 25 m center column at
  the loudest passage. No shooters, hats or lasers.
- **Pop, 100 BPM, verse/pre-chorus/chorus/bridge.** Section boundaries match the arrangement
  (9.6 / 38.4 / 57.6 / 86.4 / 105.6 / 115.2 / 134.4 s). Verses are medium (shooters every 2 bars);
  choruses are intense with an accent on entry. The bridge becomes a breakdown.
- Browser tests: `tools/browser-test.mjs` (screenshots of moments of a show) and
  `tools/export-test.mjs` (end-to-end export of a clip) drive the dev server with Playwright.
  A 3 s 1080×1080 clip exported headless came out with 90 frames = 3.000 s of video, audio
  covering the same span, and the moov atom first.
- Consecutive sections never share an oarsman, fan, ring or shooter pattern, a palette, a color
  mode or a camera preset.
