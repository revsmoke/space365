/**
 * Groups batch surface: full M365 unified-group directory → world zones.
 *
 * Lists /groups filtered to unified (M365) groups. Every unified group NOT
 * already in the team table gets a fresh deterministic zone slot and an
 * upsert_team with **isEnabled: false** — allowlist-first: admins enable
 * zones in the console, we never flood the world. Teams-backed groups that
 * full_sync already wrote stay untouched (we only add missing rows).
 *
 * Membership for newly added groups syncs via /groups/{id}/members?$select=id
 * (all roles 'member' — /groups/{id}/members carries no owner flag; owners
 * come from /owners which we deliberately skip here).
 *
 * CAUTION: tenants can hold thousands of groups — the sync is capped at
 * GROUPS_SYNC_CAP (env-tunable, default 500); we log when the listing was
 * (possibly) truncated.
 */
import { ZONE_SLOTS, assignZoneSlot } from "../../../shared/types/layout";
import { GraphError } from "../graph_client";
import { stdbSql } from "../stdb_sql";
import {
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
} from "./common";

export const GROUPS_SYNC_INTERVAL_MS = 60 * 60_000; // 1h
export const GROUPS_SYNC_CAP_DEFAULT = 500;

/** Group listing cap: GROUPS_SYNC_CAP env var (positive integer), default 500. */
export function groupsSyncCap(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.GROUPS_SYNC_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : GROUPS_SYNC_CAP_DEFAULT;
}

const UNIFIED_FILTER_PATH =
  "/groups?$select=id,displayName,groupTypes,resourceProvisioningOptions" +
  "&$filter=groupTypes/any(c:c eq 'Unified')";

export type GraphGroup = {
  id?: string;
  displayName?: string;
  groupTypes?: string[];
  resourceProvisioningOptions?: string[];
};

export type GraphDirectoryObject = {
  id?: string;
  "@odata.type"?: string;
};

export function isUnifiedGroup(group: GraphGroup): boolean {
  return Array.isArray(group.groupTypes) && group.groupTypes.includes("Unified");
}

export type NewTeamRow = {
  teamId: string;
  name: string;
  zoneId: number;
  isEnabled: boolean; // always false here — allowlist-first
};

export type ZonePlan = {
  rows: NewTeamRow[];
  /** Group ids we could not place because the 64-slot zone grid filled up. */
  gridFullSkipped: string[];
};

/**
 * Map unified groups to new team rows. Groups already in the team table are
 * skipped (Teams-backed groups full_sync wrote stay untouched). Zone slots
 * come from the shared deterministic layout; `takenZones` is mutated as slots
 * are claimed so a single pass never double-assigns.
 */
export function planNewGroupZones(
  groups: GraphGroup[],
  existingTeamIds: ReadonlySet<string>,
  takenZones: Set<number>,
): ZonePlan {
  const rows: NewTeamRow[] = [];
  const gridFullSkipped: string[] = [];
  for (const group of groups) {
    if (!group.id || existingTeamIds.has(group.id)) continue;
    if (takenZones.size >= ZONE_SLOTS) {
      gridFullSkipped.push(group.id);
      continue;
    }
    const zoneId = assignZoneSlot(group.id, takenZones);
    takenZones.add(zoneId);
    rows.push({
      teamId: group.id,
      name: group.displayName ?? "",
      zoneId,
      isEnabled: false,
    });
  }
  return { rows, gridFullSkipped };
}

/** Member directory objects → user ids ('member' role for all). */
export function memberUserIds(members: GraphDirectoryObject[]): string[] {
  return members
    .filter(
      (m) =>
        m.id &&
        // /members can return devices/service principals; keep users (and
        // untyped rows, which $select=id sometimes produces).
        (m["@odata.type"] === undefined ||
          m["@odata.type"] === "#microsoft.graph.user"),
    )
    .map((m) => m.id!);
}

export type GroupsSyncResult = {
  unifiedFound: number;
  truncated: boolean;
  filterSupported: boolean;
  teamsAdded: number;
  alreadySynced: number;
  gridFullSkipped: number;
  membershipsSynced: number;
  membershipWriteFailures: number;
};

