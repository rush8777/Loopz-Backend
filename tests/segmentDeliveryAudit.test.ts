import { afterEach, describe, expect, it } from 'vitest';
import { segmentDeliveryFixture } from './segmentDeliveryFixture.js';
let f:Awaited<ReturnType<typeof segmentDeliveryFixture>>;
afterEach(async()=>{if(f){await f.app.close();f.cleanup();}});
describe('segment delivery audit: membership API versus delivery API',()=>{
 it('delivers pro segment members after ingestion and excludes non-members',async()=>{
  f=await segmentDeliveryFixture(); const e=await f.widget();
  expect((await f.manifest('a')).experiences).toHaveLength(0);
  await f.identify('a','test-user-1'); const membership=await f.members();expect(membership.total).toBe(1);expect(membership.members[0].externalUserId).toBe('test-user-1');
  expect((await f.manifest('a',membership.members[0].trackedUserId)).experiences).toHaveLength(0);
  expect((await f.manifest('a','test-user-1')).experiences.map((x:any)=>x.id)).toContain(e.id);
  expect((await f.manifest('other','non-member')).experiences).toHaveLength(0);
  const read=await f.request('GET',f.root+'/experiences/'+e.id);
  expect(read.publishedVersion.definition.targeting.audience).toEqual({type:'segment',segmentId:f.pro.id});
 });
 it('resolves a returning member from its anonymous alias without re-identify',async()=>{
  f=await segmentDeliveryFixture();const e=await f.widget();await f.identify('a','user');
  expect((await f.members()).total).toBe(1);
  expect((await f.manifest('a',undefined,{sessionId:'new-session'})).experiences.map((x:any)=>x.id)).toContain(e.id);
 });
 it('supports property updates, multiple browsers, all/any and not_matches',async()=>{
  f=await segmentDeliveryFixture();const other=await f.segment({logic:'or',conditions:[{type:'user_property',propertyName:'role',operator:'equals',value:'admin'},{logic:'and',conditions:[{type:'user_property',propertyName:'plan',operator:'equals',value:'pro'}]}]});
  const all=await f.widget({type:'segment_rules',logic:'all',conditions:[{id:'one',segmentId:f.pro.id,operator:'matches'},{id:'two',segmentId:other.id,operator:'matches'}]});
  const negative=await f.widget({type:'segment_rules',logic:'any',conditions:[{id:'one',segmentId:f.pro.id,operator:'not_matches'}]});
  await f.identify('a','user');await f.identify('b','user');expect((await f.members()).total).toBe(1);
  for(const anon of ['a','b'])expect((await f.manifest(anon,'user')).experiences.map((x:any)=>x.id)).toEqual([all.id]);
  await f.identify('a','user',{plan:'free'});expect((await f.members()).total).toBe(0);
  expect((await f.manifest('a','user')).experiences.map((x:any)=>x.id)).toEqual([negative.id]);
 });
 it('claims anonymous behavioral history on identify without losing membership',async()=>{
  f=await segmentDeliveryFixture();const s=await f.segment({logic:'and',conditions:[{type:'event',eventName:'setup',operator:'performed'}]});
  const e=await f.widget({type:'segment',segmentId:s.id});await f.ingest('a',[{type:'custom',name:'setup'}]);
  expect((await f.members(s.id)).total).toBe(1);expect((await f.manifest('a')).experiences[0].id).toBe(e.id);
  await f.identify('a','user');expect((await f.members(s.id)).total).toBe(1);
  expect((await f.manifest('a','user')).experiences[0].id).toBe(e.id);
 });
});

