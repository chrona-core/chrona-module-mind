import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CoreError, type CoreMeta, type CoreRecords, type CoreSettings, type CoreState, type Receipt, type RecordKind, type Understanding, type ContextResult, type Scope, type Pursuit } from "./core-types";

export const CORE_DATABASE_FILE = "mind-core.sqlite";
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  throw new CoreError("INVALID_INPUT", "Expected finite JSON data");
}
export const coreDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const evidenceId = (sourceIdentity: string, epoch: string, eventId: string): string => coreDigest([sourceIdentity, epoch, eventId]);
export const objectRetractionId = (sourceIdentity: string, kind: string, id: string): string => coreDigest(["object", sourceIdentity, kind, id]);
export const sessionRetractionId = (id: string): string => coreDigest(["session", id]);

export const defaultCoreSettings = (): CoreSettings => ({
  revision: 0, enabled: true, learningEnabled: true, notifyEnabled: false,
  timezone: "UTC", quietStart: "23:00", quietEnd: "08:00",
  eventRetentionDays: 30, diagnosticRetentionDays: 7,
  maxDatabaseBytes: 256 * 1024 * 1024, restoreBlocked: false,
});

type RetractionOptions = {
  evidenceRefs: string[]; now: string; reason: "forgotten" | "source-retracted";
  understandingIds?: string[]; fenceObjects?: boolean;
};
type RetractionWork = RetractionOptions & {
  visibilityRevision: number; removed: Set<string>; understandings: Set<string>; pursuits: Set<string>;
};
type ContextCollection = {
  limit: number; maxBytes: number; applies: (item: { scope: Scope }) => boolean;
  relevant: (value: string) => boolean; readable: (scope: Scope) => boolean;
};
function invalidInput(message: string): never { throw new CoreError("INVALID_INPUT", message); }
const DAY = 86_400_000;

