import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {useRef} from 'react';
import {normalizedToChatMessages} from '@/modules/chat/hooks/useChatMessages';
import {useSessionStore} from '@/modules/chat/hooks/useSessionStore';
import {useChatRealtimeHandlers} from '@/modules/chat/hooks/useChatRealtimeHandlers';
import {api} from '@/shared/api';
import type {NormalizedMessage,ProjectSession,ServerEvent} from '@/shared/types';
vi.mock('@/shared/api',()=>({api:{providers:{sessionMessages:vi.fn()}}}));
const row=(id:string,content:string,kind:NormalizedMessage['kind']='text'):NormalizedMessage=>({id,messageKey:id,sessionId:'one',provider:'codex',timestamp:'2026-11-04T00:00:00Z',kind,role:'assistant',content});
function harness(){
 let listener:(msg:ServerEvent)=>void=()=>{};
 const subscribe=(fn:typeof listener)=>{listener=fn;return()=>{};};
 const view=renderHook(({session})=>{
  const store=useSessionStore();store.setActiveSession(session);
  const seq=useRef(new Map<string,number>());
  useChatRealtimeHandlers({isActive:true,subscribe,provider:'codex',selectedSession:{id:session} as ProjectSession,currentSessionId:session,
   setTokenBudget:()=>{},pendingPermissionRequests:[],setPendingPermissionRequests:()=>{},lastSeqRef:seq,statusCheckSentAtRef:useRef(new Map()),requestLatestMessages:async()=>{},sessionStore:store});
  return store;
 },{initialProps:{session:'one'}});
 return {view,send:(message:NormalizedMessage)=>listener(message)};
}
beforeEach(()=>{vi.useFakeTimers();vi.mocked(api.providers.sessionMessages).mockReset();});
afterEach(()=>{cleanup();vi.useRealTimers();});

test('interleaved sessions, view switching and replayed frames never mix or duplicate streamed text',async()=>{
 const {view,send}=harness();
 act(()=>{
  send({...row('a','你','stream_delta'),seq:1,streamSnapshot:true});
  send({...row('b','other','stream_delta'),sessionId:'two',seq:1,streamSnapshot:true});
 });
 view.rerender({session:'two'});
 await act(async()=>{vi.advanceTimersByTime(50);});
 expect(view.result.current.getMessages('one').map(m=>m.content)).toEqual(['你']);
 expect(view.result.current.getMessages('two').map(m=>m.content)).toEqual(['other']);
 act(()=>{
  send({...row('a','你好','stream_delta'),seq:2,streamSnapshot:true});
  send({...row('a','你','stream_delta'),seq:1,streamSnapshot:true});
  send({...row('a','你好'),seq:3});
 });
 expect(view.result.current.getMessages('one')).toHaveLength(1);
 expect(view.result.current.getMessages('one')[0]).toMatchObject({content:'你好',kind:'text',id:'a'});
});

test('late history reconciles a streaming answer without duplication or replacing a newer partial with old text',async()=>{
 const {view,send}=harness();
 act(()=>send({...row('a','growing answer','stream_delta'),seq:1,streamSnapshot:true}));
 await act(async()=>{vi.advanceTimersByTime(50);});
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[row('a','growing')],total:1,hasMore:false}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 expect(view.result.current.getMessages('one').map(m=>m.content)).toEqual(['growing answer']);
 act(()=>send({...row('a','growing answer complete'),seq:2}));
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[row('a','growing answer complete')],total:1,hasMore:false}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 expect(view.result.current.getMessages('one')).toHaveLength(1);
 expect(view.result.current.getMessages('one')[0].content).toBe('growing answer complete');
});

test('identical legitimate replies remain separate and native delivery order beats skewed clocks',()=>{
 const {view,send}=harness();
 act(()=>{
  send({...row('a','same'),seq:1,timestamp:'2026-11-04T01:00:00Z'});
  send({...row('b','same'),seq:2,timestamp:'2026-11-04T00:00:00Z'});
 });
 expect(view.result.current.getMessages('one').map(m=>m.id)).toEqual(['a','b']);
});

