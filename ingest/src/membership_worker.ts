/**
 * Membership worker: executes self-service join/leave ceremonies via app-only
 * Graph calls (GroupMember.ReadWrite.All), mirroring the provisioning worker's
 * command-queue pattern.
 *
 * Users file requests for THEMSELVES through the module's request_membership
 * reducer (policy-gated by allow_group_join); pending member_request rows
 * surface to this service through the service_member_queue view. For each row
 * we add/remove the member on the M365 group, re-sync that group's membership
 * into SpacetimeDB so the world updates immediately, and report the outcome
 * back through service_complete_membership. Completed rows leave the view, so
 * the queue is self-draining; an in-memory set additionally guarantees each
 * request is processed at most once per run.
 */
import type { DbConnection } from "../../shared/bindings";
import { GraphError } from "./graph_client";
import { shortError } from "./provisioning";
import type { StdbWriter } from "./stdb_writer";
import { memberUserIds, type GraphDirectoryObject } from "./surfaces/groups_sync";
import type { Logger } from "./surfaces/common";

/** Structural Graph subset the worker needs (tests stub this). */
export type GraphMembershipClient = {
  post(pathOrUrl: string, body: unknown): Promise<unknown>;
  delete(pathOrUrl: string): Promise<void>;
  getAll(path: string, limit?: number): Promise<Record<string, unknown>[]>;
};

/** The service_member_queue row fields the worker consumes (camelCase bindings). */
export type MemberRow = {
  id: bigint;
  teamId: string;
  userId: string;
  action: string; // 'join' | 'leave'
};

/** Reducer calls the worker needs. */
export type MembershipReducers = {
  syncTeamMembership(args: {
    teamId: string;
    userIds: string[];
    roles: string[];
  }): Promise<void>;
  serviceCompleteMembership(args: {
    requestId: bigint;
    ok: boolean;
    resultRef: string;
  }): Promise<void>;
};

export function membershipReducers(writer: StdbWriter): MembershipReducers {
  const r = writer.conn.reducers;
  return {
    syncTeamMembership: (args) => r.syncTeamMembership(args),
    serviceCompleteMembership: (args) => r.serviceCompleteMembership(args),
  };
}

/** $ref body for POST /groups/{id}/members/$ref. */
export function memberRefPayload(userId: string): { "@odata.id": string } {
  return {
    "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
  };
}

/**
 * Join tolerance: Graph answers 400 with "One or more added object references
 * already exist" when the user is already a member — the desired state holds,
 * so treat it as success.
 */
export function isAlreadyMember(error: unknown): boolean {
  if (!(error instanceof GraphError)) return false;
  return error.status === 400 && /already exist/i.test(error.message);
}

/**
 * Leave tolerance: 404 means the membership link (or its target) is already
 * gone — the desired state holds, so treat it as success.
 */
export function isNotMember(error: unknown): boolean {
  return error instanceof GraphError && error.status === 404;
}

/**
 * Execute one join/leave against Graph. Resolves on success (including the
 * tolerated already-member/not-member cases); throws on real failures.
 */
export async function executeMembershipAction(
  graph: Pick<GraphMembershipClient, "post" | "delete">,
  row: Pick<MemberRow, "teamId" | "userId" | "action">,
): Promise<{ noop: boolean }> {
  if (row.action === "join") {
    try {
      await graph.post(`/groups/${row.teamId}/members/$ref`, memberRefPayload(row.userId));
      return { noop: false };
    } catch (error) {
      if (isAlreadyMember(error)) return { noop: true };
      throw error;
    }
  }
  if (row.action === "leave") {
    try {
      await graph.delete(`/groups/${row.teamId}/members/${row.userId}/$ref`);
      return { noop: false };
    } catch (error) {
      if (isNotMember(error)) return { noop: true };
      throw error;
    }
  }
  throw new Error(`unsupported action: ${row.action}`);
}

/**
 * Re-sync one group's membership into STDB right after a successful ceremony
 * so the world updates immediately (the hourly groups_sync would eventually
 * catch up anyway). Returns false when the fetch or write failed — callers
 * treat that as non-fatal because the Graph-side action already succeeded and
 * sync_team_membership has a known panic bug (see groups_sync.ts).
 */
