import { test, expect } from "bun:test";
import { createKioskPolicy, toKioskRoomCard } from "../web/client/kiosk_mode";

test("T10 kiosk policy defaults to strict read-only mode", () => {
  const policy = createKioskPolicy();
  expect(policy.read_only).toBe(true);
  expect(policy.allow_personal_overlays).toBe(false);
  expect(policy.enable_deep_links).toBe(false);
});

test("T10 kiosk room card strips deep links by default", () => {
  const card = toKioskRoomCard(
    {
      channel_id: "channel-1",
      title: "#general",
      msg_count: 5,
      deep_link: "https://teams.microsoft.com/l/message/...",
    },
    createKioskPolicy(),
  );

  expect(card.deep_link).toBeUndefined();
});
