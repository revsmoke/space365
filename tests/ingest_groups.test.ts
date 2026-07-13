/**
 * Unit tests for the Groups permission batch surfaces
 * (ingest/src/surfaces/groups_sync.ts, libraries.ts, mailboxes.ts).
 * Pure mapping/aggregation functions exercised with mock Graph payloads.
 */
import { describe, expect, test } from "bun:test";
import { GraphError } from "../ingest/src/graph_client";
import { ZONE_SLOTS } from "../shared/types/layout";
import type { GraphLike } from "../ingest/src/surfaces/common";
import {
  GROUPS_SYNC_CAP_DEFAULT,
  groupsSyncCap,
  isUnifiedGroup,
  memberUserIds,
  planNewGroupZones,
  runGroupsSyncOnce,
  type GraphGroup,
} from "../ingest/src/surfaces/groups_sync";
import {
  FOLDER_DESCENT_CAP,
  computeLibraryStats,
  pickRecentFiles,
  runLibrariesOnce,
  splitDriveItems,
  type DriveItem,
} from "../ingest/src/surfaces/libraries";
import {
  computeMailboxStats,
  runMailboxesOnce,
  type GroupConversation,
} from "../ingest/src/surfaces/mailboxes";

const NOW = Date.parse("2026-07-07T12:00:00Z");
const DAY_MS = 24 * 3_600_000;

const micros = (iso: string) => BigInt(Date.parse(iso)) * 1000n;

// ---------------------------------------------------------------------------
// groups_sync: group → team mapping
// ---------------------------------------------------------------------------

describe("groups_sync: unified group detection", () => {
  test("groupTypes containing 'Unified' marks a unified group", () => {
    expect(isUnifiedGroup({ id: "g1", groupTypes: ["Unified"] })).toBe(true);
    expect(isUnifiedGroup({ id: "g2", groupTypes: ["DynamicMembership", "Unified"] })).toBe(true);
    expect(isUnifiedGroup({ id: "g3", groupTypes: [] })).toBe(false); // security group
    expect(isUnifiedGroup({ id: "g4" })).toBe(false);
  });
});

describe("groups_sync: group → team zone planning", () => {
  const groups: GraphGroup[] = [
    { id: "group-new-1", displayName: "All Company", groupTypes: ["Unified"] },
    { id: "group-existing", displayName: "TPG", groupTypes: ["Unified"] },
    { id: "group-new-2", displayName: "Design Guild", groupTypes: ["Unified"] },
    { displayName: "id-less ignored", groupTypes: ["Unified"] },
  ];

  test("new groups get isEnabled=false and fresh zone slots; existing untouched", () => {
    const taken = new Set([7]); // group-existing already occupies zone 7
    const plan = planNewGroupZones(groups, new Set(["group-existing"]), taken);
    expect(plan.rows).toHaveLength(2);
    for (const row of plan.rows) {
      // Allowlist-first: never flood the world.
      expect(row.isEnabled).toBe(false);
      expect(row.zoneId).toBeGreaterThanOrEqual(1);
      expect(row.zoneId).toBeLessThanOrEqual(ZONE_SLOTS);
      expect(row.zoneId).not.toBe(7); // never steals an existing slot
    }
    expect(plan.rows.map((r) => r.teamId)).toEqual(["group-new-1", "group-new-2"]);
    expect(plan.rows[0]!.name).toBe("All Company");
  });

  test("assigned zones never collide within a pass and mutate the taken set", () => {
    const taken = new Set<number>();
    const many: GraphGroup[] = Array.from({ length: 40 }, (_, i) => ({
      id: `group-${i}`,
      groupTypes: ["Unified"],
    }));
    const plan = planNewGroupZones(many, new Set(), taken);
    const zones = plan.rows.map((r) => r.zoneId);
    expect(new Set(zones).size).toBe(40); // all distinct
    expect(taken.size).toBe(40);
  });

  test("full zone grid skips the overflow instead of throwing", () => {
    const taken = new Set(Array.from({ length: ZONE_SLOTS }, (_, i) => i + 1));
    const plan = planNewGroupZones(
      [{ id: "overflow", groupTypes: ["Unified"] }],
      new Set(),
      taken,
    );
    expect(plan.rows).toHaveLength(0);
    expect(plan.gridFullSkipped).toEqual(["overflow"]);
  });
});

