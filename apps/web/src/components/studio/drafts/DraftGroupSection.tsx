"use client";

import { Children, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  DraftGroupHeader,
  type DraftGroupHeaderProps,
} from "./DraftGroupHeader";

export type DraftGroupSectionProps = Omit<
  ComponentPropsWithoutRef<"section">,
  "children" | "aria-labelledby"
> &
  Pick<
    DraftGroupHeaderProps,
    | "groupId"
    | "name"
    | "description"
    | "isFocused"
    | "onFocusGroup"
    | "onRenameGroup"
    | "onCreateDraft"
    | "onDeleteGroup"
    | "onMoveGroup"
    | "isMoveUpDisabled"
    | "isMoveDownDisabled"
  > & {
    draftCount?: number;
    children?: ReactNode;
    emptyMessage?: string;
  };

export function DraftGroupSection({
  groupId,
  name,
  description,
  isFocused,
  onFocusGroup,
  onRenameGroup,
  onCreateDraft,
  onDeleteGroup,
  onMoveGroup,
  isMoveUpDisabled,
  isMoveDownDisabled,
  draftCount,
  children,
  emptyMessage = "No drafts in this group yet.",
  className,
  ...props
}: DraftGroupSectionProps) {
  const isEmpty = draftCount === 0 || Children.count(children) === 0;
  const headerId = `draft-group-${groupId}-label`;

  return (
    <section
      className={cn(
        "flex min-w-max shrink-0 flex-col gap-2 rounded-2xl border border-border/70 bg-background/20",
        className,
      )}
      aria-labelledby={headerId}
      data-draft-group-section
      data-draft-group-id={groupId}
      {...props}
    >
      <DraftGroupHeader
        groupId={groupId}
        name={name}
        description={description}
        draftCount={draftCount}
        isFocused={isFocused}
        onFocusGroup={onFocusGroup}
        onRenameGroup={onRenameGroup}
        onCreateDraft={onCreateDraft}
        onDeleteGroup={onDeleteGroup}
        onMoveGroup={onMoveGroup}
        isMoveUpDisabled={isMoveUpDisabled}
        isMoveDownDisabled={isMoveDownDisabled}
      />
      <div
        className="flex min-h-32 w-max min-w-full flex-row items-start gap-16"
        role="list"
        aria-label={`${name} drafts`}
        data-draft-group-drafts
      >
        {isEmpty ? (
          <div role="listitem">
            <p
              className="flex min-h-24 min-w-64 items-center justify-center rounded-xl border border-dashed border-border px-4 text-sm text-muted-foreground"
              role="status"
              data-testid="draft-group-empty"
            >
              {emptyMessage}
            </p>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
