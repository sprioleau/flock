"use client";

import { useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FrameIcon,
  Link2Icon,
  LinkIcon,
  PencilLineIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { GenerationRequestDataPart } from "@/lib/chat-contract";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditorStore } from "@/lib/editor-store";
import { getOrCreateSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useActiveBrandKit } from "../brand-kit/useActiveBrandKit";
import { publishGenerationTargetDocument, useIsAgentBusy } from "../chat/agent-status";
import { sendPromptThroughComposer } from "../chat/composer-handoff";
import {
  clearGenerationRequest,
  stashGenerationRequest,
} from "../chat/pending-generation-request";
import {
  buildIdeatePromptText,
  buildVariationPromptText,
  MAX_GENERATION_DIRECTION_INPUT_LENGTH,
  pickVariationTheme,
  readSourceThemeGlobals,
} from "./draft-generation";
import { computeNextDraftName, computeVariationDraftName } from "./draft-naming";
import { useCanvasDrafts, type DraftListEntry } from "./use-canvas-drafts";

/** The two agent-composed draft actions in the menu. */
type GenerationMode = "ideate" | "designVariation";

/**
 * Per-mode wording for the shared direction dialog. Only the words differ —
 * the field, the cap, and the send path are identical — so this is a lookup
 * rather than two dialogs.
 *
 * The placeholders are examples of the ONE thing the field is for in each
 * mode: for a variation, the look (it is the only channel that can release the
 * pre-applied theme); for an ideation, the angle.
 */
const GENERATION_DIALOG_COPY: Readonly<
  Record<
    GenerationMode,
    { title: string; label: string; placeholder: string; confirmLabel: string }
  >
> = {
  ideate: {
    title: "Ideate with AI",
    label: "What should it try? (optional)",
    placeholder: "A shorter, warmer version — lead with the photo…",
    confirmLabel: "Ideate",
  },
  designVariation: {
    title: "Add a design variation",
    label: "Anything you want changed? (optional)",
    placeholder: "Lighter colours, bigger photo…",
    confirmLabel: "Create variation",
  },
};

/**
 * §10.2 frames UX — the compact toolbar control that replaced the v1 chip
 * row: [prev] [current draft name ▾] [next]. The menu lists every draft on
 * the canvas (click = activate; dual naming surfaced as a read-only secondary
 * line: agent-authored `agentName` + fork lineage) and keeps all v1
 * management actions — rename (inline, swaps the trigger for an input),
 * duplicate, copy link, new blank draft. Activation is delegated upward
 * (shallow ?doc= pushState in StudioShell).
 */
