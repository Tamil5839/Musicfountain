// Offline video export: renders every frame with a fixed timestep (never real time, so it is
// frame-perfect on any machine), encodes H.264 + AAC with WebCodecs and muxes an MP4 with
// mp4-muxer ("fast start" moov first, so it streams and uploads to X cleanly).

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Stage } from './stage';

export interface ExportPreset {
  label: string;
  width: number;
  height: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { label: '1920×1080 (16:9)', width: 1920, height: 1080 },
  { label: '1080×1920 (9:16)', width: 1080, height: 1920 },
  { label: '1080×1080 (1:1)', width: 1080, height: 1080 },
];

export interface ExportOptions {
  width: number;
  height: number;
  fps: 30 | 60;
  start: number;
  end: number;
  audio: AudioBuffer;
  /** Mbit/s; default depends on size and frame rate */
  bitrateMbps?: number;
  /** called after rendering to put the canvas back to its on-screen size */
  restoreView?: () => void;
}

export interface ExportProgress {
  frame: number;
  frames: number;
  fraction: number;
  etaSeconds: number;
  stage: string;
}

export interface ExportResult {
  blob: Blob;
  audioCodec: 'aac' | 'opus';
  videoCodec: string;
  warnings: string[];
}

const AUDIO_SR = 48000;

export function exportSupported(): string | null {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return 'This browser has no WebCodecs video encoder. Use a recent Chrome, Edge or Safari.';
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return 'This browser has no WebCodecs audio encoder. Use a recent Chrome, Edge or Safari.';
  return null;
}

type MuxVideoCodec = 'avc' | 'vp9' | 'av1';

async function pickVideoConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<{ config: VideoEncoderConfig; mux: MuxVideoCodec }> {
  const big = width * height * fps > 1920 * 1080 * 30;
  const avc = big
    ? ['avc1.64002A', 'avc1.640032', 'avc1.4D002A', 'avc1.42002A']
    : ['avc1.640028', 'avc1.64002A', 'avc1.4D0028', 'avc1.42E028', 'avc1.42002A'];
  // H.264 first (what X / QuickTime want); VP9 / AV1 only as a last resort
  const candidates: [string, MuxVideoCodec][] = [
    ...avc.map((c): [string, MuxVideoCodec] => [c, 'avc']),
    ['vp09.00.41.08', 'vp9'],
    ['av01.0.09M.08', 'av1'],
  ];
  for (const hw of ['no-preference', 'prefer-software'] as HardwareAcceleration[]) {
    for (const [codec, mux] of candidates) {
      const cfg: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        bitrateMode: 'variable',
        latencyMode: 'quality',
        hardwareAcceleration: hw,
        ...(mux === 'avc' ? { avc: { format: 'avc' as const } } : {}),
      };
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) return { config: res.config ?? cfg, mux };
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(`This browser can't encode video at ${width}×${height} ${fps}fps.`);
}

async function pickAudioConfig(): Promise<{ config: AudioEncoderConfig; codec: 'aac' | 'opus' }> {
  const aac: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: AUDIO_SR, numberOfChannels: 2, bitrate: 192000 };
  try {
    if ((await AudioEncoder.isConfigSupported(aac)).supported) return { config: aac, codec: 'aac' };
  } catch {
    /* fall through */
  }
  const opus: AudioEncoderConfig = { codec: 'opus', sampleRate: AUDIO_SR, numberOfChannels: 2, bitrate: 192000 };
  if ((await AudioEncoder.isConfigSupported(opus)).supported) return { config: opus, codec: 'opus' };
  throw new Error('This browser cannot encode audio (AAC or Opus).');
}

/**
 * AAC encoders prepend "priming" samples that most players don't trim without an edit list,
 * which would make the audio late by 20–45 ms. Measure the delay once by round-tripping a click
 * through the encoder + decoder, so the export can start the audio that much later.
 */
