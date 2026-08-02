"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_VOICE_AVOID_WORDS,
  MAX_VOICE_DESCRIPTORS,
  MAX_VOICE_GUIDANCE_LENGTH,
  type BrandToneOfVoice,
  type BrandVoiceFormality,
  type BrandVoicePerson,
} from "@/lib/brand-kit";

/** What the editor hands back — provenance is stamped server-side. */
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
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
];

const PERSON_OPTIONS: { value: BrandVoicePerson | ""; label: string }[] = [
  { value: "", label: "Not set" },
  { value: "first-person-plural", label: 'We / you' },
  { value: "third-person", label: "By name" },
];

const SELECT_CLASSNAME =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring";

/** Comma-separated text ⇄ list of trimmed entries (the least-friction editor). */
function parseList({ text, maxEntries }: { text: string; maxEntries: number }): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, maxEntries);
}

/**
 * Tone of voice (brand-kit-user-control §5) — "so the agent knows how to
 * write". Coarse axes plus the freeform space that actually carries nuance;
 * deliberately not twelve sliders nobody fills in.
 *
 * Everything here is optional and every field is editable whether the agent
 * proposed it or not. Clearing the whole thing (the Clear action in the panel)
 * hands the field back to the next scrape.
 *
 * The words typed here reach the model as a DELIMITED DATA BLOCK, never as
 * instructions to it (lib/brand-voice.ts) — the copy under the field says so,
 * because "guidance the agent reads" is a reasonable thing for a user to
 * wonder about.
 */
export function BrandVoiceEditor({
  toneOfVoice,
  isBusy,
  onCommit,
}: {
  toneOfVoice: BrandToneOfVoice | undefined;
  isBusy: boolean;
  onCommit: (draft: BrandVoiceDraft) => void;
}) {
  const [descriptorsText, setDescriptorsText] = useState("");
  const [avoidText, setAvoidText] = useState("");
  const [guidance, setGuidance] = useState("");
  const [formality, setFormality] = useState<BrandVoiceFormality | "">("");
  const [person, setPerson] = useState<BrandVoicePerson | "">("");

  // Reseed whenever the stored voice changes (save, re-scrape, another tab).
  const serializedTone = JSON.stringify(toneOfVoice ?? null);
  useEffect(() => {
    const stored = JSON.parse(serializedTone) as BrandToneOfVoice | null;
    setDescriptorsText((stored?.descriptors ?? []).join(", "));
    setAvoidText((stored?.avoid ?? []).join(", "));
    setGuidance(stored?.guidance ?? "");
    setFormality(stored?.formality ?? "");
    setPerson(stored?.person ?? "");
  }, [serializedTone]);

  const buildDraft = (overrides: Partial<BrandVoiceDraft> = {}): BrandVoiceDraft => {
    const trimmedGuidance = guidance.trim();
    return {
      descriptors: parseList({ text: descriptorsText, maxEntries: MAX_VOICE_DESCRIPTORS }),
      ...(formality === "" ? {} : { formality }),
      ...(person === "" ? {} : { person }),
      ...(trimmedGuidance.length === 0 ? {} : { guidance: trimmedGuidance }),
      ...(avoidText.trim().length === 0
        ? {}
        : { avoid: parseList({ text: avoidText, maxEntries: MAX_VOICE_AVOID_WORDS }) }),
      ...overrides,
    };
  };

  return (
    <div className="flex flex-col gap-3" data-testid="brand-kit-voice-editor">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="brand-voice-descriptors"
          className="text-xs font-medium tracking-wide text-muted-foreground"
        >
          Sounds like
        </label>
        <Input
          id="brand-voice-descriptors"
          type="text"
          value={descriptorsText}
          placeholder="warm, plain-spoken, precise"
          className="h-8 text-sm"
          onChange={(event) => setDescriptorsText(event.target.value)}
          onBlur={() => onCommit(buildDraft())}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          disabled={isBusy}
          data-testid="brand-kit-voice-descriptors"
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="brand-voice-formality"
            className="text-xs font-medium tracking-wide text-muted-foreground"
          >
            Register
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
            Refers to itself as
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
            {PERSON_OPTIONS.map((option) => (
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
