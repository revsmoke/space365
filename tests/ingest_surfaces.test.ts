/**
 * Unit tests for the P4 data surfaces (ingest/src/surfaces/*).
 * Pure mapping/aggregation functions exercised with mock Graph payloads.
 */
import { describe, expect, test } from "bun:test";
import { GraphError } from "../ingest/src/graph_client";
import {
  hourBucketMs,
  msToMicros,
  parseGraphUtcMs,
  type GraphLike,
} from "../ingest/src/surfaces/common";
import {
  dedupeEvents,
  mapEventToMeeting,
  runMeetingsOnce,
  zoneForOrganizer,
  type CalendarEvent,
  type TeamLookup,
} from "../ingest/src/surfaces/meetings";
import {
  deriveAppointmentStatus,
  mapAppointment,
  runBookingsOnce,
} from "../ingest/src/surfaces/bookings";
import {
  aggregateCallRecords,
  callModalityKey,
  primaryModality,
  runCallStatsOnce,
  type CallRecord,
} from "../ingest/src/surfaces/call_stats";
import {
  bucketNameMap,
  detectVanishedTasks,
  dueDatePart,
  plannerDeeplink,
  runPlannerQuestsOnce,
  taskToQuests,
  taskToZoneTask,
  type PlannerTask,
} from "../ingest/src/surfaces/planner_quests";
import { aggregateDirectoryAudits } from "../ingest/src/surfaces/audit_ticker";

const NOW = Date.parse("2026-07-06T15:30:00Z");

const LOOKUP: TeamLookup = {
  teamsByUser: new Map([
    ["user-a", ["team-2", "team-1"]],
    ["user-b", ["team-unsynced"]],
  ]),
  zoneByTeam: new Map([
    ["team-1", 7],
    ["team-2", 9],
  ]),
};

function graphEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    iCalUId: "ical-1",
    start: { dateTime: "2026-07-06T16:00:00.0000000" },
    end: { dateTime: "2026-07-06T17:00:00.0000000" },
    ...overrides,
  };
}

describe("common helpers", () => {
  test("parseGraphUtcMs treats tz-less datetimes as UTC", () => {
    expect(parseGraphUtcMs("2026-07-06T16:00:00.0000000")).toBe(
      Date.parse("2026-07-06T16:00:00Z"),
    );
    expect(parseGraphUtcMs("2026-07-06T16:00:00Z")).toBe(
      Date.parse("2026-07-06T16:00:00Z"),
    );
    expect(parseGraphUtcMs("garbage")).toBeNull();
    expect(parseGraphUtcMs(undefined)).toBeNull();
  });

  test("hour bucketing + micros conversion", () => {
    expect(hourBucketMs(NOW)).toBe(Date.parse("2026-07-06T15:00:00Z"));
    expect(msToMicros(1_000)).toBe(1_000_000n);
  });
});

describe("meetings: event mapping", () => {
  test("maps event with organizer team zone, redacted subject, joinUrl", () => {
    const row = mapEventToMeeting(
      graphEvent({
        isOnlineMeeting: true,
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      }),
      "user-a",
      LOOKUP,
    );
    expect(row).not.toBeNull();
    expect(row!.eventId).toBe("evt-1");
    // deterministic: lowest sorted synced team id (team-1, zone 7) wins
    expect(row!.teamId).toBe("team-1");
    expect(row!.zoneId).toBe(7);
    // PRD privacy: subject is never stored
    expect(row!.subjectRedacted).toBe("");
    expect(row!.joinUrl).toBe("https://teams.microsoft.com/l/meetup-join/abc");
    expect(row!.startsAtMicros).toBe(
      BigInt(Date.parse("2026-07-06T16:00:00Z")) * 1000n,
    );
    expect(row!.endsAtMicros).toBe(BigInt(Date.parse("2026-07-06T17:00:00Z")) * 1000n);
  });

  test("organizer without synced team, or unknown organizer, lands in plaza (zone 0)", () => {
    expect(zoneForOrganizer("user-b", LOOKUP)).toEqual({ teamId: undefined, zoneId: 0 });
    expect(zoneForOrganizer(undefined, LOOKUP)).toEqual({ teamId: undefined, zoneId: 0 });
  });

  test("non-online meeting has no joinUrl even if onlineMeeting present", () => {
    const row = mapEventToMeeting(
      graphEvent({ isOnlineMeeting: false, onlineMeeting: { joinUrl: "https://x" } }),
      undefined,
      LOOKUP,
    );
    expect(row!.joinUrl).toBeUndefined();
  });

  test("drops events missing id or parseable start/end", () => {
    expect(mapEventToMeeting(graphEvent({ id: undefined }), undefined, LOOKUP)).toBeNull();
    expect(
      mapEventToMeeting(graphEvent({ start: { dateTime: "nope" } }), undefined, LOOKUP),
    ).toBeNull();
  });
});

