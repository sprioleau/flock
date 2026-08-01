"use client";

import {
  BubbleMenuItem,
  CheckIcon,
  ChevronDownIcon,
  useBubbleMenuContext,
} from "@react-email/editor/ui";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { HighlighterIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EMAIL_SAFE_FONT_OPTIONS } from "./email-safe-fonts";

/**
 * Span-level typography controls for the inline-editor bubble menu: font
 * family, font size, text color, and highlight. The Resend BubbleMenu ships
 * no TextStyle-family selectors, so these compose its primitives
 * (BubbleMenuItem + the --re-* theme variables via classes in
 * inline-text-editor.css) around the official Tiptap extension commands
 * (setFontFamily / setFontSize / setColor / setHighlight).
 *
 * INVARIANT (session-close logic): every popover renders in place — NO
 * portal — so it stays inside the editor wrapper and an open dropdown never
 * trips InlineTextEditor's outside-pointerdown commit.
 */

/** Font sizes offered for spans, in px. The block defaults (14px paragraphs,
 * 32/24/20px headings) come from the renderer; a span mark overrides them. */
const FONT_SIZE_OPTIONS = ["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px"] as const;

/** Email-safe text colors (hex only — every client supports inline hex). */
const TEXT_COLOR_OPTIONS = [
  "#1a1a2e",
  "#6b7280",
  "#b91c1c",
  "#c2410c",
  "#a16207",
  "#15803d",
  "#1d4ed8",
  "#7e22ce",
  "#be185d",
  "#ffffff",
] as const;

/** Soft background colors that keep dark text readable. */
const HIGHLIGHT_COLOR_OPTIONS = [
  "#fff3a3",
  "#fecaca",
  "#fed7aa",
  "#bbf7d0",
  "#bfdbfe",
  "#e9d5ff",
  "#fbcfe8",
  "#e5e7eb",
] as const;

interface SpanControlShellProps {
  name: string;
  isActive: boolean;
  trigger: ReactNode;
  /** Popover content; call `close` after applying a selection. */
  children: (close: () => void) => ReactNode;
}

/**
 * Trigger button (BubbleMenuItem, matching the B/I/U/S look) + in-place
 * popover. The popover closes on pointerdown outside the control and on
 * Escape (capture-phase, stopping propagation so an open popover swallows
 * the Escape instead of the editor committing the session).
 */
function SpanControlShell({ name, isActive, trigger, children }: SpanControlShellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="flock-span-control">
      <BubbleMenuItem
        name={name}
        isActive={isActive || isOpen}
        onCommand={() => setIsOpen((wasOpen) => !wasOpen)}
        // Keep the editor's selection: never let the trigger steal focus.
        onPointerDown={(event) => event.preventDefault()}
      >
        {trigger}
      </BubbleMenuItem>
      {isOpen && <div className="flock-span-popover">{children(() => setIsOpen(false))}</div>}
    </div>
  );
}

interface OptionRowProps {
  isActive: boolean;
  onSelect: () => void;
  style?: React.CSSProperties;
  children: ReactNode;
}

function OptionRow({ isActive, onSelect, style, children }: OptionRowProps) {
  return (
    <button
      type="button"
      className="flock-span-option"
      data-active={isActive || undefined}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      <span className="flock-span-option-label" style={style}>
        {children}
      </span>
      {isActive && <CheckIcon width={14} height={14} />}
    </button>
  );
}

interface SwatchGridProps {
  colors: readonly string[];
  activeColor: string | undefined;
  onSelect: (color: string) => void;
}

function SwatchGrid({ colors, activeColor, onSelect }: SwatchGridProps) {
  return (
    <div className="flock-swatch-grid">
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          className="flock-swatch"
          data-active={color === activeColor || undefined}
          style={{ backgroundColor: color }}
          aria-label={color}
          title={color}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onSelect(color)}
        />
      ))}
    </div>
  );
}

/** Reactive read of the selection's textStyle/highlight attrs. */
function useSpanStyleState(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      const textStyle = instance.getAttributes("textStyle");
      const highlight = instance.getAttributes("highlight");
      return {
        fontFamily: typeof textStyle.fontFamily === "string" ? textStyle.fontFamily : undefined,
        fontSize: typeof textStyle.fontSize === "string" ? textStyle.fontSize : undefined,
        color: typeof textStyle.color === "string" ? textStyle.color : undefined,
        highlightColor: typeof highlight.color === "string" ? highlight.color : undefined,
      };
    },
  });
}

