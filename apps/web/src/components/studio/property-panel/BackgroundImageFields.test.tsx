import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  BackgroundImageFields,
  BACKGROUND_IMAGE_POSITION_OPTIONS,
  BACKGROUND_IMAGE_REPEAT_OPTIONS,
  BACKGROUND_IMAGE_SIZE_OPTIONS,
} from "./BackgroundImageFields";

interface FieldElementProps {
  label: string;
  value?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  onCommit: (value: string | undefined) => void;
}

function getFieldElements(tree: ReactElement<{ children?: ReactNode }>): Array<ReactElement<FieldElementProps>> {
  return Children.toArray(tree.props.children).flatMap((child) =>
    isValidElement<FieldElementProps>(child) ? [child] : [],
  );
}

describe("BackgroundImageFields", () => {
  it("exposes URL, size, position, and repeat controls with typed option sets", () => {
    const tree = BackgroundImageFields({
      properties: {
        backgroundImageUrl: "https://cdn.example.test/hero.jpg",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      },
      helpFor: (propertyKey) => `help:${propertyKey}`,
      onCommit: vi.fn(),
    }) as ReactElement<{ children?: ReactNode }>;
    const fields = getFieldElements(tree);

    expect(fields).toHaveLength(4);
    expect(fields[0]?.props.label).toBe("Background image URL");
    expect(fields[0]?.props.value).toBe("https://cdn.example.test/hero.jpg");
    expect(fields[1]?.props.options).toEqual(BACKGROUND_IMAGE_SIZE_OPTIONS);
    expect(fields[2]?.props.options).toEqual(BACKGROUND_IMAGE_POSITION_OPTIONS);
    expect(fields[3]?.props.options).toEqual(BACKGROUND_IMAGE_REPEAT_OPTIONS);
  });

  it("commits each edit under its own typed property key, including clearing the URL", () => {
    const onCommit = vi.fn();
    const tree = BackgroundImageFields({
      properties: {},
      helpFor: () => undefined,
      onCommit,
    }) as ReactElement<{ children?: ReactNode }>;
    const fields = getFieldElements(tree);

    fields[0]?.props.onCommit(undefined);
    fields[1]?.props.onCommit("contain");
    fields[2]?.props.onCommit("top");
    fields[3]?.props.onCommit("repeat-x");

    expect(onCommit.mock.calls).toEqual([
      [{ backgroundImageUrl: undefined }],
      [{ backgroundSize: "contain" }],
      [{ backgroundPosition: "top" }],
      [{ backgroundRepeat: "repeat-x" }],
    ]);
  });
});
