// App entry: wires analysis -> choreography -> show -> stage, playback, UI and export.

import { loadSong, type LoadedSong } from './analysis';
import { choreograph } from './choreographer';
import { EXPORT_PRESETS, exportSupported, exportVideo, suggestClip } from './exporter';
import type { Quality } from './fountain/particles';
import { AudioPlayer, Show } from './show';
import { Stage } from './stage';
import { UI, type UiSettings } from './ui';

const DPR_CAP: Record<Quality, number> = { Low: 1, Medium: 1.25, High: 1.5, Ultra: 2 };

const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || Math.min(screen.width, screen.height) < 700;
const settings: UiSettings = {
  intensity: 1,
  quality: lowEnd ? 'Medium' : 'High',
  theme: 'classic',
  camera: 'auto',
  lasers: true,
  mist: true,
  bloom: 0.9,
  exportPreset: EXPORT_PRESETS[0].label,
  exportFps: 30,
  clip: false,
  clipStart: 0,
  clipEnd: 30,
};

const canvas = document.getElementById('scene') as HTMLCanvasElement;
let stage: Stage;
try {
  stage = new Stage(canvas, { ...settings });
} catch (err) {
  const div = document.createElement('div');
  div.id = 'fatal';
  div.textContent = `Fountain needs WebGL2 with float textures. (${err instanceof Error ? err.message : String(err)})`;
  document.body.append(div);
  throw err;
}

let player: AudioPlayer | null = null;
let show: Show | null = null;
let song: LoadedSong | null = null;
let exporting = false;
let abort: AbortController | null = null;
let loading = false;

let lastT = -1;
let dirty = true;
const markDirty = () => (dirty = true);

const fmt = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[stage.settings.quality]);
  stage.setSize(window.innerWidth, window.innerHeight, dpr);
}

const ui = new UI(
  {
    onFile: (f) => void onFile(f),
    onPlayPause: () => {
      if (!player || !show || exporting) return;
      if (player.playing) player.pause();
      else void player.play();
    },
    onSeek: (t) => {
      if (!player || !show || exporting) return;
      player.seek(Math.max(0, Math.min(show.duration - 0.01, t)));
    },
    onSettings: (key) => {
      const s = stage.settings;
      switch (key) {
        case 'quality':
          stage.setQuality(settings.quality);
          resize();
          break;
        case 'camera':
          s.camera = settings.camera;
          if (s.camera === 'orbit') stage.controls.update();
          break;
        default:
          s.intensity = settings.intensity;
          s.theme = settings.theme;
          s.lasers = settings.lasers;
          s.mist = settings.mist;
          s.bloom = settings.bloom;
      }
      stage.applySettings();
      markDirty();
    },
    onExport: () => void onExport(),
    onCancelExport: () => abort?.abort(),
    onSuggestClip: () => {
      if (!show) return;
      const c = suggestClip(stage);
      ui.setClip(c.start, c.end);
      ui.toast(`Clip ${fmt(c.start)}–${fmt(c.end)} selected`);
    },
    getTime: () => (player && show ? player.time : 0),
    isPlaying: () => !!player?.playing,
  },
  settings,
);

async function onFile(file: File) {
  if (exporting || loading) return;
  loading = true;
  // create / resume the audio context inside the user gesture so playback can start later
  if (!player) player = new AudioPlayer();
  else player.stop();
  void player.ctx.resume().catch(() => {});
  ui.showProgress(0, 'Reading file…');
  try {
    const s = await loadSong(file, (p, stageText) => ui.showProgress(p, stageText));
    ui.showProgress(0.97, 'Choreographing the show…');
    await new Promise((r) => setTimeout(r, 30));
    const data = choreograph(s.analysis);
    song = s;
    show = new Show(data, s.analysis);
    player.load(s.buffer);
    stage.setShow(show);
    const clip = suggestClip(stage);
    settings.clipStart = clip.start;
    settings.clipEnd = clip.end;
    settings.clip = false;
    ui.setShow(show, file.name);
    ui.toast(s.fromCache ? 'Analysis loaded from cache — same song, same show.' : 'Show ready. Space to play/pause, H to hide the UI.');
    try {
      await player.play();
    } catch {
      /* autoplay blocked: the play button works */
    }
  } catch (err) {
    console.error(err);
    ui.showError(err instanceof Error ? err.message : String(err));
  } finally {
    loading = false;
  }
}

async function onExport() {
  if (exporting) return;
  if (!show || !song || !player) {
    ui.toast('Load a song first.');
    return;
  }
  const unsupported = exportSupported();
  if (unsupported) {
    ui.toast(unsupported, 6000, true);
    return;
  }
  player.pause();
  const preset = EXPORT_PRESETS.find((p) => p.label === settings.exportPreset) ?? EXPORT_PRESETS[0];
  const fps = Number(settings.exportFps) === 60 ? 60 : 30;
  let start = 0;
  let end = show.duration;
  if (settings.clip) {
    start = Math.max(0, Math.min(settings.clipStart, settings.clipEnd));
    end = Math.min(show.duration, Math.max(settings.clipStart, settings.clipEnd));
    if (end - start < 1) {
      ui.toast('The clip is shorter than a second — adjust the in/out points.', 4000, true);
      return;
    }
  }
  exporting = true;
  abort = new AbortController();
  ui.openExport(`${preset.label} · ${fps} fps · ${fmt(start)}–${fmt(end)} (${(end - start).toFixed(1)} s) · H.264 + AAC`);
  try {
    const res = await exportVideo(
      stage,
      {
        width: preset.width,
        height: preset.height,
        fps,
        start,
        end,
        audio: song.buffer,
        restoreView: resize,
      },
      (p) => {
        const eta = p.etaSeconds > 0 ? ` · ETA ${fmt(p.etaSeconds)}` : '';
        ui.exportProgress(p.fraction, `${p.stage} ${p.frame}/${p.frames}${eta}`);
      },
      abort.signal,
    );
    const base = song.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'fountain';
    const filename = `${base} - fountain ${preset.width}x${preset.height}.mp4`;
    ui.exportDone(URL.createObjectURL(res.blob), filename, res.blob.size / 1e6, res.warnings);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') ui.exportFailed('Export cancelled.');
    else {
      console.error(err);
      ui.exportFailed(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    exporting = false;
    abort = null;
    markDirty();
  }
}

// ------------------------------------------------------------------------------ main loop
window.addEventListener('resize', resize);
resize();

const idleStart = performance.now();
window.addEventListener('resize', markDirty);
canvas.addEventListener('pointermove', () => settings.camera === 'orbit' && markDirty());
canvas.addEventListener('wheel', () => settings.camera === 'orbit' && markDirty(), { passive: true });
stage.controls.addEventListener('change', markDirty);
ui.gui.onChange(markDirty);
function frame(now: number) {
  requestAnimationFrame(frame);
  if (exporting) return;
  const t = show && player ? player.time : (now - idleStart) / 1000;
  // a paused show is a still frame: don't burn the GPU re-rendering it
  const orbiting = settings.camera === 'orbit' && stage.controls.update();
  if (t === lastT && !dirty && !orbiting) return;
  lastT = t;
  dirty = false;
  stage.advanceTo(t);
  stage.render(t);
  ui.update(t);
}
requestAnimationFrame(frame);

// expose for debugging / automated tests
(window as unknown as { fountain: unknown }).fountain = { stage, ui, settings, markDirty, get show() { return show; }, get player() { return player; }, onFile, onExport };
