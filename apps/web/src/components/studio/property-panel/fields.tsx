"use client";

import { useId } from "react";
import { AlignCenter, AlignLeft, AlignRight, X } from "lucide-react";
import type { TextAlign } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { useEndCoalescing } from "./usePanelDispatch";
import { useLiveDraft } from "./useLiveDraft";

/**
 * Shared property-panel field controls. Every input event commits an op
 * immediately (the canvas tracks in real time); the editor store's undo-stack
 * coalescing merges rapid same-field dispatches into one undo entry per
 * gesture. Blur ends the coalescing run.
 *
 * `helpText` is the SDK schema's `.describe()` string, surfaced as a hover
 * tooltip on the field label.
 */

interface FieldShellProps {
  /** Omit for controls that are not labelable elements (e.g. toggle groups). */
  inputId?: string;
  label: string;
  helpText?: string;
  children: React.ReactNode;
}

function FieldShell({ inputId, label, helpText, children }: FieldShellProps) {
  return (
    <div className="space-y-1.5" data-slot="panel-field">
      {inputId !== undefined ? (
        <Label htmlFor={inputId} title={helpText} className="text-xs text-muted-foreground">
          {label}
        </Label>
      ) : (
        <p title={helpText} className="text-xs font-medium text-muted-foreground">
          {label}
        </p>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextFieldProps {
  label: string;
  value: string | undefined;
  /** Committed when the input is emptied. "skip" keeps the last valid value. */
  emptyBehavior?: "skip" | "clear" | "commit";
  placeholder?: string;
  helpText?: string;
  onCommit: (value: string | undefined) => void;
}

export function TextField({
  label,
  value,
  emptyBehavior = "skip",
  placeholder,
  helpText,
  onCommit,
}: TextFieldProps) {
  const inputId = useId();
  const endCoalescing = useEndCoalescing();
  const { draft, setDraft, handleFocus, handleBlur } = useLiveDraft<string>({
    value: value ?? "",
    onCommit: (next) => {
      if (next.trim() === "") {
        if (emptyBehavior === "clear") {
          onCommit(undefined);
        } else if (emptyBehavior === "commit") {
          onCommit("");
        }
        return;
      }
      onCommit(next);
    },
    onGestureEnd: endCoalescing,
  });

  return (
    <FieldShell inputId={inputId} label={label} helpText={helpText}>
      <Input
        id={inputId}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
    </FieldShell>
  );
}

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

export interface NumberFieldProps {
  label: string;
  value: number | undefined;
  /** When true, an emptied input commits `undefined` (clears the override). */
  isClearable?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  helpText?: string;
  onCommit: (value: number | undefined) => void;
}

function clampNumber({ value, min, max }: { value: number; min?: number; max?: number }): number {
  let result = value;
  if (min !== undefined && result < min) {
    result = min;
  }
  if (max !== undefined && result > max) {
    result = max;
  }
  return result;
}

export function NumberField({
  label,
  value,
  isClearable = false,
  min,
  max,
  step,
  placeholder,
  helpText,
  onCommit,
}: NumberFieldProps) {
  const inputId = useId();
  const endCoalescing = useEndCoalescing();
  const { draft, setDraft, handleFocus, handleBlur } = useLiveDraft<string>({
    value: value === undefined ? "" : String(value),
    onCommit: (next) => {
      const trimmed = next.trim();
      if (trimmed === "") {
        if (isClearable) {
          onCommit(undefined);
        }
        return;
      }
      const parsed = Number(trimmed);
      if (Number.isNaN(parsed)) {
        return;
      }
      onCommit(clampNumber({ value: parsed, min, max }));
    },
    onGestureEnd: endCoalescing,
  });

  return (
    <FieldShell inputId={inputId} label={label} helpText={helpText}>
      <Input
        id={inputId}
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
    </FieldShell>
  );
}

// ---------------------------------------------------------------------------
// Percent slider
// ---------------------------------------------------------------------------

export interface PercentSliderFieldProps {
  label: string;
  /** Current percent, or undefined when the property is cleared (e.g. "natural"). */
  valuePercent: number | undefined;
  min: number;
  max: number;
  step: number;
  /** Exact-value readout beside the percent (e.g. "510px"). */
  detailText?: string;
  /** Readout shown when valuePercent is undefined (e.g. "natural"). */
  clearedLabel?: string;
  /** Renders a clear affordance restoring the undefined state. */
  onClear?: () => void;
  helpText?: string;
  onCommit: (percent: number) => void;
}

/**
 * A percentage slider following the panel's instant-apply law: EVERY slider
 * movement commits an op immediately (`onValueChange` — the canvas tracks the
 * drag in real time, never debounced); releasing the thumb ends the store's
 * coalescing gesture (`onValueCommitted`), so one drag = one undo step. The
 * readout keeps the exact number visible next to the human-facing percent.
 */
export function PercentSliderField({
  label,
  valuePercent,
  min,
  max,
  step,
  detailText,
  clearedLabel = "unset",
  onClear,
  helpText,
  onCommit,
}: PercentSliderFieldProps) {
  const endCoalescing = useEndCoalescing();
  const sliderPercent = clampNumber({ value: valuePercent ?? max, min, max });

  return (
    <FieldShell label={label} helpText={helpText}>
      <div className="flex items-center gap-2">
        <Slider
          value={sliderPercent}
          min={min}
          max={max}
          step={step}
          aria-label={label}
          onValueChange={(next) => onCommit(next as number)}
          onValueCommitted={() => endCoalescing()}
        />
        <span
          className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums"
          data-slot="slider-readout"
        >
          {valuePercent === undefined ? clearedLabel : `${valuePercent}%`}
          {valuePercent !== undefined && detailText !== undefined && (
            <span className="block text-[9px] text-muted-foreground/70">{detailText}</span>
          )}
        </span>
        {onClear !== undefined && valuePercent !== undefined && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Clear ${label.toLowerCase()}`}
            title={`Reset to ${clearedLabel}`}
            onClick={() => {
              onClear();
              endCoalescing();
            }}
          >
            <X />
          </Button>
        )}
      </div>
    </FieldShell>
  );
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** Normalize a CSS hex color to #rrggbb for the native color input; null if not hex. */
function toSwatchHex(color: string): string | null {
  const match = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (match === null) {
    return null;
  }
  const hex = color.trim().slice(1);
  if (hex.length === 6) {
    return `#${hex.toLowerCase()}`;
  }
  const [r, g, b] = hex.toLowerCase();
  return `#${r}${r}${g}${g}${b}${b}`;
}

export interface ColorFieldProps {
  label: string;
  value: string | undefined;
  /** Resolved fallback shown (and used for the swatch) when no override is set. */
  fallbackColor?: string;
  /** When true, the override can be cleared (empty text or the clear button). */
  isClearable?: boolean;
  helpText?: string;
  onCommit: (value: string | undefined) => void;
}

export function ColorField({
  label,
  value,
  fallbackColor,
  isClearable = false,
  helpText,
  onCommit,
}: ColorFieldProps) {
  const inputId = useId();
  const endCoalescing = useEndCoalescing();
  const { draft, setDraft, handleFocus, handleBlur } = useLiveDraft<string>({
    value: value ?? "",
    onCommit: (next) => {
      const trimmed = next.trim();
      if (trimmed === "") {
        if (isClearable) {
          onCommit(undefined);
        }
        return;
      }
      onCommit(trimmed);
    },
    onGestureEnd: endCoalescing,
  });

  const effectiveColor = draft.trim() === "" ? (fallbackColor ?? "") : draft;
  const swatchHex = toSwatchHex(effectiveColor) ?? "#000000";
  const hasOverride = value !== undefined;

  return (
    <FieldShell inputId={inputId} label={label} helpText={helpText}>
      <div className="flex items-center gap-1.5">
        {/* The native swatch fills the WHOLE rounded control: zero padding on
            the input and its WebKit wrapper, no inner swatch border, and
            overflow-hidden lets rounded-md clip the swatch's corners. */}
        <input
          type="color"
          aria-label={`${label} color swatch`}
          value={swatchHex}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={cn(
            "size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-input bg-transparent p-0",
            "[&::-webkit-color-swatch-wrapper]:p-0",
            "[&::-webkit-color-swatch]:border-0",
            "[&::-moz-color-swatch]:border-0",
          )}
        />
        <Input
          id={inputId}
          value={draft}
          placeholder={fallbackColor}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="font-mono"
        />
        {isClearable && hasOverride ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Clear ${label} override`}
            onClick={() => onCommit(undefined)}
          >
            <X />
          </Button>
        ) : null}
      </div>
    </FieldShell>
  );
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

const ALIGN_OPTIONS: ReadonlyArray<{ align: TextAlign; icon: React.ReactNode }> = [
  { align: "left", icon: <AlignLeft /> },
  { align: "center", icon: <AlignCenter /> },
  { align: "right", icon: <AlignRight /> },
];

export interface AlignFieldProps {
  label: string;
  value: TextAlign | undefined;
  /** When true, unpressing the active option commits `undefined` (clears). */
  isClearable?: boolean;
  helpText?: string;
  onCommit: (value: TextAlign | undefined) => void;
}

export function AlignField({
  label,
  value,
  isClearable = false,
  helpText,
  onCommit,
}: AlignFieldProps) {
  return (
    <FieldShell label={label} helpText={helpText}>
      <ToggleGroup
        aria-label={label}
        variant="outline"
        spacing={0}
        value={value === undefined ? [] : [value]}
        onValueChange={(groupValue: string[]) => {
          const next = groupValue[0];
          if (next === "left" || next === "center" || next === "right") {
            onCommit(next);
          } else if (isClearable) {
            onCommit(undefined);
          }
        }}
      >
        {ALIGN_OPTIONS.map(({ align, icon }) => (
          <ToggleGroupItem key={align} value={align} aria-label={`Align ${align}`} size="sm">
            {icon}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </FieldShell>
  );
}

// ---------------------------------------------------------------------------
// Select (small fixed set of labelled options, rendered as a toggle group)
// ---------------------------------------------------------------------------

export interface SelectFieldOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectFieldProps<T extends string> {
  label: string;
  value: T | undefined;
  options: ReadonlyArray<SelectFieldOption<T>>;
  /** When true, unpressing the active option commits `undefined` (clears). */
  isClearable?: boolean;
  helpText?: string;
  onCommit: (value: T | undefined) => void;
}

export interface DropdownFieldOption {
  value: string;
  label: string;
}

export interface DropdownFieldProps {
  label: string;
  value: string | undefined;
  options: ReadonlyArray<DropdownFieldOption>;
  helpText?: string;
  onCommit: (value: string) => void;
}

/**
 * A native single-select dropdown styled like the Input control — for option
 * sets too large for SelectField's segmented toggle (e.g. email-safe font
 * stacks). A current value that matches no option renders as a disabled
 * "Custom" entry so the control always reflects the underlying doc.
 */
export function DropdownField({ label, value, options, helpText, onCommit }: DropdownFieldProps) {
  const inputId = useId();
  const isKnownValue = value === undefined || options.some((option) => option.value === value);

  return (
    <FieldShell inputId={inputId} label={label} helpText={helpText}>
      <select
        id={inputId}
        value={value ?? ""}
        onChange={(event) => onCommit(event.target.value)}
        className={cn(
          "h-8 w-full min-w-0 cursor-pointer rounded-lg border border-input bg-transparent px-2 text-base",
          "transition-colors outline-none focus-visible:border-ring focus-visible:ring-3",
          "focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
        )}
      >
        {!isKnownValue && (
          <option value={value} disabled>
            Custom
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} style={{ fontFamily: option.value }}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  isClearable = false,
  helpText,
  onCommit,
}: SelectFieldProps<T>) {
  return (
    <FieldShell label={label} helpText={helpText}>
      <ToggleGroup
        aria-label={label}
        variant="outline"
        spacing={0}
        value={value === undefined ? [] : [value]}
        onValueChange={(groupValue: string[]) => {
          const next = options.find((option) => option.value === groupValue[0]);
          if (next !== undefined) {
            onCommit(next.value);
          } else if (isClearable) {
            onCommit(undefined);
          }
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} size="sm" className="text-xs">
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </FieldShell>
  );
}
