// Dark reflective lake: planar reflection (three's Reflector with a custom shader), two scrolling
// normal maps for the idle surface, and expanding ring ripples where water lands.

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { JETS, JET_COUNT } from './fountain/layout';
import type { NozzleBank } from './fountain/nozzles';

const MAX_RIPPLES = 48;

const WATER_SHADER = {
  name: 'FountainWater',
  uniforms: {
    color: { value: null as THREE.Color | null },
    tDiffuse: { value: null as THREE.Texture | null },
    textureMatrix: { value: null as THREE.Matrix4 | null },
    tNormal: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0)) },
    uCam: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0.0012 },
    uDeep: { value: new THREE.Color(0.0015, 0.0025, 0.005) },
    uReflect: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUvR;
    varying vec3 vWorld;
    void main() {
      vUvR = textureMatrix * vec4(position, 1.0);
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform float uTime;
    uniform vec4 uRipples[${MAX_RIPPLES}];
    uniform vec3 uCam;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    uniform vec3 uDeep;
    uniform float uReflect;
    varying vec4 vUvR;
    varying vec3 vWorld;
    void main() {
      vec2 p = vWorld.xz;
      vec3 n1 = texture2D(tNormal, p * 0.031 + vec2(uTime * 0.006, uTime * 0.004)).xyz * 2.0 - 1.0;
      vec3 n2 = texture2D(tNormal, p * 0.083 + vec2(-uTime * 0.009, uTime * 0.007)).xyz * 2.0 - 1.0;
      vec3 n3 = texture2D(tNormal, p * 0.27 + vec2(uTime * 0.02, -uTime * 0.013)).xyz * 2.0 - 1.0;
      float dist = length(uCam - vWorld);
      // far water calms down (and avoids shimmering)
      float calm = 1.0 / (1.0 + dist * 0.004);
      vec2 slope = (n1.xy * 0.5 + n2.xy * 0.35 + n3.xy * 0.2 * calm) * 0.11;
      for (int i = 0; i < ${MAX_RIPPLES}; i++) {
        vec4 r = uRipples[i];
        float age = uTime - r.z;
        if (r.w <= 0.0 || age < 0.0 || age > 3.5) continue;
        vec2 d = p - r.xy;
        float dd = length(d) + 1e-3;
        float front = 0.4 + age * 3.4;
        float x = dd - front;
        float env = exp(-x * x / (0.5 + age * 0.9)) * r.w * exp(-age * 1.2) / (1.0 + 0.35 * front);
        slope += (d / dd) * sin(x * 3.2) * env;
      }
      vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
      vec3 V = normalize(uCam - vWorld);
      float cosT = max(dot(N, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
      float refl = mix(0.45, 1.0, fres) * uReflect;
      vec4 uv = vUvR;
      uv.xy += slope * 0.9 * uv.w * calm;
      vec3 R = texture2DProj(tDiffuse, uv).rgb;
      vec3 col = uDeep + R * refl;
      col = mix(uFogColor, col, exp(-dist * uFogDensity));
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Pool {
  readonly mesh: Reflector;
  private readonly uniforms: typeof WATER_SHADER.uniforms;
  private next = 0;
  private lastT = 0;
  private seed = 9;

  constructor(reflectionSize: [number, number]) {
    const geo = new THREE.PlaneGeometry(2400, 2400);
    this.mesh = new Reflector(geo, {
      textureWidth: reflectionSize[0],
      textureHeight: reflectionSize[1],
      clipBias: 0.002,
      shader: WATER_SHADER,
      multisample: 4,
    });
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(0, 0, 0);
    this.uniforms = (this.mesh.material as THREE.ShaderMaterial).uniforms as unknown as typeof WATER_SHADER.uniforms;
    this.uniforms.tNormal.value = makeNormalMap();
  }

  setReflectionSize(w: number, h: number) {
    this.mesh.getRenderTarget().setSize(Math.max(64, Math.round(w)), Math.max(64, Math.round(h)));
  }

  setFog(color: THREE.Color, density: number) {
    this.uniforms.uFogColor.value.copy(color);
    this.uniforms.uFogDensity.value = density;
  }

  private rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** Spawn ripples where active jets land. Deterministic for a given sequence of calls. */
  update(t: number, camera: THREE.Camera, bank: NozzleBank) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    let dt = t - this.lastT;
    this.lastT = t;
    if (dt < 0 || dt > 0.5) {
      // seek: clear ripples
      for (const r of this.uniforms.uRipples.value) r.set(0, 0, -100, 0);
      dt = 0;
    }
    // ~14 new ripples per second across the active jets, weighted by flow and height
    let total = 0;
    for (let j = 0; j < JET_COUNT; j++) total += bank.valve[j] * Math.min(1, bank.vy[j] / 15);
    if (total < 0.05) return;
    const spawn = dt * 14 * Math.min(1, total / 6);
    let n = Math.floor(spawn + this.rand());
    while (n-- > 0) {
      let pick = this.rand() * total;
      let j = 0;
      for (; j < JET_COUNT - 1; j++) {
        pick -= bank.valve[j] * Math.min(1, bank.vy[j] / 15);
        if (pick <= 0) break;
      }
      const jet = JETS[j];
      const vy = bank.vy[j];
      const reach = Math.sin(bank.angle[j]) * vy * 1.1;
      const x = jet.pos[0] + jet.sway[0] * reach + (this.rand() - 0.5) * 3;
      const z = jet.pos[2] + jet.sway[2] * reach + (this.rand() - 0.5) * 3;
      const strength = 0.4 + 0.6 * Math.min(1, vy / 30);
      this.uniforms.uRipples.value[this.next].set(x, z, t - this.rand() * 0.1, strength);
      this.next = (this.next + 1) % MAX_RIPPLES;
    }
  }
}

/** Tileable water normal map from a sum of integer-frequency waves. */
function makeNormalMap(): THREE.DataTexture {
  const N = 256;
  const h = new Float32Array(N * N);
  let s = 77;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const waves: [number, number, number, number][] = [];
  for (let i = 0; i < 40; i++) {
    const fx = Math.round((r() - 0.5) * 24);
    const fy = Math.round((r() - 0.5) * 24);
    if (fx === 0 && fy === 0) continue;
    const f = Math.hypot(fx, fy);
    waves.push([fx, fy, r() * Math.PI * 2, 1 / Math.pow(f, 1.1)]);
  }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let v = 0;
      for (const [fx, fy, ph, a] of waves) v += a * Math.sin(((fx * x + fy * y) / N) * Math.PI * 2 + ph);
      h[y * N + x] = v;
    }
  const data = new Uint8Array(N * N * 4);
  const k = 2.2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x - 1 + N) % N)];
      const dy = h[((y + 1) % N) * N + x] - h[((y - 1 + N) % N) * N + x];
      const nx = -dx * k;
      const ny = -dy * k;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = (y * N + x) * 4;
      data[o] = Math.round(((nx / l) * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round(((ny / l) * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(((nz / l) * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
