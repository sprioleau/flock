"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  createSpeechInputController,
  getSpeechRecognitionConstructor,
  type SpeechInputController,
} from "./speech-input-controller";

/**
 * React adapter for the voice-input controller (see
 * speech-input-controller.ts — the tested state machine). One instance per
 * composer; the composer passes its current text to `startListening` and
 * receives the full updated text through `onTranscriptChange` as dictation
 * streams in.
 *
 * Support detection is hydration-safe (useSyncExternalStore with a `false`
 * server snapshot): the mic button appears after hydration only in browsers
 * that ship SpeechRecognition, and is absent everywhere else
 * (feature-detected, not disabled).
 */

/** Browser capability — fixed for the page's lifetime, so never re-notifies. */
function subscribeToNothing(): () => void {
  return () => {};
}
function getIsSpeechSupportedSnapshot(): boolean {
  return getSpeechRecognitionConstructor() !== null;
}
function getServerIsSpeechSupportedSnapshot(): boolean {
  return false;
}
export function useSpeechInput({
  onTranscriptChange,
}: {
  onTranscriptChange: (text: string) => void;
}): {
  isSpeechSupported: boolean;
  isListening: boolean;
  speechErrorMessage: string | null;
  startListening: (baseText: string) => void;
  stopListening: () => void;
  toggleListening: (baseText: string) => void;
} {
  const isSpeechSupported = useSyncExternalStore(
    subscribeToNothing,
    getIsSpeechSupportedSnapshot,
    getServerIsSpeechSupportedSnapshot,
  );
  const [isListening, setIsListening] = useState(false);
  const [speechErrorMessage, setSpeechErrorMessage] = useState<string | null>(null);

  // The controller callbacks read through this ref so the latest render's
  // closure handles each transcript update.
  const onTranscriptChangeRef = useRef(onTranscriptChange);
  useEffect(() => {
    onTranscriptChangeRef.current = onTranscriptChange;
  });

  // The controller is created LAZILY on first use (event-handler time, never
  // during render — the react-hooks/refs rule forbids render-time ref reads)
  // and lives for the component's lifetime.
  const controllerRef = useRef<SpeechInputController | null>(null);
  const getController = useCallback((): SpeechInputController => {
    controllerRef.current ??= createSpeechInputController({
      createRecognition: () => {
        const RecognitionConstructor = getSpeechRecognitionConstructor();
        return RecognitionConstructor === null ? null : new RecognitionConstructor();
      },
      onTranscriptChange: (text) => onTranscriptChangeRef.current(text),
      onListeningChange: setIsListening,
      onError: setSpeechErrorMessage,
    });
    return controllerRef.current;
  }, []);

  // Abort (not stop) on unmount: no state updates on an unmounted owner.
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const startListening = useCallback(
    (baseText: string): void => {
      setSpeechErrorMessage(null);
      getController().start(baseText);
    },
    [getController],
  );

  const stopListening = useCallback((): void => {
    getController().stop();
  }, [getController]);

  const toggleListening = useCallback(
    (baseText: string): void => {
      const controller = getController();
      if (controller.getIsListening()) {
        controller.stop();
      } else {
        startListening(baseText);
      }
    },
    [getController, startListening],
  );

  return {
    isSpeechSupported,
    isListening,
    speechErrorMessage,
    startListening,
    stopListening,
    toggleListening,
  };
}
