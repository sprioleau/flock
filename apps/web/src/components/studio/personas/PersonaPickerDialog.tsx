"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDownIcon, PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  replaceEnabledPersonaSlug,
  setPersonaEnabled,
  setPersonasPaused,
  useArePersonasPaused,
  useEnabledPersonaSlugs,
} from "@/lib/personas/enabled-personas";
import {
  MAX_PERSONA_MARKDOWN_LENGTH,
  parsePersonaMarkdown,
  parsePersonaMarkdownToForm,
  serializePersonaForm,
  validatePersonaMarkdown,
  type PersonaFormModel,
} from "@/lib/personas/parse-persona-markdown";
import { getOrCreateSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * Multi-agent canvas — the persona picker: a dialog (opened from the
 * settings FAB's "Agents" entry) listing every registry persona with an
 * enable toggle. Enablement is browser-session-scoped localStorage
 * (enabled-personas.ts); enabled personas join the open document's facepile
 * and review settled edits (use-persona-advisors.ts).
 *
 * v1 (proposal §6 item 9, owner-directed shape): personas are edited through
 * a STRUCTURED FORM — labeled fields over the markdown, never raw markdown
 * in the UI. parse-persona-markdown.ts owns the lossless markdown ⇄ form
 * mapping; markdown stays the storage/interchange format. Built-ins are
 * copy-on-edit — saving forks a session copy (`user/<sessionId>/<base>`)
 * that shadows the built-in in this session's picker; "Reset to default"
 * deletes the copy. Either way the enabled slug follows the row that defines
 * the persona (replaceEnabledPersonaSlug), so the runner's next turn reads
 * the saved markdown straight from the registry.
 *
 * Create-from-scratch: the "Create agent" affordance opens the SAME
 * structured form, blank, with placeholder guidance teaching the format's
 * spirit ("What you watch for" / "How you respond"). Creating inserts a
 * session-owned advisory row (slug `user/<sessionId>/<slugified-name>`,
 * server-side collision handling) and enables it for this browser
 * immediately. Created personas are ordinary registry rows — they join the
 * facepile, runner, findings, and watch scopes with zero persona-conditional
 * code — and carry a Delete affordance instead of Reset (no built-in behind
 * them).
 */

export interface PersonaPickerDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export function PersonaPickerDialog({ isOpen, onOpenChange }: PersonaPickerDialogProps) {
  // Anonymous session id (localStorage). Read only while the dialog is open
  // — opening is a user gesture, so this never runs during SSR/hydration
  // (window is always live here; the presence provider's pattern).
  const sessionId = isOpen ? getOrCreateSessionId() : null;

  const personas = useQuery(
    api.personas.listPersonas,
    isOpen && sessionId !== null ? { sessionId } : "skip",
  );
  const seedBuiltInPersonas = useMutation(api.personas.seedBuiltInPersonas);
  const enabledSlugs = useEnabledPersonaSlugs();
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);

  // Idempotent built-in seed on first open (insert-if-missing; never overwrites).
  useEffect(() => {
    if (isOpen) {
      seedBuiltInPersonas({}).catch((error: unknown) => {
        console.error("[personas] built-in seed failed:", error);
      });
    }
  }, [isOpen, seedBuiltInPersonas]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="persona-picker">
        <DialogHeader>
          <DialogTitle>Agents</DialogTitle>
          <DialogDescription>
            Advisory teammates that review your edits and leave suggestions. Enabled agents join
            the document&apos;s facepile while you work.
          </DialogDescription>
        </DialogHeader>
        <PersonasPausedToggle />
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {personas === undefined || sessionId === null ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading agents…</p>
          ) : personas.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No agents yet.</p>
          ) : (
            personas.map((persona) => (
              <PersonaRow
                key={persona.slug}
                persona={persona}
                isEnabled={enabledSlugs.includes(persona.slug)}
                sessionId={sessionId}
              />
            ))
          )}
          {sessionId !== null &&
            (isCreateFormOpen ? (
              <PersonaCreateForm sessionId={sessionId} onClose={() => setIsCreateFormOpen(false)} />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 self-start"
                onClick={() => setIsCreateFormOpen(true)}
                data-testid="persona-create-button"
              >
                <PlusIcon />
                Create agent
              </Button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The credit-conservation pause: stops the persona watcher from calling
 * /api/personas at all (zero Gemini spend — for demos especially) WITHOUT
 * disabling any personas. Enablement, open findings, and editing stay fully
 * functional; presence just goes idle. Persisted per browser beside the
 * enablement list.
 */
function PersonasPausedToggle() {
  const arePersonasPaused = useArePersonasPaused();
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2",
        arePersonasPaused && "border-amber-500/40 bg-amber-500/10",
      )}
      data-testid="personas-paused-toggle"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium">
          {arePersonasPaused ? "Recommendations paused" : "Recommendations active"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {arePersonasPaused
            ? "Agents stay enabled but make no API calls until you resume."
            : "Pause to conserve API credits — agents stay enabled, nothing runs."}
        </p>
      </div>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0 gap-1"
        onClick={() => setPersonasPaused(!arePersonasPaused)}
        data-testid="personas-paused-button"
      >
        {arePersonasPaused ? <PlayIcon /> : <PauseIcon />}
        {arePersonasPaused ? "Resume" : "Pause"}
      </Button>
    </div>
  );
}

interface PersonaPayload {
  slug: string;
  name: string;
  color: string;
  capabilityMode: "advisory";
  personaMarkdown: string;
  cooldownSeconds: number;
  /** Optional in the payload (see convex/personas.ts); undefined ⇒ built-in. */
  isBuiltIn?: boolean;
  /** True ⇒ created from scratch by this session (deletable, no built-in behind it). */
  isUserCreated?: boolean;
}

interface PersonaRowProps {
  persona: PersonaPayload;
  isEnabled: boolean;
  sessionId: string;
}

function PersonaRow({ persona, isEnabled, sessionId }: PersonaRowProps) {
  const [isMarkdownExpanded, setIsMarkdownExpanded] = useState(false);
  const parsed = parsePersonaMarkdown(persona.personaMarkdown);
  const isUserCreated = persona.isUserCreated === true;
  const isCustomized = persona.isBuiltIn === false && !isUserCreated;

  return (
    <div className="rounded-lg border px-3 py-2.5" data-testid={`persona-row-${persona.slug}`}>
      <div className="flex items-start gap-2.5">
        <span
          className="mt-1 size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: persona.color }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{persona.name}</p>
            <span className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
              {persona.capabilityMode}
            </span>
            {isCustomized && (
              <span
                className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-[10px] text-primary"
                data-testid={`persona-customized-badge-${persona.slug}`}
              >
                customized
              </span>
            )}
            {isUserCreated && (
              <span
                className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-[10px] text-primary"
                data-testid={`persona-created-badge-${persona.slug}`}
              >
                created by you
              </span>
            )}
          </div>
          {parsed.description !== null && (
            <p className="mt-0.5 text-xs text-muted-foreground">{parsed.description}</p>
          )}
        </div>
        <PersonaToggle slug={persona.slug} name={persona.name} isEnabled={isEnabled} />
      </div>
      <button
        type="button"
        onClick={() => setIsMarkdownExpanded((current) => !current)}
        className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        aria-expanded={isMarkdownExpanded}
        data-testid={`persona-markdown-toggle-${persona.slug}`}
      >
        <ChevronDownIcon
          className={cn("size-3 transition-transform", isMarkdownExpanded && "rotate-180")}
        />
        {isMarkdownExpanded ? "Hide definition" : "View definition"}
      </button>
      {isMarkdownExpanded && <PersonaDefinition persona={persona} sessionId={sessionId} />}
    </div>
  );
}

interface PersonaDefinitionProps {
  persona: PersonaPayload;
  sessionId: string;
}

/**
 * The expanded definition. Read mode renders the parsed behavior text as
 * labeled prose (no frontmatter or fences on screen); edit mode is the
 * structured form. Reset to default (copies of built-ins only) deletes the
 * session copy and swaps enablement back to the pristine built-in; created
 * personas get Delete instead (there is no built-in to fall back to).
 */
function PersonaDefinition({ persona, sessionId }: PersonaDefinitionProps) {
  const resetPersonaToBuiltIn = useMutation(api.personas.resetPersonaToBuiltIn);
  const deletePersona = useMutation(api.personas.deletePersona);
  const [isEditing, setIsEditing] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isUserCreated = persona.isUserCreated === true;
  const isSessionOwned = persona.isBuiltIn === false;

  const formModel = useMemo(
    () => parsePersonaMarkdownToForm(persona.personaMarkdown),
    [persona.personaMarkdown],
  );

  const handleReset = async () => {
    setIsRemoving(true);
    setErrorMessage(null);
    try {
      const { builtInSlug } = await resetPersonaToBuiltIn({ slug: persona.slug, sessionId });
      replaceEnabledPersonaSlug({ fromSlug: persona.slug, toSlug: builtInSlug });
    } catch (error: unknown) {
      console.error("[personas] reset to default failed:", error);
      setErrorMessage("Could not reset this persona. Please try again.");
      setIsRemoving(false);
    }
    // On success this row unmounts (the built-in un-shadows) — no state to restore.
  };

  const handleDelete = async () => {
    setIsRemoving(true);
    setErrorMessage(null);
    try {
      await deletePersona({ slug: persona.slug, sessionId });
      setPersonaEnabled({ slug: persona.slug, isEnabled: false });
    } catch (error: unknown) {
      console.error("[personas] delete failed:", error);
      setErrorMessage("Could not delete this agent. Please try again.");
      setIsRemoving(false);
    }
    // On success this row unmounts (the row is gone) — no state to restore.
  };

  if (isEditing) {
    return (
      <PersonaEditForm
        persona={persona}
        initialModel={formModel}
        isCustomized={isSessionOwned}
        sessionId={sessionId}
        onClose={() => setIsEditing(false)}
      />
    );
  }

  return (
    <div className="mt-1.5">
      <PersonaDefinitionView persona={persona} model={formModel} />
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => {
            setErrorMessage(null);
            setIsEditing(true);
          }}
          data-testid={`persona-edit-${persona.slug}`}
        >
          Edit
        </Button>
        {isSessionOwned && !isUserCreated && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={isRemoving}
            onClick={() => void handleReset()}
            data-testid={`persona-reset-${persona.slug}`}
          >
            Reset to default
          </Button>
        )}
        {isUserCreated && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-destructive hover:text-destructive"
            disabled={isRemoving}
            onClick={() => void handleDelete()}
            data-testid={`persona-delete-${persona.slug}`}
          >
            {isRemoving ? "Deleting…" : "Delete"}
          </Button>
        )}
        {errorMessage !== null && <p className="text-[11px] text-destructive">{errorMessage}</p>}
      </div>
    </div>
  );
}

