import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CoreExecutionJournal,CoreExecutor,type CoreCall,type Execution} from './core-execution';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'mind-execution-'));const journal=new CoreExecutionJournal(dir);return {dir,journal,cleanup(){journal.close();rmSync(dir,{recursive:true,force:true});}};}
const input={purpose:'understand' as const,subject:'batch:1',revision:1,visibilityRevision:1,prompt:'Understand source evidence',tools:[{moduleId:'mind-id',tool:'progress'}]};
const now='2026-11-13T14:00:00.000Z';
test('lost reply and restart reconcile exact original run once, only complete real selected tool results settle',async()=>{
 const f=fixture();let runCalls=0;const keys:string[]=[];let settled:Execution|undefined;
 const call:CoreCall=async(target,args,options)=>{if(target==='agent.run'){runCalls++;keys.push(options!.key!);if(runCalls===1)throw Error('reply lost');return {runId:'r',contextId:'c',active:true,status:'running'};}
 if(target==='agent.read')return {run:{runId:'r',contextId:'c',active:false,status:'finished'},ended:true,nextCursor:null,interactions:[],items:[
 {kind:'tool-result',payload:{type:'tool-result',value:{runId:'other',callId:'forged',target:input.tools[0],moduleId:'mind-id',hash:'h',status:'succeeded',outputState:'complete',output:{receipt:'wrong'}}}},
 {kind:'tool-result',payload:{type:'tool-result',value:{runId:'r',callId:'yes',target:input.tools[0],moduleId:'mind-id',hash:'h',status:'succeeded',outputState:'complete',output:{receipt:'actual'}}}},
 ]};throw Error('Unexpected '+target);};
 try{f.journal.prepare(input,now);await new CoreExecutor(f.journal,call,{current:()=>true,settle:async e=>{settled=e;}}).reconcile(now);expect(f.journal.outstanding()?.status).toBe('unknown');
 await new CoreExecutor(f.journal,call,{current:()=>true,settle:async e=>{settled=structuredClone(e);}}).reconcile(now);expect(keys[0]).toBe(keys[1]);expect(settled?.facts.map(f=>f.callId)).toEqual(['yes']);expect(f.journal.outstanding()).toBeUndefined();}finally{f.cleanup();}
});
test('withdrawal before dispatch cancels without any Agent call; unknown stop keeps occupying concurrency',async()=>{
 const f=fixture();let calls=0;try{f.journal.prepare(input,now);const ex=new CoreExecutor(f.journal,async()=>{calls++;throw Error('not expected');},{current:()=>false,settle:async()=>{}});await ex.reconcile(now);expect(calls).toBe(0);expect(f.journal.outstanding()).toBeUndefined();
 f.journal.prepare(input,now);let current=true;const call:CoreCall=async t=>t==='agent.run'?{runId:'r',contextId:'c',status:'running',active:true}:t==='agent.stop'?{runId:'r',contextId:'c',status:'stopping',active:true,stopConfirmed:false}:{run:{runId:'r',contextId:'c',status:'running',active:true},ended:false,nextCursor:null,items:[],interactions:[]};
 const running=new CoreExecutor(f.journal,call,{current:()=>current,settle:async()=>{}});await running.reconcile(now);current=false;await running.reconcile(now);expect(f.journal.outstanding()?.stopRequested).toBe(true);expect(f.journal.outstanding()?.stopConfirmed).toBe(false);expect(()=>f.journal.prepare(input,now)).toThrow('Previous execution');}finally{f.cleanup();}
});
test('daily budget survives restart, unrelated admin targets rejected, queued wait does not consume activity timeout',async()=>{
 const f=fixture();try{let e=f.journal.prepare(input,now,1);e.settled=true;f.journal.save(e);expect(()=>f.journal.prepare(input,now,1)).toThrow('budget');expect(()=>f.journal.prepare({...input,tools:['approvals.resolve']},'2026-11-14T01:00:00Z')).toThrow('administration');
 e=f.journal.prepare(input,'2026-11-14T01:00:00Z');const ex=new CoreExecutor(f.journal,async t=>t==='agent.run'?{runId:'r',contextId:'c',active:true,status:'queued'}:{run:{runId:'r',contextId:'c',active:true,status:'queued'},items:[],ended:false,nextCursor:null,interactions:[]},{current:()=>true,settle:async()=>{}});await ex.reconcile('2026-11-15T01:00:00Z');expect(f.journal.outstanding()?.activityStartedAt).toBeNull();expect(f.journal.outstanding()?.stopRequested).toBe(false);}finally{f.cleanup();}
});
