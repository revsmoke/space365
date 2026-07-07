/**
 * Groups batch surface: group drive (SharePoint document library) stats +
 * the 15 most recent files per enabled team/group.
 *
 * For each ENABLED team: /groups/{id}/drive/root/children (top 50, metadata
 * only — name, webUrl, lastModifiedDateTime; never content, never download).
 * Teams-backed groups keep their files inside CHANNEL FOLDERS at the drive
 * root, so we also descend ONE level: the children of each root folder
 * (capped at FOLDER_DESCENT_CAP folders per team, $top=50 each).
 *
 * Stats semantics (documented per task):
 *   - file_count counts FILES ONLY — files at the root plus files one level
 *     deep. Folders themselves are NOT counted (cleaner semantic now that we
 *     descend into them); deeper subfolders are neither entered nor counted.
 *   - recent_count_7d / last_file_at use lastModifiedDateTime across that
 *     same file set.
 *   - upsert_library_file rows are the 15 most recently modified files
 *     across root + subfolders; prune_library_files makes the row set a
 *     full replacement per team.
 *
 * Groups without a provisioned drive (security-ish groups, never-touched
 * SharePoint) return 404 — skipped gracefully, existing rows untouched.
 * Per-folder 404/403 (deleted / permission-trimmed folders) skips just that
 * folder, never the team.
 */
import { GraphError } from "../graph_client";
import { stdbSql } from "../stdb_sql";
import {
  msToMicros,
  parseGraphUtcMs,
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
} from "./common";

export const LIBRARIES_INTERVAL_MS = 15 * 60_000;
export const LIBRARY_ITEMS_TOP = 50;
export const LIBRARY_RECENT_FILES = 15;
export const FOLDER_DESCENT_CAP = 12;
export const RECENT_WINDOW_MS = 7 * 24 * 3_600_000;

const ITEM_SELECT = "$select=id,name,webUrl,lastModifiedDateTime,folder,file";

export type DriveItem = {
  id?: string;
  name?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
};

/** Partition a children listing into files and folders (folder facet wins). */
export function splitDriveItems(items: DriveItem[]): {
  files: DriveItem[];
  folders: DriveItem[];
} {
  const files: DriveItem[] = [];
  const folders: DriveItem[] = [];
  for (const item of items) {
    (item.folder ? folders : files).push(item);
  }
  return { files, folders };
}

export type LibraryStats = {
  fileCount: number; // FILES only (root + one level deep); folders excluded
  recentCount7d: number;
  lastFileAtMs: number; // 0 when no files / no parseable timestamps
};

/** Stats over a files-only set (callers exclude folders via splitDriveItems). */
export function computeLibraryStats(files: DriveItem[], nowMs: number): LibraryStats {
  let recentCount7d = 0;
  let lastFileAtMs = 0;
  for (const file of files) {
    const modifiedMs = parseGraphUtcMs(file.lastModifiedDateTime);
    if (modifiedMs === null) continue;
    if (nowMs - modifiedMs <= RECENT_WINDOW_MS) recentCount7d++;
    if (modifiedMs > lastFileAtMs) lastFileAtMs = modifiedMs;
  }
  return { fileCount: files.length, recentCount7d, lastFileAtMs };
}

export type LibraryFileRow = {
  fileId: string;
  teamId: string;
  name: string;
  webUrl: string;
  modifiedAt: bigint; // micros
};

/** The N most recently modified FILES (folder facet excluded), id required. */
export function pickRecentFiles(
  items: DriveItem[],
  teamId: string,
  limit: number = LIBRARY_RECENT_FILES,
): LibraryFileRow[] {
  return items
    .filter((item) => item.id && !item.folder)
    .map((item) => ({
      item,
      modifiedMs: parseGraphUtcMs(item.lastModifiedDateTime) ?? 0,
    }))
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .slice(0, limit)
    .map(({ item, modifiedMs }) => ({
      fileId: item.id!,
      teamId,
      name: item.name ?? "",
      webUrl: item.webUrl ?? "",
      modifiedAt: msToMicros(modifiedMs),
    }));
}

export type LibrariesResult = {
  teamsPolled: number;
  teamsSkipped: number; // no drive (404) or inaccessible (400/403)
  foldersDescended: number;
  foldersSkipped: number; // per-folder 400/403/404
  filesSeen: number;
  filesWritten: number;
};

