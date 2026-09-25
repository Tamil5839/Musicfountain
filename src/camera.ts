// Cinematic camera presets and the scheduled "director" that blends between them.
// Every preset is a smooth function of time since the shot started — no shake, ever.

import * as THREE from 'three';
import { POOL_CENTER } from './fountain/layout';
import type { Show } from './show';
import type { CameraPreset, Shot } from './types';

export interface Pose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  /** vertical field of view (degrees) designed for a 16:9 frame */
  fov: number;
}

const C = new THREE.Vector3(...POOL_CENTER);
const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

function hash01(seed: number, k: number): number {
  let h = (seed ^ (k * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function presetPose(preset: CameraPreset, tau: number, seed: number, out: Pose): Pose {
  const r1 = hash01(seed, 1) - 0.5;
  const r2 = hash01(seed, 2) - 0.5;
  const dirSign = hash01(seed, 3) < 0.5 ? -1 : 1;
  switch (preset) {
    case 'wide': {
      out.pos.set(Math.sin(tau * 0.012) * 8 + r1 * 20, 9 + r2 * 3, C.z + 200 - tau * 0.12);
      out.target.set(r1 * 6, 21, C.z);
      out.fov = 40;
      break;
    }
    case 'low': {
      const x0 = r1 * 50;
      out.pos.set(x0 + dirSign * tau * 0.25, 1.1, C.z + 105);
      out.target.set(x0 * 0.3, 27, C.z);
      out.fov = 50;
      break;
    }
    case 'dolly': {
      // slow side dolly that ping-pongs across the pool
      const span = 120;
      const phase = (tau * 1.6) / span + 0.5 + r1;
      const tri = 1 - Math.abs((((phase % 2) + 2) % 2) - 1);
      const x = dirSign * (-span / 2 + span * tri);
      out.pos.set(x, 7 + r2 * 3, C.z + 88);
      out.target.set(x * 0.3, 19, C.z);
      out.fov = 44;
      break;
    }
    case 'crane': {
      const k = ease(tau / 14);
      out.pos.set(r1 * 10, 2.5 + 46 * k, C.z + 120 + 45 * k);
      out.target.set(0, 20 + 8 * k, C.z);
      out.fov = 50 - 8 * k;
      break;
    }
    case 'orbit': {
      const a = r1 * 1.2 + dirSign * tau * 0.02;
      out.pos.set(C.x + Math.sin(a) * 135, 15 + r2 * 6, C.z + Math.cos(a) * 135);
      out.target.set(C.x, 21, C.z);
      out.fov = 44;
      break;
    }
    case 'close': {
      const x0 = r1 * 30;
      out.pos.set(x0 + dirSign * tau * 0.15, 5, C.z + 70 - Math.min(20, tau * 0.35));
      out.target.set(x0 * 0.5, 18, C.z);
      out.fov = 56;
      break;
    }
    case 'high': {
      out.pos.set(r1 * 40 + Math.sin(tau * 0.02) * 10, 72, C.z + 185 - tau * 0.2);
      out.target.set(0, 8, C.z);
      out.fov = 42;
      break;
    }
  }
  return out;
}

/** Adapt a 16:9 vertical FOV to other aspect ratios (portrait keeps the tall jets in frame). */
export function fovForAspect(fov169: number, aspect: number): number {
  const d = Math.PI / 180;
  const h169 = 2 * Math.atan(Math.tan((fov169 * d) / 2) * (16 / 9));
  const k = Math.min(1, Math.max(0, (aspect - 0.5625) / (1.7778 - 0.5625)));
  const hTarget = h169 * (0.62 + 0.38 * k);
  const v = 2 * Math.atan(Math.tan(hTarget / 2) / aspect);
  return Math.min(82, Math.max(fov169, v / d));
}

export class Director {
  private readonly a: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45 };
  private readonly b: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45 };
  readonly current: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45 };

  /** Pose at time t from the show's shot list (or the idle orbit when no show is loaded). */
  evaluate(t: number, show: Show | null): Pose {
    if (!show) {
      presetPose('wide', t, 12345, this.current);
      return this.current;
    }
    const shots: Shot[] = show.data.shots;
    let i = 0;
    for (let k = shots.length - 1; k >= 0; k--)
      if (shots[k].start <= t) {
        i = k;
        break;
      }
    const s = shots[i];
    presetPose(s.preset, Math.max(0, t - s.start), s.seed, this.a);
    const since = t - s.start;
    if (i > 0 && since < s.blend) {
      const p = shots[i - 1];
      presetPose(p.preset, t - p.start, p.seed, this.b);
      const k = ease(since / s.blend);
      this.current.pos.lerpVectors(this.b.pos, this.a.pos, k);
      this.current.target.lerpVectors(this.b.target, this.a.target, k);
      this.current.fov = this.b.fov + (this.a.fov - this.b.fov) * k;
    } else {
      this.current.pos.copy(this.a.pos);
      this.current.target.copy(this.a.target);
      this.current.fov = this.a.fov;
    }
    return this.current;
  }

  apply(camera: THREE.PerspectiveCamera, pose: Pose) {
    camera.position.copy(pose.pos);
    camera.lookAt(pose.target);
    const fov = fovForAspect(pose.fov, camera.aspect);
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
