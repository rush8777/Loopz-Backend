import { describe, expect, it } from "vitest";
import { builderCssIsSafe } from "../src/lib/experiences/builderContentContract";

describe("responsive builder CSS security", () => {
  it("accepts scoped media rules and rejects unscoped selectors inside them", () => {
    expect(builderCssIsSafe("@media(max-width:600px){.movcues-widget .movcues-widget__actions{flex-wrap:wrap}}")).toBe(true);
    expect(builderCssIsSafe("@media(max-width:600px){button{width:100%}}")).toBe(false);
  });
});
