/**
 * Provisioning worker: executes admin-requested world actions via app-only
 * Graph calls (SPEC command-queue pattern).
 *
 * Admins file requests through the module's admin_request_channel /
 * admin_request_group reducers; pending provision_request rows surface to
 * this service through the service_queue view.
 *
 * - kind 'channel': create the Teams channel (Channel.Create app role),
 *   assign a deterministic room slot from the shared layout, upsert the
 *   channel row.
 * - kind 'group': create an M365 unified group (Group.Create app role),
 *   assign a deterministic zone slot, upsert the team row **enabled** (an
 *   admin explicitly founded it) and sync its (empty) membership.
 *   NOTE (v1): the group starts as a plain M365 group — we deliberately do
 *   NOT team-ify it (no PUT /groups/{id}/team); Teams-ification is a
 *   follow-up ceremony.
 *
 * Every request reports its outcome back through service_complete_provision.
 * Completed rows leave the view, so the queue is self-draining; an in-memory
 * set additionally guarantees each request is processed at most once per run.
 */
import { assignRoomSlot, assignZoneSlot } from "../../shared/types/layout";
import type { DbConnection } from "../../shared/bindings";
import { GraphError } from "./graph_client";
import { stdbSql } from "./stdb_sql";
import type { StdbWriter } from "./stdb_writer";
import type { Logger, SqlReader } from "./surfaces/common";

/** Structural Graph subset the worker needs (tests stub this). */
export type GraphProvisioner = {
  getAll(path: string, limit?: number): Promise<Record<string, unknown>[]>;
  post(pathOrUrl: string, body: unknown): Promise<unknown>;
};

/** The service_queue row fields the worker consumes (camelCase bindings). */
export type ProvisionRow = {
  id: bigint;
  kind: string;
  teamId: string;
  name: string;
  description: string;
};

/** Reducer calls the worker needs. */
export type ProvisionReducers = {
  upsertChannel(args: {
    channelId: string;
    teamId: string;
    name: string;
    roomId: number;
    visibility: string;
    isEnabled: boolean;
  }): Promise<void>;
  /** Required for kind 'group'; optional for channel-only callers (older tests). */
  upsertTeam?(args: {
    teamId: string;
    name: string;
    zoneId: number;
    isEnabled: boolean;
  }): Promise<void>;
  /** Required for kind 'group'; optional for channel-only callers (older tests). */
  syncTeamMembership?(args: {
    teamId: string;
    userIds: string[];
    roles: string[];
  }): Promise<void>;
  serviceCompleteProvision(args: {
    requestId: bigint;
    ok: boolean;
    resultRef: string;
  }): Promise<void>;
};

export function provisionReducers(writer: StdbWriter): ProvisionReducers {
  const r = writer.conn.reducers;
  return {
    upsertChannel: (args) => r.upsertChannel(args),
    upsertTeam: (args) => r.upsertTeam(args),
    syncTeamMembership: (args) => r.syncTeamMembership(args),
    serviceCompleteProvision: (args) => r.serviceCompleteProvision(args),
  };
}

/** Queue row → Graph channel-create payload. */
export function channelCreatePayload(
  row: Pick<ProvisionRow, "name" | "description">,
): { displayName: string; description: string; membershipType: "standard" } {
  return {
    displayName: row.name,
    description: row.description,
    membershipType: "standard",
  };
}

/**
 * Duplicate-name detection. Graph answers 409 Conflict for an exact repeat of
 * a live channel, but historically also 400 with a "name already existed"
 * message (e.g. soft-deleted channels), so match both.
 */
export function isAlreadyExists(error: unknown): boolean {
  if (!(error instanceof GraphError)) return false;
  if (error.status === 409) return true;
  return /already exist/i.test(error.message) || /NameAlreadyExists/i.test(error.code);
}

/** Escape a string literal for an OData $filter clause. */
export function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Look up an existing channel id by display name (used on 409). */
export async function findChannelByName(
  graph: Pick<GraphProvisioner, "getAll">,
  teamId: string,
  displayName: string,
): Promise<string | null> {
  const channels = await graph.getAll(
    `/teams/${teamId}/channels?$filter=displayName eq '${escapeODataLiteral(displayName)}'`,
  );
  const match = channels.find((ch) => typeof ch.id === "string" && ch.id);
  return match ? String(match.id) : null;
}

/**
 * Create the Teams channel; a duplicate-name conflict resolves to the
 * existing channel (idempotent success).
 */
export async function createGraphChannel(
  graph: GraphProvisioner,
  row: Pick<ProvisionRow, "teamId" | "name" | "description">,
): Promise<{ channelId: string; reused: boolean }> {
  try {
    const created = (await graph.post(
      `/teams/${row.teamId}/channels`,
      channelCreatePayload(row),
    )) as { id?: string } | null;
    if (!created?.id) throw new Error("channel created without id");
    return { channelId: created.id, reused: false };
  } catch (error) {
    if (isAlreadyExists(error)) {
      const existing = await findChannelByName(graph, row.teamId, row.name);
      if (existing) return { channelId: existing, reused: true };
    }
    throw error;
  }
}

