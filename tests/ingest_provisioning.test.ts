/**
 * Unit tests for the provisioning worker (ingest/src/provisioning.ts).
 * Graph and SpacetimeDB are stubbed; the live path is exercised separately
 * via `--provision-once` against the dev database.
 */
import { describe, expect, test } from "bun:test";
import { GraphError } from "../ingest/src/graph_client";
import {
  ProvisioningWorker,
  assignRoomForChannel,
  channelCreatePayload,
  createGraphChannel,
  escapeODataLiteral,
  findChannelByName,
  isAlreadyExists,
  shortError,
  type GraphProvisioner,
  type ProvisionReducers,
  type ProvisionRow,
} from "../ingest/src/provisioning";
import type { SqlReader } from "../ingest/src/surfaces/common";

const TEAM_ID = "11111111-2222-3333-4444-555555555555";

function queueRow(overrides: Partial<ProvisionRow> = {}): ProvisionRow {
  return {
    id: 7n,
    kind: "channel",
    teamId: TEAM_ID,
    name: "space365-test-channel",
    description: "created by test",
    ...overrides,
  };
}

/** Records reducer calls for assertions. */
function recordingReducers() {
  const upserts: unknown[] = [];
  const completions: { requestId: bigint; ok: boolean; resultRef: string }[] = [];
  const reducers: ProvisionReducers = {
    upsertChannel: async (args) => void upserts.push(args),
    serviceCompleteProvision: async (args) => void completions.push(args),
  };
  return { reducers, upserts, completions };
}

/** SQL stub: one team zone row + configurable existing channels. */
function sqlStub(
  channels: [channelId: string, roomId: number][],
  zoneId = 7,
): SqlReader {
  return async (query: string) => {
    if (query.includes("FROM team")) return [[String(zoneId)]];
    if (query.includes("FROM channel")) {
      return channels.map(([id, room]) => [id, String(room)]);
    }
    throw new Error(`unexpected query: ${query}`);
  };
}

describe("provisioning: queue row → Graph payload", () => {
  test("maps name/description and always requests a standard channel", () => {
    expect(channelCreatePayload(queueRow())).toEqual({
      displayName: "space365-test-channel",
      description: "created by test",
      membershipType: "standard",
    });
  });

  test("escapes single quotes for OData lookups", () => {
    expect(escapeODataLiteral("Bob's channel")).toBe("Bob''s channel");
    expect(escapeODataLiteral("plain")).toBe("plain");
  });
});

describe("provisioning: already-exists detection", () => {
  test("409 counts, as do 400s with an already-exists message or code", () => {
    expect(isAlreadyExists(new GraphError(409, "Conflict", "duplicate"))).toBe(true);
    expect(
      isAlreadyExists(new GraphError(400, "BadRequest", "Channel name already existed")),
    ).toBe(true);
    expect(isAlreadyExists(new GraphError(400, "NameAlreadyExists", ""))).toBe(true);
    expect(isAlreadyExists(new GraphError(400, "BadRequest", "bad team id"))).toBe(false);
    expect(isAlreadyExists(new GraphError(403, "Forbidden", "nope"))).toBe(false);
    expect(isAlreadyExists(new Error("409"))).toBe(false);
  });
});

describe("provisioning: channel creation with 409 fallback", () => {
  test("POST success returns the new channel id", async () => {
    const posts: [string, unknown][] = [];
    const graph: GraphProvisioner = {
      post: async (path, body) => {
        posts.push([path, body]);
        return { id: "chan-new" };
      },
      getAll: async () => {
        throw new Error("lookup must not run on success");
      },
    };
    const created = await createGraphChannel(graph, queueRow());
    expect(created).toEqual({ channelId: "chan-new", reused: false });
    expect(posts).toEqual([
      [
        `/teams/${TEAM_ID}/channels`,
        {
          displayName: "space365-test-channel",
          description: "created by test",
          membershipType: "standard",
        },
      ],
    ]);
  });

  test("409 resolves via displayName lookup and reports reuse", async () => {
    const lookups: string[] = [];
    const graph: GraphProvisioner = {
      post: async () => {
        throw new GraphError(409, "Conflict", "already exists");
      },
      getAll: async (path) => {
        lookups.push(path);
        return [{ id: "chan-existing", displayName: "space365-test-channel" }];
      },
    };
    const created = await createGraphChannel(graph, queueRow());
    expect(created).toEqual({ channelId: "chan-existing", reused: true });
    expect(lookups).toEqual([
      `/teams/${TEAM_ID}/channels?$filter=displayName eq 'space365-test-channel'`,
    ]);
  });

  test("409 with no matching channel rethrows the original error", async () => {
    const graph: GraphProvisioner = {
      post: async () => {
        throw new GraphError(409, "Conflict", "already exists");
      },
      getAll: async () => [],
    };
    await expect(createGraphChannel(graph, queueRow())).rejects.toThrow("Conflict");
  });

  test("non-conflict Graph errors pass through without lookup", async () => {
    const graph: GraphProvisioner = {
      post: async () => {
        throw new GraphError(403, "Forbidden", "missing role");
      },
      getAll: async () => {
        throw new Error("lookup must not run");
      },
    };
    await expect(createGraphChannel(graph, queueRow())).rejects.toThrow("Forbidden");
  });

  test("findChannelByName quotes names containing single quotes", async () => {
    const lookups: string[] = [];
    const graph = {
      getAll: async (path: string) => {
        lookups.push(path);
        return [];
      },
    };
    expect(await findChannelByName(graph, TEAM_ID, "Bob's room")).toBeNull();
    expect(lookups[0]).toContain("displayName eq 'Bob''s room'");
  });
});

