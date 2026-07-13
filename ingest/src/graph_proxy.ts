export type GraphOverlayRoute = "mentions" | "meetingsSoon";

export type GraphFetchInit = {
  method: "GET";
  headers: Record<string, string>;
};

export type GraphFetchResponse = {
  status: number;
  json: () => Promise<unknown>;
};

type FetchGraph = (url: string, init: GraphFetchInit) => Promise<GraphFetchResponse>;

type GraphOBOProxyArgs = {
  allowPersonalOverlays: (userId: string) => boolean;
  getAccessTokenForUser: (userId: string) => Promise<string>;
  fetchGraph: FetchGraph;
  graphBaseUrl?: string;
};

export type GraphOverlayRequest = {
  userId: string;
  route: GraphOverlayRoute | string;
  nowIsoTimestamp?: string;
};

export type GraphOverlayResult = {
  status: number;
  body: unknown;
};

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

export function createGraphOBOProxy(args: GraphOBOProxyArgs) {
  const baseUrl = args.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL;

  async function fetchUserOverlay(request: GraphOverlayRequest): Promise<GraphOverlayResult> {
    if (!args.allowPersonalOverlays(request.userId)) {
      return {
        status: 403,
        body: { error: "Personal overlays are disabled for this user." },
      };
    }

    const routePath = buildRoutePath(request.route, request.nowIsoTimestamp);
    if (!routePath) {
      return {
        status: 400,
        body: { error: "Unsupported overlay route." },
      };
    }

    const token = await args.getAccessTokenForUser(request.userId);
    const response = await args.fetchGraph(`${baseUrl}${routePath}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const payload = await response.json();
    return {
      status: response.status,
      body: payload,
    };
  }

  return {
    fetchUserOverlay,
  };
}

function buildRoutePath(
  route: GraphOverlayRoute | string,
  nowIsoTimestamp?: string,
): string | null {
  if (route === "mentions") {
    return "/me/chats/getAllMessages?$top=25";
  }

  if (route === "meetingsSoon") {
    const start = nowIsoTimestamp ?? new Date().toISOString();
    const end = new Date(Date.parse(start) + 30 * 60 * 1000).toISOString();
    return `/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=25`;
  }

  return null;
}
