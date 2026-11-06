import {readFileSync} from 'node:fs';
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {useSessionStore} from '@/modules/chat/hooks/useSessionStore';
import {normalizedToChatMessages} from '@/modules/chat/hooks/useChatMessages';
const state=vi.hoisted(()=>({page:null as unknown}));
vi.mock('@/shared/api',()=>({api:{providers:{sessionMessages:async()=>({ok:true,json:async()=>({data:state.page})})}}}));
const file=process.env.CLOUDCLI_SUBAGENT_REPLAY_FIXTURE;
const fixture=file?JSON.parse(readFileSync(file,'utf8')):null;
const kinds=new Set(['text','stream_delta','tool_use','tool_result','thinking','task_status','task_notification']);
afterEach(cleanup);
for(const historyFirst of [true,false])test.skipIf(!fixture)(`real parent/subagent trace keeps the final reply last after paginated refresh and replay (${historyFirst})`,async()=>{
 const view=renderHook(useSessionStore);
 const full=fixture.history.messages;
 const page={...fixture.history,messages:full.slice(-20),hasMore:true,oldestCursor:full.at(-20).messageKey||full.at(-20).id};
 state.page=page;
 if(historyFirst)await act(async()=>{await view.result.current.fetchFromServer('fixture');});
 act(()=>{for(const event of fixture.events)if(kinds.has(event.kind))view.result.current.appendRealtime('fixture',event);});
 await act(async()=>{await view.result.current.fetchFromServer('fixture');});
 const visible=()=>normalizedToChatMessages(view.result.current.getMessages('fixture'));
 expect(visible().some(row=>row.toolName==='subAgentActivity')).toBe(false);
 expect(visible().at(-1)?.content).toContain('9f1aae1');
 expect(visible().filter(row=>row.toolResult?.isError)).toHaveLength(0);
 // Loading all history must preserve the old failures in their original
 // place, rather than suppressing errors to make the latest screen look clean.
 state.page=fixture.history;
 await act(async()=>{await view.result.current.fetchFromServer('fixture',{limit:null});});
 const native=normalizedToChatMessages(full);
 expect(visible().map(row=>row.id)).toEqual(native.map(row=>row.id));
 expect(visible().filter(row=>row.toolResult?.isError).length).toBeGreaterThan(0);
 expect(visible().at(-1)?.content).toContain('9f1aae1');
 await act(async()=>{await view.result.current.refreshLatestFromServer('fixture');});
 expect(visible().at(-1)?.content).toContain('9f1aae1');
});
