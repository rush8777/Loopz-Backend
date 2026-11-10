import {afterEach, expect, it} from 'vitest';
import {eq} from 'drizzle-orm';
import {experienceImpressions} from '../src/db/schema.js';
import {segmentDeliveryFixture} from './segmentDeliveryFixture.js';
let f:Awaited<ReturnType<typeof segmentDeliveryFixture>>;
afterEach(async()=>{if(f){await f.app.close();f.cleanup();}});
it('uses one canonical alias for widgets and checklists, while explicit unknown or different IDs fail closed',async()=>{
 f=await segmentDeliveryFixture();await f.widget();await f.widget(undefined,'checklist','checklist');await f.identify('a','pro');await f.identify('b','free',{plan:'free'});
 const restored=await f.manifest('a');expect(restored.experiences).toHaveLength(1);expect(restored.checklists).toHaveLength(1);
 for(const user of ['unknown','free']){const m=await f.manifest('a',user);expect(m.experiences).toHaveLength(0);expect(m.checklists).toHaveLength(0);}
 const loggedOut=await f.manifest('fresh-after-reset');expect(loggedOut.experiences).toHaveLength(0);expect(loggedOut.checklists).toHaveLength(0);
 expect((await f.members()).members.map((m:any)=>m.externalUserId)).toEqual(['pro']);
});
it('attributes an alias-only shown impression canonically and enforces once across browsers',async()=>{
 f=await segmentDeliveryFixture();await f.widget(undefined,'modal','widget',{frequency:{mode:'once'}});await f.identify('a','pro');const membership=await f.members();const e=(await f.manifest('a')).experiences[0];
 await f.request('POST',`/public/sites/${f.site.siteId}/experience-events`,{experienceId:e.id,versionId:e.versionId,event:'shown',anonymousId:'a',sessionId:'audit-session',timestamp:Date.now()});
 const [impression]=await f.db.select().from(experienceImpressions).where(eq(experienceImpressions.experienceId,e.id));expect(impression.trackedUserId).toBe(membership.members[0].trackedUserId);
 expect((await f.manifest('other-browser','pro')).experiences).toHaveLength(0);
});
it('never restores an alias from another site',async()=>{
 f=await segmentDeliveryFixture();await f.identify('same-anon','pro');const other=await f.request('POST',`/orgs/${f.owner.org.id}/sites`,{name:'Isolated',domain:'http://other.test'});
 const {resolveDeliveryUserId}=await import('../src/lib/identity/deliveryIdentity.js');expect(await resolveDeliveryUserId(f.db,other.id,undefined,'same-anon')).toBeNull();expect(await resolveDeliveryUserId(f.db,other.id,'pro','same-anon')).toBeNull();
});
it.each(['cooldown','maxImpressions'])('keeps %s authoritative after alias restoration',async(mode)=>{
 f=await segmentDeliveryFixture();await f.widget(undefined,'modal','widget',{frequency:mode==='cooldown'?{mode:'every_time',cooldownHours:1}:{mode:'every_time',maxImpressions:1}});await f.identify('a','pro');const e=(await f.manifest('a')).experiences[0];await f.request('POST',`/public/sites/${f.site.siteId}/experience-events`,{experienceId:e.id,versionId:e.versionId,event:'shown',anonymousId:'a',sessionId:'audit-session',timestamp:Date.now()});expect((await f.manifest('a')).experiences).toHaveLength(0);
 if(mode==='cooldown'){await f.db.update(experienceImpressions).set({shownAt:new Date(Date.now()-2*3600000)}).where(eq(experienceImpressions.experienceId,e.id));expect((await f.manifest('a')).experiences).toHaveLength(1);}
});
it('preserves an anonymous survey response on first identification, without handing it to a different account',async()=>{
 f=await segmentDeliveryFixture();await f.widget({type:'all'},'survey');const e=(await f.manifest('a')).experiences[0];const shown=await f.request('POST',`/public/sites/${f.site.siteId}/experience-events`,{experienceId:e.id,versionId:e.versionId,event:'shown',anonymousId:'a',sessionId:'audit-session',timestamp:Date.now()});const identity={experienceId:e.id,versionId:e.versionId,impressionId:shown.impressionId,anonymousId:'a',sessionId:'audit-session'};
 const response=await f.request('POST',`/public/sites/${f.site.siteId}/survey-responses`,identity);await f.identify('a','pro');
 const update=(user:string)=>f.app.inject({method:'PATCH',url:`/public/sites/${f.site.siteId}/survey-responses/${response.responseId}`,payload:{...identity,trackedUserId:user,answers:{},currentStepId:response.currentStepId}});
 const continued=await update('pro');expect(continued.statusCode,continued.body).toBe(204);
 await f.identify('a','other',{plan:'free'});const denied=await update('other');expect(denied.statusCode).toBe(404);
 const {surveyResponses}=await import('../src/db/schema.js');const [row]=await f.db.select().from(surveyResponses).where(eq(surveyResponses.id,response.responseId));const member=(await f.members()).members.find((m:any)=>m.externalUserId==='pro');expect(row.trackedUserId).toBe(member.trackedUserId);
});
