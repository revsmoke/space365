/**
 * Full Graph → SpacetimeDB sync (SPEC §5 membership model, P1.6).
 *
 * App-only reads: tenant users (first 100), first 5 teams, their channels,
 * team members, channel members. Zone/room slots come from the shared
 * deterministic layout (shared/types/layout.ts); already-assigned slots are
 * loaded from module state so existing geography never reshuffles.
 */
import {
  ZONE_SLOTS,
  assignRoomSlot,
  assignZoneSlot,
} from "../../shared/types/layout";
import { GraphClient, GraphError } from "./graph_client";
import { stdbSql } from "./stdb_sql";
import type { StdbWriter } from "./stdb_writer";

export const TEAM_SYNC_LIMIT = 5;
export const USER_SYNC_LIMIT = 100;

/**
 * WORKAROUND (2026-07-06): the deployed module's room_activity view panics
 * ("too many elements") whenever an enabled standard channel exists, aborting
 * any transaction that touches channel/channel_activity_agg. Until the module
 * fix ships (multi-column index prefix filter), channels sync with
 * is_enabled=false; flip INGEST_CHANNELS_ENABLED=1 once fixed.
 */
export function channelsEnabledDefault(env: Record<string, string | undefined> = process.env): boolean {
  return (env.INGEST_CHANNELS_ENABLED ?? "0") === "1";
}

export type FullSyncResult = {
  users: number;
  teams: number;
  channels: number;
  teamMemberships: number;
  channelMemberships: number;
  skippedChannelMembershipReads: number;
  failedMembershipWrites: number;
};

type GraphUser = {
  id?: string;
  displayName?: string;
  department?: string;
  jobTitle?: string;
  accountEnabled?: boolean;
};

type GraphTeam = { id?: string; displayName?: string };

type GraphChannel = {
  id?: string;
  displayName?: string;
  membershipType?: string;
};

type GraphMember = {
  userId?: string;
  roles?: string[];
};

export function visibilityFromMembershipType(membershipType?: string): string {
  if (membershipType === "private") return "private";
  if (membershipType === "shared") return "shared";
  return "standard";
}

export function memberRole(roles?: string[]): string {
  return Array.isArray(roles) && roles.includes("owner") ? "owner" : "member";
}

/** Load already-assigned zone slots so new teams never move existing ones. */
export async function loadZoneState(): Promise<{
  byTeam: Map<string, number>;
  taken: Set<number>;
}> {
  const byTeam = new Map<string, number>();
  const taken = new Set<number>();
  for (const [teamId, zoneId] of await stdbSql("SELECT team_id, zone_id FROM team")) {
    const zone = Number(zoneId);
    if (!Number.isFinite(zone)) continue;
    byTeam.set(teamId, zone);
    taken.add(zone);
  }
  return { byTeam, taken };
}

/** Load already-assigned room slots, keyed by zone. */
export async function loadRoomState(): Promise<{
  byChannel: Map<string, number>;
  takenByZone: Map<number, Set<number>>;
}> {
  const byChannel = new Map<string, number>();
  const takenByZone = new Map<number, Set<number>>();
  for (const [channelId, roomId] of await stdbSql(
    "SELECT channel_id, room_id FROM channel",
  )) {
    const room = Number(roomId);
    if (!Number.isFinite(room)) continue;
    byChannel.set(channelId, room);
    const zone = Math.floor(room / 100);
    if (!takenByZone.has(zone)) takenByZone.set(zone, new Set());
    takenByZone.get(zone)!.add(room % 100);
  }
  return { byChannel, takenByZone };
}

