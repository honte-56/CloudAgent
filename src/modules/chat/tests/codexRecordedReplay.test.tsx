import {readFileSync} from 'node:fs';
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {useSessionStore} from '@/modules/chat/hooks/useSessionStore';
import {normalizedToChatMessages} from '@/modules/chat/hooks/useChatMessages';
import type {NormalizedMessage} from '@/shared/types';
const state=vi.hoisted(()=>({page:null as unknown}));
vi.mock('@/shared/api',()=>({api:{providers:{sessionMessages:async()=>({ok:true,json:async()=>({data:state.page})})}}}));
// Private capture stays outside the repository; the deterministic native-format
// fixture in the provider tests covers the same identity rules in normal CI.
const file=process.env.CLOUDCLI_REPLAY_FIXTURE;
const fixture=file?JSON.parse(readFileSync(file,'utf8')):null;
afterEach(cleanup);
function visible(store:ReturnType<typeof useSessionStore>){return normalizedToChatMessages(store.getMessages('fixture'));}
const kinds=new Set(['text','stream_delta','tool_use','tool_result','thinking','task_status','task_notification']);

test.skipIf(!fixture)('the reported production trace reproduces duplicate acknowledged input against the old history parser',async()=>{
 const view=renderHook(useSessionStore);state.page=fixture.oldHistory;
 await act(async()=>{await view.result.current.fetchFromServer('fixture');});
 act(()=>{for(const event of fixture.events)if(kinds.has(event.kind))view.result.current.appendRealtime('fixture',event);});
 expect(visible(view.result.current).filter(row=>row.type==='user'&&row.content==='健康')).toHaveLength(2);
});
for(const historyFirst of [true,false])test.skipIf(!fixture)(`the actual trace reconciles input, commands, reasoning and replies exactly once (history first: ${historyFirst})`,async()=>{
 const view=renderHook(useSessionStore);state.page=fixture.history;
 if(historyFirst)await act(async()=>{await view.result.current.fetchFromServer('fixture');});
 act(()=>{for(const event of fixture.events as NormalizedMessage[])if(kinds.has(event.kind))view.result.current.appendRealtime('fixture',event);});
 await act(async()=>{await view.result.current.fetchFromServer('fixture');});
 const rows=visible(view.result.current),native=normalizedToChatMessages(fixture.history.messages);
 expect(rows.filter(row=>row.type==='user'&&row.content==='健康')).toHaveLength(1);
 expect(rows.filter(row=>row.isToolUse&&row.toolName==='Bash').map(row=>row.toolId)).toEqual(native.filter(row=>row.isToolUse&&row.toolName==='Bash').map(row=>row.toolId));
 expect(rows.map(row=>row.id)).toEqual(native.map(row=>row.id));
});
