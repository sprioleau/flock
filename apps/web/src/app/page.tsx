import { ConvexHealthBadge } from "./ConvexHealthBadge";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">Tandem</h1>
      <p className="max-w-md text-center text-muted-foreground">
        An AI-powered collaborative email editor. You describe, your partner
        builds.
      </p>
      <ConvexHealthBadge />
      <p className="text-xs text-muted-foreground">
        Phase 0 — deploy skeleton: Next.js + Convex + Vercel
      </p>
    </main>
  );
}