export async function resyncGroupMembership(
  graph: Pick<GraphMembershipClient, "getAll">,
  reducers: Pick<MembershipReducers, "syncTeamMembership">,
  teamId: string,
  log: Logger,
): Promise<boolean> {
  try {
    const members = (await graph.getAll(
      `/groups/${teamId}/members?$select=id`,
    )) as GraphDirectoryObject[];
    const userIds = memberUserIds(members);
    await reducers.syncTeamMembership({
      teamId,
      userIds,
      roles: userIds.map(() => "member"),
    });
    return true;
  } catch (error) {
    log(`membership.resync_failed group=${teamId} error=${shortError(error)}`);
    return false;
  }
}

export type MembershipWorkerOptions = {
  graph: GraphMembershipClient;
  reducers: MembershipReducers;
  log?: Logger;
};

export class MembershipWorker {
  #graph: GraphMembershipClient;
  #reducers: MembershipReducers;
  #log: Logger;
  /** Request ids handled this run — each request is processed exactly once. */
  #processed = new Set<string>();

  constructor(options: MembershipWorkerOptions) {
    this.#graph = options.graph;
    this.#reducers = options.reducers;
    this.#log = options.log ?? console.log;
  }

  /**
   * Handle one pending request. Returns false when the request was already
   * processed this run (debounce). Every accepted request terminates in a
   * service_complete_membership call — success or failure — so it leaves the
   * pending view either way.
   */
  async processRequest(row: MemberRow): Promise<boolean> {
    const key = row.id.toString();
    if (this.#processed.has(key)) return false;
    this.#processed.add(key);

    if (row.action !== "join" && row.action !== "leave") {
      await this.#reducers.serviceCompleteMembership({
        requestId: row.id,
        ok: false,
        resultRef: `unsupported action: ${row.action}`,
      });
      this.#log(`membership.unsupported id=${key} action=${row.action}`);
      return true;
    }

    try {
      const { noop } = await executeMembershipAction(this.#graph, row);
      const resynced = await resyncGroupMembership(
        this.#graph,
        this.#reducers,
        row.teamId,
        this.#log,
      );
      await this.#reducers.serviceCompleteMembership({
        requestId: row.id,
        ok: true,
        resultRef: row.action,
      });
      this.#log(
        `membership.done id=${key} action=${row.action} team=${row.teamId}` +
          (noop ? " noop=1" : "") +
          (resynced ? "" : " resync=failed"),
      );
    } catch (error) {
      const summary = shortError(error);
      await this.#reducers.serviceCompleteMembership({
        requestId: row.id,
        ok: false,
        resultRef: summary,
      });
      this.#log(`membership.failed id=${key} action=${row.action} error=${summary}`);
    }
    return true;
  }

  /** Process pending rows in request order; returns how many were handled. */
  async processQueue(rows: Iterable<MemberRow>): Promise<number> {
    const pending = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let handled = 0;
    for (const row of pending) {
      if (await this.processRequest(row)) handled++;
    }
    return handled;
  }
}

/** Await the initial service_member_queue subscription apply. */
function subscribeMemberQueue(conn: DbConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`service_member_queue subscribe timeout after ${timeoutMs}ms`)),
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
        reject(new Error("service_member_queue subscribe error"));
      })
      .subscribe("SELECT * FROM service_member_queue");
  });
}

/**
 * One-shot mode (--ceremonies-once): subscribe, drain the current queue, done.
 */
export async function runMembershipOnce(
  conn: DbConnection,
  worker: MembershipWorker,
  options: { timeoutMs?: number; log?: Logger } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  await subscribeMemberQueue(conn, options.timeoutMs ?? 15_000);
  const handled = await worker.processQueue([...conn.db.serviceMemberQueue.iter()]);
  log(`membership.once handled=${handled}`);
  return handled;
}

/**
 * Serve mode: keep the subscription open; drain on apply and again whenever a
 * new pending row arrives (the worker's processed-set dedupes overlaps).
 */
export async function startMembershipWorker(
  conn: DbConnection,
  worker: MembershipWorker,
  options: { timeoutMs?: number; log?: Logger } = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const drain = () => {
    worker
      .processQueue([...conn.db.serviceMemberQueue.iter()])
      .catch((error) => log(`membership.drain_error ${(error as Error).message}`));
  };
  conn.db.serviceMemberQueue.onInsert(() => drain());
  await subscribeMemberQueue(conn, options.timeoutMs ?? 15_000);
  drain();
  log("membership.worker ready");
}
