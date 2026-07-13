import { test, expect } from "bun:test";
import {
  handleGraphWebhook,
  type GraphWebhookRequest,
} from "../ingest/src/webhook";

test("T3 responds to Graph validation token challenge", () => {
  const req: GraphWebhookRequest = {
    method: "GET",
    query: { validationToken: "token-123" },
    headers: {},
    body: null,
  };

  const res = handleGraphWebhook(req, {
    clientState: "expected-client-state",
    knownSubscriptions: new Set(),
  });

  expect(res.status).toBe(200);
  expect(res.body).toBe("token-123");
});

test("T3 validates clientState and subscriptionId on notifications", () => {
  const req: GraphWebhookRequest = {
    method: "POST",
    query: {},
    headers: {},
    body: {
      value: [
        {
          subscriptionId: "sub-1",
          clientState: "expected-client-state",
          changeType: "created",
          resource: "teams/team-1/channels/channel-1/messages/msg-1",
          resourceData: { id: "msg-1" },
        },
      ],
    },
  };

  const res = handleGraphWebhook(req, {
    clientState: "expected-client-state",
    knownSubscriptions: new Set(["sub-1"]),
  });

  expect(res.status).toBe(202);
  expect(res.notifications.length).toBe(1);
});

test("T3 rejects notification with unknown subscription", () => {
  const req: GraphWebhookRequest = {
    method: "POST",
    query: {},
    headers: {},
    body: {
      value: [
        {
          subscriptionId: "sub-unknown",
          clientState: "expected-client-state",
          changeType: "created",
          resource: "teams/team-1/channels/channel-1/messages/msg-1",
          resourceData: { id: "msg-1" },
        },
      ],
    },
  };

  const res = handleGraphWebhook(req, {
    clientState: "expected-client-state",
    knownSubscriptions: new Set(["sub-1"]),
  });

  expect(res.status).toBe(401);
});