test('older pages use stable identity cursors even when new messages arrive during the request',async()=>{
 const {view}=harness();
 vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce({ok:true,json:async()=>({data:{messages:[row('c','c'),row('d','d')],oldestCursor:'c',total:4,hasMore:true}})} as Response)
  .mockResolvedValueOnce({ok:true,json:async()=>({data:{messages:[row('a','a'),row('b','b')],oldestCursor:'a',total:5,hasMore:false}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 await act(async()=>{await view.result.current.fetchMore('one');});
 expect(vi.mocked(api.providers.sessionMessages).mock.calls[1][1]).toMatchObject({before:'c'});
 expect(view.result.current.getMessages('one').map(m=>m.id)).toEqual(['a','b','c','d']);
});

test('a compacted replay keeps a growing reply before the tools that followed its first fragment',async()=>{
 const {view,send}=harness();
 act(()=>{
  send({...row('tool',''),kind:'tool_use',toolId:'tool',toolName:'Bash',seq:2});
  send({...row('answer','complete text','stream_delta'),seq:10,firstSeq:1,streamSnapshot:true});
  send({...row('answer','complete text'),seq:11,firstSeq:1});
 });
 expect(view.result.current.getMessages('one').map(m=>m.id)).toEqual(['answer','tool']);
});

test('a new history revision removes superseded realtime rows but retains post-edit delivery',async()=>{
 const {view,send}=harness();
 act(()=>{send({...row('old','old answer'),seq:1});send({...row('new','new answer'),seq:8});});
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[],total:0,hasMore:false,timelineRevision:7}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 expect(view.result.current.getMessages('one').map(m=>m.id)).toEqual(['new']);
});


test('rendered rows retain the provider identity across stream updates and completion',()=>{
 const first=normalizedToChatMessages([row('stable','first','stream_delta')])[0];
 const updated=normalizedToChatMessages([row('stable','first second','stream_delta')])[0];
 const final=normalizedToChatMessages([row('stable','first second')])[0];
 expect([first.id,updated.id,final.id]).toEqual(['stable','stable','stable']);
});

test('unchanged history polling retains settled row objects and the merged array',async()=>{
 const {view}=harness();
 vi.mocked(api.providers.sessionMessages).mockImplementation(async()=>({ok:true,json:async()=>({data:{messages:[row('a','settled')],total:1,hasMore:false,oldestCursor:'a',timelineRevision:0}})} as Response));
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 const previous=view.result.current.getMessages('one');
 await act(async()=>{const result=await view.result.current.refreshLatestFromServer('one');expect(result.changed).toBe(false);});
 expect(view.result.current.getMessages('one')).toBe(previous);
});

test('replaying an interrupted answer flushes pending text and finishes its streaming presentation',()=>{
 const {view,send}=harness();
 act(()=>{
  send({...row('partial','retained partial answer','stream_delta'),seq:10,streamSnapshot:true});
  send({kind:'chat_replay_complete',sessionId:'one',cursor:11,isProcessing:false} as unknown as NormalizedMessage);
 });
 expect(view.result.current.getMessages('one')[0]).toMatchObject({kind:'text',content:'retained partial answer'});
});


test('persisted anchors survive pruning, so an old unpersisted error stays before the final reply',async()=>{
 const {view,send}=harness();
 act(()=>{send({...row('intro','working'),seq:1});send({...row('diagnostic','earlier error'),kind:'error',seq:2});send({...row('final','finished'),seq:3});});
 vi.mocked(api.providers.sessionMessages).mockImplementation(async()=>({ok:true,json:async()=>({data:{messages:[row('intro','working'),row('final','finished')],total:2,hasMore:false}})} as Response));
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 expect(view.result.current.getMessages('one').map(message=>message.id)).toEqual(['intro','diagnostic','final']);
 await act(async()=>{await view.result.current.refreshLatestFromServer('one');});
 expect(view.result.current.getMessages('one').map(message=>message.id)).toEqual(['intro','diagnostic','final']);
 act(()=>send({...row('new-error','later error'),kind:'error',seq:4}));
 expect(view.result.current.getMessages('one').at(-1)?.id).toBe('new-error');
});

test('old replay rows outside the loaded window wait for upward paging instead of appearing below the final reply',async()=>{
 const {view,send}=harness();
 act(()=>{send({...row('old-error',''),kind:'tool_use',toolId:'old-error',toolName:'Bash',seq:1});send({...row('recent','recent'),seq:90});send({...row('final','finished'),seq:100});});
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[row('recent','recent'),row('final','finished')],total:3,hasMore:true,oldestCursor:'recent'}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 expect(view.result.current.getMessages('one').map(message=>message.id)).toEqual(['recent','final']);
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[{...row('old-error',''),kind:'tool_use',toolId:'old-error',toolName:'Bash'}],total:3,hasMore:false,oldestCursor:'old-error'}})} as Response);
 await act(async()=>{await view.result.current.fetchMore('one');});
 expect(view.result.current.getMessages('one').map(message=>message.id)).toEqual(['old-error','recent','final']);
});