describe("groups_sync: member id extraction", () => {
  test("keeps users and untyped rows, drops non-users and id-less rows", () => {
    expect(
      memberUserIds([
        { id: "u1", "@odata.type": "#microsoft.graph.user" },
        { id: "u2" }, // untyped ($select=id) kept
        { id: "dev1", "@odata.type": "#microsoft.graph.device" },
        { "@odata.type": "#microsoft.graph.user" }, // no id
      ]),
    ).toEqual(["u1", "u2"]);
  });
});

describe("groups_sync: poll loop", () => {
  const sqlTeams = [
    ["team-tpg", "7"],
    ["team-other", "9"],
  ];

  function stubGraph(groups: GraphGroup[], membersByGroup: Record<string, string[]> = {}) {
    const paths: string[] = [];
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        paths.push(path);
        if (path.startsWith("/groups?")) return groups as Record<string, unknown>[];
        const match = /^\/groups\/([^/]+)\/members/.exec(path);
        if (match) {
          return (membersByGroup[match[1]!] ?? []).map((id) => ({ id }));
        }
        throw new Error(`unexpected path ${path}`);
      },
    };
    return { graph, paths };
  }

  test("adds only unknown unified groups (disabled), syncs their membership", async () => {
    const { graph } = stubGraph(
      [
        { id: "team-tpg", displayName: "TPG", groupTypes: ["Unified"] }, // already synced
        { id: "group-new", displayName: "All Company", groupTypes: ["Unified"] },
        { id: "group-security", displayName: "Sec", groupTypes: [] }, // defense in depth
      ],
      { "group-new": ["user-a", "user-b"] },
    );
    const upserts: unknown[] = [];
    const memberships: unknown[] = [];
    const result = await runGroupsSyncOnce(
      graph,
      {
        upsertTeam: async (args) => void upserts.push(args),
        syncTeamMembership: async (args) => void memberships.push(args),
      },
      { log: () => {}, sql: async () => sqlTeams },
    );

    expect(result.unifiedFound).toBe(2);
    expect(result.teamsAdded).toBe(1);
    expect(result.alreadySynced).toBe(1);
    expect(result.truncated).toBe(false);
    expect(upserts).toHaveLength(1);
    const team = upserts[0] as { teamId: string; isEnabled: boolean; zoneId: number };
    expect(team.teamId).toBe("group-new");
    expect(team.isEnabled).toBe(false); // allowlist-first
    expect(team.zoneId).not.toBe(7);
    expect(team.zoneId).not.toBe(9);
    expect(memberships).toEqual([
      { teamId: "group-new", userIds: ["user-a", "user-b"], roles: ["member", "member"] },
    ]);
    expect(result.membershipsSynced).toBe(2);
  });

  test("existing teams are never re-upserted (Teams-backed groups untouched)", async () => {
    const { graph } = stubGraph([
      { id: "team-tpg", displayName: "TPG renamed?!", groupTypes: ["Unified"] },
    ]);
    const upserts: unknown[] = [];
    const result = await runGroupsSyncOnce(
      graph,
      {
        upsertTeam: async (args) => void upserts.push(args),
        syncTeamMembership: async () => {},
      },
      { log: () => {}, sql: async () => sqlTeams },
    );
    expect(result.teamsAdded).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  test("cap is env-tunable via GROUPS_SYNC_CAP, default 500", () => {
    expect(GROUPS_SYNC_CAP_DEFAULT).toBe(500);
    expect(groupsSyncCap({})).toBe(500);
    expect(groupsSyncCap({ GROUPS_SYNC_CAP: "250" })).toBe(250);
    expect(groupsSyncCap({ GROUPS_SYNC_CAP: "250.9" })).toBe(250);
    expect(groupsSyncCap({ GROUPS_SYNC_CAP: "0" })).toBe(500); // invalid → default
    expect(groupsSyncCap({ GROUPS_SYNC_CAP: "-5" })).toBe(500);
    expect(groupsSyncCap({ GROUPS_SYNC_CAP: "lots" })).toBe(500);
  });

  test("reports truncation when the listing hits the cap", async () => {
    const cap = groupsSyncCap();
    const groups: GraphGroup[] = Array.from({ length: cap }, (_, i) => ({
      id: `bulk-${i}`,
      groupTypes: ["Unified"],
    }));
    const { graph } = stubGraph(groups);
    const logs: string[] = [];
    const result = await runGroupsSyncOnce(
      graph,
      { upsertTeam: async () => {}, syncTeamMembership: async () => {} },
      { log: (l) => void logs.push(l), sql: async () => [], dryRun: true },
    );
    expect(result.truncated).toBe(true);
    expect(logs.some((l) => l.includes("groups_sync.truncated"))).toBe(true);
    // More groups than zone slots: the rest are grid-full skipped.
    expect(result.teamsAdded + result.gridFullSkipped).toBe(cap);
    expect(result.teamsAdded).toBe(ZONE_SLOTS);
  });

  test("400 on the unified filter falls back to client-side filtering", async () => {
    const paths: string[] = [];
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        paths.push(path);
        if (path.includes("$filter")) {
          throw new GraphError(400, "Request_UnsupportedQuery", "filter rejected");
        }
        if (path.startsWith("/groups?")) {
          return [
            { id: "g-uni", groupTypes: ["Unified"] },
            { id: "g-sec", groupTypes: [] },
          ] as Record<string, unknown>[];
        }
        return [];
      },
    };
    const upserts: { teamId: string }[] = [];
    const result = await runGroupsSyncOnce(
      graph,
      {
        upsertTeam: async (args) => void upserts.push(args as { teamId: string }),
        syncTeamMembership: async () => {},
      },
      { log: () => {}, sql: async () => [] },
    );
    expect(result.filterSupported).toBe(false);
    expect(result.unifiedFound).toBe(1);
    expect(upserts.map((u) => u.teamId)).toEqual(["g-uni"]);
  });

  test("membership write failure (module bug) does not abort the run", async () => {
    const { graph } = stubGraph(
      [
        { id: "g1", groupTypes: ["Unified"] },
        { id: "g2", groupTypes: ["Unified"] },
      ],
      { g1: ["u1"], g2: ["u2"] },
    );
    const result = await runGroupsSyncOnce(
      graph,
      {
        upsertTeam: async () => {},
        syncTeamMembership: async (args) => {
          if (args.teamId === "g1") throw new Error("index panic");
        },
      },
      { log: () => {}, sql: async () => [] },
    );
    expect(result.teamsAdded).toBe(2);
    expect(result.membershipWriteFailures).toBe(1);
    expect(result.membershipsSynced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// libraries: drive stats + recent files
// ---------------------------------------------------------------------------

function driveItem(overrides: Partial<DriveItem> = {}): DriveItem {
  return {
    id: "item-1",
    name: "Spec.docx",
    webUrl: "https://contoso.sharepoint.com/Spec.docx",
    lastModifiedDateTime: new Date(NOW - DAY_MS).toISOString(),
    file: { mimeType: "application/msword" },
    ...overrides,
  };
}

describe("libraries: drive item partitioning", () => {
  test("splitDriveItems separates files from folders (folder facet wins)", () => {
    const file = driveItem({ id: "f1" });
    const folder = driveItem({ id: "d1", file: undefined, folder: { childCount: 3 } });
    const odd = driveItem({ id: "odd", folder: {}, file: {} }); // folder facet wins
    const { files, folders } = splitDriveItems([file, folder, odd]);
    expect(files.map((i) => i.id)).toEqual(["f1"]);
    expect(folders.map((i) => i.id)).toEqual(["d1", "odd"]);
  });
});

describe("libraries: drive stats math (files only)", () => {
  test("counts files, 7d window, max timestamp — folders are NOT counted", () => {
    const items: DriveItem[] = [
      driveItem({ id: "f1", lastModifiedDateTime: "2026-07-06T12:00:00Z" }), // 1d ago
      driveItem({ id: "f2", lastModifiedDateTime: "2026-06-30T12:00:00Z" }), // exactly 7d: in
      driveItem({ id: "f3", lastModifiedDateTime: "2026-06-20T12:00:00Z" }), // out
      driveItem({
        id: "d1",
        name: "Archive",
        file: undefined,
        folder: { childCount: 3 },
        lastModifiedDateTime: "2026-07-07T09:00:00Z",
      }),
    ];
    // Callers feed computeLibraryStats the files-only partition.
    const stats = computeLibraryStats(splitDriveItems(items).files, NOW);
    expect(stats.fileCount).toBe(3); // folder excluded
    expect(stats.recentCount7d).toBe(2); // folder's recent timestamp excluded too
    expect(stats.lastFileAtMs).toBe(Date.parse("2026-07-06T12:00:00Z"));
  });

  test("empty drive yields zeros", () => {
    expect(computeLibraryStats([], NOW)).toEqual({
      fileCount: 0,
      recentCount7d: 0,
      lastFileAtMs: 0,
    });
  });

  test("unparseable timestamps are ignored, not counted as recent", () => {
    const stats = computeLibraryStats(
      [driveItem({ lastModifiedDateTime: "garbage" }), driveItem({ lastModifiedDateTime: undefined })],
      NOW,
    );
    expect(stats.fileCount).toBe(2);
    expect(stats.recentCount7d).toBe(0);
    expect(stats.lastFileAtMs).toBe(0);
  });
});

describe("libraries: recent file picking", () => {
  test("folders excluded, sorted desc by modified, capped at 15, metadata only", () => {
    const items: DriveItem[] = [
      driveItem({ id: "old", name: "old.txt", lastModifiedDateTime: "2026-06-01T00:00:00Z" }),
      driveItem({ id: "folder", name: "Docs", file: undefined, folder: {} }),
      ...Array.from({ length: 16 }, (_, i) =>
        driveItem({
          id: `f-${i}`,
          name: `file-${i}.txt`,
          lastModifiedDateTime: new Date(NOW - i * 3_600_000).toISOString(),
        }),
      ),
    ];
    const rows = pickRecentFiles(items, "team-1");
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.fileId !== "folder")).toBe(true);
    expect(rows.every((r) => r.fileId !== "old")).toBe(true); // 17 files, 2 oldest dropped
    expect(rows[0]!.fileId).toBe("f-0"); // newest first
    expect(rows[0]!.teamId).toBe("team-1");
    expect(rows[0]!.modifiedAt).toBe(BigInt(NOW) * 1000n);
    // Metadata only: exactly these keys, no content.
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "fileId",
      "modifiedAt",
      "name",
      "teamId",
      "webUrl",
    ]);
  });

  test("id-less items are skipped", () => {
    expect(pickRecentFiles([driveItem({ id: undefined })], "t")).toHaveLength(0);
  });
});

