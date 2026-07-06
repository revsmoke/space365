/**
 * Deterministic world layout (SPEC §11, layout_version 1).
 *
 * Stable ID → coordinates. Same algorithm runs in the ingest service (assigns
 * zone_id/room_id when upserting teams/channels) and the client (positions
 * geometry). New teams/channels get free slots without moving existing ones
 * because slot choice depends only on the ID hash, resolved by open addressing.
 *
 * zone_id: 1..ZONE_SLOTS placed on a ring-of-rings grid around the plaza.
 * room_id: zone_id * 100 + (1..ROOMS_PER_ZONE) laid out in a grid inside the zone.
 */

export const LAYOUT_VERSION = 1;
export const ZONE_SLOTS = 64;
export const ROOMS_PER_ZONE = 24;

/** Zone footprint in world units. */
export const ZONE_SIZE = 60;
/** Distance between zone centers. */
export const ZONE_PITCH = 80;
/** Room footprint inside a zone. */
export const ROOM_SIZE = 10;
export const ROOM_PITCH = 13;

/** FNV-1a 32-bit — stable across JS runtimes, no bigint needed. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Assign a zone slot for a team id given the set of already-taken slots.
 * Open addressing: start at hash % ZONE_SLOTS, probe forward.
 * Deterministic given identical taken-sets — the ingest service is the only
 * assigner (single writer), so client just consumes stored zone_id.
 */
export function assignZoneSlot(teamId: string, taken: Set<number>): number {
  const start = hashId(teamId) % ZONE_SLOTS;
  for (let i = 0; i < ZONE_SLOTS; i++) {
    const slot = ((start + i) % ZONE_SLOTS) + 1; // 1-based
    if (!taken.has(slot)) return slot;
  }
  throw new Error('zone grid full');
}

export function assignRoomSlot(channelId: string, zoneId: number, takenInZone: Set<number>): number {
  const start = hashId(channelId) % ROOMS_PER_ZONE;
  for (let i = 0; i < ROOMS_PER_ZONE; i++) {
    const slot = ((start + i) % ROOMS_PER_ZONE) + 1;
    if (!takenInZone.has(slot)) return zoneId * 100 + slot;
  }
  throw new Error(`zone ${zoneId} room grid full`);
}

/**
 * Zone center position. Slot 0 is reserved for the plaza at origin.
 * Zones spiral outward in square rings: ring 1 holds 8, ring 2 holds 16, ...
 */
export function zonePosition(zoneId: number): { x: number; z: number } {
  if (zoneId <= 0) return { x: 0, z: 0 };
  let ring = 1;
  let index = zoneId - 1;
  let capacity = 8;
  while (index >= capacity) {
    index -= capacity;
    ring++;
    capacity = ring * 8;
  }
  const side = 2 * ring; // cells per side (excluding corner shared)
  const sideIndex = Math.floor(index / side);
  const offset = (index % side) - ring;
  const d = ring * ZONE_PITCH;
  switch (sideIndex) {
    case 0: return { x: offset * ZONE_PITCH, z: -d }; // north edge
    case 1: return { x: d, z: offset * ZONE_PITCH }; // east
    case 2: return { x: -offset * ZONE_PITCH, z: d }; // south
    default: return { x: -d, z: -offset * ZONE_PITCH }; // west
  }
}

/** Room position within its zone: 6×4 grid centered on the zone center. */
export function roomPosition(roomId: number): { x: number; z: number; zoneId: number } {
  const zoneId = Math.floor(roomId / 100);
  const slot = (roomId % 100) - 1; // 0-based
  const cols = 6;
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  const zc = zonePosition(zoneId);
  const x0 = zc.x - ((cols - 1) / 2) * ROOM_PITCH;
  const z0 = zc.z - 1.5 * ROOM_PITCH;
  return { x: x0 + col * ROOM_PITCH, z: z0 + row * ROOM_PITCH, zoneId };
}
