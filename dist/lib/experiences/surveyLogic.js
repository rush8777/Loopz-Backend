export function nextSurveyStep(survey, index, answers) {
    const step = survey.steps[index];
    if (!step)
        return null;
    const rule = step.branching?.rules.find(rule => matches(rule, answers[rule.questionId]));
    const destination = rule?.nextStepId ?? step.branching?.defaultNextStepId;
    if (destination === 'submit')
        return null;
    const next = destination ? survey.steps.findIndex(step => step.id === destination) : index + 1;
    return next > index && next < survey.steps.length ? next : null;
}
/** Derived solely from the published definition and answer values, never client visited-step claims. */
export function surveyPath(survey, answers) {
    const path = [];
    let index = survey.steps.length ? 0 : null;
    while (index !== null && path.length < survey.steps.length) {
        path.push(index);
        index = nextSurveyStep(survey, index, answers);
    }
    return path;
}
export function answersOnSurveyPath(survey, answers) {
    const ids = new Set(surveyPath(survey, answers).flatMap(index => survey.steps[index].questions.map(question => question.id)));
    return Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id)));
}
export function surveyBranchErrors(survey) {
    const errors = [];
    survey.steps.forEach((step, index) => {
        if (!step.branching)
            return;
        const forward = (id) => id === undefined || id === 'submit' || survey.steps.findIndex(step => step.id === id) > index;
        if (!forward(step.branching.defaultNextStepId))
            errors.push('Survey navigation must target a later step or Submit.');
        if (!Array.isArray(step.branching.rules) || step.branching.rules.length > 10) {
            errors.push('A Survey step supports at most 10 branch rules.');
            return;
        }
        for (const rule of step.branching.rules) {
            const question = step.questions.find(question => question.id === rule.questionId);
            if (!question || !forward(rule.nextStepId) || !rule.nextStepId) {
                errors.push('A branch must use a question on its own step and a forward destination.');
                continue;
            }
            if (rule.operator === 'answered') {
                if (rule.value !== undefined)
                    errors.push('Answered conditions do not use a comparison value.');
                continue;
            }
            const choice = question.type === 'single_choice' || question.type === 'multiple_choice';
            const numeric = question.type === 'rating' || question.type === 'nps';
            if (rule.operator === 'includes') {
                if (question.type !== 'multiple_choice' || typeof rule.value !== 'string' || !question.options.some(option => option.id === rule.value))
                    errors.push('Includes needs an existing multiple-choice option.');
            }
            else if (rule.operator === 'gte' || rule.operator === 'lte') {
                if (!numeric || typeof rule.value !== 'number' || !Number.isInteger(rule.value) || rule.value < (question.type === 'nps' ? 0 : question.min) || rule.value > (question.type === 'nps' ? 10 : question.max))
                    errors.push('Numeric conditions need a value in the question range.');
            }
            else if (rule.operator === 'equals' || rule.operator === 'not_equals') {
                if (question.type === 'multiple_choice' || (numeric ? typeof rule.value !== 'number' || !Number.isInteger(rule.value) || rule.value < (question.type === 'nps' ? 0 : question.min) || rule.value > (question.type === 'nps' ? 10 : question.max) : typeof rule.value !== 'string') || (choice && !question.options.some(option => option.id === rule.value)))
                    errors.push('Comparison value must match the question type and options.');
            }
            else
                errors.push('Unsupported Survey branch operator.');
        }
    });
    return errors;
}
function matches(rule, answer) {
    if (rule.operator === 'answered')
        return answer !== undefined && answer !== '' && (!Array.isArray(answer) || answer.length > 0);
    if (rule.operator === 'equals')
        return answer === rule.value;
    if (rule.operator === 'not_equals')
        return answer !== undefined && answer !== rule.value;
    if (rule.operator === 'includes')
        return Array.isArray(answer) && typeof rule.value === 'string' && answer.includes(rule.value);
    if (rule.operator === 'gte')
        return typeof answer === 'number' && typeof rule.value === 'number' && answer >= rule.value;
    if (rule.operator === 'lte')
        return typeof answer === 'number' && typeof rule.value === 'number' && answer <= rule.value;
    return false;
}
//# sourceMappingURL=surveyLogic.js.map