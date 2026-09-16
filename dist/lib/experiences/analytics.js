import { and, eq, gte, lte } from "drizzle-orm";
import { experienceEvents, experienceImpressions, experiences, experienceVersions, surveyResponses } from "../../db/schema.js";
const round = (value) => Math.round(value * 10) / 10;
const rate = (numerator, denominator) => denominator ? round(numerator / denominator * 100) : 0;
const identity = (row) => row.trackedUserId ?? row.anonymousId ?? row.impressionId ?? row.id;
export async function getExperienceAnalytics(db, siteId, experienceId, range) {
    const [experience] = await db.select().from(experiences).where(and(eq(experiences.siteId, siteId), eq(experiences.id, experienceId))).limit(1);
    if (!experience)
        return null;
    const impressions = await db.select().from(experienceImpressions).where(and(eq(experienceImpressions.siteId, siteId), eq(experienceImpressions.experienceId, experienceId), gte(experienceImpressions.shownAt, range.since), lte(experienceImpressions.shownAt, range.until)));
    const events = await db.select().from(experienceEvents).where(and(eq(experienceEvents.siteId, siteId), eq(experienceEvents.experienceId, experienceId), gte(experienceEvents.timestamp, range.since), lte(experienceEvents.timestamp, range.until)));
    const responses = await db.select().from(surveyResponses).where(and(eq(surveyResponses.siteId, siteId), eq(surveyResponses.experienceId, experienceId), gte(surveyResponses.startedAt, range.since), lte(surveyResponses.startedAt, range.until)));
    const usersSeen = new Set(impressions.map(identity)).size;
    const completed = new Set(impressions.filter(row => row.completedAt).map(identity)).size;
    const dismissed = new Set(impressions.filter(row => row.dismissedAt).map(identity)).size;
    const started = experience.widgetType === "survey" ? new Set(responses.map(identity)).size : experience.kind === "guide" ? uniqueEventUsers(events, "guide_step_shown") : new Set(events.filter(row => row.eventType === "widget_interacted").map(identity)).size;
    const submitted = new Set(responses.filter(row => row.submittedAt).map(identity)).size;
    const abandoned = new Set(responses.filter(row => row.abandonedAt).map(identity)).size;
    const stepIds = [...new Set(events.filter(row => row.stepId).sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0)).map(row => row.stepId))];
    const steps = stepIds.map(stepId => {
        const rows = events.filter(row => row.stepId === stepId);
        const shown = rows.filter(row => row.eventType === "guide_step_shown");
        const advanced = rows.filter(row => row.eventType === "guide_step_completed");
        const usersReached = new Set(shown.map(identity)).size;
        const usersAdvanced = new Set(advanced.map(identity)).size;
        const dropOff = Math.max(0, usersReached - usersAdvanced);
        const durations = advanced.map(row => row.durationMs).filter((value) => value !== null);
        return { stepId, stepIndex: rows[0]?.stepIndex ?? 0, usersReached, usersAdvanced, dropOff, dropOffRate: rate(dropOff, usersReached), averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0 };
    }).sort((a, b) => a.stepIndex - b.stepIndex);
    const questionResults = await aggregateQuestions(db, experience.publishedVersionId, responses);
    const trend = [...new Set(impressions.map(row => row.shownAt.toISOString().slice(0, 10)))].sort().map(date => {
        const dailyImpressions = impressions.filter(row => row.shownAt.toISOString().startsWith(date));
        const dailyResponses = responses.filter(row => row.startedAt.toISOString().startsWith(date));
        return { date, usersSeen: new Set(dailyImpressions.map(identity)).size, completed: new Set(dailyImpressions.filter(row => row.completedAt).map(identity)).size, dismissed: new Set(dailyImpressions.filter(row => row.dismissedAt).map(identity)).size, submitted: new Set(dailyResponses.filter(row => row.submittedAt).map(identity)).size };
    });
    return {
        experience: { id: experience.id, name: experience.name, kind: experience.kind, widgetType: experience.widgetType },
        summary: { usersSeen, usersStarted: started, completed, dismissed, completionRate: rate(completed, usersSeen) },
        guide: experience.kind === "guide" ? { steps } : null,
        survey: experience.widgetType === "survey" ? { usersSeen, started, submitted, abandoned, responseRate: rate(submitted, usersSeen), questions: questionResults } : null,
        trend,
    };
}
export async function listExperienceAnalytics(db, siteId, range) {
    const rows = await db.select().from(experiences).where(eq(experiences.siteId, siteId));
    return { experiences: (await Promise.all(rows.map(row => getExperienceAnalytics(db, siteId, row.id, range)))).filter(Boolean) };
}
export async function listSurveyResponses(db, siteId, experienceId, range, limit, offset) {
    const rows = await db.select().from(surveyResponses).where(and(eq(surveyResponses.siteId, siteId), eq(surveyResponses.experienceId, experienceId), gte(surveyResponses.startedAt, range.since), lte(surveyResponses.startedAt, range.until)));
    rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return { total: rows.length, limit, offset, responses: rows.slice(offset, offset + limit).map(row => ({ responseId: row.id, experienceId: row.experienceId, versionId: row.versionId, impressionId: row.impressionId, anonymousId: row.anonymousId, trackedUserId: row.trackedUserId, sessionId: row.sessionId, answers: row.answers, startedAt: row.startedAt.toISOString(), submittedAt: row.submittedAt?.toISOString() ?? null, abandonedAt: row.abandonedAt?.toISOString() ?? null })) };
}
export async function experienceMetric(db, siteId, experienceId, metric, range) {
    const analytics = await getExperienceAnalytics(db, siteId, experienceId, range);
    if (!analytics)
        return null;
    const survey = analytics.survey;
    const summary = analytics.summary;
    const values = { users_seen: summary.usersSeen, completions: summary.completed, completion_rate: summary.completionRate, dismissals: summary.dismissed, responses: survey?.submitted ?? 0, response_rate: survey?.responseRate ?? 0, abandonment_rate: survey ? rate(survey.abandoned, survey.started) : 0, impressions: summary.usersSeen, interactions: summary.usersStarted, interaction_rate: rate(summary.usersStarted, summary.usersSeen) };
    if (metric === "step_reach")
        return { kind: "breakdown", rows: analytics.guide?.steps.map(step => ({ key: step.stepId, label: `Step ${step.stepIndex + 1}`, value: step.usersReached })) ?? [] };
    if (metric === "step_drop_off")
        return { kind: "breakdown", rows: analytics.guide?.steps.map(step => ({ key: step.stepId, label: `Step ${step.stepIndex + 1}`, value: step.dropOff })) ?? [] };
    return { kind: "scalar", values: [{ seriesKey: metric, value: values[metric] ?? 0, recentValue: values[metric] ?? 0, previousValue: null, deltaPercent: null }] };
}
function uniqueEventUsers(events, type) { return new Set(events.filter(row => row.eventType === type).map(identity)).size; }
async function aggregateQuestions(db, versionId, responses) {
    if (!versionId)
        return [];
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, versionId)).limit(1);
    const definition = version?.definition;
    if (!definition || !("survey" in definition) || !definition.survey)
        return [];
    return definition.survey.steps.flatMap(step => step.questions).map(question => {
        const answers = responses.filter(row => row.submittedAt).map(row => row.answers[question.id]).filter(value => value !== undefined);
        if (question.type === "short_text" || question.type === "long_text")
            return { questionId: question.id, label: question.label, type: question.type, responseCount: answers.length, textResponses: answers.filter((value) => typeof value === "string") };
        const counts = new Map();
        for (const answer of answers)
            for (const value of Array.isArray(answer) ? answer : [answer])
                counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
        return { questionId: question.id, label: question.label, type: question.type, responseCount: answers.length, distribution: [...counts].map(([value, count]) => ({ value, count, percent: rate(count, answers.length) })).sort((a, b) => b.count - a.count) };
    });
}
//# sourceMappingURL=analytics.js.map