describe("meetings: iCalUId dedupe across attendees", () => {
  test("same iCalUId across calendars collapses to one, organizer copy wins", () => {
    const deduped = dedupeEvents([
      {
        userId: "attendee",
        events: [graphEvent({ id: "evt-attendee-copy", isOrganizer: false })],
      },
      {
        userId: "organizer",
        events: [graphEvent({ id: "evt-organizer-copy", isOrganizer: true })],
      },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.event.id).toBe("evt-organizer-copy");
    expect(deduped[0]!.organizerUserId).toBe("organizer");
  });

  test("falls back to event id when iCalUId is missing", () => {
    const deduped = dedupeEvents([
      { userId: "u1", events: [graphEvent({ iCalUId: undefined, id: "evt-x" })] },
      { userId: "u2", events: [graphEvent({ iCalUId: undefined, id: "evt-x" })] },
      { userId: "u3", events: [graphEvent({ iCalUId: undefined, id: "evt-y" })] },
    ]);
    expect(deduped).toHaveLength(2);
  });

  test("distinct iCalUIds stay distinct", () => {
    const deduped = dedupeEvents([
      { userId: "u1", events: [graphEvent(), graphEvent({ id: "evt-2", iCalUId: "ical-2" })] },
    ]);
    expect(deduped).toHaveLength(2);
  });
});

describe("meetings: poll loop", () => {
  test("skips 403/404 users, dedupes, writes via reducer", async () => {
    const calls: unknown[] = [];
    const sqlResponses: Record<string, string[][]> = {
      "SELECT user_id FROM user WHERE is_active = true": [["user-a"], ["user-b"], ["user-c"]],
      "SELECT team_id, zone_id FROM team": [["team-1", "7"], ["team-2", "9"]],
      "SELECT team_id, user_id FROM team_member": [["team-1", "user-a"]],
    };
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        if (path.includes("/users/user-a/")) {
          return [graphEvent({ isOrganizer: true }) as Record<string, unknown>];
        }
        if (path.includes("/users/user-b/")) {
          throw new GraphError(404, "MailboxNotFound", "no mailbox");
        }
        return [graphEvent({ id: "evt-attendee-copy" }) as Record<string, unknown>];
      },
    };
    const result = await runMeetingsOnce(
      graph,
      { upsertMeeting: async (args) => void calls.push(args) },
      { log: () => {}, sql: async (q) => sqlResponses[q] ?? [], nowMs: NOW },
    );
    expect(result.usersSkipped).toBe(1);
    expect(result.usersPolled).toBe(2);
    expect(result.meetingsWritten).toBe(1); // deduped by shared iCalUId
    expect(calls).toHaveLength(1);
    expect((calls[0] as { zoneId: number }).zoneId).toBe(7); // organizer's team
  });
});

