"use client";

import { useState, type ComponentPropsWithoutRef, type FormEvent, type KeyboardEvent } from "react";
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
  onCreateDraft?: (groupId: string) => void;
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

export function DraftGroupHeader({
  groupId,
  name,
  description,
  draftCount,
  isFocused = false,
  onFocusGroup,
  onRenameGroup,
  onCreateDraft,
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

  function handleFocusKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!isDraftGroupActivationKey(event)) {
      return;
    }
    event.preventDefault();
    onFocusGroup(groupId);
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
      {...props}
    >
      {isEditing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={commitEditing}
          data-draft-group-edit-form
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              maxLength={80}
              autoFocus
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
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              aria-label={`Save changes to ${name}`}
              data-testid="draft-group-save"
            >
              <CheckIcon />
            </Button>
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
          onClick={() => onFocusGroup(groupId)}
          onKeyDown={handleFocusKeyDown}
          aria-label={`Focus group ${name}`}
          aria-current={isFocused ? "true" : undefined}
          aria-describedby={description ? headerDescriptionId : undefined}
          data-action="focus-group"
          data-testid="draft-group-focus-target"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold" data-draft-group-name>
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={beginEditing}
          aria-label={`Edit ${name}`}
          data-testid="draft-group-edit"
        >
          <PencilIcon />
        </Button>
      ) : null}
      {!isEditing && onMoveGroup ? (
        <>
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
        </>
      ) : null}
      {!isEditing && onCreateDraft ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onCreateDraft(groupId)}
          aria-label={`Create draft in ${name}`}
          data-testid="draft-group-create-draft"
        >
          <PlusIcon />
        </Button>
      ) : null}
      {!isEditing && onDeleteGroup ? (
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
      ) : null}
    </header>
  );
}