describe("libraries: poll loop with folder descent", () => {
  /** Stub drive: root children per team, folder children per folder id. */
  function stubDrive(
    rootByTeam: Record<string, DriveItem[] | GraphError>,
    childrenByFolder: Record<string, DriveItem[] | GraphError>,
  ): { graph: GraphLike; paths: string[] } {
    const paths: string[] = [];
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        paths.push(path);
        const rootMatch = /^\/groups\/([^/]+)\/drive\/root\/children/.exec(path);
        if (rootMatch) {
          const entry = rootByTeam[rootMatch[1]!];
          if (entry instanceof GraphError) throw entry;
          return (entry ?? []) as Record<string, unknown>[];
        }
        const folderMatch = /^\/groups\/[^/]+\/drive\/items\/([^/]+)\/children/.exec(path);
        if (folderMatch) {
          const entry = childrenByFolder[folderMatch[1]!];
          if (entry instanceof GraphError) throw entry;
          return (entry ?? []) as Record<string, unknown>[];
        }
        throw new Error(`unexpected path ${path}`);
      },
    };
    return { graph, paths };
  }

  const folder = (id: string) =>
    driveItem({ id, name: id, file: undefined, folder: { childCount: 1 } });

  test("aggregates files across root + one folder level; 404 (no drive) skips", async () => {
    const { graph } = stubDrive(
      {
        "team-ok": [
          driveItem({ id: "root-f1", name: "root.txt", lastModifiedDateTime: "2026-07-06T12:00:00Z" }),
          folder("General"),
          folder("Design"),
        ],
        "team-nodrive": new GraphError(404, "ResourceNotFound", "no drive"),
      },
      {
        General: [
          driveItem({ id: "gen-f1", name: "notes.docx", lastModifiedDateTime: "2026-07-07T09:00:00Z" }),
          folder("nested-subfolder"), // NOT descended into, NOT counted
        ],
        Design: [
          driveItem({ id: "des-f1", name: "logo.png", lastModifiedDateTime: "2026-06-01T00:00:00Z" }),
        ],
      },
    );
    const libraries: unknown[] = [];
    const files: { fileId: string }[] = [];
    const prunes: unknown[] = [];
    const result = await runLibrariesOnce(
      graph,
      {
        upsertZoneLibrary: async (args) => void libraries.push(args),
        upsertLibraryFile: async (args) => void files.push(args as { fileId: string }),
        pruneLibraryFiles: async (args) => void prunes.push(args),
      },
      { log: () => {}, nowMs: NOW, sql: async () => [["team-ok"], ["team-nodrive"]] },
    );

    expect(result.teamsPolled).toBe(1);
    expect(result.teamsSkipped).toBe(1);
    expect(result.foldersDescended).toBe(2);
    // Folders themselves are NOT counted; nested subfolder not entered.
    expect(libraries).toEqual([
      {
        teamId: "team-ok",
        fileCount: 3,
        recentCount7D: 2,
        lastFileAt: micros("2026-07-07T09:00:00Z"),
      },
    ]);
    // Recent files span root + subfolders, newest first.
    expect(files.map((f) => f.fileId)).toEqual(["gen-f1", "root-f1", "des-f1"]);
    expect(prunes).toEqual([{ teamId: "team-ok", keepIds: ["gen-f1", "root-f1", "des-f1"] }]);
  });

  test("descends at most FOLDER_DESCENT_CAP folders per team", async () => {
    const rootFolders = Array.from({ length: FOLDER_DESCENT_CAP + 3 }, (_, i) =>
      folder(`ch-${i}`),
    );
    const childrenByFolder = Object.fromEntries(
      rootFolders.map((f) => [f.id!, [driveItem({ id: `${f.id}-file`, name: `${f.id}.txt` })]]),
    );
    const { graph, paths } = stubDrive({ "team-1": rootFolders }, childrenByFolder);
    const libraries: { fileCount: number }[] = [];
    const result = await runLibrariesOnce(
      graph,
      {
        upsertZoneLibrary: async (args) => void libraries.push(args as { fileCount: number }),
        upsertLibraryFile: async () => {},
        pruneLibraryFiles: async () => {},
      },
      { log: () => {}, nowMs: NOW, sql: async () => [["team-1"]] },
    );
    expect(result.foldersDescended).toBe(FOLDER_DESCENT_CAP);
    expect(libraries[0]!.fileCount).toBe(FOLDER_DESCENT_CAP); // one file per descended folder
    expect(paths.filter((p) => p.includes("/drive/items/"))).toHaveLength(FOLDER_DESCENT_CAP);
  });

  test("per-folder 404/403 skips just that folder, not the team", async () => {
    const { graph } = stubDrive(
      { "team-1": [folder("ok"), folder("gone"), folder("denied")] },
      {
        ok: [driveItem({ id: "ok-f", name: "kept.txt", lastModifiedDateTime: "2026-07-06T12:00:00Z" })],
        gone: new GraphError(404, "ResourceNotFound", "deleted folder"),
        denied: new GraphError(403, "AccessDenied", "trimmed"),
      },
    );
    const libraries: { fileCount: number }[] = [];
    const prunes: unknown[] = [];
    const result = await runLibrariesOnce(
      graph,
      {
        upsertZoneLibrary: async (args) => void libraries.push(args as { fileCount: number }),
        upsertLibraryFile: async () => {},
        pruneLibraryFiles: async (args) => void prunes.push(args),
      },
      { log: () => {}, nowMs: NOW, sql: async () => [["team-1"]] },
    );
    expect(result.teamsPolled).toBe(1);
    expect(result.foldersDescended).toBe(1);
    expect(result.foldersSkipped).toBe(2);
    expect(libraries[0]!.fileCount).toBe(1);
    expect(prunes).toEqual([{ teamId: "team-1", keepIds: ["ok-f"] }]);
  });

  test("empty drive still writes zeroed stats and prunes to empty", async () => {
    const { graph } = stubDrive({ "team-1": [] }, {});
    const libraries: unknown[] = [];
    const prunes: unknown[] = [];
    await runLibrariesOnce(
      graph,
      {
        upsertZoneLibrary: async (args) => void libraries.push(args),
        upsertLibraryFile: async () => {},
        pruneLibraryFiles: async (args) => void prunes.push(args),
      },
      { log: () => {}, nowMs: NOW, sql: async () => [["team-1"]] },
    );
    expect(libraries).toEqual([
      { teamId: "team-1", fileCount: 0, recentCount7D: 0, lastFileAt: 0n },
    ]);
    expect(prunes).toEqual([{ teamId: "team-1", keepIds: [] }]);
  });
});