/** Synchronous transaction only: callbacks must never await external work or issue effects. */
export class CoreTransaction {
  constructor(private readonly db: Database, private readonly writable: boolean) {}
  private write() { if (!this.writable) throw new CoreError("FORBIDDEN", "Read transaction cannot write"); }
  get<K extends RecordKind>(kind: K, id: string): CoreRecords[K] | undefined {
    const row = this.db.query<{ data: string }, [string, string]>("SELECT data FROM mind_records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(row.data) as CoreRecords[K] : undefined;
  }
  list<K extends RecordKind>(kind: K): CoreRecords[K][] {
    return this.db.query<{ data: string }, [string]>("SELECT data FROM mind_records WHERE kind=? ORDER BY id").all(kind).map(row => JSON.parse(row.data) as CoreRecords[K]);
  }
  put<K extends RecordKind>(kind: K, value: CoreRecords[K]): void {
    this.write();
    this.db.query("INSERT INTO mind_records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(kind, value.id, canonical(value));
  }
  delete(kind: RecordKind, id: string): void { this.write(); this.db.query("DELETE FROM mind_records WHERE kind=? AND id=?").run(kind, id); }
  meta(): CoreMeta { return this.setting<CoreMeta>("meta"); }
  setMeta(value: CoreMeta): void { this.setSetting("meta", value); }
  settings(): CoreSettings { return this.setting<CoreSettings>("settings"); }
  setSettings(value: CoreSettings): void { this.setSetting("settings", value); }
  private setting<T>(key: string): T {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM mind_meta WHERE key=?").get(key);
    if (!row) throw new Error(`Mind core missing metadata: ${key}`);
    return JSON.parse(row.data) as T;
  }
  private setSetting(key: string, value: unknown): void {
    this.write(); this.db.query("UPDATE mind_meta SET data=? WHERE key=?").run(canonical(value), key);
  }
  receipt<T>(options: {
    subject: string; actionKey: string; args: unknown; now: string;
    apply: () => T; authorizeCached?: (value: T | null) => void;
  }): Receipt<T> {
    const { subject, actionKey, args, now, apply, authorizeCached } = options;
    this.write();
    const hash = coreDigest(args);
    const previous = this.db.query<{ digest: string; result: string }, [string, string]>("SELECT digest,result FROM mind_receipts WHERE subject=? AND action_key=?").get(subject, actionKey);
    if (previous) {
      if (previous.digest !== hash) throw new CoreError("CONFLICT", "actionKey already used with different parameters");
      const result = JSON.parse(previous.result) as Receipt<T>;
      authorizeCached?.(result.value);
      return result;
    }
    const value = apply();
    const result: Receipt<T> = { actionKey, at: now, outcome: "applied", value };
    this.db.query("INSERT INTO mind_receipts(subject,action_key,digest,result,at) VALUES(?,?,?,?,?)").run(subject, actionKey, hash, canonical(result), now);
    return result;
  }
  /** Keep key/digest fences indefinitely; retire content without imposing a lifetime operation cap. */
  compactReceipts(before: string, outcome: "compacted" | "forgotten" = "compacted"): void {
    this.write();
    this.db.query("UPDATE mind_receipts SET result=json_object('actionKey',action_key,'at',at,'outcome',?,'value',NULL) WHERE at<=? AND json_extract(result,'$.outcome')='applied'").run(outcome, before);
  }
  authorizeValue(value: unknown, authorizeScope: (scope: Scope) => void): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(item => this.authorizeValue(item, authorizeScope)); return; }
    const object = value as Record<string, unknown>;
    if (object.scope) authorizeScope(object.scope as Scope);
    this.authorizeReferences(object, authorizeScope);
    for (const item of Object.values(object)) this.authorizeValue(item, authorizeScope);
  }
  private authorizeReferences(object: Record<string, unknown>, authorizeScope: (scope: Scope) => void): void {
    const check = (kind: RecordKind, id: unknown) => {
      if (typeof id !== "string") return;
      const record = this.get(kind, id);
      if (record) this.authorizeValue(record, authorizeScope);
    };
    if (typeof object.pursuitId === "string") {
      const p = this.get("pursuit", object.pursuitId); if (p) authorizeScope(p.scope);
    }
    if (typeof object.candidateId === "string") check("candidate", object.candidateId);
    if (object.targetKind === "understanding" || object.targetKind === "pursuit") check(object.targetKind, object.targetId);
    if (object.kind === "evidence" || object.kind === "understanding" || object.kind === "pursuit") check(object.kind, object.id);
    for (const key of ["evidenceRefs", "supportingRefs", "opposingRefs"] as const) {
      if (Array.isArray(object[key])) for (const id of object[key]) check("evidence", id);
    }
  }
  private contextCoverage(result: ContextResult): void {
    const settings = this.settings();
    if (settings.restoreBlocked) result.unknowns.push("restore_retraction_ledger_unverified");
    if (!settings.learningEnabled) result.unknowns.push("learning_paused");
    if (!settings.enabled) result.unknowns.push("mind_paused");
    // Coverage is technical source state, not proof that a source or model is usable.
    result.checkpoints = this.list("checkpoint").map(c => ({ ...c, batchDigest: undefined }));
    for (const c of result.checkpoints) {
      if (!c.coverage.complete) result.unknowns.push(`${c.sourceIdentity}: ${c.coverage.gap ?? "incomplete coverage"}`);
    }
    if (!result.checkpoints.length) result.unknowns.push("no_source_coverage");
  }
  private addContextRecord(result: ContextResult, kind: "understandings" | "pursuits", item: Understanding | Pursuit,
    options: ContextCollection): void {
    if (result.understandings.length + result.pursuits.length >= options.limit) { result.truncated = true; return; }
    const refs = "supportingRefs" in item ? [...item.supportingRefs, ...item.opposingRefs] : [...item.evidenceRefs,...item.understandingRefs.flatMap(id=>{const u=this.get('understanding',id);return u?[...u.supportingRefs,...u.opposingRefs]:['missing-understanding'];})];
    const evidence = [...new Set(refs)].flatMap(id => {
      const e = this.get("evidence", id); return e && !e.retractedAt && !e.expiredAt && options.readable(e.scope) &&
        (e.sourceIdentity==='owner'||e.sourceIdentity==='mind-owner'||this.list('checkpoint').some(cp=>cp.sourceIdentity===e.sourceIdentity&&cp.epoch===e.epoch&&cp.scopeRevision===e.scopeRevision&&cp.coverage.complete)) ? [e] : [];
    });
    // Missing coverage is an unknown, never a basis for reusing copied understanding.
    if(evidence.length!==new Set(refs).size)return;
    const next = { ...result, [kind]: [...result[kind], item],
      evidence: [...result.evidence, ...evidence.filter(e => !result.evidence.some(prior => prior.id === e.id))] };
    if (Buffer.byteLength(canonical(next)) > options.maxBytes) { result.truncated = true; return; }
    if (kind === "understandings") result.understandings.push(item as Understanding); else result.pursuits.push(item as Pursuit);
    result.evidence = next.evidence;
  }
  collectContext(options: ContextCollection): ContextResult {
    const { applies, relevant, limit, maxBytes } = options;
    const u = this.list("understanding").filter(item => applies(item) && item.status !== "retracted");
    // Specific exceptions precede broad claims; explicit statements precede inference in one scope.
    u.sort((a, b) => Object.keys(b.scope).length - Object.keys(a.scope).length ||
      Number(b.explicitness === "explicit") - Number(a.explicitness === "explicit") || Number(relevant(b.value))-Number(relevant(a.value)) ||
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const p = this.list("pursuit").filter(item => applies(item) && !["done", "ended"].includes(item.status)).sort((a,b)=>Number(relevant(b.goal))-Number(relevant(a.goal))||b.updatedAt.localeCompare(a.updatedAt));
    const result: ContextResult = { revision: this.meta().revision, visibilityRevision: this.meta().visibilityRevision,
      understandings: [], pursuits: [], evidence: [], feedback: [], checkpoints: [], unknowns: [], truncated: false };
    this.contextCoverage(result);
    u.forEach(item => this.addContextRecord(result, "understandings", item, options));
    p.forEach(item => this.addContextRecord(result, "pursuits", item, options));
    for (const feedback of this.list("feedback").filter(applies).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)) {
      if (Buffer.byteLength(canonical({ ...result, feedback: [...result.feedback, feedback] })) > maxBytes) {
        result.truncated = true; break;
      }
      result.feedback.push(feedback);
    }
    // Source metadata must respect the response bound too.
    while (Buffer.byteLength(canonical(result)) > maxBytes && result.checkpoints.length) { result.checkpoints.pop(); result.truncated = true; }
    while (Buffer.byteLength(canonical(result)) > maxBytes && result.unknowns.length) { result.unknowns.pop(); result.truncated = true; }
    return result;
  }
  understandingRetractionId(kind: Understanding["kind"], scope: Understanding["scope"], refs: string[]): string {
    const origins = [...new Set(refs.map(id => {
      const e = this.get("evidence", id);
      return e ? coreDigest([e.sourceIdentity, e.object.kind, e.object.id, e.object.revision]) : id;
    }))].sort();
    return coreDigest(["understanding", kind, scope, origins]);
  }
  invalidateUnderstanding(id: string, now: string): void {
    for (const p of this.list("pursuit")) {
      if (!p.understandingRefs.includes(id) || p.status === "ended") continue;
      p.revision++; p.updatedAt = now;
      if (p.currentActor) p.currentActor.stopRequested = true;
      p.status = "waiting"; p.waitReason = "understanding changed; execution and result require fresh verification";
      delete p.verification; this.put("pursuit", p);
    }
  }
  retract(options: RetractionOptions) {
    const meta = this.meta(); meta.visibilityRevision++; this.setMeta(meta);
    const work: RetractionWork = { ...options, visibilityRevision: meta.visibilityRevision,
      removed: new Set(options.evidenceRefs), understandings: new Set(options.understandingIds), pursuits: new Set() };
    this.retractEvidence(work);
    this.retractUnderstandings(work);
    this.retractPursuits(work);
    this.retractEphemeral(work);
    return { visibilityRevision: meta.visibilityRevision, evidence: work.removed.size,
      understandings: work.understandings.size, pursuits: work.pursuits.size };
  }
  private retractEvidence(work: RetractionWork): void {
    const { now, reason, visibilityRevision } = work;
    for (const id of work.removed) {
      const e = this.get("evidence", id); if (!e) continue;
      delete e.content; e.retractedAt = now; e.updatedAt = now; e.revision++; e.visibilityRevision = visibilityRevision;
      this.put("evidence", e);
      if (work.fenceObjects !== false) this.put("retraction", {
        id: objectRetractionId(e.sourceIdentity, e.object.kind, e.object.id), revision: visibilityRevision, at: now, reason });
    }
  }
  private retractUnderstandings(work: RetractionWork): void {
    const { now, reason, visibilityRevision, removed, understandings } = work;
    for (const u of this.list("understanding")) {
      if (!understandings.has(u.id) && ![...u.supportingRefs, ...u.opposingRefs].some(id => removed.has(id))) continue;
      if (reason === "forgotten") this.put("retraction", {
        id: this.understandingRetractionId(u.kind, u.scope, u.supportingRefs), revision: visibilityRevision, at: now, reason });
      understandings.add(u.id);
      u.supportingRefs = u.supportingRefs.filter(id => !removed.has(id)); u.opposingRefs = u.opposingRefs.filter(id => !removed.has(id));
      // Mixed-source conclusions need recomputation: old prose could retain forgotten content.
      u.value = ""; u.status = u.supportingRefs.length && !work.understandingIds?.includes(u.id) ? "needs-review" : "retracted";
      u.revision++; u.updatedAt = now; u.visibilityRevision = visibilityRevision; this.put("understanding", u);
    }
  }
  private retractPursuits(work: RetractionWork): void {
    const { now, visibilityRevision, removed, understandings, pursuits } = work;
    for (const p of this.list("pursuit")) {
      if (!p.evidenceRefs.some(id => removed.has(id)) && !p.understandingRefs.some(id => understandings.has(id))) continue;
      pursuits.add(p.id);
      p.evidenceRefs = p.evidenceRefs.filter(id => !removed.has(id));
      p.understandingRefs = p.understandingRefs.filter(id => !understandings.has(id));
      p.goal = ""; p.semanticKey = coreDigest(["withdrawn", p.id]); p.completionCriteria = [];
      delete p.nextStep; delete p.verification; p.artifactRefs = [];
      p.paused = true; p.status = p.evidenceRefs.length || p.understandingRefs.length ? "waiting" : "ended";
      p.waitReason = p.currentActor ? "source withdrawn; stop requested, execution unconfirmed" : "source withdrawn; requires new evidence";
      if (p.currentActor) p.currentActor.stopRequested = true;
      p.revision++; p.updatedAt = now; p.visibilityRevision = visibilityRevision; this.put("pursuit", p);
    }
  }
  private retractEphemeral(work: RetractionWork): void {
    const { removed, understandings, pursuits } = work;
    for (const c of this.list("candidate")) {
      if (pursuits.has(c.pursuitId) || c.evidenceRefs.some(id => removed.has(id))) this.delete("candidate", c.id);
    }
    for (const f of this.list("feedback")) {
      if (f.evidenceRefs.some(id => removed.has(id)) || understandings.has(f.targetId) || pursuits.has(f.targetId)) this.delete("feedback", f.id);
    }
    // Receipts hold snapshots; remove their copied prose while keeping key/digest replay fences.
    this.compactReceipts("9999-12-31T23:59:59.999Z", "forgotten");
  }
  updateSettings(expectedRevision: number, patch: Partial<Omit<CoreSettings, "revision" | "restoreBlocked">>): CoreSettings {
    const settings = this.settings();
    if (!Number.isSafeInteger(expectedRevision) || settings.revision !== expectedRevision) {
      throw new CoreError("CONFLICT", `Version mismatch: expected ${expectedRevision}, current ${settings.revision}`);
    }
    const permitted = ["enabled", "learningEnabled", "notifyEnabled", "timezone", "quietStart", "quietEnd", "eventRetentionDays", "diagnosticRetentionDays", "maxDatabaseBytes"];
    if (Object.keys(patch).some(k => !permitted.includes(k))) invalidInput("Unknown or privileged setting");
    const next = { ...settings, ...patch, revision: settings.revision + 1 };
    for (const key of ["enabled", "learningEnabled", "notifyEnabled"] as const) if (typeof next[key] !== "boolean") invalidInput("Invalid boolean setting");
    for (const key of ["eventRetentionDays", "diagnosticRetentionDays"] as const) if (!Number.isSafeInteger(next[key]) || next[key] < 1 || next[key] > 3650) invalidInput("Retention must be 1..3650 days");
    if (!Number.isSafeInteger(next.maxDatabaseBytes) || next.maxDatabaseBytes < 65536) invalidInput("Invalid storage high-water mark");
    try { new Intl.DateTimeFormat("en", { timeZone: next.timezone }); } catch (error) { throw new CoreError("INVALID_INPUT", `Invalid timezone: ${String(error)}`); }
    for (const v of [next.quietStart, next.quietEnd]) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) invalidInput("Invalid quiet hours");
    this.setSettings(next);
    if (!next.enabled && settings.enabled) for (const p of this.list("pursuit")) if (p.currentActor) { p.currentActor.stopRequested = true; p.revision++; this.put("pursuit", p); }
    return next;
  }
  private expireEvidence(now: string, settings: CoreSettings): number {
    let expired = 0;
    for (const e of this.list("evidence")) {
      if (e.expiredAt || e.retractedAt) continue;
      const days = e.diagnostic ? settings.diagnosticRetentionDays : settings.eventRetentionDays;
      if (Date.parse(e.receivedAt) + days * DAY > Date.parse(now)) continue;
      delete e.content; e.expiredAt = now; e.updatedAt = now; e.revision++; this.put("evidence", e); expired++;
    }
    return expired;
  }
  private reviewExpiredUnderstandings(now: string): void {
    for (const u of this.list("understanding")) {
      if (u.status === "retracted" || u.status === "needs-review") continue;
      const expired = u.expiresAt && u.expiresAt <= now || u.supportingRefs.some(id => this.get("evidence", id)?.expiredAt);
      if (!expired) continue;
      u.status = "needs-review"; u.revision++; u.updatedAt = now; this.put("understanding", u);
      this.invalidateUnderstanding(u.id, now);
    }
  }
  maintain(now: string) {
    const settings = this.settings(), expired = this.expireEvidence(now, settings);
    this.reviewExpiredUnderstandings(now);
    const before = new Date(Date.parse(now) - settings.eventRetentionDays * DAY).toISOString();
    for (const c of this.list("candidate")) if (c.state !== "pending" && c.updatedAt < before) this.delete("candidate", c.id);
    this.compactReceipts(before);
    const meta = this.meta();
    if (this.approximateBytes() >= settings.maxDatabaseBytes) {
      meta.degraded = "storage_high_water: ingestion stopped; retained goals and artifacts preserved";
    } else delete meta.degraded;
    this.setMeta(meta); return { expired, degraded: meta.degraded ?? null };
  }
  approximateBytes(): number {
    const pages = this.db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
    const free = this.db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
    const size = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 4096;
    return (pages - free) * size;
  }
}

