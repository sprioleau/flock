"use client";

import {
  LayoutDashboardIcon,
  PaletteIcon,
  PlayIcon,
  SquarePenIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/logo";
import { UserButton } from "@/lib/auth/UserButton";
import {
  BRAND_PATH,
  DASHBOARD_PATH,
  DEMO_PATH,
  STUDIO_PATH,
} from "@/lib/auth/config";
import { cn } from "@/lib/utils";

/*
  The app's persistent left navigation rail (brand-memory §"immersive page").

  Flock had NO global navigation before this: /dashboard, /studio, /demo and
  the (new) /brand page were islands reachable only by knowing the URL or by a
  one-off link buried in some other surface. The rail is the first thing that
  makes them one application you can move around in.

  Scope this slice: the rail wraps /dashboard and /brand (the two "management"
  surfaces). /studio keeps its own full-height canvas chrome — a persistent
  rail inside the editor is a larger UX change and gets its own pass — so the
  rail deliberately still LISTS the editor as a destination without being
  mounted there.

  Account + the claim-your-work call to action live at the bottom via
  {@link UserButton}, which renders itself only when auth is enabled and shows
  the anonymous-vs-claimed state and the "email me a link" action. When auth
  is off it renders nothing, and the rail simply has no account row — the same
  graceful absence the rest of the app relies on.
*/

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /*
    True when the current path should light this item up. `/brand` matches all
    of its sections; the others match their exact route.
  */
  isActive: (pathname: string) => boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  {
    label: "Dashboard",
    href: DASHBOARD_PATH,
    icon: LayoutDashboardIcon,
    isActive: (pathname) => pathname === DASHBOARD_PATH,
  },
  {
    label: "Editor",
    href: STUDIO_PATH,
    icon: SquarePenIcon,
    isActive: (pathname) => pathname === STUDIO_PATH,
  },
  {
    label: "Demo",
    href: DEMO_PATH,
    icon: PlayIcon,
    isActive: (pathname) => pathname === DEMO_PATH,
  },
  {
    label: "Brand",
    href: BRAND_PATH,
    icon: PaletteIcon,
    isActive: (pathname) => pathname === BRAND_PATH || pathname.startsWith(`${BRAND_PATH}/`),
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <nav
        aria-label="Primary"
        className="flex w-56 shrink-0 flex-col gap-1 border-r bg-background px-3 py-4"
      >
        <Link
          href={DASHBOARD_PATH}
          className="mb-3 flex items-center gap-2 px-2 text-sm font-semibold"
          aria-label="Flock home"
        >
          <Logo variant="logomark" className="h-6 w-6" />
          <span>Flock</span>
        </Link>
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const isActive = item.isActive(pathname);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-auto border-t pt-3">
          <UserButton />
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