describe("bookings", () => {
  test("status derived from time window (no Graph status field)", () => {
    expect(deriveAppointmentStatus(NOW - 7_200_000, NOW - 3_600_000, NOW)).toBe("completed");
    expect(deriveAppointmentStatus(NOW - 600_000, NOW + 600_000, NOW)).toBe("in_progress");
    expect(deriveAppointmentStatus(NOW + 3_600_000, NOW + 7_200_000, NOW)).toBe("upcoming");
  });

  test("serviceName falls back to serviceId then empty", () => {
    const base = {
      id: "appt-1",
      startDateTime: { dateTime: "2026-07-07T10:00:00.0000000" },
    };
    expect(mapAppointment({ ...base, serviceName: "Haircut" }, "biz", NOW)!.serviceName).toBe(
      "Haircut",
    );
    expect(mapAppointment({ ...base, serviceId: "svc-9" }, "biz", NOW)!.serviceName).toBe(
      "svc-9",
    );
    expect(mapAppointment(base, "biz", NOW)!.serviceName).toBe("");
  });

  test("zero businesses reports gracefully", async () => {
    const graph: GraphLike = { get: async () => ({}), getAll: async () => [] };
    const result = await runBookingsOnce(graph, { upsertBookingAppointment: async () => {} }, {
      log: () => {},
      nowMs: NOW,
    });
    expect(result).toEqual({ apiAvailable: true, businesses: 0, appointmentsWritten: 0 });
  });

  test("403 on bookingBusinesses reports api unavailable", async () => {
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async () => {
        throw new GraphError(403, "Forbidden", "no bookings");
      },
    };
    const result = await runBookingsOnce(graph, { upsertBookingAppointment: async () => {} }, {
      log: () => {},
      nowMs: NOW,
    });
    expect(result.apiAvailable).toBe(false);
  });
});

describe("call stats: callRecord → hourly bucket aggregation", () => {
  const records: CallRecord[] = [
    {
      type: "peerToPeer",
      modalities: ["audio"],
      startDateTime: "2026-07-06T10:05:00Z",
      endDateTime: "2026-07-06T10:35:00Z", // 30 min
    },
    {
      type: "peerToPeer",
      modalities: ["audio"],
      startDateTime: "2026-07-06T10:50:00Z",
      endDateTime: "2026-07-06T11:05:00Z", // 15 min, bucketed by start hour
    },
    {
      type: "groupCall",
      modalities: ["audio", "video"],
      startDateTime: "2026-07-06T10:10:00Z",
      endDateTime: "2026-07-06T10:40:00Z", // 30 min, video_group
    },
    {
      type: "peerToPeer",
      modalities: ["audio"],
      startDateTime: "2026-07-06T11:15:00Z",
      endDateTime: "2026-07-06T11:21:00Z", // 6 min, next hour
    },
    { modalities: ["audio"] }, // no start: dropped
  ];

  test("modality selection", () => {
    expect(primaryModality(["audio", "video"])).toBe("video");
    expect(primaryModality(["audio"])).toBe("audio");
    expect(primaryModality(["videoBasedScreenSharing"])).toBe("video");
    expect(primaryModality([])).toBe("unknown");
    expect(callModalityKey({ type: "groupCall", modalities: ["audio"] })).toBe("audio_group");
    expect(callModalityKey({ type: "peerToPeer", modalities: ["video"] })).toBe("video_peer");
  });

  test("aggregates counts and minutes per hour+modality", () => {
    const buckets = aggregateCallRecords(records);
    const key = (b: { bucketStartMicros: bigint; modality: string }) =>
      `${b.bucketStartMicros}|${b.modality}`;
    const byKey = new Map(buckets.map((b) => [key(b), b]));

    const h10 = BigInt(Date.parse("2026-07-06T10:00:00Z")) * 1000n;
    const h11 = BigInt(Date.parse("2026-07-06T11:00:00Z")) * 1000n;

    expect(buckets).toHaveLength(3);
    expect(byKey.get(`${h10}|audio_peer`)).toMatchObject({ callCount: 2, totalMinutes: 45 });
    expect(byKey.get(`${h10}|video_group`)).toMatchObject({ callCount: 1, totalMinutes: 30 });
    expect(byKey.get(`${h11}|audio_peer`)).toMatchObject({ callCount: 1, totalMinutes: 6 });
  });

  test("falls back to $top paging when $filter is rejected", async () => {
    const paths: string[] = [];
    const graph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        paths.push(path);
        if (path.includes("$filter")) {
          throw new GraphError(400, "BadRequest", "filter not supported");
        }
        return [
          {
            type: "peerToPeer",
            modalities: ["audio"],
            startDateTime: new Date(NOW - 3_600_000).toISOString(),
            endDateTime: new Date(NOW - 3_000_000).toISOString(),
          },
          {
            type: "peerToPeer",
            modalities: ["audio"],
            startDateTime: new Date(NOW - 30 * 24 * 3_600_000).toISOString(), // too old
          },
        ] as Record<string, unknown>[];
      },
    };
    const written: unknown[] = [];
    const result = await runCallStatsOnce(
      graph,
      { ingestCallStats: async (args) => void written.push(args) },
      { log: () => {}, nowMs: NOW },
    );
    expect(result.filterSupported).toBe(false);
    expect(result.recordsSeen).toBe(1); // old record cut off client-side
    expect(written).toHaveLength(1);
    expect(paths.some((p) => p.includes("$top=100"))).toBe(true);
  });
});

