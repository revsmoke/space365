/**
 * Unit tests for the membership + group ceremonies:
 *  - ingest/src/membership_worker.ts (join/leave via service_member_queue)
 *  - ingest/src/provisioning.ts kind 'group' (found a new M365 group)
 * Graph and SpacetimeDB are stubbed; the live path is exercised separately
 * via `--ceremonies-once` against the dev database.
 */
import { describe, expect, test } from "bun:test";
import { GraphError } from "../ingest/src/graph_client";
import {
  MembershipWorker,
  executeMembershipAction,
  isAlreadyMember,
  isNotMember,
  memberRefPayload,
  resyncGroupMembership,
  type GraphMembershipClient,
  type MemberRow,
  type MembershipReducers,
} from "../ingest/src/membership_worker";
import {
  ProvisioningWorker,
  assignZoneForGroup,
  createGraphGroup,
  deriveMailNickname,
  groupCreatePayload,
  isNicknameInUse,
  type GraphProvisioner,
  type ProvisionReducers,
  type ProvisionRow,
} from "../ingest/src/provisioning";
import type { SqlReader } from "../ingest/src/surfaces/common";

const GROUP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_ID = "99999999-8888-7777-6666-555555555555";

// --- membership worker -------------------------------------------------------

function memberRow(overrides: Partial<MemberRow> = {}): MemberRow {
  return { id: 11n, teamId: GROUP_ID, userId: USER_ID, action: "join", ...overrides };
}

type GraphCall = { method: string; path: string; body?: unknown };

/** Graph stub recording calls; behavior injectable per method. */
function membershipGraphStub(options: {
  postError?: unknown;
  deleteError?: unknown;
  members?: { id?: string; "@odata.type"?: string }[];
  membersError?: unknown;
} = {}) {
  const calls: GraphCall[] = [];
  const graph: GraphMembershipClient = {
    post: async (path, body) => {
      calls.push({ method: "POST", path, body });
      if (options.postError) throw options.postError;
      return null; // Graph answers 204 No Content for member $ref adds
    },
    delete: async (path) => {
      calls.push({ method: "DELETE", path });
      if (options.deleteError) throw options.deleteError;
    },
    getAll: async (path) => {
      calls.push({ method: "GETALL", path });
      if (options.membersError) throw options.membersError;
      return (options.members ?? []) as Record<string, unknown>[];
    },
  };
  return { graph, calls };
}

/** Records reducer calls for assertions. */
function recordingMembershipReducers() {
  const syncs: { teamId: string; userIds: string[]; roles: string[] }[] = [];
  const completions: { requestId: bigint; ok: boolean; resultRef: string }[] = [];
  const reducers: MembershipReducers = {
    syncTeamMembership: async (args) => void syncs.push(args),
    serviceCompleteMembership: async (args) => void completions.push(args),
  };
  return { reducers, syncs, completions };
}

describe("membership: Graph payload shapes", () => {
  test("join POSTs the directoryObjects $ref body to the group members endpoint", async () => {
    const { graph, calls } = membershipGraphStub();
    await executeMembershipAction(graph, memberRow());
    expect(calls).toEqual([
      {
        method: "POST",
        path: `/groups/${GROUP_ID}/members/$ref`,
        body: {
          "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${USER_ID}`,
        },
      },
    ]);
  });

  test("memberRefPayload pins the fully-qualified directoryObjects URL", () => {
    expect(memberRefPayload("u1")).toEqual({
      "@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/u1",
    });
  });

  test("leave DELETEs the member $ref link", async () => {
    const { graph, calls } = membershipGraphStub();
    await executeMembershipAction(graph, memberRow({ action: "leave" }));
    expect(calls).toEqual([
      { method: "DELETE", path: `/groups/${GROUP_ID}/members/${USER_ID}/$ref` },
    ]);
  });
});

