export type PersonalQuestKind = "mention" | "meeting";
export type PersonalQuestStatus = "open" | "done" | "dismissed";

export type PersonalQuest = {
  quest_id: string;
  user_id: string;
  kind: PersonalQuestKind;
  title: string;
  source_ref: string;
  deeplink: string;
  created_at: string;
  status: PersonalQuestStatus;
};

type ListQuestArgs = {
  ownerUserId: string;
  viewerUserId: string;
  status?: PersonalQuestStatus;
};

export function createPersonalOverlayStore() {
  const optInByUser = new Map<string, boolean>();
  const questsByUser = new Map<string, Map<string, PersonalQuest>>();

  function setOptIn(userId: string, enabled: boolean): void {
    optInByUser.set(userId, enabled);
    if (!enabled) {
      questsByUser.delete(userId);
    }
  }

  function isOptedIn(userId: string): boolean {
    return optInByUser.get(userId) ?? false;
  }

  function upsertQuest(quest: PersonalQuest): boolean {
    if (!isOptedIn(quest.user_id)) {
      return false;
    }

    const userQuests = questsByUser.get(quest.user_id) ?? new Map<string, PersonalQuest>();
    userQuests.set(quest.quest_id, { ...quest });
    questsByUser.set(quest.user_id, userQuests);
    return true;
  }

  function listQuestsForViewer(args: ListQuestArgs): PersonalQuest[] {
    if (args.ownerUserId !== args.viewerUserId) {
      return [];
    }
    if (!isOptedIn(args.ownerUserId)) {
      return [];
    }

    const userQuests = questsByUser.get(args.ownerUserId);
    if (!userQuests) {
      return [];
    }

    const requestedStatus = args.status;
    const rows: PersonalQuest[] = [];
    for (const quest of userQuests.values()) {
      if (requestedStatus && quest.status !== requestedStatus) {
        continue;
      }
      rows.push({ ...quest });
    }
    return rows;
  }

  return {
    setOptIn,
    isOptedIn,
    upsertQuest,
    listQuestsForViewer,
  };
}
