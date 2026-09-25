// Lasers: thin additive beams from three emitters at the foot of the mist screen. A beam is
// only visible where it passes through mist (same density function as the mist screen), so
// they read as real lasers cutting through fog rather than glowing sticks.

import * as THREE from 'three';
import { MIST_Z } from './fountain/layout';
import type { Lights } from './lights';
import { MIST_DENSITY_GLSL, type Mist } from './mist';
import type { Show } from './show';
import type { LaserCue } from './types';

const MAX_BEAMS = 48;
const BEAM_LEN = 95;
const EMITTERS: [number, number, number][] = [
  [0, 0.4, MIST_Z + 0.6],
  [-58, 0.4, MIST_Z + 0.6],
  [58, 0.4, MIST_Z + 0.6],
];
const DEG = Math.PI / 180;

export class Lasers {
  readonly mesh: THREE.Mesh;
  enabled = true;
  private readonly origin: THREE.InstancedBufferAttribute;
  private readonly dir: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(mist: Mist) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 2, 1, 2, 3, 1]);
    this.origin = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 3), 3);
    this.dir = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 3), 3);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 4), 4);
    for (const a of [this.origin, this.dir, this.color]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('origin', this.origin);
    geo.setAttribute('dir', this.dir);
    geo.setAttribute('beamColor', this.color);
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...mist.sharedUniforms, uLen: { value: BEAM_LEN } },
      vertexShader: /* glsl */ `
        uniform float uLen;
        attribute vec3 origin;
        attribute vec3 dir;
        attribute vec4 beamColor;
        varying vec3 vWorld;
        varying vec4 vColor;
        varying float vAcross;
        varying float vAlong;
        void main() {
          vec3 p = origin + dir * uLen * position.x;
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(dir, toCam));
          float width = 0.12 + 0.0045 * length(cameraPosition - p);
          p += side * width * position.y;
          vWorld = p;
          vColor = beamColor;
          vAcross = position.y;
          vAlong = position.x;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${MIST_DENSITY_GLSL}
        varying vec3 vWorld;
        varying vec4 vColor;
        varying float vAcross;
        varying float vAlong;
        void main() {
          float d = mistDensity(vWorld);
          float core = exp(-vAcross * vAcross * 9.0) + 0.25 * exp(-vAcross * vAcross * 2.0);
          float vis = 0.003 + d * 1.6;
          float end = smoothstep(1.0, 0.8, vAlong) * smoothstep(0.0, 0.01, vAlong);
          gl_FragColor = vec4(vColor.rgb * vColor.a * core * vis * end, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(t: number, show: Show | null, lights: Lights) {
    let n = 0;
    const cue = show && this.enabled ? activeCue(show.data.laserCues, t) : null;
    if (cue && show) {
      const beat = show.beatPos(t);
      const prog = Math.min(1, Math.max(0, (t - cue.start) / Math.max(0.1, cue.end - cue.start)));
      const fadeIn = Math.min(1, (t - cue.start) / 0.4);
      const fadeOut = Math.min(1, (cue.end - t) / 0.4);
      const base = cue.intensity * Math.min(fadeIn, fadeOut) * (0.6 + 0.6 * lights.master);
      const pal = lights.palette;
      const add = (e: number, angleFromVertical: number, ci: number, intensity: number) => {
        if (n >= MAX_BEAMS || intensity <= 0.001) return;
        const [ox, oy, oz] = EMITTERS[e];
        this.origin.setXYZ(n, ox, oy, oz);
        const s = Math.sin(angleFromVertical);
        const c = Math.cos(angleFromVertical);
        this.dir.setXYZ(n, s, c, 0.06);
        const col = pal[ci % 4];
        this.color.setXYZW(n, col.r, col.g, col.b, intensity * 0.7);
        n++;
      };
      const frac = beat - Math.floor(beat);
      switch (cue.mode) {
        case 'fanRise': {
          const N = 5 + Math.round(prog * 11);
          const spread = (170 - 110 * prog) * DEG;
          for (let i = 0; i < N; i++) add(0, (i / (N - 1) - 0.5) * spread, 3, base * (0.35 + 0.65 * prog));
          break;
        }
        case 'sweep': {
          const sw = 0.5 + 0.5 * Math.sin((Math.PI * 2 * beat) / 8);
          for (let i = 0; i < 6; i++) {
            const off = (i / 5 - 0.5) * 24 * DEG;
            add(1, (15 + 40 * sw) * DEG + off, i % 2 ? 0 : 2, base);
            add(2, -(15 + 40 * sw) * DEG - off, i % 2 ? 2 : 0, base);
          }
          break;
        }
        case 'tunnel': {
          const pulse = 0.6 + 0.4 * Math.exp(-4 * frac);
          const rot = 8 * DEG * Math.sin((Math.PI * 2 * beat) / 16);
          for (let i = 0; i < 14; i++) add(0, -80 * DEG + (i * 160 * DEG) / 13 + rot, i % 2 ? 0 : 1, base * pulse);
          break;
        }
        case 'strobe': {
          const k = Math.exp(-6 * frac);
          for (let e = 0; e < 3; e++)
            for (let i = 0; i < 8; i++) {
              const center = e === 0 ? 0 : e === 1 ? 30 * DEG : -30 * DEG;
              add(e, center + (i / 7 - 0.5) * 70 * DEG, (i + e) % 3, base * k);
            }
          break;
        }
        case 'burst': {
          const k = 1 - 0.4 * prog;
          for (let e = 0; e < 3; e++)
            for (let i = 0; i < 14; i++) {
              const center = e === 0 ? 0 : e === 1 ? 35 * DEG : -35 * DEG;
              add(e, center + (i / 13 - 0.5) * (e === 0 ? 150 : 90) * DEG, e === 0 ? 3 : i % 3, base * k);
            }
          break;
        }
        default:
          break;
      }
    }
    this.geo.instanceCount = n;
    this.origin.needsUpdate = true;
    this.dir.needsUpdate = true;
    this.color.needsUpdate = true;
    this.mesh.visible = n > 0;
  }
}

function activeCue(cues: LaserCue[], t: number): LaserCue | null {
  for (const c of cues) if (t >= c.start && t < c.end) return c;
  return null;
}
