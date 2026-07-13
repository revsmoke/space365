import { ZONE_SLOTS, ROOMS_PER_ZONE } from '@shared/layout';
import type { ZoneDatum } from './zones';
import type { RoomDatum } from './rooms';

/**
 * ?synthetic=1 perf mode: fabricate the full 64 zones x 24 rooms world
 * client-side so rendering can be stress-tested without server data.
 */
export function syntheticWorld(): { zones: ZoneDatum[]; rooms: RoomDatum[] } {
  const zones: ZoneDatum[] = [];
  const rooms: RoomDatum[] = [];
  for (let z = 1; z <= ZONE_SLOTS; z++) {
    const teamId = `synthetic-team-${z}`;
    zones.push({ zoneId: z, teamId, name: `Synth Zone ${z}` });
    for (let s = 1; s <= ROOMS_PER_ZONE; s++) {
      const roomId = z * 100 + s;
      // deterministic pseudo-random glow so the scene has variety
      const g = ((z * 7919 + s * 104729) % 1000) / 1000;
      rooms.push({
        roomId,
        channelId: `syn-${roomId}`,
        teamId,
        name: `Room ${roomId}`,
        glow: g > 0.7 ? g : g * 0.3,
        isPrivate: (z + s) % 11 === 0,
      });
    }
  }
  return { zones, rooms };
}
