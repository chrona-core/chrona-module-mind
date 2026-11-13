import {chrona,on,onDisconnect,ModelError,type Caller} from 'chrona';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CoreMindStore,coreDigest} from './core-store';
import {CoreMindService} from './core-service';
import {CoreRuntime,RUNTIME_ACCESS} from './core-runtime';
import {CoreActions} from './core-actions';
import {CoreSources} from './core-sources';
import {CoreNotifications} from './core-notifications';
import {CoreRecovery} from './core-recovery';
import {CoreError,type CoreAccess,type ContextInput} from './core-types';
import type {CoreCall} from './core-execution';
const store=new CoreMindStore(chrona.paths.data),service=new CoreMindService(store),actions=new CoreActions(chrona.paths.data,service);
const rawCall:CoreCall=async(target,args,options)=>{
 const value=await (chrona.call as CoreCall)(target,args,options);
 if(value&&typeof value==='object'&&'json'in value&&typeof value.json==='string')return JSON.parse(value.json) as unknown;
 return value;
};
const recovery=new CoreRecovery(chrona.paths.data,store,service);
const notifications=new CoreNotifications(store,rawCall,()=>chrona.dependencies['notify']);
let identity:{moduleId:string;hash:string}|undefined;
const self=()=>{if(!identity)throw Error('Mind current version is not verified');return identity;};
const runtime=new CoreRuntime(store,service,rawCall,self,actions);
const sources=new CoreSources(store,service,rawCall,async()=>{const id=chrona.dependencies['chat'];if(!id)return undefined;const directory=await rawCall('modules.list',{limit:100}) as {items:{id:string;activeHash:string}[]};const row=directory.items.find(m=>m.id===id);return row?.activeHash?{moduleId:id,hash:row.activeHash}:undefined;});
const TOOLS=['overview','detail','settings','context','remember','pursue','control','feedback','forget','progress','action','artifact','verdict','check','recovery'];
const tools=new Set(TOOLS);let pagesReady=false,maintaining=false,backgroundBusy=false,closed=false;
const log=(event:string,error:unknown)=>console.error(JSON.stringify({component:'mind',event,error:error instanceof Error?error.message.slice(0,500):String(error).slice(0,500)}));
async function verifyIdentity(){
 const directory=await rawCall('modules.list',{limit:100}) as {items:{id:string;name:string;activeHash:string}[]};const row=directory.items.find(m=>m.name==='mind');
 if(!row?.activeHash)throw Error('Active Mind module missing from directory');identity={moduleId:row.id,hash:row.activeHash};
}
function access(caller:Caller|undefined,tool:string,executionRunId?:string):CoreAccess{
 if(caller?.kind==='owner')return {subject:`owner:${caller.via??'local'}`,role:'owner',scopes:[{}]};
 if(caller?.kind==='module'){
  if(caller.moduleId===self().moduleId&&caller.hash===self().hash){const bound=runtime.accessForCaller(`module:${caller.moduleId}:${caller.hash}`,true,executionRunId);if(['remember','pursue','control','feedback','progress','action'].includes(tool)&&!bound.execution)throw new ModelError('forbidden','Only the current kernel-bound Mind execution may mutate understanding or work');return bound;}
  // Web is the explicitly approved owner UI host; only its real kernel principal is accepted, never a JSON owner flag.
  if(caller.moduleId===chrona.dependencies['web']&&['overview','detail','settings','context','control','feedback','forget','remember','pursue','artifact','check','recovery'].includes(tool))return {subject:`web:${caller.moduleId}:${caller.hash}`,role:'owner',scopes:[{}]};
  return {subject:`module:${caller.moduleId}:${caller.hash}`,role:'application',scopes:[{}]};
 }
 throw new ModelError('forbidden','Mind requires a real owner or approved application caller');
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function input(args:Record<string,unknown>){if(typeof args.input!=='string')throw new ModelError('invalid','Expected input JSON');const value=JSON.parse(args.input) as unknown;if(!object(value))throw new ModelError('invalid','Expected a JSON object');return value;}
function contextInput(args:Record<string,unknown>):ContextInput{
 const scope=typeof args.scope==='string'?{sessionId:args.scope}:object(args.scope)?args.scope:{};
 return {scope,...(typeof args.query==='string'?{query:args.query}:{}),...(typeof args.limit==='number'?{limit:args.limit}:{}),...(typeof args.maxBytes==='number'?{maxBytes:args.maxBytes}:{})};
}
async function register(){
 if(maintaining)return;maintaining=true;
 try{
  await verifyIdentity();if(!pagesReady&&chrona.dependencies['web']){
   const component=await chrona.call<{type:string}>({moduleId:chrona.dependencies['web'],tool:'component-set'},{name:'MindWorkspace',javascript:readFileSync(join(chrona.paths.module,'dist/workspace.js'),'utf8'),css:readFileSync(join(chrona.paths.module,'workspace.css'),'utf8'),props:{type:'object',properties:{view:{type:'string',enum:['overview','understanding','connections','settings']}},additionalProperties:false},tools:TOOLS});
   for(const page of [{id:'main',title:'Mind',view:'overview'},{id:'settings',title:'Mind 设置',view:'settings'}])await chrona.call({moduleId:chrona.dependencies['web'],tool:'page-set'},{id:page.id,title:page.title,layout:'workspace',spec:{root:'mind',elements:{mind:{type:component.type,props:{view:page.view},children:[]}}}});
   pagesReady=true;
  }
  const timer=await chrona.call<{items:{id:string}[]}>('timers.list',{});if(!timer.items.some(t=>t.id==='mind-core'))await chrona.call('timers.set',{id:'mind-core',schedule:{kind:'every',milliseconds:60000}});
 }catch(error){log('registration_failed',error);}finally{maintaining=false;}
}
async function background(manual=false){
 if(backgroundBusy||closed)return runtime.view();backgroundBusy=true;
 try{recovery.guard();if(!identity)await verifyIdentity();if(!store.inspect(tx=>tx.settings().restoreBlocked))await sources.sync();runtime.cleanupWithdrawn();const status=await runtime.tick(manual);runtime.cleanupWithdrawn();await notifications.sync();return status;}
 catch(error){log('source_or_runtime_failed',error);return {...runtime.view(),sourceError:error instanceof Error?error.message:'Source unavailable'};}
 finally{backgroundBusy=false;}
}
on('tool',async event=>{
 try{
  if(!tools.has(event.id))throw new ModelError('invalid','Unknown Mind tool');if(!identity)await verifyIdentity();
  recovery.guard();const a=event.args,who=access(event.caller,event.id,event.call?.executionRunId);let result:unknown;
  if(store.inspect(tx=>tx.settings().restoreBlocked)&&who.role!=='owner'&&['context','detail','artifact','overview'].includes(event.id))throw new CoreError('RESTORE_BLOCKED','Restored memory is unavailable until owner review');
  switch(event.id){
   case 'context':result=service.context(contextInput(a),who);break;
   case 'overview':{
    const overview=service.overview({limit:typeof a.limit==='number'?a.limit:50,...(typeof a.after==='string'?{after:a.after}:{})},who);
    result={...overview,health:runtime.view(),notifications:notifications.view(),budget:runtime.view().budget,sources:store.read().checkpoints,autonomousPublishing:runtime.view().autonomousPublishing,recovery:recovery.status()};break;
   }
   case 'detail':{
    const id=String(a.id??''),state=store.read();const kind=state.pursuits.some(p=>p.id===id)?'pursuit':state.understandings.some(u=>u.id===id)?'understanding':'evidence';
    const detail=service.detail({kind,id},who),refs='evidenceRefs'in detail?detail.evidenceRefs:'supportingRefs'in detail?[...detail.supportingRefs,...detail.opposingRefs]:[];
    result={...detail,evidence:refs.map(id=>service.detail({kind:'evidence',id},who)).filter(e=>!e.retractedAt),artifacts:kind==='pursuit'?actions.list(id).map(d=>actions.read(d.ref)):[]};break;
   }
   case 'recovery':{result=a.input===undefined?recovery.status():recovery.review(input(a) as never,who);break;}
   case 'settings':{
    if(a.patch===undefined)result=service.settings(undefined,who);
    else {const patch=JSON.parse(String(a.patch)) as unknown;if(!object(patch))throw new ModelError('invalid','Settings patch must be an object');const state=store.read();result=service.settings({expectedRevision:Number(a.revision),expectedVisibilityRevision:state.visibilityRevision,actionKey:`settings:${coreDigest([who.subject,a.revision,patch])}`,patch},who);await runtime.executor.reconcile();}break;
   }
   case 'remember':result=service.remember(input(a) as never,who);break;
   case 'pursue':result=service.pursue(input(a) as never,who);break;
   case 'control':result=service.control(input(a) as never,who);await runtime.executor.reconcile();break;
   case 'feedback':result=service.feedback(input(a) as never,who);break;
   case 'forget':{
    const forgotten=service.forget(input(a) as never,who);await runtime.executor.reconcile();const cleanup=runtime.cleanupWithdrawn();result={...forgotten,value:{...forgotten.value,cleanup:{...forgotten.value?.cleanup,mind:cleanup.deferred?'deferred-original-command':'complete',deferredCommands:cleanup.deferred}}};break;
   }
   case 'verdict':{if(event.caller?.kind!=='module'||event.caller.moduleId!==self().moduleId||event.caller.hash!==self().hash)throw new ModelError('forbidden','Independent verifier identity required');if(!event.call?.executionRunId)throw new ModelError('forbidden','Kernel-bound verifier run required');result=runtime.verdict(input(a) as never,{...event.caller,runId:event.call.executionRunId});break;}
   case 'progress':await runtime.bindResponsibility();result=service.progress(input(a) as never,access(event.caller,event.id,event.call?.executionRunId));break;
   case 'action':await runtime.bindResponsibility();result=actions.create(input(a) as never,access(event.caller,event.id,event.call?.executionRunId));break;
   case 'artifact':{
    const document=actions.read(String(a.ref));service.detail({kind:'pursuit',id:document.pursuitId},who);result=document;break;
   }
   case 'check':if(who.role!=='owner')throw new ModelError('forbidden','Only the owner can manually check');result=await background(true);break;
  }
  return {result:{json:JSON.stringify(result)}};
 }catch(error){log(event.id,error);if(error instanceof ModelError)throw error;if(error instanceof CoreError)return {result:{json:JSON.stringify({error:{code:error.code,message:error.message}})}};throw new ModelError('failed',error instanceof Error?error.message:'Mind operation failed');}
});
on('activated',async()=>{pagesReady=false;await register();return {};});
on('timer',async event=>{if(event.id!=='mind-core')throw new ModelError('invalid','Unknown Mind timer');return {result:await background()};});
const reconciliationTimer=setInterval(()=>{void background();},10000),registrationTimer=setInterval(()=>{void register();},60000);
onDisconnect(()=>{closed=true;clearInterval(reconciliationTimer);clearInterval(registrationTimer);runtime.close();notifications.close();actions.close();store.close();});
void register();
