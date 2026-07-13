import * as THREE from 'three';
import { hashId } from '@shared/layout';

/**
 * Colorblind-safe glow gradient: cold blue -> warm orange (no red/green axis).
 */
export const GLOW_COLD = new THREE.Color('#2f6bd8');
export const GLOW_HOT = new THREE.Color('#ff9d2e');

export function glowColor(glow: number, target = new THREE.Color()): THREE.Color {
  return target.copy(GLOW_COLD).lerp(GLOW_HOT, THREE.MathUtils.clamp(glow, 0, 1));
}

/** Deterministic zone/team hue from the team id hash. */
export function teamColor(teamId: string, target = new THREE.Color()): THREE.Color {
  const h = hashId(teamId);
  const hue = (h % 360) / 360;
  const sat = 0.35 + ((h >>> 9) % 100) / 400; // 0.35..0.6
  return target.setHSL(hue, sat, 0.32);
}