describe("membership: desired-state tolerance", () => {
  test("join tolerates 400 'already exist' (already a member)", async () => {
    const error = new GraphError(
      400,
      "Request_BadRequest",
      "One or more added object references already exist for the following modified properties: 'members'.",
    );
    expect(isAlreadyMember(error)).toBe(true);
    const { graph } = membershipGraphStub({ postError: error });
    expect(await executeMembershipAction(graph, memberRow())).toEqual({ noop: true });
  });

  test("other 400s and non-Graph errors are NOT treated as already-member", () => {
    expect(isAlreadyMember(new GraphError(400, "BadRequest", "bad guid"))).toBe(false);
    expect(isAlreadyMember(new GraphError(403, "Forbidden", "already exist"))).toBe(false);
    expect(isAlreadyMember(new Error("already exist"))).toBe(false);
  });

  test("leave tolerates 404 (already not a member)", async () => {
    const error = new GraphError(404, "Request_ResourceNotFound", "does not exist");
    expect(isNotMember(error)).toBe(true);
    const { graph } = membershipGraphStub({ deleteError: error });
    expect(await executeMembershipAction(graph, memberRow({ action: "leave" }))).toEqual(
      { noop: true },
    );
  });

  test("join does NOT tolerate 404 and leave does NOT tolerate 400", async () => {
    const notFound = new GraphError(404, "NotFound", "no such group");
    const { graph } = membershipGraphStub({ postError: notFound });
    await expect(executeMembershipAction(graph, memberRow())).rejects.toThrow("404");

    const dynamic = new GraphError(400, "BadRequest", "dynamic membership group");
    const { graph: g2 } = membershipGraphStub({ deleteError: dynamic });
    await expect(
      executeMembershipAction(g2, memberRow({ action: "leave" })),
    ).rejects.toThrow("400");
  });
});

describe("membership: post-success re-sync", () => {
  test("fetches group members and replaces STDB membership (all role member)", async () => {
    const { graph, calls } = membershipGraphStub({
      members: [
        { id: "u1" },
        { id: "u2", "@odata.type": "#microsoft.graph.user" },
        { id: "dev1", "@odata.type": "#microsoft.graph.device" }, // filtered out
      ],
    });
    const { reducers, syncs } = recordingMembershipReducers();
    expect(await resyncGroupMembership(graph, reducers, GROUP_ID, () => {})).toBe(true);
    expect(calls).toEqual([
      { method: "GETALL", path: `/groups/${GROUP_ID}/members?$select=id` },
    ]);
    expect(syncs).toEqual([
      { teamId: GROUP_ID, userIds: ["u1", "u2"], roles: ["member", "member"] },
    ]);
  });

  test("resync failure is non-fatal (returns false, redacted log)", async () => {
    const lines: string[] = [];
    const { graph } = membershipGraphStub({
      membersError: new GraphError(403, "Forbidden", "app for bob@contoso.com denied"),
    });
    const { reducers, syncs } = recordingMembershipReducers();
    expect(
      await resyncGroupMembership(graph, reducers, GROUP_ID, (l) => lines.push(l)),
    ).toBe(false);
    expect(syncs).toHaveLength(0);
    expect(lines.join(" ")).toContain("graph 403 Forbidden");
    expect(lines.join(" ")).not.toContain("bob@contoso.com");
  });
});

