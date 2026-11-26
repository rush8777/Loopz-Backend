import { applyOnsiteDocument, duplicateDocument, listBlocks, onsiteDocumentFromBuilder, onsiteId, type OnsiteDocument } from "./onsiteDocument.js";
import { isSourceAuthored } from "./sourceMarkup.js";
import type { ExperienceDefinition, GuideStep, GuideStepPattern, SurveyQuestion, WidgetBuilderState, WidgetType } from "./types.js";

export type ExperienceLayout =
  | { kind: "guide"; steps: Array<{ pattern: GuideStepPattern; document: OnsiteDocument }> }
  | { kind: "checklist"; document: OnsiteDocument; items: string[] }
  | { kind: "survey"; steps: Array<{ document: OnsiteDocument; questions: SurveyQuestion[] }> }
  | { kind: "widget"; widgetType: WidgetType; document: OnsiteDocument };

function cleanDocument(builder: WidgetBuilderState | undefined, guide = false): OnsiteDocument {
  const original = onsiteDocumentFromBuilder(builder);
  if (!original || isSourceAuthored(builder)) throw new Error("Only structured on-site designs can be saved as templates.");
  const document = duplicateDocument(original);
  for (const block of listBlocks(document.root)) {
    if (block.type === "heading") block.html = "Add a heading";
    if (block.type === "text") block.html = "Add a short description.";
    if (block.type === "button") {
      block.label = guide ? "Next" : "Continue";
      block.action = { id: block.action.id, type: guide ? "next_step" : "dismiss" };
    }
    if (block.type === "image") { block.src = ""; block.alt = ""; }
    if (block.type === "checklist_text") delete block.text;
  }
  return document;
}

function remapQuestions(document: OnsiteDocument, questions: SurveyQuestion[]): SurveyQuestion[] {
  const ids = new Map<string, string>();
  const result = questions.map((question, index) => {
    const id = onsiteId("question");
    ids.set(question.id, id);
    const base = { id, label: `Question ${index + 1}`, required: false };
    switch (question.type) {
      case "single_choice":
      case "multiple_choice":
        return { ...base, type: question.type, options: question.options.map((_, index) => ({ id: onsiteId("option"), label: `Option ${index + 1}` })) };
      case "rating": return { ...base, type: question.type, min: question.min, max: question.max };
      case "nps": return { ...base, type: question.type };
      case "short_text":
      case "long_text": return { ...base, type: question.type };
    }
  });
  for (const block of listBlocks(document.root)) if (block.type === "question") {
    const id = ids.get(block.questionId);
    if (!id) throw new Error("Unknown template question");
    block.questionId = id;
  }
  return result;
}

function remapItems(document: OnsiteDocument, items: string[]): string[] {
  const ids = new Map(items.map(id => [id, onsiteId("item")]));
  for (const block of listBlocks(document.root)) if (block.type === "checklist_task") {
    const id = ids.get(block.itemId);
    if (!id) throw new Error("Unknown template task");
    block.itemId = id;
  }
  return [...ids.values()];
}

export function captureExperienceLayout(definition: ExperienceDefinition, widgetType: WidgetType | null): ExperienceLayout {
  if ("geoAgent" in definition) throw new Error("Geo Agent layouts are configured separately.");
  if ("steps" in definition) {
    return { kind: "guide", steps: definition.steps.map(step => ({ pattern: step.pattern ?? "anchored_card", document: cleanDocument(step.builder, true) })) };
  }
  if ("items" in definition) {
    const document = cleanDocument(definition.builder);
    return { kind: "checklist", document, items: remapItems(document, definition.items.map(item => item.id)) };
  }
  if (definition.survey) {
    return { kind: "survey", steps: definition.survey.steps.map(step => {
      const document = cleanDocument(step.builder);
      return { document, questions: remapQuestions(document, step.questions) };
    }) };
  }
  if (!widgetType) throw new Error("The experience format is missing.");
  return { kind: "widget", widgetType, document: cleanDocument(definition.builder) };
}

const emptyBuilder = (): WidgetBuilderState => ({ version: 1, projectData: {}, html: "", css: "" });

export function applyExperienceLayout(definition: ExperienceDefinition, layout: ExperienceLayout): void {
  if (layout.kind === "guide" && "steps" in definition) {
    definition.steps = layout.steps.map(({ pattern, document }, index, steps): GuideStep => {
      const builder = emptyBuilder();
      const copy = duplicateDocument(document);
      if (index === steps.length - 1) for (const block of listBlocks(copy.root)) if (block.type === "button") {
        block.label = "Finish";
        block.action = { id: block.action.id, type: "dismiss" };
      }
      const { content } = applyOnsiteDocument(builder, copy, pattern);
      return { id: onsiteId("step"), pattern, content, builder, advance: { type: "button" }, behavior: { dismissible: true } };
    });
  } else if (layout.kind === "checklist" && "items" in definition) {
    const document = duplicateDocument(layout.document);
    definition.items = remapItems(document, layout.items).map((id, index) => ({
      id, title: `Task ${index + 1}`, action: { type: "none" }, completion: { type: "item_clicked" },
    }));
    definition.builder = emptyBuilder();
    applyOnsiteDocument(definition.builder, document, "checklist", undefined, definition);
  } else if (layout.kind === "survey" && "content" in definition && definition.survey) {
    const { submitLabel } = definition.survey;
    definition.survey.steps = layout.steps.map(step => {
      const document = duplicateDocument(step.document);
      const questions = remapQuestions(document, step.questions);
      const builder = emptyBuilder();
      const { content } = applyOnsiteDocument(builder, document, "survey", { questions, submitLabel });
      return { id: onsiteId("step"), content, questions, builder };
    });
    definition.content = { ...definition.survey.steps[0].content };
  } else if (layout.kind === "widget" && "content" in definition) {
    definition.builder = emptyBuilder();
    definition.content = applyOnsiteDocument(definition.builder, duplicateDocument(layout.document), layout.widgetType).content;
  } else {
    throw new Error("This template cannot be used with this experience type.");
  }
}
