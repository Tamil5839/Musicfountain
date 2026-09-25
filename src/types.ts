// Shared data types between analysis, choreography, playback and rendering.

export type SectionLabel = 'intro' | 'verse' | 'build' | 'chorus' | 'drop' | 'breakdown' | 'outro';

export interface Onset {
  /** time in seconds */
  t: number;
  /** strength 0..1 (normalized per band) */
  s: number;
}

export interface Section {
  start: number;
  end: number;
  label: SectionLabel;
  /** mean normalized energy of the section relative to the song, 0..1 */
  energy: number;
  /** absolute "how intense does this feel" 0..1 (loudness + percussion + brightness) */
  intensity: number;
  /** linear energy slope across the section (energy units per second) */
  slope: number;
  /** index of an earlier section this one repeats (cosine similarity), or -1 */
  repeatOf: number;
}

export interface BuildUp {
  /** time the build starts (bar aligned) */
  start: number;
  /** time of the drop (downbeat after the build) */
  drop: number;
  /** 0..1 */
  strength: number;
}

export interface TimeSpan {
  start: number;
  end: number;
}

export interface Analysis {
  version: number;
  hash: string;
  duration: number;
  /** Tempo in beats per minute. */
  bpm: number;
  /** 0..1 — how much the beat grid can be trusted. Low for rubato / ambient music. */
  beatConfidence: number;
  beatsPerBar: number;
  beats: number[];
  downbeats: number[];
  onsets: { kick: Onset[]; snare: Onset[]; hat: Onset[] };
  /** Sample rate of the per-frame curves below (Hz). */
  curveRate: number;
  /** Smoothed RMS energy, normalized 0..1 over the song. */
  energy: Float32Array;
  /** Slow (≈2 s) energy envelope, 0..1. */
  energySlow: Float32Array;
  /** Spectral centroid, normalized 0..1 over the song. */
  brightness: Float32Array;
  /** Melody contour 0..1 (low..high), -1 where no clear pitch. */
  pitch: Float32Array;
  /** Percussive activity (onset density) 0..1. */
  percussion: Float32Array;
  /** Structural novelty sampled on the curve grid, 0..1. */
  novelty: Float32Array;
  sections: Section[];
  buildups: BuildUp[];
  silences: TimeSpan[];
  fadeOut: TimeSpan | null;
  /** Time of the first/last audible sample. */
  firstSound: number;
  lastSound: number;
  /** Peak loudness in dBFS (RMS of the loudest passage). */
  peakDb: number;
}

export type Family = 'shooter' | 'oarsman' | 'ring' | 'fan';

export type Tier = 'calm' | 'medium' | 'intense';

export type OarsPattern =
  | 'wave'
  | 'mirror'
  | 'split'
  | 'chase'
  | 'sing'
  | 'fanOut'
  | 'crossfire'
  | 'pulse'
  | 'sweep'
  | 'ripple'
  | 'alternate'
  | 'whip'
  | 'breathe'
  | 'rise'
  | 'off';

export type FanPattern = 'curtainWave' | 'curtainFull' | 'curtainSplit' | 'curtainV' | 'curtainBreath' | 'curtainRise' | 'off';

export type RingPattern = 'spiral' | 'ringPulse' | 'crown' | 'bloom' | 'off';

export type ShooterPattern =
  | 'center'
  | 'outsideIn'
  | 'insideOut'
  | 'chaseLR'
  | 'chaseRL'
  | 'pairs'
  | 'all'
  | 'alternate';

export type ColorMode = 'solid' | 'alternate' | 'gradient' | 'chase' | 'split';

export type CameraPreset = 'wide' | 'low' | 'dolly' | 'crane' | 'orbit' | 'close' | 'high';

export type MistMode = 'glow' | 'rings' | 'lines' | 'bars' | 'spots' | 'dim';

export type LaserMode = 'off' | 'fanRise' | 'sweep' | 'tunnel' | 'strobe' | 'burst';

export type CueKind =
  | 'shooter'
  | 'ring'
  | 'snap'
  | 'hat'
  | 'drop'
  | 'build'
  | 'camera'
  | 'accent'
  | 'finale';

export interface SectionPlan {
  index: number;
  start: number;
  end: number;
  label: SectionLabel;
  tier: Tier;
  /** How fast continuous patterns cycle: 1 = one cycle per bar-ish; smaller = slower. */
  pace: number;
  /** Family height factors (0..1 of the family maximum). */
  level: number;
  oars: OarsPattern;
  fan: FanPattern;
  ring: RingPattern;
  shooters: ShooterPattern | null;
  /** fire shooters every N bars */
  shooterEvery: number;
  palette: number;
  colorMode: ColorMode;
  mist: MistMode;
  laser: LaserMode;
  snareTarget: 'ring' | 'snap';
  hats: boolean;
  /** pivot spring natural frequency (rad/s) and max angular speed (rad/s) */
  springOmega: number;
  maxAngularSpeed: number;
  /** 0..1 angle amplitude for oarsmen patterns */
  swing: number;
  seed: number;
}

/** A single valve burst on one jet, timed so the water PEAKS at `peak`. */
export interface JetEvent {
  jet: number;
  peak: number;
  /** apex height in meters, before the global intensity multiplier */
  height: number;
  /** how long the valve stays open (s) */
  hold: number;
  /** optional nozzle tilt override (radians) */
  angle?: number;
  /** if true, `height` is added on top of the jet's running pattern (a pressure pulse) */
  boost?: boolean;
  kind: CueKind;
}

export interface SnapEvent {
  t: number;
  /** 'all' = all lean same direction, 'alt' = odd/even opposite, 'wave' = spread across line */
  mode: 'all' | 'alt' | 'wave' | 'center';
  sign: number;
  amount: number;
}

export interface Shot {
  start: number;
  preset: CameraPreset;
  seed: number;
  /** seconds used to blend from the previous shot */
  blend: number;
}

export type ProjectionKind = 'ring' | 'line' | 'bars' | 'spot' | 'flash' | 'rise';

export interface MistCue {
  t: number;
  dur: number;
  kind: ProjectionKind;
  /** palette slot 0=primary 1=secondary 2=accent 3=white */
  color: number;
  x: number;
  y: number;
  size: number;
  speed: number;
  strength: number;
}

export interface LaserCue {
  start: number;
  end: number;
  mode: LaserMode;
  intensity: number;
}

export interface Marker {
  t: number;
  kind: CueKind;
}
