/**
 * Read current module state via the `spacetime sql` CLI (owner identity).
 *
 * The ingest service needs read access to private tables (team, channel,
 * user, graph_cursor) to make deterministic layout decisions; the SDK client
 * cache only sees public tables/views, so we read through the CLI instead.
 * Only used for ids/numbers — cells must not contain '|'.
 */

export type StdbSqlOptions = {
  database?: string;
  server?: string;
};

export function parseSqlTable(output: string): string[][] {
  const lines = output.split(/\r?\n/);
  const separatorIndex = lines.findIndex((line) => /^-+(\+-+)*$/.test(line.replace(/\s/g, "")));
  if (separatorIndex < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(separatorIndex + 1)) {
    if (!line.trim()) continue;
    rows.push(line.split("|").map((cell) => unquoteCell(cell.trim())));
  }
  return rows;
}

function unquoteCell(cell: string): string {
  if (cell.startsWith('"') && cell.endsWith('"') && cell.length >= 2) {
    return cell.slice(1, -1);
  }
  return cell;
}

export async function stdbSql(
  query: string,
  options: StdbSqlOptions = {},
): Promise<string[][]> {
  const database = options.database ?? process.env.STDB_DATABASE ?? "space365";
  const server = options.server ?? process.env.STDB_SERVER ?? "local";
  const proc = Bun.spawn(
    ["spacetime", "sql", database, query, "--server", server],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`spacetime sql failed (${exitCode}): ${stderr.trim().slice(0, 500)}`);
  }
  return parseSqlTable(stdout);
}
