/**
 * Parity test harness: connects N clients (each with a distinct identity) to the
 * dedicated `space365test` database, awaits subscription sync, calls reducers,
 * reads client-cache view state, and runs server-side SQL assertions via the CLI.
 *
 * NEVER points at the dev db `space365`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import type { Identity } from "spacetimedb";
import { DbConnection, tables } from "../shared/bindings/index.ts";

export { tables };
export type { DbConnection };

export const HOST_URI = "ws://127.0.0.1:3000";
export const DB_NAME = "space365test";

/**
 * Cached tokens for the shared admin/service identities. The whole suite shares
 * one admin and one service identity (bootstrap only works once per fresh db);
 * parity/publish.ts wipes this file whenever the db is re-published.
 */
export const TOKEN_CACHE_FILE = join(tmpdir(), "space365test-parity-tokens.json");

export interface Conn {
  conn: DbConnection;
  identity: Identity;
  token: string;
}

function readTokenCache(): Record<string, string> {
  try {
    if (existsSync(TOKEN_CACHE_FILE)) {
      return JSON.parse(readFileSync(TOKEN_CACHE_FILE, "utf8"));
    }
  } catch {
    /* corrupted cache -> re-bootstrap */
  }
  return {};
}

function writeTokenCache(cache: Record<string, string>): void {
  writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache));
}

export function clearTokenCache(): void {
  rmSync(TOKEN_CACHE_FILE, { force: true });
}

/** Poll until `cond()` is truthy or the timeout elapses. */
export async function waitFor(
  cond: () => boolean,
  timeoutMs = 3000,
  label = "condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await Bun.sleep(25);
  }
  if (cond()) return;
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

/** Assert a condition stays false for `holdMs` (used for "never leaks" checks). */
export async function assertNever(
  cond: () => boolean,
  holdMs = 750,
  label = "condition"
): Promise<void> {
  const deadline = Date.now() + holdMs;
  while (Date.now() < deadline) {
    if (cond()) throw new Error(`assertNever violated: ${label}`);
    await Bun.sleep(25);
  }
}

/**
 * Per-test-file harness. Tracks every connection it opens so `dispose()` in
 * afterAll can close them and let the bun test process exit cleanly.
 */
export class Harness {
  #conns: Conn[] = [];
  #admin: Promise<Conn> | null = null;
  #service: Promise<Conn> | null = null;

  /**
   * Open a connection. Without a token the server mints a fresh identity, so
   * every logical test user gets its own anonymous connection.
   */
  connect(token?: string): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect timeout (5s)")), 5000);
      DbConnection.builder()
        .withUri(HOST_URI)
        .withDatabaseName(DB_NAME)
        .withToken(token)
        .onConnect((conn, identity, tok) => {
          clearTimeout(timer);
          const c: Conn = { conn: conn as DbConnection, identity, token: tok };
          this.#conns.push(c);
          resolve(c);
        })
        .onConnectError((_ctx, err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        })
        .build();
    });
  }

  /**
   * The shared admin connection. On a fresh db the FIRST grant_role call
   * bootstraps the caller as admin; the token is cached so every other test
   * file reconnects as the same admin identity.
   */
  admin(): Promise<Conn> {
    if (!this.#admin) {
      this.#admin = (async () => {
        const cache = readTokenCache();
        if (cache.admin) return await this.connect(cache.admin);
        const c = await this.connect();
        await c.conn.reducers.grantRole({ target: c.identity, role: "admin" });
        writeTokenCache({ ...readTokenCache(), admin: c.token });
        return c;
      })();
    }
    return this.#admin;
  }

  /** A shared service-role connection (granted by the admin). */
  service(): Promise<Conn> {
    if (!this.#service) {
      this.#service = (async () => {
        const cache = readTokenCache();
        if (cache.service) return await this.connect(cache.service);
        const adm = await this.admin();
        const c = await this.connect();
        await adm.conn.reducers.grantRole({ target: c.identity, role: "service" });
        writeTokenCache({ ...readTokenCache(), service: c.token });
        return c;
      })();
    }
    return this.#service;
  }

  /** Subscribe `conn` to the given typed table/view queries and await initial sync. */
  subscribe(conn: DbConnection, queries: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("subscription apply timeout (5s)")),
        5000
      );
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          clearTimeout(timer);
          resolve();
        })
        .onError((ctx: any) => {
          clearTimeout(timer);
          reject(new Error(`subscription error: ${ctx?.event?.message ?? "unknown"}`));
        })
        .subscribe(queries as any);
    });
  }

  /** Close every connection this harness opened. Call from afterAll. */
  dispose(): void {
    for (const c of this.#conns) {
      try {
        c.conn.disconnect();
      } catch {
        /* already closed */
      }
    }
    this.#conns = [];
    this.#admin = null;
    this.#service = null;
  }
}

// ---------------------------------------------------------------------------
// Server-side SQL assertions (shells out to the spacetime CLI; the CLI login
// owns the db, so private tables are readable).
// ---------------------------------------------------------------------------

/** Run a SQL query against space365test; returns data rows as raw " a | b " strings. */
export function sql(query: string): string[] {
  const proc = Bun.spawnSync(
    ["spacetime", "sql", DB_NAME, query, "--server", "local"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const out = proc.stdout.toString();
  if (proc.exitCode !== 0) {
    throw new Error(`spacetime sql failed: ${proc.stderr.toString()}\n${out}`);
  }
  const lines = out.split("\n");
  // Header/data separator looks like "------+------"; find the first such line.
  const sepIdx = lines.findIndex((l) => /^[-+\s]+$/.test(l) && l.includes("--"));
  if (sepIdx === -1) return [];
  return lines
    .slice(sepIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Split one raw sql() row into trimmed, unquoted cell values. */
export function cells(row: string): string[] {
  return row.split("|").map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
}

// ---------------------------------------------------------------------------
// Misc shared helpers
// ---------------------------------------------------------------------------

export const MICROS_PER_MIN = 60_000_000n;
export const MICROS_PER_HOUR = 3_600_000_000n;

/**
 * Per-run nonce for ids that must not collide with a previous run's rows
 * (event_id is a global primary key with idempotent dedupe, so re-running the
 * suite against an already-populated db would otherwise silently no-op).
 */
export const RUN_ID = Date.now().toString(36);

/** Current time in micros since Unix epoch, as bigint (module time base). */
export function nowMicros(): bigint {
  return BigInt(Date.now()) * 1000n;
}

/** Deterministic shuffle so replay tests are reproducible. */
export function seededShuffle<T>(arr: T[], seed = 42): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
