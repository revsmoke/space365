/**
 * Shared helpers for the P4 data surfaces (ingest/src/surfaces/*).
 *
 * Each surface is a pure mapping layer (unit-testable with mock Graph
 * payloads) plus a `run*Once` poll function driven from main.ts.
 */
import type { StdbWriter } from "../stdb_writer";

/** Structural subset of GraphClient so tests can stub Graph reads. */
export type GraphLike = {
  get(pathOrUrl: string): Promise<unknown>;
  getAll(path: string, limit?: number): Promise<Record<string, unknown>[]>;
};

export type Logger = (line: string) => void;

/** SQL reader shape (matches stdb_sql.stdbSql) so tests can stub reads. */
export type SqlReader = (query: string) => Promise<string[][]>;

/** Graph datetimes are frequently tz-suffix-less UTC; parse accordingly. */
export function parseGraphUtcMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const withZone = /[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

export function msToMicros(ms: number): bigint {
  return BigInt(Math.round(ms)) * 1000n;
}

/** Floor a millisecond timestamp to its UTC hour bucket. */
export function hourBucketMs(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

/** Reducer calls the P4 surfaces need. */
export type SurfaceReducers = {
  upsertMeeting(args: {
    eventId: string;
    teamId: string | undefined;
    zoneId: number;
    subjectRedacted: string;
    startsAtMicros: bigint;
    endsAtMicros: bigint;
    joinUrl: string | undefined;
  }): Promise<void>;
  upsertBookingAppointment(args: {
    appointmentId: string;
    businessId: string;
    serviceName: string;
    startsAtMicros: bigint;
    status: string;
  }): Promise<void>;
  ingestCallStats(args: {
    bucketStartMicros: bigint;
    modality: string;
    callCount: number;
    totalMinutes: number;
  }): Promise<void>;
  createOrUpdateQuest(args: {
    questId: string;
    userId: string;
    kind: string;
    title: string;
    sourceRef: string;
    deeplink: string;
    status: string;
  }): Promise<void>;
  ingestAuditStats(args: {
    bucketStartMicros: bigint;
    category: string;
    count: number;
  }): Promise<void>;
  upsertZoneTask(args: {
    taskId: string;
    teamId: string;
    planTitle: string;
    title: string;
    bucket: string;
    percentComplete: number;
    due: string | undefined;
  }): Promise<void>;
  deleteZoneTask(args: { taskId: string }): Promise<void>;
  // --- Groups permission batch (groups_sync / libraries / mailboxes) --------
  upsertTeam(args: {
    teamId: string;
    name: string;
    zoneId: number;
    isEnabled: boolean;
  }): Promise<void>;
  syncTeamMembership(args: {
    teamId: string;
    userIds: string[];
    roles: string[];
  }): Promise<void>;
  upsertZoneLibrary(args: {
    teamId: string;
    fileCount: number;
    recentCount7D: number;
    lastFileAt: bigint;
  }): Promise<void>;
  upsertLibraryFile(args: {
    fileId: string;
    teamId: string;
    name: string;
    webUrl: string;
    modifiedAt: bigint;
  }): Promise<void>;
  pruneLibraryFiles(args: { teamId: string; keepIds: string[] }): Promise<void>;
  upsertZoneMailbox(args: {
    teamId: string;
    threadCount7D: number;
    lastTopicAt: bigint;
  }): Promise<void>;
};

/**
 * The committed StdbWriter facade predates P4, so reach the generated
 * reducer accessors through its exposed connection (camelCase accessors
 * from shared/bindings) instead of editing stdb_writer.ts.
 */
export function surfaceReducers(writer: StdbWriter): SurfaceReducers {
  const r = writer.conn.reducers;
  return {
    upsertMeeting: (args) => r.upsertMeeting(args),
    upsertBookingAppointment: (args) => r.upsertBookingAppointment(args),
    ingestCallStats: (args) => r.ingestCallStats(args),
    createOrUpdateQuest: (args) => r.createOrUpdateQuest(args),
    ingestAuditStats: (args) => r.ingestAuditStats(args),
    upsertZoneTask: (args) => r.upsertZoneTask(args),
    deleteZoneTask: (args) => r.deleteZoneTask(args),
    upsertTeam: (args) => r.upsertTeam(args),
    syncTeamMembership: (args) => r.syncTeamMembership(args),
    upsertZoneLibrary: (args) => r.upsertZoneLibrary(args),
    upsertLibraryFile: (args) => r.upsertLibraryFile(args),
    pruneLibraryFiles: (args) => r.pruneLibraryFiles(args),
    upsertZoneMailbox: (args) => r.upsertZoneMailbox(args),
  };
}

export type SurfaceRunOptions = {
  log?: Logger;
  sql?: SqlReader;
  nowMs?: number;
  /** When true, fetch + map but skip reducer writes (summary is logged). */
  dryRun?: boolean;
};
