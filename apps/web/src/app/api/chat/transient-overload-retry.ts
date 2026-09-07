import { APICallError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

/*
  Google returns some temporary capacity failures with isRetryable unset. The
  AI SDK therefore does not retry them, even when the HTTP status is 503. This
  middleware fills that provider-specific gap without replaying a tool call:
  it retries only the provider request, before a response exists and before
  streamText can execute any tool side effects.
*/

const DEFAULT_TRANSIENT_OVERLOAD_RETRIES = 1;
const DEFAULT_TRANSIENT_OVERLOAD_DELAY_MS = 2_000;

interface TransientOverloadRetryOptions {
  maxRetries?: number;
  delayMs?: number;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function isTransientOverloadError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
    return false;
  }

  const statusCode = error.statusCode;
  const hasTransientStatus =
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504;
  const hasCapacityMessage = /high demand|overload|temporar|capacity|try again later/i.test(
    readErrorMessage(error),
  );

  return hasTransientStatus || hasCapacityMessage;
}

async function waitBeforeRetry(delayMs: number, abortSignal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  if (abortSignal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeoutId = setTimeout(resolve, delayMs);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        resolve();
      },
      { once: true },
    );
  });
}

interface RetryOperationOptions {
  abortSignal: AbortSignal | undefined;
  maxRetries: number;
  delayMs: number;
}

async function runWithTransientOverloadRetry<T>(
  operation: () => PromiseLike<T>,
  options: RetryOperationOptions,
): Promise<T> {
  let retryCount = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (retryCount >= options.maxRetries || !isTransientOverloadError(error)) {
        throw error;
      }
      retryCount += 1;
      await waitBeforeRetry(options.delayMs, options.abortSignal);
    }
  }
}

export function createTransientOverloadRetryMiddleware(
  options: TransientOverloadRetryOptions = {},
): LanguageModelMiddleware {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_TRANSIENT_OVERLOAD_RETRIES));
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_TRANSIENT_OVERLOAD_DELAY_MS);

  return {
    wrapGenerate: async ({ doGenerate, params }) =>
      runWithTransientOverloadRetry(
        doGenerate,
        { abortSignal: params.abortSignal, maxRetries, delayMs },
      ),
    wrapStream: async ({ doStream, params }) =>
      runWithTransientOverloadRetry(
        doStream,
        { abortSignal: params.abortSignal, maxRetries, delayMs },
      ),
  };
}

export function wrapModelWithTransientOverloadRetry(
  model: LanguageModel,
  options?: TransientOverloadRetryOptions,
): LanguageModel {
  if (typeof model === "string") {
    return model;
  }
  return wrapLanguageModel({
    model,
    middleware: createTransientOverloadRetryMiddleware(options),
  });
}
