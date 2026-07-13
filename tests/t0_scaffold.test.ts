import { existsSync } from "node:fs";
import { test, expect } from "bun:test";

const requiredDirectories = [
  "spacetime/module/src",
  "ingest/src",
  "ingest/src/surfaces",
  "web/client-app/src",
  "shared/types",
  "shared/bindings",
  "parity",
];

test("T0 scaffold directories exist", () => {
  for (const dir of requiredDirectories) {
    expect(existsSync(dir)).toBe(true);
  }
});
