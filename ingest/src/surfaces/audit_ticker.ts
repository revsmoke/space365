/**
 * P4 surface: directory audit ticker.
 *
 * Reads the most recent /auditLogs/directoryAudits entries
 * (AuditLog.Read.All) and aggregates counts by category per UTC hour into
 * `audit_stats_agg` via ingest_audit_stats. Only category + hour + count are
 * stored — no actors, no targets, no activity names.
 */
import {
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
  hourBucketMs,
  msToMicros,
  parseGraphUtcMs,
} from "./common";

export const AUDIT_INTERVAL_MS = 60 * 60_000;
export const AUDIT_TOP = 25;

export type DirectoryAudit = {
  id?: string;
  category?: string;
  activityDateTime?: string;
};

export type AuditBucket = {
  bucketStartMicros: bigint;
  category: string;
  count: number;
};

export function aggregateDirectoryAudits(audits: DirectoryAudit[]): AuditBucket[] {
  const buckets = new Map<string, AuditBucket>();
  for (const audit of audits) {
    const ms = parseGraphUtcMs(audit.activityDateTime);
    if (ms === null) continue;
    const bucketMs = hourBucketMs(ms);
    const category = audit.category || "uncategorized";
    const key = `${bucketMs}|${category}`;
    const existing = buckets.get(key);
    if (existing) existing.count++;
    else buckets.set(key, { bucketStartMicros: msToMicros(bucketMs), category, count: 1 });
  }
  return [...buckets.values()];
}

export type AuditResult = {
  auditsSeen: number;
  bucketsWritten: number;
  /** JSON-ready summary, also logged (useful with --dry-run). */
  summary: { bucketStartIso: string; category: string; count: number }[];
};

export async function runAuditTickerOnce(
  graph: GraphLike,
  reducers: Pick<SurfaceReducers, "ingestAuditStats">,
  options: SurfaceRunOptions = {},
): Promise<AuditResult> {
  const log = options.log ?? console.log;

  const audits = (await graph.getAll(
    `/auditLogs/directoryAudits?$top=${AUDIT_TOP}`,
    AUDIT_TOP,
  )) as DirectoryAudit[];

  const buckets = aggregateDirectoryAudits(audits);
  for (const bucket of buckets) {
    if (!options.dryRun) await reducers.ingestAuditStats(bucket);
  }

  const summary = buckets.map((bucket) => ({
    bucketStartIso: new Date(Number(bucket.bucketStartMicros / 1000n)).toISOString(),
    category: bucket.category,
    count: bucket.count,
  }));
  log(
    `audit.done audits=${audits.length} buckets=${buckets.length}` +
      (options.dryRun ? " dry_run=1" : "") +
      ` summary=${JSON.stringify(summary)}`,
  );
  return { auditsSeen: audits.length, bucketsWritten: buckets.length, summary };
}