export async function runFullSync(
  graph: GraphClient,
  writer: StdbWriter,
  log: (line: string) => void = console.log,
  channelsEnabled: boolean = channelsEnabledDefault(),
): Promise<FullSyncResult> {
  const result: FullSyncResult = {
    users: 0,
    teams: 0,
    channels: 0,
    teamMemberships: 0,
    channelMemberships: 0,
    skippedChannelMembershipReads: 0,
    failedMembershipWrites: 0,
  };

  // --- Tenant users (first 100) ------------------------------------------
  const users = (await graph.getAll(
    `/users?$top=${USER_SYNC_LIMIT}&$select=id,displayName,department,jobTitle,accountEnabled`,
    USER_SYNC_LIMIT,
  )) as GraphUser[];
  for (const user of users) {
    if (!user.id) continue;
    await writer.upsertUser({
      userId: user.id,
      displayName: user.displayName ?? "",
      dept: user.department ?? "",
      title: user.jobTitle ?? "",
      isActive: user.accountEnabled !== false,
    });
    result.users++;
  }
  log(`sync.users=${result.users}`);

  // --- Teams (first 5) + deterministic zones ------------------------------
  const zoneState = await loadZoneState();
  const roomState = await loadRoomState();
  const teams = (await graph.getAll(
    `/teams?$top=${TEAM_SYNC_LIMIT}`,
    TEAM_SYNC_LIMIT,
  )) as GraphTeam[];

  for (const team of teams) {
    if (!team.id) continue;
    let zoneId = zoneState.byTeam.get(team.id);
    if (zoneId === undefined) {
      zoneId = assignZoneSlot(team.id, zoneState.taken);
      zoneState.taken.add(zoneId);
      zoneState.byTeam.set(team.id, zoneId);
    }
    if (zoneId > ZONE_SLOTS) throw new Error(`zone ${zoneId} out of range`);
    await writer.upsertTeam({
      teamId: team.id,
      name: team.displayName ?? "",
      zoneId,
      isEnabled: true,
    });
    result.teams++;

    // --- Channels + rooms --------------------------------------------------
    const channels = (await graph.getAll(
      `/teams/${team.id}/channels`,
    )) as GraphChannel[];
    if (!roomState.takenByZone.has(zoneId)) {
      roomState.takenByZone.set(zoneId, new Set());
    }
    const takenInZone = roomState.takenByZone.get(zoneId)!;

    for (const channel of channels) {
      if (!channel.id) continue;
      let roomId = roomState.byChannel.get(channel.id);
      if (roomId === undefined) {
        roomId = assignRoomSlot(channel.id, zoneId, takenInZone);
        takenInZone.add(roomId % 100);
        roomState.byChannel.set(channel.id, roomId);
      }
      await writer.upsertChannel({
        channelId: channel.id,
        teamId: team.id,
        name: channel.displayName ?? "",
        roomId,
        visibility: visibilityFromMembershipType(channel.membershipType),
        isEnabled: channelsEnabled,
      });
      result.channels++;

      // --- Channel members (private/shared have their own roster) --------
      try {
        const members = (await graph.getAll(
          `/teams/${team.id}/channels/${channel.id}/members`,
        )) as GraphMember[];
        const withIds = members.filter((m) => m.userId);
        try {
          await writer.syncChannelMembership({
            channelId: channel.id,
            userIds: withIds.map((m) => m.userId!),
            roles: withIds.map((m) => memberRole(m.roles)),
          });
          result.channelMemberships += withIds.length;
        } catch (error) {
          // Known module bug: sync_channel_membership panics on its
          // multi-column index prefix filter. Keep syncing everything else.
          result.failedMembershipWrites++;
          log(`sync.channel_members.write_failed channel=${channel.id} error=${(error as Error).message}`);
        }
      } catch (error) {
        if (error instanceof GraphError && (error.status === 403 || error.status === 404)) {
          result.skippedChannelMembershipReads++;
          log(`sync.channel_members.skip channel=${channel.id} status=${error.status}`);
        } else {
          throw error;
        }
      }
    }

    // --- Team members -------------------------------------------------------
    const members = (await graph.getAll(`/teams/${team.id}/members`)) as GraphMember[];
    const withIds = members.filter((m) => m.userId);
    try {
      await writer.syncTeamMembership({
        teamId: team.id,
        userIds: withIds.map((m) => m.userId!),
        roles: withIds.map((m) => memberRole(m.roles)),
      });
      result.teamMemberships += withIds.length;
    } catch (error) {
      // Known module bug: sync_team_membership panics on its multi-column
      // index prefix filter. Keep syncing everything else.
      result.failedMembershipWrites++;
      log(`sync.team_members.write_failed team=${team.id} error=${(error as Error).message}`);
    }
  }

  log(
    `sync.done teams=${result.teams} channels=${result.channels} users=${result.users} ` +
      `team_members=${result.teamMemberships} channel_members=${result.channelMemberships} ` +
      `failed_membership_writes=${result.failedMembershipWrites}`,
  );
  return result;
}