async function measureAudioDelay(config: AudioEncoderConfig): Promise<number> {
  if (typeof AudioDecoder === 'undefined') return 0;
  try {
    const n = AUDIO_SR / 2;
    const clickAt = 9600;
    const data = new Float32Array(n * 2);
    for (let c = 0; c < 2; c++) for (let i = 0; i < 48; i++) data[c * n + clickAt + i] = Math.sin((i / 48) * Math.PI) * 0.9;
    const chunks: EncodedAudioChunk[] = [];
    let decoderConfig: AudioDecoderConfig | undefined;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        chunks.push(chunk);
        if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      },
      error: () => {},
    });
    enc.configure(config);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: AUDIO_SR, numberOfFrames: n, numberOfChannels: 2, timestamp: 0, data }));
    await enc.flush();
    enc.close();
    if (!decoderConfig) return 0;
    const out: Float32Array[] = [];
    const dec = new AudioDecoder({
      output: (ad) => {
        const buf = new Float32Array(ad.numberOfFrames);
        ad.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
        out.push(buf);
        ad.close();
      },
      error: () => {},
    });
    dec.configure(decoderConfig);
    for (const c of chunks) dec.decode(c);
    await dec.flush();
    dec.close();
    const all = new Float32Array(out.reduce((s, b) => s + b.length, 0));
    let o = 0;
    for (const b of out) {
      all.set(b, o);
      o += b.length;
    }
    let best = 0;
    let bestI = -1;
    for (let i = 0; i < all.length; i++) {
      const v = Math.abs(all[i]);
      if (v > best) {
        best = v;
        bestI = i;
      }
    }
    if (bestI < 0 || best < 0.1) return 0;
    const delay = bestI - (clickAt + 24);
    return delay > 0 && delay < 4096 ? delay : 0;
  } catch {
    return 0;
  }
}

export async function exportVideo(
  stage: Stage,
  opts: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const unsupported = exportSupported();
  if (unsupported) throw new Error(unsupported);
  const { width, height, fps } = opts;
  const warnings: string[] = [];
  const pixelsRel = (width * height) / (1920 * 1080);
  const bitrate = Math.round((opts.bitrateMbps ?? (fps === 60 ? 16 : 11) * Math.max(0.6, pixelsRel)) * 1e6);
  const video = await pickVideoConfig(width, height, fps, bitrate);
  const videoConfig = video.config;
  if (video.mux !== 'avc')
    warnings.push(
      `This browser has no H.264 encoder, so the video is ${video.mux.toUpperCase()}. It plays in browsers and VLC, but X and QuickTime need H.264 — export from Chrome/Edge on macOS or Windows, or from Safari.`,
    );
  const audio = await pickAudioConfig();
  if (audio.codec !== 'aac')
    warnings.push('This browser has no AAC encoder, so the audio track is Opus. It plays in browsers/VLC but QuickTime and X need AAC — export from Chrome on macOS/Windows or Safari for AAC.');
  const audioDelay = audio.codec === 'aac' ? await measureAudioDelay(audio.config) : 0;

  const frames = Math.max(1, Math.round((opts.end - opts.start) * fps));
  const duration = frames / fps;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: video.mux, width, height, frameRate: fps },
    audio: { codec: audio.codec, numberOfChannels: 2, sampleRate: AUDIO_SR },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encodeError: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e instanceof Error ? e : new Error(String(e))),
  });
  venc.configure(videoConfig);
  const aenc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, fixAacDescription(meta)),
    error: (e) => (encodeError = e instanceof Error ? e : new Error(String(e))),
  });
  aenc.configure(audio.config);

  // ---- audio: the exact same span as the video, with short fades at clip edges
  onProgress({ frame: 0, frames, fraction: 0, etaSeconds: 0, stage: 'Encoding audio…' });
  encodeAudio(aenc, opts.audio, opts.start, duration, audioDelay);

  // ---- video: offline, fixed timestep
  const canvas = stage.renderer.domElement;
  const prevTime = stage.simTime;
  stage.setSize(width, height, 1);
  const t0 = performance.now();
  try {
    onProgress({ frame: 0, frames, fraction: 0, etaSeconds: 0, stage: 'Warming up the fountain…' });
    stage.seek(opts.start);
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      const t = opts.start + i / fps;
      stage.advanceTo(t);
      stage.render(t);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps), alpha: 'discard' });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      if (i % 2 === 0 || i === frames - 1) {
        const el = (performance.now() - t0) / 1000;
        const eta = (el / (i + 1)) * (frames - i - 1);
        onProgress({ frame: i + 1, frames, fraction: (i + 1) / frames, etaSeconds: eta, stage: 'Rendering frames…' });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    onProgress({ frame: frames, frames, fraction: 1, etaSeconds: 0, stage: 'Finishing the MP4…' });
    await venc.flush();
    await aenc.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
  } finally {
    try {
      venc.close();
    } catch {
      /* closed */
    }
    try {
      aenc.close();
    } catch {
      /* closed */
    }
    opts.restoreView?.();
    stage.seek(prevTime);
  }
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    audioCodec: audio.codec,
    videoCodec: videoConfig.codec,
    warnings,
  };
}

