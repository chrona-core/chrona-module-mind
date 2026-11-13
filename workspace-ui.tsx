import React, { useEffect, useRef, useState, useId, type ReactNode } from 'react';
// Bundled statically by Bun; local lifecycle typing avoids requiring another app's dev types.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require('react-dom/client') as { createRoot(host: HTMLElement): { render(node: ReactNode): void; unmount(): void } };
// Core and adapter projections evolve independently; narrow fields at their display/use sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
export type MindProps = {
    view?: 'overview' | 'understanding' | 'connections' | 'settings';
    title?: string;
};
export type MindContext = {
    props?: MindProps;
    call: (tool: string, args: Data) => Promise<unknown>;
};
const object = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): Data[] => Array.isArray(v) ? v.filter(object) : [];
const text = (v: unknown, fallback = ''): string => typeof v === 'string' ? v : fallback;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-CN') : '尚无记录';
const labels: Record<string, string> = { candidate: '待核对', active: '正在推进', watching: '持续留意', investigating: '正在调查', preparing: '正在准备', acting: '正在处理', verifying: '正在核对', waiting: '等待条件', 'waiting-user': '需要你决定', waiting_user: '需要你决定', paused: '已暂停', completed: '已核对完成', done: '已完成', ended: '已结束', invalidated: '依据已变化', uncertain: '仍不确定', inferred: '推断', explicit: '你明确说过', blocked: '受阻', available: '目录可用', unavailable: '不可用', unknown: '未知', healthy: '状态可用', degraded: '接入不完整', gap: '存在覆盖缺口' };
labels['needs-review'] = '需要核对';
class MindCallError extends Error {
    constructor(message: string, readonly definite = false) { super(message); }
}
const label = (v: unknown) => labels[text(v)] ?? text(v, '尚待核对');
export async function callMind(context: MindContext, tool: string, args: Data = {}): Promise<Data> {
    let response: unknown;
    try {
        response = await context.call(tool, args);
    }
    catch (e) {
        if (object(e) && ['INVALID_INPUT', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'CAPACITY', 'RESTORE_BLOCKED', 'invalid', 'forbidden', 'conflict', 'not_found', 'capacity'].includes(e.code))
            throw new MindCallError(text(e.message, e.code), true);
        throw e;
    }
    if (!object(response) || typeof response.json !== 'string')
        throw Error('Mind 返回格式无效，请刷新后核对');
    const value: unknown = JSON.parse(response.json);
    if (!object(value))
        throw Error('Mind 返回内容无效');
    if (value.error)
        throw new MindCallError(object(value.error) ? text(value.error.message, text(value.error.code, '操作失败')) : String(value.error), ['INVALID_INPUT', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'CAPACITY', 'RESTORE_BLOCKED', 'invalid', 'forbidden', 'conflict', 'not_found', 'capacity'].includes(text(value.error.code)));
    return value;
}
// The shared Web Markdown subset, rendered as React text nodes: raw HTML never executes.
function Inline({ value }: {
    value: string;
}) {
    const parts = value.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g);
    return <>{parts.map((part, i) => {
            if (part.startsWith('`'))
                return <code key={i}>{part.slice(1, -1)}</code>;
            if (part.startsWith('**'))
                return <strong key={i}>{part.slice(2, -2)}</strong>;
            const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
            if (link && /^(https?:\/\/|\/(?!\/)|#)/i.test(link[2]!))
                return <a key={i} href={link[2]} rel="noopener noreferrer">{link[1]}</a>;
            return <React.Fragment key={i}>{part}</React.Fragment>;
        })}</>;
}
export function ResultText({ value, plain = false }: {
    value: string;
    plain?: boolean;
}) {
    if (plain)
        return <pre className="mind-plain">{value}</pre>;
    const blocks: ReactNode[] = [];
    let code: string[] | null = null;
    for (const [i, line] of value.split('\n').entries()) {
        if (/^\s*```/.test(line)) {
            if (code) {
                blocks.push(<pre key={i}><code>{code.join('\n')}</code></pre>);
                code = null;
            }
            else
                code = [];
            continue;
        }
        if (code) {
            code.push(line);
            continue;
        }
        const heading = /^#{1,6}\s+(.+)$/.exec(line), bullet = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
        if (heading)
            blocks.push(<h4 key={i}><Inline value={heading[1]!}/></h4>);
        else if (bullet)
            blocks.push(<ul key={i}><li><Inline value={bullet[1]!}/></li></ul>);
        else if (line.trim())
            blocks.push(<p key={i}><Inline value={line}/></p>);
    }
    if (code)
        blocks.push(<pre key="open-fence"><code>{code.join('\n')}</code></pre>);
    return <div className="mind-markdown">{blocks}</div>;
}
function Empty({ children }: {
    children: ReactNode;
}) { return <div className="mind-empty">{children}</div>; }
function Evidence({ items }: {
    items: Data[];
}) {
    return <div className="mind-evidence">{items.length ? items.map((e, i) => <blockquote key={e.id ?? i}><p>{text(e.content?.text, text(e.text, text(e.boundedContent, '来源内容未提供')))}</p><footer>{text(e.sourceIdentity, text(e.source, '来源'))} · {text(e.object?.id, text(e.objectRef?.id, text(e.objectRef)))} · {date(e.occurredAt ?? e.receivedAt)}{e.retractedAt ? ' · 已撤回' : ''}{e.content?.truncated ? ' · 内容已截断' : ''}</footer></blockquote>) : <p className="mind-muted">尚无可展示的依据；这不代表已确认。</p>}</div>;
}
export function MindWorkspace({ context }: {
    context: MindContext;
}) {
    const [view, setView] = useState<MindProps['view']>(context.props?.view ?? 'overview');
    const [overview, setOverview] = useState<Data | null>(null), [understanding, setUnderstanding] = useState<Data | null>(null), [settings, setSettings] = useState<Data | null>(null);
    const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Data | null>(null), [detail, setDetail] = useState<Data | null>(null), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
    const [inputMode, setInputMode] = useState<'pursue' | 'remember'>('pursue');
    const [input, setInput] = useState(''), [plain, setPlain] = useState(false), [forget, setForget] = useState<Data | null>(null);
    const [settingsDraft, setSettingsDraft] = useState<Data | null>(null), [settingsError, setSettingsError] = useState('');
    const [restoreReviewed,setRestoreReviewed]=useState(false);
    const [query, setQuery] = useState(''), [projectScope, setProjectScope] = useState(''), [sessionScope, setSessionScope] = useState(''), [contextError, setContextError] = useState(''), [contextLoading, setContextLoading] = useState(false);
    const inputId = useId(), forgetTitleId = useId();
    const dialogRef = useRef<HTMLElement>(null), previousFocus = useRef<HTMLElement | null>(null);
    const pending = useRef<{
        tool: string;
        args: Data;
        success: string;
        done?: (result: Data) => void;
    } | null>(null);
    const [uncertain, setUncertain] = useState(false);
    useEffect(() => {
        if (!forget)
            return;
        previousFocus.current = document.activeElement as HTMLElement;
        const siblings = Array.from(dialogRef.current?.parentElement?.parentElement?.children ?? []).filter(e => e !== dialogRef.current?.parentElement) as HTMLElement[];
        const states = siblings.map(e => e.inert);
        siblings.forEach(e => { e.inert = true; });
        dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
        return () => { siblings.forEach((e, i) => { e.inert = states[i]!; }); previousFocus.current?.focus(); };
    }, [forget]);
    const alive = useRef(true), generation = useRef(0), detailGeneration = useRef(0), writeLock = useRef(false), contextRef = useRef(context), contextGeneration = useRef(0);
    contextRef.current = context;
    useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; detailGeneration.current++; }; }, []);
    useEffect(() => { if (context.props?.view)
        setView(context.props.view); }, [context.props?.view]);
    const api = (tool: string, args: Data = {}) => callMind(contextRef.current, tool, args);
    function report(e: unknown, event: string) { console.error(JSON.stringify({ component: 'mind-workspace', event, error: { name: e instanceof Error ? e.name : 'UnknownError', message: errorText(e).slice(0, 512) } })); }
    async function load(after?: string) {
        const current = ++generation.current;
        setLoading(true);
        setError('');
        try {
            const result = await api('overview', after ? { after } : {});
            if (alive.current && current === generation.current)
                setOverview(previous => after && previous ? { ...result, items: [...list(previous.items), ...list(result.items)] } : result);
        }
        catch (e) {
            report(e, 'overview-failed');
            if (alive.current && current === generation.current)
                setError(errorText(e));
        }
        finally {
            if (alive.current && current === generation.current)
                setLoading(false);
        }
    }
    async function loadSettings() {
        setSettingsError('');
        try {
            const result = await api('settings');
            if (alive.current) {
                const value = object(result.settings) ? { ...result.settings, revision: result.revision ?? result.settings.revision } : result;
                setSettings(value);
                setSettingsDraft(value);
            }
        }
        catch (e) {
            report(e, 'settings-failed');
            if (alive.current)
                setSettingsError(errorText(e));
        }
    }
    async function loadUnderstanding(search = '') {
        const requestGeneration = ++contextGeneration.current;
        setContextError('');
        setContextLoading(true);
        try {
            const result = await api('context', { query: search, scope: { ...(projectScope.trim() ? { projectId: projectScope.trim() } : {}), ...(sessionScope.trim() ? { sessionId: sessionScope.trim() } : {}) }, limit: 50, maxBytes: 32768 });
            if (alive.current && requestGeneration === contextGeneration.current)
                setUnderstanding(result);
        }
        catch (e) {
            report(e, 'context-failed');
            if (alive.current && requestGeneration === contextGeneration.current)
                setContextError(errorText(e));
        }
        finally {
            if (alive.current && requestGeneration === contextGeneration.current)
                setContextLoading(false);
        }
    }
    useEffect(() => { void load(); }, []);
    useEffect(() => { if (view === 'settings' && !settings)
        void loadSettings(); if ((view === 'understanding' || view === 'connections') && !understanding)
        void loadUnderstanding(); }, [view]);
    async function open(item: Data, kind = 'pursuit') {
        const current = ++detailGeneration.current;
        setSelected({ ...item, kind });
        setDetail(null);
        setDetailError('');
        setDetailLoading(true);
        try {
            let result = await api('detail', { id: item.id });
            const record = result.pursuit ?? result.understanding ?? result.item ?? result;
            if (!Array.isArray(result.evidence)) {
                const refs = [...new Set<string>([...(record.evidenceRefs ?? []), ...(record.supportingRefs ?? []), ...(record.opposingRefs ?? [])])];
                const replies = await Promise.allSettled(refs.slice(0, 12).map(id => api('detail', { id })));
                const evidence = replies.flatMap(r => r.status === 'fulfilled' ? [r.value.evidence ?? r.value] : []);
                const failed = replies.filter(r => r.status === 'rejected').length;
                if (failed)
                    report(new Error('EvidenceReadFailed'), 'evidence-read-failed');
                result = { item: record, ...result, evidence, unknowns: [...(result.unknowns ?? []), ...(failed ? [`${failed} 条依据暂时无法读取，可重试详情。`] : []), ...(refs.length > 12 ? ['仅展示前 12 条依据，其他依据尚未补读。'] : [])] };
            }
            if (alive.current && current === detailGeneration.current)
                setDetail(result);
        }
        catch (e) {
            report(e, 'detail-failed');
            if (alive.current && current === detailGeneration.current)
                setDetailError(errorText(e));
        }
        finally {
            if (alive.current && current === detailGeneration.current)
                setDetailLoading(false);
        }
    }
    async function sendPending() {
        if (writeLock.current || !pending.current)
            return;
        const request = pending.current;
        writeLock.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            const result = await api(request.tool, request.args);
            if (!alive.current)
                return;
            pending.current = null;
            setUncertain(false);
            if (result.outcome && result.outcome !== 'applied') {
                setNotice('原请求已有回执，但相关内容已清理或压缩。请查看最新结果，不会重新执行。');
            }
            else {
                const receiptValue = result.value ?? result;
                const cleanup = receiptValue.cleanup;
                setNotice(cleanup ? `Mind 内清理：${cleanup.mind === 'complete' ? '已完成' : '待核对'}；外部内容：未请求清理；原执行：仍需核对停止。` : text(result.message, request.success));
                request.done?.(result);
            }
            await load();
        }
        catch (e) {
            report(e, `${request.tool}-failed`);
            if (e instanceof MindCallError && e.definite) {
                pending.current = null;
                setUncertain(false);
            }
            else
                setUncertain(true);
            if (alive.current)
                setError(`${errorText(e)}。输入已保留；请核对最新状态。结果不明时只能重试同一请求。`);
        }
        finally {
            writeLock.current = false;
            if (alive.current)
                setBusy(false);
        }
    }
    async function write(tool: string, payload: Data, success: string, done?: (result: Data) => void, exactArgs = false) {
        if (writeLock.current || pending.current)
            return;
        if (!exactArgs && typeof overview?.visibilityRevision !== 'number') {
            setError('缺少最新撤回版本，请先刷新核对。');
            return;
        }
        pending.current = { tool, args: exactArgs ? payload : { input: JSON.stringify({ actionKey: crypto.randomUUID(), expectedVisibilityRevision: overview?.visibilityRevision, ...payload }) }, success, done };
        await sendPending();
    }
    const pursuits = list(overview?.pursuits ?? overview?.items).filter(p => typeof p.goal === 'string');
    const decisions = list(overview?.decisions ?? overview?.needsDecision ?? overview?.needsYou).length ? list(overview?.decisions ?? overview?.needsDecision ?? overview?.needsYou) : pursuits.filter(p => ['waiting-user', 'waiting_user'].includes(p.status) || p.needsDecision === true || p.waitReason === 'user');
    const results = list(overview?.results ?? overview?.completed).length ? list(overview?.results ?? overview?.completed) : pursuits.filter(p => ['completed', 'done'].includes(p.status));
    const ongoing = pursuits.filter(p => !decisions.some(d => d.id === p.id) && !results.some(r => r.id === p.id) && !['ended', 'dropped'].includes(p.status));
    const understandings = [...new Map([...list(overview?.understandings ?? overview?.items), ...list(understanding?.understandings)].filter(u => typeof u.value === 'string').map(u => [u.id, u])).values()].filter(u => u.value && u.status !== 'retracted' && (!query.trim() || u.value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (!projectScope.trim() || u.scope?.projectId === projectScope.trim()) && (!sessionScope.trim() || u.scope?.sessionId === sessionScope.trim()));
    const sources = list(overview?.sources ?? overview?.coverage?.sources ?? understanding?.checkpoints ?? understanding?.coverage);
    const currentItem = detail?.pursuit ?? detail?.understanding ?? detail?.item ?? (detail?.id ? detail : selected);
    const evidence = list(detail?.evidence ?? detail?.evidences ?? currentItem?.evidence);
    function control(action: string) { if (currentItem)
        void write('control', { id: currentItem.id, kind: selected?.kind ?? 'pursuit', operation: action, expectedRevision: currentItem.revision, ...(action === 'correct' ? selected?.kind === 'pursuit' ? { value: `${text(currentItem.goal)}\n补充要求：${input.trim()}`, completionCriteria: [...(Array.isArray(currentItem.completionCriteria) ? currentItem.completionCriteria : [text(currentItem.goal)]), input.trim()] } : { value: input.trim() } : {}) }, '已提交变更；停止状态以最新核对为准。', () => { if (action === 'correct') {
            setInput('');
            contextGeneration.current++;
            setUnderstanding(null);
            void loadUnderstanding(query);
        } setSelected(null); setDetail(null); }); }
    function submit() {
        if (!input.trim())
            return;
        if (selected) {
            control('correct');
            return;
        }
        if (inputMode === 'remember') {
            void write('remember', { expectedRevision: 0, kind: 'preference', value: input.trim(), scope: {}, explicitness: 'explicit', supportingRefs: [], opposingRefs: [] }, '已保存这条明确理解，可在“对你的理解”中核对和纠正。', () => { setInput(''); contextGeneration.current++; setUnderstanding(null); if (view === 'understanding' || view === 'connections') void loadUnderstanding(query); });
            return;
        }
        void write('pursue', { goal: input.trim(), semanticKey: `owner:${crypto.randomUUID()}`, completionCriteria: [input.trim()], scope: {}, expectedRevision: 0, evidenceRefs: [], understandingRefs: [], reason: 'explicit-goal' }, '已保存，后续进展将在这里显示。', () => setInput(''));
    }
    function refresh() { void load(); if (view === 'understanding' || view === 'connections')
        void loadUnderstanding(query); if (view === 'settings')
        void loadSettings(); if (selected)
        void open(selected, selected.kind); }
    function cards(items: Data[], tone: string) {
        return <div className="mind-cards">{items.map(item => <article className={`mind-card ${tone}`} key={item.id}><div className="mind-card-top"><span className="mind-tag">{item.paused === true ? '已暂停' : label(item.status)}</span>{item.nextCheckAt && <span className="mind-muted">{date(item.nextCheckAt)}</span>}</div><h3><button className="mind-title-button" onClick={() => void open(item)}>{text(item.title, text(item.goal, '查看事项'))}</button></h3>{(item.summary ?? item.result ?? item.currentResult) && <ResultText value={text(item.summary, text(item.result, text(item.currentResult)))} plain={plain}/>}{item.waitReason && <p className="mind-blocker">{text(item.waitReason)}</p>}{item.nextStep && <p><span className="mind-muted">接下来 </span>{text(item.nextStep)}</p>}{item.verification && <p className="mind-muted">核对：{text(item.verification.summary, text(item.verification.method, text(item.verification.status, text(item.verification))))}</p>}<button className="mind-link" onClick={() => void open(item)}>查看成果与依据 <span aria-hidden="true">↗</span></button></article>)}</div>;
    }
    function settingField(name: string, title: string, type: 'number' | 'text' | 'time' = 'number') {
        return <label className="mind-field">{title}<input type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 1 : undefined} value={settingsDraft?.[name] ?? ''} onChange={e => setSettingsDraft({ ...settingsDraft, [name]: type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}/></label>;
    }
    return <div className="mind-workspace">
    <header className="mind-header"><div><div className="mind-eyebrow">持续理解 · 主动推进</div><h1>{context.props?.title ?? 'Mind'}</h1><p>正在替你留意和推进</p></div><div className="mind-header-actions"><button disabled={loading || busy} onClick={refresh}>刷新</button><button className="mind-primary" disabled={busy || loading || !overview} onClick={() => void write('check', {}, '已请求核对，结果以实际进展为准。', undefined, true)}>现在核对</button></div></header>
    <nav className="mind-tabs" aria-label="Mind 页面">{([['overview', '概览'], ['understanding', '对你的理解'], ['connections', '接入与自主范围'], ['settings', '设置']] as const).map(([id, name]) => <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{name}</button>)}</nav>
    <div className="mind-content">{overview?.recovery?.blocked && <section role="alert" className="mind-alert"><h2>恢复数据需要你核对</h2><p>Mind 已暂停学习与后台行动。这份备份可能早于后来执行的遗忘请求，旧内容可能重新出现。先查看并清理不再允许保留的理解和依据，再决定是否重新授权。</p><p>这里只能核对 Chrona 支持的备份恢复；手工覆盖整个数据目录无法可靠检测。</p><label className="mind-toggle"><input type="checkbox" checked={restoreReviewed} onChange={e=>setRestoreReviewed(e.target.checked)}/>我已核对这份恢复的数据，允许 Mind 重新使用其中保留的内容</label><button disabled={!restoreReviewed||busy||uncertain||!overview.recovery.restoreId} onClick={()=>void write('recovery',{restoreId:overview.recovery.restoreId,decision:'authorize-restored-memory'},'已重新授权这份恢复的数据。',()=>setRestoreReviewed(false))}>重新授权并恢复工作</button></section>}{error && <div role="alert" className="mind-alert"><p>{error}</p><button disabled={loading} onClick={refresh}>刷新核对</button></div>}{uncertain && <div className="mind-alert" role="status"><p>上一请求的结果尚不确定。核对或重试原请求后才能继续修改。</p><button disabled={busy} onClick={() => void sendPending()}>重试原请求</button></div>}{overview?.degraded && <p className="mind-blocker">{text(overview.degraded)}</p>}{notice && <p className="mind-notice" role="status">{notice}</p>}{loading && <p role="status" className="mind-loading">正在读取 Mind 的最新进展…</p>}
    {view === 'overview' && <>
      <div className="mind-section-heading"><div><h2>此刻，值得你看见的</h2><p className="mind-muted">先看成果与待决定事项，再了解每件事的来龙去脉。</p></div><label className="mind-toggle"><input type="checkbox" checked={plain} onChange={e => setPlain(e.target.checked)}/>纯文本</label></div>
      {!loading && overview && !decisions.length && !ongoing.length && !results.length && <Empty><h3>还没有值得持续推进的事</h3><p>正常使用 Chrona，或在下方交代一件希望继续跟进的事。</p><p>学习范围和来源同步状态可在“接入与自主范围”查看。</p><button onClick={() => setView('connections')}>查看当前接入范围</button></Empty>}
      {!!decisions.length && <section aria-label="需要你决定"><h2>需要你决定 <span className="mind-count">{decisions.length}</span></h2>{cards(decisions, 'mind-decision')}</section>}
      {!!ongoing.length && <section aria-label="正在推进"><h2>正在推进 <span className="mind-count">{ongoing.length}</span></h2>{cards(ongoing, '')}</section>}
      {!!results.length && <section aria-label="已经帮你做成"><h2>已经帮你做成 <span className="mind-count">{results.length}</span></h2>{cards(results, 'mind-result')}</section>}
      {(overview?.limited || overview?.hasMore || overview?.nextCursor || overview?.next) && <p className="mind-muted">当前为有界结果，仍有更多内容。可通过具体事项或理解搜索继续查看。{overview?.next && <button disabled={loading} onClick={() => void load(overview.next)}>加载更多</button>}</p>}
    </>}
    {view === 'understanding' && <section><div className="mind-section-heading"><div><h2>有依据，才形成理解</h2><p className="mind-muted">区分你明确说过的内容与仍待核对的推断，随时纠正或忘记。</p></div></div><form className="mind-search" onSubmit={e => { e.preventDefault(); void loadUnderstanding(query); }}><input aria-label="搜索理解" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索目标、偏好或项目…"/><input aria-label="项目范围" value={projectScope} onChange={e => setProjectScope(e.target.value)} placeholder="项目 ID（可选）"/><input aria-label="会话范围" value={sessionScope} onChange={e => setSessionScope(e.target.value)} placeholder="会话 ID（可选）"/><button>搜索</button></form><p className="mind-muted">列表合并当前概览与所选范围的查询；内容有界，查找其他项目或会话请填写范围。</p>{contextLoading && <p role="status">正在读取相关理解…</p>}{contextError && <div role="alert"><p>{contextError}</p><button onClick={() => void loadUnderstanding(query)}>重试读取理解</button></div>}{understanding?.truncated && <p className="mind-muted">当前理解已按范围和大小截断，可缩小搜索继续查看。</p>}{understanding && !understandings.length && <Empty>目前没有可展示的理解。学习尚未形成可靠依据时，这里会保持为空。</Empty>}<div className="mind-cards">{understandings.map(item => <article className="mind-card" key={item.id}><div className="mind-card-top"><span className="mind-tag">{label(item.explicitness)}</span><span className="mind-muted">{item.paused === true ? '已暂停' : label(item.status)}</span></div><h3>{text(item.value, text(item.summary))}</h3><p className="mind-muted">适用范围：{item.scope?.projectId ? `项目 ${item.scope.projectId}` : item.scope?.sessionId ? '此会话' : '全局'}</p><div className="mind-actions"><button onClick={() => void open(item, 'understanding')}>依据与纠正</button><button onClick={() => setForget({ ...item, kind: 'understanding' })}>忘记这条理解</button></div></article>)}</div></section>}
    {view === 'connections' && <section><h2>接入与自主范围</h2><p className="mind-muted">只展示真实接入和核对结果；应用已启用不代表模型实际调用成功。</p><div className="mind-cards"><article className="mind-card"><h3>学习范围</h3><p>{overview?.settings?.learningEnabled === false || settings?.learningEnabled === false ? '学习已暂停' : overview?.settings?.learningEnabled === true || settings?.learningEnabled === true ? '从获准的已发送内容学习' : '学习状态尚待确认'}</p><p>原始对话由 Chat 保存。未发送草稿、剪贴板和私有凭据不属于学习来源。</p><button onClick={() => setView('settings')}>调整学习与自主范围</button></article><article className="mind-card"><h3>能力与接入健康</h3><p>{text(overview?.health?.summary, '尚无真实调用验证记录')}</p>{overview?.health?.lastVerifiedAt && <p>最近验证：{date(overview.health.lastVerifiedAt)}</p>}{overview?.health?.lastCheckAt && <p>最近检查：{date(overview.health.lastCheckAt)}</p>}{overview?.health?.current?.stopRequested && !overview?.health?.current?.stopConfirmed && <p className="mind-blocker">已请求停止，原执行尚未确认停止。</p>}{overview?.health?.error && <p className="mind-blocker">{text(overview.health.error)}</p>}<p className="mind-muted">没有可靠计量时，费用与 token 消耗为未知。</p></article></div><h3>来源覆盖</h3>{contextLoading && <p role="status">正在读取来源同步信息…</p>}{contextError && <div role="alert"><p>{contextError}</p><button onClick={() => void loadUnderstanding()}>重试来源读取</button></div>}{!sources.length && <Empty>尚无可展示的来源同步信息。来源未接入与“没有新变化”会分别报告。</Empty>}{sources.map((source, i) => <article className="mind-card" key={source.id ?? i}><h3>{text(source.name, text(source.sourceIdentity, text(source.moduleId, '来源')))}</h3><p>{source.status ? label(source.status) : '已记录同步水位'} · 最近同步：{date(source.lastSyncedAt ?? source.capturedAt ?? source.updatedAt)}</p><p>{source.coverage?.complete === true ? '当前声明范围完整' : '覆盖范围尚不完整或未确认'}</p>{(source.gap ?? source.coverage?.gap) && <p className="mind-blocker">{text(source.gap, text(source.coverage?.gap))}</p>}</article>)}<details><summary>实际自主范围与限制</summary><p>{text(overview?.autonomy?.summary, '自主范围尚未由服务提供。设置不会授予新的应用权限。')}</p><p>暂停先阻止新动作；正在执行的动作须核对停止。Mind 的遗忘不自动清理 Chat、Provider 历史和已产生的外部效果。</p></details></section>}
    {view === 'settings' && <section><h2>让 Mind 按你的节奏工作</h2>{settingsError && <div role="alert" className="mind-alert"><p>{settingsError}</p><button onClick={() => void loadSettings()}>重试读取设置</button></div>}{!settingsDraft && !settingsError && <p role="status">正在读取设置…</p>}{settingsDraft && <form className="mind-settings" onSubmit={e => { e.preventDefault(); const revision = settingsDraft.revision; const patch = Object.fromEntries(Object.entries(settingsDraft).filter(([key, value]) => key !== 'revision' && key !== 'restoreBlocked' && settings?.[key] !== value)); if (!Object.keys(patch).length) {
        setNotice('设置没有变化。');
        return;
    } void write('settings', { patch: JSON.stringify(patch), revision }, '设置已保存。', () => { void loadSettings(); }, true); }}><fieldset disabled={busy}><legend>学习与主动推进</legend><label className="mind-toggle"><input type="checkbox" checked={settingsDraft.learningEnabled === true} onChange={e => setSettingsDraft({ ...settingsDraft, learningEnabled: e.target.checked })}/>从获准的已发送内容学习</label><label className="mind-toggle"><input type="checkbox" checked={settingsDraft.enabled === true} onChange={e => setSettingsDraft({ ...settingsDraft, enabled: e.target.checked })}/>允许后台持续推进</label><p className="mind-muted">学习范围来自来源应用的批准设置；开启此项不会扩大权限或回扫全部历史。</p></fieldset><fieldset disabled={busy}><legend>后台预算</legend>{typeof overview?.budget?.limit === 'number' && <p>今日后台启动：{overview.budget.starts ?? '未知'} / {overview.budget.limit}；新机会调查：{overview.budget.opportunities ?? '未知'} / {overview.budget.opportunityLimit ?? '未知'}</p>}{typeof settingsDraft.dailyRunLimit === 'number' ? settingField('dailyRunLimit', '每日后台启动上限') : <p>每日后台启动上限：服务尚未提供可修改的预算。</p>}{typeof settingsDraft.dailyOpportunityLimit === 'number' && settingField('dailyOpportunityLimit', '其中新机会调查上限')}<p className="mind-muted">实际费用与 token：{text(overview?.budget?.summary, '未知；无可靠计量时不显示为 0')}。启动和时长限制不等于费用硬上限。</p></fieldset><fieldset disabled={busy}><legend>通知与安静时段</legend><label className="mind-toggle"><input type="checkbox" checked={settingsDraft.notifyEnabled === true} onChange={e => setSettingsDraft({ ...settingsDraft, notifyEnabled: e.target.checked })}/>启用外部通知</label>{typeof settingsDraft.dailyNotificationLimit === 'number' && settingField('dailyNotificationLimit', '每日即时通知上限')}{settingField('quietStart', '安静时段开始', 'time')}{settingField('quietEnd', '安静时段结束', 'time')}{settingField('timezone', '时区', 'text')}<p className="mind-muted">关闭外部通知后，网页仍可查看成果。通知渠道须已接入并可用。</p></fieldset><div className="mind-actions"><button className="mind-primary" disabled={busy || uncertain || typeof settings?.revision !== 'number'}>保存设置</button><button type="button" disabled={busy} onClick={() => void loadSettings()}>重新读取</button></div></form>}</section>}
    </div>
    {selected && <section className="mind-detail" aria-label="事项详情"><div className="mind-section-heading"><h2>{text(currentItem?.goal, text(currentItem?.value, text(currentItem?.title, '事项详情')))}</h2><button aria-label="关闭详情" onClick={() => { detailGeneration.current++; setSelected(null); setDetail(null); }}>关闭</button></div>{detailLoading && <p role="status">正在读取成果与依据…</p>}{detailError && <div role="alert"><p>{detailError}</p><button onClick={() => void open(selected, selected.kind)}>重试读取详情</button></div>}{detail && <><p className="mind-tag">{currentItem?.paused ? '已暂停' : label(currentItem?.status)}</p>{(currentItem?.summary ?? currentItem?.result) && <ResultText value={text(currentItem?.summary, text(currentItem?.result))} plain={plain}/>}{currentItem?.currentActor?.stopRequested && <p className="mind-blocker">已请求停止，原执行尚待核对；仍可能产生外部效果。</p>}<h3>成果</h3>{Array.isArray(currentItem?.artifactRefs) && currentItem.artifactRefs.map((ref: string) => <p className="mind-muted" key={ref}>成果引用：<code>{ref}</code>（内容须由服务补读核对）</p>)}{!list(detail.artifacts ?? currentItem?.artifacts).length && <p className="mind-muted">尚无可打开的成果，未核对内容不作为完成。</p>}{list(detail.artifacts ?? currentItem?.artifacts).map((a, i) => <article className="mind-artifact" key={a.id ?? i}><h4>{text(a.title, text(a.name, '成果'))}</h4><ResultText value={text(a.body, text(a.content?.text, text(a.content, text(a.text))))} plain={plain || a.format === 'text'}/>{a.url && /^(https?:\/\/|\/(?!\/))/.test(a.url) && <a href={a.url} rel="noopener noreferrer">打开成果</a>}<p className="mind-muted">{text(a.verification?.summary, text(a.status, '验证范围尚未提供'))}</p></article>)}<h3>依据与未知点</h3><Evidence items={evidence}/>{evidence.map(e => <button className="mind-link" key={e.id} disabled={busy || uncertain} onClick={() => setForget({ ...e, kind: 'evidence' })}>忘记依据 {e.id}</button>)}{currentItem?.nextStep && <p>下一步：{text(currentItem.nextStep)}</p>}{currentItem?.waitReason && <p className="mind-blocker">{text(currentItem.waitReason)}</p>}{Array.isArray(detail.unknowns) && detail.unknowns.map((u: unknown, i: number) => <p key={i}>{text(u, object(u) ? text(u.message) : '')}</p>)}<div className="mind-actions">{selected.kind === 'pursuit' && <><button disabled={busy || uncertain || detailLoading || typeof currentItem?.revision !== 'number'} onClick={() => control(currentItem?.paused ? 'resume' : 'pause')}>{currentItem?.paused ? '恢复推进' : '暂停推进'}</button><button disabled={busy || uncertain || typeof currentItem?.revision !== 'number'} onClick={() => control('end')}>结束这件事</button></>}<button disabled={busy || uncertain || typeof currentItem?.revision !== 'number'} onClick={() => void write('feedback', { targetId: currentItem?.id, targetKind: selected.kind, scope: currentItem?.scope ?? {}, value: 'useful', expectedRevision: currentItem?.revision }, '谢谢，已记录这条明确反馈。', () => void open(currentItem, selected.kind))}>有帮助</button><button disabled={busy || uncertain || typeof currentItem?.revision !== 'number'} onClick={() => void write('feedback', { targetId: currentItem?.id, targetKind: selected.kind, scope: currentItem?.scope ?? {}, value: 'not-useful', expectedRevision: currentItem?.revision }, '已记录，将用于调整后续跟进。', () => void open(currentItem, selected.kind))}>没有帮助</button>{selected.kind === 'understanding' && <button disabled={busy || uncertain} onClick={() => setForget({ ...currentItem, kind: 'understanding' })}>忘记这条理解</button>}</div></>}</section>}
    <form className="mind-composer" onSubmit={e => { e.preventDefault(); submit(); }}><label htmlFor={inputId}>{selected ? '补充、纠正，或告诉我接下来怎么做' : '有什么希望我继续留意？'}</label>{!selected && <label className="mind-input-mode">用途 <select aria-label="补充用途" value={inputMode} onChange={e => setInputMode(e.target.value as 'pursue' | 'remember')}><option value="pursue">持续跟进</option><option value="remember">记住这条理解</option></select></label>}<textarea id={inputId} rows={2} value={input} onChange={e => setInput(e.target.value)} placeholder={selected ? '例如：改到下周，预算控制在 500 元以内…' : '例如：这周继续帮我整理研究资料，结果保存在本地…'} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
    } }}/><div><span className="mind-muted">{busy ? '正在提交，请稍候…' : 'Ctrl / ⌘ + Enter 提交'}</span><button className="mind-primary" disabled={busy || uncertain || loading || typeof overview?.visibilityRevision !== 'number' || !input.trim() || (selected !== null && (!detail || detailLoading))}>{selected ? '补充这件事' : inputMode === 'remember' ? '保存理解' : '交给 Mind'}</button></div></form>
    {forget && <div className="mind-dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby={forgetTitleId} ref={dialogRef} className="mind-dialog" onKeyDown={e => { if (e.key === 'Escape' && !busy)
        setForget(null); if (e.key === 'Tab') {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
        }
        else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
        }
    } }}><h2 id={forgetTitleId}>忘记这部分内容？</h2><p>{text(forget.value, text(forget.goal, text(forget.title)))}</p><p>将清理 Mind 内的相关内容、派生理解与未来行动。其他独立依据仍支持的理解可能保留。</p><p>不会自动删除原始 Chat 对话、Provider 历史或已发送的外部消息。正在执行的动作仍须核对停止。</p><div className="mind-actions"><button disabled={busy} onClick={() => setForget(null)}>取消</button><button className="mind-danger" disabled={busy || uncertain} onClick={() => void write('forget', { target: { kind: forget.kind, id: forget.id } }, '已提交遗忘；具体清理与停止范围以服务回执为准。', () => { contextGeneration.current++; detailGeneration.current++; generation.current++; setOverview(null); setUnderstanding(null); setDetail(null); setContextLoading(false); setForget(null); setSelected(null); if (view === 'understanding' || view === 'connections')
        void loadUnderstanding(query); })}>确认忘记</button></div></section></div>}
  </div>;
}
export default function mount(element: HTMLElement, context: MindContext) {
    const host = document.createElement('div');
    host.className = 'mind-root';
    element.append(host);
    const root = createRoot(host);
    let destroyed = false;
    root.render(<MindWorkspace context={context}/>);
    return { update(next: MindContext) { if (!destroyed)
            root.render(<MindWorkspace context={next}/>); }, destroy() { if (!destroyed) {
            destroyed = true;
            root.unmount();
            host.remove();
        } } };
}