describe("membership: worker flow", () => {
  test("join success: Graph add → resync → complete(true, 'join')", async () => {
    const { graph, calls } = membershipGraphStub({ members: [{ id: USER_ID }] });
    const { reducers, syncs, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    expect(await worker.processRequest(memberRow())).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GETALL"]);
    expect(syncs).toEqual([{ teamId: GROUP_ID, userIds: [USER_ID], roles: ["member"] }]);
    expect(completions).toEqual([{ requestId: 11n, ok: true, resultRef: "join" }]);
  });

  test("leave success completes with resultRef 'leave'", async () => {
    const { graph } = membershipGraphStub({ members: [] });
    const { reducers, syncs, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    await worker.processRequest(memberRow({ id: 12n, action: "leave" }));
    expect(syncs).toEqual([{ teamId: GROUP_ID, userIds: [], roles: [] }]);
    expect(completions).toEqual([{ requestId: 12n, ok: true, resultRef: "leave" }]);
  });

  test("already-member join still resyncs and completes ok", async () => {
    const { graph } = membershipGraphStub({
      postError: new GraphError(400, "Request_BadRequest", "references already exist"),
      members: [{ id: USER_ID }],
    });
    const { reducers, syncs, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    await worker.processRequest(memberRow());
    expect(syncs).toHaveLength(1);
    expect(completions).toEqual([{ requestId: 11n, ok: true, resultRef: "join" }]);
  });

  test("Graph failure completes(false) with a short redacted summary, no resync", async () => {
    const { graph, calls } = membershipGraphStub({
      postError: new GraphError(403, "Forbidden", "app lacks role for bob@x.com"),
    });
    const { reducers, syncs, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    await worker.processRequest(memberRow());
    expect(calls.map((c) => c.method)).toEqual(["POST"]); // no members fetch
    expect(syncs).toHaveLength(0);
    expect(completions).toEqual([
      { requestId: 11n, ok: false, resultRef: "graph 403 Forbidden" },
    ]);
  });

  test("resync failure after a successful Graph action still completes ok", async () => {
    const { graph } = membershipGraphStub({
      membersError: new GraphError(503, "ServiceUnavailable", "try later"),
    });
    const { reducers, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    await worker.processRequest(memberRow());
    expect(completions).toEqual([{ requestId: 11n, ok: true, resultRef: "join" }]);
  });

  test("unsupported actions complete as failed without touching Graph", async () => {
    const { graph, calls } = membershipGraphStub();
    const { reducers, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    await worker.processRequest(memberRow({ action: "promote" }));
    expect(calls).toHaveLength(0);
    expect(completions).toEqual([
      { requestId: 11n, ok: false, resultRef: "unsupported action: promote" },
    ]);
  });

  test("debounce: each request id is processed exactly once per run", async () => {
    const { graph, calls } = membershipGraphStub({ members: [] });
    const { reducers, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    const row = memberRow();
    expect(await worker.processRequest(row)).toBe(true);
    expect(await worker.processRequest(row)).toBe(false); // e.g. onInsert replay
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(completions).toHaveLength(1);
  });

  test("processQueue drains in id order and skips already-processed rows", async () => {
    const { graph } = membershipGraphStub({ members: [] });
    const { reducers, completions } = recordingMembershipReducers();
    const worker = new MembershipWorker({ graph, reducers, log: () => {} });
    await worker.processRequest(memberRow({ id: 2n }));
    const handled = await worker.processQueue([
      memberRow({ id: 3n, action: "leave" }),
      memberRow({ id: 1n }),
      memberRow({ id: 2n }), // already done above
    ]);
    expect(handled).toBe(2);
    expect(completions.map((c) => c.requestId)).toEqual([2n, 1n, 3n]);
  });
});

// --- provisioning kind 'group' -----------------------------------------------

function groupQueueRow(overrides: Partial<ProvisionRow> = {}): ProvisionRow {
  return {
    id: 21n,
    kind: "group",
    teamId: "", // group requests carry no team
    name: "Space365 Ceremony-Test",
    description: "disposable test group",
    ...overrides,
  };
}

function recordingProvisionReducers() {
  const teams: unknown[] = [];
  const channels: unknown[] = [];
  const syncs: { teamId: string; userIds: string[]; roles: string[] }[] = [];
  const completions: { requestId: bigint; ok: boolean; resultRef: string }[] = [];
  const reducers: ProvisionReducers = {
    upsertChannel: async (args) => void channels.push(args),
    upsertTeam: async (args) => void teams.push(args),
    syncTeamMembership: async (args) => void syncs.push(args),
    serviceCompleteProvision: async (args) => void completions.push(args),
  };
  return { reducers, teams, channels, syncs, completions };
}

/** SQL stub for the team-table zone scan. */
function teamSqlStub(rows: [teamId: string, zoneId: number][]): SqlReader {
  return async (query: string) => {
    if (query.includes("FROM team")) return rows.map(([id, z]) => [id, String(z)]);
    throw new Error(`unexpected query: ${query}`);
  };
}

describe("group provisioning: mailNickname derivation", () => {
  test("lowercases and strips non-alphanumerics", () => {
    expect(deriveMailNickname("Space365 Ceremony-Test")).toBe("space365ceremonytest");
    expect(deriveMailNickname("Q3 Launch (EMEA)!")).toBe("q3launchemea");
  });

  test("falls back to 'group' when nothing survives", () => {
    expect(deriveMailNickname("!!! ***")).toBe("group");
    expect(deriveMailNickname("")).toBe("group");
  });

  test("caps at Graph's 64-char mailNickname limit", () => {
    expect(deriveMailNickname("a".repeat(100))).toBe("a".repeat(64));
  });
});

describe("group provisioning: create payload + collision retry", () => {
  test("payload shape: unified, mail-enabled, not security-enabled", () => {
    expect(groupCreatePayload(groupQueueRow(), "space365ceremonytest")).toEqual({
      displayName: "Space365 Ceremony-Test",
      description: "disposable test group",
      mailNickname: "space365ceremonytest",
      groupTypes: ["Unified"],
      mailEnabled: true,
      securityEnabled: false,
    });
  });

  test("nickname-in-use detection is 400 + mailNickname message only", () => {
    expect(
      isNicknameInUse(
        new GraphError(
          400,
          "ValidationError",
          "Another object with the same value for property mailNickname already exists.",
        ),
      ),
    ).toBe(true);
    expect(isNicknameInUse(new GraphError(400, "BadRequest", "bad displayName"))).toBe(false);
    expect(isNicknameInUse(new GraphError(409, "Conflict", "mailNickname"))).toBe(false);
    expect(isNicknameInUse(new Error("mailNickname"))).toBe(false);
  });

  test("happy path POSTs /groups once and returns the new id", async () => {
    const posts: [string, unknown][] = [];
    const graph = {
      post: async (path: string, body: unknown) => {
        posts.push([path, body]);
        return { id: "grp-new" };
      },
    };
    expect(await createGraphGroup(graph, groupQueueRow())).toEqual({
      groupId: "grp-new",
      mailNickname: "space365ceremonytest",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe("/groups");
    expect((posts[0]![1] as { mailNickname: string }).mailNickname).toBe(
      "space365ceremonytest",
    );
  });

  test("nickname collision retries exactly once with a -2 suffix", async () => {
    const nicknames: string[] = [];
    const graph = {
      post: async (_path: string, body: unknown) => {
        const nickname = (body as { mailNickname: string }).mailNickname;
        nicknames.push(nickname);
        if (nicknames.length === 1) {
          throw new GraphError(
            400,
            "ValidationError",
            "Another object with the same value for property mailNickname already exists.",
          );
        }
        return { id: "grp-2" };
      },
    };
    expect(await createGraphGroup(graph, groupQueueRow())).toEqual({
      groupId: "grp-2",
      mailNickname: "space365ceremonytest-2",
    });
    expect(nicknames).toEqual(["space365ceremonytest", "space365ceremonytest-2"]);
  });

  test("a second collision propagates (no infinite retry)", async () => {
    const graph = {
      post: async () => {
        throw new GraphError(400, "ValidationError", "property mailNickname already exists");
      },
    };
    await expect(createGraphGroup(graph, groupQueueRow())).rejects.toThrow("mailNickname");
  });

  test("non-collision errors pass through without retry", async () => {
    let posts = 0;
    const graph = {
      post: async () => {
        posts++;
        throw new GraphError(403, "Forbidden", "missing Group.Create");
      },
    };
    await expect(createGraphGroup(graph, groupQueueRow())).rejects.toThrow("Forbidden");
    expect(posts).toBe(1);
  });
});

describe("group provisioning: zone assignment", () => {
  test("assigns a fresh 1-based slot avoiding taken zones", async () => {
    const zone = await assignZoneForGroup(teamSqlStub([["team-a", 7]]), "grp-new");
    expect(zone).toBeGreaterThanOrEqual(1);
    expect(zone).toBeLessThanOrEqual(256);
    expect(zone).not.toBe(7);
  });

  test("keeps the existing slot when the group already has a team row", async () => {
    const sql = teamSqlStub([
      ["team-a", 7],
      ["grp-new", 42],
    ]);
    expect(await assignZoneForGroup(sql, "grp-new")).toBe(42);
  });
});

describe("group provisioning: worker flow", () => {
  test("happy path: create → zone → upsert_team(enabled) → empty membership → complete(true, id)", async () => {
    const { reducers, teams, channels, syncs, completions } = recordingProvisionReducers();
    const graph: GraphProvisioner = {
      post: async (path) => {
        expect(path).toBe("/groups");
        return { id: "grp-new" };
      },
      getAll: async () => {
        throw new Error("no lookups expected for group creation");
      },
    };
    const worker = new ProvisioningWorker({
      graph,
      reducers,
      sql: teamSqlStub([["team-a", 7]]),
      log: () => {},
    });
    expect(await worker.processRequest(groupQueueRow())).toBe(true);
    expect(channels).toHaveLength(0);
    expect(teams).toHaveLength(1);
    const team = teams[0] as Record<string, unknown>;
    expect(team.teamId).toBe("grp-new");
    expect(team.name).toBe("Space365 Ceremony-Test");
    expect(team.isEnabled).toBe(true); // an admin explicitly founded it
    expect(team.zoneId).toBeGreaterThanOrEqual(1);
    // A fresh app-created group has no members: seed the world with an empty set.
    expect(syncs).toEqual([{ teamId: "grp-new", userIds: [], roles: [] }]);
    expect(completions).toEqual([{ requestId: 21n, ok: true, resultRef: "grp-new" }]);
  });

  test("failure path: complete(false, short summary), no team upsert", async () => {
    const { reducers, teams, syncs, completions } = recordingProvisionReducers();
    const graph: GraphProvisioner = {
      post: async () => {
        throw new GraphError(403, "Forbidden", "app lacks Group.Create for bob@x.com");
      },
      getAll: async () => [],
    };
    const worker = new ProvisioningWorker({
      graph,
      reducers,
      sql: teamSqlStub([]),
      log: () => {},
    });
    await worker.processRequest(groupQueueRow());
    expect(teams).toHaveLength(0);
    expect(syncs).toHaveLength(0);
    expect(completions).toEqual([
      { requestId: 21n, ok: false, resultRef: "graph 403 Forbidden" },
    ]);
  });

  test("channel requests are unaffected by the group extension", async () => {
    const { reducers, teams, channels, completions } = recordingProvisionReducers();
    const graph: GraphProvisioner = {
      post: async () => ({ id: "chan-new" }),
      getAll: async () => [],
    };
    const sql: SqlReader = async (query: string) => {
      if (query.includes("FROM team")) return [["9"]];
      if (query.includes("FROM channel")) return [];
      throw new Error(`unexpected query: ${query}`);
    };
    const worker = new ProvisioningWorker({ graph, reducers, sql, log: () => {} });
    await worker.processRequest(
      groupQueueRow({ kind: "channel", teamId: "team-x", name: "chan" }),
    );
    expect(teams).toHaveLength(0);
    expect(channels).toHaveLength(1);
    expect(completions).toEqual([{ requestId: 21n, ok: true, resultRef: "chan-new" }]);
  });

  test("still rejects genuinely unknown kinds", async () => {
    const { reducers, completions } = recordingProvisionReducers();
    const worker = new ProvisioningWorker({
      graph: {
        post: async () => {
          throw new Error("graph must not be called");
        },
        getAll: async () => [],
      },
      reducers,
      sql: teamSqlStub([]),
      log: () => {},
    });
    await worker.processRequest(groupQueueRow({ kind: "site" }));
    expect(completions).toEqual([
      { requestId: 21n, ok: false, resultRef: "unsupported kind: site" },
    ]);
  });
});
