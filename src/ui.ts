// DOM user interface: drop zone, analysis progress, transport + choreography timeline,
// settings panel (lil-gui) and the export dialog.

import GUI from 'lil-gui';
import { EXPORT_PRESETS } from './exporter';
import type { Show } from './show';
import type { CueKind, SectionLabel } from './types';

export const LABEL_COLORS: Record<SectionLabel, string> = {
  intro: '#5b7cfa',
  verse: '#3aa7b5',
  build: '#f5a623',
  chorus: '#e84393',
  drop: '#ff3b30',
  breakdown: '#8e7cc3',
  outro: '#6c7a89',
};

const LANES: { kind: CueKind; label: string; color: string }[] = [
  { kind: 'shooter', label: 'Shooters', color: '#ffd166' },
  { kind: 'ring', label: 'Ring', color: '#4cc9f0' },
  { kind: 'snap', label: 'Oarsmen', color: '#b388ff' },
  { kind: 'hat', label: 'Hats', color: '#9aa5b1' },
];

export interface UiSettings {
  intensity: number;
  quality: 'Low' | 'Medium' | 'High' | 'Ultra';
  theme: 'classic' | 'neon' | 'sunset' | 'monochrome';
  camera: 'auto' | 'orbit';
  lasers: boolean;
  mist: boolean;
  bloom: number;
  exportPreset: string;
  exportFps: 30 | 60;
  clip: boolean;
  clipStart: number;
  clipEnd: number;
}

export interface UiCallbacks {
  onFile(file: File): void;
  onPlayPause(): void;
  onSeek(t: number): void;
  onSettings(changed: keyof UiSettings): void;
  onExport(): void;
  onCancelExport(): void;
  onSuggestClip(): void;
  getTime(): number;
  isPlaying(): boolean;
}

