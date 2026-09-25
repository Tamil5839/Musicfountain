// Underwater lights: every nozzle has a lamp whose color comes from the section palette.
// The lamps color the water column from below (the particle shader reads them) and show up
// as glowing pools on the water surface.

import * as THREE from 'three';
import { JETS, JET_COUNT } from './fountain/layout';
import { JET_TEX_H, JET_TEX_W, type NozzleBank } from './fountain/nozzles';
import type { Show } from './show';
import type { ColorMode, Family, SectionPlan } from './types';

export type ThemeName = 'classic' | 'neon' | 'sunset' | 'monochrome';

type Hex3 = [string, string, string];
export const THEMES: Record<ThemeName, Hex3[]> = {
  classic: [
    ['#fff1d6', '#ffc861', '#ffffff'],
    ['#ffd27a', '#fff8ee', '#ffb347'],
    ['#f3f6ff', '#ffe2a8', '#ffcf6e'],
    ['#ffb95e', '#fff1d6', '#ffe7b0'],
    ['#fff9f0', '#d9e8ff', '#ffd78f'],
    ['#ffdca0', '#ffae5c', '#ffffff'],
  ],
  neon: [
    ['#ff2bd6', '#19e6ff', '#7a5cff'],
    ['#2b6bff', '#b6ff2b', '#ff2b9d'],
    ['#9d2bff', '#ff5ec8', '#2bffd5'],
    ['#ff7a1a', '#1ad9ff', '#ff2b5e'],
    ['#19ff8c', '#2b9dff', '#fffb2b'],
    ['#ff2b2b', '#2b3dff', '#ffffff'],
  ],
  sunset: [
    ['#ff7a45', '#ff4f8b', '#ffd166'],
    ['#ff5e62', '#9b5de5', '#ffb86b'],
    ['#f9a03f', '#d7263d', '#ffe29a'],
    ['#ff8fab', '#fb6f92', '#ffc2d1'],
    ['#c86bfa', '#ff9e7a', '#ffd6a5'],
    ['#ff6b35', '#f7c59f', '#ef476f'],
  ],
  monochrome: [
    ['#ffffff', '#cfd8e6', '#ffffff'],
    ['#e8eef8', '#9fb3cc', '#ffffff'],
    ['#fdfdfd', '#bdc6d3', '#e6ecf5'],
    ['#dbe6ff', '#ffffff', '#aabbd4'],
    ['#ffffff', '#8fa1bb', '#d0dae8'],
    ['#f0f4fa', '#c4ceda', '#ffffff'],
  ],
};

const FAMILY_BOOST: Record<Family, number> = { shooter: 1.7, oarsman: 1.0, fan: 0.6, ring: 1.0 };
const WHITE = new THREE.Color(1, 1, 1);

