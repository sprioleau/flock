import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TOUR_STOP_COUNT, TOUR_STOPS, type TourStop } from "@/lib/tour/tour-stops";
import { TourCard } from "./StudioTour";

/*
  The tour card's SHAPE, checked the way this app checks components: there is no
  DOM here (vitest.config.ts pins `environment: "node"`), so the component is
  called as a plain function and the element tree it returns is walked.

  TourCard is deliberately hook-free so it needs no stubbing at all to do that.
  Everything that genuinely requires a browser — resolving the anchor,
  positioning against it, drawing the arrow — lives in StudioTour above it and
  belongs to the browser pass. What this suite can prove is everything that
  would be a real bug:

  - Skip is on EVERY card, because a tour you cannot leave is a hostage
    situation and this one fires automatically on a first visit;
  - the first card offers no Back, and the last offers Done rather than Next,
    so nobody is invited to walk off either end;
  - "Open it" appears exactly where there is something to open, since that
    button ENDS the tour and a card that ended it while opening nothing would
    leave the user with neither;
  - the preview image slot stays dormant until a stop actually carries one.
*/

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
  };
  visit(node);
  return found;
}

function findByTestId(node: ReactNode, testId: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["data-testid"] === testId);
}

function visibleText(node: ReactNode): string {
  const parts: string[] = [];
  const visit = (current: ReactNode): void => {
    if (typeof current === "string" || typeof current === "number") {
      parts.push(String(current));
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    visit((current as ElementWithProps).props.children as ReactNode);
  };
  visit(node);
  return parts.join(" ");
}

const handlers = {
  onBack: vi.fn(),
  onNext: vi.fn(),
  onSkip: vi.fn(),
  onOpenSurface: vi.fn(),
};

function renderCard(stop: TourStop): ReactNode {
  return TourCard({ stop, ...handlers });
}

const firstStop = TOUR_STOPS[0];
const lastStop = TOUR_STOPS[TOUR_STOPS.length - 1];
const stopWithSurface = TOUR_STOPS.find((stop) => stop.surface !== undefined)!;
const stopWithoutSurface = TOUR_STOPS.find((stop) => stop.surface === undefined)!;

describe("what every card says", () => {
  it("shows the stop's own title and body — no copy duplicated into the card", () => {
    for (const stop of TOUR_STOPS) {
      const text = visibleText(renderCard(stop));
      expect(text).toContain(stop.title);
      expect(text).toContain(stop.body);
    }
  });

  it("names a data-testid to nobody", () => {
    /*
      The anchors are internal addresses. A card that leaked one would be
      telling a first-time visitor to go and find "brand-kit-open-button".
    */
    for (const stop of TOUR_STOPS) {
      expect(visibleText(renderCard(stop))).not.toContain(stop.anchorTestId);
    }
  });

  it("counts the stop out of the real total", () => {
    const progress = findByTestId(renderCard(TOUR_STOPS[1]), "studio-tour-progress");
    /*
      visibleText joins each text child with a space; collapse before comparing.
    */
    expect(visibleText(progress).replace(/\s+/g, " ")).toBe(`2 of ${TOUR_STOP_COUNT}`);
  });

  it("offers Skip on every single one", () => {
    /*
      The tour starts on its own, so the way out has to be on the card the user
      did not ask for — and on every card after it, not just the first.
    */
    for (const stop of TOUR_STOPS) {
      expect(findByTestId(renderCard(stop), "studio-tour-skip")).toBeDefined();
    }
  });
});

describe("the ends of the tour", () => {
  it("offers no Back on the first card", () => {
    expect(findByTestId(renderCard(firstStop), "studio-tour-back")).toBeUndefined();
    expect(findByTestId(renderCard(TOUR_STOPS[1]), "studio-tour-back")).toBeDefined();
  });

  it("says Done on the last card and Next before it", () => {
    expect(visibleText(findByTestId(renderCard(lastStop), "studio-tour-next"))).toBe("Done");
    expect(visibleText(findByTestId(renderCard(firstStop), "studio-tour-next"))).toBe("Next");
  });
});

describe("the 'Open it' exit", () => {
  it("is there for a stop with a surface behind the trigger", () => {
    expect(findByTestId(renderCard(stopWithSurface), "studio-tour-open")).toBeDefined();
  });

  it("is absent where there is no named surface to open", () => {
    /*
      The button finishes the tour. On a stop with nothing to open that would
      end the walkthrough and show the user nothing in its place.
    */
    expect(findByTestId(renderCard(stopWithoutSurface), "studio-tour-open")).toBeUndefined();
  });
});

describe("the buttons", () => {
  it("routes each one to its own handler", () => {
    const tree = renderCard(stopWithSurface);
    for (const [testId, handlerName] of [
      ["studio-tour-skip", "onSkip"],
      ["studio-tour-next", "onNext"],
      ["studio-tour-open", "onOpenSurface"],
    ] as const) {
      handlers[handlerName].mockClear();
      const button = findByTestId(tree, testId);
      (button!.props.onClick as () => void)();
      expect(handlers[handlerName]).toHaveBeenCalledTimes(1);
    }
  });
});

describe("the preview slot", () => {
  it("renders nothing while no stop carries an image", () => {
    /*
      The images are deferred (they need somewhere to live that this workstream
      does not own yet), so every stop ships without one and the cards are
      arrow-and-copy. This is the guard that the empty case is a clean absence
      rather than a broken <img>.
    */
    for (const stop of TOUR_STOPS) {
      expect(findByTestId(renderCard(stop), "studio-tour-preview")).toBeUndefined();
    }
  });

  it("renders one, with its alt text, the moment a stop declares it", () => {
    /*
      The contract the images will slot into. Alt text is required rather than
      optional because a preview is the card's answer to "what is behind this
      icon", and a screen-reader user is owed that answer in words.
    */
    const previewed: TourStop = {
      ...firstStop,
      preview: { src: "https://example.convex.cloud/brand-kit.png", alt: "The brand kit panel" },
    };
    const image = findByTestId(renderCard(previewed), "studio-tour-preview");
    expect(image?.type).toBe("img");
    expect(image?.props.alt).toBe("The brand kit panel");
    expect(image?.props.src).toBe("https://example.convex.cloud/brand-kit.png");
  });
});
