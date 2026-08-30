import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/AppShell";
import { BrandSubNav } from "@/components/brand/BrandSubNav";

export const metadata: Metadata = {
  title: "Brand — Flock",
  description: "Your brand kit and the standing guidance that shapes every email.",
};

/*
  The /brand workspace chrome: the app rail (AppShell) on the far left, the
  section sub-nav next to it, and the selected section's content filling the
  rest. Both navs live here so they persist while only the content column
  swaps between sections.
*/
export default function BrandLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      <div className="flex h-full min-w-0">
        <BrandSubNav />
        <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </AppShell>
  );
}
