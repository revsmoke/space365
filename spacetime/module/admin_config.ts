import type { createMembershipStore } from "./membership_sync";

type MembershipStore = ReturnType<typeof createMembershipStore>;

export type PrivacyConfig = {
  allow_presence: boolean;
  allow_aggregates: boolean;
  allow_content_on_click: boolean;
  safe_mode: boolean;
};

export function createAdminConfigStore() {
  const allowlistedChannels = new Set<string>();
  let privacyConfig: PrivacyConfig = {
    allow_presence: true,
    allow_aggregates: true,
    allow_content_on_click: false,
    safe_mode: false,
  };

  function setAllowlistedChannels(channelIds: string[]): void {
    allowlistedChannels.clear();
    for (const id of channelIds) {
      allowlistedChannels.add(id);
    }
  }

  function isChannelAllowlisted(channelId: string): boolean {
    return allowlistedChannels.has(channelId);
  }

  function setPrivacyConfig(next: Partial<PrivacyConfig>): void {
    privacyConfig = { ...privacyConfig, ...next };
  }

  function getPrivacyConfig(): PrivacyConfig {
    return { ...privacyConfig };
  }

  function canViewChannel(input: {
    userId: string;
    channelId: string;
    membership: MembershipStore;
  }): boolean {
    if (!isChannelAllowlisted(input.channelId)) {
      return false;
    }

    return input.membership.canAccessChannel(input.userId, input.channelId);
  }

  return {
    setAllowlistedChannels,
    isChannelAllowlisted,
    setPrivacyConfig,
    getPrivacyConfig,
    canViewChannel,
  };
}
