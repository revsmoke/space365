/**
 * Delta reconciliation (SPEC §5 sync strategy, POC-7 pattern).
 *
 * Extends the reconcile.ts cursor-store idea to real Graph deltas persisted
 * in the module: delta links live in `graph_cursor` via set_graph_cursor.
 * /users is the first real delta resource — first run walks the full set,
 * later runs replay only changes (including @removed → is_active=false).
 */
import { GraphClient } from "./graph_client";
import { stdbSql } from "./stdb_sql";
import type { StdbWriter } from "./stdb_writer";

export const USERS_DELTA_RESOURCE = "users";
const USERS_DELTA_INITIAL_URL =
  "/users/delta?$select=id,displayName,department,jobTitle,accountEnabled";

type DeltaUser = {
  id?: string;
  displayName?: string;
  department?: string;
  jobTitle?: string;
  accountEnabled?: boolean;
  "@removed"?: { reason?: string };
};

export type UsersDeltaResult = {
  upserted: number;
  removed: number;
  pages: number;
  resumedFromCursor: boolean;
};

export async function loadDeltaLink(resource: string): Promise<string | null> {
  const rows = await stdbSql(
    `SELECT delta_link FROM graph_cursor WHERE resource = '${resource}'`,
  );
  return rows[0]?.[0] || null;
}

export async function runUsersDelta(
  graph: GraphClient,
  writer: StdbWriter,
  log: (line: string) => void = console.log,
): Promise<UsersDeltaResult> {
  const cursor = await loadDeltaLink(USERS_DELTA_RESOURCE);
  const result: UsersDeltaResult = {
    upserted: 0,
    removed: 0,
    pages: 0,
    resumedFromCursor: cursor !== null,
  };

  let next: string | null = cursor ?? USERS_DELTA_INITIAL_URL;
  let deltaLink: string | null = null;

  while (next) {
    const page = (await graph.get(next)) as {
      value?: DeltaUser[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    result.pages++;

    for (const user of page.value ?? []) {
      if (!user.id) continue;
      if (user["@removed"]) {
        // Keep the row (referenced by history) but deactivate it. Preserve
        // the stored display name; delta removals carry no profile fields.
        const existing = await stdbSql(
          `SELECT display_name, dept, title FROM user WHERE user_id = '${user.id}'`,
        );
        await writer.upsertUser({
          userId: user.id,
          displayName: existing[0]?.[0] ?? "",
          dept: existing[0]?.[1] ?? "",
          title: existing[0]?.[2] ?? "",
          isActive: false,
        });
        result.removed++;
      } else {
        await writer.upsertUser({
          userId: user.id,
          displayName: user.displayName ?? "",
          dept: user.department ?? "",
          title: user.jobTitle ?? "",
          isActive: user.accountEnabled !== false,
        });
        result.upserted++;
      }
    }

    deltaLink = page["@odata.deltaLink"] ?? null;
    next = page["@odata.nextLink"] ?? null;
  }

  if (deltaLink) {
    await writer.setGraphCursor({
      resource: USERS_DELTA_RESOURCE,
      deltaLink,
    });
  }

  log(
    `delta.users pages=${result.pages} upserted=${result.upserted} removed=${result.removed} ` +
      `resumed=${result.resumedFromCursor} cursor_stored=${deltaLink !== null}`,
  );
  return result;
}
