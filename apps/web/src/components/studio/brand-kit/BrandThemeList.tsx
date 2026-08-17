"use client";

import { useMemo, useState } from "react";
import { Loader2Icon, PencilLineIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { BrandColor, BrandKitFonts, ThemeVariation } from "@/lib/brand-kit";
import {
  buildEditedThemeVariation,
  getPaletteHexes,
  getThemeColorRoles,
  getThemeEditPaletteHexes,
  type ThemeColorRoles,
} from "@/lib/brand-theme-builder";
import { ThemeSwatch } from "../theme/ThemeSwatch";
import { ThemeRolePicker } from "./ThemeRolePicker";

/*
  THE KIT'S THEMES, editable and deletable (brand-kit-user-control §14.5b —
  the UI half of two mutations that already exist server-side).

  Both actions are deliberately understated. Editing expands inline under the
  row rather than opening a dialog, because the thing being edited is right
  there and a modal would hide it. Deleting goes through the house
  confirmation dialog (DraftSelector's is the precedent) — but says something
  different from that one, because the consequence is different: a deleted
  theme is recoverable and, crucially, deleting it changes nothing any draft
  RENDERS. Copy that implied otherwise would frighten people out of a safe
  action.

  WHAT THIS COMPONENT DOES NOT DO: write. Every mutation is the caller's, so
  the panel keeps one error surface and one busy flag, exactly as it does for
  colors, fonts and social links.
*/
export function BrandThemeList({
  variations,
  deletedVariations,
  colors,
  fonts,
  isBusy,
  onSaveEdit,
  onSetDeleted,
}: {
  variations: ThemeVariation[];
  /* Soft-deleted themes, oldest deletion first — the Restore list. */
  deletedVariations: ThemeVariation[];
  colors: BrandColor[];
  fonts: BrandKitFonts;
  isBusy: boolean;
  onSaveEdit: (variation: ThemeVariation) => void;
  onSetDeleted: (input: { variationId: string; isDeleted: boolean }) => void;
}) {
  /* Which theme's inline editor is open, by id. Null = none. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /* Which theme the confirmation dialog is asking about. */
  const [pendingDeletion, setPendingDeletion] = useState<ThemeVariation | null>(null);
  const paletteHexes = useMemo(() => getPaletteHexes(colors), [colors]);
  /*
    A kit needs at least one theme (getBrandKitValidationErrors), so the last
    one standing cannot be deleted. Saying so on a disabled button beats
    letting the click travel to the server and come back as a refusal.
  */
  const isLastVariation = variations.length <= 1;

  return (
    <div className="flex flex-col gap-1" data-testid="brand-theme-list">
      <ul className="flex flex-col">
        {variations.map((variation) => (
          <li key={variation.id} className="flex flex-col border-b last:border-b-0">
            <div
              className="flex items-center gap-3 py-2"
              data-testid={`brand-theme-row-${variation.id}`}
            >
              <ThemeSwatch globals={variation.globals} />
              <span className="min-w-0 flex-1 truncate text-sm">{variation.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                aria-label={`Edit ${variation.name}`}
                disabled={isBusy}
                onClick={() => setEditingId(editingId === variation.id ? null : variation.id)}
                data-testid={`brand-theme-edit-${variation.id}`}
              >
                <PencilLineIcon />
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                aria-label={`Delete ${variation.name}`}
                disabled={isBusy || isLastVariation}
                onClick={() => setPendingDeletion(variation)}
                data-testid={`brand-theme-delete-${variation.id}`}
              >
                <Trash2Icon />
              </Button>
            </div>
            {editingId === variation.id && (
              <ThemeEditForm
                variation={variation}
                colors={colors}
                paletteHexes={paletteHexes}
                fonts={fonts}
                isBusy={isBusy}
                onCancel={() => setEditingId(null)}
                onSave={(edited) => {
                  onSaveEdit(edited);
                  setEditingId(null);
                }}
              />
            )}
          </li>
        ))}
      </ul>

      {deletedVariations.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5" data-testid="brand-theme-deleted-list">
          <span className="text-xs font-medium tracking-wide text-muted-foreground">
            Deleted themes
          </span>
          {/*
            The point of a SOFT delete, made visible. Restoring puts the theme
            back with its original id, which is what re-links every draft that
            was using it — with that draft's own local changes still intact,
            because its pointer and baseline were never touched.
          */}
          <p className="text-xs text-muted-foreground">
            Restoring one puts it back on the theme menu, and any draft that was using it is linked
            to it again.
          </p>
          <ul className="flex flex-col">
            {deletedVariations.map((variation) => (
              <li
                key={variation.id}
                className="flex items-center gap-3 py-2"
                data-testid={`brand-theme-deleted-${variation.id}`}
              >
                <ThemeSwatch globals={variation.globals} />
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {variation.name}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={isBusy}
                  onClick={() => onSetDeleted({ variationId: variation.id, isDeleted: false })}
                  data-testid={`brand-theme-restore-${variation.id}`}
                >
                  <RotateCcwIcon />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog
        open={pendingDeletion !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setPendingDeletion(null);
          }
        }}
      >
        <DialogContent className="max-w-sm" data-testid="brand-theme-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete this theme?</DialogTitle>
            {/*
              THE COPY IS THE FEATURE. What people fear here is that removing a
              theme will change the emails built on it, and it will not: nothing
              in the delete path touches a draft. Saying that plainly — and that
              the theme can be restored — is what makes this a decision somebody
              can make in a second.
            */}
            <DialogDescription>
              “{pendingDeletion?.name ?? "This theme"}” leaves the theme menu. Drafts using it keep
              exactly the look they have now — they just stop following it. You can restore it from
              this panel afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={isBusy}
              onClick={() => {
                if (pendingDeletion !== null) {
                  onSetDeleted({ variationId: pendingDeletion.id, isDeleted: true });
                }
                setPendingDeletion(null);
              }}
              data-testid="brand-theme-delete-confirm"
            >
              {isBusy && <Loader2Icon className="animate-spin" />}
              Delete theme
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/*
  One theme's inline editor: the same four selects the add form uses, over a
  palette that also holds this theme's own colors, plus its name.

  THE PALETTE UNION IS THE WHOLE SUBTLETY (getThemeEditPaletteHexes). A scraped
  theme's heading color is frequently a contrast-repaired shade that is not in
  the authored palette, and a select whose options do not include its own
  current value shows the wrong color selected and changes the theme the moment
  it is submitted. Adding the theme's four colors cannot admit a failing
  combination — the stored one already passes WCAG-AA, or it would not be on the
  row — so filter-before-offering holds exactly as strongly here as in the add
  form.
*/
function ThemeEditForm({
  variation,
  colors,
  paletteHexes,
  fonts,
  isBusy,
  onCancel,
  onSave,
}: {
  variation: ThemeVariation;
  colors: BrandColor[];
  paletteHexes: string[];
  fonts: BrandKitFonts;
  isBusy: boolean;
  onCancel: () => void;
  onSave: (variation: ThemeVariation) => void;
}) {
  const storedRoles = getThemeColorRoles(variation);
  const [roles, setRoles] = useState<ThemeColorRoles>(storedRoles);
  const [name, setName] = useState(variation.name);
  const editPaletteHexes = getThemeEditPaletteHexes({ paletteHexes, roles: storedRoles });
  const edited = buildEditedThemeVariation({ variation, name, roles, fonts });

  return (
    <div
      className="flex flex-col gap-3 border-t py-3"
      data-testid={`brand-theme-edit-form-${variation.id}`}
    >
      <ThemeRolePicker
        roles={roles}
        paletteHexes={editPaletteHexes}
        colors={colors}
        isBusy={isBusy}
        idPrefix={`brand-theme-edit-${variation.id}`}
        onRolesChange={setRoles}
      />
      <div className="flex items-center gap-2">
        {edited !== null && <ThemeSwatch globals={edited.globals} />}
        <Input
          type="text"
          value={name}
          aria-label={`Name for ${variation.name}`}
          className="h-8 min-w-0 flex-1 text-sm"
          onChange={(event) => setName(event.target.value)}
          disabled={isBusy}
          data-testid={`brand-theme-edit-name-${variation.id}`}
        />
      </div>
      {/*
        Renaming keeps the theme's id, so drafts stay linked to it — which is
        also why a rename alone does not re-arm anybody's "Updated brand
        available" pill (updateBrandThemeVariation bumps the revision only for
        a payload change).
      */}
      <p className="text-xs text-muted-foreground">
        Drafts using this theme keep their look until you choose to update them, and any change they
        made themselves survives that update.
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          disabled={isBusy || edited === null || name.trim().length === 0}
          onClick={() => {
            if (edited !== null) {
              onSave(edited);
            }
          }}
          data-testid={`brand-theme-edit-save-${variation.id}`}
        >
          {isBusy && <Loader2Icon className="animate-spin" />}
          Save theme
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          onClick={onCancel}
          data-testid={`brand-theme-edit-cancel-${variation.id}`}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
