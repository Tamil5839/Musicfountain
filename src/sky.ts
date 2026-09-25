// Night backdrop: sky gradient with city light-pollution glow and faint stars, a procedural
// skyline of dark towers with scattered lit windows, and blinking aviation lights.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const HORIZON = new THREE.Color(0.012, 0.016, 0.034);
export const FOG_DENSITY = 0.00085;

export class Sky {
  readonly group = new THREE.Group();
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly cityMat: THREE.ShaderMaterial;
  private readonly beaconMat: THREE.ShaderMaterial;

  constructor() {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color(0.0006, 0.0009, 0.0025) },
        uHorizon: { value: HORIZON.clone() },
        uGlow: { value: new THREE.Color(0.05, 0.03, 0.03) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGlow;
        uniform float uTime;
        varying vec3 vDir;
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
          // light pollution from the city behind the lake
          float behind = smoothstep(0.2, -0.9, d.z);
          col += uGlow * exp(-max(h, 0.0) * 14.0) * (0.35 + 0.65 * behind);
          // stars
          vec3 sd = d * 380.0;
          vec3 cell = floor(sd);
          float r = hash(cell);
          if (r > 0.9965 && h > 0.06) {
            vec3 f = fract(sd) - 0.5;
            float tw = 0.7 + 0.3 * sin(uTime * (1.0 + r * 3.0) + r * 91.0);
            col += vec3(0.9, 0.95, 1.0) * exp(-dot(f, f) * 70.0) * (r - 0.9965) * 250.0 * smoothstep(0.06, 0.35, h) * tw * 0.012;
          }
          if (h < 0.0) col = uHorizon * 0.7;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), this.skyMat);
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    this.group.add(dome);

    this.cityMat = new THREE.ShaderMaterial({
      uniforms: {
        uFogColor: { value: HORIZON.clone() },
        uFogDensity: { value: FOG_DENSITY },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float seed;
        varying vec3 vPos;
        varying vec3 vN;
        varying float vSeed;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vPos = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          vSeed = seed;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uTime;
        varying vec3 vPos;
        varying vec3 vN;
        varying float vSeed;
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        void main() {
          vec3 col = vec3(0.0022, 0.0026, 0.0045);
          if (vN.y < 0.5) {
            bool side = abs(vN.x) > 0.5;
            vec2 fc = side ? vPos.zy : vPos.xy;
            vec2 g = fc / vec2(3.3, 3.7);
            vec2 cell = floor(g);
            vec2 f = fract(g);
            float h = hash(vec3(cell, vSeed * 13.0 + (side ? 7.0 : 0.0)));
            float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.28, f.y) * step(f.y, 0.78);
            float lit = step(0.66, h);
            vec3 warm = mix(vec3(1.0, 0.62, 0.3), vec3(0.62, 0.78, 1.0), step(0.8, fract(h * 13.3)));
            float b = 0.5 + 0.5 * fract(h * 71.0);
            vec3 pattern = warm * win * lit * b;
            // far away the window grid is sub-pixel: fade to its average
            float px = max(fwidth(g.x), fwidth(g.y));
            float detail = clamp(1.6 - px * 2.2, 0.0, 1.0);
            vec3 avg = mix(vec3(1.0, 0.62, 0.3), vec3(0.62, 0.78, 1.0), 0.2) * 0.34 * 0.28 * 0.75;
            col += mix(avg, pattern, detail) * 0.05;
            // faint vertical gradient: buildings catch some city glow at the base
            col += vec3(0.004, 0.003, 0.004) * exp(-vPos.y / 60.0);
          }
          float dist = length(cameraPosition - vPos);
          col = mix(uFogColor, col, exp(-dist * uFogDensity));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const { geometry, beacons } = buildSkyline();
    const city = new THREE.Mesh(geometry, this.cityMat);
    city.frustumCulled = false;
    this.group.add(city);

    this.beaconMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uPx;
        attribute float phase;
        varying float vOn;
        void main() {
          vOn = step(0.55, fract(uTime * 0.5 + phase));
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = 3.5 * uPx;
        }`,
      fragmentShader: /* glsl */ `
        varying float vOn;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = exp(-dot(c, c) * 18.0);
          gl_FragColor = vec4(vec3(1.0, 0.05, 0.02) * a * vOn * 0.9, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.Float32BufferAttribute(beacons.flatMap((b) => [b[0], b[1], b[2]]), 3));
    bGeo.setAttribute('phase', new THREE.Float32BufferAttribute(beacons.map((b) => b[3]), 1));
    const pts = new THREE.Points(bGeo, this.beaconMat);
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  update(t: number, pixelScale: number) {
    this.skyMat.uniforms.uTime.value = t;
    this.cityMat.uniforms.uTime.value = t;
    this.beaconMat.uniforms.uTime.value = t;
    this.beaconMat.uniforms.uPx.value = pixelScale;
  }
}

function buildSkyline(): { geometry: THREE.BufferGeometry; beacons: [number, number, number, number][] } {
  let s = 4242;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const geos: THREE.BufferGeometry[] = [];
  const beacons: [number, number, number, number][] = [];
  const addBox = (x: number, z: number, w: number, d: number, h: number, y0 = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y0 + h / 2, z);
    const seed = new Float32Array(g.attributes.position.count).fill(r() * 100);
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    geos.push(g);
  };
  // a ring of buildings around the lake, tallest behind the fountain
  for (let i = 0; i < 420; i++) {
    const ang = (r() - 0.5) * Math.PI * 2; // 0 = straight behind the fountain (-z)
    const behind = Math.cos(ang);
    const dist = 480 + r() * 520 + (behind < 0 ? 150 : 0);
    const x = Math.sin(ang) * dist;
    const z = -Math.cos(ang) * dist - 60;
    const tallness = behind > 0.3 ? 1 : behind > -0.2 ? 0.6 : 0.3;
    const h = (18 + Math.pow(r(), 2.2) * 150) * tallness + 8;
    const w = 14 + r() * 26;
    const d = 14 + r() * 26;
    addBox(x, z, w, d, h);
    if (h > 90) beacons.push([x, h + 1, z, r()]);
  }
  // a supertall with setbacks behind the fountain
  const tx = 60;
  const tz = -640;
  const tiers = [
    [46, 140],
    [36, 120],
    [28, 110],
    [20, 90],
    [12, 60],
    [5, 70],
  ];
  let y = 0;
  for (const [w, h] of tiers) {
    addBox(tx, tz, w, w, h, y);
    y += h;
  }
  beacons.push([tx, y + 2, tz, 0.1]);
  for (let k = 0; k < 4; k++) beacons.push([tx + (k % 2 ? 22 : -22), 140 + k * 60, tz + 22, 0.1 + k * 0.2]);
  return { geometry: mergeGeometries(geos), beacons };
}
