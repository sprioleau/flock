export const UNGROUPED_DRAFT_GROUP_KEY = "__ungrouped__";

export interface DraftGroupLayoutGroup {
  _id: string;
  name: string;
  description?: string;
  orderIndex: number;
}

export interface DraftGroupLayoutDraft {
  _id: string;
  groupId?: string;
  groupOrderIndex?: number;
  orderIndex: number;
}

export interface DraftGroupLayoutRow<
  Group extends DraftGroupLayoutGroup,
  Draft extends DraftGroupLayoutDraft,
> {
  key: string;
  group: Group | null;
  drafts: Draft[];
  isUngrouped: boolean;
}

function sortDrafts<Draft extends DraftGroupLayoutDraft>(drafts: Draft[]): Draft[] {
  return drafts.sort(
    (first, second) =>
      (first.groupOrderIndex ?? first.orderIndex) -
      (second.groupOrderIndex ?? second.orderIndex),
  );
}

/*
  Resolve the strict vertical-group / horizontal-draft layout. A draft whose
  group disappeared between reactive snapshots is retained in Ungrouped.
*/
export function buildDraftGroupLayout<
  Group extends DraftGroupLayoutGroup,
  Draft extends DraftGroupLayoutDraft,
>({
  groups,
  drafts,
}: {
  groups: readonly Group[];
  drafts: readonly Draft[];
}): DraftGroupLayoutRow<Group, Draft>[] {
  const orderedGroups = [...groups].sort(
    (first, second) => first.orderIndex - second.orderIndex,
  );
  const knownGroupIds = new Set(orderedGroups.map((group) => group._id));
  const rows: DraftGroupLayoutRow<Group, Draft>[] = orderedGroups.map((group) => ({
    key: group._id,
    group,
    drafts: sortDrafts(drafts.filter((draft) => draft.groupId === group._id)),
    isUngrouped: false,
  }));
  const ungroupedDrafts = sortDrafts(
    drafts.filter(
      (draft) => draft.groupId === undefined || !knownGroupIds.has(draft.groupId),
    ),
  );
  if (ungroupedDrafts.length > 0 || rows.length === 0) {
    rows.push({
      key: UNGROUPED_DRAFT_GROUP_KEY,
      group: null,
      drafts: ungroupedDrafts,
      isUngrouped: true,
    });
  }
  return rows;
}

export function getReorderedDraftGroupIds({
  groupIds,
  groupId,
  direction,
}: {
  groupIds: readonly string[];
  groupId: string;
  direction: "up" | "down";
}): string[] {
  const nextIds = [...groupIds];
  const currentIndex = nextIds.indexOf(groupId);
  if (currentIndex < 0) {
    return nextIds;
  }
  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= nextIds.length) {
    return nextIds;
  }
  const displacedId = nextIds[nextIndex]!;
  nextIds[nextIndex] = groupId;
  nextIds[currentIndex] = displacedId;
  return nextIds;
}
