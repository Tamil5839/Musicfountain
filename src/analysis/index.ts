// Main-thread entry for song loading: decode, hash, cached analysis via a Web Worker.

import type { Analysis } from '../types';
import { ANALYSIS_VERSION } from './analyze';
import { ANALYSIS_SR } from './features';

export const PLAYBACK_SR = 48000;

export interface LoadedSong {
  name: string;
  hash: string;
  /** Full-quality stereo buffer used for playback and export. */
  buffer: AudioBuffer;
  analysis: Analysis;
  fromCache: boolean;
}

export type LoadProgress = (fraction: number, stage: string) => void;

export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function decodeFile(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, 1, PLAYBACK_SR);
  return await ctx.decodeAudioData(bytes.slice(0));
}

/** Mixes down to mono and resamples to the analysis rate with an OfflineAudioContext. */
export async function toAnalysisMono(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil(buffer.duration * ANALYSIS_SR));
  const ctx = new OfflineAudioContext(1, length, ANALYSIS_SR);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export function analyzeInWorker(samples: Float32Array, sampleRate: number, hash: string, onProgress: LoadProgress): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.p, msg.stage);
      else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.analysis as Analysis);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Analysis worker failed'));
    };
    worker.postMessage({ samples, sampleRate, hash }, [samples.buffer]);
  });
}

// ------------------------------------------------------------------------------ IndexedDB cache
const DB_NAME = 'fountain';
const STORE = 'analysis';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheGet(key: string): Promise<Analysis | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as Analysis) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cachePut(key: string, value: Analysis): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadSong(file: File, onProgress: LoadProgress): Promise<LoadedSong> {
  onProgress(0, 'Reading file…');
  const bytes = await file.arrayBuffer();
  const hash = await hashBytes(bytes);
  onProgress(0.02, 'Decoding audio…');
  let buffer: AudioBuffer;
  try {
    buffer = await decodeFile(bytes);
  } catch {
    throw new Error("Couldn't decode this file. Try an MP3, WAV or M4A (AAC).");
  }
  if (buffer.duration < 5) throw new Error('This clip is too short — drop a song of at least 5 seconds.');
  const key = `${hash}:${ANALYSIS_VERSION}`;
  const cached = await cacheGet(key);
  if (cached && cached.version === ANALYSIS_VERSION) {
    onProgress(1, 'Loaded from cache');
    return { name: file.name, hash, buffer, analysis: cached, fromCache: true };
  }
  onProgress(0.05, 'Listening to your song…');
  const mono = await toAnalysisMono(buffer);
  const analysis = await analyzeInWorker(mono, ANALYSIS_SR, hash, (p, stage) => onProgress(0.05 + p * 0.9, stage));
  await cachePut(key, analysis);
  return { name: file.name, hash, buffer, analysis, fromCache: false };
}
