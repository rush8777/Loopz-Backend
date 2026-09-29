import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signup } from "./helpers.js";
import { surveyResponses } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

describe("experience analytics", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); (ctx.db as unknown as { $client: { close(): void } }).$client.close(); ctx.cleanup(); });

  it("deduplicates Guide step reach and returns backend-computed funnel aggregates", async () => {
    const owner = await signup(ctx.app, { email: "experience-analytics@example.com" }); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: authorization, payload: { name: "Analytics", domain: "analytics.example.com" } })).json();
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "guide", name: "Onboarding", buildUrl: "https://analytics.example.com", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.steps[0].pattern = "modal"; definition.steps[0].advance = { type: "button" };
    await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } });
    const published = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization })).json(); const versionId = published.publishedVersion.id;
    const base = { experienceId: created.id, versionId, anonymousId: "anon_1", sessionId: "session_1", pageViewId: "page_1", timestamp: Date.now() };
    const shown = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, event: "shown", eventType: "experience_shown" } }); expect(shown.statusCode).toBe(201); const impressionId = shown.json().impressionId;
    for (let index = 0; index < 2; index++) { const response = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, impressionId, event: "interaction", eventType: "guide_step_shown", stepId: definition.steps[0].id, stepIndex: 0 } }); expect(response.statusCode, response.body).toBe(204); }
    expect((await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, impressionId, event: "interaction", eventType: "guide_step_completed", stepId: definition.steps[0].id, stepIndex: 0, durationMs: 1250 } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { ...base, impressionId, event: "completed", eventType: "guide_completed", stepId: definition.steps[0].id, stepIndex: 0 } })).statusCode).toBe(204);
    const analytics = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/analytics`, headers: authorization });
    expect(analytics.statusCode).toBe(200); expect(analytics.json().summary).toMatchObject({ usersSeen: 1, usersStarted: 1, completed: 1, completionRate: 100 }); expect(analytics.json().guide.steps[0]).toMatchObject({ usersReached: 1, usersAdvanced: 1, dropOff: 0, averageDurationMs: 1250 });
  });

  it("returns version-aware survey summaries, paginated response details, and dynamic response segments", async () => {
    const owner = await signup(ctx.app, { email: "survey-results@example.com" }); const authorization = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites`, headers: authorization, payload: { name: "Survey Results", domain: "survey-results.example.com" } })).json();
    const created = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences`, headers: authorization, payload: { kind: "widget", widgetType: "survey", name: "Onboarding feedback", buildUrl: "https://survey-results.example.com/task", template: "blank", useBuildPageAsTarget: false } })).json();
    const definition = created.draftVersion.definition; definition.survey.steps[0].builder.html = definition.survey.steps[0].builder.html.replace('class="movecues-survey-footer"', 'class="movecues-survey-footer" data-movecues-survey-controls="builder"');
    expect((await ctx.app.inject({ method: "PATCH", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}`, headers: authorization, payload: { definition } })).statusCode).toBe(200);
    const published = (await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/publish`, headers: authorization })).json();
    const versionId = published.publishedVersion.id; const rating = definition.survey.steps[0].questions[0]; const text = definition.survey.steps[0].questions[1];
    const shown = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/experience-events`, payload: { experienceId: created.id, versionId, anonymousId: "survey_result_anon", sessionId: "survey_result_session", event: "shown" } });
    const identity = { experienceId: created.id, versionId, impressionId: shown.json().impressionId, anonymousId: "survey_result_anon", sessionId: "survey_result_session" };
    const started = await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/survey-responses`, payload: identity });
    expect((await ctx.app.inject({ method: "PATCH", url: `/public/sites/${site.siteId}/survey-responses/${started.json().responseId}`, payload: { ...identity, currentStepId: definition.survey.steps[1].id, answers: { [rating.id]: 4, [text.id]: "Inviting teammates was confusing" }, submitted: true } })).statusCode).toBe(204);
    const [stored] = await ctx.db.select().from(surveyResponses).where(eq(surveyResponses.id, started.json().responseId)); await ctx.db.update(surveyResponses).set({ startedAt: new Date(stored.submittedAt!.getTime() - 42_000) }).where(eq(surveyResponses.id, stored.id));

    const analytics = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/analytics`, headers: authorization });
    expect(analytics.statusCode).toBe(200); expect(analytics.json().survey).toMatchObject({ responseCount: 1, submitted: 1, responseRate: 100, abandonmentRate: 0, averageCompletionTimeMs: 42000, medianCompletionTimeMs: 42000 });
    expect(analytics.json().survey.questions.find((question: { questionId: string }) => question.questionId === rating.id)).toMatchObject({ label: rating.label, average: 4, median: 4, mode: 4, historical: false });
    expect(analytics.json().survey.latestFeedback).toHaveLength(1); expect(analytics.json().survey.latestFeedback[0]).toMatchObject({ text: "Inviting teammates was confusing", respondent: { displayName: "Anonymous visitor" } });

    const responses = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/responses?status=submitted&identityType=anonymous&questionId=${rating.id}&ratingMin=4&limit=1`, headers: authorization });
    expect(responses.statusCode).toBe(200); expect(responses.json()).toMatchObject({ total: 1, limit: 1, offset: 0 }); expect(responses.json().responses[0].answerDetails).toEqual(expect.arrayContaining([expect.objectContaining({ questionId: rating.id, label: rating.label, displayValue: "4" })]));

    expect((await ctx.app.inject({ method: "POST", url: `/public/sites/${site.siteId}/events`, payload: { sessionId: "survey_result_session", events: [{ type: "identify", timestamp: Date.now(), anonymousId: "survey_result_anon", externalUserId: "respondent_1", traits: { name: "Ada Respondent", email: "ada@example.com" } }] } })).statusCode).toBe(200);
    const identified = await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/responses?identityType=identified`, headers: authorization });
    expect(identified.json()).toMatchObject({ total: 1, responses: [expect.objectContaining({ respondent: expect.objectContaining({ identityType: "identified", displayName: "Ada Respondent" }) })] });
    expect((await ctx.app.inject({ method: "GET", url: `/orgs/${owner.org.id}/sites/${site.id}/experiences/${created.id}/responses?identityType=anonymous`, headers: authorization })).json().total).toBe(0);

    const snapshot = { id: rating.id, label: rating.label, type: rating.type, min: rating.min, max: rating.max };
    const invalidSegment = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/segments`, headers: authorization, payload: { name: "Invalid rating", definition: { logic: "and", conditions: [{ type: "survey_response", experienceId: created.id, question: snapshot, matcher: { type: "rating_range", min: 4, max: 99 }, dateRange: { type: "relative", days: 30 } }] } } });
    expect(invalidSegment.statusCode).toBe(400); expect(invalidSegment.json().error).toBe("invalid_survey_condition");
    const segment = await ctx.app.inject({ method: "POST", url: `/orgs/${owner.org.id}/sites/${site.id}/segments`, headers: authorization, payload: { name: "Rated onboarding four", definition: { logic: "and", conditions: [{ type: "survey_response", experienceId: created.id, question: snapshot, matcher: { type: "rating_range", min: 4, max: 4 }, dateRange: { type: "relative", days: 30 } }] } } });
    expect(segment.statusCode, segment.body).toBe(201); expect(segment.json().audienceCount).toBe(1);
  });
});
