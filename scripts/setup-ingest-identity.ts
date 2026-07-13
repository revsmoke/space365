/**
 * Bootstrap the ingest service identity (P1.6 setup).
 *
 * 1. Connects to local SpacetimeDB, persisting the connection token to
 *    ingest/.stdb-token (stable service identity).
 * 2. Prints the identity hex.
 * 3. Grants it the 'service' role via the CLI (the CLI identity is admin):
 *      spacetime call space365 grant_role '"<hex>"' '"service"' --server local
 *
 * Run: bun run scripts/setup-ingest-identity.ts
 */
import { connectStdb } from "../ingest/src/stdb_writer";
import { stdbSql } from "../ingest/src/stdb_sql";

const database = process.env.STDB_DATABASE ?? "space365";
const server = process.env.STDB_SERVER ?? "local";

const stdb = await connectStdb();
console.log(`ingest.identity=${stdb.identityHex}`);
console.log("ingest.token.file=ingest/.stdb-token");

const existing = await stdbSql(
  `SELECT role FROM role_grant WHERE identity = 0x${stdb.identityHex}`,
  { database, server },
);
if (existing.length > 0 && existing[0][0] === "service") {
  console.log("ingest.role=service (already granted)");
} else {
  const proc = Bun.spawn(
    [
      "spacetime",
      "call",
      database,
      "grant_role",
      `"${stdb.identityHex}"`,
      '"service"',
      "--server",
      server,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    console.error(`grant_role failed (${exitCode}): ${stderr.trim()}`);
    process.exit(1);
  }
  console.log("ingest.role=service (granted)");
}

const verify = await stdbSql(
  `SELECT role FROM role_grant WHERE identity = 0x${stdb.identityHex}`,
  { database, server },
);
console.log(`ingest.role.verified=${verify[0]?.[0] ?? "MISSING"}`);

stdb.disconnect();
process.exit(0);
