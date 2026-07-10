/**
 * Thin Microsoft Graph HTTP client: bearer auth, paging, 429/503 retry.
 * All reads are app-only (client-credentials token from graph_auth).
 */

export class GraphError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(`Graph ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export type GraphClientOptions = {
  getToken: () => Promise<string>;
  baseUrl?: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Per-attempt request timeout; a hung Graph call must not hang the service. */
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";

export class GraphClient {
  #getToken: () => Promise<string>;
  #baseUrl: string;
  #maxRetries: number;
  #fetch: typeof fetch;
  #timeoutMs: number;

  constructor(options: GraphClientOptions) {
    this.#getToken = options.getToken;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  #resolveUrl(pathOrUrl: string): string {
    return pathOrUrl.startsWith("https://")
      ? pathOrUrl
      : `${this.#baseUrl}${pathOrUrl}`;
  }

  async request(
    method: string,
    pathOrUrl: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const url = this.#resolveUrl(pathOrUrl);
    for (let attempt = 0; ; attempt++) {
      const token = await this.#getToken();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted && attempt < this.#maxRetries) {
          continue; // timed out — retry like a 503
        }
        if (controller.signal.aborted) {
          throw new GraphError(0, "timeout", `no response within ${this.#timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (
        (response.status === 429 || response.status === 503) &&
        attempt < this.#maxRetries
      ) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "2");
        await sleep(Math.min(retryAfter, 30) * 1000);
        continue;
      }

      if (response.status === 204) {
        return { status: 204, json: null };
      }

      const json = await response.json().catch(() => null);
      if (!response.ok) {
        const err = extractError(json);
        throw new GraphError(response.status, err.code, err.message);
      }
      return { status: response.status, json };
    }
  }

  async get(pathOrUrl: string): Promise<unknown> {
    return (await this.request("GET", pathOrUrl)).json;
  }

  async post(pathOrUrl: string, body: unknown): Promise<unknown> {
    return (await this.request("POST", pathOrUrl, body)).json;
  }

  async patch(pathOrUrl: string, body: unknown): Promise<unknown> {
    return (await this.request("PATCH", pathOrUrl, body)).json;
  }

  async delete(pathOrUrl: string): Promise<void> {
    await this.request("DELETE", pathOrUrl);
  }

  /** Follow @odata.nextLink pages, accumulating `value` up to `limit` items. */
  async getAll(path: string, limit = Infinity): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let next: string | undefined = path;
    while (next && items.length < limit) {
      const page = (await this.get(next)) as {
        value?: Record<string, unknown>[];
        "@odata.nextLink"?: string;
      };
      for (const item of page.value ?? []) {
        items.push(item);
        if (items.length >= limit) break;
      }
      next = page["@odata.nextLink"];
    }
    return items;
  }
}

function extractError(json: unknown): { code: string; message: string } {
  if (
    typeof json === "object" &&
    json !== null &&
    "error" in json &&
    typeof (json as { error: unknown }).error === "object" &&
    (json as { error: unknown }).error !== null
  ) {
    const error = (json as { error: Record<string, unknown> }).error;
    return {
      code: String(error.code ?? "unknown"),
      message: String(error.message ?? ""),
    };
  }
  return { code: "unknown", message: "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
