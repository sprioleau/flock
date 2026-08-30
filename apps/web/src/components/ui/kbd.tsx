import { cn } from "@/lib/utils"

/*
  Keycap chip for shortcut hints (the shadcn Kbd pattern). Carries
  `data-slot="kbd"` so TooltipContent's built-in kbd styling applies when one
  sits inside a tooltip; standalone it renders a muted keycap.
*/
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-sm bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground select-none",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
