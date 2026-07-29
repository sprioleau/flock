/**
 * Email-safe font stacks — fonts reliably installed across mail clients, each
 * with fallbacks.
 *
 * DUPLICATED from property-panel/DocumentSettingsPanel.tsx's module-private
 * EMAIL_SAFE_FONT_OPTIONS (that file is owner-WIP/frozen territory, and the
 * constant is not exported). Keep the two lists byte-identical so a span
 * font and a block font chosen from either surface resolve to the same
 * stack — the Helvetica stack string also matches the SDK's
 * DEFAULT_FONT_STACK byte-for-byte.
 */
export const EMAIL_SAFE_FONT_OPTIONS = [
  { value: "Helvetica, Arial, sans-serif", label: "Helvetica" },
  { value: "Arial, Helvetica, sans-serif", label: "Arial" },
  { value: "Verdana, Geneva, sans-serif", label: "Verdana" },
  { value: "Tahoma, Geneva, sans-serif", label: "Tahoma" },
  { value: "'Trebuchet MS', Helvetica, sans-serif", label: "Trebuchet MS" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Times New Roman', Times, serif", label: "Times New Roman" },
  { value: "'Courier New', Courier, monospace", label: "Courier New" },
] as const;
