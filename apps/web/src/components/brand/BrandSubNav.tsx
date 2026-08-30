"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND_PATH } from "@/lib/auth/config";
import { cn } from "@/lib/utils";
import { BRAND_SECTIONS, DEFAULT_BRAND_SECTION } from "./brand-sections";

/*
  The section sub-nav for the /brand workspace — the second column, inside the
  app rail. Lives in the layout so it persists across section navigations
  without remounting (only the content column swaps).

  Active state is derived from the path: bare /brand highlights the default
  section, matching {@link resolveBrandSection}'s fallback, so the sub-nav and
  the page never disagree about which section is showing.
*/
export function BrandSubNav() {
  const pathname = usePathname();
  const activeSlug =
    pathname === BRAND_PATH || pathname === `${BRAND_PATH}/`
      ? DEFAULT_BRAND_SECTION.slug
      : pathname.slice(`${BRAND_PATH}/`.length);
  return (
    <nav
      aria-label="Brand sections"
      className="w-48 shrink-0 border-r px-3 py-6"
    >
      <h2 className="px-2.5 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Brand
      </h2>
      <ul className="flex flex-col gap-0.5">
        {BRAND_SECTIONS.map((section) => {
          const isActive = section.slug === activeSlug;
          return (
            <li key={section.slug}>
              <Link
                href={`${BRAND_PATH}/${section.slug}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
