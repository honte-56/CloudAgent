import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, RefreshCw, X } from 'lucide-react';
import { api, readApiJson } from '@/shared/api';
import type { DiffLine, Project, TaskProgressSnapshot } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { SubagentTimeline } from '@/modules/chat/tools/SubagentTimeline';
import PermissionContext from '@/modules/chat/context/PermissionContext';

type Props = {
  sessionId: string;
  toolUseId: string;
  title: string;
  selectedProject: Project;
  createDiff: (before: string, after: string) => DiffLine[];
  onClose: () => void;
};

/** ChatInterface's read-only right panel: polls the existing task's records without navigating or creating another runtime. */
export const TaskProgressPanel = memo(({ sessionId, toolUseId, title, selectedProject, createDiff, onClose }: Props) => {
  // Keep the last successful snapshot visible throughout refreshes and temporary disconnects.
  const [snapshot, setSnapshot] = useState<TaskProgressSnapshot | null>(null);
  // A failed refresh is shown alongside the retained snapshot until recovery.
  const [error, setError] = useState('');
  // Indicates request activity separately from whether the underlying task is running.
  const [refreshing, setRefreshing] = useState(false);
  // Workflow selection and history window belong only to this open panel.
  const [agentId, setAgentId] = useState<string | undefined>();
  // Bound the timeline payload while allowing older entries to be requested.
  const [limit, setLimit] = useState(100);
  // Scrolling upward suspends follow mode until the user explicitly returns to the latest rows.
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<() => void>(() => {});
  const messages = useMemo(() => normalizedToChatMessages(snapshot?.messages ?? []), [snapshot?.messages]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    let stopped = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (stopped || inFlight) return;
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') { timer = setTimeout(() => void refresh(), 2000); return; }
      inFlight = true; controller = new AbortController(); setRefreshing(true);
      const deadline = setTimeout(() => controller?.abort(), 15000);
      try {
        const response = await api.providers.taskProgress(sessionId, toolUseId, { agentId, limit }, { signal: controller.signal });
        const result = await readApiJson<{ data: TaskProgressSnapshot }>(response);
        if (!stopped) { setSnapshot(result.data); setError(''); }
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error && caught.name !== 'AbortError' ? caught.message : '读取进展超时，稍后自动重试。');
      } finally {
        clearTimeout(deadline); inFlight = false;
        if (!stopped) { setRefreshing(false); timer = setTimeout(() => void refresh(), 2000); }
      }
    };
    refreshRef.current = () => { void refresh(); };
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, [sessionId, toolUseId, agentId, limit]);
  useEffect(() => {
    if (!following) return;
    const frame = requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [snapshot, following]);

  const more = (snapshot?.totalMessages ?? snapshot?.activityCount ?? 0) > limit && limit < 500;
  const status = snapshot?.status === 'running' ? '运行中' : snapshot?.status === 'completed' ? '已完成'
    : snapshot?.status === 'failed' ? '失败' : snapshot?.status === 'stopped' ? '已停止' : '实时进展';
  return <aside aria-label="子任务实时进展" className="absolute inset-y-0 right-0 z-30 flex w-full min-w-0 flex-col border-l border-border bg-background shadow-xl md:relative md:inset-auto md:w-[45%] md:min-w-[320px] md:max-w-[680px] md:shrink-0"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-3">
      <div className="min-w-0 flex-1"><h2 className="break-words text-sm font-medium">{snapshot?.title || title || '子任务进展'}</h2>
        <div className="mt-1 flex gap-2 text-xs text-muted-foreground"><span>{snapshot?.provider ?? ''}</span><span>{status}</span><span>自动更新 · 仅查看</span></div>
      </div>
      <button type="button" onClick={() => refreshRef.current()} disabled={refreshing} aria-label="刷新子任务进展" className="rounded p-1.5 hover:bg-muted disabled:opacity-50">
        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭子任务侧栏" className="rounded p-1.5 hover:bg-muted"><X className="h-4 w-4" /></button>
    </div>
    {!!snapshot?.agents?.length && <div className="flex shrink-0 flex-wrap gap-1 border-b border-border p-2" aria-label="工作流子智能体">
      {snapshot.agents.map(agent => <button type="button" key={agent.id} aria-pressed={snapshot.selectedAgentId === agent.id}
        onClick={() => { setAgentId(agent.id); setFollowing(true); }}
        className={`rounded px-2 py-1 text-xs ${snapshot.selectedAgentId === agent.id ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{agent.label || agent.id}</button>)}
    </div>}
    {error && <div role="alert" className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive">{error} 将自动重试。</div>}
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3" onScroll={() => {
      const box = scroll.current; if (box) setFollowing(box.scrollHeight - box.scrollTop - box.clientHeight < 80);
    }}>
      {!snapshot && !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取子任务…</div>}
      {more && <button type="button" className="mb-3 rounded border px-3 py-1 text-xs" onClick={() => { setFollowing(false); setLimit(value => Math.min(500, value + 100)); }}>加载更早的进展</button>}
      <PermissionContext.Provider value={null}>
        {messages.map((message, index) => <MessageComponent key={String(message.id ?? message.toolId ?? `${message.timestamp}-${index}`)}
          message={message} prevMessage={index > 0 ? messages[index - 1] : null} createDiff={createDiff}
          selectedProject={selectedProject} provider={snapshot!.provider} showThinking />)}
        {!!snapshot?.activity?.length && <SubagentTimeline activity={snapshot.activity} activityCount={snapshot.activityCount} createDiff={createDiff} selectedProject={selectedProject} showAll />}
      </PermissionContext.Provider>
      {snapshot?.output && <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-mono text-xs leading-relaxed">{snapshot.output}</pre>}
      {snapshot?.outputTruncated && <p className="mt-2 text-xs text-muted-foreground">显示最近的命令输出。</p>}
      {snapshot?.notice && <p className="mt-3 text-xs text-muted-foreground">{snapshot.notice}</p>}
    </div>
    {!following && <button type="button" onClick={() => setFollowing(true)} className="absolute bottom-4 right-4 flex items-center gap-1 rounded-full border bg-background px-3 py-1.5 text-xs shadow"><ArrowDown className="h-3 w-3" />回到最新进展</button>}
  </aside>;
});