test('reconnect frames are applied atomically at the replay boundary',()=>{
 const {view,send}=harness();
 act(()=>{send({...row('first','first'),seq:1,isReplay:true} as NormalizedMessage);send({...row('final','finished'),seq:2,isReplay:true} as NormalizedMessage);});
 expect(view.result.current.getMessages('one')).toHaveLength(0);
 act(()=>send({kind:'chat_replay_complete',sessionId:'one',cursor:2,isProcessing:false} as unknown as NormalizedMessage));
 expect(view.result.current.getMessages('one').map(message=>message.id)).toEqual(['first','final']);
});

test('an unsequenced history prefix must not hide a pending tool inside the loaded time window',async()=>{
 const {view,send}=harness();
 const prefix={...row('prefix','existing prompt'),timestamp:'2026-11-04T00:00:00Z'};
 const final={...row('final','latest reply'),timestamp:'2026-11-04T00:00:02Z'};
 act(()=>{send({...row('pending',''),kind:'tool_use',toolId:'pending',toolName:'Bash',seq:95,timestamp:'2026-11-04T00:00:01Z'});send({...final,seq:100});});
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[prefix,final],total:5,hasMore:true}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 expect(view.result.current.getMessages('one').map(message=>message.id)).toEqual(['prefix','pending','final']);
});

test('a replay snapshot repairs a suffix heard before the subscribe ack without downgrading completed text',async()=>{
 const {view,send}=harness();
 act(()=>send({...row('answer','world','stream_delta'),seq:3,firstSeq:1,streamSnapshot:false}));
 await act(async()=>{vi.advanceTimersByTime(50);});
 act(()=>{
  send({...row('answer','hello world','stream_delta'),seq:3,firstSeq:1,streamSnapshot:true,isReplay:true} as NormalizedMessage);
  send({kind:'chat_replay_complete',sessionId:'one',cursor:3,isProcessing:true} as unknown as NormalizedMessage);
 });
 expect(view.result.current.getMessages('one')[0].content).toBe('hello world');
 act(()=>send({...row('answer','hello world finished'),seq:4}));
 act(()=>{
  send({...row('answer','hello world','stream_delta'),seq:3,streamSnapshot:true,isReplay:true} as NormalizedMessage);
  send({kind:'chat_replay_complete',sessionId:'one',cursor:4,isProcessing:false} as unknown as NormalizedMessage);
 });
 expect(view.result.current.getMessages('one')[0]).toMatchObject({kind:'text',content:'hello world finished'});
});

for (const provider of ['codex','claude'] as const) test(`${provider} first streamed fragment stays after a persisted user prompt that has no delivery sequence`,async()=>{
 const {view,send}=harness();
 const previous={...row('previous','Previous reply'),provider,timestamp:'2026-11-05T09:40:00Z'};
 const question={...row('question','Next question'),provider,role:'user' as const,timestamp:'2026-11-05T09:43:32Z'};
 act(()=>send({...previous,seq:10}));
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[previous,question],total:2,hasMore:false}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 act(()=>send({...row('answer','First fragment','stream_delta'),provider,seq:12,timestamp:'2026-11-05T09:43:36Z'}));
 act(()=>vi.advanceTimersByTime(100));
 expect(view.result.current.getMessages('one').map(m=>m.id)).toEqual(['previous','question','answer']);
});

test('an older replay stays before a later unsequenced user prompt instead of being forced to the tail',async()=>{
 const {view,send}=harness();
 const previous={...row('previous','Previous'),timestamp:'2026-11-05T09:40:00Z'};
 const question={...row('question','Later question'),role:'user' as const,timestamp:'2026-11-05T09:43:32Z'};
 act(()=>send({...previous,seq:10}));
 vi.mocked(api.providers.sessionMessages).mockResolvedValue({ok:true,json:async()=>({data:{messages:[previous,question],total:2,hasMore:false}})} as Response);
 await act(async()=>{await view.result.current.fetchFromServer('one');});
 act(()=>send({...row('old-pending','Earlier answer','stream_delta'),seq:12,timestamp:'2026-11-05T09:41:00Z'}));
 act(()=>vi.advanceTimersByTime(100));
 expect(view.result.current.getMessages('one').map(m=>m.id)).toEqual(['previous','old-pending','question']);
});
