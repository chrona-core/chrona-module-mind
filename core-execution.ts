import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Target = string | { moduleId: string; tool: string };
export type CoreCall = (target: Target, args: Record<string, unknown>, options?: { key?: string }) => Promise<unknown>;
export type ToolFact = { runId: string; callId: string; target: Target; moduleId: string; hash: string; status: string; outputState: string; output?: unknown };
export type Execution = {
 id: string; purpose: 'understand'|'pursuit'|'opportunity'; subject: string; basis?: string; revision: number; visibilityRevision: number;
 principal?: {moduleId:string;hash:string}; key: string; args: Record<string, unknown>; tools: Target[]; createdAt: string; activityStartedAt: string|null;
 contextId: string|null; runId: string|null; cursor: string|null; status: 'prepared'|'running'|'waiting'|'unknown'|'settling'|'finished'|'failed';
 ended: boolean; active: boolean; terminalStatus?: string; stopRequested: boolean; stopConfirmed: boolean; stopKey: string;
 error: string|null; interactions: unknown[]; facts: ToolFact[]; summary: string; settled: boolean;
};
export type ExecutionHooks = {
 /** Rechecks current target/visibility versions immediately before each new dispatch. */
 current: (execution: Execution) => boolean;
 /** Actual persisted tool results; never model text. Must be idempotent by execution/callId. */
 settle: (execution: Execution) => Promise<void>;
 admitted?: (execution: Execution) => Promise<void>;
};
const targetKey = (t: Target) => typeof t === 'string' ? t : `${t.moduleId}:${t.tool}`;
const errorText = (e: unknown) => e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function runView(raw: unknown) {
 if (!record(raw) || typeof raw.runId !== 'string' || typeof raw.contextId !== 'string' || typeof raw.status !== 'string' || typeof raw.active !== 'boolean') throw Error('Invalid Agent run receipt');
 return { runId: raw.runId, contextId: raw.contextId, status: raw.status, active: raw.active };
}
/** This journal stores command identities and observations; all execution remains in kernel's unique queue. */
export class CoreExecutionJournal {
 readonly db: Database;
 constructor(directory: string) {
  mkdirSync(directory, {recursive:true,mode:0o700}); const path=join(directory,'mind-execution.sqlite');
  this.db=new Database(path,{create:true}); chmodSync(path,0o600);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);');
 }
 all():Execution[] { return (this.db.query('SELECT json FROM executions ORDER BY created_at,id').all() as {json:string}[]).map(r=>JSON.parse(r.json) as Execution); }
 save(e:Execution) { this.db.query('INSERT INTO executions(id,created_at,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(e.id,e.createdAt,JSON.stringify(e)); return structuredClone(e); }
 get(id:string):Execution { const row=this.db.query('SELECT json FROM executions WHERE id=?').get(id) as {json:string}|null; if(!row)throw Error('Execution not found'); return JSON.parse(row.json) as Execution; }
 outstanding() { return this.all().find(e=>!e.settled); }
 prepare(input:{purpose:Execution['purpose'];subject:string;basis?:string;revision:number;visibilityRevision:number;prompt:string;tools:Target[];principal?:{moduleId:string;hash:string}}, now:string, budget=24, opportunityBudget=8) {
  return this.db.transaction(()=>{
   if(this.outstanding())throw Error('Previous execution or effect still requires reconciliation');
   const today=this.all().filter(e=>e.createdAt.slice(0,10)===now.slice(0,10));
   if(today.length>=budget || input.purpose==='opportunity'&&today.filter(e=>e.purpose==='opportunity').length>=opportunityBudget)throw Error('Background start budget exhausted');
   if(input.tools.length>100 || new Set(input.tools.map(targetKey)).size!==input.tools.length)throw Error('Invalid selected tools');
   if(input.tools.some(t=>typeof t==='string' && (/^(approvals\.(resolve|request)|secrets\.|settings\.|agent\.(run|native)|modules\.(install|remove|rollback|promote))/.test(t)))) throw Error('Autonomous tool selection includes unrestricted administration');
   const id=randomUUID();
   return this.save({id,purpose:input.purpose,subject:input.subject,basis:input.basis,revision:input.revision,visibilityRevision:input.visibilityRevision,principal:input.principal,key:`mind:${id}:run`,
    args:{prompt:input.prompt,content:[],lane:'background',tools:input.tools,kind:'conversation'},tools:structuredClone(input.tools),createdAt:now,activityStartedAt:null,contextId:null,runId:null,cursor:null,status:'prepared',ended:false,active:false,stopRequested:false,stopConfirmed:false,stopKey:`mind:${id}:stop`,error:null,interactions:[],facts:[],summary:'',settled:false});
  }).immediate();
 }
 scrubInvalid(keep:(e:Execution)=>boolean){let deferred=0;for(const e of this.all()){
  if(keep(e))continue;
  if(!e.settled&&!e.runId&&e.status!=='prepared'){deferred++;continue;}
  if(!e.settled)e.stopRequested=true;
  if(Object.keys(e.args).length||e.interactions.length||e.facts.some(f=>f.output!==undefined)||e.summary||e.error){e.args={};e.interactions=[];e.facts=e.facts.map(({output:_output,...f})=>f);e.summary='';e.error=null;this.save(e);}
 }this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');return {deferred};}
 prune(now:string) { // Keep unresolved identities; finite recovery receipts rather than a lifetime cap.
  const floor=new Date(Date.parse(now)-30*86400000).toISOString();
  for(const e of this.all())if(e.settled&&e.createdAt<floor)this.db.query('DELETE FROM executions WHERE id=?').run(e.id);
 }
 close(){this.db.close();}
}
/** Preserves original run command on lost reply, and unknown effects occupy concurrency until reconciled. */
export class CoreExecutor {
 private busy=false;
 constructor(readonly journal:CoreExecutionJournal, readonly call:CoreCall, readonly hooks:ExecutionHooks){}
 async reconcile(now=new Date().toISOString()) {
  if(this.busy)return; this.busy=true;
  try {
   let e=this.journal.outstanding(); if(!e)return;
   if(e.status==='settling'){await this.settle(e);return;}
   const current=this.hooks.current(e);
   if(!current || e.activityStartedAt && Date.parse(now)-Date.parse(e.activityStartedAt)>(e.purpose==='opportunity'?180000:600000))e.stopRequested=true;
   if(!e.runId){
    // Even when withdrawn, prepared/unknown requests must query the *original* command identity.
    // Pure prepared commands have no dispatch intent yet and may be cancelled without dispatch.
    if(e.stopRequested && e.status==='prepared'){e.status='failed';e.ended=true;e.active=false;e.stopConfirmed=true;this.journal.save(e);await this.settle(e);return;}
    e.status='unknown';this.journal.save(e); // durable before external call
    const run=runView(await this.call('agent.run',e.args,{key:e.key}));
    e.runId=run.runId;e.contextId=run.contextId;e.status='running';e.active=run.active;this.journal.save(e);
   }
   this.journal.save(e);await this.hooks.admitted?.(e);e=this.journal.get(e.id);
   if(e.stopRequested&&!e.stopConfirmed){
    const stopped=await this.call('agent.stop',{runId:e.runId},{key:e.stopKey});
    const run=runView(stopped);if(run.runId!==e.runId||run.contextId!==e.contextId)throw Error('Stop receipt identity mismatch');
    e.stopConfirmed=record(stopped)&&stopped.stopConfirmed===true;e.active=run.active;this.journal.save(e);
   }
   for(let i=0;i<5;i++){
    const page=await this.call('agent.read',{runId:e.runId,...(e.cursor?{cursor:e.cursor}:{}),limit:100,waitMs:0});
    if(!record(page)||!Array.isArray(page.items)||typeof page.ended!=='boolean'||!(page.nextCursor===null||typeof page.nextCursor==='string'))throw Error('Invalid Agent observation page');
    const run=runView(page.run);if(run.runId!==e.runId||run.contextId!==e.contextId)throw Error('Agent observation identity mismatch');
    if(run.active&&!e.activityStartedAt&&run.status!=='queued')e.activityStartedAt=now;
    for(const item of page.items)this.capture(e,item);
    const next=page.nextCursor as string|null;if(next&&next===e.cursor&&page.items.length)throw Error('Agent observation cursor did not advance');
    e.cursor=next;e.ended=page.ended;e.active=run.active;if(!run.active)e.terminalStatus=run.status;e.interactions=Array.isArray(page.interactions)?page.interactions:[];
    e.status=run.status==='unknown'?'unknown':run.active?(e.interactions.length?'waiting':'running'):run.status==='finished'?'finished':'failed';e.error=null;
    this.journal.save(e);
    if(page.ended&&!next&&!run.active&&(!e.stopRequested||e.stopConfirmed)){await this.settle(e);return;}
    if(!next)break;
   }
  } catch(error){const e=this.journal.outstanding();if(e){e.error=errorText(error);if(e.status!=='settling')e.status='unknown';this.journal.save(e);}console.error(JSON.stringify({component:'mind',event:'execution_reconciliation_failed',error:errorText(error)}));}
  finally{this.busy=false;}
 }
 private capture(e:Execution,raw:unknown){
  if(!record(raw)||raw.kind!=='tool-result'||!record(raw.payload)||raw.payload.type!=='tool-result'||!record(raw.payload.value))return;
  const v=raw.payload.value;
  if(v.runId!==e.runId||typeof v.callId!=='string'||typeof v.moduleId!=='string'||typeof v.hash!=='string'||typeof v.status!=='string'||typeof v.outputState!=='string')return;
  if(e.principal&&(v.moduleId!==e.principal.moduleId||v.hash!==e.principal.hash))return;
  const t=v.target;if(!(typeof t==='string'||record(t)&&typeof t.moduleId==='string'&&typeof t.tool==='string'))return;
  if(!e.tools.some(selected=>targetKey(selected)===targetKey(t as Target)))return;
  const fact={runId:e.runId!,callId:v.callId,target:t as Target,moduleId:v.moduleId,hash:v.hash,status:v.status,outputState:v.outputState,...(v.outputState==='complete'&&this.hooks.current(e)?{output:v.output}:{})};
  const at=e.facts.findIndex(f=>f.callId===fact.callId);if(at<0)e.facts.push(fact);else e.facts[at]=fact;
 }
 private async settle(e:Execution){
  if(e.facts.some(f=>f.status==='unknown')){e.status='unknown';e.error='Original tool effect remains unknown; no new execution will start';this.journal.save(e);return;}
  e.status='settling';this.journal.save(e);
  await this.hooks.settle(e);e.settled=true;e.status=e.terminalStatus==='finished'&&!e.stopRequested?'finished':'failed';e.args={};e.interactions=[];e.facts=e.facts.map(({output:_output,...f})=>f);this.journal.save(e);
 }
 async stop(){const e=this.journal.outstanding();if(e){e.stopRequested=true;this.journal.save(e);await this.reconcile();}}
}
