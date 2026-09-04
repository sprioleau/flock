import { describe, expect, it } from "vitest";
import {
  UNGROUPED_DRAFT_GROUP_KEY,
  buildDraftGroupLayout,
  getReorderedDraftGroupIds,
} from "./draft-group-layout";

describe("draft group layout", () => {
  it("orders groups vertically and drafts horizontally within each group", () => {
    const groups = [
      { _id: "light", name: "Light", orderIndex: 2 },
      { _id: "dark", name: "Dark", orderIndex: 1 },
    ];
    const drafts = [
      { _id: "dark-b", groupId: "dark", groupOrderIndex: 1, orderIndex: 0 },
      { _id: "loose", orderIndex: 3 },
      { _id: "dark-a", groupId: "dark", groupOrderIndex: 0, orderIndex: 2 },
    ];

    const rows = buildDraftGroupLayout({ groups, drafts });

    expect(rows.map((row) => row.key)).toEqual(["dark", "light", UNGROUPED_DRAFT_GROUP_KEY]);
    expect(rows[0]!.drafts.map((draft) => draft._id)).toEqual(["dark-a", "dark-b"]);
    expect(rows[1]!.drafts).toEqual([]);
    expect(rows[2]!.drafts.map((draft) => draft._id)).toEqual(["loose"]);
  });

  it("keeps legacy and temporarily orphaned drafts visible in Ungrouped", () => {
    const rows = buildDraftGroupLayout({
      groups: [{ _id: "kept", name: "Kept", orderIndex: 0 }],
      drafts: [
        { _id: "legacy", orderIndex: 0 },
        { _id: "orphan", groupId: "deleted", groupOrderIndex: 0, orderIndex: 1 },
      ],
    });

    expect(rows.at(-1)?.drafts.map((draft) => draft._id)).toEqual(["legacy", "orphan"]);
  });

  it("moves a group by one position without mutating the source order", () => {
    const ids = ["one", "two", "three"];

    expect(getReorderedDraftGroupIds({ groupIds: ids, groupId: "two", direction: "down" })).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(getReorderedDraftGroupIds({ groupIds: ids, groupId: "one", direction: "up" })).toEqual(ids);
    expect(ids).toEqual(["one", "two", "three"]);
  });
});