export async function runLibrariesOnce(
  graph: GraphLike,
  reducers: Pick<
    SurfaceReducers,
    "upsertZoneLibrary" | "upsertLibraryFile" | "pruneLibraryFiles"
  >,
  options: SurfaceRunOptions = {},
): Promise<LibrariesResult> {
  const log = options.log ?? console.log;
  const sql = options.sql ?? stdbSql;
  const nowMs = options.nowMs ?? Date.now();

  const teamIds = (await sql("SELECT team_id FROM team WHERE is_enabled = true"))
    .map((row) => row[0])
    .filter(Boolean);

  const result: LibrariesResult = {
    teamsPolled: 0,
    teamsSkipped: 0,
    foldersDescended: 0,
    foldersSkipped: 0,
    filesSeen: 0,
    filesWritten: 0,
  };

  for (const teamId of teamIds) {
    let rootItems: DriveItem[];
    try {
      rootItems = (await graph.getAll(
        `/groups/${teamId}/drive/root/children?$top=${LIBRARY_ITEMS_TOP}&${ITEM_SELECT}`,
        LIBRARY_ITEMS_TOP,
      )) as DriveItem[];
    } catch (error) {
      // 404: group has no provisioned drive (security group / SharePoint
      // never touched). 400: non-GUID dev seed ids. 403: access denied.
      // All skip without wiping existing rows.
      if (
        error instanceof GraphError &&
        (error.status === 400 || error.status === 403 || error.status === 404)
      ) {
        result.teamsSkipped++;
        log(`libraries.skip team=${teamId} status=${error.status} code=${error.code}`);
        continue;
      }
      throw error;
    }
    result.teamsPolled++;

    // One level of descent: Teams channel folders at the drive root hold the
    // actual files in this tenant. Deeper nesting is out of scope.
    const { files: rootFiles, folders } = splitDriveItems(rootItems);
    const files: DriveItem[] = [...rootFiles];
    let foldersDescended = 0;
    for (const folder of folders.slice(0, FOLDER_DESCENT_CAP)) {
      if (!folder.id) continue;
      let children: DriveItem[];
      try {
        children = (await graph.getAll(
          `/groups/${teamId}/drive/items/${folder.id}/children?$top=${LIBRARY_ITEMS_TOP}&${ITEM_SELECT}`,
          LIBRARY_ITEMS_TOP,
        )) as DriveItem[];
      } catch (error) {
        if (
          error instanceof GraphError &&
          (error.status === 400 || error.status === 403 || error.status === 404)
        ) {
          result.foldersSkipped++;
          log(
            `libraries.folder.skip team=${teamId} folder=${folder.id} status=${error.status}`,
          );
          continue;
        }
        throw error;
      }
      foldersDescended++;
      files.push(...splitDriveItems(children).files);
    }
    result.foldersDescended += foldersDescended;
    result.filesSeen += files.length;

    const stats = computeLibraryStats(files, nowMs);
    if (!options.dryRun) {
      await reducers.upsertZoneLibrary({
        teamId,
        fileCount: stats.fileCount,
        recentCount7D: stats.recentCount7d,
        lastFileAt: msToMicros(stats.lastFileAtMs),
      });
    }

    const recentFiles = pickRecentFiles(files, teamId);
    for (const file of recentFiles) {
      if (!options.dryRun) await reducers.upsertLibraryFile(file);
      result.filesWritten++;
    }
    // Full replacement per team: anything not in keepIds is pruned.
    if (!options.dryRun) {
      await reducers.pruneLibraryFiles({
        teamId,
        keepIds: recentFiles.map((f) => f.fileId),
      });
    }
    log(
      `libraries.team team=${teamId} files=${stats.fileCount} ` +
        `folders_descended=${foldersDescended} recent7d=${stats.recentCount7d} ` +
        `rows=${recentFiles.length}`,
    );
  }

  log(
    `libraries.done teams=${result.teamsPolled} skipped=${result.teamsSkipped} ` +
      `folders=${result.foldersDescended} folder_skips=${result.foldersSkipped} ` +
      `files=${result.filesSeen} rows=${result.filesWritten}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return result;
}
