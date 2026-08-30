import { chargeCreditForRequest } from "@/lib/auth/credits";
import { MOCK_MODEL_HEADER } from "@/lib/chat-contract";
import {
  generateImageRequestBodySchema,
  type GenerateImageErrorResponseBody,
  type GenerateImageResponseBody,
} from "./contract";
import { generateEmailImage } from "./generation";

/*
  POST /api/generate-image — the HUMAN path's generation endpoint (the agent
  path calls the same core module from the /api/chat executor instead).

  Returns `{ base64, mimeType, alt }` for the perceived-latency design: the
  client paints the base64 as a data-URI preview IMMEDIATELY, uploads the
  binary to Convex storage in the background, and only then commits the
  storage URL as the block's src. Base64 never touches Convex.

  Mock selection mirrors /api/chat: the deterministic generator runs when the
  request carries `x-flock-mock: 1`, when FLOCK_MOCK_IMAGE_MODEL=1, or when
  no GOOGLE_GENERATIVE_AI_API_KEY is configured.
*/

function errorResponse(status: number, body: GenerateImageErrorResponseBody): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(400, {
      error: "invalid_request",
      message: "Request body is not valid JSON.",
    });
  }

  const parsedBody = generateImageRequestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return errorResponse(400, {
      error: "invalid_request",
      message: parsedBody.error.issues.map((issue) => issue.message).join("; "),
    });
  }
  const { prompt, aspectRatio } = parsedBody.data;

  const isMockForced = request.headers.get(MOCK_MODEL_HEADER) === "1";
  /*
    Mirrors generateEmailImage's own mock decision: a run that never reaches
    the provider must not cost the user anything.
  */
  const isMockRun =
    isMockForced ||
    process.env.FLOCK_MOCK_IMAGE_MODEL === "1" ||
    !process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  /*
    Image generation is user-initiated inference — it costs a credit.
  */
  const charge = await chargeCreditForRequest({ request, isMockRun });
  if (!charge.isAllowed) {
    return errorResponse(429, { error: "out_of_credits", message: charge.message });
  }

  const outcome = await generateEmailImage({
    prompt,
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    isMockForced,
  });
  if (!outcome.isGenerated) {
    return errorResponse(502, {
      error: "generation_failed",
      message: `The image wasn't generated: ${outcome.message}`,
    });
  }

  const body: GenerateImageResponseBody = {
    base64: outcome.base64,
    mimeType: outcome.mimeType,
    alt: outcome.alt,
  };
  return Response.json(body);
}