describe("planner: task → quest mapping", () => {
  const task: PlannerTask = {
    id: "task-1",
    title: "Ship the P4 surfaces",
    percentComplete: 50,
    assignments: { "user-a": {}, "user-b": {} },
  };

  test("one quest per assigned user with expected shape", () => {
    const quests = taskToQuests(task, "Sprint 12");
    expect(quests).toHaveLength(2);
    const questA = quests.find((q) => q.userId === "user-a")!;
    expect(questA).toEqual({
      questId: "planner-task-1-user-a",
      userId: "user-a",
      kind: "task",
      title: "Ship the P4 surfaces",
      sourceRef: "Sprint 12",
      deeplink: plannerDeeplink("task-1"),
      status: "open",
    });
    expect(questA.deeplink).toBe("https://tasks.office.com/Home/Task/task-1");
  });

  test("completed tasks yield no quests", () => {
    expect(taskToQuests({ ...task, percentComplete: 100 }, "p")).toHaveLength(0);
  });

  test("unassigned or id-less tasks yield no quests", () => {
    expect(taskToQuests({ ...task, assignments: {} }, "p")).toHaveLength(0);
    expect(taskToQuests({ ...task, assignments: null }, "p")).toHaveLength(0);
    expect(taskToQuests({ ...task, id: undefined }, "p")).toHaveLength(0);
  });

  test("missing percentComplete counts as incomplete", () => {
    expect(taskToQuests({ ...task, percentComplete: undefined }, "p")).toHaveLength(2);
  });
});