// ---------------------------------------------------------------------------
// mailboxes: conversation counting
// ---------------------------------------------------------------------------

describe("mailboxes: conversation counting", () => {
  test("7d window and max lastDeliveredDateTime", () => {
    const conversations: GroupConversation[] = [
      { id: "c1", lastDeliveredDateTime: "2026-07-07T10:00:00Z" }, // recent
      { id: "c2", lastDeliveredDateTime: "2026-06-30T12:00:00Z" }, // exactly 7d: in
      { id: "c3", lastDeliveredDateTime: "2026-05-01T00:00:00Z" }, // old
      { id: "c4" }, // no timestamp: ignored
    ];
    const stats = computeMailboxStats(conversations, NOW);
    expect(stats.threadCount7d).toBe(2);
    expect(stats.lastTopicAtMs).toBe(Date.parse("2026-07-07T10:00:00Z"));
  });

  test("empty mailbox yields zeros", () => {
    expect(computeMailboxStats([], NOW)).toEqual({ threadCount7d: 0, lastTopicAtMs: 0 });
  });
});

describe("mailboxes: poll loop", () => {
  test("403/404 tolerated; counts and times only reach the reducer", async () => {
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        if (path.includes("/groups/team-denied/")) {
          throw new GraphError(403, "ErrorAccessDenied", "denied");
        }
        if (path.includes("/groups/team-nomailbox/")) {
          throw new GraphError(404, "ErrorItemNotFound", "no mailbox");
        }
        return [
          { id: "c1", topic: "SECRET TOPIC", lastDeliveredDateTime: "2026-07-06T12:00:00Z" },
          { id: "c2", lastDeliveredDateTime: "2026-06-01T12:00:00Z" },
        ] as Record<string, unknown>[];
      },
    };
    const writes: unknown[] = [];
    const result = await runMailboxesOnce(
      graph,
      { upsertZoneMailbox: async (args) => void writes.push(args) },
      {
        log: () => {},
        nowMs: NOW,
        sql: async () => [["team-ok"], ["team-denied"], ["team-nomailbox"]],
      },
    );
    expect(result.teamsPolled).toBe(1);
    expect(result.teamsSkipped).toBe(2);
    expect(writes).toEqual([
      {
        teamId: "team-ok",
        threadCount7D: 1,
        lastTopicAt: micros("2026-07-06T12:00:00Z"),
      },
    ]);
    // NO topics, NO senders — only counts and times cross the boundary.
    expect(
      JSON.stringify(writes, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).not.toContain("SECRET");
  });

  test("400 on $select retries without it", async () => {
    const paths: string[] = [];
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        paths.push(path);
        if (path.includes("$select")) {
          throw new GraphError(400, "BadRequest", "select not supported");
        }
        return [{ id: "c1", lastDeliveredDateTime: "2026-07-07T08:00:00Z" }];
      },
    };
    const writes: unknown[] = [];
    const result = await runMailboxesOnce(
      graph,
      { upsertZoneMailbox: async (args) => void writes.push(args) },
      { log: () => {}, nowMs: NOW, sql: async () => [["team-1"]] },
    );
    expect(result.teamsPolled).toBe(1);
    expect(writes).toHaveLength(1);
    expect(paths.some((p) => !p.includes("$select"))).toBe(true);
  });
});
