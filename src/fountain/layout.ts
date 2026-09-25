// Fixed physical layout of the installation: a long curved pool with five nozzle families.
// Units are meters. The audience looks toward -Z; the pool arc bends toward the viewer.

import type { Family } from '../types';

export interface JetDef {
  id: number;
  family: Family;
  /** index inside its family */
  famIndex: number;
  famCount: number;
  /** position along the family line, -1 (left) .. 1 (right) */
  u: number;
  pos: [number, number, number];
  /** unit horizontal direction the nozzle tilts toward for positive angles */
  sway: [number, number, number];
  maxHeight: number;
  /** share of the particle budget */
  weight: number;
  /** nozzle radius (m), for emission spread */
  radius: number;
  /** base spray cone half-angle (rad) */
  spread: number;
}

/** The pool arc: circle centre on the audience side. */
export const ARC_CENTER_Z = 100;
export const ARC_RADIUS = 150;
export const POOL_CENTER: [number, number, number] = [0, 0, ARC_CENTER_Z - ARC_RADIUS];
/** Mist curtain plane (behind the fan line). */
export const MIST_Z = ARC_CENTER_Z - ARC_RADIUS - 22;
export const MIST_WIDTH = 150;

export const FAMILY_MAX: Record<Family, number> = {
  shooter: 60,
  oarsman: 32,
  ring: 14,
  fan: 26,
};

const DEG = Math.PI / 180;

function onArc(r: number, theta: number): { pos: [number, number, number]; tangent: [number, number, number] } {
  return {
    pos: [r * Math.sin(theta), 0, ARC_CENTER_Z - r * Math.cos(theta)],
    tangent: [Math.cos(theta), 0, Math.sin(theta)],
  };
}

export function buildLayout(): JetDef[] {
  const jets: JetDef[] = [];
  const add = (j: Omit<JetDef, 'id'>) => jets.push({ ...j, id: jets.length });

  // Shooters: 7 very tall vertical jets on the middle line
  for (let i = 0; i < 7; i++) {
    const u = i / 6 - 0.5;
    const { pos, tangent } = onArc(ARC_RADIUS, u * 54 * DEG);
    add({ family: 'shooter', famIndex: i, famCount: 7, u: u * 2, pos, sway: tangent, maxHeight: FAMILY_MAX.shooter, weight: 0.068, radius: 0.55, spread: 0.024 });
  }
  // Oarsmen: 24 pivoting jets on the front line
  for (let i = 0; i < 24; i++) {
    const u = i / 23 - 0.5;
    const { pos, tangent } = onArc(ARC_RADIUS - 14, u * 68 * DEG);
    add({ family: 'oarsman', famIndex: i, famCount: 24, u: u * 2, pos, sway: tangent, maxHeight: FAMILY_MAX.oarsman, weight: 0.0118, radius: 0.12, spread: 0.022 });
  }
  // Ring: 16 small jets around the central shooter
  const c = onArc(ARC_RADIUS, 0).pos;
  for (let i = 0; i < 16; i++) {
    const phi = (i / 16) * Math.PI * 2 + Math.PI / 2;
    const dir: [number, number, number] = [Math.cos(phi), 0, Math.sin(phi)];
    add({
      family: 'ring',
      famIndex: i,
      famCount: 16,
      u: Math.cos(phi),
      pos: [c[0] + 9 * dir[0], 0, c[2] + 9 * dir[2]],
      sway: dir,
      maxHeight: FAMILY_MAX.ring,
      weight: 0.0048,
      radius: 0.08,
      spread: 0.03,
    });
  }
  // Fan / curtain: 40 closely spaced jets on the back line
  for (let i = 0; i < 40; i++) {
    const u = i / 39 - 0.5;
    const { pos, tangent } = onArc(ARC_RADIUS + 12, u * 44 * DEG);
    add({ family: 'fan', famIndex: i, famCount: 40, u: u * 2, pos, sway: tangent, maxHeight: FAMILY_MAX.fan, weight: 0.0049, radius: 0.1, spread: 0.028 });
  }
  const total = jets.reduce((s, j) => s + j.weight, 0);
  for (const j of jets) j.weight /= total;
  return jets;
}

export const JETS = buildLayout();
export const JET_COUNT = JETS.length;

export const familyJets = (f: Family) => JETS.filter((j) => j.family === f);
export const SHOOTERS = familyJets('shooter');
export const OARSMEN = familyJets('oarsman');
export const RING = familyJets('ring');
export const FAN = familyJets('fan');