describe("planner: task → zone task mapping", () => {
  const buckets = bucketNameMap([
    { id: "bucket-1", name: "To do" },
    { id: "bucket-2", name: "Doing" },
    { id: "no-name" }, // nameless bucket → ''
    { name: "id-less bucket ignored" },
  ]);

  test("bucket names map by id, nameless/unknown ids fall back to ''", () => {
    expect(buckets.get("bucket-1")).toBe("To do");
    expect(buckets.get("no-name")).toBe("");
    expect(buckets.size).toBe(3);
  });

  test("dueDateTime keeps only the date part", () => {
    expect(dueDatePart("2026-07-10T10:00:00Z")).toBe("2026-07-10");
    expect(dueDatePart(null)).toBeUndefined();
    expect(dueDatePart(undefined)).toBeUndefined();
    expect(dueDatePart("garbage")).toBeUndefined();
  });

  test("maps team id, plan title, bucket name, percent, due", () => {
    const row = taskToZoneTask(
      {
        id: "task-1",
        title: "Ship it",
        percentComplete: 50,
        bucketId: "bucket-2",
        dueDateTime: "2026-07-10T10:00:00Z",
      },
      "team-1",
      "Sprint 12",
      buckets,
    );
    expect(row).toEqual({
      taskId: "task-1",
      teamId: "team-1",
      planTitle: "Sprint 12",
      title: "Ship it",
      bucket: "Doing",
      percentComplete: 50,
      due: "2026-07-10",
    });
  });

  test("completed tasks still map (clients style them; never dropped)", () => {
    const row = taskToZoneTask(
      { id: "task-2", title: "Done thing", percentComplete: 100 },
      "team-1",
      "Sprint 12",
      buckets,
    )!;
    expect(row.percentComplete).toBe(100);
    expect(row.bucket).toBe("");
    expect(row.due).toBeUndefined();
  });

  test("unknown bucket ids fall back to '', id-less tasks map to null", () => {
    expect(
      taskToZoneTask({ id: "t", bucketId: "missing" }, "team-1", "p", buckets)!.bucket,
    ).toBe("");
    expect(taskToZoneTask({ title: "no id" }, "team-1", "p", buckets)).toBeNull();
  });
});

describe("planner: vanished-task delete detection", () => {
  const known: [string, string][] = [
    ["task-a", "team-1"],
    ["task-b", "team-1"],
    ["task-c", "team-2"],
  ];

  test("deletes ids missing from a polled team's sync", () => {
    expect(
      detectVanishedTasks(known, new Set(["task-a"]), new Set(["team-1", "team-2"])),
    ).toEqual(["task-b", "task-c"]);
  });

  test("never deletes tasks of teams that were skipped this run", () => {
    expect(detectVanishedTasks(known, new Set(["task-a"]), new Set(["team-1"]))).toEqual([
      "task-b",
    ]);
    expect(detectVanishedTasks(known, new Set(), new Set())).toEqual([]);
  });
});

