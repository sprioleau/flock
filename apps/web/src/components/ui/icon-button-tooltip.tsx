"use client";

import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export function IconButtonTooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: ReactNode;
  side?: "bottom" | "inline-end" | "inline-start" | "left" | "right" | "top";
}) {
  return (
    <TooltipProvider delay={250}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
