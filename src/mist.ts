// Mist screen: a wide fog curtain behind the fountain, drawn as several stacked noise layers.
// Mist is only visible where light hits it: its own palette glow, spill from the underwater
// lamps of the fan jets below it, and shape projections (rings, lines, bars, spots) timed to
// the music. Lasers (lasers.ts) use the same density function so beams only show in the mist.

import * as THREE from 'three';
import { FAN, MIST_WIDTH, MIST_Z } from './fountain/layout';
import { JET_TEX_W, ROW, type NozzleBank } from './fountain/nozzles';
import type { Lights } from './lights';
import type { Show } from './show';
import type { MistCue, ProjectionKind } from './types';

export const MIST_HEIGHT = 58;
const MAX_PROJ = 8;
const LAYERS = [-2.6, -1.3, 0, 1.3, 2.6];

/** GLSL: mist density at a world position. Needs uMistTime, uMistDensity, uMistHeight. */
export const MIST_DENSITY_GLSL = /* glsl */ `
uniform float uMistTime;
uniform float uMistDensity;
uniform float uMistHeight;
float mHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float mNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mHash(i), mHash(i + vec3(1, 0, 0)), f.x), mix(mHash(i + vec3(0, 1, 0)), mHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(mHash(i + vec3(0, 0, 1)), mHash(i + vec3(1, 0, 1)), f.x), mix(mHash(i + vec3(0, 1, 1)), mHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float mFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * mNoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return v;
}
float mistDensity(vec3 p) {
  float t = uMistTime;
  float x = p.x;
  float halfW = ${(MIST_WIDTH / 2).toFixed(1)};
  float edge = smoothstep(halfW, halfW - 22.0, abs(x));
  float H = uMistHeight;
  float vert = smoothstep(-0.5, 3.0, p.y) * (1.0 - smoothstep(H * 0.3, H, p.y));
  vec3 q = vec3(x * 0.04 + t * 0.03, p.y * 0.055 - t * 0.11, t * 0.03 + p.z * 0.08);
  float n = mFbm(q);
  float n2 = mFbm(q * 2.4 + vec3(-t * 0.05, -t * 0.09, 3.1));
  // a fairly even sheet with soft billows (real mist screens are not clumpy smoke)
  float d = clamp(0.5 + (n - 0.5) * 0.9 + (n2 - 0.5) * 0.5, 0.0, 1.0);
  float zm = exp(-pow((p.z - ${MIST_Z.toFixed(1)}) / 4.0, 2.0));
  return uMistDensity * edge * vert * d * zm;
}`;

const KIND_ID: Record<ProjectionKind, number> = { ring: 1, line: 2, bars: 3, spot: 4, flash: 5, rise: 6 };

