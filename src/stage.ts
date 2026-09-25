// The engine: owns the renderer, scene, post-processing and the fixed-timestep simulation.
// Live playback and offline export drive the exact same code path.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Director } from './camera';
import { POOL_CENTER } from './fountain/layout';
import { NozzleBank, allocatePools } from './fountain/nozzles';
import { ParticleSystem, QUALITY_PRESETS, type Quality } from './fountain/particles';
import { Lasers } from './lasers';
import { Lights, type ThemeName } from './lights';
import { Mist } from './mist';
import { Pool } from './pool';
import { Show, idleTargets, makeTargets } from './show';
import { FOG_DENSITY, HORIZON, Sky } from './sky';

export const SIM_DT = 1 / 120;
const PREROLL = 6.5;

export interface StageSettings {
  intensity: number;
  quality: Quality;
  theme: ThemeName;
  camera: 'auto' | 'orbit';
  lasers: boolean;
  mist: boolean;
  bloom: number;
}

const REFLECTION_SCALE: Record<Quality, number> = { Low: 0.3, Medium: 0.45, High: 0.5, Ultra: 0.7 };

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  readonly bank: NozzleBank;
  particles: ParticleSystem;
  readonly lights: Lights;
  readonly pool: Pool;
  readonly mist: Mist;
  readonly lasers: Lasers;
  readonly sky: Sky;
  readonly director = new Director();
  readonly controls: OrbitControls;
  show: Show | null = null;
  simTime = 0;
  private readonly targets = makeTargets();
  private readonly size = new THREE.Vector2();
  settings: StageSettings;
  private quality: Quality;

  constructor(canvas: HTMLCanvasElement, settings: StageSettings) {
    this.settings = settings;
    this.quality = settings.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required.');

    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.5, 9000);
    this.camera.position.set(0, 9, 150);

    const pools = allocatePools(QUALITY_PRESETS[settings.quality][0] * QUALITY_PRESETS[settings.quality][1]);
    this.bank = new NozzleBank(pools);
    this.particles = new ParticleSystem(this.renderer, settings.quality, pools, this.bank.tex);
    this.lights = new Lights(settings.theme, this.particles.jetTex);
    this.pool = new Pool([512, 288]);
    this.pool.setFog(HORIZON, FOG_DENSITY);
    this.mist = new Mist();
    this.lasers = new Lasers(this.mist);
    this.sky = new Sky();

    this.scene.add(this.sky.group, this.pool.mesh, this.lights.glowMesh, this.mist.group, this.lasers.mesh, this.particles.mesh);

    const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), settings.bloom, 0.45, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(POOL_CENTER[0], 18, POOL_CENTER[2]);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 600;
    this.controls.enabled = settings.camera === 'orbit';
    this.applySettings();
  }

  applySettings() {
    const s = this.settings;
    this.bloom.strength = s.bloom;
    this.mist.enabled = s.mist;
    this.lasers.enabled = s.lasers;
    this.lights.setTheme(s.theme);
    this.controls.enabled = s.camera === 'orbit';
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.settings.quality = q;
    this.scene.remove(this.particles.mesh);
    this.particles.dispose();
    const pools = allocatePools(QUALITY_PRESETS[q][0] * QUALITY_PRESETS[q][1]);
    this.bank.setPools(pools);
    this.particles = new ParticleSystem(this.renderer, q, pools, this.bank.tex);
    this.lights.setJetTexture(this.particles.jetTex);
    this.scene.add(this.particles.mesh);
    this.resizeInternals();
    this.seek(this.simTime);
  }

  setShow(show: Show | null) {
    this.show = show;
    this.seek(0);
  }

  /** Size in device pixels of the drawing buffer. */
  setSize(width: number, height: number, pixelRatio: number) {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.resizeInternals();
  }

  private resizeInternals() {
    this.renderer.getDrawingBufferSize(this.size);
    this.particles.setResolution(this.size.x, this.size.y);
    const k = REFLECTION_SCALE[this.settings.quality];
    this.pool.setReflectionSize(this.size.x * k, this.size.y * k);
    // keep droplets similarly bright at different output sizes
    this.particles.setBrightness(Math.pow(1080 / Math.max(360, this.size.y), 0.35));
  }

  // --------------------------------------------------------------------------- simulation
  private evaluateTargets(t: number) {
    if (this.show) this.show.evaluate(t, this.settings.intensity, this.targets);
    else idleTargets(t, this.targets);
  }

  private stepOnce(dt: number) {
    const t = this.simTime;
    this.evaluateTargets(t);
    this.bank.step(t, dt, this.targets);
    const gust = 1.0 + 0.5 * Math.sin(t * 0.13) + 0.25 * Math.sin(t * 0.37 + 1.3);
    this.particles.setWind(gust, 0.35 * Math.sin(t * 0.07));
    this.particles.step(dt);
    this.simTime = t + dt;
  }

  /** Jump to time t: clear all water and pre-roll the fountain so it looks right immediately. */
  seek(t: number) {
    this.bank.reset();
    this.particles.reset();
    const start = Math.max(0, t - PREROLL);
    this.simTime = start;
    // the droplet integrator is exact for any step, so pre-roll can use coarse steps
    const coarse = 1 / 40;
    while (this.simTime < t - 1e-6) this.stepOnce(Math.min(coarse, t - this.simTime));
    this.simTime = t;
  }

  /** Advance the simulation to t with fixed steps (seeking if t jumped). */
  advanceTo(t: number, dt = SIM_DT) {
    if (t < this.simTime - 1e-4 || t - this.simTime > 1.0) {
      this.seek(t);
      return;
    }
    while (this.simTime < t - 1e-6) this.stepOnce(Math.min(dt, t - this.simTime + 1e-9));
  }

  // --------------------------------------------------------------------------- rendering
  render(t: number) {
    const show = this.show;
    this.lights.update(t, show, this.bank);
    this.particles.jetTex.needsUpdate = true;
    if (this.settings.camera === 'auto') this.director.apply(this.camera, this.director.evaluate(t, show));
    this.camera.updateMatrixWorld();
    this.pool.update(t, this.camera, this.bank);
    this.mist.update(t, show, this.lights, this.bank);
    this.lasers.update(t, show, this.lights);
    this.renderer.getDrawingBufferSize(this.size);
    this.sky.update(t, this.size.y / 1080);
    this.composer.render();
  }

  dispose() {
    this.particles.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
