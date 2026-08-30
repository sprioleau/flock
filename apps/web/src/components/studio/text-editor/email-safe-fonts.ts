/*
  Email-safe font stacks — fonts reliably installed across mail clients, each
  with fallbacks.

  THE list: the bubble menu's span font picker, the block property panels'
  per-block font overrides, and the document settings' theme fonts all read
  it, so a font chosen on any surface resolves to the same stack. The
  Helvetica entry matches the SDK's DEFAULT_FONT_STACK byte-for-byte, so an
  untouched document/block shows "Helvetica" instead of "Custom".
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