export class Mist {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  enabled = true;
  /** current density (0..1) for lasers */
  density = 0;
  height = MIST_HEIGHT;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMistTime: { value: 0 },
        uMistDensity: { value: 0.6 },
        uMistHeight: { value: MIST_HEIGHT },
        uColors: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(1, 1, 1)] },
        uGlow: { value: 0.4 },
        uGain: { value: 0.13 },
        uLight: { value: 1 },
        uSpill: { value: new THREE.Color() },
        uProj: { value: Array.from({ length: MAX_PROJ }, () => new THREE.Vector4()) },
        uProjPos: { value: Array.from({ length: MAX_PROJ }, () => new THREE.Vector4()) },
        uProjCol: { value: Array.from({ length: MAX_PROJ }, () => new THREE.Color()) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${MIST_DENSITY_GLSL}
        uniform vec3 uColors[4];
        uniform float uGlow;
        uniform float uGain;
        uniform float uLight;
        uniform vec3 uSpill;
        uniform vec4 uProj[${MAX_PROJ}];
        uniform vec4 uProjPos[${MAX_PROJ}];
        uniform vec3 uProjCol[${MAX_PROJ}];
        varying vec3 vWorld;
        void main() {
          float dens = mistDensity(vWorld);
          if (dens < 0.002) discard;
          float x = vWorld.x;
          float y = vWorld.y;
          float yn = clamp(y / uMistHeight, 0.0, 1.0);
          vec3 light = mix(uColors[1], uColors[0], yn) * uGlow * 0.55;
          light += uSpill * exp(-y / 10.0) * 0.9;
          for (int i = 0; i < ${MAX_PROJ}; i++) {
            vec4 pr = uProj[i];
            if (pr.x < 0.5) continue;
            vec4 pp = uProjPos[i];
            float age = pr.y;
            float fade = clamp(1.0 - age / pr.z, 0.0, 1.0);
            float v = 0.0;
            if (pr.x < 1.5) {
              float r = pp.z + pp.w * age;
              float d = length(vec2(x - pp.x, y - pp.y));
              v = exp(-pow((d - r) / 1.4, 2.0));
            } else if (pr.x < 2.5) {
              float yl = pp.y + pp.w * age;
              v = exp(-pow((y - yl) / 1.1, 2.0));
            } else if (pr.x < 3.5) {
              float w = (fract(x / pp.z + pp.w * 0.5 + 0.25) - 0.5) * pp.z;
              v = exp(-w * w / 1.2) * fade;
            } else if (pr.x < 4.5) {
              float d = length(vec2(x - pp.x, y - pp.y));
              v = exp(-d * d / (pp.z * pp.z)) * sin(3.14159 * clamp(age / pr.z, 0.0, 1.0)) * 1.6;
              fade = 1.0;
            } else if (pr.x < 5.5) {
              v = 0.35;
              fade *= fade * fade;
            } else {
              float yl = pp.w * age;
              v = exp(-pow((y - yl) / 2.2, 2.0)) + 0.5 * exp(-pow((y - yl * 0.6) / 1.5, 2.0));
            }
            light += uProjCol[i] * v * fade * pr.w * 1.1;
          }
          vec3 col = (light * uLight + vec3(0.012, 0.014, 0.02)) * dens * uGain;
          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    for (const dz of LAYERS) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(MIST_WIDTH + 20, MIST_HEIGHT + 4, 1, 1), this.material);
      plane.position.set(0, MIST_HEIGHT / 2, MIST_Z + dz);
      plane.renderOrder = 2;
      this.group.add(plane);
    }
  }

  /** Uniforms shared with the laser shader. */
  get sharedUniforms() {
    const u = this.material.uniforms;
    return { uMistTime: u.uMistTime, uMistDensity: u.uMistDensity, uMistHeight: u.uMistHeight };
  }

  update(t: number, show: Show | null, lights: Lights, bank: NozzleBank) {
    const u = this.material.uniforms;
    u.uMistTime.value = t;
    let density = 0.55;
    let glow = 0.35;
    if (show) {
      density = show.curve('mist', t);
      glow = show.curve('glow', t);
    }
    if (!this.enabled) density = 0;
    this.density = density;
    u.uMistDensity.value = density;
    u.uMistHeight.value = MIST_HEIGHT * (0.55 + 0.45 * density);
    u.uGlow.value = glow * (0.4 + 0.6 * lights.master) + lights.flash * 0.8;
    u.uLight.value = show ? Math.min(1.2, lights.master + 0.15) : 0.6;
    for (let k = 0; k < 4; k++) (u.uColors.value as THREE.Color[])[k].copy(lights.palette[k]);
    // spill from the fan lamps directly below the screen
    const spill = u.uSpill.value as THREE.Color;
    spill.setRGB(0, 0, 0);
    const tex = bank.tex;
    for (const j of FAN) {
      const o = (ROW.light * JET_TEX_W + j.id) * 4;
      const w = tex[o + 3] / FAN.length;
      spill.r += tex[o] * w;
      spill.g += tex[o + 1] * w;
      spill.b += tex[o + 2] * w;
    }
    // projections active at t
    const proj = u.uProj.value as THREE.Vector4[];
    const pos = u.uProjPos.value as THREE.Vector4[];
    const col = u.uProjCol.value as THREE.Color[];
    let n = 0;
    if (show) {
      const cues = show.data.mistCues;
      let lo = 0;
      let hi = cues.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (cues[m].t < t - 3) lo = m + 1;
        else hi = m;
      }
      for (let k = lo; k < cues.length && n < MAX_PROJ; k++) {
        const c: MistCue = cues[k];
        if (c.t > t) break;
        const age = t - c.t;
        if (age > c.dur) continue;
        proj[n].set(KIND_ID[c.kind], age, c.dur, c.strength);
        pos[n].set(c.x, c.y, c.size, c.speed);
        col[n].copy(lights.palette[c.color] ?? lights.palette[3]);
        n++;
      }
    }
    for (; n < MAX_PROJ; n++) proj[n].set(0, 0, 1, 0);
    this.group.visible = this.enabled;
  }
}