export function FontFamilySelector() {
  const { editor } = useBubbleMenuContext();
  const { fontFamily } = useSpanStyleState(editor);
  const activeOption = EMAIL_SAFE_FONT_OPTIONS.find((option) => option.value === fontFamily);

  const selectFont = ({ value, close }: { value: string | undefined; close: () => void }) => {
    if (value === undefined) {
      editor.chain().focus().unsetFontFamily().run();
    } else {
      editor.chain().focus().setFontFamily(value).run();
    }
    close();
  };

  return (
    <SpanControlShell
      name="Font family"
      isActive={fontFamily !== undefined}
      trigger={
        <span className="flock-span-trigger-label">
          <span style={activeOption !== undefined ? { fontFamily: activeOption.value } : undefined}>
            {activeOption?.label ?? "Font"}
          </span>
          <ChevronDownIcon width={12} height={12} />
        </span>
      }
    >
      {(close) => (
        <>
          <OptionRow
            isActive={fontFamily === undefined}
            onSelect={() => selectFont({ value: undefined, close })}
          >
            Default
          </OptionRow>
          {EMAIL_SAFE_FONT_OPTIONS.map((option) => (
            <OptionRow
              key={option.value}
              isActive={option.value === fontFamily}
              onSelect={() => selectFont({ value: option.value, close })}
              style={{ fontFamily: option.value }}
            >
              {option.label}
            </OptionRow>
          ))}
        </>
      )}
    </SpanControlShell>
  );
}

export function FontSizeSelector() {
  const { editor } = useBubbleMenuContext();
  const { fontSize } = useSpanStyleState(editor);

  const selectSize = ({ value, close }: { value: string | undefined; close: () => void }) => {
    if (value === undefined) {
      editor.chain().focus().unsetFontSize().run();
    } else {
      editor.chain().focus().setFontSize(value).run();
    }
    close();
  };

  return (
    <SpanControlShell
      name="Font size"
      isActive={fontSize !== undefined}
      trigger={
        <span className="flock-span-trigger-label">
          <span>{fontSize !== undefined ? fontSize.replace("px", "") : "Size"}</span>
          <ChevronDownIcon width={12} height={12} />
        </span>
      }
    >
      {(close) => (
        <>
          <OptionRow
            isActive={fontSize === undefined}
            onSelect={() => selectSize({ value: undefined, close })}
          >
            Default
          </OptionRow>
          {FONT_SIZE_OPTIONS.map((option) => (
            <OptionRow
              key={option}
              isActive={option === fontSize}
              onSelect={() => selectSize({ value: option, close })}
            >
              {option.replace("px", "")} px
            </OptionRow>
          ))}
        </>
      )}
    </SpanControlShell>
  );
}

export function TextColorSelector() {
  const { editor } = useBubbleMenuContext();
  const { color } = useSpanStyleState(editor);

  const selectColor = ({ value, close }: { value: string | undefined; close: () => void }) => {
    if (value === undefined) {
      editor.chain().focus().unsetColor().run();
    } else {
      editor.chain().focus().setColor(value).run();
    }
    close();
  };

  return (
    <SpanControlShell
      name="Text color"
      isActive={color !== undefined}
      trigger={
        <span className="flock-span-trigger-label">
          <span className="flock-color-a" style={{ borderBottomColor: color ?? "currentColor" }}>
            A
          </span>
          <ChevronDownIcon width={12} height={12} />
        </span>
      }
    >
      {(close) => (
        <>
          <SwatchGrid
            colors={TEXT_COLOR_OPTIONS}
            activeColor={color}
            onSelect={(value) => selectColor({ value, close })}
          />
          <OptionRow
            isActive={color === undefined}
            onSelect={() => selectColor({ value: undefined, close })}
          >
            Default
          </OptionRow>
        </>
      )}
    </SpanControlShell>
  );
}

export function HighlightSelector() {
  const { editor } = useBubbleMenuContext();
  const { highlightColor } = useSpanStyleState(editor);

  const selectColor = ({ value, close }: { value: string | undefined; close: () => void }) => {
    if (value === undefined) {
      editor.chain().focus().unsetHighlight().run();
    } else {
      editor.chain().focus().setHighlight({ color: value }).run();
    }
    close();
  };

  return (
    <SpanControlShell
      name="Highlight"
      isActive={highlightColor !== undefined}
      trigger={
        <span className="flock-span-trigger-label">
          <HighlighterIcon
            width={14}
            height={14}
            style={highlightColor !== undefined ? { color: highlightColor } : undefined}
          />
          <ChevronDownIcon width={12} height={12} />
        </span>
      }
    >
      {(close) => (
        <>
          <SwatchGrid
            colors={HIGHLIGHT_COLOR_OPTIONS}
            activeColor={highlightColor}
            onSelect={(value) => selectColor({ value, close })}
          />
          <OptionRow
            isActive={highlightColor === undefined}
            onSelect={() => selectColor({ value: undefined, close })}
          >
            None
          </OptionRow>
        </>
      )}
    </SpanControlShell>
  );
}
