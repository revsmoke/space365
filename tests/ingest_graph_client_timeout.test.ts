import { test, expect } from "bun:test";
import { GraphClient, GraphError } from "../ingest/src/graph_client";

test("graph client aborts hung requests and retries, then fails with timeout GraphError (PR2 review)", async () => {
  let calls = 0;
  const hangingFetch = ((_url: string, init?: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  }) as unknown as typeof fetch;

  const client = new GraphClient({
    getToken: async () => "tok",
    fetchImpl: hangingFetch,
    timeoutMs: 20,
    maxRetries: 1,
  });

  const started = Date.now();
  await expect(client.get("/me")).rejects.toThrow(GraphError);
  expect(calls).toBe(2); // initial attempt + one retry
  expect(Date.now() - started).toBeLessThan(2000);
});

test("graph client returns normally under the timeout", async () => {
  const okFetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  const client = new GraphClient({ getToken: async () => "tok", fetchImpl: okFetch, timeoutMs: 1000 });
  expect((await client.get("/me")) as { ok: boolean }).toEqual({ ok: true });
});
