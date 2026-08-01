import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  GATE_COOKIE_NAME,
  GATE_RETURN_TO_PARAM,
  deriveGateCookieValue,
  getAccessPassword,
  isMatchingSecret,
  resolveReturnToPath,
} from "@/lib/access-gate";
import { GateForm } from "./GateForm";

export const metadata: Metadata = {
  title: "Flock",
  description: "Private preview",
};

export default async function GatePage({ searchParams }: PageProps<"/gate">) {
  const resolvedSearchParams = await searchParams;
  const rawReturnTo = resolvedSearchParams[GATE_RETURN_TO_PARAM];
  const returnToPath = resolveReturnToPath(
    Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo,
  );

  const password = getAccessPassword();
  if (password === undefined) {
    // Gate disabled — nothing to guard, don't strand visitors here.
    redirect(returnToPath);
  }

  // Already unlocked (e.g. deep link to /gate) → pass straight through.
  const cookieStore = await cookies();
  const gateCookieValue = cookieStore.get(GATE_COOKIE_NAME)?.value;
  if (
    gateCookieValue !== undefined &&
    isMatchingSecret({
      providedValue: gateCookieValue,
      expectedValue: deriveGateCookieValue(password),
    })
  ) {
    redirect(returnToPath);
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">Flock</h1>
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          This is a private preview. Enter the access password to continue.
        </p>
      </div>
      <div className="w-full max-w-xs rounded-xl border border-border bg-card p-6 shadow-sm">
        <GateForm returnToPath={returnToPath} />
      </div>
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        Have a shared email link? Open it directly — links with a document id
        don&apos;t need the password.
      </p>
    </main>
  );
}
