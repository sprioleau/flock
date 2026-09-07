"use client";

import {
  useState,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButtonTooltip } from "@/components/ui/icon-button-tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type DraftGroupRenameValue = {
  name: string;
  description?: string;
};

export type DraftGroupHeaderProps = Omit<
  ComponentPropsWithoutRef<"header">,
  "children" | "onClick" | "onKeyDown"
> & {
  groupId: string;
  name: string;
  description?: string;
  draftCount?: number;
  isFocused?: boolean;
  onFocusGroup: (groupId: string) => void;
  onRenameGroup?: (groupId: string, value: DraftGroupRenameValue) => void;
  onCreateGroup?: () => void;
  onDeleteGroup?: (groupId: string) => void;
  onMoveGroup?: (groupId: string, direction: "up" | "down") => void;
  isMoveUpDisabled?: boolean;
  isMoveDownDisabled?: boolean;
};

export function normalizeDraftGroupRenameValue(
  value: DraftGroupRenameValue,
): DraftGroupRenameValue | null {
  const name = value.name.trim();
  if (name.length === 0) {
    return null;
  }

  const description = value.description?.trim();
  return description === undefined || description.length === 0
    ? { name }
    : { name, description };
}

export function isDraftGroupActivationKey(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "Enter" || event.key === " ";
}

export function isDraftGroupRenameActivationKey(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "F2";
}

export function getDraftGroupEditExitAction(
  event: Pick<KeyboardEvent, "key">,
): "commit" | "cancel" | null {
  if (event.key === "Enter") {
    return "commit";
  }
  if (event.key === "Escape") {
    return "cancel";
  }
  return null;
}

export function getShouldCommitDraftGroupEditOnBlur({
  isFocusWithinEditor,
}: {
  isFocusWithinEditor: boolean;
}): boolean {
  return !isFocusWithinEditor;
}

export function getDraftGroupClickAction({
  isNameTarget,
  isInteractiveControl,
}: {
  isNameTarget: boolean;
  isInteractiveControl: boolean;
}): "rename" | "focus" | "ignore" {
  if (isNameTarget) {
    return "rename";
  }
  if (isInteractiveControl) {
    return "ignore";
  }
  return "focus";
}

