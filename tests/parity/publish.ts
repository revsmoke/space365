/**
 * Pretest: (re-)publish the dedicated parity test database `space365test` with
 * --delete-data=always so every full suite run starts from a fresh world, then
 * drop the cached admin/service tokens (fresh db means fresh role bootstrap).
 *
 * Never touches the dev database `space365`.
 */
import { join } from "node:path";
import { clearTokenCache, DB_NAME } from "./harness.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const modulePath = join(repoRoot, "spacetime", "module");

console.log(`[parity] publishing ${DB_NAME} from ${modulePath} ...`);
const proc = Bun.spawnSync(
  [
    "spacetime",
    "publish",
    DB_NAME,
    "--server",
    "local",
    "--yes",
    "--delete-data=always",
    "--module-path",
    modulePath,
  ],
  { stdout: "inherit", stderr: "inherit" }
);

if (proc.exitCode !== 0) {
  console.error(`[parity] publish failed with exit code ${proc.exitCode}`);
  process.exit(proc.exitCode ?? 1);
}

clearTokenCache();
console.log("[parity] publish complete; token cache cleared");
