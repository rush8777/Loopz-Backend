import fs from 'node:fs';
import { createTestApp, signup } from './helpers.js';
import { publishReviewed } from './reviewedPublish.js';
export async function segmentDeliveryFixture(domain = 'localhost:3000') {
 const ctx = await createTestApp(); const owner = await signup(ctx.app);
 const log=(entry:any)=>{fs.mkdirSync('../evidence',{recursive:true});fs.appendFileSync('../evidence/backend-requests.jsonl',JSON.stringify(entry)+'\n');};
 const headers = { authorization: `Bearer ${owner.accessToken}` };
 async function request(method: any, url: string, payload?: any) {
  const r = await ctx.app.inject({method,url,headers,payload});
  log({method,url,request:payload,status:r.statusCode,response:r.json()});
  if(r.statusCode>=400) throw new Error(`${method} ${url} ${r.statusCode} ${r.body}`);
  return r.json();
 }
 const site = await request('POST',`/orgs/${owner.org.id}/sites`,{name:'Audit site',domain:`http://${domain}`} );
 const root = `/orgs/${owner.org.id}/sites/${site.id}`;
 async function segment(definition: any = {logic:'and',conditions:[{type:'user_property',propertyName:'plan',operator:'equals',value:'pro'}]}) {
  return request('POST',root+'/segments',{name:'Audit segment',definition});
 }
 const pro = await segment(); let counter=0;
 async function widget(audience: any = {type:'segment',segmentId:pro.id}, widgetType='modal', kind='widget', targetingPatch:any={}) {
  const e = await request('POST',root+'/experiences',{kind,...(kind==='widget'?{widgetType}:kind==='guide'?{guidePattern:'modal'}:{}),name:'Audit experience '+(++counter),buildUrl:`http://${domain}/`,template:'blank',useBuildPageAsTarget:false});
  const definition=e.draftVersion.definition; definition.targeting.audience=audience;
  definition.targeting.frequency={mode:'every_time'}; Object.assign(definition.targeting,targetingPatch);
  if(widgetType==='anchored_card'||widgetType==='hotspot')definition.target={primarySelector:'#target',fallbackSelectors:[],reliability:'reliable'};
  await request('PATCH',root+'/experiences/'+e.id,{definition,revision:e.draftVersion.revision});
  const r=await publishReviewed(ctx.app,{method:'POST',url:root+'/experiences/'+e.id+'/publish',headers});
  log({method:'POST',url:root+'/experiences/'+e.id+'/publish',status:r.statusCode,response:r.json()});
  if(r.statusCode!==200)throw new Error(r.body); return r.json();
 }
 async function ingest(anonymousId: string, events:any[], sessionId='audit-session') {
  const r=await ctx.app.inject({method:'POST',url:`/public/sites/${site.siteId}/events`,payload:{sessionId,events:events.map(e=>({timestamp:Date.now(),anonymousId,...e}))}});
  log({method:'POST',url:`/public/sites/${site.siteId}/events`,request:{anonymousId,sessionId,events},status:r.statusCode,response:r.json()});
  if(r.statusCode!==200)throw new Error(r.body); return r.json();
 }
 async function identify(anon:string,user:string,traits:any={plan:'pro'}) {return ingest(anon,[{type:'identify',externalUserId:user,traits}]);}
 async function members(segmentId=pro.id){return request('GET',root+'/segments/'+segmentId+'/members');}
 async function manifest(anon:string,user?:string,extra:Record<string,string>={}) {
  const q=new URLSearchParams({url:`http://${domain}/`,anonymousId:anon,sessionId:'audit-session',...(user?{trackedUserId:user}:{}),...extra});
  const r=await ctx.app.inject({method:'GET',url:`/public/sites/${site.siteId}/experiences?${q}`});
  log({method:'GET',url:`/public/sites/${site.siteId}/experiences`,query:Object.fromEntries(q),status:r.statusCode,response:r.json()});
  if(r.statusCode!==200)throw new Error(r.body);return r.json();
 }
 return {...ctx,owner,headers,site,root,pro,request,segment,widget,ingest,identify,members,manifest};
}
