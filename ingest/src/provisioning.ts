/**
 * Provisioning worker: executes admin-requested world actions via app-only
 * Graph calls (SPEC command-queue pattern).
 *
 * Admins file requests through the module's admin_request_channel reducer;
 * pending provision_request rows surface to this service through the
 * service_queue view. For each 'channel' request we create the Teams channel
 * (Channel.Create app role), assign a deterministic room slot from the shared
 * layout, upsert the channel row, and report the outcome back through
 * service_complete_provision. Completed rows leave the view, so the queue is
 * self-draining; an in-memory set additionally guarantees each request is
 * processed at most once per run.
 */
import { assignRoomSlot } from "../../shared/types/layout";
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

    if (row.kind !== "channel") {
      await this.#reducers.serviceCompleteProvision({
        requestId: row.id,
        ok: false,
        resultRef: `unsupported kind: ${row.kind}`,
      });
      this.#log(`provision.unsupported id=${key} kind=${row.kind}`);
      return true;
    }

    try {
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
    } catch (error) {
      const summary = shortError(error);
      await this.#reducers.serviceCompleteProvision({
        requestId: row.id,
        ok: false,
        resultRef: summary,
      });
      this.#log(`provision.failed id=${key} error=${summary}`);
    }
    return true;
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