/** Read mode: the behavior text as labeled prose — never raw markdown. */
function PersonaDefinitionView({
  persona,
  model,
}: {
  persona: PersonaPayload;
  model: PersonaFormModel;
}) {
  if (!model.isStructured) {
    // Structurally unparseable (hand-authored exotic content): the raw text
    // is the only faithful rendering.
    return (
      <pre className="max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {persona.personaMarkdown}
      </pre>
    );
  }
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto rounded-md bg-muted/50 p-2.5">
      {model.intro.length > 0 && (
        <p className="text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {model.intro}
        </p>
      )}
      {model.sections.map((section) => (
        <div key={section.heading}>
          <p className="text-[11px] font-medium text-foreground/80">{section.heading}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {section.content}
          </p>
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground/70">
        {getEagernessLabel(persona.cooldownSeconds)} reviewer — checks in about every{" "}
        {persona.cooldownSeconds}s.
      </p>
    </div>
  );
}

/** Accent colors offered by the swatch picker (distinct from the human hue wheel). */
const PERSONA_COLOR_PALETTE = [
  "#e11d48", // rose (Tone Police default)
  "#0d9488", // teal (Styling Recommender default)
  "#d97706", // amber
  "#16a34a", // green
  "#c026d3", // fuchsia
  "#475569", // slate
];

/**
 * Eagerness ⟷ cooldown mapping. The user-facing control is an EAGERNESS
 * slider (more eager = reviews more often); what persists is still
 * `cooldownSeconds` (the Gemini budget guard), so the mapping is INVERSE and
 * floors at 20s. Stops run left (most relaxed, 180s) → right (most eager,
 * 20s). Values that aren't a stop (hand-edited frontmatter) display at the
 * nearest stop and are only rewritten when the user actually moves the
 * slider — an untouched form stays byte-stable on save.
 */
const EAGERNESS_COOLDOWN_STOPS_SECONDS: readonly number[] = [180, 120, 90, 60, 45, 30, 20];

/** Slider position (0 = most relaxed) for a cooldown — nearest stop wins. */
function getEagernessPosition(cooldownSeconds: number): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  EAGERNESS_COOLDOWN_STOPS_SECONDS.forEach((stopSeconds, index) => {
    const distance = Math.abs(stopSeconds - cooldownSeconds);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

/** Human eagerness word for the read view (mirrors the slider's framing). */
function getEagernessLabel(cooldownSeconds: number): string {
  if (cooldownSeconds <= 30) {
    return "Eager";
  }
  if (cooldownSeconds <= 60) {
    return "Balanced";
  }
  return "Relaxed";
}

interface PersonaEditFormProps {
  persona: PersonaPayload;
  initialModel: PersonaFormModel;
  isCustomized: boolean;
  sessionId: string;
  onClose: () => void;
}

/**
 * The structured editor: labeled form fields over the markdown. On save the
 * model serializes deterministically back to canonical markdown
 * (serializePersonaForm — byte-stable when nothing changed), passes the
 * existing validation, and lands via updatePersonaMarkdown, which also syncs
 * the row's typed name/color/cooldown fields.
 */
function PersonaEditForm({
  persona,
  initialModel,
  isCustomized,
  sessionId,
  onClose,
}: PersonaEditFormProps) {
  const updatePersonaMarkdown = useMutation(api.personas.updatePersonaMarkdown);
  const [model, setModel] = useState<PersonaFormModel>(initialModel);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const patchModel = (patch: Partial<PersonaFormModel>) => {
    setModel((current) => ({ ...current, ...patch }));
  };

  const serialized = useMemo(() => serializePersonaForm(model), [model]);

  // Effective values: form fields fall back to the row's typed fields when
  // the markdown carries no frontmatter value of its own.
  const effectiveName = model.name ?? persona.name;
  const effectiveColor = model.color ?? persona.color;
  const effectiveCooldownSeconds = model.cooldownSeconds ?? persona.cooldownSeconds;

  const fieldIdBase = `persona-form-${persona.slug.replaceAll("/", "-")}`;

  const handleSave = async () => {
    if (effectiveName.trim().length === 0) {
      setErrorMessage("Give the persona a display name.");
      return;
    }
    // Headings alone serialize to non-empty text, so require actual behavior
    // prose here — validatePersonaMarkdown can only see the serialized bytes.
    const hasBehaviorText = model.isStructured
      ? model.intro.trim().length > 0 ||
        model.sections.some((section) => section.content.trim().length > 0)
      : model.rawMarkdown.trim().length > 0;
    if (!hasBehaviorText) {
      setErrorMessage("Add behavior text — it's what shapes how this persona reviews.");
      return;
    }
    const validationError = validatePersonaMarkdown(serialized);
    if (validationError !== null) {
      setErrorMessage(validationError);
      return;
    }
    const hasNameChange = effectiveName.trim() !== persona.name;
    const hasColorChange = effectiveColor !== persona.color;
    const hasCooldownChange = effectiveCooldownSeconds !== persona.cooldownSeconds;
    if (
      serialized === persona.personaMarkdown &&
      !hasNameChange &&
      !hasColorChange &&
      !hasCooldownChange
    ) {
      // Byte-identical round trip and no typed-field changes: nothing to save.
      onClose();
      return;
    }
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const { savedSlug } = await updatePersonaMarkdown({
        slug: persona.slug,
        personaMarkdown: serialized,
        sessionId,
        ...(hasNameChange ? { name: effectiveName.trim() } : {}),
        ...(hasColorChange ? { color: effectiveColor } : {}),
        ...(hasCooldownChange ? { cooldownSeconds: effectiveCooldownSeconds } : {}),
      });
      // Copy-on-edit: a built-in's save lands on the session copy — move the
      // enablement with it so the next persona run uses the new definition.
      if (savedSlug !== persona.slug) {
        replaceEnabledPersonaSlug({ fromSlug: persona.slug, toSlug: savedSlug });
      }
      onClose();
    } catch (error: unknown) {
      console.error("[personas] persona save failed:", error);
      setErrorMessage("Could not save this persona. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-2.5 rounded-md border bg-muted/30 p-2.5">
      {model.isStructured ? (
        <StructuredPersonaFields
          model={model}
          patchModel={patchModel}
          effectiveName={effectiveName}
          effectiveColor={effectiveColor}
          effectiveCooldownSeconds={effectiveCooldownSeconds}
          testIdSuffix={persona.slug}
        />
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`${fieldIdBase}-raw`} className="text-xs">
            Advanced
          </Label>
          <p className="text-[10px] text-muted-foreground">
            This definition has a custom format the form can&apos;t display — edit it directly.
          </p>
          <Textarea
            id={`${fieldIdBase}-raw`}
            value={model.rawMarkdown}
            onChange={(event) => patchModel({ rawMarkdown: event.target.value })}
            rows={10}
            spellCheck={false}
            className="max-h-64 min-h-40 font-mono text-[11px] leading-relaxed md:text-[11px]"
            data-testid={`persona-form-raw-${persona.slug}`}
          />
        </div>
      )}
      <p
        className={cn(
          "text-right text-[10px] tabular-nums",
          serialized.length > MAX_PERSONA_MARKDOWN_LENGTH
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {serialized.length.toLocaleString()} / {MAX_PERSONA_MARKDOWN_LENGTH.toLocaleString()}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          disabled={isSaving}
          onClick={() => void handleSave()}
          data-testid={`persona-editor-save-${persona.slug}`}
        >
          {isSaving ? "Saving…" : isCustomized ? "Save" : "Save as copy"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isSaving}
          onClick={onClose}
          data-testid={`persona-editor-cancel-${persona.slug}`}
        >
          Cancel
        </Button>
      </div>
      {errorMessage !== null && (
        <p
          className="text-[11px] text-destructive"
          data-testid={`persona-editor-error-${persona.slug}`}
        >
          {errorMessage}
        </p>
      )}
      {!isCustomized && (
        <p className="text-[10px] text-muted-foreground">
          Built-in agents stay pristine — saving creates your own copy that replaces it here.
        </p>
      )}
    </div>
  );
}

/**
 * Placeholder guidance for the create form's blank fields — teaches the
 * format's spirit (concrete watch items, concrete response style) without
 * pre-filling text the user would have to delete.
 */
const PERSONA_SECTION_PLACEHOLDERS: Record<string, string> = {
  "What you watch for":
    "The concrete, spottable problems this agent scans the email for — e.g. meaningful images missing alt text; link text that just says 'click here'; text too low-contrast to read.",
  "How you respond":
    "How findings are worded — e.g. quote the exact content it's about, say why it matters, and offer a concrete fix the user could paste in. At most two findings per pass.",
};

const PERSONA_INTRO_PLACEHOLDER =
  "Who is this agent and what is its single job? e.g. \"You are the Accessibility Checker. Your single job is making sure every subscriber can read and use this email.\"";

interface StructuredPersonaFieldsProps {
  model: PersonaFormModel;
  patchModel: (patch: Partial<PersonaFormModel>) => void;
  effectiveName: string;
  effectiveColor: string;
  effectiveCooldownSeconds: number;
  /** Persona slug for edits, "new" for the create form (field ids + testids). */
  testIdSuffix: string;
}

/**
 * The structured form's field set — shared verbatim between editing an
 * existing persona and creating one from scratch (the owner's "same form,
 * blank" shape). Purely controlled; save semantics live in the caller.
 */
function StructuredPersonaFields({
  model,
  patchModel,
  effectiveName,
  effectiveColor,
  effectiveCooldownSeconds,
  testIdSuffix,
}: StructuredPersonaFieldsProps) {
  const fieldIdBase = `persona-form-${testIdSuffix.replaceAll("/", "-")}`;
  const swatchColors = PERSONA_COLOR_PALETTE.includes(effectiveColor)
    ? PERSONA_COLOR_PALETTE
    : [effectiveColor, ...PERSONA_COLOR_PALETTE];

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="space-y-1">
          <Label htmlFor={`${fieldIdBase}-name`} className="text-xs">
            Name
          </Label>
          <Input
            id={`${fieldIdBase}-name`}
            value={effectiveName}
            placeholder="Accessibility Checker"
            onChange={(event) => patchModel({ name: event.target.value })}
            className="h-8 text-xs md:text-xs"
            data-testid={`persona-form-name-${testIdSuffix}`}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Eagerness</Label>
          <div className="flex h-8 items-center gap-2">
            <span className="text-[10px] text-muted-foreground select-none">Relaxed</span>
            <Slider
              value={getEagernessPosition(effectiveCooldownSeconds)}
              onValueChange={(position) =>
                patchModel({
                  cooldownSeconds:
                    EAGERNESS_COOLDOWN_STOPS_SECONDS[position as number] ??
                    effectiveCooldownSeconds,
                })
              }
              min={0}
              max={EAGERNESS_COOLDOWN_STOPS_SECONDS.length - 1}
              step={1}
              aria-label="Eagerness"
              data-testid={`persona-form-eagerness-${testIdSuffix}`}
            />
            <span className="text-[10px] text-muted-foreground select-none">Eager</span>
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            checks every ~{effectiveCooldownSeconds}s
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${fieldIdBase}-description`} className="text-xs">
          Description
        </Label>
        <Input
          id={`${fieldIdBase}-description`}
          value={model.description ?? ""}
          placeholder="One line shown in this list"
          onChange={(event) =>
            patchModel({
              description: event.target.value.length > 0 ? event.target.value : null,
            })
          }
          className="h-8 text-xs md:text-xs"
          data-testid={`persona-form-description-${testIdSuffix}`}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Color</Label>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Accent color">
          {swatchColors.map((swatchColor) => (
            <button
              key={swatchColor}
              type="button"
              role="radio"
              aria-checked={swatchColor === effectiveColor}
              aria-label={`Color ${swatchColor}`}
              onClick={() => patchModel({ color: swatchColor })}
              className={cn(
                "size-5 cursor-pointer rounded-full transition-shadow",
                swatchColor === effectiveColor &&
                  "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ backgroundColor: swatchColor }}
              data-testid={`persona-form-color-${testIdSuffix}-${swatchColor.slice(1)}`}
            />
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${fieldIdBase}-intro`} className="text-xs">
          Behavior guidelines
        </Label>
        <Textarea
          id={`${fieldIdBase}-intro`}
          value={model.intro}
          placeholder={PERSONA_INTRO_PLACEHOLDER}
          onChange={(event) => patchModel({ intro: event.target.value })}
          rows={3}
          spellCheck={false}
          className="min-h-16 text-xs leading-relaxed md:text-xs"
          data-testid={`persona-form-intro-${testIdSuffix}`}
        />
      </div>
      {model.sections.map((section, sectionIndex) => (
        <div key={section.heading} className="space-y-1">
          <Label htmlFor={`${fieldIdBase}-section-${sectionIndex}`} className="text-xs">
            {section.heading}
          </Label>
          <Textarea
            id={`${fieldIdBase}-section-${sectionIndex}`}
            value={section.content}
            placeholder={PERSONA_SECTION_PLACEHOLDERS[section.heading]}
            onChange={(event) => {
              const nextSections = model.sections.map((existing, index) =>
                index === sectionIndex
                  ? { ...existing, content: event.target.value }
                  : existing,
              );
              patchModel({ sections: nextSections });
            }}
            rows={5}
            spellCheck={false}
            className="min-h-24 text-xs leading-relaxed md:text-xs"
            data-testid={`persona-form-section-${testIdSuffix}-${sectionIndex}`}
          />
        </div>
      ))}
      {model.unmappedFrontmatterLines.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor={`${fieldIdBase}-advanced`} className="text-xs">
            Advanced (unmapped settings)
          </Label>
          <Textarea
            id={`${fieldIdBase}-advanced`}
            value={model.unmappedFrontmatterLines.join("\n")}
            onChange={(event) =>
              patchModel({
                unmappedFrontmatterLines: event.target.value
                  .split("\n")
                  .filter((line) => line.trim().length > 0),
              })
            }
            rows={2}
            spellCheck={false}
            className="min-h-12 font-mono text-[11px] leading-relaxed md:text-[11px]"
            data-testid={`persona-form-advanced-${testIdSuffix}`}
          />
        </div>
      )}
    </>
  );
}

/** Defaults for a persona created from scratch. */
const CREATED_PERSONA_DEFAULT_COLOR = "#c026d3"; // fuchsia — no built-in uses it
const CREATED_PERSONA_DEFAULT_COOLDOWN_SECONDS = 60; // "Balanced" on the slider

/**
 * The blank form model behind "Create agent": the built-ins' own structure
 * (intro + "What you watch for" / "How you respond"), empty, so placeholders
 * teach the format and the serialized markdown matches the seeded shape.
 */
function buildBlankPersonaFormModel(): PersonaFormModel {
  return {
    name: "",
    color: CREATED_PERSONA_DEFAULT_COLOR,
    cooldownSeconds: CREATED_PERSONA_DEFAULT_COOLDOWN_SECONDS,
    description: null,
    intro: "",
    sections: [
      { heading: "What you watch for", content: "" },
      { heading: "How you respond", content: "" },
    ],
    unmappedFrontmatterLines: [],
    hasFrontmatter: true,
    isStructured: true,
    rawMarkdown: "",
  };
}

interface PersonaCreateFormProps {
  sessionId: string;
  onClose: () => void;
}

/**
 * Create-from-scratch: the same structured form, blank. Creating inserts a
 * session-owned advisory row via personas.createPersona (server generates the
 * `user/<sessionId>/<slugified-name>` slug, collision-suffixed) and enables
 * it for this browser immediately, so it joins the facepile and the runner's
 * next pass without any further clicks.
 */
function PersonaCreateForm({ sessionId, onClose }: PersonaCreateFormProps) {
  const createPersona = useMutation(api.personas.createPersona);
  const [model, setModel] = useState<PersonaFormModel>(buildBlankPersonaFormModel);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const patchModel = (patch: Partial<PersonaFormModel>) => {
    setModel((current) => ({ ...current, ...patch }));
  };

  const effectiveName = model.name ?? "";
  const effectiveColor = model.color ?? CREATED_PERSONA_DEFAULT_COLOR;
  const effectiveCooldownSeconds =
    model.cooldownSeconds ?? CREATED_PERSONA_DEFAULT_COOLDOWN_SECONDS;

  const serialized = useMemo(
    () => serializePersonaForm({ ...model, name: effectiveName.trim() }),
    [model, effectiveName],
  );

  const handleCreate = async () => {
    if (effectiveName.trim().length === 0) {
      setErrorMessage("Give the agent a display name.");
      return;
    }
    const hasBehaviorText =
      model.intro.trim().length > 0 ||
      model.sections.some((section) => section.content.trim().length > 0);
    if (!hasBehaviorText) {
      setErrorMessage("Add behavior text — it's what shapes how this agent reviews.");
      return;
    }
    const validationError = validatePersonaMarkdown(serialized);
    if (validationError !== null) {
      setErrorMessage(validationError);
      return;
    }
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const { slug } = await createPersona({
        sessionId,
        name: effectiveName.trim(),
        color: effectiveColor,
        cooldownSeconds: effectiveCooldownSeconds,
        personaMarkdown: serialized,
      });
      // New agents start enabled for this browser — they join the open
      // document's facepile and review passes right away.
      setPersonaEnabled({ slug, isEnabled: true });
      onClose();
    } catch (error: unknown) {
      console.error("[personas] persona create failed:", error);
      setErrorMessage("Could not create this agent. Please try again.");
      setIsSaving(false);
    }
  };

  return (
    <div
      className="space-y-2.5 rounded-lg border bg-muted/30 px-3 py-2.5"
      data-testid="persona-create-form"
    >
      <p className="text-xs font-medium">New agent</p>
      <StructuredPersonaFields
        model={model}
        patchModel={patchModel}
        effectiveName={effectiveName}
        effectiveColor={effectiveColor}
        effectiveCooldownSeconds={effectiveCooldownSeconds}
        testIdSuffix="new"
      />
      <p
        className={cn(
          "text-right text-[10px] tabular-nums",
          serialized.length > MAX_PERSONA_MARKDOWN_LENGTH
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {serialized.length.toLocaleString()} / {MAX_PERSONA_MARKDOWN_LENGTH.toLocaleString()}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          disabled={isSaving}
          onClick={() => void handleCreate()}
          data-testid="persona-create-save"
        >
          {isSaving ? "Creating…" : "Create agent"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isSaving}
          onClick={onClose}
          data-testid="persona-create-cancel"
        >
          Cancel
        </Button>
      </div>
      {errorMessage !== null && (
        <p className="text-[11px] text-destructive" data-testid="persona-create-error">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

/** A small switch (no shadcn switch in this repo — a minimal, accessible one). */
function PersonaToggle({
  slug,
  name,
  isEnabled,
}: {
  slug: string;
  name: string;
  isEnabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isEnabled}
      aria-label={`${isEnabled ? "Disable" : "Enable"} ${name}`}
      onClick={() => setPersonaEnabled({ slug, isEnabled: !isEnabled })}
      className={cn(
        "relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
        isEnabled ? "bg-primary" : "bg-muted-foreground/25",
      )}
      data-testid={`persona-toggle-${slug}`}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform",
          isEnabled && "translate-x-4",
        )}
        aria-hidden
      />
    </button>
  );
}
