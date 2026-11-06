import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

test('Claude wrapped deltas and final history use the same item identity, separately for each session', () => {
 const p=new ClaudeSessionsProvider({getLiveRunStartTime:()=>null});
 const stream=(sid:string,event:object,parent:string|null=null)=>p.normalizeMessage({type:'stream_event',event,parent_tool_use_id:parent},sid);
 stream('one',{type:'message_start',message:{id:'a'}});
 stream('two',{type:'message_start',message:{id:'b'}});
 stream('one',{type:'message_start',message:{id:'child'}},'tool-child');
 const delta=stream('one',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hello'}})[0];
 assert.equal(delta.messageKey,'claude-block:a:0');
 assert.equal(stream('two',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'world'}})[0].messageKey,'claude-block:b:0');
 const final=p.normalizeMessage({uuid:'transcript-uuid',type:'assistant',message:{id:'a',role:'assistant',content:[{type:'text',text:'hello world'}]}},'one')[0];
 assert.equal(final.messageKey,delta.messageKey); assert.equal(final.id,delta.id);
 assert.equal(stream('one',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'child'}} ,'tool-child')[0].parentToolUseId,'tool-child');
});

test('Codex live completion and persisted answer have identical keys; repeated text with distinct ids stays distinct',()=>{
 const p=new CodexSessionsProvider();
 const live=p.normalizeMessage({type:'item',itemType:'agent_message',itemId:'a',message:{content:'done'}},'s')[0];
 const history=p.normalizeMessage({type:'assistant',uuid:'a',message:{role:'assistant',content:'done'}},'s')[0];
 const next=p.normalizeMessage({type:'assistant',uuid:'b',message:{role:'assistant',content:'done'}},'s')[0];
 assert.equal(live.messageKey,history.messageKey);assert.notEqual(next.messageKey,history.messageKey);
});


test('Claude consumed user input keeps the receipt UUID while additional text blocks stay distinct',()=>{
 const p=new ClaudeSessionsProvider({getLiveRunStartTime:()=>null});
 const rows=p.normalizeMessage({type:'user',uuid:'client-receipt',message:{role:'user',content:[{type:'text',text:'追加条件'},{type:'text',text:'更多说明'}]}},'s');
 assert.deepEqual(rows.map(row=>row.id),['client-receipt','client-receipt_text_1']);
 assert(rows.every(row=>row.transcriptAnchorId==='client-receipt'));
});

test('Claude split thinking/text/tool rows retain the stream-wide content block index', () => {
 const p=new ClaudeSessionsProvider({getLiveRunStartTime:()=>null});
 const stream=(event:object)=>p.normalizeMessage({type:'stream_event',event},'split');
 stream({type:'message_start',message:{id:'response'}});
 const thinking={type:'assistant',uuid:'thinking-row',message:{id:'response',role:'assistant',content:[{type:'thinking',thinking:''}]}};
 assert.deepEqual(p.normalizeMessage(thinking,'split'),[]);
 const delta=stream({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Answer'}})[0];
 const text={type:'assistant',uuid:'text-row',message:{id:'response',role:'assistant',content:[{type:'text',text:'Answer'}]}};
 const final=p.normalizeMessage(text,'split')[0];
 assert.equal(final.messageKey,delta.messageKey);
 assert.equal(p.normalizeMessage(text,'split')[0].id,final.id,'same UUID is idempotent');
 const tool=p.normalizeMessage({type:'assistant',uuid:'tool-row',message:{id:'response',role:'assistant',content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{}}]}},'split')[0];
 assert.equal(tool.messageKey,'claude-block:response:2');
 const second=p.normalizeMessage({type:'assistant',uuid:'second-text',message:{id:'response',role:'assistant',content:[{type:'text',text:'Answer'}]}},'split')[0];
 assert.equal(second.messageKey,'claude-block:response:3','identical text in a distinct block stays distinct');
});
