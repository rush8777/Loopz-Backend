export const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'short_text', 'long_text', 'rating', 'nps'];
/** Small pure projection shared by the two compilers; SurveyRenderer owns behavior. */
export function surveyQuestionMarkup(question, blockId) {
    const label = escape(question.label);
    let controls;
    if (question.type === 'short_text' || question.type === 'long_text') {
        const attrs = `class="movcues-survey-input" data-movcues-question-input aria-label="${label}" placeholder="${escape(question.placeholder ?? '')}" maxlength="${question.maxLength ?? 10000}"${question.required ? ' aria-required="true"' : ''}`;
        controls = question.type === 'short_text' ? `<input type="text" ${attrs}>` : `<textarea ${attrs}></textarea>`;
    }
    else {
        const options = question.type === 'rating' || question.type === 'nps'
            ? Array.from({ length: question.type === 'nps' ? 11 : question.max - question.min + 1 }, (_, index) => { const value = String(index + (question.type === 'nps' ? 0 : question.min)); return { id: value, label: value }; })
            : question.options;
        controls = `<div class="movcues-survey-options">${options.map(option => `<button type="button" class="movcues-survey-option" data-movcues-option-id="${escape(option.id)}" aria-pressed="false">${escape(option.label)}</button>`).join('')}</div>`;
    }
    return `<div class="movcues-block movcues-survey-question" data-movcues-block-id="${escape(blockId)}" data-movcues-question-id="${escape(question.id)}" data-movcues-question-type="${question.type}"><p class="movcues-survey-question__label">${label}${question.required ? ' *' : ''}</p>${controls}</div>`;
}
export function surveyControlsMarkup(blockId, label) {
    return `<div class="movcues-block movcues-survey-footer" data-movcues-block-id="${escape(blockId)}" data-movcues-survey-controls="onsite"><div data-movcues-survey-progress><span>Progress</span><span data-movcues-survey-progress-bar></span></div><p class="movcues-survey-validation" role="alert"></p><div class="movcues-survey-actions"><button type="button" data-movcues-survey-action="back">Back</button><button type="button" data-movcues-survey-action="next">Next</button><button type="button" data-movcues-survey-action="submit">${escape(label)}</button></div></div>`;
}
export const SURVEY_CELL_CSS = '.movcues-widget .movcues-survey-question__label{margin:0 0 8px;font-weight:600}.movcues-widget .movcues-survey-options{display:flex;flex-wrap:wrap;gap:6px}.movcues-widget .movcues-survey-option,.movcues-widget [data-movcues-survey-action]{min-height:36px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:inherit;padding:8px 12px;font:inherit;cursor:pointer}.movcues-widget .movcues-survey-option.is-selected{border-color:var(--movcues-primary);background:color-mix(in srgb,var(--movcues-primary) 12%,white)}.movcues-widget .movcues-survey-input{box-sizing:border-box;width:100%;min-width:0;min-height:36px;border:1px solid #cbd5e1;border-radius:6px;padding:8px;font:inherit}.movcues-widget textarea.movcues-survey-input{min-height:84px;resize:vertical}.movcues-widget .movcues-survey-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.movcues-widget .movcues-survey-footer{width:100%}.movcues-widget [data-movcues-survey-progress]{font-size:12px;margin-bottom:8px}.movcues-widget [data-movcues-survey-progress-bar]{display:block;height:3px;background:var(--movcues-primary);margin-top:5px}.movcues-widget .movcues-survey-validation{color:#b91c1c;font-size:12px}.movcues-widget .movcues-survey-question.has-error{outline:2px solid #dc2626;outline-offset:4px}';
export function surveyQuestionErrors(questions) {
    if (!Array.isArray(questions) || questions.length > 20)
        return ['A Survey step supports at most 20 questions.'];
    const errors = [], ids = new Set();
    for (const question of questions) {
        if (!question || !QUESTION_TYPES.includes(question.type)) {
            errors.push('Unsupported Survey question type.');
            continue;
        }
        if (!question.id || question.id.length > 64 || ids.has(question.id))
            errors.push('Question IDs must be unique and contain 1–64 characters.');
        ids.add(question.id);
        if (!question.label?.trim() || question.label.length > 500)
            errors.push('Question labels must contain 1–500 characters.');
        if (question.required !== undefined && typeof question.required !== 'boolean')
            errors.push('Required must be a boolean.');
        if (question.type === 'single_choice' || question.type === 'multiple_choice') {
            if (!Array.isArray(question.options) || !question.options.length || question.options.length > 20)
                errors.push('Choice questions need 1–20 options.');
            else {
                const optionIds = new Set();
                for (const option of question.options) {
                    if (!option.id || option.id.length > 64 || optionIds.has(option.id) || !option.label?.trim() || option.label.length > 200)
                        errors.push('Options need unique IDs and nonempty labels (up to 200 characters).');
                    optionIds.add(option.id);
                }
            }
        }
        else if (question.type === 'rating' && (!Number.isInteger(question.min) || !Number.isInteger(question.max) || question.min < 0 || question.max > 100 || question.max <= question.min || question.max - question.min > 20))
            errors.push('Rating needs an ascending range of at most 21 values between 0 and 100.');
        else if ((question.type === 'short_text' || question.type === 'long_text') && ((question.maxLength !== undefined && (!Number.isInteger(question.maxLength) || question.maxLength < 1 || question.maxLength > 10000)) || (question.placeholder?.length ?? 0) > 500))
            errors.push('Text limit must be 1–10,000 and placeholder at most 500 characters.');
    }
    return errors;
}
function escape(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
//# sourceMappingURL=surveyMarkup.js.map