export async function runGroupsSyncOnce(
  graph: GraphLike,
  reducers: Pick<SurfaceReducers, "upsertTeam" | "syncTeamMembership">,
  options: SurfaceRunOptions = {},
): Promise<GroupsSyncResult> {
  const log = options.log ?? console.log;
  const sql = options.sql ?? stdbSql;

  // Existing teams + taken zone slots (never reshuffle existing geography).
  const existingTeamIds = new Set<string>();
  const takenZones = new Set<number>();
  for (const [teamId, zoneId] of await sql("SELECT team_id, zone_id FROM team")) {
    if (teamId) existingTeamIds.add(teamId);
    const zone = Number(zoneId);
    if (Number.isFinite(zone)) takenZones.add(zone);
  }

  // Unified groups, capped. The groupTypes/any filter is supported on v1.0
  // without ConsistencyLevel; if the tenant rejects it (400) fall back to an
  // unfiltered listing filtered client-side.
  const cap = groupsSyncCap();
  let filterSupported = true;
  let groups: GraphGroup[];
  try {
    groups = (await graph.getAll(UNIFIED_FILTER_PATH, cap)) as GraphGroup[];
  } catch (error) {
    if (!(error instanceof GraphError) || error.status !== 400) throw error;
    filterSupported = false;
    log(`groups_sync.filter_rejected code=${error.code} falling back to client-side filter`);
    const all = (await graph.getAll(
      "/groups?$select=id,displayName,groupTypes,resourceProvisioningOptions",
      cap,
    )) as GraphGroup[];
    groups = all.filter(isUnifiedGroup);
  }
  // Defense in depth: the filter path should only return unified groups, but
  // never trust a listing to write directory rows.
  const unified = groups.filter(isUnifiedGroup);
  const truncated = groups.length >= cap;
  if (truncated) {
    log(`groups_sync.truncated cap=${cap} — tenant has more groups than the sync cap`);
  }

  const plan = planNewGroupZones(unified, existingTeamIds, takenZones);
  if (plan.gridFullSkipped.length > 0) {
    log(`groups_sync.zone_grid_full skipped=${plan.gridFullSkipped.length}`);
  }

  const result: GroupsSyncResult = {
    unifiedFound: unified.length,
    truncated,
    filterSupported,
    teamsAdded: 0,
    alreadySynced: unified.filter((g) => g.id && existingTeamIds.has(g.id)).length,
    gridFullSkipped: plan.gridFullSkipped.length,
    membershipsSynced: 0,
    membershipWriteFailures: 0,
  };

  for (const row of plan.rows) {
    if (!options.dryRun) await reducers.upsertTeam(row);
    result.teamsAdded++;

    // Membership for the newly added group (ids only, all role 'member').
    let userIds: string[];
    try {
      const members = (await graph.getAll(
        `/groups/${row.teamId}/members?$select=id`,
      )) as GraphDirectoryObject[];
      userIds = memberUserIds(members);
    } catch (error) {
      if (error instanceof GraphError && (error.status === 403 || error.status === 404)) {
        log(`groups_sync.members.skip group=${row.teamId} status=${error.status}`);
        continue;
      }
      throw error;
    }
    try {
      if (!options.dryRun) {
        await reducers.syncTeamMembership({
          teamId: row.teamId,
          userIds,
          roles: userIds.map(() => "member"),
        });
      }
      result.membershipsSynced += userIds.length;
    } catch (error) {
      // Known module bug: sync_team_membership can panic on its multi-column
      // index prefix filter. Keep syncing the remaining groups.
      result.membershipWriteFailures++;
      log(
        `groups_sync.members.write_failed group=${row.teamId} error=${(error as Error).message}`,
      );
    }
  }

  log(
    `groups_sync.done unified=${result.unifiedFound} added=${result.teamsAdded} ` +
      `existing=${result.alreadySynced} truncated=${result.truncated} ` +
      `grid_full_skipped=${result.gridFullSkipped} members=${result.membershipsSynced} ` +
      `member_write_failures=${result.membershipWriteFailures}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return result;
}
