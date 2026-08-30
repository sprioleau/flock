"use client";

import { useMemo } from "react";
import {
  createEmptyDocument,
  getPreviewParams,
  getSectionTemplate,
  ROOT_BLOCK_ID,
  type EmailDocument,
  type GlobalStyles,
} from "@flock/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { ReadOnlyEmailPreview } from "../history/ReadOnlyEmailPreview";

/*
  A rendered miniature of one section-catalog template, styled with the
  ACTIVE draft's theme: the template is instantiated (default demo params)
  into a minimal one-section EmailDocument whose root carries the current
  document's globals, then rendered through the history feature's
  ReadOnlyEmailPreview (the same SDK block views + measured fit-zoom the
  sibling draft frames reuse — visual parity with what scaffoldSection would
  actually insert).

  Performance: previews mount lazily (only while the gallery's preview mode
  is on, or inside an open hover card) and the instantiated document is
  memoized per template + globals reference, so pointer traffic and unrelated
  store updates never rebuild or re-render a miniature.
*/

/*
  Instantiate `templateId` into a minimal preview document under `globals`.
*/
export function buildSectionTemplatePreviewDoc(args: {
  templateId: string;
  globals: GlobalStyles | undefined;
}): EmailDocument | null {
  const template = getSectionTemplate(args.templateId);
  if (template === undefined) {
    return null;
  }
  /*
    The gallery is the one caller that builds from sample values rather than
    from content someone supplied — a thumbnail is never sent, and a hero with
    no button or a footer with no address line would misrepresent the template
    to whoever is browsing for one. `getPreviewParams` fills exactly the params
    the schema deliberately leaves undefaulted, so the miniature still shows
    the button and the address that a real draft only gets when asked for.
  */
  const built = template.build({
    params: template.paramsSchema.parse(getPreviewParams(template)),
  });
  const doc = createEmptyDocument();
  const emptyRoot = doc[ROOT_BLOCK_ID];
  if (emptyRoot === undefined || emptyRoot.type !== "root") {
    return null;
  }
  doc[ROOT_BLOCK_ID] = {
    ...emptyRoot,
    childrenIds: [built.section.id],
    properties: { globals: args.globals ?? {} },
  };
  doc[built.section.id] = built.section;
  for (const child of built.children) {
    doc[child.id] = child;
  }
  return doc;
}

export function SectionTemplatePreview({ templateId }: { templateId: string }) {
  /*
    The globals object is only replaced when the theme/document settings
    change, so this selector (and the memo below) is stable across edits.
  */
  const globals = useEditorStore((state) => {
    const root = state.doc[ROOT_BLOCK_ID];
    return root !== undefined && root.type === "root" ? root.properties.globals : undefined;
  });
  const previewDoc = useMemo(
    () => buildSectionTemplatePreviewDoc({ templateId, globals }),
    [templateId, globals],
  );
  if (previewDoc === null) {
    return null;
  }
  return (
    <div data-testid={`section-template-preview-${templateId}`}>
      <ReadOnlyEmailPreview doc={previewDoc} />
    </div>
  );
}