describe("planner: poll loop writes zone tasks and prunes vanished ones", () => {
  const sqlStub = (knownTasks: [string, string][]) => async (query: string) => {
    if (query.includes("FROM team")) return [["team-1"], ["team-dead"]];
    if (query.includes("FROM zone_task")) return knownTasks;
    throw new Error(`unexpected query: ${query}`);
  };

  const graph: GraphLike = {
    get: async () => ({}),
    getAll: async (path: string) => {
      if (path === "/groups/team-1/planner/plans") {
        return [{ id: "plan-1", title: "Sprint 12" }];
      }
      if (path === "/groups/team-dead/planner/plans") {
        throw new GraphError(400, "BadRequest", "not a GUID");
      }
      if (path === "/planner/plans/plan-1/buckets") {
        return [{ id: "bucket-1", name: "To do" }];
      }
      if (path === "/planner/plans/plan-1/tasks") {
        return [
          {
            id: "task-live",
            title: "Live task",
            percentComplete: 0,
            bucketId: "bucket-1",
            dueDateTime: "2026-07-20T00:00:00Z",
            assignments: { "user-a": {} },
          },
          {
            id: "task-complete",
            title: "Finished",
            percentComplete: 100,
            bucketId: "bucket-1",
          },
        ] as Record<string, unknown>[];
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };

  test("upserts every task, deletes vanished, keeps skipped teams intact", async () => {
    const quests: unknown[] = [];
    const zoneUpserts: Record<string, unknown>[] = [];
    const deletes: string[] = [];
    const result = await runPlannerQuestsOnce(
      graph,
      {
        createOrUpdateQuest: async (args) => void quests.push(args),
        upsertZoneTask: async (args) => void zoneUpserts.push(args),
        deleteZoneTask: async ({ taskId }) => void deletes.push(taskId),
      },
      {
        log: () => {},
        sql: sqlStub([
          ["task-live", "team-1"], // still present → kept
          ["task-vanished", "team-1"], // gone from Graph → deleted
          ["task-elsewhere", "team-dead"], // team skipped → kept
        ]),
      },
    );

    expect(result.teamsPolled).toBe(1);
    expect(result.teamsSkipped).toBe(1);
    expect(result.tasksSeen).toBe(2);
    expect(result.questsWritten).toBe(1); // completed task yields no quest
    expect(result.zoneTasksWritten).toBe(2); // ...but does yield a zone task
    expect(result.zoneTasksDeleted).toBe(1);
    expect(deletes).toEqual(["task-vanished"]);
    expect(zoneUpserts.map((z) => z.taskId)).toEqual(["task-live", "task-complete"]);
    expect(zoneUpserts[0]).toEqual({
      taskId: "task-live",
      teamId: "team-1",
      planTitle: "Sprint 12",
      title: "Live task",
      bucket: "To do",
      percentComplete: 0,
      due: "2026-07-20",
    });
  });

  test("dry run maps everything but writes nothing", async () => {
    const writes: unknown[] = [];
    const result = await runPlannerQuestsOnce(
      graph,
      {
        createOrUpdateQuest: async (args) => void writes.push(args),
        upsertZoneTask: async (args) => void writes.push(args),
        deleteZoneTask: async (args) => void writes.push(args),
      },
      { log: () => {}, dryRun: true, sql: sqlStub([["task-vanished", "team-1"]]) },
    );
    expect(writes).toHaveLength(0);
    expect(result.zoneTasksWritten).toBe(2);
    expect(result.zoneTasksDeleted).toBe(1);
  });

  test("bucket fetch failure degrades to '' bucket names", async () => {
    const noBucketGraph: GraphLike = {
      get: async () => ({}),
      getAll: async (path: string) => {
        if (path.includes("/buckets")) {
          throw new GraphError(403, "Forbidden", "no");
        }
        return graph.getAll(path);
      },
    };
    const zoneUpserts: Record<string, unknown>[] = [];
    await runPlannerQuestsOnce(
      noBucketGraph,
      {
        createOrUpdateQuest: async () => {},
        upsertZoneTask: async (args) => void zoneUpserts.push(args),
        deleteZoneTask: async () => {},
      },
      { log: () => {}, sql: sqlStub([]) },
    );
    expect(zoneUpserts).toHaveLength(2);
    expect(zoneUpserts.every((z) => z.bucket === "")).toBe(true);
  });
});

describe("audit ticker: directoryAudits → hourly category counts", () => {
  test("aggregates by category per hour, defaults uncategorized", () => {
    const buckets = aggregateDirectoryAudits([
      { category: "UserManagement", activityDateTime: "2026-07-06T14:10:00Z" },
      { category: "UserManagement", activityDateTime: "2026-07-06T14:50:00Z" },
      { category: "GroupManagement", activityDateTime: "2026-07-06T14:20:00Z" },
      { category: "UserManagement", activityDateTime: "2026-07-06T15:01:00Z" },
      { activityDateTime: "2026-07-06T15:02:00Z" },
      { category: "Dropped" }, // no timestamp: dropped
    ]);
    const h14 = BigInt(Date.parse("2026-07-06T14:00:00Z")) * 1000n;
    const h15 = BigInt(Date.parse("2026-07-06T15:00:00Z")) * 1000n;
    expect(buckets).toHaveLength(4);
    expect(buckets).toContainEqual({
      bucketStartMicros: h14,
      category: "UserManagement",
      count: 2,
    });
    expect(buckets).toContainEqual({
      bucketStartMicros: h14,
      category: "GroupManagement",
      count: 1,
    });
    expect(buckets).toContainEqual({
      bucketStartMicros: h15,
      category: "UserManagement",
      count: 1,
    });
    expect(buckets).toContainEqual({
      bucketStartMicros: h15,
      category: "uncategorized",
      count: 1,
    });
  });
});
