"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { unlockGate, type UnlockGateState } from "./actions";

const initialState: UnlockGateState = { errorMessage: null };

export function GateForm({ returnToPath }: { returnToPath: string }) {
  const [state, formAction, isPending] = useActionState(
    unlockGate,
    initialState,
  );

  return (
    <form action={formAction} className="flex w-full flex-col gap-3">
      {/* "from" = GATE_RETURN_TO_PARAM (lib/access-gate.ts) — not imported
          here because that module uses node:crypto (server-only). */}
      <input type="hidden" name="from" value={returnToPath} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="gate-password">Password</Label>
        <Input
          id="gate-password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          required
          aria-invalid={state.errorMessage !== null || undefined}
          aria-describedby={
            state.errorMessage !== null ? "gate-error" : undefined
          }
        />
      </div>
      {state.errorMessage !== null ? (
        <p id="gate-error" role="alert" className="text-sm text-destructive">
          {state.errorMessage}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Unlocking…" : "Enter"}
      </Button>
    </form>
  );
}
