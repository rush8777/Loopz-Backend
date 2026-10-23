import { describe, expect, it } from 'vitest';
import { guideDefinitionSchema, guidePublishIssues } from '../src/lib/experiences/validation.js';
const target = { primarySelector: '#feature', fallbackSelectors: [], reliability: 'reliable' as const };
const step = { id: 'one', pattern: 'anchored_card' as const, content: { heading: 'Feature', body: 'Use this feature' }, behavior: { dismissible: true }, target };
const definition = (steps: unknown[]) => ({ steps, design: { width: 'md', theme: { background: '#fff', foreground: '#111', primary: '#2563eb', borderRadius: 'md' } }, targeting: { pageRules: [], audience: { type: 'all' }, trigger: { type: 'page_load' }, frequency: { mode: 'once' }, priority: 0 } });
describe('Guide logic contracts', () => {
  it('preserves optional fields and keeps legacy trigger targets compatible', () => {
    const guide = guideDefinitionSchema.parse(definition([{ ...step, advance: { type: 'element_click' } }])); expect(guide.steps[0].advance).toEqual({ type: 'element_click' }); expect(guidePublishIssues(guide)).toEqual([]);
    const configured = { ...step, advance: { type: 'element_hover', durationMs: 700, target: { ...target, primarySelector: '#unrelated-action' } }, presentation: { delayMs: 300, missingTarget: { action: 'dismiss', timeoutMs: 2500 } } };
    expect(guideDefinitionSchema.parse(definition([configured])).steps[0]).toEqual(configured);
  });
  it.each([
    { advance: { type: 'element_hover', durationMs: 99 } }, { advance: { type: 'element_hover', durationMs: 60001 } },
    { advance: { type: 'custom_event', eventName: ' ' } }, { advance: { type: 'custom_event', eventName: 'bad\nevent' } },
    { advance: { type: 'route', pageRules: [] } }, { advance: { type: 'route', pageRules: [{ id: 'rule', kind: 'include', operator: 'equals', value: ' ' }] } },
    { presentation: { delayMs: -1 } }, { presentation: { delayMs: 30001 } },
    { presentation: { missingTarget: { action: 'skip', timeoutMs: 60001 } } }, { presentation: { missingTarget: { action: 'skip', timeoutMs: 0 } } },
    { pattern: 'modal', advance: { type: 'element_click', target } }, { pattern: 'modal', presentation: { missingTarget: { action: 'wait', timeoutMs: 500 } } },
  ])('rejects malformed or unsupported step configuration %j', invalid => {
    const result = guideDefinitionSchema.safeParse(definition([{ ...step, ...invalid }])); expect(result.success).toBe(false); if (!result.success) expect(result.error.issues[0].path).toContain('steps');
  });
  it('rejects empty/duplicate steps and identifies a final-step skip before publishing', () => {
    expect(guideDefinitionSchema.safeParse(definition([])).success).toBe(false); expect(guideDefinitionSchema.safeParse(definition([step, step])).success).toBe(false);
    const guide = guideDefinitionSchema.parse(definition([{ ...step, presentation: { missingTarget: { action: 'skip', timeoutMs: 500 } } }]));
    expect(guidePublishIssues(guide)[0]).toMatchObject({ path: ['steps', 0, 'presentation', 'missingTarget'], message: expect.stringContaining('Step 1') });
  });
});
