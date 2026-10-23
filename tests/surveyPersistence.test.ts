import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signup } from './helpers.js';
import { publishReviewed } from './reviewedPublish.js';
import { eq } from 'drizzle-orm';
import { experienceVersions, experienceEvents, experienceImpressions, surveyResponses } from '../src/db/schema.js';

describe('Survey persistence and recovery', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

  async function published(branching = false) {
    const owner = await signup(ctx.app); const headers = { authorization: `Bearer ${owner.accessToken}` };
    const site = (await ctx.app.inject({ method: 'GET', url: `/orgs/${owner.org.id}/sites`, headers })).json().sites[0];
    const endpoint = `/orgs/${owner.org.id}/sites/${site.id}/experiences`;
    const created = await ctx.app.inject({ method: 'POST', url: endpoint, headers, payload: { kind: 'widget', widgetType: 'survey', name: 'Reliable survey', buildUrl: 'https://example.test/task', template: 'blank', useBuildPageAsTarget: false } });
    expect(created.statusCode).toBe(201); const experience = created.json();
    if (branching) {
      const definition = structuredClone(experience.draftVersion.definition);
      definition.survey.steps = [
        { id: 'choice_step', content: { heading: 'Choose', body: '' }, questions: [{id:'choice',type:'single_choice',label:'Path',required:true,options:[{id:'skip',label:'Skip'},{id:'full',label:'Full'}]}], branching:{rules:[{questionId:'choice',operator:'equals',value:'skip',nextStepId:'last_step'}]} },
        { id:'required_step', content:{heading:'Required middle',body:''}, questions:[{id:'middle',type:'short_text',label:'Explain',required:true}] },
        { id:'last_step',content:{heading:'Finish',body:''},questions:[{id:'last',type:'rating',label:'Rate',required:true,min:1,max:5}] }
      ];
      const update=await ctx.app.inject({method:'PATCH',url:`${endpoint}/${experience.id}`,headers,payload:{definition,revision:experience.draftVersion.revision}});expect(update.statusCode).toBe(200);
    }
    const publish = await publishReviewed(ctx.app, { method: 'POST', url: `${endpoint}/${experience.id}/publish`, headers }); expect(publish.statusCode).toBe(200);
    const version = publish.json().publishedVersion;
    const identity = { experienceId: experience.id, versionId: version.id, anonymousId: 'visitor', sessionId: 'same-session' };
    const events = `/public/sites/${site.publicId ?? site.siteId}/experience-events`;
    const responses = `/public/sites/${site.publicId ?? site.siteId}/survey-responses`;
    return { site, identity, events, responses, survey: version.definition.survey };
  }

  it('deduplicates concurrent shown/response creation and recovers saved answers before frequency filtering', async () => {
    const f = await published();
    const shown = await Promise.all(Array.from({ length: 3 }, () => ctx.app.inject({ method: 'POST', url: f.events, payload: { ...f.identity, event: 'shown' } })));
    expect(shown.map(result => result.statusCode).sort()).toEqual([200, 200, 201]);
    expect(new Set(shown.map(result => result.json().impressionId)).size).toBe(1);
    const identity = { ...f.identity, impressionId: shown[0].json().impressionId };
    const created = await Promise.all(Array.from({ length: 3 }, () => ctx.app.inject({ method: 'POST', url: f.responses, payload: identity })));
    expect(created.map(result => result.statusCode).sort()).toEqual([200, 200, 201]);
    expect(new Set(created.map(result => result.json().responseId)).size).toBe(1);
    const answers = { [f.survey.steps[0].questions[0].id]: 4 };
    const responseId = created[0].json().responseId;
    expect((await ctx.app.inject({ method: 'PATCH', url: `${f.responses}/${responseId}`, payload: { ...identity, currentStepId: f.survey.steps[1].id, answers } })).statusCode).toBe(204);
    const recovered = await ctx.app.inject({ method: 'POST', url: f.responses, payload: identity });
    expect(recovered.json()).toMatchObject({ responseId, currentStepId: f.survey.steps[1].id, answers });
    const manifest = await ctx.app.inject({ method: 'GET', url: `/public/sites/${f.site.publicId ?? f.site.siteId}/experiences?url=https%3A%2F%2Fexample.test%2Ftask&anonymousId=visitor&sessionId=same-session` });
    expect(manifest.json().experiences[0].impressionId).toBe(identity.impressionId);
    const stranger = await ctx.app.inject({ method: 'POST', url: f.responses, payload: { ...identity, sessionId: 'other-session' } }); expect(stranger.statusCode).toBe(404);
    expect(await ctx.db.select().from(experienceImpressions)).toHaveLength(1); expect(await ctx.db.select().from(surveyResponses)).toHaveLength(1);
    expect((await ctx.db.select().from(experienceEvents)).filter(event => event.eventType === 'survey_started')).toHaveLength(1);
  });

  it('submits atomically once and rejects later overwrites or abandonment, including stale clients', async () => {
    const f = await published(); const shown = await ctx.app.inject({ method: 'POST', url: f.events, payload: { ...f.identity, event: 'shown' } });
    const identity = { ...f.identity, impressionId: shown.json().impressionId };
    const created = await ctx.app.inject({ method: 'POST', url: f.responses, payload: identity }); const url = `${f.responses}/${created.json().responseId}`;
    const payload = { ...identity, currentStepId: f.survey.steps[1].id, answers: { [f.survey.steps[0].questions[0].id]: 4 }, submitted: true };
    const sent = await Promise.all([ctx.app.inject({ method: 'PATCH', url, payload }), ctx.app.inject({ method: 'PATCH', url, payload })]); expect(sent.map(result => result.statusCode)).toEqual([204, 204]);
    expect((await ctx.app.inject({ method: 'PATCH', url, payload: { ...payload, submitted: false, abandoned: true } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'PATCH', url, payload: { ...payload, answers: { [f.survey.steps[0].questions[0].id]: 2 } } })).statusCode).toBe(409);
    const legacyEvent = { ...identity, event: 'completed', eventType: 'survey_submitted' };
    await Promise.all([ctx.app.inject({ method: 'POST', url: f.events, payload: legacyEvent }), ctx.app.inject({ method: 'POST', url: f.events, payload: legacyEvent })]);
    expect((await ctx.db.select().from(experienceEvents)).filter(event => event.eventType === 'survey_submitted')).toHaveLength(1);
    const [stored] = await ctx.db.select().from(surveyResponses); expect(stored.answers).toEqual(payload.answers); expect(stored.abandonedAt).toBeNull(); expect(stored.submittedAt).toBeInstanceOf(Date);
    expect((await ctx.db.select().from(experienceImpressions))[0].completedAt).toBeInstanceOf(Date);
  });

  it('persists abandonment once and never accepts completion analytics for an unsaved submission', async () => {
    const f = await published(); const shown = await ctx.app.inject({ method: 'POST', url: f.events, payload: { ...f.identity, event: 'shown' } });
    const identity = { ...f.identity, impressionId: shown.json().impressionId };
    const created = await ctx.app.inject({ method: 'POST', url: f.responses, payload: identity });
    expect((await ctx.app.inject({ method: 'POST', url: f.events, payload: { ...identity, event: 'completed', eventType: 'survey_submitted' } })).statusCode).toBe(409);
    const url = `${f.responses}/${created.json().responseId}`, payload = { ...identity, answers: {}, abandoned: true };
    expect((await ctx.app.inject({ method: 'PATCH', url, payload })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'PATCH', url, payload })).statusCode).toBe(204);
    expect((await ctx.db.select().from(experienceEvents)).filter(event => event.eventType === 'survey_abandoned')).toHaveLength(1);
    expect((await ctx.db.select().from(surveyResponses))[0].submittedAt).toBeNull();
  });
  it('validates required questions on the server-derived permitted path and rejects forged skipped steps', async () => {
    const f=await published(true);const shown=await ctx.app.inject({method:'POST',url:f.events,payload:{...f.identity,event:'shown'}});
    const identity={...f.identity,impressionId:shown.json().impressionId};const response=await ctx.app.inject({method:'POST',url:f.responses,payload:identity});const url=`${f.responses}/${response.json().responseId}`;
    const send=(answers:Record<string,unknown>,currentStepId='last_step',submitted=true)=>ctx.app.inject({method:'PATCH',url,payload:{...identity,answers,currentStepId,submitted}});
    expect((await send({choice:'full',last:4})).statusCode).toBe(400);
    expect((await send({choice:'skip',last:4},'required_step',false)).statusCode).toBe(400);
    expect((await send({choice:'skip',middle:'forged',last:4})).statusCode).toBe(400);
    expect((await send({choice:'skip',last:8})).statusCode).toBe(400);
    expect((await send({last:4})).statusCode).toBe(400);
    const forged=await ctx.app.inject({method:'PATCH',url,payload:{...identity,answers:{choice:'full',last:4},currentStepId:'last_step',submitted:true,visitedStepIds:['choice_step','last_step']}});expect(forged.statusCode).toBe(400);
    expect((await send({choice:'skip',last:4})).statusCode).toBe(204);
    const [stored]=await ctx.db.select().from(surveyResponses);expect(stored.answers).toEqual({choice:'skip',last:4});expect(stored.submittedAt).toBeInstanceOf(Date);
  });

  it('does not accept completion state by disguising the lifecycle event type', async()=>{
    const f=await published();const shown=await ctx.app.inject({method:'POST',url:f.events,payload:{...f.identity,event:'shown'}});const identity={...f.identity,impressionId:shown.json().impressionId};
    expect((await ctx.app.inject({method:'POST',url:f.events,payload:{...identity,event:'completed',eventType:'widget_interacted'}})).statusCode).toBe(409);
    expect((await ctx.db.select().from(experienceImpressions))[0].completedAt).toBeNull();
  });

  it('resumes a custom-event Survey without firing that event again and allows a new terminal impression',async()=>{
    const f=await published();const [version]=await ctx.db.select().from(experienceVersions);
    const definition=structuredClone(version.definition) as any;definition.targeting.trigger={type:'custom_event',eventName:'feedback_open'};definition.targeting.frequency={mode:'every_time'};
    await ctx.db.update(experienceVersions).set({definition}).where(eq(experienceVersions.id,version.id));
    const manifest=`/public/sites/${f.site.publicId??f.site.siteId}/experiences?url=https%3A%2F%2Fexample.test%2Ftask&anonymousId=visitor&sessionId=same-session`;
    expect((await ctx.app.inject({method:'GET',url:manifest})).json().experiences).toHaveLength(0);
    const shown=await ctx.app.inject({method:'POST',url:f.events,payload:{...f.identity,event:'shown'}});const identity={...f.identity,impressionId:shown.json().impressionId};
    const response=await ctx.app.inject({method:'POST',url:f.responses,payload:identity});expect((await ctx.app.inject({method:'GET',url:manifest})).json().experiences[0].impressionId).toBe(identity.impressionId);
    expect((await ctx.app.inject({method:'PATCH',url:`${f.responses}/${response.json().responseId}`,payload:{...identity,answers:{},abandoned:true}})).statusCode).toBe(204);
    const next=await ctx.app.inject({method:'POST',url:f.events,payload:{...f.identity,event:'shown'}});expect(next.statusCode).toBe(201);expect(next.json().impressionId).not.toBe(identity.impressionId);
  });

});
