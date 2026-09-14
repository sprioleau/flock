"use client";

import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ArtifactProgressStep {
  id: string;
  label: string;
}

export function ArtifactProgressSteps({
  steps,
  currentIndex,
  status,
  label,
}: {
  steps: readonly ArtifactProgressStep[];
  currentIndex: number;
  status: "queued" | "running" | "succeeded" | "failed";
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5" aria-label={label}>
      {steps.map((step, index) => {
        const isComplete = status === "succeeded" || index < currentIndex;
        const isCurrent = status === "running" && index === currentIndex;
        const hasFailed = status === "failed" && index === currentIndex;
        return (
          <div key={step.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            {isComplete ? (
              <CheckIcon className="size-3.5 text-success" />
            ) : isCurrent ? (
              <Loader2Icon className="size-3.5 animate-spin text-primary" />
            ) : hasFailed ? (
              <TriangleAlertIcon className="size-3.5 text-destructive" />
            ) : (
              <span className="ml-1 size-1.5 rounded-full bg-border" />
            )}
            <span className={cn(isCurrent && "text-foreground", hasFailed && "text-destructive")}>
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
