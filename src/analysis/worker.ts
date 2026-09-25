// Web Worker entry: runs the whole-song analysis off the main thread.

import { analyzeSamples } from './analyze';

interface Request {
  samples: Float32Array;
  sampleRate: number;
  hash: string;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { samples, sampleRate, hash } = e.data;
  try {
    let last = 0;
    const analysis = analyzeSamples(samples, sampleRate, hash, (p, stage) => {
      const now = performance.now();
      if (now - last > 60 || p >= 1) {
        last = now;
        self.postMessage({ type: 'progress', p, stage });
      }
    });
    self.postMessage({ type: 'done', analysis });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
