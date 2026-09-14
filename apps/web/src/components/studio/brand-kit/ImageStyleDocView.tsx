"use client";

import type { BrandColor } from "@/lib/brand-kit";
import { cn } from "@/lib/utils";
import { EmailDesignDocView } from "./EmailDesignDocView";

/*
  Image-style guidance uses the same safe markdown and inline brand-color chip
  renderer as email-design guidance. The empty state remains specific to this
  artifact so the two routes never describe the wrong document.
*/

export function ImageStyleDocView({
  markdown,
  colors,
  className,
}: {
  markdown: string;
  colors: BrandColor[] | undefined;
  className?: string;
}) {
  if (markdown.trim().length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground italic", className)}>
        No image-style guidance yet.
      </p>
    );
  }

  return (
    <div className={className} data-testid="image-style-doc-view">
      <EmailDesignDocView markdown={markdown} colors={colors} />
    </div>
  );
}
