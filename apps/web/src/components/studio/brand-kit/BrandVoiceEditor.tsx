"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getBrandVoiceDescriptorChoices,
  getBrandVoiceDescriptorLabel,
  toggleBrandVoiceDescriptor,
  MAX_VOICE_AVOID_WORDS,
  MAX_VOICE_DESCRIPTORS,
  MAX_VOICE_GUIDANCE_LENGTH,
  type BrandToneOfVoice,
  type BrandVoiceFormality,
  type BrandVoicePerson,
} from "@/lib/brand-kit";
import { cn } from "@/lib/utils";

/*
  What the editor hands back — provenance is stamped server-side.
*/
export interface BrandVoiceDraft {
  descriptors: string[];
  formality?: BrandVoiceFormality;
  person?: BrandVoicePerson;
  guidance?: string;
  avoid?: string[];
}

const FORMALITY_OPTIONS: { value: BrandVoiceFormality | ""; label: string }[] = [
  { value: "", label: "Not set" },
  { value: "casual", label: "Casual" },
  { value: "neutral", label: "In between" },
  { value: "formal", label: "Formal" },
];

const SELECT_CLASSNAME =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring";

/*
  Longest brand name shown inside an option label before it is trimmed.
*/
const MAX_NAME_IN_OPTION_LENGTH = 24;

/*
  The "talks about itself as" choice, in the brand's own words: "We" versus
  the brand's actual name — which is the real question, and the reason the
  old "Refers to itself as / first-person-plural" labels had to go.
*/
function getPersonOptions(brandName: string): { value: BrandVoicePerson | ""; label: string }[] {
  const trimmedName = brandName.trim();
  const nameLabel =
    trimmedName.length === 0
      ? "The brand name"
      : trimmedName.length > MAX_NAME_IN_OPTION_LENGTH
        ? `${trimmedName.slice(0, MAX_NAME_IN_OPTION_LENGTH).trimEnd()}…`
        : trimmedName;
  return [
    { value: "", label: "Not set" },
    { value: "first-person-plural", label: "We" },
    { value: "third-person", label: nameLabel },
  ];
}

/*
  Comma-separated text ⇄ list of trimmed entries (the least-friction editor).
*/
function parseList({ text, maxEntries }: { text: string; maxEntries: number }): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, maxEntries);
}

