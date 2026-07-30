import type { GlobalStyles } from "@tandem/email-sdk";

/**
 * The visual cue for one theme: a bare "Aa" glyph showing the theme's text
 * colors (capital A = heading color, lowercase a = paragraph color, set in
 * the theme's heading font — no chip or border, the colored glyph IS the
 * icon), plus two overlapping circles — BACK circle = the email
 * (outer/canvas) background, FRONT circle = the content (sections')
 * background.
 */
export function ThemeSwatch({ globals }: { globals: Required<GlobalStyles> }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
      <span
        className="flex h-6 w-7 items-center justify-center text-[13px] leading-none font-semibold"
        style={{ fontFamily: globals.heading1FontFamily }}
      >
        <span style={{ color: globals.heading1TextColor }}>A</span>
        <span style={{ color: globals.paragraphTextColor }}>a</span>
      </span>
      <span className="relative h-6 w-8">
        {/* Back circle: email (outer) background */}
        <span
          className="absolute top-1/2 left-0 size-5 -translate-y-1/2 rounded-full border border-foreground/15"
          style={{ backgroundColor: globals.emailBackgroundColor }}
        />
        {/* Front circle: content (inner) background */}
        <span
          className="absolute top-1/2 left-3 size-5 -translate-y-1/2 rounded-full border border-foreground/15"
          style={{ backgroundColor: globals.contentBackgroundColor }}
        />
      </span>
    </span>
  );
}