export class CoreMindStore {
  readonly path: string;
  private readonly db: Database;
  private inTransaction = false;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Mind private directory must not be a symlink");
    this.path = join(resolve(directory), CORE_DATABASE_FILE);
    if (existsSync(this.path) && (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink())) throw new Error("Mind core database must be a regular file");
    this.db = new Database(this.path, { create: true, strict: true });
    chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
    // DELETE journal avoids a long-lived WAL copy of forgotten snippets. This is logical deletion, not forensic erasure.
    this.db.exec(`CREATE TABLE IF NOT EXISTS mind_meta(key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS mind_records(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS mind_receipts(subject TEXT NOT NULL, action_key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), at TEXT NOT NULL, PRIMARY KEY(subject,action_key));
      CREATE INDEX IF NOT EXISTS mind_receipts_at ON mind_receipts(at);`);
    const initialize = this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO mind_meta(key,data) VALUES('schema','1')").run();
      const schema = this.db.query<{ data: string }, []>("SELECT data FROM mind_meta WHERE key='schema'").get();
      if (schema?.data !== "1") throw new Error("Unsupported Mind core schema; refusing to reset private data");
      this.db.query("INSERT OR IGNORE INTO mind_meta(key,data) VALUES('meta',?)").run(canonical({ revision: 0, visibilityRevision: 0 }));
      this.db.query("INSERT OR IGNORE INTO mind_meta(key,data) VALUES('settings',?)").run(canonical(defaultCoreSettings()));
    });
    initialize.immediate();
  }
  private transaction<T>(write: boolean, fn: (tx: CoreTransaction) => T): T {
    if (this.inTransaction) throw new Error("Nested Mind core transactions are not supported");
    const work = this.db.transaction(() => {
      this.inTransaction = true;
      try {
        const tx = new CoreTransaction(this.db, write);
        const result = fn(tx);
        if (result && typeof result === "object" && "then" in result) throw new Error("Mind transaction callback must be synchronous");
        if (write) { const meta = tx.meta(); tx.setMeta({ ...meta, revision: meta.revision + 1 }); }
        return structuredClone(result);
      } finally { this.inTransaction = false; }
    });
    return write ? work.immediate() : work.deferred();
  }
  inspect<T>(fn: (tx: CoreTransaction) => T): T { return this.transaction(false, fn); }
  update<T>(fn: (tx: CoreTransaction) => T): T { return this.transaction(true, fn); }
  /** Diagnostic/runtime snapshot; normal bounded reads use service.context/overview. */
  read(): CoreState {
    return this.inspect(tx => ({ ...tx.meta(), settings: tx.settings(), evidence: tx.list("evidence"),
      understandings: tx.list("understanding"), pursuits: tx.list("pursuit"), checkpoints: tx.list("checkpoint"),
      retractions: tx.list("retraction"), candidates: tx.list("candidate"), actions: tx.list("action"), feedback: tx.list("feedback") }));
  }
  close(): void { this.db.close(); }
}
