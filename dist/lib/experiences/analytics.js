import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { experienceEvents, experienceImpressions, experiences, experienceVersions, surveyResponses, trackedUserAliases, trackedUserProperties } from "../../db/schema.js";
import { hydrateIdentities } from "../identity/hydrate.js";
import { isChecklistDefinition } from "./types.js";
const round = (value) => Math.round(value * 10) / 10;
const rate = (numerator, denominator) => denominator ? round(numerator / denominator * 100) : 0;
const identity = (row) => row.trackedUserId ?? row.anonymousId ?? row.impressionId ?? row.id;
const median = (values) => { if (!values.length)
    return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2); };
export async function getExperienceAnalytics(db, siteId, experienceId, range) {
    const [experience] = await db.select().from(experiences).where(and(eq(experiences.siteId, siteId), eq(experiences.id, experienceId))).limit(1);
    if (!experience)
        return null;
    const [rawImpressions, rawEvents, rawResponses] = await Promise.all([
        db.select().from(experienceImpressions).where(and(eq(experienceImpressions.siteId, siteId), eq(experienceImpressions.experienceId, experienceId), gte(experienceImpressions.shownAt, range.since), lte(experienceImpressions.shownAt, range.until))),
        db.select().from(experienceEvents).where(and(eq(experienceEvents.siteId, siteId), eq(experienceEvents.experienceId, experienceId), gte(experienceEvents.timestamp, range.since), lte(experienceEvents.timestamp, range.until))),
        db.select().from(surveyResponses).where(and(eq(surveyResponses.siteId, siteId), eq(surveyResponses.experienceId, experienceId), gte(surveyResponses.startedAt, range.since), lte(surveyResponses.startedAt, range.until))),
    ]);
    const canonicalIds = await canonicalIdentityMap(db, siteId, [...rawImpressions, ...rawEvents, ...rawResponses]);
    const canonicalize = (row) => row.trackedUserId || !row.anonymousId ? row : { ...row, trackedUserId: canonicalIds.get(row.anonymousId) ?? null };
    const impressions = rawImpressions.map(canonicalize);
    const events = rawEvents.map(canonicalize);
    const responses = rawResponses.map(canonicalize);
    const usersSeen = new Set(impressions.map(identity)).size;
    const completed = experience.kind === "checklist" ? uniqueEventUsers(events, "checklist_completed") : new Set(impressions.filter(row => row.completedAt).map(identity)).size;
    const dismissed = experience.kind === "checklist" ? uniqueEventUsers(events, "checklist_dismissed") : new Set(impressions.filter(row => row.dismissedAt).map(identity)).size;
    const started = experience.kind === "checklist" ? new Set(events.filter(row => row.eventType === "checklist_item_clicked" || row.eventType === "checklist_item_completed").map(identity)).size : experience.widgetType === "survey" ? new Set(responses.map(identity)).size : experience.kind === "guide" ? uniqueEventUsers(events, "guide_step_shown") : new Set(events.filter(row => row.eventType === "widget_interacted").map(identity)).size;
    const submittedRows = responses.filter(row => row.submittedAt);
    const abandonedRows = responses.filter(row => row.abandonedAt);
    const submitted = new Set(submittedRows.map(identity)).size;
    const abandoned = new Set(abandonedRows.map(identity)).size;
    const completionDurations = submittedRows.map(row => row.submittedAt.getTime() - row.startedAt.getTime()).filter(value => value >= 0);
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
    const surveyResults = experience.widgetType === "survey" ? await aggregateSurvey(db, siteId, experience.publishedVersionId, responses) : null;
    const checklist = experience.kind === "checklist" ? await aggregateChecklist(db, experience.publishedVersionId, events, usersSeen) : null;
    const dates = new Set([...impressions.map(row => row.shownAt.toISOString().slice(0, 10)), ...responses.map(row => row.startedAt.toISOString().slice(0, 10))]);
    const trend = [...dates].sort().map(date => {
        const dailyImpressions = impressions.filter(row => row.shownAt.toISOString().startsWith(date));
        const dailyResponses = responses.filter(row => row.startedAt.toISOString().startsWith(date));
        const dailyEvents = events.filter(row => row.timestamp.toISOString().startsWith(date));
        const dailySeen = new Set(dailyImpressions.map(identity)).size;
        const dailySubmitted = dailyResponses.filter(row => row.submittedAt);
        const dailyAbandoned = dailyResponses.filter(row => row.abandonedAt);
        const interacted = experience.widgetType === "survey" ? new Set(dailyResponses.map(identity)).size : experience.kind === "guide" ? uniqueEventUsers(dailyEvents, "guide_step_shown") : experience.kind === "checklist" ? new Set(dailyEvents.filter(row => row.eventType === "checklist_item_clicked" || row.eventType === "checklist_item_completed").map(identity)).size : uniqueEventUsers(dailyEvents, "widget_interacted");
        return { date, usersSeen: dailySeen, interacted, completed: experience.kind === "checklist" ? uniqueEventUsers(dailyEvents, "checklist_completed") : new Set(dailyImpressions.filter(row => row.completedAt).map(identity)).size, dismissed: experience.kind === "checklist" ? uniqueEventUsers(dailyEvents, "checklist_dismissed") : new Set(dailyImpressions.filter(row => row.dismissedAt).map(identity)).size, submitted: new Set(dailySubmitted.map(identity)).size, starts: dailyResponses.length, responses: dailySubmitted.length, abandoned: dailyAbandoned.length, responseRate: rate(new Set(dailySubmitted.map(identity)).size, dailySeen), abandonmentRate: rate(dailyAbandoned.length, dailyResponses.length) };
    });
    return {
        experience: { id: experience.id, name: experience.name, kind: experience.kind, widgetType: experience.widgetType },
        summary: { usersSeen, usersStarted: started, completed, dismissed, completionRate: rate(completed, usersSeen) },
        guide: experience.kind === "guide" ? { steps } : null,
        survey: surveyResults ? { usersSeen, started, submitted, responseCount: submittedRows.length, abandoned, responseRate: rate(submitted, usersSeen), abandonmentRate: rate(abandonedRows.length, responses.length), averageCompletionTimeMs: completionDurations.length ? Math.round(completionDurations.reduce((sum, value) => sum + value, 0) / completionDurations.length) : null, medianCompletionTimeMs: median(completionDurations), ...surveyResults } : null,
        checklist,
        trend,
    };
}
async function aggregateSurvey(db, siteId, currentVersionId, responses) {
    const versionIds = [...new Set(responses.map(row => row.versionId))];
    if (currentVersionId && !versionIds.includes(currentVersionId))
        versionIds.push(currentVersionId);
    const versions = versionIds.length ? await db.select().from(experienceVersions).where(inArray(experienceVersions.id, versionIds)) : [];
    const questionsByVersion = new Map();
    for (const version of versions) {
        const definition = version.definition;
        questionsByVersion.set(version.id, "survey" in definition && definition.survey ? definition.survey.steps.flatMap(step => step.questions) : []);
    }
    const groups = new Map();
    for (const version of versions)
        for (const question of questionsByVersion.get(version.id) ?? []) {
            const key = questionSchemaKey(question);
            const group = groups.get(key) ?? { question, versionIds: [], answers: [] };
            group.versionIds.push(version.id);
            groups.set(key, group);
        }
    for (const row of responses) {
        if (!row.submittedAt)
            continue;
        const answers = row.answers;
        for (const question of questionsByVersion.get(row.versionId) ?? []) {
            const value = answers[question.id];
            if (value === undefined || !validAnswer(question, value))
                continue;
            groups.get(questionSchemaKey(question))?.answers.push(value);
        }
    }
    const questions = [...groups.entries()].map(([schemaKey, group]) => summarizeQuestion(schemaKey, group.question, group.versionIds, group.answers, currentVersionId));
    const commonResponses = questions.flatMap(question => { const distribution = "distribution" in question ? question.distribution : undefined; const top = distribution?.[0]; return top ? [{ schemaKey: question.schemaKey, questionId: question.questionId, label: question.label, value: top.value, displayValue: top.label, count: top.count, percent: top.percent, historical: question.historical }] : []; });
    const investigationGroups = commonResponses.map(item => ({ ...item, observation: `${item.count.toLocaleString()} respondents selected “${item.displayValue}”.` }));
    const latestFeedback = [];
    const recent = responses.filter(row => row.submittedAt).sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime()).slice(0, 100);
    const respondentByKey = new Map((await hydrateRespondents(db, siteId, recent.map(identity))).map(item => [item.identityKey, item]));
    for (const row of recent) {
        for (const question of questionsByVersion.get(row.versionId) ?? []) {
            if (question.type !== "short_text" && question.type !== "long_text")
                continue;
            const text = row.answers[question.id];
            if (typeof text !== "string" || !text.trim())
                continue;
            latestFeedback.push({ responseId: row.id, questionId: question.id, questionLabel: question.label, text: text.trim(), submittedAt: row.submittedAt.toISOString(), respondent: respondentByKey.get(identity(row)) ?? anonymousRespondent(identity(row)) });
            if (latestFeedback.length === 5)
                break;
        }
        if (latestFeedback.length === 5)
            break;
    }
    return { questions, commonResponses, investigationGroups, latestFeedback };
}
function questionSchemaKey(question) { return JSON.stringify(question.type === "single_choice" || question.type === "multiple_choice" ? { id: question.id, type: question.type, label: question.label, options: question.options } : question.type === "rating" ? { id: question.id, type: question.type, label: question.label, min: question.min, max: question.max } : { id: question.id, type: question.type, label: question.label }); }
function validAnswer(question, value) {
    if (question.type === "single_choice")
        return typeof value === "string" && question.options.some(option => option.id === value);
    if (question.type === "multiple_choice")
        return Array.isArray(value) && value.every(item => question.options.some(option => option.id === item));
    if (question.type === "short_text" || question.type === "long_text")
        return typeof value === "string";
    if (question.type === "rating")
        return typeof value === "number" && Number.isInteger(value) && value >= question.min && value <= question.max;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10;
}
function summarizeQuestion(schemaKey, question, versionIds, answers, currentVersionId) {
    const base = { schemaKey, questionId: question.id, label: question.label, type: question.type, question, versionIds, historical: currentVersionId ? !versionIds.includes(currentVersionId) : false, responseCount: answers.length };
    if (question.type === "short_text" || question.type === "long_text")
        return base;
    const counts = new Map();
    for (const answer of answers)
        for (const value of Array.isArray(answer) ? answer : [answer])
            counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
    const optionLabels = new Map(question.type === "single_choice" || question.type === "multiple_choice" ? question.options.map(option => [option.id, option.label]) : []);
    const distribution = [...counts].map(([value, count]) => ({ value, label: optionLabels.get(value) ?? value, count, percent: rate(count, answers.length) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const numeric = answers.filter((value) => typeof value === "number");
    if (question.type === "rating")
        return { ...base, distribution, average: numeric.length ? round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length) : null, median: median(numeric), mode: distribution[0] ? Number(distribution[0].value) : null, min: question.min, max: question.max };
    if (question.type === "nps") {
        const promoters = numeric.filter(value => value >= 9).length;
        const passives = numeric.filter(value => value >= 7 && value <= 8).length;
        const detractors = numeric.filter(value => value <= 6).length;
        return { ...base, distribution, npsScore: numeric.length ? round((promoters - detractors) / numeric.length * 100) : null, nps: { promoters, passives, detractors } };
    }
    return { ...base, distribution, percentagesMayExceed100: question.type === "multiple_choice" };
}
async function aggregateChecklist(db, versionId, events, usersSeen) {
    if (!versionId)
        return { usersShown: usersSeen, usersOpened: 0, usersStarted: 0, usersCompleted: 0, completionRate: 0, usersDismissed: 0, items: [] };
    const [version] = await db.select().from(experienceVersions).where(eq(experienceVersions.id, versionId)).limit(1);
    const definition = version?.definition;
    if (!definition || !isChecklistDefinition(definition))
        return null;
    const opened = uniqueEventUsers(events, "checklist_opened");
    const started = new Set(events.filter(row => row.eventType === "checklist_item_clicked" || row.eventType === "checklist_item_completed").map(identity)).size;
    const completed = uniqueEventUsers(events, "checklist_completed");
    const dismissed = uniqueEventUsers(events, "checklist_dismissed");
    return { usersShown: usersSeen, usersOpened: opened, usersStarted: started, usersCompleted: completed, completionRate: rate(completed, usersSeen), usersDismissed: dismissed, items: definition.items.map((item, index) => { const clicks = new Set(events.filter(row => row.eventType === "checklist_item_clicked" && row.itemId === item.id).map(identity)).size; const completions = new Set(events.filter(row => row.eventType === "checklist_item_completed" && row.itemId === item.id).map(identity)).size; return { itemId: item.id, title: item.title, index, uniqueClicks: clicks, uniqueCompletions: completions, completionRate: rate(completions, usersSeen) }; }) };
}
export async function listExperienceAnalytics(db, siteId, range) {
    const rows = await db.select().from(experiences).where(eq(experiences.siteId, siteId));
    return { experiences: (await Promise.all(rows.map(row => getExperienceAnalytics(db, siteId, row.id, range)))).filter(Boolean) };
}
export async function listSurveyResponses(db, siteId, experienceId, range, limit, offset, filters = {}) {
    const [experience] = await db.select().from(experiences).where(and(eq(experiences.siteId, siteId), eq(experiences.id, experienceId))).limit(1);
    if (!experience || experience.widgetType !== "survey")
        return null;
    const conditions = [eq(surveyResponses.siteId, siteId), eq(surveyResponses.experienceId, experienceId), gte(surveyResponses.startedAt, range.since), lte(surveyResponses.startedAt, range.until)];
    if (filters.status === "submitted")
        conditions.push(isNotNull(surveyResponses.submittedAt));
    if (filters.status === "abandoned")
        conditions.push(isNotNull(surveyResponses.abandonedAt));
    if (filters.status === "started")
        conditions.push(and(isNull(surveyResponses.submittedAt), isNull(surveyResponses.abandonedAt)));
    const claimedAlias = sql `EXISTS (SELECT 1 FROM ${trackedUserAliases} alias WHERE alias.site_id = ${surveyResponses.siteId} AND alias.anonymous_id = ${surveyResponses.anonymousId})`;
    if (filters.identityType === "identified")
        conditions.push(sql `(${surveyResponses.trackedUserId} IS NOT NULL OR ${claimedAlias})`);
    if (filters.identityType === "anonymous")
        conditions.push(sql `(${surveyResponses.trackedUserId} IS NULL AND NOT ${claimedAlias})`);
    if (filters.versionId)
        conditions.push(eq(surveyResponses.versionId, filters.versionId));
    if (filters.questionId) {
        const path = `$.${filters.questionId}`;
        const extracted = sql `json_extract(${surveyResponses.answers}, ${path})`;
        if (filters.answer !== undefined)
            conditions.push(sql `(${extracted} = ${filters.answer} OR EXISTS (SELECT 1 FROM json_each(${surveyResponses.answers}, ${path}) WHERE json_each.value = ${filters.answer}))`);
        if (filters.ratingMin !== undefined)
            conditions.push(sql `CAST(${extracted} AS REAL) >= ${filters.ratingMin}`);
        if (filters.ratingMax !== undefined)
            conditions.push(sql `CAST(${extracted} AS REAL) <= ${filters.ratingMax}`);
        if (filters.npsCategory === "promoter")
            conditions.push(sql `CAST(${extracted} AS INTEGER) BETWEEN 9 AND 10`);
        if (filters.npsCategory === "passive")
            conditions.push(sql `CAST(${extracted} AS INTEGER) BETWEEN 7 AND 8`);
        if (filters.npsCategory === "detractor")
            conditions.push(sql `CAST(${extracted} AS INTEGER) BETWEEN 0 AND 6`);
    }
    const where = and(...conditions);
    const [{ total }] = await db.select({ total: sql `count(*)` }).from(surveyResponses).where(where);
    const rawRows = await db.select().from(surveyResponses).where(where).orderBy(desc(surveyResponses.startedAt)).limit(limit).offset(offset);
    const canonicalIds = await canonicalIdentityMap(db, siteId, rawRows);
    const rows = rawRows.map(row => row.trackedUserId || !row.anonymousId ? row : { ...row, trackedUserId: canonicalIds.get(row.anonymousId) ?? null });
    const versions = rows.length ? await db.select().from(experienceVersions).where(inArray(experienceVersions.id, [...new Set(rows.map(row => row.versionId))])) : [];
    const questionsByVersion = new Map(versions.map(version => { const definition = version.definition; return [version.id, "survey" in definition && definition.survey ? definition.survey.steps.flatMap(step => step.questions) : []]; }));
    const respondents = await hydrateRespondents(db, siteId, rows.map(identity));
    const respondentByKey = new Map(respondents.map(item => [item.identityKey, item]));
    return { total, limit, offset, responses: rows.map(row => ({ responseId: row.id, experienceId: row.experienceId, versionId: row.versionId, impressionId: row.impressionId, anonymousId: row.anonymousId, trackedUserId: row.trackedUserId, sessionId: row.sessionId, answers: row.answers, answerDetails: answerDetails(questionsByVersion.get(row.versionId) ?? [], row.answers), respondent: respondentByKey.get(identity(row)) ?? anonymousRespondent(identity(row)), startedAt: row.startedAt.toISOString(), submittedAt: row.submittedAt?.toISOString() ?? null, abandonedAt: row.abandonedAt?.toISOString() ?? null })) };
}
function answerDetails(questions, answers) { return Object.entries(answers).map(([questionId, value]) => { const question = questions.find(item => item.id === questionId); if (!question || !validAnswer(question, value))
    return { questionId, label: "Unavailable question", type: "legacy", value, displayValue: "Unavailable legacy answer", malformed: true }; const options = question.type === "single_choice" || question.type === "multiple_choice" ? new Map(question.options.map(option => [option.id, option.label])) : null; const displayValue = Array.isArray(value) ? value.map(item => options?.get(item) ?? item).join(", ") : typeof value === "string" ? options?.get(value) ?? value : String(value); return { questionId, label: question.label, type: question.type, value, displayValue, malformed: false }; }); }
async function hydrateRespondents(db, siteId, ids) {
    const unique = [...new Set(ids)];
    const summaries = await hydrateIdentities(db, siteId, unique);
    const trackedIds = summaries.flatMap(item => item.trackedUserId ? [item.trackedUserId] : []);
    const properties = trackedIds.length ? await db.select().from(trackedUserProperties).where(and(eq(trackedUserProperties.siteId, siteId), inArray(trackedUserProperties.trackedUserId, trackedIds))) : [];
    const props = new Map();
    for (const property of properties) {
        const values = props.get(property.trackedUserId) ?? new Map();
        values.set(property.name.toLowerCase(), property.value);
        props.set(property.trackedUserId, values);
    }
    return summaries.map((item, index) => { const values = item.trackedUserId ? props.get(item.trackedUserId) : undefined; const name = values?.get("name") ?? values?.get("full_name"); const email = values?.get("email") ?? null; return { ...item, identityKey: unique[index], displayName: item.identityType === "identified" ? name ?? email ?? item.externalUserId ?? "Identified user" : "Anonymous visitor", email, profilePath: item.trackedUserId ? `/users/${item.trackedUserId}` : item.anonymousId ? `/users/anonymous/${encodeURIComponent(item.anonymousId)}` : null }; });
}
function anonymousRespondent(identityKey) { return { identityKey, identityType: "anonymous", trackedUserId: null, externalUserId: null, anonymousId: identityKey, lastSeenAt: null, displayName: "Anonymous visitor", email: null, profilePath: `/users/anonymous/${encodeURIComponent(identityKey)}` }; }
async function canonicalIdentityMap(db, siteId, rows) {
    const anonymousIds = [...new Set(rows.filter(row => !row.trackedUserId && row.anonymousId).map(row => row.anonymousId))];
    if (!anonymousIds.length)
        return new Map();
    const aliases = await db.select({ anonymousId: trackedUserAliases.anonymousId, trackedUserId: trackedUserAliases.trackedUserId }).from(trackedUserAliases).where(and(eq(trackedUserAliases.siteId, siteId), inArray(trackedUserAliases.anonymousId, anonymousIds)));
    return new Map(aliases.map(alias => [alias.anonymousId, alias.trackedUserId]));
}
export async function experienceMetric(db, siteId, experienceId, metric, range) {
    const analytics = await getExperienceAnalytics(db, siteId, experienceId, range);
    if (!analytics)
        return null;
    const survey = analytics.survey;
    const summary = analytics.summary;
    const values = { users_seen: summary.usersSeen, completions: summary.completed, completion_rate: summary.completionRate, dismissals: summary.dismissed, responses: survey?.responseCount ?? 0, response_rate: survey?.responseRate ?? 0, abandonment_rate: survey?.abandonmentRate ?? 0, impressions: summary.usersSeen, interactions: summary.usersStarted, interaction_rate: rate(summary.usersStarted, summary.usersSeen) };
    if (metric === "step_reach")
        return { kind: "breakdown", rows: analytics.guide?.steps.map(step => ({ key: step.stepId, label: `Step ${step.stepIndex + 1}`, value: step.usersReached })) ?? [] };
    if (metric === "step_drop_off")
        return { kind: "breakdown", rows: analytics.guide?.steps.map(step => ({ key: step.stepId, label: `Step ${step.stepIndex + 1}`, value: step.dropOff })) ?? [] };
    return { kind: "scalar", values: [{ seriesKey: metric, value: values[metric] ?? 0, recentValue: values[metric] ?? 0, previousValue: null, deltaPercent: null }] };
}
function uniqueEventUsers(events, type) { return new Set(events.filter(row => row.eventType === type).map(identity)).size; }
//# sourceMappingURL=analytics.js.map