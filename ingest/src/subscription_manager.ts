/**
 * Graph change-notification subscription lifecycle (SPEC §8).
 *
 * Creates/renews subscriptions for channel messages of allowlisted (enabled)
 * team channels. This machine has no public HTTPS endpoint, so DRY_RUN is
 * the default (GRAPH_SUBSCRIPTIONS_DRY_RUN=1): we log what would be created
 * and record subscription_health rows with a 'dry_run' state so the admin
 * board reflects reality. The real code path is complete for prod.
 *
 * Channel-message subscriptions have a short Graph-enforced max lifetime,
 * so TTL defaults to 55 minutes and the renewal loop renews when less than
 * 20% of the TTL remains.
 */
import { GraphClient, GraphError } from "./graph_client";
import { stdbSql } from "./stdb_sql";
import type { StdbWriter } from "./stdb_writer";
import { hashId } from "../../shared/types/layout";

export type SubscriptionRecord = {
  id: string;
  resource: string;
  expiresAtMs: number;
  dryRun: boolean;
};

export type SubscriptionManagerOptions = {
  graph: GraphClient;
  writer: StdbWriter;
  notificationUrl: string;
  clientState: string;
  dryRun: boolean;
  ttlMinutes?: number;
  log?: (line: string) => void;
};

export function channelMessagesResource(teamId: string, channelId: string): string {
  return `teams/${teamId}/channels/${channelId}/messages`;
}

export function dryRunSubscriptionId(resource: string): string {
  return `dryrun-${hashId(resource).toString(16).padStart(8, "0")}`;
}

/** Renew when less than `fraction` (default 20%) of the ttl remains. */
export function needsRenewal(
  expiresAtMs: number,
  nowMs: number,
  ttlMs: number,
  fraction = 0.2,
): boolean {
  return expiresAtMs - nowMs < ttlMs * fraction;
}

export class SubscriptionManager {
  #options: Required<Pick<SubscriptionManagerOptions, "ttlMinutes" | "log">> &
    SubscriptionManagerOptions;
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SubscriptionManagerOptions) {
    this.#options = {
      ttlMinutes: 55,
      log: console.log,
      ...options,
    };
  }

  get knownSubscriptionIds(): Set<string> {
    return new Set(this.subscriptions.keys());
  }

  #ttlMs(): number {
    return this.#options.ttlMinutes * 60 * 1000;
  }

  /**
   * Channels of enabled teams = the subscription allowlist. Keyed off the
   * TEAM toggle (not the channel one) because channels currently sync
   * disabled as a module-bug workaround — see full_sync.ts.
   */
  async loadAllowlist(): Promise<{ teamId: string; channelId: string }[]> {
    const enabledTeams = new Set(
      (await stdbSql("SELECT team_id FROM team WHERE is_enabled = true")).map(
        (row) => row[0],
      ),
    );
    const channels = await stdbSql("SELECT channel_id, team_id FROM channel");
    return channels
      .filter(([, teamId]) => enabledTeams.has(teamId))
      .map(([channelId, teamId]) => ({ teamId, channelId }));
  }

  async ensureSubscriptions(): Promise<SubscriptionRecord[]> {
    const allowlist = await this.loadAllowlist();
    const created: SubscriptionRecord[] = [];
    for (const { teamId, channelId } of allowlist) {
      const resource = channelMessagesResource(teamId, channelId);
      const existing = [...this.subscriptions.values()].find(
        (record) => record.resource === resource,
      );
      if (existing) continue;
      created.push(await this.#create(resource));
    }
    return created;
  }

  async #create(resource: string): Promise<SubscriptionRecord> {
    const { log, writer, dryRun } = this.#options;
    const expiresAtMs = Date.now() + this.#ttlMs();

    if (dryRun) {
      const record: SubscriptionRecord = {
        id: dryRunSubscriptionId(resource),
        resource,
        expiresAtMs,
        dryRun: true,
      };
      this.subscriptions.set(record.id, record);
      log(
        `subscription.dry_run would_create resource=${resource} ` +
          `notificationUrl=${this.#options.notificationUrl} ttl_min=${this.#options.ttlMinutes}`,
      );
      await writer.updateSubscriptionHealth({
        graphSubscriptionId: record.id,
        resource,
        expiresAtMicros: BigInt(expiresAtMs) * 1000n,
        state: "dry_run",
      });
      return record;
    }

    const response = (await this.#options.graph.post("/subscriptions", {
      changeType: "created,updated,deleted",
      notificationUrl: this.#options.notificationUrl,
      resource,
      expirationDateTime: new Date(expiresAtMs).toISOString(),
      clientState: this.#options.clientState,
    })) as { id?: string; expirationDateTime?: string };

    if (!response.id) throw new Error(`subscription create returned no id for ${resource}`);
    const record: SubscriptionRecord = {
      id: response.id,
      resource,
      expiresAtMs: response.expirationDateTime
        ? Date.parse(response.expirationDateTime)
        : expiresAtMs,
      dryRun: false,
    };
    this.subscriptions.set(record.id, record);
    log(`subscription.created id=${record.id} resource=${resource}`);
    await writer.updateSubscriptionHealth({
      graphSubscriptionId: record.id,
      resource,
      expiresAtMicros: BigInt(record.expiresAtMs) * 1000n,
      state: "active",
    });
    return record;
  }

  async renewDue(nowMs: number = Date.now()): Promise<number> {
    const { log, writer, dryRun } = this.#options;
    let renewed = 0;
    for (const record of this.subscriptions.values()) {
      if (!needsRenewal(record.expiresAtMs, nowMs, this.#ttlMs())) continue;
      const nextExpiryMs = nowMs + this.#ttlMs();

      if (dryRun) {
        record.expiresAtMs = nextExpiryMs;
        log(`subscription.dry_run would_renew id=${record.id}`);
        await writer.updateSubscriptionHealth({
          graphSubscriptionId: record.id,
          resource: record.resource,
          expiresAtMicros: BigInt(nextExpiryMs) * 1000n,
          state: "dry_run",
        });
        renewed++;
        continue;
      }

      try {
        await this.#options.graph.patch(`/subscriptions/${record.id}`, {
          expirationDateTime: new Date(nextExpiryMs).toISOString(),
        });
        record.expiresAtMs = nextExpiryMs;
        log(`subscription.renewed id=${record.id}`);
        await writer.updateSubscriptionHealth({
          graphSubscriptionId: record.id,
          resource: record.resource,
          expiresAtMicros: BigInt(nextExpiryMs) * 1000n,
          state: "active",
        });
        renewed++;
      } catch (error) {
        const status = error instanceof GraphError ? error.status : 0;
        log(`subscription.renew_failed id=${record.id} status=${status}`);
        await writer.updateSubscriptionHealth({
          graphSubscriptionId: record.id,
          resource: record.resource,
          expiresAtMicros: BigInt(record.expiresAtMs) * 1000n,
          state: "failed",
        });
        if (status === 404) this.subscriptions.delete(record.id);
      }
    }
    return renewed;
  }

  async listRemote(): Promise<unknown[]> {
    if (this.#options.dryRun) return [...this.subscriptions.values()];
    const page = (await this.#options.graph.get("/subscriptions")) as {
      value?: unknown[];
    };
    return page.value ?? [];
  }

  startRenewalLoop(intervalMs = 60_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.renewDue().catch((error) =>
        this.#options.log(`subscription.loop_error ${(error as Error).message}`),
      );
    }, intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
