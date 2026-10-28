import { describe, expect, it } from "vitest";
import { applyOnsiteDocument, createOnsiteDocument, validateCompiledOnsiteBuilder } from "../src/lib/experiences/onsiteDocument.js";
import { applySourceMarkup, sourceContentProjection, validateSourceMarkup } from "../src/lib/experiences/sourceMarkup.js";
import type { WidgetBuilderState } from "../src/lib/experiences/types.js";

const html = `<section class="movcues-widget movcues-widget--modal" data-movcues-widget-type="modal" data-movcues-document-version="2"><div class="hero"><span>New</span><h2 data-movcues-content="heading">Welcome aboard</h2><p data-movcues-content="body">Build something memorable.</p><button type="button" data-movcues-action-id="start_now">Get started</button></div></section>`;
const css = `.movcues-widget{padding:32px;background:#fff}.movcues-widget .hero{display:grid;gap:16px}@media(max-width:600px){.movcues-widget .hero{padding:16px}}`;

describe("source-authored builder contract", () => {
  it("accepts a complete responsive redesign with resolvable actions", () => {
    expect(validateSourceMarkup({ html, css, actionBindings: { start_now: { type: "dismiss" } } }, { widgetType: "modal", guide: false })).toEqual([]);
  });

  it.each([
    [html.replace("<span>New</span>", "<script>alert(1)</script>"), css],
    [html, `body{color:red}`],
    [html, `@import url('https://evil.example/x.css');${css}`],
    [html.replace('data-movcues-action-id="start_now"', 'onclick="alert(1)"'), css],
  ])("rejects unsafe HTML or CSS", (candidateHtml, candidateCss) => {
    expect(validateSourceMarkup({ html: candidateHtml, css: candidateCss, actionBindings: { start_now: { type: "dismiss" } } }, { widgetType: "modal", guide: false }).length).toBeGreaterThan(0);
  });

  it("keeps the structured recovery document while making source the explicit canonical surface", () => {
    const builder: WidgetBuilderState = { version: 1, projectData: {}, html: "", css: "" };
    const compiled = applyOnsiteDocument(builder, createOnsiteDocument(), "modal");
    const recovery = (builder.projectData.movcues as any).onsiteDocument;
    applySourceMarkup(builder, { html, css, actionBindings: { start_now: { type: "dismiss" } } });
    const content = sourceContentProjection(html, compiled.content);
    expect((builder.projectData.movcues as any)).toMatchObject({ authoringSurface: "source", sourceVersion: 1, onsiteDocument: recovery });
    expect(validateCompiledOnsiteBuilder(builder, content, "modal", false)).toEqual([]);
  });

  it("rejects missing Survey and Checklist protected components", () => {
    expect(validateSourceMarkup({ html: html.replaceAll("modal", "survey"), css, actionBindings: { start_now: { type: "dismiss" } } }, { widgetType: "survey", guide: false, survey: { questions: [{ id: "question_1", type: "single_choice" }] } }).join(" ")).toMatch(/question_1|Survey controls/);
    expect(validateSourceMarkup({ html: html.replaceAll("modal", "checklist"), css, actionBindings: { start_now: { type: "dismiss" } } }, { widgetType: "checklist", guide: false, checklist: { items: [{ id: "item_1" }] } }).join(" ")).toMatch(/Checklist role|item_1/);
  });
});