// --- kind 'group': found a new M365 unified group ---------------------------

/** Graph caps mailNickname at 64 chars. */
const MAIL_NICKNAME_MAX = 64;

/**
 * Derive a mailNickname from the display name: lowercase alphanumerics only.
 * Falls back to 'group' when nothing survives (e.g. an all-symbol name).
 */
export function deriveMailNickname(name: string): string {
  const nickname = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, MAIL_NICKNAME_MAX);
  return nickname || "group";
}

/**
 * Nickname collision: Graph answers 400 with "Another object with the same
 * value for property mailNickname already exists."
 */
export function isNicknameInUse(error: unknown): boolean {
  if (!(error instanceof GraphError)) return false;
  return error.status === 400 && /mailNickname/i.test(error.message);
}

/** Queue row → Graph group-create payload (M365 unified group, not a team). */
export function groupCreatePayload(
  row: Pick<ProvisionRow, "name" | "description">,
  mailNickname: string,
): {
  displayName: string;
  description: string;
  mailNickname: string;
  groupTypes: ["Unified"];
  mailEnabled: true;
  securityEnabled: false;
} {
  return {
    displayName: row.name,
    description: row.description,
    mailNickname,
    groupTypes: ["Unified"],
    mailEnabled: true,
    securityEnabled: false,
  };
}

/**
 * Create the M365 group. A mailNickname collision retries exactly once with a
 * '-2' suffix; a second collision (or any other failure) propagates.
 */
export async function createGraphGroup(
  graph: Pick<GraphProvisioner, "post">,
  row: Pick<ProvisionRow, "name" | "description">,
): Promise<{ groupId: string; mailNickname: string }> {
  const nickname = deriveMailNickname(row.name);
  const attempt = async (mailNickname: string): Promise<string> => {
    const created = (await graph.post(
      "/groups",
      groupCreatePayload(row, mailNickname),
    )) as { id?: string } | null;
    if (!created?.id) throw new Error("group created without id");
    return created.id;
  };
  try {
    return { groupId: await attempt(nickname), mailNickname: nickname };
  } catch (error) {
    if (!isNicknameInUse(error)) throw error;
    const retry = `${nickname.slice(0, MAIL_NICKNAME_MAX - 2)}-2`;
    return { groupId: await attempt(retry), mailNickname: retry };
  }
}

/**
 * Deterministic zone slot for the new group: seed taken slots from the team
 * table (same approach as groups_sync). If the group already has a team row
 * (e.g. a retried request), its slot is kept.
 */
export async function assignZoneForGroup(
  sql: SqlReader,
  groupId: string,
): Promise<number> {
  const taken = new Set<number>();
  for (const [teamId, zoneId] of await sql("SELECT team_id, zone_id FROM team")) {
    const zone = Number(zoneId);
    if (!Number.isFinite(zone)) continue;
    if (teamId === groupId) return zone; // already synced: keep its slot
    taken.add(zone);
  }
  return assignZoneSlot(groupId, taken);
}

/** Short failure summary for result_ref — status/code only, never tokens or PII. */
export function shortError(error: unknown): string {
  if (error instanceof GraphError) return `graph ${error.status} ${error.code}`;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer <redacted>").slice(0, 120);
}

/**
 * Deterministic room slot for the new channel: seed taken slots from the
 * team's existing channels (same approach as full_sync.loadRoomState, scoped
 * to one team). If the channel already has a row, its slot is kept.
 */
export async function assignRoomForChannel(
  sql: SqlReader,
  teamId: string,
  channelId: string,
): Promise<number> {
  const teamLiteral = escapeODataLiteral(teamId); // '' escaping works for SQL too
  const teamRows = await sql(`SELECT zone_id FROM team WHERE team_id = '${teamLiteral}'`);
  const zoneId = Number(teamRows[0]?.[0]);
  if (!Number.isFinite(zoneId)) {
    throw new Error(`team has no zone assignment`);
  }
  const takenInZone = new Set<number>();
  for (const [existingId, roomId] of await sql(
    `SELECT channel_id, room_id FROM channel WHERE team_id = '${teamLiteral}'`,
  )) {
    const room = Number(roomId);
    if (!Number.isFinite(room)) continue;
    if (existingId === channelId) return room; // already synced: keep its slot
    takenInZone.add(room % 100);
  }
  return assignRoomSlot(channelId, zoneId, takenInZone);
}

export type ProvisioningWorkerOptions = {
  graph: GraphProvisioner;
  reducers: ProvisionReducers;
  sql?: SqlReader;
  log?: Logger;
};

export class ProvisioningWorker {
  #graph: GraphProvisioner;
  #reducers: ProvisionReducers;
  #sql: SqlReader;
  #log: Logger;
  /** Request ids handled this run — each request is processed exactly once. */
  #processed = new Set<string>();

  constructor(options: ProvisioningWorkerOptions) {
    this.#graph = options.graph;
    this.#reducers = options.reducers;
    this.#sql = options.sql ?? stdbSql;
    this.#log = options.log ?? console.log;
  }

