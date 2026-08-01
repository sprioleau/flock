import type { GlobalStyles } from "@flock/email-sdk";
import { cn } from "@/lib/utils";
import { formatTransitionTooltip, type ValueTransition } from "./value-transition";

/**
 * The compact before → after glance appended to op-log rows, rendering a
 * `ValueTransition` from value-transition.ts. Purely additive next to the
 * existing text labels:
 * - color:  two small circles with an arrow — the same circle language as the
 *   theme dropdown's ThemeSwatch (border ring for near-white visibility).
 * - number: "24 → 12px" in compact mono.
 * - text:   "left → center" in compact mono.
 * - theme:  two mini email/content circle stacks (ThemeSwatch's two-circle
 *   cue, miniaturized) with an arrow.
 * Raw values always available via the title tooltip.
 */
export function BeforeAfterChip({
  transition,
  className,
}: {
  transition: ValueTransition;
  className?: string;
}) {
  const tooltip = formatTransitionTooltip(transition);

  if (transition.kind === "color") {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center gap-1 align-middle", className)}
        title={tooltip}
        data-testid="before-after-chip"
        data-transition-kind="color"
      >
        <ColorDot color={transition.before} />
        <TransitionArrow />
        <ColorDot color={transition.after} />
      </span>
    );
  }

  if (transition.kind === "theme") {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center gap-1 align-middle", className)}
        title={tooltip}
        data-testid="before-after-chip"
        data-transition-kind="theme"
      >
        <ThemeDotPair globals={transition.before} />
        <TransitionArrow />
        <ThemeDotPair globals={transition.after} />
      </span>
    );
  }

  const afterWithUnit =
    transition.kind === "number" ? `${transition.after}${transition.unit}` : transition.after;
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px] whitespace-nowrap text-muted-foreground",
        transition.kind === "number" && "tabular-nums",
        className,
      )}
      title={tooltip}
      data-testid="before-after-chip"
      data-transition-kind={transition.kind}
    >
      {transition.before} → {afterWithUnit}
    </span>
  );
}

/** One color circle, ringed like ThemeSwatch so near-white stays visible. */
function ColorDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-3 shrink-0 rounded-full border border-foreground/15"
      style={{ backgroundColor: color }}
    />
  );
}

function TransitionArrow() {
  return (
    <span aria-hidden className="text-[9px] leading-none text-muted-foreground/70">
      →
    </span>
  );
}

/**
 * ThemeSwatch's two-circle cue at chip scale: BACK circle = email (canvas)
 * background, FRONT circle = content (sections') background.
 */
function ThemeDotPair({ globals }: { globals: Required<GlobalStyles> }) {
  return (
    <span className="relative inline-block h-3 w-[18px] shrink-0" aria-hidden>
      <span
        className="absolute top-0 left-0 size-3 rounded-full border border-foreground/15"
        style={{ backgroundColor: globals.emailBackgroundColor }}
      />
      <span
        className="absolute top-0 left-1.5 size-3 rounded-full border border-foreground/15"
        style={{ backgroundColor: globals.contentBackgroundColor }}
      />
    </span>
  );
}
