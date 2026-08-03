"use client";

import type { BrandKitFonts } from "@/lib/brand-kit";
import { isEmailSafeFontStack } from "@/lib/brand-kit-fonts";
import { EMAIL_SAFE_FONT_OPTIONS } from "../text-editor/email-safe-fonts";

/**
 * The kit's heading and body fonts, editable (brand-kit-v2 §1) — what the
 * scrape inferred is a suggestion, the same as the kit name and the palette.
 *
 * Selection only, from {@link EMAIL_SAFE_FONT_OPTIONS} — THE list the block
 * properties panel and the inline text tools already use, so a font picked
 * anywhere in the app resolves to the same stack. Never a free-text field: a
 * typed font that no mail client ships is a broken email nobody sees until it
 * lands.
 *
 * Each option renders in its own face, so the choice is visible before it is
 * made. A stored stack that is not on the list (a legacy or mock kit) shows
 * as a disabled "Custom" entry rather than silently jumping to another font.
 *
 * Commits instantly on change — no Save button, no debounce.
 */
export function BrandFontsEditor({
  fonts,
  onCommit,
}: {
  fonts: BrandKitFonts;
  onCommit: (fonts: BrandKitFonts) => void;
}) {
  const roles = [
    {
      key: "heading" as const,
      label: "Heading",
      stack: fonts.heading,
      commit: (stack: string) => onCommit({ ...fonts, heading: stack }),
    },
    {
      key: "body" as const,
      label: "Body",
      stack: fonts.body,
      commit: (stack: string) => onCommit({ ...fonts, body: stack }),
    },
  ];

  return (
    <div className="flex flex-col gap-2" data-testid="brand-kit-fonts-editor">
      {roles.map((role) => (
        <div key={role.key} className="flex items-center gap-3">
          <label
            htmlFor={`brand-font-${role.key}`}
            className="w-16 shrink-0 text-xs text-muted-foreground"
          >
            {role.label}
          </label>
          <select
            id={`brand-font-${role.key}`}
            value={role.stack}
            className="h-8 min-w-0 flex-1 cursor-pointer rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
            style={{ fontFamily: role.stack }}
            onChange={(event) => role.commit(event.target.value)}
            data-testid={`brand-kit-font-${role.key}`}
          >
            {!isEmailSafeFontStack(role.stack) && (
              <option value={role.stack} disabled>
                Custom
              </option>
            )}
            {EMAIL_SAFE_FONT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} style={{ fontFamily: option.value }}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