/*
  Tone of voice (brand-kit-user-control §5, relabelled by brand-kit-v2 §4) —
  "so the agent knows how to write". Coarse axes plus the freeform space that
  actually carries nuance; deliberately not twelve sliders nobody fills in.

  Every label here is something a non-technical person reads, so none of them
  is a linguistics term: "Sounds like" is a set of words to pick from (not a
  blank box that invites a paragraph), "How formal" replaced "Register", and
  "Talks about itself as" offers "We" or the brand's own name instead of
  "first-person-plural".

  Everything here is optional and every field is editable whether the agent
  proposed it or not. Clearing the whole thing (the Clear action in the panel)
  hands the field back to the next scrape.

  The words chosen here reach the model as a DELIMITED DATA BLOCK, never as
  instructions to it (lib/brand-voice.ts) — the copy under the field says so,
  because "guidance the agent reads" is a reasonable thing for a user to
  wonder about.
*/
export function BrandVoiceEditor({
  brandName,
  toneOfVoice,
  isBusy,
  onCommit,
}: {
  /*
    The kit's name — it is one of the "talks about itself as" options.
  */
  brandName: string;
  toneOfVoice: BrandToneOfVoice | undefined;
  isBusy: boolean;
  onCommit: (draft: BrandVoiceDraft) => void;
}) {
  const [descriptors, setDescriptors] = useState<string[]>(
    () => toneOfVoice?.descriptors ?? [],
  );
  const [avoidText, setAvoidText] = useState(() => (toneOfVoice?.avoid ?? []).join(", "));
  const [guidance, setGuidance] = useState(() => toneOfVoice?.guidance ?? "");
  const [formality, setFormality] = useState<BrandVoiceFormality | "">(
    () => toneOfVoice?.formality ?? "",
  );
  const [person, setPerson] = useState<BrandVoicePerson | "">(() => toneOfVoice?.person ?? "");

  /*
    Reseed whenever the stored voice changes (save, re-scrape, another tab).
    Compared by value, not identity: `toneOfVoice` is rebuilt on every Convex
    update even when nothing about it differs, and reseeding on identity would
    wipe whatever the user is halfway through typing.
  */
  //
  /*
    Adjusted DURING RENDER, not in an effect. React discards the in-progress
    render and re-runs with the new state before painting, so the fields never
    flash the previous kit's voice — which is exactly what an effect would do,
    and what react-hooks/set-state-in-effect flags. The fields above also seed
    themselves, so the first paint is correct without any resync at all.
  */
  const serializedTone = JSON.stringify(toneOfVoice ?? null);
  const [seededFrom, setSeededFrom] = useState(serializedTone);
  if (seededFrom !== serializedTone) {
    setSeededFrom(serializedTone);
    setDescriptors(toneOfVoice?.descriptors ?? []);
    setAvoidText((toneOfVoice?.avoid ?? []).join(", "));
    setGuidance(toneOfVoice?.guidance ?? "");
    setFormality(toneOfVoice?.formality ?? "");
    setPerson(toneOfVoice?.person ?? "");
  }

  const buildDraft = (overrides: Partial<BrandVoiceDraft> = {}): BrandVoiceDraft => {
    const trimmedGuidance = guidance.trim();
    return {
      descriptors: descriptors.slice(0, MAX_VOICE_DESCRIPTORS),
      ...(formality === "" ? {} : { formality }),
      ...(person === "" ? {} : { person }),
      ...(trimmedGuidance.length === 0 ? {} : { guidance: trimmedGuidance }),
      ...(avoidText.trim().length === 0
        ? {}
        : { avoid: parseList({ text: avoidText, maxEntries: MAX_VOICE_AVOID_WORDS }) }),
      ...overrides,
    };
  };

  /*
    Toggle one word on/off and save immediately — no Save button, no debounce.
  */
  const toggleDescriptor = (descriptor: string): void => {
    const nextDescriptors = toggleBrandVoiceDescriptor({ selected: descriptors, descriptor });
    if (nextDescriptors === descriptors) {
      return; /* At the cap and this word isn't selected — nothing to save. */
    }
    setDescriptors(nextDescriptors);
    onCommit(buildDraft({ descriptors: nextDescriptors }));
  };

  const descriptorChoices = getBrandVoiceDescriptorChoices(descriptors);
  const isAtDescriptorLimit = descriptors.length >= MAX_VOICE_DESCRIPTORS;

  return (
    <div className="flex flex-col gap-3" data-testid="brand-kit-voice-editor">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">Sounds like</span>
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Sounds like"
          data-testid="brand-kit-voice-descriptors"
        >
          {descriptorChoices.map((descriptor) => {
            const isSelected = descriptors.includes(descriptor);
            return (
              <button
                key={descriptor}
                type="button"
                aria-pressed={isSelected}
                disabled={isBusy || (!isSelected && isAtDescriptorLimit)}
                onClick={() => toggleDescriptor(descriptor)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input text-muted-foreground hover:text-foreground",
                )}
                data-testid={`brand-kit-voice-descriptor-${descriptor}`}
              >
                {getBrandVoiceDescriptorLabel(descriptor)}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Pick up to {MAX_VOICE_DESCRIPTORS}.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="brand-voice-formality"
            className="text-xs font-medium tracking-wide text-muted-foreground"
          >
            How formal
          </label>
          <select
            id="brand-voice-formality"
            value={formality}
            className={SELECT_CLASSNAME}
            onChange={(event) => {
              const nextFormality = event.target.value as BrandVoiceFormality | "";
              setFormality(nextFormality);
              onCommit(
                nextFormality === ""
                  ? { ...buildDraft(), formality: undefined }
                  : buildDraft({ formality: nextFormality }),
              );
            }}
            disabled={isBusy}
            data-testid="brand-kit-voice-formality"
          >
            {FORMALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="brand-voice-person"
            className="text-xs font-medium tracking-wide text-muted-foreground"
          >
            Talks about itself as
          </label>
          <select
            id="brand-voice-person"
            value={person}
            className={SELECT_CLASSNAME}
            onChange={(event) => {
              const nextPerson = event.target.value as BrandVoicePerson | "";
              setPerson(nextPerson);
              onCommit(
                nextPerson === ""
                  ? { ...buildDraft(), person: undefined }
                  : buildDraft({ person: nextPerson }),
              );
            }}
            disabled={isBusy}
            data-testid="brand-kit-voice-person"
          >
            {getPersonOptions(brandName).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="brand-voice-guidance"
          className="text-xs font-medium tracking-wide text-muted-foreground"
        >
          Writing notes
        </label>
        <Textarea
          id="brand-voice-guidance"
          value={guidance}
          maxLength={MAX_VOICE_GUIDANCE_LENGTH}
          placeholder="Short sentences. Never exclamation marks. Lead with the benefit."
          className="min-h-16 text-sm"
          onChange={(event) => setGuidance(event.target.value)}
          onBlur={() => onCommit(buildDraft())}
          disabled={isBusy}
          data-testid="brand-kit-voice-guidance"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="brand-voice-avoid"
          className="text-xs font-medium tracking-wide text-muted-foreground"
        >
          Words to avoid
        </label>
        <Input
          id="brand-voice-avoid"
          type="text"
          value={avoidText}
          placeholder="synergy, revolutionary, unlock"
          className="h-8 text-sm"
          onChange={(event) => setAvoidText(event.target.value)}
          onBlur={() => onCommit(buildDraft())}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          disabled={isBusy}
          data-testid="brand-kit-voice-avoid"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        The assistant writes your email copy in this voice. It won&apos;t change how the assistant
        talks to you in chat.
      </p>
    </div>
  );
}
