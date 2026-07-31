"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEndCoalescing } from "./usePanelDispatch";
import { useLiveDraft } from "./useLiveDraft";

export interface TextareaFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  helpText?: string;
  /** Extra classes on the textarea (e.g. a monospace font for code). */
  textareaClassName?: string;
  onCommit: (value: string) => void;
}

/**
 * Multiline sibling of fields.tsx's TextField, for content where newlines are
 * meaningful (the code block's source). Same live-draft + coalescing wiring:
 * every keystroke commits instantly, one undo entry per gesture. Emptying the
 * field keeps the last valid value (the schema requires non-empty content).
 */
export function TextareaField({
  label,
  value,
  placeholder,
  helpText,
  textareaClassName,
  onCommit,
}: TextareaFieldProps) {
  const inputId = useId();
  const endCoalescing = useEndCoalescing();
  const { draft, setDraft, handleFocus, handleBlur } = useLiveDraft<string>({
    value,
    onCommit: (next) => {
      if (next.trim() === "") {
        return;
      }
      onCommit(next);
    },
    onGestureEnd: endCoalescing,
  });

  return (
    <div className="space-y-1.5" data-slot="panel-field">
      <Label htmlFor={inputId} title={helpText} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Textarea
        id={inputId}
        value={draft}
        placeholder={placeholder}
        className={textareaClassName}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
    </div>
  );
}
