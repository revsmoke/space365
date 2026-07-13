import { describe, expect, test } from 'bun:test';
import {
  ZONE_SLOTS,
  ROOMS_PER_ZONE,
  assignRoomSlot,
  assignZoneSlot,
  hashId,
  roomPosition,
  zonePosition,
} from '../shared/types/layout';

describe('deterministic layout v1', () => {
  test('hash is stable', () => {
    expect(hashId('team-eng')).toBe(hashId('team-eng'));
    expect(hashId('team-eng')).not.toBe(hashId('team-ops'));
  });

  test('zone assignment is deterministic and collision-free', () => {
    const taken = new Set<number>();
    const ids = Array.from({ length: 40 }, (_, i) => `team-${i}`);
    const slots = ids.map((id) => {
      const s = assignZoneSlot(id, taken);
      taken.add(s);
      return s;
    });
    expect(new Set(slots).size).toBe(40);
    // adding new teams never moves existing ones
    const taken2 = new Set<number>(slots);
    const next = assignZoneSlot('team-new', taken2);
    expect(slots).toEqual(
      ids.map((id, i) => slots[i]) // unchanged
    );
    expect(taken2.has(next)).toBe(false);
    expect(next).toBeGreaterThanOrEqual(1);
    expect(next).toBeLessThanOrEqual(ZONE_SLOTS);
  });

  test('room ids encode zone', () => {
    const taken = new Set<number>();
    const roomId = assignRoomSlot('chan-general', 3, taken);
    expect(Math.floor(roomId / 100)).toBe(3);
    expect(roomId % 100).toBeGreaterThanOrEqual(1);
    expect(roomId % 100).toBeLessThanOrEqual(ROOMS_PER_ZONE);
  });

  test('zone positions are unique and plaza is origin', () => {
    expect(zonePosition(0)).toEqual({ x: 0, z: 0 });
    const seen = new Set<string>();
    for (let z = 1; z <= ZONE_SLOTS; z++) {
      const p = zonePosition(z);
      const key = `${p.x},${p.z}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test('rooms sit near their zone center', () => {
    const zc = zonePosition(5);
    for (let slot = 1; slot <= ROOMS_PER_ZONE; slot++) {
      const p = roomPosition(500 + slot);
      expect(Math.abs(p.x - zc.x)).toBeLessThanOrEqual(40);
      expect(Math.abs(p.z - zc.z)).toBeLessThanOrEqual(40);
      expect(p.zoneId).toBe(5);
    }
  });
});
