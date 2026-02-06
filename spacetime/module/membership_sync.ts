export type TeamRow = {
  team_id: string;
  name: string;
  is_enabled: boolean;
};

export type ChannelVisibility = "public" | "private";

export type ChannelRow = {
  channel_id: string;
  team_id: string;
  name: string;
  visibility: ChannelVisibility;
};

export type TeamMemberRow = {
  team_id: string;
  user_id: string;
  role: string;
};

export type ChannelMemberRow = {
  channel_id: string;
  user_id: string;
  role: string;
};

export type MembershipSnapshot = {
  teams: TeamRow[];
  channels: ChannelRow[];
  team_members: TeamMemberRow[];
  channel_members: ChannelMemberRow[];
};

export function createMembershipStore() {
  const teams = new Map<string, TeamRow>();
  const channels = new Map<string, ChannelRow>();
  const teamMembers = new Map<string, Set<string>>();
  const channelMembers = new Map<string, Set<string>>();

  function syncFromSnapshot(snapshot: MembershipSnapshot): void {
    teams.clear();
    channels.clear();
    teamMembers.clear();
    channelMembers.clear();

    for (const row of snapshot.teams) {
      teams.set(row.team_id, row);
    }

    for (const row of snapshot.channels) {
      channels.set(row.channel_id, row);
    }

    for (const row of snapshot.team_members) {
      const users = teamMembers.get(row.team_id) ?? new Set<string>();
      users.add(row.user_id);
      teamMembers.set(row.team_id, users);
    }

    for (const row of snapshot.channel_members) {
      const users = channelMembers.get(row.channel_id) ?? new Set<string>();
      users.add(row.user_id);
      channelMembers.set(row.channel_id, users);
    }
  }

  function canAccessChannel(userId: string, channelId: string): boolean {
    const channel = channels.get(channelId);
    if (!channel) {
      return false;
    }

    if (channel.visibility === "private") {
      return channelMembers.get(channelId)?.has(userId) ?? false;
    }

    return teamMembers.get(channel.team_id)?.has(userId) ?? false;
  }

  function getTeamMemberCount(teamId: string): number {
    return teamMembers.get(teamId)?.size ?? 0;
  }

  function getChannelMemberCount(channelId: string): number {
    return channelMembers.get(channelId)?.size ?? 0;
  }

  return {
    syncFromSnapshot,
    canAccessChannel,
    getTeamMemberCount,
    getChannelMemberCount,
  };
}
