import type { createAdminConfigStore } from "../../spacetime/module/admin_config";
import type { createMembershipStore } from "../../spacetime/module/membership_sync";

type AdminConfigStore = ReturnType<typeof createAdminConfigStore>;
type MembershipStore = ReturnType<typeof createMembershipStore>;

export type ChannelRecord = {
  channel_id: string;
  name: string;
};

type LinkStore = ReturnType<typeof createFastTravelLinkStore>;

type SearchFastTravelServiceArgs = {
  userId: string;
  membership: MembershipStore;
  config: AdminConfigStore;
  channels: ChannelRecord[];
  linkStore?: LinkStore;
};

export function createFastTravelLinkStore() {
  let sequence = 0;
  const tokenToChannel = new Map<string, string>();

  function issue(channelId: string): string {
    sequence += 1;
    const token = `loc-${sequence.toString(36)}`;
    tokenToChannel.set(token, channelId);
    return token;
  }

  function resolve(token: string): string | undefined {
    return tokenToChannel.get(token);
  }

  return { issue, resolve };
}

export function createSearchFastTravelService(args: SearchFastTravelServiceArgs) {
  const linkStore = args.linkStore ?? createFastTravelLinkStore();

  function searchChannels(query: string): ChannelRecord[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    return args.channels.filter((channel) => {
      if (!channel.name.toLowerCase().includes(normalizedQuery)) {
        return false;
      }
      return args.config.canViewChannel({
        userId: args.userId,
        channelId: channel.channel_id,
        membership: args.membership,
      });
    });
  }

  function createLocationLink(channelId: string): string | null {
    const canView = args.config.canViewChannel({
      userId: args.userId,
      channelId,
      membership: args.membership,
    });
    if (!canView) {
      return null;
    }

    const token = linkStore.issue(channelId);
    return `space365://loc/${token}`;
  }

  function resolveLocationLink(link: string): { channel_id: string } | null {
    const token = parseToken(link);
    if (!token) {
      return null;
    }

    const channelId = linkStore.resolve(token);
    if (!channelId) {
      return null;
    }

    const canView = args.config.canViewChannel({
      userId: args.userId,
      channelId,
      membership: args.membership,
    });
    if (!canView) {
      return null;
    }

    return { channel_id: channelId };
  }

  return {
    searchChannels,
    createLocationLink,
    resolveLocationLink,
  };
}

function parseToken(link: string): string | null {
  const prefix = "space365://loc/";
  if (!link.startsWith(prefix)) {
    return null;
  }
  const token = link.slice(prefix.length);
  if (token.length === 0) {
    return null;
  }
  return token;
}
