"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, InfoIcon } from "lucide-react";
import { useEditorStore } from "@/lib/editor-store";
import {
  requestPreSendReview,
  summarisePreSendReview,
  type PreSendReviewOutcome,
} from "./pre-send-review-client";

/**
 * The pre-send review, as the user meets it: a quiet block above the Send
 * button listing what will not render in the major email clients.
 *
 * IT NEVER STANDS IN THE WAY. It renders nothing at all while checking and
 * nothing at all if the check could not run, it disables no control, and the
 * submit button beside it does not read its state — a user can send in the
 * same click whether this says nothing, says the email is clean, or lists
 * eight problems. That is the owner's instruction twice over ("advisory, not
 * autocratic"), and it is enforced here by the component simply having no
 * mechanism to refuse.
 *
 * IT RUNS ONCE PER OPEN, not per keystroke. The check is deterministic and
 * costs one render plus a few milliseconds of analysis, but the document does
 * not change while a send dialog is open, so re-running it as the user types
 * their address would be work with no possible new answer.
 */
export function PreSendReviewNotice() {
  const [outcome, setOutcome] = useState<PreSendReviewOutcome>({ status: "checking" });
  /* Orphan a response that lands after the dialog closes, the same discipline
     useSendTestEmail applies to an in-flight send. */
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    requestPreSendReview(useEditorStore.getState().doc)
      .then((next) => {
        if (isMountedRef.current) {
          setOutcome(next);
        }
      })
      .catch(() => {
        if (isMountedRef.current) {
          setOutcome({ status: "unavailable" });
        }
      });
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const summary = summarisePreSendReview(outcome);
  if (summary === null) {
    return null;
  }

  const findings = outcome.status === "ready" ? outcome.findings : [];
  const isClean = findings.length === 0;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3"
      data-testid="pre-send-review"
    >
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {isClean ? (
          <CheckIcon className="size-4 shrink-0" aria-hidden />
        ) : (
          <InfoIcon className="size-4 shrink-0" aria-hidden />
        )}
        {summary}
      </p>
      {isClean ? null : (
        <ul className="flex flex-col gap-2">
          {findings.map((finding) => (
            <li key={finding.id} className="text-sm" data-testid="pre-send-review-finding">
              <span className="font-medium text-foreground">{finding.title}</span>
              <span className="block text-muted-foreground">{finding.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
