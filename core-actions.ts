import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreMindService } from './core-service';
import type { CoreAccess, GuardActionInput } from './core-types';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export type DocumentArtifact={ref:string;digest:string;title:string;body:string;format:'markdown'|'text';pursuitId:string;visibilityRevision:number;createdAt:string};
/** Concrete local document effect, not an arbitrary tool proxy or permission grant. */
export class CoreActions {
 readonly db:Database;
 constructor(directory:string,private readonly service:CoreMindService){
  mkdirSync(directory,{recursive:true,mode:0o700});const path=join(directory,'mind-artifacts.sqlite');this.db=new Database(path,{create:true});chmodSync(path,0o600);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS documents(ref TEXT PRIMARY KEY, action_key TEXT UNIQUE NOT NULL, input_digest TEXT NOT NULL, json TEXT NOT NULL);');
 }
 create(input:GuardActionInput&{document:{title:string;body:string;format?:'markdown'|'text'}},access:CoreAccess){
  if(input.target!=='document')throw Error('Only local document creation is available through this effect adapter');
  const d=input.document;if(!d||typeof d.title!=='string'||typeof d.body!=='string'||!d.body.trim()||d.body.length>150000||d.title.length>200)throw Error('A bounded, nonempty local document is required');
  // Core guard atomically checks current responsibility, pursuit revision and visibility, including replays.
  const guard={...input,arguments:{title:d.title,body:d.body,format:d.format??'markdown'}};
  this.service.guardAction(guard,access);
  const document = this.db.transaction(()=>{
   const signature=digest(JSON.stringify(guard.arguments));const prior=this.db.query('SELECT input_digest,json FROM documents WHERE action_key=?').get(input.actionKey) as {input_digest:string;json:string}|null;
   if(prior){if(prior.input_digest!==signature)throw Error('Same action key cannot change document');return JSON.parse(prior.json) as DocumentArtifact;}
   const document:DocumentArtifact={ref:`mind-document:${digest(input.actionKey)}`,digest:digest(d.body),title:d.title,body:d.body,format:d.format??'markdown',pursuitId:input.pursuitId,visibilityRevision:input.expectedVisibilityRevision,createdAt:new Date().toISOString()};
   this.db.query('INSERT INTO documents(ref,action_key,input_digest,json) VALUES(?,?,?,?)').run(document.ref,input.actionKey,signature,JSON.stringify(document));return document;
  }).immediate();
  this.service.recordAction({actionKey:`${input.actionKey}:outcome`,expectedVisibilityRevision:input.expectedVisibilityRevision,effectActionKey:input.actionKey,outcome:'succeeded',originalReceiptRef:document.ref},{subject:'mind:document-adapter',role:'runtime',scopes:[{}]});
  return document;
 }
 read(ref:string){const r=this.db.query('SELECT json FROM documents WHERE ref=?').get(ref) as {json:string}|null;if(!r)throw Error('Document not found');const d=JSON.parse(r.json) as DocumentArtifact;if(digest(d.body)!==d.digest)throw Error('Document digest mismatch');return d;}
 list(pursuitId:string){return (this.db.query('SELECT json FROM documents').all() as {json:string}[]).map(r=>JSON.parse(r.json) as DocumentArtifact).filter(d=>d.pursuitId===pursuitId).map(({body:_body,...d})=>d);}
 /** Forget removes local derived content; occurred effects remain content-free in the core ledger. */
 forgetPursuits(ids:string[]){const set=new Set(ids);for(const row of this.db.query('SELECT ref,json FROM documents').all() as {ref:string;json:string}[])if(set.has((JSON.parse(row.json) as DocumentArtifact).pursuitId))this.db.query('DELETE FROM documents WHERE ref=?').run(row.ref);this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');}
 close(){this.db.close();}
}
