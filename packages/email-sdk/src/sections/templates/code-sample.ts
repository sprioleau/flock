import { z } from "zod";
import { CODE_BLOCK_LANGUAGES } from "../../schema/blocks";
import { createSectionComposer, headingNode, paragraphNode, textDocOf } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/*
  `code-sample` — developer-audience section: a short lead-in, a
  syntax-highlighted code block, and a standalone docs link. Reference:
  react.email/components code-block patterns. Uses the code and link leaf
  blocks (the snippet keeps the renderer's default dark scheme — a terminal
  look that reads well under light and dark themes alike).
*/

const DEFAULT_CODE = `import { send } from "@flock/sdk";

await send({
  to: "ada@example.com",
  subject: "Hello from Flock",
});`;

export const codeSampleParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .default("Get started in seconds")
      .describe("The section's heading — rendered as a level-2 heading."),
    body: z
      .string()
      .min(1)
      .default("Install the SDK and send your first email with a few lines of code.")
      .describe("One or two sentences introducing the snippet."),
    code: z
      .string()
      .min(1)
      .default(DEFAULT_CODE)
      .describe("The source code to display, verbatim (newlines preserved). Keep it short — email width."),
    language: z
      .enum(CODE_BLOCK_LANGUAGES)
      .default("typescript")
      .describe("Language for syntax highlighting."),
    docsLabel: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The docs link's visible text, shown under the snippet. Omit, with docsHref, for a snippet with no link under it.",
      ),
    docsHref: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The docs link's destination: an absolute URL. Give a real one or omit it — there is no default, so a section you leave without a destination simply has no docs link.",
      ),
  })
  .describe("Code-sample content: heading, lead-in, the snippet and its language, and a docs link.");

export const codeSampleTemplate = defineSectionTemplate({
  id: "code-sample",
  name: "Code sample",
  category: "content",
  useWhen:
    "Speak to developers with a short lead-in, a syntax-highlighted code snippet, and a docs link underneath.",
  paramsSchema: codeSampleParamsSchema,
  /*
    The snippet is the point, and sample code purporting to be the reader's is worse than none. `language` is a fence attribute, not copy.
  */
  contentRequirements: {
    copyParams: ["headline", "body", "code"],
    listParams: [],
    imageCount: 0,
  },
  /*
    The gallery shows the docs link; a real section only gets one that leads somewhere.
  */
  previewParams: { docsLabel: "Read the docs", docsHref: "https://example.com/docs" },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        headingNode({ level: 2, content: params.headline }),
        paragraphNode(params.body),
      ]),
    });
    composer.addLeaf({ kind: "code", code: params.code, language: params.language });
    /*
      A "Read the docs" link to docs that do not exist is worse than none.
    */
    if (params.docsLabel !== undefined && params.docsHref !== undefined) {
      composer.addLeaf({ kind: "link", text: params.docsLabel, href: params.docsHref });
    }
    return composer.finish();
  },
});
