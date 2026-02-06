export type KioskPolicy = {
  read_only: boolean;
  allow_personal_overlays: boolean;
  enable_deep_links: boolean;
};

export type RoomCard = {
  channel_id: string;
  title: string;
  msg_count: number;
  deep_link?: string;
};

export function createKioskPolicy(
  overrides: Partial<KioskPolicy> = {},
): KioskPolicy {
  return {
    read_only: true,
    allow_personal_overlays: false,
    enable_deep_links: false,
    ...overrides,
  };
}

export function toKioskRoomCard(card: RoomCard, policy: KioskPolicy): RoomCard {
  if (policy.enable_deep_links) {
    return card;
  }

  const { deep_link: _removed, ...rest } = card;
  return rest;
}
