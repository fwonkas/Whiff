import type { Vec3 } from "@rl/domain";

/** Standard arena half-extents in Unreal units. */
export const FIELD = { halfWidth: 4096, halfLength: 5120 } as const;
/** The ball rests at about z = 93; above this it is in the air. */
export const AERIAL_Z = 300;

/**
 * Rotate a location so the given team attacks toward +y. Blue (0) already
 * attacks +y; orange (1) is rotated 180 degrees, so left and right swap too.
 */
export function attackUp(v: Vec3, team: number): Vec3 {
  return team === 1 ? { x: -v.x, y: -v.y, z: v.z } : v;
}

export type Third = "attacking" | "middle" | "defending";

/** Thirds of the field's length, from the attacking team's point of view. */
export function third(v: Vec3, team: number): Third {
  const y = attackUp(v, team).y;
  const t = FIELD.halfLength / 3;
  return y > t ? "attacking" : y < -t ? "defending" : "middle";
}

export type Lane = "left" | "center" | "right";

/** Which third of the field's width, as seen by a team attacking up the screen. */
export function lane(v: Vec3, team: number): Lane {
  const x = attackUp(v, team).x;
  const w = FIELD.halfWidth / 3;
  // +x is the attacker's left when facing +y: confirmed 2026-10-24 by wall
  // touches in freeplay (left wall x ≈ +3700, right wall x ≈ -3400).
  return x > w ? "left" : x < -w ? "right" : "center";
}
