import { describe, expect, test } from "bun:test";
import { parseSqlTable } from "../ingest/src/stdb_sql";
import {
  channelMessagesResource,
  dryRunSubscriptionId,
  needsRenewal,
} from "../ingest/src/subscription_manager";
import { memberRole, visibilityFromMembershipType } from "../ingest/src/full_sync";

describe("spacetime sql output parsing", () => {
  test("parses header, separator, quoted strings and numbers", () => {
    const output = [
      "WARNING: This command is UNSTABLE and subject to breaking changes.",
      "",
      ' team_id    | zone_id ',
      '------------+---------',
      ' "team-eng" | 1       ',
      ' "t-2"      | 34      ',
      "",
    ].join("\n");
    expect(parseSqlTable(output)).toEqual([
      ["team-eng", "1"],
      ["t-2", "34"],
    ]);
  });

  test("returns empty for empty result sets", () => {
    expect(parseSqlTable(" user_id \n---------\n")).toEqual([]);
    expect(parseSqlTable("")).toEqual([]);
  });
});

describe("subscription manager", () => {
  test("renews when less than 20% of ttl remains", () => {
    const ttl = 55 * 60 * 1000;
    const now = 1_000_000_000;
    expect(needsRenewal(now + ttl * 0.19, now, ttl)).toBe(true);
    expect(needsRenewal(now + ttl * 0.5, now, ttl)).toBe(false);
    expect(needsRenewal(now - 1, now, ttl)).toBe(true); // already expired
  });

  test("dry-run subscription ids are deterministic per resource", () => {
    const resource = channelMessagesResource("team-1", "chan-1");
    expect(resource).toBe("teams/team-1/channels/chan-1/messages");
    expect(dryRunSubscriptionId(resource)).toBe(dryRunSubscriptionId(resource));
    expect(dryRunSubscriptionId(resource)).toMatch(/^dryrun-[0-9a-f]{8}$/);
    expect(dryRunSubscriptionId(resource)).not.toBe(
      dryRunSubscriptionId(channelMessagesResource("team-1", "chan-2")),
    );
  });
});

describe("full sync mapping", () => {
  test("membershipType maps to visibility", () => {
    expect(visibilityFromMembershipType("private")).toBe("private");
    expect(visibilityFromMembershipType("shared")).toBe("shared");
    expect(visibilityFromMembershipType("standard")).toBe("standard");
    expect(visibilityFromMembershipType(undefined)).toBe("standard");
  });

  test("owner role detection", () => {
    expect(memberRole(["owner"])).toBe("owner");
    expect(memberRole([])).toBe("member");
    expect(memberRole(undefined)).toBe("member");
  });
});
