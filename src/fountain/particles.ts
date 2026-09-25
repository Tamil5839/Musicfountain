// GPU water: every droplet lives in two float textures (position+age, velocity+state) and is
// advanced by GPUComputationRenderer with the exact linear-drag ballistic solution, so any
// step size gives the same trajectory. Droplets that hit the pool may bounce as a short-lived
// splash. Rendering draws each droplet as a velocity-aligned streak (motion-blur look).

import * as THREE from 'three';
import { GPUComputationRenderer, type Variable } from 'three/addons/misc/GPUComputationRenderer.js';
import { JET_COUNT } from './layout';
import { K_DRAG } from './physics';
import { JET_TEX_H, JET_TEX_W } from './nozzles';

export const QUALITY_PRESETS = {
  Low: [256, 256],
  Medium: [512, 256],
  High: [512, 512],
  Ultra: [768, 512],
} as const;
export type Quality = keyof typeof QUALITY_PRESETS;

const SIM_COMMON = /* glsl */ `
uniform sampler2D tInfo;
uniform sampler2D tJets;
uniform float uDt;
uniform float uStep;
uniform vec3 uWind;
uniform float uKBase;

vec4 jetRow(float jet, float row) {
  return texture2D(tJets, vec2((jet + 0.5) / ${JET_TEX_W.toFixed(1)}, (row + 0.5) / ${JET_TEX_H.toFixed(1)}));
}

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rnd(float a, float b, float c) {
  uint h = pcg(uint(a) ^ pcg(uint(b) + pcg(uint(c) + 17u)));
  return float(h) * (1.0 / 4294967296.0);
}

// per-droplet drag: most droplets near the median, ~12% light spray that drifts and hangs
float dragOf(float r) {
  float k = uKBase * exp((fract(r * 13.7) - 0.5) * 0.8);
  return fract(r * 7.13) > 0.88 ? uKBase * (3.0 + 3.0 * fract(r * 3.1)) : k;
}

void integrate(inout vec3 p, inout vec3 v, float k, float dt) {
  vec3 vt = uWind + vec3(0.0, -9.81 / k, 0.0);
  float e = exp(-k * dt);
  p += vt * dt + (v - vt) * ((1.0 - e) / k);
  v = vt + (v - vt) * e;
}

void simulate(inout vec4 P, inout vec4 V, vec4 info) {
  float jet = info.x;
  float local = info.y;
  float pool = info.z;
  float r = info.w;
  vec4 em = jetRow(jet, 3.0);
  float count = em.y;
  float rel = mod(local - em.x + pool, pool);
  float k = dragOf(r);
  if (count > 0.5 && rel < count) {
    // (re)launch: position within this step so the stream is continuous
    float f = (rel + 0.5) / count;
    vec4 A = jetRow(jet, 1.0);
    vec4 B = jetRow(jet, 2.0);
    vec4 N = jetRow(jet, 0.0);
    vec3 dir = normalize(mix(A.xyz, B.xyz, f) + vec3(0.0, 1e-4, 0.0));
    float speed = mix(A.w, B.w, f);
    vec3 t1 = normalize(cross(dir, abs(dir.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
    vec3 t2 = cross(dir, t1);
    float h1 = rnd(local, uStep, 1.0);
    float h2 = rnd(local, uStep, 2.0);
    float h3 = rnd(local, uStep, 3.0);
    float h4 = rnd(local, uStep, 4.0);
    float ang = 6.2831853 * h1;
    float spread = em.z * sqrt(h2) * (k > uKBase * 2.5 ? 2.2 : 1.0);
    vec3 d = normalize(dir + (t1 * cos(ang) + t2 * sin(ang)) * spread);
    speed *= 1.0 + (h3 - 0.5) * 0.05;
    float ang2 = 6.2831853 * h4;
    vec3 pos = N.xyz + vec3(cos(ang2), 0.0, sin(ang2)) * em.w * sqrt(h3) + vec3(0.0, 0.05, 0.0);
    vec3 vel = d * speed;
    float tau = (1.0 - f) * uDt;
    integrate(pos, vel, k, tau);
    P = vec4(pos, tau);
    V = vec4(vel, 1.0);
    return;
  }
  if (V.w < 0.5) return;
  vec3 pos = P.xyz;
  vec3 vel = V.xyz;
  float age = P.w + uDt;
  float state = V.w;
  integrate(pos, vel, state > 1.5 ? uKBase * 3.0 : k, uDt);
  if (pos.y < 0.0) {
    if (state < 1.5) {
      float impact = length(vel);
      if (rnd(local, uStep, 11.0) < 0.5 && impact > 1.5) {
        float a2 = 6.2831853 * rnd(local, uStep, 12.0);
        float up = (0.2 + 0.8 * rnd(local, uStep, 13.0)) * min(impact * 0.2, 5.0);
        float side = rnd(local, uStep, 14.0) * min(impact * 0.1, 2.5);
        vel = vec3(cos(a2) * side + vel.x * 0.12, up, sin(a2) * side + vel.z * 0.12);
        pos.y = 0.02;
        age = 0.0;
        state = 2.0;
      } else {
        state = 0.0;
      }
    } else {
      state = 0.0;
    }
  }
  if (state > 1.5 && age > 1.4) state = 0.0;
  if (age > 16.0) state = 0.0;
  P = vec4(pos, age);
  V = vec4(vel, state);
}
`;

