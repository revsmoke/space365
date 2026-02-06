import type { createMembershipStore } from "../../spacetime/module/membership_sync";
import type { createWorldModule, RoomState } from "../../spacetime/module/world_module";

type WorldModule = ReturnType<typeof createWorldModule>;
type MembershipStore = ReturnType<typeof createMembershipStore>;

type ViewState = {
  channel_id: string;
  msg_count: number;
  react_count: number;
  last_activity_at: string;
};

type LiveClientArgs = {
  world: WorldModule;
  membership: MembershipStore;
  userId: string;
};

export function createLiveClient(args: LiveClientArgs) {
  const viewStateByChannel = new Map<string, ViewState>();
  const unsubscribers = new Map<string, () => void>();

  function watchChannel(channelId: string): boolean {
    if (!args.membership.canAccessChannel(args.userId, channelId)) {
      return false;
    }

    if (unsubscribers.has(channelId)) {
      return true;
    }

    const unsubscribe = args.world.subscribeRoom(channelId, (state) => {
      viewStateByChannel.set(channelId, mapRoomState(state));
    });

    unsubscribers.set(channelId, unsubscribe);
    return true;
  }

  function unwatchChannel(channelId: string): void {
    const unsubscribe = unsubscribers.get(channelId);
    if (!unsubscribe) {
      return;
    }
    unsubscribe();
    unsubscribers.delete(channelId);
    viewStateByChannel.delete(channelId);
  }

  function getViewState(channelId: string): ViewState | undefined {
    return viewStateByChannel.get(channelId);
  }

  return {
    watchChannel,
    unwatchChannel,
    getViewState,
  };
}

function mapRoomState(state: RoomState): ViewState {
  return {
    channel_id: state.channel_id,
    msg_count: state.msg_count,
    react_count: state.react_count,
    last_activity_at: state.last_activity_at,
  };
}
