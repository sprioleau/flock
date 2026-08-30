"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/*
  App-wide toast system: an imperative `toast.success("…")` API callable from
  anywhere (no hook or context needed — a module-level store bridges into
  React via useSyncExternalStore), rendered by the single `<Toaster />`
  mounted in the root layout. Toasts slide up from the very bottom of the
  viewport, auto-dismiss, and come in success / error / warning / info
  variants with a semantic icon + color (tokens only, so dark mode is free).
*/

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  /*
    Optional smaller second line under the message.
  */
  description?: string;
  /*
    Auto-dismiss delay. Defaults to 4 seconds.
  */
  durationMs?: number;
}

interface ToastRecord {
  id: number;
  variant: ToastVariant;
  message: string;
  description?: string;
  durationMs: number;
}

const DEFAULT_TOAST_DURATION_MS = 4000;
const TOAST_EXIT_ANIMATION_MS = 200;

/*
  ---------------------------------------------------------------------------
  Module-level store (imperative API → React via useSyncExternalStore).
  ---------------------------------------------------------------------------
*/

let toastRecords: readonly ToastRecord[] = [];
let nextToastId = 1;
const storeListeners = new Set<() => void>();

function emitToastsChanged(): void {
  for (const listener of storeListeners) {
    listener();
  }
}

function subscribeToToasts(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getToastsSnapshot(): readonly ToastRecord[] {
  return toastRecords;
}

const EMPTY_TOASTS: readonly ToastRecord[] = [];
function getServerToastsSnapshot(): readonly ToastRecord[] {
  return EMPTY_TOASTS;
}

function addToast({
  variant,
  message,
  options,
}: {
  variant: ToastVariant;
  message: string;
  options?: ToastOptions;
}): number {
  const record: ToastRecord = {
    id: nextToastId++,
    variant,
    message,
    ...(options?.description === undefined ? {} : { description: options.description }),
    durationMs: options?.durationMs ?? DEFAULT_TOAST_DURATION_MS,
  };
  toastRecords = [...toastRecords, record];
  emitToastsChanged();
  return record.id;
}

function removeToast(toastId: number): void {
  if (!toastRecords.some((record) => record.id === toastId)) {
    return;
  }
  toastRecords = toastRecords.filter((record) => record.id !== toastId);
  emitToastsChanged();
}

/*
  Show a toast. Returns the toast id (rarely needed — toasts auto-dismiss).

    toast.success("Section saved");
    toast.error("Couldn't send the test email", { description: reason });
*/
export const toast = {
  success: (message: string, options?: ToastOptions): number =>
    addToast({ variant: "success", message, options }),
  error: (message: string, options?: ToastOptions): number =>
    addToast({ variant: "error", message, options }),
  warning: (message: string, options?: ToastOptions): number =>
    addToast({ variant: "warning", message, options }),
  info: (message: string, options?: ToastOptions): number =>
    addToast({ variant: "info", message, options }),
};

/*
  ---------------------------------------------------------------------------
  Rendering.
  ---------------------------------------------------------------------------
*/

const VARIANT_PRESENTATION: Record<
  ToastVariant,
  { Icon: typeof CircleCheckIcon; iconClassName: string }
> = {
  success: { Icon: CircleCheckIcon, iconClassName: "text-success" },
  error: { Icon: CircleAlertIcon, iconClassName: "text-destructive" },
  warning: { Icon: TriangleAlertIcon, iconClassName: "text-warning" },
  info: { Icon: InfoIcon, iconClassName: "text-info" },
};

/*
  The single toast viewport — mount ONCE in the root layout. Pinned to the
  very bottom of the viewport, centered; stacks bottom-up when several
  toasts are live. The region itself is click-through (pointer-events-none)
  so it never blocks the UI underneath.
*/
export function Toaster() {
  const liveToasts = useSyncExternalStore(
    subscribeToToasts,
    getToastsSnapshot,
    getServerToastsSnapshot,
  );

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      role="region"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 px-4 pb-4"
      data-testid="toaster"
    >
      {liveToasts.map((record) => (
        <ToastItem key={record.id} record={record} />
      ))}
    </div>
  );
}

function ToastItem({ record }: { record: ToastRecord }) {
  /*
    Two-phase dismissal: mark leaving (plays the slide-out), then remove
    from the store once the exit animation has run.
  */
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    const hideTimer = window.setTimeout(() => setIsLeaving(true), record.durationMs);
    return () => window.clearTimeout(hideTimer);
  }, [record.durationMs]);

  useEffect(() => {
    if (!isLeaving) {
      return;
    }
    const removeTimer = window.setTimeout(() => removeToast(record.id), TOAST_EXIT_ANIMATION_MS);
    return () => window.clearTimeout(removeTimer);
  }, [isLeaving, record.id]);

  const { Icon, iconClassName } = VARIANT_PRESENTATION[record.variant];

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg",
        isLeaving
          ? "animate-out fade-out slide-out-to-bottom-4 duration-200 fill-mode-forwards"
          : "animate-in fade-in slide-in-from-bottom-4 duration-300",
      )}
      data-testid={`toast-${record.variant}`}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClassName)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{record.message}</p>
        {record.description !== undefined && (
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{record.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setIsLeaving(true)}
        aria-label="Dismiss notification"
        className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
