/**
 * SpacetimeDB writer for the ingest service (SPEC §9).
 *
 * Connects over WebSocket with the generated TS bindings and calls ingest
 * reducers. The connection token is persisted to ingest/.stdb-token so the
 * service identity is stable across restarts; that identity gets the
 * 'service' role via scripts/setup-ingest-identity.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Identity } from "spacetimedb";
import { DbConnection } from "../../shared/bindings";

export const DEFAULT_STDB_URI = "ws://127.0.0.1:3000";
export const DEFAULT_STDB_DATABASE = "space365";
export const TOKEN_FILE = new URL("../.stdb-token", import.meta.url).pathname;

export type StdbConnection = {
  conn: DbConnection;
  identity: Identity;
  identityHex: string;
  token: string;
  disconnect: () => void;
};

export type ConnectOptions = {
  uri?: string;
  databaseName?: string;
  tokenFile?: string;
  timeoutMs?: number;
};

export async function connectStdb(
  options: ConnectOptions = {},
): Promise<StdbConnection> {
  const uri = options.uri ?? process.env.STDB_URI ?? DEFAULT_STDB_URI;
  const databaseName =
    options.databaseName ?? process.env.STDB_DATABASE ?? DEFAULT_STDB_DATABASE;
  const tokenFile = options.tokenFile ?? TOKEN_FILE;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const savedToken = existsSync(tokenFile)
    ? readFileSync(tokenFile, "utf8").trim()
    : undefined;

  return await new Promise<StdbConnection>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SpacetimeDB connect timeout after ${timeoutMs}ms (${uri})`)),
      timeoutMs,
    );

    let builder = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(databaseName)
      .onConnectError((_ctx: unknown, error?: Error) => {
        clearTimeout(timer);
        reject(error ?? new Error("SpacetimeDB connect error"));
      })
      .onConnect((conn: DbConnection, identity: Identity, token: string) => {
        clearTimeout(timer);
        if (token && token !== savedToken) {
          writeFileSync(tokenFile, token, { mode: 0o600 });
        }
        resolve({
          conn,
          identity,
          identityHex: normalizeIdentityHex(identity.toHexString()),
          token,
          disconnect: () => conn.disconnect(),
        });
      });

    if (savedToken) {
      builder = builder.withToken(savedToken);
    }

    builder.build();
  });
}

export function normalizeIdentityHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/**
 * Typed ingest facade over the reducer accessor map. Every method is one
 * atomic reducer transaction; the returned promise settles on server ack.
 */
export class StdbWriter {
  #conn: DbConnection;

  constructor(conn: DbConnection) {
    this.#conn = conn;
  }

  get conn(): DbConnection {
    return this.#conn;
  }

  upsertUser(args: {
    userId: string;
    displayName: string;
    dept: string;
    title: string;
    isActive: boolean;
  }): Promise<void> {
    return this.#conn.reducers.upsertUser(args);
  }

  upsertTeam(args: {
    teamId: string;
    name: string;
    zoneId: number;
    isEnabled: boolean;
  }): Promise<void> {
    return this.#conn.reducers.upsertTeam(args);
  }

  upsertChannel(args: {
    channelId: string;
    teamId: string;
    name: string;
    roomId: number;
    visibility: string;
    isEnabled: boolean;
  }): Promise<void> {
    return this.#conn.reducers.upsertChannel(args);
  }

  syncTeamMembership(args: {
    teamId: string;
    userIds: string[];
    roles: string[];
  }): Promise<void> {
    return this.#conn.reducers.syncTeamMembership(args);
  }

  syncChannelMembership(args: {
    channelId: string;
    userIds: string[];
    roles: string[];
  }): Promise<void> {
    return this.#conn.reducers.syncChannelMembership(args);
  }

  ingestPresence(args: {
    userId: string;
    availability: string;
    activity: string;
    source: string;
  }): Promise<void> {
    return this.#conn.reducers.ingestPresence(args);
  }

  ingestChannelMessageEvent(args: {
    eventId: string;
    eventType: string;
    occurredAtMicros: bigint;
    teamId: string;
    channelId: string;
    actorUserId: string | undefined;
    messageId: string | undefined;
    threadId: string | undefined;
  }): Promise<void> {
    return this.#conn.reducers.ingestChannelMessageEvent(args);
  }

  updateSubscriptionHealth(args: {
    graphSubscriptionId: string;
    resource: string;
    expiresAtMicros: bigint;
    state: string;
  }): Promise<void> {
    return this.#conn.reducers.updateSubscriptionHealth(args);
  }

  setGraphCursor(args: { resource: string; deltaLink: string }): Promise<void> {
    return this.#conn.reducers.setGraphCursor(args);
  }
}
