"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

/*
  Base UI popover wrapped in app chrome (same pattern as dialog.tsx):
  semantic popover tokens, subtle ring, zoom/fade animation. Content is
  portalled and positioned relative to the trigger.
*/

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  children,
  sideOffset = 6,
  align = "start",
  side = "bottom",
  ...props
}: PopoverPrimitive.Popup.Props & {
  sideOffset?: number
  align?: "start" | "center" | "end"
  side?: "top" | "bottom" | "left" | "right"
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner sideOffset={sideOffset} align={align} side={side} className="z-50">
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "rounded-xl bg-popover p-3 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