export function DraftGroupHeader({
  groupId,
  name,
  description,
  draftCount,
  isFocused = false,
  onFocusGroup,
  onRenameGroup,
  onCreateGroup,
  onDeleteGroup,
  onMoveGroup,
  isMoveUpDisabled = false,
  isMoveDownDisabled = false,
  className,
  ...props
}: DraftGroupHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [nameInput, setNameInput] = useState(name);
  const [descriptionInput, setDescriptionInput] = useState(description ?? "");
  const headerLabelId = `draft-group-${groupId}-label`;
  const headerDescriptionId = `draft-group-${groupId}-description`;
  const draftCountLabel =
    draftCount === undefined
      ? undefined
      : `${draftCount} draft${draftCount === 1 ? "" : "s"}`;

  function beginEditing(): void {
    setNameInput(name);
    setDescriptionInput(description ?? "");
    setIsEditing(true);
  }

  function cancelEditing(): void {
    setNameInput(name);
    setDescriptionInput(description ?? "");
    setIsEditing(false);
  }

  function commitEditing(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    const value = normalizeDraftGroupRenameValue({
      name: nameInput,
      description: descriptionInput,
    });
    if (value === null) {
      cancelEditing();
      return;
    }
    onRenameGroup?.(groupId, value);
    setIsEditing(false);
  }

  function handleFocusKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (
      event.target instanceof Element &&
      event.target !== event.currentTarget &&
      event.target.closest("button, a, input, textarea, select") !== null
    ) {
      return;
    }
    if (isDraftGroupRenameActivationKey(event) && onRenameGroup !== undefined) {
      event.preventDefault();
      beginEditing();
      return;
    }
    if (!isDraftGroupActivationKey(event)) {
      return;
    }
    event.preventDefault();
    onFocusGroup(groupId);
  }

  function handleGroupHeaderClick(event: MouseEvent<HTMLElement>): void {
    const isNameTarget =
      event.target instanceof Element &&
      event.target.closest("[data-action='rename-group-from-name']") !== null;
    const isInteractiveControl =
      event.target instanceof Element &&
      event.target.closest("button, a, input, textarea, select") !== null;
    const action = getDraftGroupClickAction({ isNameTarget, isInteractiveControl });
    if (action === "rename") {
      if (onRenameGroup !== undefined) {
        beginEditing();
      } else {
        onFocusGroup(groupId);
      }
    } else if (action === "focus") {
      onFocusGroup(groupId);
    }
  }

  return (
    <header
      className={cn(
        "flex min-h-14 items-center gap-2 rounded-xl border bg-card/80 px-2 py-1.5 shadow-sm",
        isFocused ? "border-primary/60 bg-primary/5" : "border-border",
        className,
      )}
      data-draft-group-header
      data-draft-group-id={groupId}
      data-action="focus-group"
      aria-label={`Focus group ${name}`}
      tabIndex={0}
      onClick={handleGroupHeaderClick}
      onKeyDown={handleFocusKeyDown}
      {...props}
    >
      {isEditing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={commitEditing}
          onBlur={(event) => {
            const isFocusWithinEditor =
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget);
            if (getShouldCommitDraftGroupEditOnBlur({ isFocusWithinEditor })) {
              commitEditing();
            }
          }}
          onKeyDown={(event) => {
            const action = getDraftGroupEditExitAction(event);
            if (action === null) {
              return;
            }
            event.preventDefault();
            if (action === "cancel") {
              cancelEditing();
            } else {
              commitEditing();
            }
          }}
          data-draft-group-edit-form
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              id={headerLabelId}
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              maxLength={80}
              autoFocus
              onFocus={(event) => event.target.select()}
              aria-label="Group name"
              data-testid="draft-group-name-input"
            />
            <Textarea
              value={descriptionInput}
              onChange={(event) => setDescriptionInput(event.target.value)}
              maxLength={160}
              rows={1}
              placeholder="Optional description"
              aria-label="Group description"
              data-testid="draft-group-description-input"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButtonTooltip label={`Save changes to ${name}`}>
              <Button
                type="submit"
                variant="ghost"
                size="icon-sm"
                aria-label={`Save changes to ${name}`}
                data-testid="draft-group-save"
              >
                <CheckIcon />
              </Button>
            </IconButtonTooltip>
            <IconButtonTooltip label={`Cancel editing ${name}`}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={cancelEditing}
                aria-label={`Cancel editing ${name}`}
                data-testid="draft-group-cancel"
              >
                <XIcon />
              </Button>
            </IconButtonTooltip>
          </div>
        </form>
      ) : (
        <button
          type="button"
          id={headerLabelId}
          className={cn(
            "min-w-0 flex-1 rounded-lg px-2 py-1 text-left outline-none transition-colors",
            "hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50",
          )}
          onClick={(event) => {
            event.stopPropagation();
            if (onRenameGroup !== undefined) {
              beginEditing();
            } else {
              onFocusGroup(groupId);
            }
          }}
          onKeyDown={(event) => {
            if (isDraftGroupActivationKey(event)) {
              event.stopPropagation();
              return;
            }
            if (isDraftGroupRenameActivationKey(event) && onRenameGroup !== undefined) {
              event.preventDefault();
              event.stopPropagation();
              beginEditing();
            }
          }}
          aria-label={
            onRenameGroup === undefined ? `Focus group ${name}` : `Rename group ${name}`
          }
          aria-current={isFocused ? "true" : undefined}
          aria-describedby={description ? headerDescriptionId : undefined}
          data-action={
            onRenameGroup === undefined ? "focus-group" : "rename-group-from-name"
          }
          data-testid="draft-group-focus-target"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "truncate text-sm font-semibold",
                onRenameGroup !== undefined && "cursor-text",
              )}
              title={
                onRenameGroup === undefined ? undefined : `Click to rename ${name}`
              }
              data-draft-group-name
            >
              {name}
            </span>
            {draftCountLabel ? (
              <span className="shrink-0 text-xs text-muted-foreground" data-draft-group-count>
                {draftCountLabel}
              </span>
            ) : null}
          </span>
          {description ? (
            <span
              className="mt-0.5 block truncate text-xs text-muted-foreground"
              id={headerDescriptionId}
              data-draft-group-description
            >
              {description}
            </span>
          ) : null}
        </button>
      )}
      {!isEditing && onRenameGroup ? (
        <IconButtonTooltip label="Rename group">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={beginEditing}
            aria-label={`Rename group ${name}`}
            data-testid="draft-group-edit"
          >
            <PencilIcon />
          </Button>
        </IconButtonTooltip>
      ) : null}
      {!isEditing && onMoveGroup ? (
        <>
          <IconButtonTooltip label={`Move ${name} up`}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={isMoveUpDisabled}
              onClick={() => onMoveGroup(groupId, "up")}
              aria-label={`Move ${name} up`}
              data-testid="draft-group-move-up"
            >
              <ArrowUpIcon />
            </Button>
          </IconButtonTooltip>
          <IconButtonTooltip label={`Move ${name} down`}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={isMoveDownDisabled}
              onClick={() => onMoveGroup(groupId, "down")}
              aria-label={`Move ${name} down`}
              data-testid="draft-group-move-down"
            >
              <ArrowDownIcon />
            </Button>
          </IconButtonTooltip>
        </>
      ) : null}
      {!isEditing && onCreateGroup ? (
        <IconButtonTooltip label="Create new group">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onCreateGroup}
            aria-label="Create new group"
            data-testid="draft-group-create-group"
          >
            <PlusIcon />
          </Button>
        </IconButtonTooltip>
      ) : null}
      {!isEditing && onDeleteGroup ? (
        <IconButtonTooltip label={`Delete group ${name}`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onDeleteGroup(groupId)}
            aria-label={`Delete group ${name}`}
            data-testid="draft-group-delete"
          >
            <Trash2Icon />
          </Button>
        </IconButtonTooltip>
      ) : null}
    </header>
  );
}
