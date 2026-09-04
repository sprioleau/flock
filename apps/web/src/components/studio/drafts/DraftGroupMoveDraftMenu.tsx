"use client";

import { MoreHorizontalIcon, MoveRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type DraftGroupMoveDestination = {
  groupId: string;
  name: string;
};

export type DraftGroupMoveDraftInput = {
  draftId: string;
  fromGroupId: string;
  toGroupId: string;
};

export type DraftGroupMoveDraftMenuItemProps = {
  draftId: string;
  fromGroupId: string;
  destination: DraftGroupMoveDestination;
  onMoveDraft: (input: DraftGroupMoveDraftInput) => void;
};

export type DraftGroupMoveDraftMenuProps = {
  draftId: string;
  draftName?: string;
  currentGroupId: string;
  groups: readonly DraftGroupMoveDestination[];
  onMoveDraft: (input: DraftGroupMoveDraftInput) => void;
};

export function getDraftGroupMoveDestinations({
  groups,
  currentGroupId,
}: Pick<DraftGroupMoveDraftMenuProps, "groups" | "currentGroupId">): DraftGroupMoveDestination[] {
  return groups.filter((group) => group.groupId !== currentGroupId);
}

export function buildDraftGroupMoveDraftInput({
  draftId,
  fromGroupId,
  destination,
}: Pick<DraftGroupMoveDraftMenuItemProps, "draftId" | "fromGroupId" | "destination">): DraftGroupMoveDraftInput {
  return {
    draftId,
    fromGroupId,
    toGroupId: destination.groupId,
  };
}

export function DraftGroupMoveDraftMenuItem({
  draftId,
  fromGroupId,
  destination,
  onMoveDraft,
}: DraftGroupMoveDraftMenuItemProps) {
  return (
    <DropdownMenuItem
      onClick={() => onMoveDraft(buildDraftGroupMoveDraftInput({ draftId, fromGroupId, destination }))}
      data-action="move-draft"
      data-draft-group-destination={destination.groupId}
      data-testid={`draft-group-move-to-${destination.groupId}`}
    >
      <MoveRightIcon />
      <span className="truncate">{destination.name}</span>
    </DropdownMenuItem>
  );
}

export function DraftGroupMoveDraftMenu({
  draftId,
  draftName = "draft",
  currentGroupId,
  groups,
  onMoveDraft,
}: DraftGroupMoveDraftMenuProps) {
  const destinations = getDraftGroupMoveDestinations({ groups, currentGroupId });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={destinations.length === 0}
            aria-label={`Move ${draftName} to another group`}
            data-testid="draft-group-move-trigger"
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Move draft to…</DropdownMenuLabel>
          {destinations.length === 0 ? (
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              Create another group first.
            </DropdownMenuLabel>
          ) : (
            destinations.map((destination) => (
              <DraftGroupMoveDraftMenuItem
                key={destination.groupId}
                draftId={draftId}
                fromGroupId={currentGroupId}
                destination={destination}
                onMoveDraft={onMoveDraft}
              />
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
