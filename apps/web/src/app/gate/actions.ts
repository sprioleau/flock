"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  GATE_COOKIE_MAX_AGE_SECONDS,
  GATE_COOKIE_NAME,
  GATE_RETURN_TO_PARAM,
  deriveGateCookieValue,
  getAccessPassword,
  isMatchingSecret,
  resolveReturnToPath,
} from "@/lib/access-gate";

export type UnlockGateState = {
  errorMessage: string | null;
};

/**
 * Server action for the gate form. Correct password → set the gate cookie
 * (an HMAC derived from the password env, never the raw password; ~30 days)
 * and redirect back to the originally-requested URL. Wrong password → return
 * a friendly error for useActionState.
 */
export async function unlockGate(
  _previousState: UnlockGateState,
  formData: FormData,
): Promise<UnlockGateState> {
  const password = getAccessPassword();
  if (password === undefined) {
    // Gate disabled — nothing to unlock.
    redirect("/");
  }

  const submittedPassword = formData.get("password");
  const isCorrectPassword =
    typeof submittedPassword === "string" &&
    submittedPassword.length > 0 &&
    isMatchingSecret({
      providedValue: submittedPassword,
      expectedValue: password,
    });

  if (!isCorrectPassword) {
    return { errorMessage: "That password isn't right — try again." };
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: GATE_COOKIE_NAME,
    value: deriveGateCookieValue(password),
    maxAge: GATE_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });

  redirect(resolveReturnToPath(formData.get(GATE_RETURN_TO_PARAM)));
}
