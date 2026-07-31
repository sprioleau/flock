/**
 * What happened to a recommendation, in user language (shared by the
 * recommendations modal rows and the facepile hover card): actionable ones
 * are Pending / Applied / Dismissed; advice that carries no ops is
 * Informational (there was never anything to apply).
 */
export function getRecommendationOutcome({
  status,
  isActionable,
}: {
  status: "open" | "dismissed" | "applied";
  isActionable: boolean;
}): { label: string; className: string } {
  if (status === "applied") {
    return {
      label: "Applied",
      className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
    };
  }
  if (status === "dismissed") {
    return { label: "Dismissed", className: "border-border bg-muted text-muted-foreground" };
  }
  if (!isActionable) {
    return { label: "Informational", className: "border-sky-500/40 bg-sky-500/10 text-sky-600" };
  }
  return { label: "Pending", className: "border-amber-500/40 bg-amber-500/10 text-amber-600" };
}