export function DraftSelector({
  onActivateDraft,
}: {
  onActivateDraft: (documentId: Id<"documents">) => void;
}) {
  const convexClient = useConvex();
  const { drafts, activeDocumentId, activeIndex } = useCanvasDrafts();
  /*
    Read for ONE reason: a design variation varies the theme, and the themes it
    may vary to are the canvas's bound kit's own (pickVariationTheme). Nothing
    else in this component styles anything.
  */
  const { brandKit, isBoundToCanvas } = useActiveBrandKit();
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [isCreatePending, setIsCreatePending] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isPromotePending, setIsPromotePending] = useState(false);
  const [isGenerationPending, setIsGenerationPending] = useState(false);
  /*
    Which AI generation the direction dialog is currently collecting for, or
    null when it is closed. BOTH actions ask now: "Ideate with AI" used to fire
    straight from the menu item with no input at all, which made every ideation
    a blind reroll — the only recourse to a result you disliked was to run it
    again and hope. One dialog serves both because the question is the same
    shape ("anything you want to say about this?"); only the copy differs.
  */
  const [generationDialogMode, setGenerationDialogMode] = useState<GenerationMode | null>(null);
  /*
    The one channel a person has to say "…but in lighter colours" at the moment
    they ask for a generation. Kept verbatim: it is quoted into the prompt and
    read by the model, never pattern-matched here.
  */
  const [generationDirection, setGenerationDirection] = useState("");
  // An AI generation waiting for its freshly created draft to become ACTIVE
  // (store-connected). The prompt must not send earlier: the chat pins each
  // turn to the document that is active at send time, so sending before the
  // switch completes would stream the sections into the SOURCE draft. A ref,
  // not state — it never drives rendering, only the activation effect below.
  const pendingGenerationSendRef = useRef<{
    sourceDocumentId: Id<"documents">;
    targetDocumentId: Id<"documents">;
    /** The sentence the person sees in the thread. */
    prompt: string;
    /** The machine half the server expands into the targeted brief. */
    generationRequest: GenerationRequestDataPart;
  } | null>(null);
  const isAgentBusy = useIsAgentBusy();

  // Fire the held prompt the moment the generated draft is active — through
  // the chat panel's own send path (composer-handoff SEND), so the request is
  // visible in the thread and the turn pins to the NEW draft (ops keep
  // landing there even if the user switches away mid-stream). Activating any
  // OTHER draft first cancels the handoff — never surprise-send later.
  useEffect(() => {
    const pendingSend = pendingGenerationSendRef.current;
    if (pendingSend === null || activeDocumentId === null) {
      return;
    }
    if (activeDocumentId === pendingSend.targetDocumentId) {
      pendingGenerationSendRef.current = null;
      // Mark the frame the generation streams into BEFORE the send, so the
      // working state (spinner/glow/lock in DraftFramesCanvas) is up the
      // moment the turn starts. agent-status clears it when the turn
      // settles; an unmounted composer means nothing was sent — clear now.
      publishGenerationTargetDocument(pendingSend.targetDocumentId);
      // Arm the machine half FIRST: sendUserMessage claims it as it builds the
      // message, so it has to be in place before the send, and it must be
      // disarmed again if no composer was mounted to receive it — otherwise it
      // would attach to whatever the person types next.
      stashGenerationRequest(pendingSend.generationRequest);
      if (!sendPromptThroughComposer(pendingSend.prompt)) {
        clearGenerationRequest();
        publishGenerationTargetDocument(null);
      }
      return;
    }
    if (activeDocumentId !== pendingSend.sourceDocumentId) {
      pendingGenerationSendRef.current = null;
    }
  }, [activeDocumentId]);

  if (drafts === undefined || drafts.length === 0) {
    return null;
  }

  const activeDraft = activeIndex >= 0 ? drafts[activeIndex]! : null;
  const previousDraft = activeIndex > 0 ? drafts[activeIndex - 1]! : null;
  const nextDraft =
    activeIndex >= 0 && activeIndex < drafts.length - 1 ? drafts[activeIndex + 1]! : null;
  /** Delete and promote both need a sibling: a canvas always keeps ≥ 1 draft. */
  const hasSiblingDrafts = drafts.length > 1;

  const beginRename = (): void => {
    if (activeDraft === null) {
      return;
    }
    setNameInput(activeDraft.name);
    setIsRenaming(true);
  };

  const commitRename = (): void => {
    setIsRenaming(false);
    if (activeDraft === null) {
      return;
    }
    const name = nameInput.trim();
    if (name.length === 0 || name === activeDraft.name) {
      return;
    }
    convexClient
      .mutation(api.documents.renameDocument, { documentId: activeDraft._id, name })
      .catch((error: unknown) => {
        console.error("renameDocument failed", error);
      });
  };

  const duplicateActiveDraft = (): void => {
    if (activeDraft === null) {
      return;
    }
    convexClient
      .mutation(api.documents.duplicateDocument, { documentId: activeDraft._id })
      .then((newDocumentId) => {
        if (newDocumentId !== null) {
          onActivateDraft(newDocumentId);
        }
      })
      .catch((error: unknown) => {
        console.error("duplicateDocument failed", error);
      });
  };

  const copyActiveDraftLink = (): void => {
    if (activeDraft === null) {
      return;
    }
    const url = `${window.location.origin}/studio?doc=${activeDraft._id}`;
    navigator.clipboard.writeText(url).catch((error: unknown) => {
      console.error("copy draft link failed", error);
    });
  };

  /** Whole-canvas share link: opens the canvas's latest draft, drafts bar shows all. */
  const copyCanvasLink = (): void => {
    if (activeDraft === null) {
      return;
    }
    const url = `${window.location.origin}/studio?canvas=${activeDraft.canvasId}`;
    navigator.clipboard.writeText(url).catch((error: unknown) => {
      console.error("copy canvas link failed", error);
    });
  };

  /** §10.2 promote: MOVE the active draft to a freshly created canvas of its own. */
  const promoteActiveDraft = (): void => {
    if (activeDraft === null || isPromotePending) {
      return;
    }
    setIsPromotePending(true);
    convexClient
      .mutation(api.documents.promoteDocumentToNewCanvas, { documentId: activeDraft._id })
      .then((result) => {
        const store = useEditorStore.getState();
        if (!result.isOk) {
          store.showNotice(
            result.reason === "already_alone"
              ? "This draft is already on its own canvas."
              : "This draft no longer exists.",
          );
          return;
        }
        // Same document id, new canvas: re-point the store's canvas so the
        // drafts bar and canvas link follow the move. The ?doc= URL is
        // unchanged and stays authoritative.
        if (store.documentId === activeDraft._id) {
          store.connectDocument({
            convexClient,
            documentId: activeDraft._id,
            canvasId: result.canvasId,
            authorId: getOrCreateSessionId(),
          });
        }
        store.showNotice(`"${activeDraft.name}" now lives on its own canvas.`);
      })
      .catch((error: unknown) => {
        console.error("promoteDocumentToNewCanvas failed", error);
        useEditorStore.getState().showNotice("Couldn't promote the draft (connection error).");
      })
      .finally(() => {
        setIsPromotePending(false);
      });
  };

  /**
   * Confirmed delete of the ACTIVE draft: hand the frame to a sibling first
   * (so the live subscription never lands on a deleted document), then run
   * the server-side cascade.
   */
  const confirmDeleteActiveDraft = (): void => {
    if (activeDraft === null || isDeletePending) {
      return;
    }
    const fallbackDraft = nextDraft ?? previousDraft;
    if (fallbackDraft === null) {
      // Last draft on the canvas — the menu item is disabled; backstop only.
      setIsDeleteDialogOpen(false);
      return;
    }
    setIsDeletePending(true);
    onActivateDraft(fallbackDraft._id);
    convexClient
      .mutation(api.documents.deleteDocument, { documentId: activeDraft._id })
      .then((result) => {
        if (!result.isOk) {
          useEditorStore
            .getState()
            .showNotice(
              result.reason === "last_draft"
                ? "A canvas needs at least one draft — this one can't be deleted."
                : "This draft was already deleted.",
            );
        }
      })
      .catch((error: unknown) => {
        console.error("deleteDocument failed", error);
        useEditorStore.getState().showNotice("Couldn't delete the draft (connection error).");
      })
      .finally(() => {
        setIsDeletePending(false);
        setIsDeleteDialogOpen(false);
      });
  };

  /**
   * The AI generation actions: create an EMPTY sibling draft, activate it,
   * and hand a composed prompt to the chat (sent by the effect above once the
   * new draft is store-connected). The request body only ever describes the
   * new blank draft, so everything the model learns about the source travels
   * in the prompt text.
   *
   * "ideate" asks for a fresh concept from a deliberately lossy outline, and
   * leaves the theme to the agent.
   *
   * A design variation is the opposite contract: same email, new shape, AND A
   * NEW THEME. Its theme is not left to the agent either way — exactly one
   * `applyTheme` op is written into the new draft BEFORE it is activated, so
   * the variation opens already wearing its theme instead of hoping the model
   * picks one. (Routing this through the SDK's composed `createDraft` path was
   * the alternative; it needs a complete section plan up front, which only the
   * model can produce, and it would cost the per-section streaming the drafts
   * menu deliberately shows. Seeding the theme keeps the streaming and makes
   * the guarantee deterministic.)
   *
   * WHICH theme is the part that changed. It used to be the source's own, and
   * a "design variation" that never changed colour was a layout variation
   * wearing the wrong name. It is now one of the BOUND KIT's OTHER live themes
   * (`pickVariationTheme` — filtered before offering, never the one already on
   * screen, never a soft-deleted one, never a generated one, so the new draft
   * is a real instance of a real theme and no model call is spent). Applying
   * it records the same advisory brand pointer the theme menu records, which
   * is what keeps the draft reading "current" rather than never-applied.
   *
   * THE HONEST FALLBACK. A kit whose only live theme is the one on screen has
   * nothing to vary to. Rather than silently reusing it and calling the result
   * a design variation, the source theme is carried as before AND a notice
   * says why — the layout variation is still worth having; pretending is not.
   *
   * Only THIS action diverges. The plain "New draft" below is untouched, and
   * the person's own words still outrank whatever theme was seeded — they ride
   * verbatim into the prompt for the model to weigh.
   */
  const startAiGeneration = ({
    mode,
    direction = "",
  }: {
    mode: GenerationMode;
    direction?: string;
  }): void => {
    if (activeDraft === null || isGenerationPending || isAgentBusy) {
      return;
    }
    const sourceDoc = useEditorStore.getState().doc;
    const sourceGlobals = readSourceThemeGlobals(sourceDoc);
    // Naming rules live in draft-naming.ts: variations carry exactly ONE
    // "(variation N)" marker (a marked source increments, never stacks) and
    // both paths dedupe against the live canvas draft list.
    const existingNames = drafts.map((draft) => draft.name);
    const name =
      mode === "designVariation"
        ? computeVariationDraftName({ sourceName: activeDraft.name, existingNames })
        : computeNextDraftName({ existingNames });
    const sessionId = getOrCreateSessionId();
    setIsGenerationPending(true);

    const run = async (): Promise<void> => {
      const { documentId } = await convexClient.mutation(api.documents.createDocument, {
        sessionId,
        canvasId: activeDraft.canvasId,
        name,
        shouldSeedEmpty: true,
      });
      let prompt: string;
      if (mode === "ideate") {
        prompt = buildIdeatePromptText({ sourceDraftName: activeDraft.name, direction });
      } else {
        const themePick = pickVariationTheme({
          brandKit,
          sourceGlobals,
          randomValue: Math.random(),
        });
        if (!themePick.isVaried) {
          useEditorStore
            .getState()
            .showNotice(
              `"${brandKit.name}" has only one theme, so this variation keeps it — add another theme to vary the colours too.`,
            );
        }
        /*
          A null on the FALLBACK path means the source is on the shared
          defaults, which the blank draft already wears — the themes match with
          nothing to copy. Whether the seed LANDED is not reported on the wire:
          the server holds both documents and compares them itself
          (generation-brief.ts's resolveVariationThemeState).
        */
        const seededGlobals = themePick.isVaried ? themePick.variation.globals : sourceGlobals;
        if (seededGlobals !== null) {
          const themeResult = await convexClient.mutation(api.documents.applyOperations, {
            documentId,
            ops: [{ name: "applyTheme", globals: seededGlobals }],
            context: {
              authorId: sessionId,
              author: "user",
              caller: "frontend",
              batchId: crypto.randomUUID(),
            },
          });
          if (!themeResult.isOk) {
            console.error("applyOperations (variation theme) rejected", themeResult.errors);
          } else if (themePick.isVaried && isBoundToCanvas) {
            /*
              The same advisory pointer ThemeMenu writes when a person picks a
              theme by hand (§4.3): it is what makes this draft an INSTANCE of
              the variation, so preserve-variation propagation can carry it
              into the kit's next revision, and the brand pill reads "current"
              rather than never-applied.

              AWAITED, where ThemeMenu fires and forgets: the model starts
              writing ops the moment this draft is activated a few lines below,
              and the pointer records `baselineGlobals` from the theme as
              seeded. Recording it first is what keeps the override diff empty
              at the moment of seeding. Still only UX metadata — the applyTheme
              op above is what actually restyled the draft — so a failure here
              is swallowed rather than allowed to sink the generation.
            */
            await convexClient
              .mutation(api.brandKits.recordDocumentBrandPointer, {
                documentId,
                variationId: themePick.variation.id,
              })
              .catch(() => undefined);
          }
        }
        prompt = buildVariationPromptText({ sourceDraftName: activeDraft.name, direction });
      }
      pendingGenerationSendRef.current = {
        sourceDocumentId: activeDraft._id,
        targetDocumentId: documentId,
        prompt,
        // The machine half of this send. It is stashed (not sent) until the new
        // draft is active, because the send itself waits for that — see the
        // activation effect.
        generationRequest: {
          kind: mode,
          sourceDocumentId: activeDraft._id,
          ...(direction.trim().length === 0 ? {} : { direction }),
        },
      };
      onActivateDraft(documentId);
    };

    run()
      .catch((error: unknown) => {
        console.error("createDocument (AI generation) failed", error);
        useEditorStore.getState().showNotice("Couldn't start the AI draft (connection error).");
      })
      .finally(() => {
        setIsGenerationPending(false);
      });
  };

  /** Send whichever generation the dialog was opened for, with what was typed. */
  const confirmGeneration = (): void => {
    if (generationDialogMode === null) {
      return;
    }
    const mode = generationDialogMode;
    setGenerationDialogMode(null);
    startAiGeneration({ mode, direction: generationDirection });
    setGenerationDirection("");
  };

  /** Open the direction dialog, deferred past the menu's close/focus-return. */
  const openGenerationDialog = (mode: GenerationMode): void => {
    setGenerationDirection("");
    setTimeout(() => setGenerationDialogMode(mode), 0);
  };

  /*
    Wording for whichever generation the dialog is collecting for. The
    variation copy stands in while the dialog is CLOSED (mode null): nothing is
    on screen then, and the fallback is only here so the dialog's markup does
    not have to be conditional in four separate places.
  */
  const generationDialogCopy = GENERATION_DIALOG_COPY[generationDialogMode ?? "designVariation"];

  const createDraft = (): void => {
    const canvasId = activeDraft?.canvasId ?? drafts[0]!.canvasId;
    if (isCreatePending) {
      return;
    }
    setIsCreatePending(true);
    convexClient
      .mutation(api.documents.createDocument, {
        sessionId: getOrCreateSessionId(),
        canvasId,
        name: computeNextDraftName({ existingNames: drafts.map((draft) => draft.name) }),
      })
      .then(({ documentId }) => {
        onActivateDraft(documentId);
      })
      .catch((error: unknown) => {
        console.error("createDocument (new draft) failed", error);
      })
      .finally(() => {
        setIsCreatePending(false);
      });
  };

  return (
    <div className="flex items-center gap-0.5" data-testid="draft-selector">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous draft"
                disabled={previousDraft === null}
                // On the first draft this must READ disabled at a glance (owner
                // emphasis) — the base button's 50%-opacity alone is too subtle
                // for a bare ghost chevron, so drop to washed-out muted (same
                // below).
                className="disabled:text-muted-foreground disabled:opacity-30"
                onClick={() => previousDraft !== null && onActivateDraft(previousDraft._id)}
                data-testid="draft-selector-prev"
              />
            }
          >
            <ChevronLeftIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">Previous draft</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {isRenaming ? (
        <input
          value={nameInput}
          onChange={(event) => setNameInput(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitRename();
            } else if (event.key === "Escape") {
              setIsRenaming(false);
            }
          }}
          autoFocus
          onFocus={(event) => event.target.select()}
          maxLength={80}
          className="h-7 rounded-md bg-background px-2 text-xs font-medium outline-none ring-1 ring-ring"
          style={{ width: `${Math.max(nameInput.length + 2, 10)}ch` }}
          aria-label={`Rename ${activeDraft?.name ?? "draft"}`}
          data-testid="draft-selector-rename-input"
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "flex h-7 max-w-56 items-center gap-1 rounded-md px-2 text-xs font-medium",
              "outline-none hover:bg-accent data-popup-open:bg-accent",
            )}
            aria-label="Drafts on this canvas"
            data-testid="draft-selector-trigger"
          >
            <span className="truncate">{activeDraft?.name ?? "…"}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-[10px] tracking-wide text-muted-foreground uppercase">
                Drafts on this canvas
              </DropdownMenuLabel>
              {drafts.map((draft) => (
                <DraftMenuEntry
                  key={draft._id}
                  draft={draft}
                  isActive={draft._id === activeDocumentId}
                  forkedFromName={
                    draft.forkedFromDocumentId !== undefined
                      ? (drafts.find((row) => row._id === draft.forkedFromDocumentId)?.name ??
                        "a removed draft")
                      : null
                  }
                  onActivate={() => onActivateDraft(draft._id)}
                />
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                // Defer past the menu's close/focus-return so the rename
                // input keeps focus once it mounts.
                setTimeout(beginRename, 0);
              }}
            >
              <PencilLineIcon /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={duplicateActiveDraft}>
              <CopyIcon /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyActiveDraftLink}>
              <LinkIcon /> Copy draft link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyCanvasLink}>
              <Link2Icon /> Copy canvas link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <TooltipProvider>
              <MaybeDisabledTooltip
                isDisabled={!hasSiblingDrafts}
                message="This draft is already on its own canvas."
              >
                <DropdownMenuItem
                  disabled={!hasSiblingDrafts || isPromotePending}
                  onClick={promoteActiveDraft}
                  data-testid="draft-menu-promote"
                >
                  <FrameIcon /> Promote to new canvas
                </DropdownMenuItem>
              </MaybeDisabledTooltip>
              <MaybeDisabledTooltip
                isDisabled={!hasSiblingDrafts}
                message="A canvas needs at least one draft."
              >
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!hasSiblingDrafts}
                  onClick={() => {
                    // Defer past the menu's close/focus-return, same as rename.
                    setTimeout(() => setIsDeleteDialogOpen(true), 0);
                  }}
                  data-testid="draft-menu-delete"
                >
                  <Trash2Icon /> Delete draft
                </DropdownMenuItem>
              </MaybeDisabledTooltip>
            </TooltipProvider>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={isCreatePending} onClick={createDraft}>
              <PlusIcon /> New draft
            </DropdownMenuItem>
            <TooltipProvider>
              <MaybeDisabledTooltip
                isDisabled={isAgentBusy}
                message="Flock is busy with another request — try again when it finishes."
              >
                <DropdownMenuItem
                  disabled={isAgentBusy || isGenerationPending}
                  onClick={() => openGenerationDialog("ideate")}
                  data-testid="draft-menu-generate"
                >
                  <SparklesIcon /> Ideate with AI
                </DropdownMenuItem>
              </MaybeDisabledTooltip>
              <MaybeDisabledTooltip
                isDisabled={isAgentBusy}
                message="Flock is busy with another request — try again when it finishes."
              >
                <DropdownMenuItem
                  disabled={isAgentBusy || isGenerationPending}
                  onClick={() => openGenerationDialog("designVariation")}
                  data-testid="draft-menu-design-variation"
                >
                  <WandSparklesIcon /> Add design variation
                </DropdownMenuItem>
              </MaybeDisabledTooltip>
            </TooltipProvider>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next draft"
                disabled={nextDraft === null}
                className="disabled:text-muted-foreground disabled:opacity-30"
                onClick={() => nextDraft !== null && onActivateDraft(nextDraft._id)}
                data-testid="draft-selector-next"
              />
            }
          >
            <ChevronRightIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">Next draft</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/*
        The direction dialog, shared by both AI actions. Optional in both — the
        primary button is still a one-click flow — but it is the single place a
        person can steer the result at all. For a variation that matters more
        than it looks: the source theme is pre-applied, so these words are the
        ONLY thing that can say "try something lighter" and have it reach the
        colour decision.

        A TEXTAREA, not an input: the cap is 500 characters, which is three or
        four lines of prose, and a single-line field that scrolls sideways makes
        what you typed impossible to re-read — which would defeat the longer cap
        it exists to serve. Enter therefore inserts a newline, and submitting
        moves to ⌘/Ctrl+Enter (or the button, which is always there).
      */}
      <Dialog
        open={generationDialogMode !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setGenerationDialogMode(null);
            setGenerationDirection("");
          }
        }}
      >
        <DialogContent className="max-w-sm" data-testid="draft-generation-dialog">
          <DialogHeader>
            <DialogTitle>
              {generationDialogCopy.title}
            </DialogTitle>
            <DialogDescription>
              {generationDialogMode === "ideate" ? (
                <>
                  Flock will design a new email on this canvas — the same subject as “
                  {activeDraft?.name ?? "this draft"}”, in its own words, layout and look.
                </>
              ) : (
                <>
                  Flock will lay “{activeDraft?.name ?? "this draft"}” out a new way, keeping the
                  same words and the same colours.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="draft-generation-direction"
              className="text-xs font-medium text-muted-foreground"
            >
              {generationDialogCopy.label}
            </label>
            <textarea
              id="draft-generation-direction"
              value={generationDirection}
              onChange={(event) => setGenerationDirection(event.target.value)}
              onKeyDown={(event) => {
                /*
                  Enter belongs to the textarea (it inserts a newline), so
                  submitting moves to ⌘/Ctrl+Enter — the same chord the chat
                  composer uses. This is a deliberate behaviour change: the old
                  single-line field submitted on bare Enter.
                */
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  confirmGeneration();
                }
              }}
              autoFocus
              rows={3}
              maxLength={MAX_GENERATION_DIRECTION_INPUT_LENGTH}
              placeholder={
                generationDialogCopy.placeholder
              }
              className="resize-none rounded-md bg-background px-2 py-1.5 text-xs outline-none ring-1 ring-border focus:ring-ring"
              data-testid="draft-generation-direction"
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={isGenerationPending}
              onClick={confirmGeneration}
              data-testid="draft-generation-confirm"
            >
              {generationDialogCopy.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="max-w-sm" data-testid="draft-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              “{activeDraft?.name ?? "This draft"}” and its entire edit history will be
              permanently deleted. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={isDeletePending}
              onClick={confirmDeleteActiveDraft}
              data-testid="draft-delete-confirm"
            >
              Delete draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Wraps a disabled menu item in a tooltip explaining WHY it is disabled
 * (disabled items are pointer-events-none, so the wrapping span catches the
 * hover). Enabled items render bare — no tooltip noise on the happy path.
 */
function MaybeDisabledTooltip({
  isDisabled,
  message,
  children,
}: {
  isDisabled: boolean;
  message: string;
  children: React.ReactNode;
}) {
  if (!isDisabled) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{children}</TooltipTrigger>
      <TooltipContent side="right">{message}</TooltipContent>
    </Tooltip>
  );
}

/** One draft row in the menu: name + read-only dual-naming/lineage secondary line. */
function DraftMenuEntry({
  draft,
  isActive,
  forkedFromName,
  onActivate,
}: {
  draft: DraftListEntry;
  isActive: boolean;
  forkedFromName: string | null;
  onActivate: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onActivate}
      data-testid="draft-menu-entry"
      data-active={isActive}
      data-document-id={draft._id}
    >
      <CheckIcon className={cn("size-3.5", !isActive && "invisible")} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{draft.name}</span>
        {(draft.agentName !== undefined || forkedFromName !== null) && (
          <span className="truncate text-[10px] text-muted-foreground">
            {draft.agentName !== undefined && <em>{draft.agentName}</em>}
            {draft.agentName !== undefined && forkedFromName !== null && " · "}
            {forkedFromName !== null && <>Forked from {forkedFromName}</>}
          </span>
        )}
      </div>
    </DropdownMenuItem>
  );
}