export class Lights {
  private palettes: THREE.Color[][] = [];
  /** Current (blended, desaturated) palette for mist / lasers: primary, secondary, accent, white. */
  readonly palette = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(1, 1, 1)];
  /** overall light level after master / flash (for mist glow etc.) */
  master = 0;
  flash = 0;
  readonly glowMesh: THREE.Mesh;
  private readonly tmpA = new THREE.Color();
  private readonly colA: THREE.Color[] = JETS.map(() => new THREE.Color());
  private readonly colB: THREE.Color[] = JETS.map(() => new THREE.Color());

  constructor(theme: ThemeName, jetTex: THREE.DataTexture) {
    this.setTheme(theme);
    this.glowMesh = makeGlowMesh(jetTex);
  }

  setJetTexture(tex: THREE.DataTexture) {
    (this.glowMesh.material as THREE.ShaderMaterial).uniforms.tJets.value = tex;
  }

  setTheme(theme: ThemeName) {
    this.palettes = THEMES[theme].map((p) => p.map((hex) => new THREE.Color(hex)));
  }

  /** Compute every lamp for time t and write them into the nozzle bank's jet texture. */
  update(t: number, show: Show | null, bank: NozzleBank) {
    if (!show) {
      this.idle(t, bank);
      return;
    }
    const idx = show.sectionIndexAt(t);
    const secs = show.data.sections;
    const cur = secs[idx];
    // crossfade around section boundaries (drops switch instantly for impact)
    let blend = 1;
    let other: SectionPlan | null = null;
    const next = secs[idx + 1];
    const XF = 0.7;
    if (next && next.label !== 'drop' && next.start - t < XF) {
      other = next;
      blend = 0.5 - 0.5 * ((next.start - t) / XF);
    } else if (idx > 0 && cur.label !== 'drop' && t - cur.start < XF) {
      other = secs[idx - 1];
      blend = 0.5 - 0.5 * ((t - cur.start) / XF);
    }
    const beat = show.beatPos(t);
    this.fillColors(cur, beat, this.colA);
    if (other) this.fillColors(other, beat, this.colB);

    const sat = show.curve('saturation', t);
    const master = show.curve('light', t);
    const flash = show.curve('flash', t);
    this.master = master;
    this.flash = flash;
    for (let j = 0; j < JET_COUNT; j++) {
      const jet = JETS[j];
      const c = this.tmpA.copy(this.colA[j]);
      if (other) c.lerp(this.colB[j], blend);
      desaturate(c, sat);
      if (flash > 0) c.lerp(WHITE, flash * 0.45);
      const valve = bank.valve[j];
      const wake = show.wake(jet.family, t);
      const intensity = master * wake * (0.08 + 0.92 * Math.pow(valve, 0.6)) * (1 + 0.45 * flash) * FAMILY_BOOST[jet.family];
      bank.setLight(j, c.r, c.g, c.b, intensity);
    }
    // palette for mist / lasers
    const pa = this.palettes[cur.palette % this.palettes.length];
    const pb = other ? this.palettes[other.palette % this.palettes.length] : pa;
    for (let k = 0; k < 3; k++) {
      this.palette[k].copy(pa[k]);
      if (other) this.palette[k].lerp(pb[k], blend);
      desaturate(this.palette[k], sat);
    }
  }

  private idle(t: number, bank: NozzleBank) {
    this.palette[0].set('#3a7bff');
    this.palette[1].set('#7fd6ff');
    this.palette[2].set('#ffffff');
    this.master = 0.5;
    this.flash = 0;
    for (let j = 0; j < JET_COUNT; j++) {
      const jet = JETS[j];
      const c = this.tmpA.copy(this.palette[jet.family === 'fan' ? 0 : 1]);
      const pulse = 0.8 + 0.2 * Math.sin(t * 0.7 + jet.u * 2);
      bank.setLight(j, c.r, c.g, c.b, 0.4 * pulse * (0.1 + 0.9 * bank.valve[j]));
    }
  }

  private fillColors(p: SectionPlan, beat: number, out: THREE.Color[]) {
    const pal = this.palettes[p.palette % this.palettes.length];
    const [pri, sec, acc] = pal;
    const mode: ColorMode = p.colorMode;
    for (let j = 0; j < JET_COUNT; j++) {
      const jet = JETS[j];
      const o = out[j];
      const x = (jet.u + 1) / 2;
      switch (jet.family) {
        case 'shooter':
          o.copy(acc).lerp(WHITE, 0.45);
          break;
        case 'ring':
          o.copy(mode === 'alternate' && jet.famIndex % 2 ? pri : acc);
          break;
        case 'oarsman':
        case 'fan': {
          const a = jet.family === 'oarsman' ? pri : sec;
          const b = jet.family === 'oarsman' ? sec : pri;
          switch (mode) {
            case 'solid':
              o.copy(a);
              break;
            case 'alternate':
              o.copy(jet.famIndex % 2 ? b : a);
              break;
            case 'gradient':
              o.copy(a).lerp(b, x);
              break;
            case 'chase':
              o.copy(a).lerp(acc, 0.5 + 0.5 * Math.sin(Math.PI * 2 * (beat / 8 - x)));
              break;
            case 'split':
              o.copy(jet.u < 0 ? a : b);
              break;
          }
          break;
        }
      }
    }
  }
}

function desaturate(c: THREE.Color, sat: number) {
  if (sat >= 0.999) return;
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const w = Math.max(l, 0.85);
  c.r = w + (c.r - w) * sat;
  c.g = w + (c.g - w) * sat;
  c.b = w + (c.b - w) * sat;
}

/** Instanced glowing light pools on the water surface, one per nozzle. */
function makeGlowMesh(jetTex: THREE.DataTexture): THREE.Mesh {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1], 3));
  geo.setIndex([0, 2, 1, 2, 3, 1]);
  const ids = new Float32Array(JET_COUNT);
  for (let j = 0; j < JET_COUNT; j++) ids[j] = j;
  geo.setAttribute('jet', new THREE.InstancedBufferAttribute(ids, 1));
  geo.instanceCount = JET_COUNT;
  const mat = new THREE.ShaderMaterial({
    uniforms: { tJets: { value: jetTex }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform sampler2D tJets;
      uniform float uScale;
      attribute float jet;
      varying vec2 vP;
      varying vec4 vL;
      vec4 jetRow(float j, float row) {
        return texture2D(tJets, vec2((j + 0.5) / ${JET_TEX_W.toFixed(1)}, (row + 0.5) / ${JET_TEX_H.toFixed(1)}));
      }
      void main() {
        vec4 N = jetRow(jet, 0.0);
        vL = jetRow(jet, 4.0);
        float fam = jetRow(jet, 5.0).z;
        float size = (fam < 0.5 ? 9.0 : fam > 2.5 ? 5.0 : 6.0) * uScale;
        vP = position.xz;
        vec3 w = N.xyz + vec3(position.x * size, 0.04, position.z * size);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      varying vec4 vL;
      void main() {
        float r2 = dot(vP, vP);
        float core = exp(-r2 * 60.0);
        float halo = exp(-r2 * 5.0) * 0.22;
        gl_FragColor = vec4(vL.rgb * vL.w * (core * 2.2 + halo), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}