describe("provisioning: error summaries stay short and token-free", () => {
  test("GraphError reduces to status + code only (no Graph message text)", () => {
    const summary = shortError(
      new GraphError(403, "Forbidden", "user bob@contoso.com may not ..."),
    );
    expect(summary).toBe("graph 403 Forbidden");
    expect(summary).not.toContain("bob@contoso.com");
  });

  test("generic errors are redacted and truncated", () => {
    expect(shortError(new Error(`fetch failed: Bearer eyJhbGciOi.abc.def`))).toBe(
      "fetch failed: Bearer <redacted>",
    );
    expect(shortError(new Error("x".repeat(500))).length).toBe(120);
  });
});

describe("provisioning: room slot assignment", () => {
  test("keeps the slot of an already-synced channel", async () => {
    const sql = sqlStub([
      ["chan-a", 703],
      ["chan-b", 704],
    ]);
    expect(await assignRoomForChannel(sql, TEAM_ID, "chan-b")).toBe(704);
  });

  test("assigns a free deterministic slot avoiding taken ones", async () => {
    const empty = sqlStub([]);
    const first = await assignRoomForChannel(empty, TEAM_ID, "chan-new");
    expect(Math.floor(first / 100)).toBe(7);
    expect(first % 100).toBeGreaterThanOrEqual(1);
    expect(first % 100).toBeLessThanOrEqual(24);

    // Same hash start now taken → open addressing moves to the next slot.
    const collided = sqlStub([["chan-other", first]]);
    const second = await assignRoomForChannel(collided, TEAM_ID, "chan-new");
    expect(second).not.toBe(first);
    expect(Math.floor(second / 100)).toBe(7);
  });

  test("fails when the team has no zone assignment", async () => {
    const sql: SqlReader = async () => [];
    await expect(assignRoomForChannel(sql, TEAM_ID, "chan-x")).rejects.toThrow(
      "no zone",
    );
  });
});

describe("provisioning: worker flow", () => {
  test("success path: create → room → upsert_channel → complete(true, id)", async () => {
    const { reducers, upserts, completions } = recordingReducers();
    const graph: GraphProvisioner = {
      post: async () => ({ id: "chan-new" }),
      getAll: async () => [],
    };
    const worker = new ProvisioningWorker({
      graph,
      reducers,
      sql: sqlStub([["chan-a", 701]]),
      log: () => {},
    });
    expect(await worker.processRequest(queueRow())).toBe(true);
    expect(upserts).toHaveLength(1);
    const upsert = upserts[0] as Record<string, unknown>;
    expect(upsert.channelId).toBe("chan-new");
    expect(upsert.teamId).toBe(TEAM_ID);
    expect(upsert.name).toBe("space365-test-channel");
    expect(upsert.visibility).toBe("standard");
    expect(upsert.isEnabled).toBe(true);
    expect(Math.floor((upsert.roomId as number) / 100)).toBe(7);
    expect(completions).toEqual([{ requestId: 7n, ok: true, resultRef: "chan-new" }]);
  });

  test("failure path: complete(false, short summary), no channel upsert", async () => {
    const { reducers, upserts, completions } = recordingReducers();
    const graph: GraphProvisioner = {
      post: async () => {
        throw new GraphError(403, "Forbidden", "app lacks Channel.Create for bob@x.com");
      },
      getAll: async () => [],
    };
    const worker = new ProvisioningWorker({
      graph,
      reducers,
      sql: sqlStub([]),
      log: () => {},
    });
    await worker.processRequest(queueRow());
    expect(upserts).toHaveLength(0);
    expect(completions).toEqual([
      { requestId: 7n, ok: false, resultRef: "graph 403 Forbidden" },
    ]);
  });

  test("unsupported kinds complete as failed instead of clogging the queue", async () => {
    const { reducers, upserts, completions } = recordingReducers();
    const worker = new ProvisioningWorker({
      graph: {
        post: async () => {
          throw new Error("graph must not be called");
        },
        getAll: async () => [],
      },
      reducers,
      sql: sqlStub([]),
      log: () => {},
    });
    await worker.processRequest(queueRow({ kind: "team" }));
    expect(upserts).toHaveLength(0);
    expect(completions).toEqual([
      { requestId: 7n, ok: false, resultRef: "unsupported kind: team" },
    ]);
  });

  test("debounce: each request id is processed exactly once per run", async () => {
    const { reducers, completions } = recordingReducers();
    let posts = 0;
    const worker = new ProvisioningWorker({
      graph: {
        post: async () => {
          posts++;
          return { id: `chan-${posts}` };
        },
        getAll: async () => [],
      },
      reducers,
      sql: sqlStub([]),
      log: () => {},
    });
    const row = queueRow();
    expect(await worker.processRequest(row)).toBe(true);
    expect(await worker.processRequest(row)).toBe(false); // e.g. onInsert replay
    expect(posts).toBe(1);
    expect(completions).toHaveLength(1);
  });

  test("processQueue drains in id order and skips already-processed rows", async () => {
    const { reducers, completions } = recordingReducers();
    const worker = new ProvisioningWorker({
      graph: { post: async () => ({ id: "chan" }), getAll: async () => [] },
      reducers,
      sql: sqlStub([]),
      log: () => {},
    });
    await worker.processRequest(queueRow({ id: 2n }));
    const handled = await worker.processQueue([
      queueRow({ id: 3n }),
      queueRow({ id: 1n }),
      queueRow({ id: 2n }), // already done above
    ]);
    expect(handled).toBe(2);
    expect(completions.map((c) => c.requestId)).toEqual([2n, 1n, 3n]);
  });
});