const fmt = (t: number) => {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}`;
};

export class UI {
  readonly settings: UiSettings;
  private readonly cb: UiCallbacks;
  private readonly root: HTMLElement;
  private readonly drop: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressText: HTMLElement;
  private readonly player: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly sectionEl: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly modal: HTMLElement;
  private readonly toastEl: HTMLElement;
  readonly gui: GUI;
  private show: Show | null = null;
  private hidden = false;
  private dragging: 'seek' | 'clipStart' | 'clipEnd' | null = null;
  private clipCtrls: { start: ReturnType<GUI['add']>; end: ReturnType<GUI['add']> } | null = null;

  constructor(cb: UiCallbacks, settings: UiSettings) {
    this.cb = cb;
    this.settings = settings;
    this.root = document.getElementById('ui')!;
    this.root.innerHTML = TEMPLATE;
    const $ = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.drop = $('#drop');
    this.progress = $('#progress');
    this.progressBar = $('#progress .bar i');
    this.progressText = $('#progress .stage');
    this.player = $('#player');
    this.playBtn = $('#play') as HTMLButtonElement;
    this.timeEl = $('#time');
    this.titleEl = $('#song-title');
    this.sectionEl = $('#section-now');
    this.canvas = $('#timeline') as HTMLCanvasElement;
    this.modal = $('#export-modal');
    this.toastEl = $('#toast');

    // ---- file input / drag & drop
    const input = $('#file') as HTMLInputElement;
    $('#choose').addEventListener('click', () => input.click());
    $('#new-song').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) cb.onFile(f);
      input.value = '';
    });
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dragging');
      const f = e.dataTransfer?.files?.[0];
      if (f) cb.onFile(f);
    });

    // ---- transport
    this.playBtn.addEventListener('click', () => cb.onPlayPause());
    $('#export-btn').addEventListener('click', () => cb.onExport());
    $('#clip-start').addEventListener('click', () => this.setClip(cb.getTime(), undefined));
    $('#clip-end').addEventListener('click', () => this.setClip(undefined, cb.getTime()));
    $('#clip-best').addEventListener('click', () => cb.onSuggestClip());
    $('#export-cancel').addEventListener('click', () => cb.onCancelExport());
    $('#export-close').addEventListener('click', () => this.closeExport());
    this.bindTimeline();

    // ---- keyboard
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        cb.onPlayPause();
      } else if (e.key === 'h' || e.key === 'H') {
        this.toggleHidden();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 5;
        cb.onSeek(cb.getTime() + (e.key === 'ArrowLeft' ? -step : step));
      } else if (e.key === 'Home') {
        cb.onSeek(0);
      }
    });

    // ---- settings panel
    this.gui = new GUI({ title: 'Fountain', width: 280 });
    const g = this.gui;
    const show = g.addFolder('Show');
    show.add(settings, 'intensity', 0.3, 1.3, 0.01).name('Jet intensity').onChange(() => cb.onSettings('intensity'));
    show.add(settings, 'theme', ['classic', 'neon', 'sunset', 'monochrome']).name('Palette theme').onChange(() => cb.onSettings('theme'));
    show.add(settings, 'lasers').name('Lasers').onChange(() => cb.onSettings('lasers'));
    show.add(settings, 'mist').name('Mist screen').onChange(() => cb.onSettings('mist'));
    const render = g.addFolder('Render');
    render.add(settings, 'quality', ['Low', 'Medium', 'High', 'Ultra']).name('Water particles').onChange(() => cb.onSettings('quality'));
    render.add(settings, 'bloom', 0, 2, 0.01).name('Bloom').onChange(() => cb.onSettings('bloom'));
    render.add(settings, 'camera', { 'Auto (directed)': 'auto', 'Manual orbit': 'orbit' }).name('Camera').onChange(() => cb.onSettings('camera'));
    const ex = g.addFolder('Export');
    ex.add(settings, 'exportPreset', EXPORT_PRESETS.map((p) => p.label)).name('Size');
    ex.add(settings, 'exportFps', [30, 60]).name('FPS');
    ex.add(settings, 'clip').name('Export clip only').onChange(() => this.drawTimeline());
    this.clipCtrls = {
      start: ex.add(settings, 'clipStart', 0, 1, 0.1).name('Clip start (s)').onChange(() => this.drawTimeline()),
      end: ex.add(settings, 'clipEnd', 0, 1, 0.1).name('Clip end (s)').onChange(() => this.drawTimeline()),
    };
    ex.add({ best: () => cb.onSuggestClip() }, 'best').name('★ Best 30 s (around the drop)');
    ex.add({ go: () => cb.onExport() }, 'go').name('⬇ Export video');
    g.add({ help: () => this.toast('Space: play/pause · H: hide UI · ←/→: scrub 5 s (Shift: 1 s)', 5000) }, 'help').name('Keyboard shortcuts');

    window.addEventListener('resize', () => this.drawTimeline());
  }

  // ------------------------------------------------------------------------- states
  showDrop() {
    this.drop.classList.remove('hidden');
    this.progress.classList.add('hidden');
  }

  showProgress(fraction: number, stage: string) {
    this.drop.classList.add('hidden');
    this.progress.classList.remove('hidden');
    this.progressBar.style.width = `${Math.round(fraction * 100)}%`;
    this.progressText.textContent = stage;
  }

  showError(msg: string) {
    this.progress.classList.add('hidden');
    if (!this.show) this.drop.classList.remove('hidden');
    this.toast(msg, 6000, true);
  }

  setShow(show: Show, title: string) {
    this.show = show;
    this.progress.classList.add('hidden');
    this.drop.classList.add('hidden');
    this.player.classList.remove('hidden');
    this.titleEl.textContent = title.replace(/\.[^.]+$/, '');
    const d = show.data;
    const a = show.analysis;
    const info = this.root.querySelector('#song-info') as HTMLElement;
    const drops = d.drops.length ? ` · ${d.drops.length} drop${d.drops.length > 1 ? 's' : ''}` : '';
    info.textContent = `${Math.round(a.bpm)} BPM${a.beatConfidence < 0.35 ? ' (free tempo)' : ''} · ${d.sections.length} sections${drops} · ${d.markers.filter((m) => m.kind !== 'camera').length} cues`;
    if (this.clipCtrls) {
      this.clipCtrls.start.max(d.duration).updateDisplay();
      this.clipCtrls.end.max(d.duration).updateDisplay();
    }
    this.drawTimeline();
  }

  setClip(start?: number, end?: number) {
    const s = this.settings;
    if (start !== undefined) s.clipStart = Math.max(0, start);
    if (end !== undefined) s.clipEnd = end;
    if (s.clipEnd <= s.clipStart + 1) s.clipEnd = Math.min(this.show?.duration ?? s.clipStart + 30, s.clipStart + 30);
    s.clip = true;
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.drawTimeline();
  }

  toggleHidden() {
    this.hidden = !this.hidden;
    document.body.classList.toggle('ui-hidden', this.hidden);
    if (this.hidden) this.gui.hide();
    else this.gui.show();
  }

  toast(msg: string, ms = 3500, error = false) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.toggle('error', error);
    this.toastEl.classList.add('show');
    clearTimeout((this.toastEl as unknown as { _t?: number })._t);
    (this.toastEl as unknown as { _t?: number })._t = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------------------- export dialog
  openExport(summary: string) {
    this.modal.classList.remove('hidden');
    this.modal.querySelector('.summary')!.textContent = summary;
    this.modal.querySelector('.result')!.innerHTML = '';
    (this.modal.querySelector('.bar i') as HTMLElement).style.width = '0%';
    this.modal.querySelector('.stage')!.textContent = 'Preparing…';
    (this.modal.querySelector('#export-cancel') as HTMLElement).classList.remove('hidden');
    (this.modal.querySelector('#export-close') as HTMLElement).classList.add('hidden');
  }

  exportProgress(fraction: number, text: string) {
    (this.modal.querySelector('.bar i') as HTMLElement).style.width = `${(fraction * 100).toFixed(1)}%`;
    this.modal.querySelector('.stage')!.textContent = text;
  }

  exportDone(url: string, filename: string, sizeMb: number, notes: string[]) {
    this.modal.querySelector('.stage')!.textContent = `Done — ${sizeMb.toFixed(1)} MB`;
    const res = this.modal.querySelector('.result') as HTMLElement;
    res.innerHTML = '';
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.className = 'btn primary';
    a.textContent = `Download ${filename}`;
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.playsInline = true;
    res.append(v, a);
    for (const n of notes) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = n;
      res.append(p);
    }
    (this.modal.querySelector('#export-cancel') as HTMLElement).classList.add('hidden');
    (this.modal.querySelector('#export-close') as HTMLElement).classList.remove('hidden');
  }

  exportFailed(msg: string) {
    this.modal.querySelector('.stage')!.textContent = msg;
    (this.modal.querySelector('#export-cancel') as HTMLElement).classList.add('hidden');
    (this.modal.querySelector('#export-close') as HTMLElement).classList.remove('hidden');
  }

  closeExport() {
    this.modal.classList.add('hidden');
    // unload the preview so it releases the audio output (Safari otherwise keeps Web Audio silent)
    const v = this.modal.querySelector('video');
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
  }

  // ------------------------------------------------------------------------- per-frame
  update(t: number) {
    if (!this.show) return;
    this.timeEl.textContent = `${fmt(t)} / ${fmt(this.show.duration)}`;
    this.playBtn.textContent = this.cb.isPlaying() ? '❚❚' : '▶';
    this.playBtn.setAttribute('aria-label', this.cb.isPlaying() ? 'Pause' : 'Play');
    const sec = this.show.sectionAt(t);
    const txt = `${sec.label} · ${sec.oars} / ${sec.fan} / ${sec.ring}${sec.shooters ? ' / ' + sec.shooters : ''}`;
    if (this.sectionEl.textContent !== txt) {
      this.sectionEl.textContent = txt;
      this.sectionEl.style.borderColor = LABEL_COLORS[sec.label];
    }
    this.drawTimeline(t);
  }

  // ------------------------------------------------------------------------- timeline
  private layout() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  }

  drawTimeline(t = this.cb.getTime()) {
    const show = this.show;
    if (!show || this.player.classList.contains('hidden')) return;
    const { w, h, dpr } = this.layout();
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const d = show.data;
    const X = (tt: number) => (tt / d.duration) * w;
    const secH = 20;
    // sections
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const s of d.sections) {
      const x0 = X(s.start);
      const x1 = X(s.end);
      ctx.fillStyle = LABEL_COLORS[s.label];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x0 + 0.5, 0, Math.max(1, x1 - x0 - 1), secH);
      ctx.globalAlpha = 1;
      if (x1 - x0 > 34) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillText(s.label.toUpperCase(), x0 + 5, secH / 2 + 0.5, x1 - x0 - 8);
      }
    }
    // energy curve
    const a = show.analysis;
    const top = secH + 3;
    const laneH = (h - top) / (LANES.length + 1);
    ctx.beginPath();
    const n = a.energy.length;
    const eH = h - top;
    for (let i = 0; i < w; i++) {
      const idx = Math.min(n - 1, Math.floor((i / w) * n));
      const y = h - a.energy[idx] * eH * 0.9;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,160,255,0.10)';
    ctx.fill();
    // build ramps
    for (const b of a.buildups) {
      const g = ctx.createLinearGradient(X(b.start), 0, X(b.drop), 0);
      g.addColorStop(0, 'rgba(245,166,35,0)');
      g.addColorStop(1, 'rgba(245,166,35,0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(X(b.start), top, X(b.drop) - X(b.start), h - top);
    }
    // cue lanes
    LANES.forEach((lane, li) => {
      const y = top + laneH * (li + 0.5);
      ctx.fillStyle = lane.color;
      ctx.globalAlpha = lane.kind === 'hat' ? 0.45 : 0.9;
      for (const m of d.markers) {
        if (m.kind !== lane.kind) continue;
        const x = X(m.t);
        ctx.fillRect(x - 0.5, y - laneH * 0.3, lane.kind === 'hat' ? 1 : 1.5, laneH * 0.6);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.fillText(lane.label, 3, y);
    });
    // big moments
    const yBig = top + laneH * (LANES.length + 0.5);
    for (const m of d.markers) {
      if (m.kind === 'drop' || m.kind === 'accent' || m.kind === 'finale' || m.kind === 'build') {
        ctx.fillStyle = m.kind === 'drop' ? '#ff3b30' : m.kind === 'build' ? '#f5a623' : '#ffffff';
        const x = X(m.t);
        ctx.beginPath();
        ctx.moveTo(x, yBig - 5);
        ctx.lineTo(x + 4, yBig + 3);
        ctx.lineTo(x - 4, yBig + 3);
        ctx.closePath();
        ctx.fill();
      }
      if (m.kind === 'camera') {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(X(m.t) - 0.5, secH, 1, 3);
      }
    }
    // clip range
    const s = this.settings;
    if (s.clip) {
      const x0 = X(s.clipStart);
      const x1 = X(s.clipEnd);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, x0, h);
      ctx.fillRect(x1, 0, w - x1, h);
      ctx.strokeStyle = '#7ee0ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x0 + 1, 1, x1 - x0 - 2, h - 2);
      ctx.fillStyle = '#7ee0ff';
      ctx.fillRect(x0 - 3, h / 2 - 9, 6, 18);
      ctx.fillRect(x1 - 3, h / 2 - 9, 6, 18);
    }
    // playhead
    const px = X(t);
    ctx.fillStyle = '#fff';
    ctx.fillRect(px - 1, 0, 2, h);
  }

  private bindTimeline() {
    const c = this.canvas;
    const timeAt = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (this.show?.duration ?? 0);
    };
    c.addEventListener('pointerdown', (e) => {
      if (!this.show) return;
      const t = timeAt(e);
      const r = c.getBoundingClientRect();
      const px = (tt: number) => (tt / this.show!.duration) * r.width;
      const x = e.clientX - r.left;
      if (this.settings.clip && Math.abs(x - px(this.settings.clipStart)) < 8) this.dragging = 'clipStart';
      else if (this.settings.clip && Math.abs(x - px(this.settings.clipEnd)) < 8) this.dragging = 'clipEnd';
      else if (e.shiftKey) {
        this.settings.clip = true;
        this.settings.clipStart = t;
        this.settings.clipEnd = t;
        this.dragging = 'clipEnd';
      } else {
        this.dragging = 'seek';
        this.cb.onSeek(t);
      }
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.show) return;
      const t = timeAt(e);
      if (!this.dragging) {
        c.title = `${fmt(t)} — ${this.show.sectionAt(t).label}  (Shift+drag to select a clip)`;
        return;
      }
      if (this.dragging === 'seek') this.cb.onSeek(t);
      else if (this.dragging === 'clipStart') this.settings.clipStart = Math.min(t, this.settings.clipEnd - 1);
      else this.settings.clipEnd = Math.max(t, this.settings.clipStart + 1);
      if (this.dragging !== 'seek') {
        this.gui.controllersRecursive().forEach((ctl) => ctl.updateDisplay());
        this.drawTimeline();
      }
    });
    const end = () => (this.dragging = null);
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
}

const TEMPLATE = /* html */ `
<div id="drop" class="panel center">
  <h1>Fountain</h1>
  <p class="lead">Drop a song</p>
  <p class="sub">MP3 · WAV · M4A — it becomes a choreographed night-time fountain show</p>
  <button id="choose" class="btn primary">Choose a file</button>
  <input id="file" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" hidden />
