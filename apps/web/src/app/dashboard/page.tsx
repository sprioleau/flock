import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { isAuthenticatedSafely } from "@/lib/auth/auth-server";
import { isAuthEnabled, LOGIN_PATH } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Your emails — Flock",
  description: "Everything you've made in Flock, ready to pick back up.",
};

/**
 * The post-sign-in landing page. Signing in comes FIRST: a visitor with no
 * identity is sent to the front door rather than shown a dashboard that can
 * only ever be empty for them.
 *
 * The redirect is one-way, so it cannot loop: `/` sends you here only when
 * {@link isAuthenticatedSafely} says yes, and here sends you back only when it
 * says no. Both read that single answer, so they cannot disagree.
 *
 * With the auth flag OFF there is no identity to establish and `/` forwards
 * everyone here — so gating would strand every visitor. The flag check is what
 * keeps this page reachable in that configuration.
 *
 * Share links are UNAFFECTED. They point at `/studio?doc=`, which has no gate
 * at all: the id is still the capability, and this page is a convenience index
 * over what an identity owns, never the way in to a document.
 *
 * DashboardShell keeps its own signed-out state for the case this cannot
 * catch: a valid Next-side session whose identity Convex declines to verify
 * (strict mode). The server says yes, the data layer says nobody — that
 * mismatch renders here, it does not redirect.
 */
export default async function DashboardPage() {
  if (isAuthEnabled() && !(await isAuthenticatedSafely())) {
    redirect(LOGIN_PATH);
  }

  return <DashboardShell />;
}