describe('publishing and independent restrictions',()=>{
 it.each(['modal','slideout','banner','anchored_card','hotspot','survey','guide','checklist'])('publishes and returns segment-targeted %s',async(type)=>{
  f=await segmentDeliveryFixture(); const e=await f.widget(undefined,type==='guide'?'modal':type,type==='guide'?'guide':type==='checklist'?'checklist':'widget');
  await f.identify('a','user');expect((await f.members()).total).toBe(1);
  const m=await f.manifest('a','user');expect([...m.experiences,...m.checklists].map((x:any)=>x.id)).toContain(e.id);
  const no=await f.manifest('free');expect([...no.experiences,...no.checklists]).toHaveLength(0);
 });
 it.each([
  ['future schedule',{schedule:{startsAt:'2099-01-01T00:00:00.000Z'}},{},false],
  ['expired schedule',{schedule:{endsAt:'2020-01-01T00:00:00.000Z'}},{},false],
  ['valid schedule',{schedule:{startsAt:'2020-01-01T00:00:00.000Z',endsAt:'2099-01-01T00:00:00.000Z'}},{},true],
  ['wrong page',{pageRules:[{id:'r',kind:'include',operator:'equals',value:'/other'}]},{},false],
  ['matching page',{pageRules:[{id:'r',kind:'include',operator:'equals',value:'/'}]},{},true],
  ['wrong origin',{allowedOrigins:['https://other.test']},{},false],
  ['missing event',{trigger:{type:'custom_event',eventName:'setup'}},{},false],
  ['fired event',{trigger:{type:'custom_event',eventName:'setup'}},{trigger:'setup'},true],
 ] as const)('%s',async(_label,targeting,query,eligible)=>{
  f=await segmentDeliveryFixture();await f.widget(undefined,'modal','widget',targeting);await f.identify('a','user');
  expect((await f.members()).total).toBe(1);expect((await f.manifest('a','user',query)).experiences.length>0).toBe(eligible);
 });
 it('keeps published targeting immutable through draft changes, republish and pause/resume',async()=>{
  f=await segmentDeliveryFixture();const e=await f.widget();await f.identify('a','user');const url=f.root+'/experiences/'+e.id;
  let read=await f.request('GET',url);const old=read.publishedVersion.definition.targeting;
  await f.request('PATCH',url,{revision:read.draftVersion.revision,settings:{targeting:{...old,audience:{type:'all'}}}});
  read=await f.request('GET',url);expect(read.publishedVersion.definition.targeting).toEqual(old);expect(read.draftVersion.definition.targeting.audience).toEqual({type:'all'});
  expect((await f.manifest('free')).experiences).toHaveLength(0);
  await f.request('POST',url+'/publish',{draftVersionId:read.draftVersion.id,revision:read.draftVersion.revision});
  expect((await f.manifest('free')).experiences).toHaveLength(1);
  await f.request('POST',url+'/pause');expect((await f.manifest('a','user')).experiences).toHaveLength(0);
  read=await f.request('GET',url);await f.request('POST',url+'/publish',{draftVersionId:read.draftVersion.id,revision:read.draftVersion.revision});expect((await f.manifest('a','user')).experiences).toHaveLength(1);
 });
 it.each(['once','once_per_session'])('persists shown impressions and enforces %s',async(mode)=>{
  f=await segmentDeliveryFixture();await f.widget(undefined,'modal','widget',{frequency:{mode}});await f.identify('a','user');
  const e=(await f.manifest('a','user')).experiences[0];
  await f.request('POST',`/public/sites/${f.site.siteId}/experience-events`,{experienceId:e.id,versionId:e.versionId,event:'shown',timestamp:Date.now(),anonymousId:'a',trackedUserId:'user',sessionId:'audit-session'});
  expect((await f.members()).total).toBe(1);expect((await f.manifest('a','user')).experiences).toHaveLength(0);
  expect((await f.manifest('a','user',{sessionId:'new-session'})).experiences).toHaveLength(mode==='once'?0:1);
 });
 it('isolates identities and segment references across sites',async()=>{
  f=await segmentDeliveryFixture();await f.widget();await f.identify('a','user');
  const site=await f.request('POST',`/orgs/${f.owner.org.id}/sites`,{name:'Other',domain:'http://other.test'});
  const otherRoot=`/orgs/${f.owner.org.id}/sites/${site.id}`;
  const e=await f.request('POST',otherRoot+'/experiences',{kind:'widget',widgetType:'modal',name:'Other',buildUrl:'http://other.test',template:'blank',useBuildPageAsTarget:false});
  e.draftVersion.definition.targeting.audience={type:'segment',segmentId:f.pro.id};
  const r=await f.app.inject({method:'PATCH',url:otherRoot+'/experiences/'+e.id,headers:f.headers,payload:{revision:e.draftVersion.revision,definition:e.draftVersion.definition}});expect(r.statusCode).toBe(400);expect(r.json().error).toBe('invalid_segment');
  const q=new URLSearchParams({url:'http://other.test',anonymousId:'a',trackedUserId:'user',sessionId:'s'});
  expect((await f.request('GET',`/public/sites/${site.siteId}/experiences?${q}`)).experiences).toHaveLength(0);
 });
});

describe('additional identity and entitlement controls',()=>{
 it('preserves membership and delivery when the browser switches accounts',async()=>{
  f=await segmentDeliveryFixture();const e=await f.widget();await f.identify('a','pro-user');
  expect((await f.members()).total).toBe(1);expect((await f.manifest('a','pro-user')).experiences[0].id).toBe(e.id);
  await f.identify('a','free-user',{plan:'free'});expect((await f.members()).total).toBe(1);
  expect((await f.manifest('a','free-user')).experiences).toHaveLength(0);
  expect((await f.manifest('b','pro-user')).experiences[0].id).toBe(e.id);
 });
 it('excludes unpublished drafts',async()=>{
  f=await segmentDeliveryFixture();await f.identify('a','user');await f.request('POST',f.root+'/experiences',{kind:'widget',widgetType:'modal',name:'Draft',buildUrl:'http://localhost:3000',template:'blank',useBuildPageAsTarget:false});
  expect((await f.members()).total).toBe(1);expect((await f.manifest('a','user')).experiences).toHaveLength(0);
 });
 it('excludes all experiences when the subscription is inactive',async()=>{
  f=await segmentDeliveryFixture();await f.widget();await f.identify('a','user');
  const {organizationSubscriptions}=await import('../src/db/schema.js');const {eq}=await import('drizzle-orm');
  await f.db.update(organizationSubscriptions).set({status:'canceled',trialEndsAt:null}).where(eq(organizationSubscriptions.orgId,f.owner.org.id));
  expect((await f.manifest('a','user')).experiences).toHaveLength(0);
 });
});
