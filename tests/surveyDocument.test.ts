import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/survey-v3.json';
import { applyOnsiteDocument, compileOnsiteDocument, listBlocks, validateCompiledOnsiteBuilder, type OnsiteDocument } from '../src/lib/experiences/onsiteDocument.js';
import { definitionSchemaFor } from '../src/lib/experiences/validation.js';
import type { SurveyQuestion, WidgetBuilderState } from '../src/lib/experiences/types.js';

const fresh = () => structuredClone(fixture) as typeof fixture & { document: OnsiteDocument; questions: SurveyQuestion[] };
describe('authoritative Survey cell compilation', () => {
  it('matches the same six-question contract fixture as the SDK compiler', () => {
    const f = fresh(), compiled = compileOnsiteDocument(f.document, 'survey', f);
    expect(createHash('sha256').update(JSON.stringify(compiled)).digest('hex')).toBe(f.expectedHash);
  });
  it('accepts required text accessibility attributes in the compiled Survey contract', () => {
    const f = fresh(); f.questions.forEach(question => { question.required = true; });
    const builder: WidgetBuilderState = { version: 1, html: '', css: '', projectData: {} };
    const { content } = applyOnsiteDocument(builder, f.document, 'survey', f);
    expect(builder.html).toContain('aria-required="true"');
    const definition = { content, design: { width: 'md', theme: { background: '#fff', foreground: '#111', primary: '#2563eb', borderRadius: 'md' } }, behavior: { dismissible: true }, targeting: { pageRules: [], audience: { type: 'all' }, trigger: { type: 'page_load' }, frequency: { mode: 'once' }, priority: 0 }, survey: { allowBack: true, showProgress: true, submitLabel: f.submitLabel, steps: [{ id: 'step_survey', content, builder, questions: f.questions }] } };
    expect(definitionSchemaFor('widget', 'survey').safeParse(definition).success).toBe(true);
  });
  it.each(['html', 'css', 'content', 'reference', 'duplicate', 'option', 'unsupported'] as const)('rejects inconsistent or invalid %s', field => {
    const f = fresh(), builder: WidgetBuilderState = { version: 1, html: '', css: '', projectData: {} };
    const compiled = applyOnsiteDocument(builder, f.document, 'survey', f); const content = compiled.content;
    if (field === 'html') builder.html = builder.html.replace('Send feedback', 'Submit elsewhere');
    if (field === 'css') builder.css += '.movcues-widget{color:red}';
    if (field === 'content') content.heading = 'Uncompiled heading';
    if (field === 'reference') Object.assign(listBlocks(f.document.root)[0], { questionId: 'orphan' });
    if (field === 'duplicate') Object.assign(listBlocks(f.document.root)[0], { questionId: f.questions[1].id });
    if (field === 'option' && f.questions[0].type === 'single_choice') f.questions[0].options[1].id = f.questions[0].options[0].id;
    if (field === 'unsupported') (f.questions[0] as { type: string }).type = 'script';
    expect(validateCompiledOnsiteBuilder(builder, content, 'survey', false, f).length).toBeGreaterThan(0);
  });
  it('checks complete compiled HTML against canonical questions in the definition schema', () => {
    const f = fresh(), builder: WidgetBuilderState = { version: 1, html: '', css: '', projectData: {} };
    const { content } = applyOnsiteDocument(builder, f.document, 'survey', f);
    const definition = { content, design: { width: 'md', theme: { background: '#fff', foreground: '#111', primary: '#2563eb', borderRadius: 'md' } }, behavior: { dismissible: true }, targeting: { pageRules: [], audience: { type: 'all' }, trigger: { type: 'page_load' }, frequency: { mode: 'once' }, priority: 0 }, survey: { allowBack: true, showProgress: true, submitLabel: f.submitLabel, steps: [{ id: 'step_survey', content, builder, questions: f.questions }] } };
    expect(definitionSchemaFor('widget', 'survey').safeParse(definition).success).toBe(true);
    builder.html = builder.html.replace('data-movcues-survey-action="submit"', 'data-movcues-survey-action="next"');
    expect(definitionSchemaFor('widget', 'survey').safeParse(definition).success).toBe(false);
  });
});
