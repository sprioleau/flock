import { describe, expect, it } from "vitest";
import {
  createSpeechInputController,
  getSpeechErrorMessage,
  type SpeechInputController,
  type SpeechRecognitionLike,
} from "./speech-input-controller";

/*
  Mock of the browser SpeechRecognition object: records configuration and
  start/stop/abort calls, and lets tests drive the event handlers directly
  (the vitest environment is node — there is no real Web Speech API here).
*/
class MockRecognition implements SpeechRecognitionLike {
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  startCallCount = 0;
  stopCallCount = 0;
  abortCallCount = 0;
  onresult: SpeechRecognitionLike["onresult"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  onend: SpeechRecognitionLike["onend"] = null;
  onstart: SpeechRecognitionLike["onstart"] = null;

  start(): void {
    this.startCallCount += 1;
  }
  stop(): void {
    this.stopCallCount += 1;
  }
  abort(): void {
    this.abortCallCount += 1;
  }

  /*
    Simulates a `result` event from (transcript, isFinal) segment pairs.
  */
  emitResults(segments: Array<{ transcript: string; isFinal: boolean }>): void {
    this.onresult?.({
      results: segments.map((segment) => ({
        isFinal: segment.isFinal,
        0: { transcript: segment.transcript },
      })),
    });
  }
}

function createHarness({ isSupported = true }: { isSupported?: boolean } = {}) {
  const recognitions: MockRecognition[] = [];
  const transcriptUpdates: string[] = [];
  const listeningUpdates: boolean[] = [];
  const errorMessages: string[] = [];
  const controller: SpeechInputController = createSpeechInputController({
    createRecognition: () => {
      if (!isSupported) {
        return null;
      }
      const recognition = new MockRecognition();
      recognitions.push(recognition);
      return recognition;
    },
    onTranscriptChange: (text) => transcriptUpdates.push(text),
    onListeningChange: (isListening) => listeningUpdates.push(isListening),
    onError: (message) => errorMessages.push(message),
  });
  return { controller, recognitions, transcriptUpdates, listeningUpdates, errorMessages };
}

describe("createSpeechInputController", () => {
  it("configures single-utterance dictation with interim results and starts listening", () => {
    const { controller, recognitions, listeningUpdates } = createHarness();
    controller.start("");
    const recognition = recognitions[0];
    expect(recognition.continuous).toBe(false);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.maxAlternatives).toBe(1);
    expect(recognition.startCallCount).toBe(1);
    expect(listeningUpdates).toEqual([true]);
    expect(controller.getIsListening()).toBe(true);
  });

  it("is a no-op when recognition is unsupported", () => {
    const { controller, listeningUpdates, transcriptUpdates } = createHarness({
      isSupported: false,
    });
    controller.start("hello");
    expect(controller.getIsListening()).toBe(false);
    expect(listeningUpdates).toEqual([]);
    expect(transcriptUpdates).toEqual([]);
  });

  it("ignores a second start while already listening", () => {
    const { controller, recognitions } = createHarness();
    controller.start("");
    controller.start("");
    expect(recognitions).toHaveLength(1);
    expect(recognitions[0].startCallCount).toBe(1);
  });

  it("streams interim results appended to the existing text with a space seam", () => {
    const { controller, recognitions, transcriptUpdates } = createHarness();
    controller.start("Make the header");
    recognitions[0].emitResults([{ transcript: "bigger", isFinal: false }]);
    recognitions[0].emitResults([{ transcript: "bigger and bolder", isFinal: false }]);
    expect(transcriptUpdates).toEqual([
      "Make the header bigger",
      "Make the header bigger and bolder",
    ]);
  });

  it("does not add a leading space when the input starts empty", () => {
    const { controller, recognitions, transcriptUpdates } = createHarness();
    controller.start("");
    recognitions[0].emitResults([{ transcript: "add a hero image", isFinal: false }]);
    expect(transcriptUpdates).toEqual(["add a hero image"]);
  });

  it("combines finalized and interim segments in order", () => {
    const { controller, recognitions, transcriptUpdates } = createHarness();
    controller.start("Hello");
    recognitions[0].emitResults([
      { transcript: "make it blue", isFinal: true },
      { transcript: "and centered", isFinal: false },
    ]);
    expect(transcriptUpdates).toEqual(["Hello make it blue and centered"]);
  });

  it("commits dangling interim text when the session ends", () => {
    const { controller, recognitions, transcriptUpdates, listeningUpdates } = createHarness();
    controller.start("");
    recognitions[0].emitResults([{ transcript: "shrink the footer", isFinal: false }]);
    recognitions[0].onend?.();
    /*
      The interim text the user watched appear survives the end of session.
    */
    expect(transcriptUpdates).toEqual(["shrink the footer", "shrink the footer"]);
    expect(listeningUpdates).toEqual([true, false]);
    expect(controller.getIsListening()).toBe(false);
  });

  it("does not re-emit the transcript on end when everything was finalized", () => {
    const { controller, recognitions, transcriptUpdates } = createHarness();
    controller.start("");
    recognitions[0].emitResults([{ transcript: "done", isFinal: true }]);
    recognitions[0].onend?.();
    expect(transcriptUpdates).toEqual(["done"]);
  });

  it("stop() delegates to the recognition service (which then fires end)", () => {
    const { controller, recognitions, listeningUpdates } = createHarness();
    controller.start("");
    controller.stop();
    expect(recognitions[0].stopCallCount).toBe(1);
    /*
      The real service fires `end` asynchronously after stop():
    */
    recognitions[0].onend?.();
    expect(listeningUpdates).toEqual([true, false]);
  });

  it("stop() without a session is a no-op", () => {
    const { controller } = createHarness();
    expect(() => controller.stop()).not.toThrow();
  });

  it("maps recognition errors to user-facing copy and stays silent on abort", () => {
    const { controller, recognitions, errorMessages } = createHarness();
    controller.start("");
    recognitions[0].onerror?.({ error: "not-allowed" });
    recognitions[0].onend?.();
    expect(errorMessages).toEqual([
      "Microphone access was denied. Allow it in your browser settings to use voice input.",
    ]);
    expect(controller.getIsListening()).toBe(false);
  });

  it("reports nothing for a user-initiated abort error code", () => {
    const { controller, recognitions, errorMessages } = createHarness();
    controller.start("");
    recognitions[0].onerror?.({ error: "aborted" });
    recognitions[0].onend?.();
    expect(errorMessages).toEqual([]);
  });

  it("abort() detaches handlers, aborts the service, and ends the session synchronously", () => {
    const { controller, recognitions, listeningUpdates, transcriptUpdates } = createHarness();
    controller.start("");
    recognitions[0].emitResults([{ transcript: "half a sentence", isFinal: false }]);
    controller.abort();
    expect(recognitions[0].abortCallCount).toBe(1);
    expect(recognitions[0].onresult).toBeNull();
    expect(recognitions[0].onend).toBeNull();
    expect(controller.getIsListening()).toBe(false);
    expect(listeningUpdates).toEqual([true, false]);
    /*
      No commit after abort — the owner is gone (unmount path).
    */
    expect(transcriptUpdates).toEqual(["half a sentence"]);
  });

  it("supports a fresh session after a previous one ends", () => {
    const { controller, recognitions, transcriptUpdates } = createHarness();
    controller.start("");
    recognitions[0].emitResults([{ transcript: "first", isFinal: true }]);
    recognitions[0].onend?.();
    controller.start("first");
    recognitions[1].emitResults([{ transcript: "second", isFinal: false }]);
    expect(recognitions).toHaveLength(2);
    expect(transcriptUpdates).toEqual(["first", "first second"]);
  });
});

describe("getSpeechErrorMessage", () => {
  it("returns null only for the user-initiated abort", () => {
    expect(getSpeechErrorMessage("aborted")).toBeNull();
  });

  it.each(["not-allowed", "service-not-allowed", "no-speech", "audio-capture", "network"])(
    "returns curated copy for %s",
    (code) => {
      const message = getSpeechErrorMessage(code);
      /*
        Full user-facing sentences — never the bare developer error code.
      */
      expect(message).not.toBe(code);
      expect(message).toMatch(/^[A-Z].*\.$/);
    },
  );

  it("falls back to generic copy for unknown codes", () => {
    expect(getSpeechErrorMessage("language-not-supported")).toBe(
      "Voice input ran into a problem. Try again.",
    );
  });
});
