import { describe, expect, it } from "vitest";
import { builderHtmlIsSafe, builderLinkUrlIsSafe } from "../src/lib/experiences/builderContentContract.js";

describe("builder rich-text contract", () => {
  it("accepts the focused formatting vocabulary and safe links", () => {
    expect(
      builderHtmlIsSafe(
        '<section class="movcues-widget"><p><strong>Bold</strong> <em>italic</em> <u>underlined</u></p><ol><li><a href="/docs" target="_self">Docs</a></li><li><a href="https://example.com" target="_blank" rel="noopener noreferrer">External</a></li></ol></section>',
      ),
    ).toBe(true);
    expect(builderLinkUrlIsSafe("#details")).toBe(true);
    expect(builderLinkUrlIsSafe("mailto:help@example.com")).toBe(true);
    expect(builderLinkUrlIsSafe("../guide")).toBe(true);
  });

  it("rejects executable or unsupported link markup", () => {
    expect(builderHtmlIsSafe('<section class="movcues-widget"><a href="javascript:alert(1)">Bad</a></section>')).toBe(false);
    expect(builderHtmlIsSafe('<section class="movcues-widget"><a href="/docs" onclick="alert(1)">Bad</a></section>')).toBe(false);
    expect(builderHtmlIsSafe('<section class="movcues-widget"><a href="/docs" target="popup">Bad</a></section>')).toBe(false);
  });
  it("parses entity-encoded URLs and rejects malformed or nested interactive markup", () => {
    for (const html of [
      '<a href="jav&#x61;script:alert(1)">Bad</a>',
      '<img src="https&#x3a;\n//example.com/x">',
      '<button><ul><li>Bad</li></ul></button>',
      '<a href="/one"><a href="/two">Nested</a></a>',
      '<p><div>Malformed</div></p>',
      '<img src="/safe" src="javascript:alert(1)">',
      '<a href="/safe" target="_blank">Missing rel</a>',
      '<span contenteditable="true">Editor attribute</span>',
    ]) expect(builderHtmlIsSafe(html), html).toBe(false);
  });

});
