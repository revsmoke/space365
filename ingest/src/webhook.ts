export type GraphWebhookRequest = {
  method: "GET" | "POST";
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
};

type RawNotification = {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
};

export type GraphNotification = {
  subscription_id: string;
  client_state: string;
  change_type: string;
  resource: string;
  resource_id: string;
};

export type GraphWebhookContext = {
  clientState: string;
  knownSubscriptions: Set<string>;
};

export type GraphWebhookResult = {
  status: number;
  body: string;
  notifications: GraphNotification[];
};

export function handleGraphWebhook(
  req: GraphWebhookRequest,
  context: GraphWebhookContext,
): GraphWebhookResult {
  if (req.method === "GET") {
    const token = req.query.validationToken;
    if (!token) {
      return {
        status: 400,
        body: "Missing validationToken",
        notifications: [],
      };
    }

    return {
      status: 200,
      body: token,
      notifications: [],
    };
  }

  const body = req.body;
  if (!isNotificationEnvelope(body)) {
    return {
      status: 400,
      body: "Invalid webhook payload",
      notifications: [],
    };
  }

  const notifications: GraphNotification[] = [];
  for (const raw of body.value) {
    const normalized = normalizeNotification(raw);
    if (!normalized) {
      return {
        status: 400,
        body: "Invalid notification shape",
        notifications: [],
      };
    }

    if (normalized.client_state !== context.clientState) {
      return {
        status: 401,
        body: "Invalid clientState",
        notifications: [],
      };
    }

    if (!context.knownSubscriptions.has(normalized.subscription_id)) {
      return {
        status: 401,
        body: "Unknown subscriptionId",
        notifications: [],
      };
    }

    notifications.push(normalized);
  }

  return {
    status: 202,
    body: "Accepted",
    notifications,
  };
}

function normalizeNotification(raw: RawNotification): GraphNotification | null {
  if (!raw.subscriptionId || !raw.clientState || !raw.changeType || !raw.resource) {
    return null;
  }
  const resourceId = raw.resourceData?.id;
  if (!resourceId) {
    return null;
  }

  return {
    subscription_id: raw.subscriptionId,
    client_state: raw.clientState,
    change_type: raw.changeType,
    resource: raw.resource,
    resource_id: resourceId,
  };
}

function isNotificationEnvelope(value: unknown): value is { value: RawNotification[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    Array.isArray((value as { value: unknown }).value)
  );
}
