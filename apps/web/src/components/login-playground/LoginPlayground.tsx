"use client";

import type { ReactNode } from "react";
import { Logo } from "@/components/ui/logo";
import { cn } from "@/lib/utils";
import type { ShowcaseTarget } from "./showcase-scene";
import { useShowcaseLoop } from "./use-showcase-loop";

function getSelectionClassName({
  selectedTarget,
  target,
}: {
  selectedTarget: ShowcaseTarget | null;
  target: ShowcaseTarget;
}): string {
  return selectedTarget === target
    ? "ring-2 ring-violet-400 ring-offset-4 ring-offset-[#17132d]"
    : "ring-0";
}

export function LoginPlayground({ loginDock }: { loginDock: ReactNode }) {
  const { scene, isReducedMotion, restartShowcase } = useShowcaseLoop();

  return (
    <div
      className="relative min-h-svh overflow-x-hidden text-neutral-950 dark:text-neutral-50"
      data-testid="login-playground"
    >
      <header className="absolute top-5 left-5 z-20 flex items-center gap-3 sm:top-7 sm:left-7">
        <div role="img" aria-label="Flock">
          <Logo
            variant="full_horizontal"
            className="w-28 sm:w-32"
            style={{ color: "var(--foreground)" }}
          />
        </div>
        <span className="hidden border-l border-border pl-3 text-xs text-muted-foreground sm:block">
          Humans and agents, building together
        </span>
      </header>

      <main className="relative z-10 mx-auto flex min-h-[42rem] w-full max-w-[96rem] items-center justify-center px-4 pt-24 pb-8 sm:px-8 lg:min-h-svh lg:pl-[23rem] lg:pr-10 lg:py-24">
        <section
          className="w-full max-w-5xl"
          aria-label="Live email collaboration showcase"
        >
          <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-semibold tracking-[0.18em] text-violet-700 uppercase dark:text-violet-300">
                Simulated collaboration
              </p>
              <h1 className="mt-1 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
                Watch a message get better, together.
              </h1>
            </div>
            <button
              type="button"
              onClick={restartShowcase}
              className="w-fit rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm font-medium shadow-sm transition hover:border-violet-400 hover:text-violet-700 focus-visible:ring-3 focus-visible:ring-violet-400/40 focus-visible:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-violet-500 dark:hover:text-violet-300"
            >
              Try a clearer headline
            </button>
          </div>

          <div className="overflow-hidden rounded-[1.75rem] border border-black/10 bg-neutral-100/90 shadow-2xl shadow-violet-950/10 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/85">
            <div className="grid lg:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="relative min-h-[31rem] overflow-hidden p-5 sm:p-8">
                <div className="mx-auto max-w-xl overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl shadow-black/10">
                  <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 text-[11px] text-neutral-500">
                    <span>Campaign draft</span>
                    <span>Live review</span>
                  </div>
                  <div className="bg-[#17132d] px-7 py-7 text-white sm:px-10 sm:py-9">
                    <p className="text-[10px] font-bold tracking-[0.2em] text-[#a99fff] uppercase">
                      Flock product update
                    </p>
                    <h2
                      className={cn(
                        "mt-4 rounded-sm text-3xl leading-tight font-semibold tracking-tight transition-[box-shadow] duration-300 sm:text-4xl",
                        getSelectionClassName({
                          selectedTarget: scene.selectedTarget,
                          target: "headline",
                        }),
                      )}
                      data-showcase-target="headline"
                    >
                      {scene.email.headline}
                    </h2>
                    <p
                      className={cn(
                        "mt-5 rounded-sm text-sm leading-6 text-violet-100 transition-[box-shadow] duration-300 sm:text-base",
                        getSelectionClassName({
                          selectedTarget: scene.selectedTarget,
                          target: "supporting-copy",
                        }),
                      )}
                      data-showcase-target="supporting-copy"
                    >
                      {scene.email.supportingCopy}
                    </p>
                    <span
                      className={cn(
                        "mt-7 inline-flex rounded-md bg-[#d9ff65] px-4 py-2.5 text-sm font-semibold text-[#17132d] transition-[box-shadow] duration-300",
                        getSelectionClassName({
                          selectedTarget: scene.selectedTarget,
                          target: "cta",
                        }),
                      )}
                      data-showcase-target="cta"
                    >
                      {scene.email.cta}
                    </span>
                  </div>
                  <div className="grid gap-4 px-7 py-6 text-neutral-900 sm:grid-cols-3 sm:px-10">
                    <div>
                      <p className="text-xs font-semibold">One shared canvas</p>
                      <p className="mt-1 text-xs leading-5 text-neutral-500">Every idea stays visible.</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold">Three perspectives</p>
                      <p className="mt-1 text-xs leading-5 text-neutral-500">Each agent has a clear role.</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold">You stay in control</p>
                      <p className="mt-1 text-xs leading-5 text-neutral-500">Changes remain inspectable.</p>
                    </div>
                  </div>
                </div>

                <div
                  className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
                  aria-hidden="true"
                  data-testid="mock-agent-cursor-layer"
                >
                  {scene.cursors.map((cursor) => (
                    <div
                      key={cursor.id}
                      className={cn(
                        "absolute flex items-start gap-1 transition-[left,top] duration-1000 ease-in-out motion-reduce:transition-none",
                        cursor.isActive ? "z-20" : "z-10",
                      )}
                      style={{
                        left: `${cursor.waypoint.xPercent}%`,
                        top: `${cursor.waypoint.yPercent}%`,
                      }}
                      data-mock-agent-cursor={cursor.id}
                    >
                      <span
                        className="mt-0.5 block size-0 border-x-[7px] border-t-[15px] border-x-transparent drop-shadow"
                        style={{ borderTopColor: cursor.color, transform: "rotate(-28deg)" }}
                      />
                      <span
                        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold text-white shadow-lg"
                        style={{ backgroundColor: cursor.color }}
                      >
                        <span className="grid size-4 place-items-center rounded-full bg-white/20 text-[9px]">
                          {cursor.glyph}
                        </span>
                        {cursor.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <aside className="border-t border-black/10 bg-white/75 p-5 dark:border-white/10 dark:bg-white/5 lg:border-t-0 lg:border-l">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold">Collaboration activity</h2>
                  <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    {isReducedMotion ? "Summary" : "Live"}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {scene.activeBeat.activity}
                </p>
                <ol
                  className="mt-5 space-y-2"
                  aria-label="Collaboration activity"
                  aria-live="polite"
                >
                  {scene.completedActivities.slice(-4).map((activity) => (
                    <li
                      key={activity}
                      className="rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground"
                    >
                      {activity}
                    </li>
                  ))}
                </ol>
                <ul className="mt-5 flex flex-wrap gap-2" aria-label="Agent roles">
                  {scene.cursors.map((cursor) => (
                    <li
                      key={cursor.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-2 py-1 text-[10px]"
                      title={cursor.role}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: cursor.color }}
                      />
                      {cursor.name}
                    </li>
                  ))}
                </ul>
                <div className="mt-5 border-t border-border pt-4">
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    This preview is a deterministic simulation. It uses no model calls or user data.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </section>
      </main>

      <aside
        className="relative z-20 mx-4 mb-5 rounded-2xl border border-border bg-card/90 p-5 shadow-xl backdrop-blur-xl sm:mx-8 sm:mb-8 lg:fixed lg:bottom-6 lg:left-6 lg:m-0 lg:w-[20rem]"
        aria-label="Sign in to Flock"
        data-testid="login-dock"
      >
        <p className="mb-4 text-sm font-semibold">Keep your work close</p>
        {loginDock}
      </aside>
    </div>
  );
}
