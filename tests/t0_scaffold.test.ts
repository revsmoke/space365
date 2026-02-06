import { existsSync } from "node:fs";
import { test, expect } from "bun:test";

const requiredDirectories = [
  "spacetime/module",
  "ingest/src",
  "web/client",
  "web/admin",
  "shared/types",
];

test("T0 scaffold directories exist", () => {
  for (const dir of requiredDirectories) {
    expect(existsSync(dir)).toBe(true);
  }
});
