import type {
  createPersonalOverlayStore,
  PersonalQuest,
} from "../../spacetime/module/personal_overlays";
import type { createGraphOBOProxy, GraphOverlayRoute } from "../../ingest/src/graph_proxy";

type PersonalOverlayStore = ReturnType<typeof createPersonalOverlayStore>;
type GraphOBOProxy = ReturnType<typeof createGraphOBOProxy>;

type PersonalOverlayClientArgs = {
  userId: string;
  store: PersonalOverlayStore;
  proxy: GraphOBOProxy;
};

type SyncResult = {
  created: number;
  status: number;
};

export function createPersonalOverlayClient(args: PersonalOverlayClientArgs) {
  function setOptIn(enabled: boolean): void {
    args.store.setOptIn(args.userId, enabled);
  }

  function isOptedIn(): boolean {
    return args.store.isOptedIn(args.userId);
  }

  async function syncFromGraph(route: GraphOverlayRoute): Promise<SyncResult> {
    if (!isOptedIn()) {
      return { created: 0, status: 204 };
    }

    const response = await args.proxy.fetchUserOverlay({
      userId: args.userId,
      route,
    });
    if (response.status !== 200) {
      return { created: 0, status: response.status };
    }

    const records = parseValueArray(response.body);
    let created = 0;

    for (const record of records) {
      const quest = mapRecordToQuest(route, args.userId, record);
      if (!quest) {
        continue;
      }
      const accepted = args.store.upsertQuest(quest);
      if (accepted) {
        created += 1;
      }
    }

    return { created, status: response.status };
  }

  function getMyOpenQuests(): PersonalQuest[] {
    return args.store.listQuestsForViewer({
      ownerUserId: args.userId,
      viewerUserId: args.userId,
      status: "open",
    });
  }

  return {
    setOptIn,
    isOptedIn,
    syncFromGraph,
    getMyOpenQuests,
  };
}

function parseValueArray(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body)) {
    return [];
  }
  const value = body.value;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function mapRecordToQuest(
  route: GraphOverlayRoute,
  userId: string,
  record: Record<string, unknown>,
): PersonalQuest | null {
  const id = asString(record.id);
  if (!id) {
    return null;
  }

  const subject = asString(record.subject) ?? fallbackTitle(route);
  const webLink = asString(record.webLink) ?? "";
  const kind = route === "mentions" ? "mention" : "meeting";

  return {
    quest_id: `${kind}:${id}`,
    user_id: userId,
    kind,
    title: subject,
    source_ref: id,
    deeplink: webLink,
    created_at: new Date().toISOString(),
    status: "open",
  };
}

function fallbackTitle(route: GraphOverlayRoute): string {
  if (route === "mentions") {
    return "New mention";
  }
  return "Upcoming meeting";
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function asString(input: unknown): string | null {
  return typeof input === "string" && input.length > 0 ? input : null;
}
