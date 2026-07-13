/**
 * P4 surface: anonymous call volume stats from Graph callRecords.
 *
 * Lists /communications/callRecords for the last 7 days ($filter on
 * startDateTime; falls back to $top paging + client-side cutoff when the
 * filter is rejected) and aggregates into hourly buckets keyed by
 * modality '<audio|video|...>_<peer|group>'. Only counts and minutes are
 * written — NO participant identities are read, kept, or stored.
 */
import { GraphError } from "../graph_client";
import {
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
  hourBucketMs,
  msToMicros,
  parseGraphUtcMs,
} from "./common";

export const CALL_STATS_INTERVAL_MS = 60 * 60_000;
export const CALL_STATS_LOOKBACK_DAYS = 7;
/** Safety cap when paging without a server-side filter. */
export const CALL_STATS_FALLBACK_LIMIT = 500;

export type CallRecord = {
  id?: string;
  type?: string; // 'peerToPeer' | 'groupCall'
  modalities?: string[];
  startDateTime?: string;
  endDateTime?: string;
};

/** Primary modality: video-ish beats audio beats whatever else is listed. */
export function primaryModality(modalities?: string[]): string {
  if (!Array.isArray(modalities) || modalities.length === 0) return "unknown";
  if (modalities.includes("video") || modalities.includes("videoBasedScreenSharing")) {
    return "video";
  }
  if (modalities.includes("audio")) return "audio";
  return modalities[0]!;
}

export function callModalityKey(record: CallRecord): string {
  const scope = record.type === "groupCall" ? "group" : "peer";
  return `${primaryModality(record.modalities)}_${scope}`;
}

export type CallBucket = {
  bucketStartMicros: bigint;
  modality: string;
  callCount: number;
  totalMinutes: number;
};

export function aggregateCallRecords(records: CallRecord[]): CallBucket[] {
  const buckets = new Map<string, CallBucket>();
  for (const record of records) {
    const startMs = parseGraphUtcMs(record.startDateTime);
    if (startMs === null) continue;
    const endMs = parseGraphUtcMs(record.endDateTime);
    const minutes = endMs !== null && endMs > startMs ? (endMs - startMs) / 60_000 : 0;
    const bucketMs = hourBucketMs(startMs);
    const modality = callModalityKey(record);
    const key = `${bucketMs}|${modality}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.callCount++;
      existing.totalMinutes += minutes;
    } else {
      buckets.set(key, {
        bucketStartMicros: msToMicros(bucketMs),
        modality,
        callCount: 1,
        totalMinutes: minutes,
      });
    }
  }
  // f32 target: keep the float small and stable.
  for (const bucket of buckets.values()) {
    bucket.totalMinutes = Math.round(bucket.totalMinutes * 100) / 100;
  }
  return [...buckets.values()];
}

export type CallStatsResult = {
  filterSupported: boolean;
  recordsSeen: number;
  bucketsWritten: number;
};

export async function runCallStatsOnce(
  graph: GraphLike,
  reducers: Pick<SurfaceReducers, "ingestCallStats">,
  options: SurfaceRunOptions = {},
): Promise<CallStatsResult> {
  const log = options.log ?? console.log;
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - CALL_STATS_LOOKBACK_DAYS * 24 * 3_600_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let records: CallRecord[];
  let filterSupported = true;
  try {
    records = (await graph.getAll(
      `/communications/callRecords?$filter=startDateTime ge ${cutoffIso}`,
    )) as CallRecord[];
  } catch (error) {
    if (error instanceof GraphError && error.status === 400) {
      // Server rejected the filter: page unfiltered and cut off client-side.
      filterSupported = false;
      log(`call_stats.filter_unsupported code=${error.code} — falling back to $top paging`);
      const paged = (await graph.getAll(
        "/communications/callRecords?$top=100",
        CALL_STATS_FALLBACK_LIMIT,
      )) as CallRecord[];
      records = paged.filter((record) => {
        const startMs = parseGraphUtcMs(record.startDateTime);
        return startMs !== null && startMs >= cutoffMs;
      });
    } else {
      throw error;
    }
  }

  const buckets = aggregateCallRecords(records);
  for (const bucket of buckets) {
    if (!options.dryRun) await reducers.ingestCallStats(bucket);
  }

  log(
    `call_stats.done records=${records.length} buckets=${buckets.length} ` +
      `filter_supported=${filterSupported}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return { filterSupported, recordsSeen: records.length, bucketsWritten: buckets.length };
}