const POS_SHADER = /* glsl */ `
${SIM_COMMON}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 P = texture2D(texturePosition, uv);
  vec4 V = texture2D(textureVelocity, uv);
  simulate(P, V, texture2D(tInfo, uv));
  gl_FragColor = P;
}`;

const VEL_SHADER = /* glsl */ `
${SIM_COMMON}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 P = texture2D(texturePosition, uv);
  vec4 V = texture2D(textureVelocity, uv);
  simulate(P, V, texture2D(tInfo, uv));
  gl_FragColor = V;
}`;

const RENDER_VS = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tInfo;
uniform sampler2D tJets;
uniform vec2 uRes;
uniform float uStreak;
uniform float uSize;
uniform float uBright;
uniform float uAmbient;
attribute vec2 ref;
varying vec3 vColor;
varying vec2 vUv;
varying float vWhite;

vec4 jetRow(float jet, float row) {
  return texture2D(tJets, vec2((jet + 0.5) / ${JET_TEX_W.toFixed(1)}, (row + 0.5) / ${JET_TEX_H.toFixed(1)}));
}

void main() {
  vec4 P = texture2D(tPos, ref);
  vec4 V = texture2D(tVel, ref);
  float state = V.w;
  vUv = position.xy;
  vColor = vec3(0.0);
  vWhite = 0.0;
  if (state < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 info = texture2D(tInfo, ref);
  bool splash = state > 1.5;
  float spray = fract(info.w * 7.13) > 0.88 ? 1.0 : 0.0;
  vec3 pos = P.xyz;
  vec3 vel = V.xyz;
  float sp = length(vel);
  vec3 tail = pos - vel * (uStreak * (splash ? 0.5 : 1.0)) * min(1.0, 2.5 / max(sp * uStreak, 1e-3));
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 c0 = vp * vec4(pos, 1.0);
  vec4 c1 = vp * vec4(tail, 1.0);
  if (c0.w < 0.5 || c1.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float aspect = uRes.x / uRes.y;
  vec2 s0 = c0.xy / c0.w;
  vec2 s1 = c1.xy / c1.w;
  vec2 d = (s0 - s1) * vec2(aspect, 1.0);
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 J = jetRow(info.x, 5.0);
  bool shooter = J.z < 0.5;
  float worldR = (spray > 0.5 ? 0.28 : 0.05) * uSize * (splash ? 1.3 : 1.0) * (shooter ? 1.5 : 1.0);
  float pxR = worldR * projectionMatrix[1][1] * uRes.y * 0.5 / c0.w;
  float fade = clamp(pxR / 0.75, 0.0, 1.0);
  pxR = max(pxR, 0.75);
  float lenPx = len * uRes.y * 0.5;
  // motion blur spreads the droplet's light over its streak
  float energy = pow(clamp((2.0 * pxR + 1.5) / (lenPx + 2.0 * pxR + 1.5), 0.08, 1.0), 0.45);
  vec2 k = vec2(1.0 / aspect, 1.0) * (2.0 / uRes.y);
  vec2 side = nrm * pxR * position.y;
  vec2 cap = dir * pxR * (position.x < 0.5 ? 1.0 : -1.0);
  vec4 c = position.x < 0.5 ? c0 : c1;
  gl_Position = vec4(c.xy + (side + cap) * k * c.w, c.z, c.w);

  // lit from below by the jet's underwater light, strongest near the water
  vec4 L = jetRow(info.x, 4.0);
  float lift = exp(-pos.y / (shooter ? 48.0 : 26.0));
  float lit = L.w * (0.35 + 0.65 * lift);
  float a = uBright * fade * energy * (spray > 0.5 ? 0.1 : 1.0) * (splash ? 0.55 : 1.0);
  if (splash) a *= clamp(1.0 - P.w / 1.4, 0.0, 1.0);
  vColor = (L.rgb * lit * 1.7 + vec3(uAmbient)) * a;
  vWhite = clamp(lit * 0.5, 0.0, 0.9);
}`;

const RENDER_FS = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
varying float vWhite;
void main() {
  float across = vUv.y;
  float core = exp(-across * across * 3.2);
  float along = mix(1.0, 0.4, vUv.x);
  float peak = max(max(vColor.r, vColor.g), vColor.b);
  vec3 col = mix(vColor, vec3(peak), vWhite * core * core);
  gl_FragColor = vec4(col * core * along, 1.0);
}`;

export class ParticleSystem {
  readonly count: number;
  readonly width: number;
  readonly height: number;
  readonly mesh: THREE.Mesh;
  private readonly gpu: GPUComputationRenderer;
  private readonly posVar: Variable;
  private readonly velVar: Variable;
  private readonly initTex: THREE.DataTexture;
  private readonly infoTex: THREE.DataTexture;
  readonly jetTex: THREE.DataTexture;
  private readonly material: THREE.ShaderMaterial;
  private stepCounter = 0;
  readonly poolSizes: Int32Array;
  /** global brightness trim (debug / tuning) */
  gain = 1;

  constructor(
    renderer: THREE.WebGLRenderer,
    quality: Quality,
    poolSizes: Int32Array,
    jetData: Float32Array,
  ) {
    const [w, h] = QUALITY_PRESETS[quality];
    this.width = w;
    this.height = h;
    this.count = w * h;
    this.poolSizes = poolSizes;

    this.jetTex = new THREE.DataTexture(jetData, JET_TEX_W, JET_TEX_H, THREE.RGBAFormat, THREE.FloatType);
    this.jetTex.minFilter = THREE.NearestFilter;
    this.jetTex.magFilter = THREE.NearestFilter;
    this.jetTex.needsUpdate = true;

    // static per-particle info: jet id, index inside the jet's pool, pool size, random
    const info = new Float32Array(this.count * 4);
    let p = 0;
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let j = 0; j < JET_COUNT; j++) {
      for (let k = 0; k < poolSizes[j]; k++) {
        info[p * 4] = j;
        info[p * 4 + 1] = k;
        info[p * 4 + 2] = poolSizes[j];
        info[p * 4 + 3] = rand();
        p++;
      }
    }
    for (; p < this.count; p++) {
      info[p * 4] = 0;
      info[p * 4 + 1] = 1e9; // never emitted
      info[p * 4 + 2] = 1;
      info[p * 4 + 3] = rand();
    }
    this.infoTex = new THREE.DataTexture(info, w, h, THREE.RGBAFormat, THREE.FloatType);
    this.infoTex.needsUpdate = true;

    this.gpu = new GPUComputationRenderer(w, h, renderer);
    this.initTex = this.gpu.createTexture();
    this.posVar = this.gpu.addVariable('texturePosition', POS_SHADER, this.initTex);
    this.velVar = this.gpu.addVariable('textureVelocity', VEL_SHADER, this.initTex);
    this.gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);
    this.gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);
    for (const v of [this.posVar, this.velVar]) {
      Object.assign(v.material.uniforms, {
        tInfo: { value: this.infoTex },
        tJets: { value: this.jetTex },
        uDt: { value: 1 / 120 },
        uStep: { value: 0 },
        uWind: { value: new THREE.Vector3(1.2, 0, 0.3) },
        uKBase: { value: K_DRAG },
      });
    }
    const err = this.gpu.init();
    if (err) throw new Error(err);

    // instanced streak quads
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 2, 1, 2, 3, 1]);
    const refs = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i++) {
      refs[i * 2] = ((i % w) + 0.5) / w;
      refs[i * 2 + 1] = (Math.floor(i / w) + 0.5) / h;
    }
    geo.setAttribute('ref', new THREE.InstancedBufferAttribute(refs, 2));
    geo.instanceCount = this.count;
    this.material = new THREE.ShaderMaterial({
      vertexShader: RENDER_VS,
      fragmentShader: RENDER_FS,
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        tInfo: { value: this.infoTex },
        tJets: { value: this.jetTex },
        uRes: { value: new THREE.Vector2(1920, 1080) },
        uStreak: { value: 0.035 },
        uSize: { value: 1 },
        uBright: { value: 0.045 * Math.pow(262144 / this.count, 0.75) },
        uAmbient: { value: 0.02 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // streak quads flip winding with their screen direction: never cull them
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.bindTextures();
  }

  setWind(x: number, z: number) {
    for (const v of [this.posVar, this.velVar]) v.material.uniforms.uWind.value.set(x, 0, z);
  }

  setResolution(w: number, h: number) {
    this.material.uniforms.uRes.value.set(w, h);
  }

  setBrightness(scale: number) {
    this.material.uniforms.uBright.value = 0.045 * Math.pow(262144 / this.count, 0.75) * scale * this.gain;
  }

  /** Upload this step's jet data and advance every droplet by dt. */
  step(dt: number) {
    this.jetTex.needsUpdate = true;
    this.stepCounter++;
    for (const v of [this.posVar, this.velVar]) {
      v.material.uniforms.uDt.value = dt;
      v.material.uniforms.uStep.value = this.stepCounter % 16000000;
    }
    this.gpu.compute();
    this.bindTextures();
  }

  /** Kill every droplet (used when seeking; the caller then pre-rolls the simulation). */
  reset() {
    for (const v of [this.posVar, this.velVar]) {
      this.gpu.renderTexture(this.initTex, v.renderTargets[0]);
      this.gpu.renderTexture(this.initTex, v.renderTargets[1]);
    }
    this.stepCounter = 0;
    this.bindTextures();
  }

  private bindTextures() {
    this.material.uniforms.tPos.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    this.material.uniforms.tVel.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
  }

  dispose() {
    this.gpu.dispose();
    this.infoTex.dispose();
    this.jetTex.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
