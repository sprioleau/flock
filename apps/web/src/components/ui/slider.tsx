"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

function Slider({ className, ...props }: SliderPrimitive.Root.Props) {
  return (
    <SliderPrimitive.Root data-slot="slider" className={cn("w-full", className)} {...props}>
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="flex w-full touch-none items-center py-1.5 select-none"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 w-full grow rounded-full bg-muted"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-indicator"
            className="absolute h-full rounded-full bg-primary"
          />
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            className={cn(
              "block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm",
              "transition-[color,box-shadow] outline-none hover:ring-3 hover:ring-ring/30",
              "focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
            )}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
