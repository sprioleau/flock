import type { EmailDocument } from "./document";

/*
  The /demo seed: a marketing email with two DELIBERATE, judgeable problems
  planted in it.

  WHY THIS EXISTS AT ALL. /demo used to open on `createStarterDocument`, which
  is a deliberately clean, QA-passing email — so two honest advisory agents
  correctly had nothing to say about it, and a stranger watched two avatars
  walk around and produce a shrug. An agent demo needs something for the agents
  to find. Planting the problems is not cheating: the personas are shown the
  document as it is and reach their own conclusion; the fixture only guarantees
  there IS a conclusion to reach.

  WHY IT READS AS A REAL SEND. A visitor is judging the product through this
  email. It is a spring-harvest release from a fictional coffee roaster —
  a genre a real brand actually sends — with a logo, a hero, a two-up origin
  section, a closing CTA and a compliant footer (postal address + unsubscribe).
  If it read as a joke, every finding about it would read as a joke too.
  "Acme" is deliberately absent: that placeholder was retired repo-wide.

  THE TWO PLANTS, and the persona each is aimed at (convex/personas.ts holds
  the actual persona definitions these were written against):

  1. TONE — `txt_push`. The letter opens warm and personal ("we set one aside
     for you") and then a single paragraph switches to pressure, guilt and
     ALL-CAPS urgency. That is verbatim the Tone Police's first watch item:
     "a pushy hard-sell line inside a warm friendly note; sudden ALL-CAPS
     urgency". Note the rest of the email is CONSISTENTLY warm — the persona is
     instructed to judge tone against the email's own dominant voice and to
     stay quiet if the whole email is brash, so the plant only works because it
     is the outlier.

  2. STYLING — `btn_scnd` against `btn_prim`. Two CTAs that clearly want to
     match have drifted on three properties at once: background color, corner
     radius and alignment. That is verbatim the Styling Recommender's first
     watch item ("two CTA buttons with different background colors, corner
     radii, or alignment"), and all three drifts are expressible as block
     property edits, so the fix can be one click rather than a conversation.

  DESIGN DISCIPLINE, DELIBERATELY BROKEN HERE. Every other seed in this file's
  neighbourhood sets structural knobs only — no colors — so the document
  restyles cleanly on a theme switch. This one hard-codes button colors and
  radii because THE DIVERGENCE IS THE CONTENT. Do not "clean this up": removing
  the overrides removes the finding.

  Ids are stable across calls and deliberately mnemonic (`txt_push`,
  `btn_scnd`): the findings fixture that pairs with this email
  (apps/web/src/app/api/personas/demo-findings.ts) addresses these blocks by
  id, and a snapshot match against THIS function is what decides whether that
  fixture still applies. The two files are written as a pair and must be
  changed as a pair.

    root
    ├─ sec_head → img_logo
    ├─ sec_hero → txt_lead (h1 + warm opener), img_hero, btn_prim   ← the styling baseline
    ├─ sec_urge → txt_push                                          ← THE TONE PLANT
    ├─ sec_orgn → row_cols → col_left → txt_farm · col_rght → txt_brew
    ├─ sec_shop → div_line, txt_last, btn_scnd                      ← THE STYLING PLANT
    └─ sec_foot → div_foot, txt_foot
*/

/*
  The roaster's green, on the hero CTA. The second button's divergence from
  it is measured against this exact value by the findings fixture.
*/
const BRAND_GREEN = "#1f6f5c";