/**
 * Safari's AAC encoder hands back a whole ES_Descriptor (the esds payload) as the decoder
 * description instead of the bare AudioSpecificConfig. mp4-muxer wraps the description in its
 * own esds, so the file ends up with a descriptor nested inside a descriptor and no player can
 * decode the audio (silent MP4). Unwrap it to the DecoderSpecificInfo (tag 0x05) payload.
 */
function fixAacDescription(meta: EncodedAudioChunkMetadata | undefined): EncodedAudioChunkMetadata | undefined {
  const cfg = meta?.decoderConfig;
  if (!cfg?.description || !cfg.codec.startsWith('mp4a')) return meta;
  const d = cfg.description;
  const bytes = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  if (bytes[0] !== 0x03) return meta; // already a bare AudioSpecificConfig
  const asc = findDescriptor(bytes, 0x05);
  return asc ? { ...meta, decoderConfig: { ...cfg, description: asc.slice() } } : meta;
}

/** Walks MPEG-4 descriptors (ES_Descr 0x03 → DecoderConfigDescr 0x04 → 0x05) and returns the payload of `tag`. */
function findDescriptor(b: Uint8Array, tag: number): Uint8Array | null {
  let i = 0;
  while (i < b.length) {
    const t = b[i++];
    let len = 0;
    for (let k = 0; k < 4 && i < b.length; k++) {
      const c = b[i++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    const body = b.subarray(i, Math.min(b.length, i + len));
    if (t === tag) return body;
    // ES_Descr: ES_ID(2) + flags(1) [+ optional fields, not set by encoders]; DecoderConfig: 13 bytes of fields
    if (t === 0x03) return findDescriptor(body.subarray(3), tag);
    if (t === 0x04) return findDescriptor(body.subarray(13), tag);
    i += len;
  }
  return null;
}

function encodeAudio(enc: AudioEncoder, buf: AudioBuffer, start: number, duration: number, delay: number) {
  const sr = buf.sampleRate;
  if (sr !== AUDIO_SR) throw new Error('Audio must be decoded at 48 kHz.');
  const total = Math.round(duration * sr);
  const first = Math.round(start * sr) + delay;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const fadeIn = start > 0.01 ? Math.round(0.02 * sr) : 0;
  const fadeOut = start + duration < buf.duration - 0.05 ? Math.round(0.35 * sr) : Math.round(0.01 * sr);
  const CH = 4800;
  for (let off = 0; off < total; off += CH) {
    const n = Math.min(CH, total - off);
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const k = off + i;
      const src = first + k;
      let g = 1;
      if (k < fadeIn) g = k / fadeIn;
      if (k > total - fadeOut) g = Math.min(g, (total - k) / fadeOut);
      data[i] = src >= 0 && src < L.length ? L[src] * g : 0;
      data[n + i] = src >= 0 && src < R.length ? R[src] * g : 0;
    }
    enc.encode(
      new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off * 1e6) / sr), data }),
    );
  }
}

/** Suggested clip: ~30 s around the first drop (or the biggest chorus), snapped to bars. */
export function suggestClip(stage: Stage, length = 30): { start: number; end: number } {
  const show = stage.show;
  if (!show) return { start: 0, end: length };
  const d = show.data;
  const dur = d.duration;
  let focus = d.drops[0];
  if (focus === undefined) {
    const loud = [...d.sections].filter((s) => s.tier === 'intense' || s.label === 'chorus').sort((a, b) => a.start - b.start)[0];
    focus = loud ? loud.start : dur * 0.35;
  }
  let start = Math.max(0, focus - length * 0.35);
  const db = d.downbeats;
  if (db.length) {
    const near = db.reduce((b, x) => (Math.abs(x - start) < Math.abs(b - start) ? x : b), db[0]);
    if (Math.abs(near - start) < 2.5) start = near;
  }
  let end = Math.min(dur, start + length);
  if (end - start < length) start = Math.max(0, end - length);
  end = Math.min(dur, start + length);
  return { start, end };
}
