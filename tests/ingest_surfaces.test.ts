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
  plannerDeeplink,
  taskToQuests,
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