  /**
   * Handle one pending request. Returns false when the request was already
   * processed this run (debounce). Every accepted request terminates in a
   * service_complete_provision call — success or failure — so it leaves the
   * pending view either way.
   */
  async processRequest(row: ProvisionRow): Promise<boolean> {
    const key = row.id.toString();
    if (this.#processed.has(key)) return false;
    this.#processed.add(key);

    if (row.kind !== "channel" && row.kind !== "group") {
      await this.#reducers.serviceCompleteProvision({
        requestId: row.id,
        ok: false,
        resultRef: `unsupported kind: ${row.kind}`,
      });
      this.#log(`provision.unsupported id=${key} kind=${row.kind}`);
      return true;
    }

    try {
      if (row.kind === "group") {
        await this.#processGroup(row, key);
      } else {
        await this.#processChannel(row, key);
      }
    } catch (error) {
      const summary = shortError(error);
      await this.#reducers.serviceCompleteProvision({
        requestId: row.id,
        ok: false,
        resultRef: summary,
      });
      this.#log(`provision.failed id=${key} kind=${row.kind} error=${summary}`);
    }
    return true;
  }

  /** kind 'channel': Graph channel → room slot → upsert_channel → complete. */
  async #processChannel(row: ProvisionRow, key: string): Promise<void> {
    const { channelId, reused } = await createGraphChannel(this.#graph, row);
    const roomId = await assignRoomForChannel(this.#sql, row.teamId, channelId);
    await this.#reducers.upsertChannel({
      channelId,
      teamId: row.teamId,
      name: row.name,
      roomId,
      visibility: "standard",
      isEnabled: true,
    });
    await this.#reducers.serviceCompleteProvision({
      requestId: row.id,
      ok: true,
      resultRef: channelId,
    });
    this.#log(
      `provision.done id=${key} team=${row.teamId} channel=${channelId} room=${roomId}` +
        (reused ? " reused=1" : ""),
    );
  }

  /**
   * kind 'group': Graph M365 group → zone slot → upsert_team (enabled: an
   * admin explicitly founded it) → empty membership sync → complete.
   * v1 does NOT team-ify the group (no PUT /groups/{id}/team) — it starts as
   * a plain M365 group; teamification is a follow-up ceremony.
   */
  async #processGroup(row: ProvisionRow, key: string): Promise<void> {
    const { upsertTeam, syncTeamMembership } = this.#reducers;
    if (!upsertTeam || !syncTeamMembership) {
      // Fail BEFORE touching Graph — never create a group we cannot record.
      throw new Error("group provisioning needs upsertTeam + syncTeamMembership reducers");
    }
    const { groupId, mailNickname } = await createGraphGroup(this.#graph, row);
    const zoneId = await assignZoneForGroup(this.#sql, groupId);
    await upsertTeam({
      teamId: groupId,
      name: row.name,
      zoneId,
      isEnabled: true,
    });
    // A freshly app-created group has no members; seed the world's view.
    await syncTeamMembership({
      teamId: groupId,
      userIds: [],
      roles: [],
    });
    await this.#reducers.serviceCompleteProvision({
      requestId: row.id,
      ok: true,
      resultRef: groupId,
    });
    this.#log(
      `provision.done id=${key} group=${groupId} zone=${zoneId} nickname=${mailNickname}`,
    );
  }

  /** Process pending rows in request order; returns how many were handled. */
  async processQueue(rows: Iterable<ProvisionRow>): Promise<number> {
    const pending = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let handled = 0;
    for (const row of pending) {
      if (await this.processRequest(row)) handled++;
    }
    return handled;
  }
}

/** Await the initial service_queue subscription apply. */
function subscribeServiceQueue(
  conn: DbConnection,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`service_queue subscribe timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve();
      })
      .onError(() => {
        clearTimeout(timer);
        reject(new Error("service_queue subscribe error"));
      })
      .subscribe("SELECT * FROM service_queue");
  });
}

/**
 * One-shot mode (--provision-once): subscribe, drain the current queue, done.
 */
export async function runProvisionOnce(
  conn: DbConnection,
  worker: ProvisioningWorker,
  options: { timeoutMs?: number; log?: Logger } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  await subscribeServiceQueue(conn, options.timeoutMs ?? 15_000);
  const handled = await worker.processQueue([...conn.db.serviceQueue.iter()]);
  log(`provision.once handled=${handled}`);
  return handled;
}

/**
 * Serve mode: keep the subscription open; drain on apply and again whenever a
 * new pending row arrives (the worker's processed-set dedupes overlaps).
 */
export async function startProvisioning(
  conn: DbConnection,
  worker: ProvisioningWorker,
  options: { timeoutMs?: number; log?: Logger } = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const drain = () => {
    worker
      .processQueue([...conn.db.serviceQueue.iter()])
      .catch((error) => log(`provision.drain_error ${(error as Error).message}`));
  };
  conn.db.serviceQueue.onInsert(() => drain());
  await subscribeServiceQueue(conn, options.timeoutMs ?? 15_000);
  drain();
  log("provision.worker ready");
}
