import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {initializeDatabase,closeConnection,sessionsDb} from '@/modules/database/index.js';
import {CodexSessionsProvider} from '@/modules/providers/list/codex/codex-sessions.provider.js';
import {transformCodexItem} from '@/modules/providers/list/codex/codex-items.provider.js';

async function fixture(rows:object[],run:(provider:CodexSessionsProvider)=>Promise<void>){
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-native-items-')),previous=process.env.DATABASE_PATH;
 closeConnection();process.env.DATABASE_PATH=path.join(dir,'auth.db');await writeFile(process.env.DATABASE_PATH,'');await initializeDatabase();
 const file=path.join(dir,'session.jsonl');await writeFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 sessionsDb.createSession('s','codex',dir,'Native timeline',undefined,undefined,file);
 try{await run(new CodexSessionsProvider());}finally{closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;await rm(dir,{recursive:true,force:true});}
}
const at=(seconds:number)=>new Date(Date.UTC(2026,10,4,11,37,seconds)).toISOString();
const typed=(item:object,seconds:number,started=seconds)=>({type:'event_msg',timestamp:at(seconds),payload:{type:'item_completed',turn_id:'turn',started_at_ms:Date.parse(at(started)),completed_at_ms:Date.parse(at(seconds)),item}});
const start={type:'event_msg',timestamp:at(0),payload:{type:'task_started',turn_id:'turn'}};
const prompt=typed({type:'UserMessage',id:'native-user',client_id:'receipt-1',content:[{type:'text',text:'健康'}]},1);
const wrapper={type:'response_item',timestamp:at(2),payload:{type:'custom_tool_call',id:'wrapper',call_id:'wrapper-call',name:'exec',input:'text(await tools.exec_command({cmd:"echo ok"}));'}};
const command={type:'CommandExecution',id:'exec-native',command:['/bin/bash','-lc','echo ok'],status:'completed',aggregated_output:'ok',exit_code:0};

test('typed commands and client receipts agree with live IDs instead of adding wrapper duplicates',async()=>{
 await fixture([start,prompt,wrapper,typed(command,5,3),{type:'response_item',timestamp:at(6),payload:{type:'custom_tool_call_output',call_id:'wrapper-call',output:'ok'}},typed({type:'UserMessage',id:'native-user-2',client_id:'receipt-2',content:[{type:'text',text:'健康'}]},7)],async provider=>{
  const history=await provider.fetchHistory('s');
  assert.deepEqual(history.messages.filter(row=>row.role==='user').map(row=>row.id),['receipt-1','receipt-2'],'legitimate repeated prompts remain distinct');
  const commands=history.messages.filter(row=>row.toolName==='Bash');assert.equal(commands.length,1);assert.equal(commands[0].toolId,'exec-native');assert.equal(commands[0].timestamp,at(3));
  assert.equal(commands[0].toolResult?.content,'ok');
  const live=provider.normalizeMessage(transformCodexItem({...command,type:'commandExecution',command:'bash -lc "echo ok"',aggregatedOutput:'ok',exitCode:0}),'s');
  assert.equal(commands[0].id,live[0].id);assert.equal(commands[0].toolId,live[0].toolId);
 });
});

test('a modern in-flight code-mode wrapper does not fabricate a second command before its native item completes',async()=>{
 await fixture([start,prompt,wrapper],async provider=>{
  const history=await provider.fetchHistory('s');assert.equal(history.messages.filter(row=>row.toolName==='Bash').length,0);
 });
});

test('legacy transcripts still reconstruct commands when native display items are absent',async()=>{
 await fixture([start,wrapper],async provider=>{
  const history=await provider.fetchHistory('s');assert.equal(history.messages.filter(row=>row.toolName==='Bash').length,1);
 });
});

test('native file changes keep their live identities and actual diff contents',async()=>{
 const patch='*** Begin Patch\n*** Add File: sample.txt\n+hello\n*** End Patch';
 await fixture([start,prompt,{type:'response_item',timestamp:at(2),payload:{type:'custom_tool_call',call_id:'patch-wrapper',name:'apply_patch',input:patch}},typed({type:'FileChange',id:'native-patch',status:'completed',changes:{'sample.txt':{type:'add',content:'hello\n'}}},5,3)],async provider=>{
  const history=await provider.fetchHistory('s');const edits=history.messages.filter(row=>['Write','Edit'].includes(row.toolName||''));
  assert.equal(edits.length,1);assert.equal(edits[0].toolId,'native-patch_0');assert(edits[0].toolResult, 'completed native edits must not remain visually running');assert.equal((edits[0].toolInput as {new_string:string}).new_string,'hello\n');
 });
});

test('native subagent lifecycle updates one Task and explicit child termination stops its status',async()=>{
 const child='11111111-2222-4333-8444-555555555555';
 const activity=(id:string,kind:string)=>({type:'SubAgentActivity',id,kind,agent_thread_id:child,agent_path:'/root/reviewer'});
 await fixture([start,prompt,{type:'response_item',timestamp:at(2),payload:{type:'function_call',call_id:'spawn-review',name:'spawn_agent',arguments:JSON.stringify({task_name:'reviewer'})}},typed(activity('spawn-review','started'),3),typed(activity('wait-review','interacted'),4),typed(activity('completed-review','completed'),5)],async provider=>{
  const parent=sessionsDb.getSessionById('s')!;
  const childPath=path.join(path.dirname(parent.jsonl_path!),`rollout-test-${child}.jsonl`);
  await writeFile(childPath,JSON.stringify({type:'event_msg',timestamp:at(4),payload:{type:'task_complete'}})+'\n');
  let history=await provider.fetchHistory('s');
  const tasks=history.messages.filter(row=>row.toolName==='Task');
  assert.equal(tasks.length,1);assert.equal(tasks[0].toolId,'spawn-review');assert.equal(tasks[0].subagent?.id,child);assert.equal(tasks[0].subagent?.status,'completed');
  assert(!history.messages.some(row=>row.toolName==='subAgentActivity'));
  const live=provider.normalizeMessage(transformCodexItem({...activity('wait-review','interacted'),type:'subAgentActivity',agentThreadId:child}),'s');
  assert.equal(live.length,1);assert.equal(live[0].kind,'status');assert.equal(live[0].historyChanged,true);
  await writeFile(childPath,JSON.stringify({type:'event_msg',timestamp:at(4),payload:{type:'task_started'}})+'\n');
  assert.equal((await provider.fetchHistory('s')).messages.find(row=>row.toolName==='Task')?.subagent?.status,'completed','a stale child file cannot revive a newer parent completion');
  await writeFile(childPath,JSON.stringify({type:'event_msg',timestamp:at(6),payload:{type:'task_started'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:at(7),payload:{type:'turn_aborted',reason:'interrupted'}})+'\n');
  history=await provider.fetchHistory('s');assert.equal(history.messages.find(row=>row.toolName==='Task')?.subagent?.status,'stopped');
  assert.equal((await provider.readSubagentActivity('s',child))?.agent.status,'stopped');
 });
});
