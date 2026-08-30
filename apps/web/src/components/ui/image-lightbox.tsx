"use client";

import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";

/*
  A minimal image lightbox built on the app's Dialog primitives: a dimmed
  full-viewport layer with a large contain-fit image on a muted stage, plus
  the standard dismiss affordances — click anywhere off the image, the X
  button, or Escape.

  The popup itself IS the full-screen dimmed layer (not the dialog backdrop):
  base-ui renders a single shared backdrop for nested dialogs and ignores
  presses on the parent's backdrop, so a nested lightbox must own its
  click-out surface to dismiss reliably from inside another dialog.

  Controlled by the caller — render one instance and point it at whichever
  image was selected. `title` doubles as the visible caption and the image's
  alt text.
*/
export function ImageLightbox({
  isOpen,
  onOpenChange,
  imageUrl,
  title,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  imageUrl: string | null;
  title: string;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-dvh max-h-none w-screen max-w-none cursor-zoom-out flex-col items-center justify-center gap-4 rounded-none bg-black/60 p-6 ring-0 sm:max-w-none"
        onClick={(event) => {
          /*
            Only clicks on the dimmed layer itself dismiss — clicks on the
            image, caption, or close button land on those elements instead.
          */
          if (event.target === event.currentTarget) {
            onOpenChange(false);
          }
        }}
        data-testid="image-lightbox"
      >
        <DialogTitle className="cursor-default rounded-full bg-background/90 px-3 py-1 text-sm font-medium shadow-sm backdrop-blur-sm">
          {title}
        </DialogTitle>
        {imageUrl !== null && (
          <div className="flex max-h-[78vh] w-full max-w-3xl cursor-default items-center justify-center overflow-hidden rounded-xl bg-muted p-4 shadow-lg">
            {/*
              Plain <img> on purpose: arbitrary external hosts and data:
              URIs — next/image can't optimize either.
            */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={title}
              className="max-h-[70vh] w-full object-contain"
              data-testid="image-lightbox-image"
            />
          </div>
        )}
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 right-4 cursor-pointer bg-background/80 backdrop-blur-sm hover:bg-background"
            />
          }
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
