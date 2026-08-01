/**
 * The framework-free state machine behind the composer mic buttons (voice
 * input). Wraps the browser's Web Speech API `SpeechRecognition` (Chrome
 * ships it as `webkitSpeechRecognition`) behind a small controller so the
 * React hook stays a thin adapter and THIS logic is unit-testable in the
 * node-env vitest setup with a mocked recognition object.
 *
 * Dictation model (per the MDN SpeechRecognition reference):
 * - `continuous = false` — one utterance per session; the service stops on
 *   its own after silence, which gives us "stop on silence" for free.
 * - `interimResults = true` — not-yet-final hypotheses stream into the input
 *   as the user speaks (appended after the text that was already there).
 * - Nothing auto-sends: the controller only produces TEXT via
 *   `onTranscriptChange`; the user reviews and sends.
 *
 * Transcript composition: `start(baseText)` snapshots the input's current
 * text; every recognition result re-renders `base + finals + interim` from
 * scratch (results are re-read whole each event, the robust pattern for this
 * API). When the session ends, any dangling interim text is COMMITTED —
 * words the user watched appear must never vanish because the recognizer
 * quit before finalizing them.
 */

/** The subset of SpeechRecognition this controller touches (mockable). */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

export interface SpeechRecognitionResultEventLike {
  results: ArrayLike<{ readonly isFinal: boolean; 0: { readonly transcript: string } }>;
}

export interface SpeechRecognitionErrorEventLike {
  error: string;
}

/**
 * Resolves the browser's SpeechRecognition constructor: the standard name
 * first, then Chrome/Safari's `webkit` prefix. Null when the browser (or a
 * non-browser environment like SSR) does not support speech recognition —
 * callers hide the mic entirely in that case.
 */
export function getSpeechRecognitionConstructor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") {
    return null;
  }
  const speechWindow = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

/**
 * User-facing copy for SpeechRecognitionErrorEvent codes (the raw codes are
 * developer-facing strings like "not-allowed"). "aborted" maps to null — the
 * user cancelled on purpose, so there is nothing to report.
 */
export function getSpeechErrorMessage(errorCode: string): string | null {
  switch (errorCode) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow it in your browser settings to use voice input.";
    case "no-speech":
      return "No speech was detected. Tap the mic and try again.";
    case "audio-capture":
      return "No microphone was found. Check that one is connected and try again.";
    case "network":
      return "Voice input needs a network connection. Check yours and try again.";
    default:
      return "Voice input ran into a problem. Try again.";
  }
}

/** Joins dictated text onto existing input text with a single space seam. */
function appendTranscript({ baseText, transcript }: { baseText: string; transcript: string }): string {
  const trimmedTranscript = transcript.trim();
  if (trimmedTranscript.length === 0) {
    return baseText;
  }
  if (baseText.length === 0) {
    return trimmedTranscript;
  }
  const separator = /\s$/.test(baseText) ? "" : " ";
  return `${baseText}${separator}${trimmedTranscript}`;
}

export interface SpeechInputController {
  /** True when a recognition session is active (listening). */
  getIsListening: () => boolean;
  /**
   * Begins a dictation session appending onto `baseText` (the input's
   * current text). No-op while already listening or when unsupported.
   */
  start: (baseText: string) => void;
  /** Ends the session, keeping everything captured so far (incl. interim). */
  stop: () => void;
  /** Ends the session and discards it silently (used on unmount). */
  abort: () => void;
}

export function createSpeechInputController({
  createRecognition,
  onTranscriptChange,
  onListeningChange,
  onError,
}: {
  /** Factory for a fresh recognition object; null when unsupported. */
  createRecognition: () => SpeechRecognitionLike | null;
  /** Receives the FULL input text (base + dictation) on every update. */
  onTranscriptChange: (text: string) => void;
  onListeningChange: (isListening: boolean) => void;
  /** Receives user-facing copy (never raw error codes). */
  onError: (message: string) => void;
}): SpeechInputController {
  let activeRecognition: SpeechRecognitionLike | null = null;
  let baseText = "";
  let latestCombinedText = "";
  let hasUncommittedInterim = false;

  const endSession = (): void => {
    activeRecognition = null;
    onListeningChange(false);
  };

  return {
    getIsListening: () => activeRecognition !== null,

    start: (startingText: string): void => {
      if (activeRecognition !== null) {
        return;
      }
      const recognition = createRecognition();
      if (recognition === null) {
        return;
      }
      baseText = startingText;
      latestCombinedText = startingText;
      hasUncommittedInterim = false;

      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      // Recognize in the UI language the user is already working in.
      recognition.lang = typeof navigator === "undefined" ? "en-US" : navigator.language;

      recognition.onresult = (event) => {
        // Re-read the whole result list each event: finals accumulate in
        // order, interims are the still-changing tail.
        let finalTranscript = "";
        let interimTranscript = "";
        for (let resultIndex = 0; resultIndex < event.results.length; resultIndex += 1) {
          const result = event.results[resultIndex];
          if (result.isFinal) {
            finalTranscript += ` ${result[0].transcript}`;
          } else {
            interimTranscript += ` ${result[0].transcript}`;
          }
        }
        const finalizedText = appendTranscript({ baseText, transcript: finalTranscript });
        latestCombinedText = appendTranscript({
          baseText: finalizedText,
          transcript: interimTranscript,
        });
        hasUncommittedInterim = interimTranscript.trim().length > 0;
        onTranscriptChange(latestCombinedText);
      };

      recognition.onerror = (event) => {
        const message = getSpeechErrorMessage(event.error);
        if (message !== null) {
          onError(message);
        }
        // onend follows onerror in the API; endSession there handles state.
      };

      recognition.onend = () => {
        // Commit any dangling interim text — the user watched it appear.
        if (hasUncommittedInterim) {
          hasUncommittedInterim = false;
          onTranscriptChange(latestCombinedText);
        }
        endSession();
      };

      onListeningChange(true);
      recognition.start();
      activeRecognition = recognition;
    },

    stop: (): void => {
      // stop() (not abort) so the service finalizes what it captured; the
      // onend handler then commits and flips the listening state.
      activeRecognition?.stop();
    },

    abort: (): void => {
      if (activeRecognition === null) {
        return;
      }
      const recognition = activeRecognition;
      // Drop handlers first: an aborted session must not mutate state that
      // belongs to a component that is unmounting.
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      endSession();
      recognition.abort();
    },
  };
}