</div>
<div id="progress" class="panel center hidden">
  <p class="lead">Listening to your song…</p>
  <div class="bar"><i></i></div>
  <p class="stage">Reading file…</p>
</div>
<div id="player" class="hidden">
  <div class="row">
    <button id="play" class="btn round" aria-label="Play">▶</button>
    <div class="meta">
      <div id="song-title"></div>
      <div id="song-info"></div>
    </div>
    <div id="section-now"></div>
    <div class="spacer"></div>
    <span id="time">0:00 / 0:00</span>
    <button id="clip-start" class="btn small" title="Set clip start at playhead">[ In</button>
    <button id="clip-end" class="btn small" title="Set clip end at playhead">Out ]</button>
    <button id="clip-best" class="btn small" title="Pick ~30 s around the first drop">★ Best 30 s</button>
    <button id="new-song" class="btn small">New song</button>
    <button id="export-btn" class="btn primary small">⬇ Export video</button>
  </div>
  <canvas id="timeline"></canvas>
</div>
<div id="export-modal" class="modal hidden">
  <div class="panel">
    <h2>Export video</h2>
    <p class="summary"></p>
    <div class="bar"><i></i></div>
    <p class="stage"></p>
    <div class="result"></div>
    <div class="actions">
      <button id="export-cancel" class="btn">Cancel</button>
      <button id="export-close" class="btn hidden">Close</button>
    </div>
  </div>
</div>
<div id="toast"></div>
<div id="drag-hint">Drop to load</div>
`;