export function createDemoDocument(): EmailDocument {
  const footerFontSize = { type: "textStyle" as const, attrs: { fontSize: "12px" } };
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_head", "sec_hero", "sec_urge", "sec_orgn", "sec_shop", "sec_foot"],
      properties: { globals: {} },
    },
    sec_head: {
      id: "sec_head",
      type: "section",
      parentId: "root",
      childrenIds: ["img_logo"],
      properties: {},
    },
    img_logo: {
      id: "img_logo",
      type: "image",
      parentId: "sec_head",
      childrenIds: [],
      properties: {
        src: "https://placehold.co/280x80/1f6f5c/f8fafc.png?text=Harborlight",
        /*
          "<Brand> logo" on the FIRST image in reading order is the convention
          deriveDraftContentClues reads the brand name off — same rule as the
          starter document.
        */
        alt: "Harborlight Coffee logo",
        width: 140,
        align: "left",
      },
    },
    sec_hero: {
      id: "sec_hero",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_lead", "img_hero", "btn_prim"],
      properties: {},
    },
    txt_lead: {
      id: "txt_lead",
      type: "text",
      parentId: "sec_hero",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "Your spring lot has landed" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Hi there — the first bags off this year's spring harvest came out of the roaster on Tuesday, and they are everything we hoped for: peach, brown sugar, and a finish that keeps going. We set one aside for you.",
                },
              ],
            },
          ],
        },
      },
    },
    img_hero: {
      id: "img_hero",
      type: "image",
      parentId: "sec_hero",
      childrenIds: [],
      properties: {
        src: "https://placehold.co/1200x600/1f6f5c/f8fafc.png?text=Spring+Harvest",
        alt: "A tray of freshly roasted spring-harvest beans, cooling",
        width: 560,
        align: "center",
      },
    },
    btn_prim: {
      id: "btn_prim",
      type: "button",
      parentId: "sec_hero",
      childrenIds: [],
      properties: {
        label: "Reserve your bag",
        href: "https://harborlightcoffee.example.com/spring",
        backgroundColor: BRAND_GREEN,
        textColor: "#ffffff",
        borderRadius: 6,
        align: "center",
      },
    },
    sec_urge: {
      id: "sec_urge",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_push"],
      properties: {},
    },
    txt_push: {
      id: "txt_push",
      type: "text",
      parentId: "sec_urge",
      childrenIds: [],
      properties: {
        /*
          THE TONE PLANT. Pressure, guilt and shouted urgency, dropped into a
          letter that is otherwise written like a note to a regular.
        */
        text: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Let's be honest — everyone else has already claimed theirs, and you're about to be the one stuck drinking last season's beans. RESERVE NOW. This is your LAST CHANCE, and we won't be sending another reminder.",
                },
              ],
            },
          ],
        },
      },
    },
    sec_orgn: {
      id: "sec_orgn",
      type: "section",
      parentId: "root",
      childrenIds: ["row_cols"],
      properties: {},
    },
    row_cols: {
      id: "row_cols",
      type: "row",
      parentId: "sec_orgn",
      childrenIds: ["col_left", "col_rght"],
      properties: {},
    },
    col_left: {
      id: "col_left",
      type: "column",
      parentId: "row_cols",
      childrenIds: ["txt_farm"],
      properties: { widthPercent: 50 },
    },
    txt_farm: {
      id: "txt_farm",
      type: "text",
      parentId: "col_left",
      childrenIds: [],
      properties: {
        textAlign: "center",
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 3 },
              content: [{ type: "text", text: "Where it grew" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Finca La Ladera, 1,900 metres above Huila. Marisol and her family have picked for us for six seasons, and this is the best cherry they've sent.",
                },
              ],
            },
          ],
        },
      },
    },
    col_rght: {
      id: "col_rght",
      type: "column",
      parentId: "row_cols",
      childrenIds: ["txt_brew"],
      properties: { widthPercent: 50 },
    },
    txt_brew: {
      id: "txt_brew",
      type: "text",
      parentId: "col_rght",
      childrenIds: [],
      properties: {
        textAlign: "center",
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 3 },
              content: [{ type: "text", text: "How we'd brew it" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Twenty grams, three hundred and twenty of water just off the boil, poured in four gentle stages. It forgives a lot, so don't overthink it.",
                },
              ],
            },
          ],
        },
      },
    },
    sec_shop: {
      id: "sec_shop",
      type: "section",
      parentId: "root",
      childrenIds: ["div_line", "txt_last", "btn_scnd"],
      properties: {},
    },
    div_line: {
      id: "div_line",
      type: "divider",
      parentId: "sec_shop",
      childrenIds: [],
      properties: {},
    },
    txt_last: {
      id: "txt_last",
      type: "text",
      parentId: "sec_shop",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "Roasted to order, every Tuesday" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Reserve by Sunday night and your bag goes on the Tuesday roast, in the post the same afternoon.",
                },
              ],
            },
          ],
        },
      },
    },
    btn_scnd: {
      id: "btn_scnd",
      type: "button",
      parentId: "sec_shop",
      childrenIds: [],
      /*
        THE STYLING PLANT. Same kind of ask as `btn_prim`, three properties
        adrift from it: an orange that is nowhere else in the email, a much
        rounder corner, and a different alignment.
      */
      properties: {
        label: "Shop the spring lineup",
        href: "https://harborlightcoffee.example.com/shop",
        backgroundColor: "#c2410c",
        textColor: "#ffffff",
        borderRadius: 24,
        align: "left",
      },
    },
    sec_foot: {
      id: "sec_foot",
      type: "section",
      parentId: "root",
      childrenIds: ["div_foot", "txt_foot"],
      properties: {},
    },
    div_foot: {
      id: "div_foot",
      type: "divider",
      parentId: "sec_foot",
      childrenIds: [],
      properties: {},
    },
    txt_foot: {
      id: "txt_foot",
      type: "text",
      parentId: "sec_foot",
      childrenIds: [],
      properties: {
        textAlign: "center",
        text: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Our story",
                  marks: [
                    {
                      type: "link",
                      attrs: { href: "https://harborlightcoffee.example.com/story" },
                    },
                    footerFontSize,
                  ],
                },
                { type: "text", text: "   ·   ", marks: [footerFontSize] },
                {
                  type: "text",
                  text: "Wholesale",
                  marks: [
                    {
                      type: "link",
                      attrs: { href: "https://harborlightcoffee.example.com/wholesale" },
                    },
                    footerFontSize,
                  ],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Harborlight Coffee Roasters · 44 Pier Road, Rockport, ME 04856",
                  marks: [footerFontSize],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Unsubscribe",
                  marks: [{ type: "link", attrs: { href: "*|UNSUB|*" } }, footerFontSize],
                },
              ],
            },
          ],
        },
      },
    },
  };
}
