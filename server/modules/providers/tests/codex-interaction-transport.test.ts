import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live.client.js';
import type { AnyRecord } from '@/shared/index.js';

test('native RPC questions remain open until an explicit reply, preserving their request ID', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-question-transport-'));
  const script = path.join(directory, 'fixture.mjs');
  await writeFile(script, `import readline from 'node:readline';
let answer=null, count=0;
const send=data=>process.stdout.write(JSON.stringify(data)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{
 const data=JSON.parse(line);
 if(data.method==='initialize') {
  send({id:data.id,result:{}});
  send({id:'native-question',method:'item/tool/requestUserInput',params:{threadId:'thread',questions:[{id:'q',question:'Choose',options:[]}]}});
 } else if(data.method==='probe') send({id:data.id,result:{answer,count}});
 else if(data.id==='native-question') {answer=data.result??data.error;count++;}
});`);
  let reply: ((result: AnyRecord) => void) | undefined;
  const errors: Error[] = [];
  const client = new CodexLiveClient(() => {}, error => errors.push(error), script, { ...process.env }, (method, params, respond, id) => {
    assert.equal(method, 'item/tool/requestUserInput');
    assert.equal(params.questions[0].id, 'q');
    assert.equal(id, 'native-question');
    reply = respond;
    return true;
  });
  try {
    await client.initialize();
    assert.deepEqual(await client.call('probe', {}), { answer: null, count: 0 });
    assert.ok(reply);
    reply({ answers: { q: { answers: ['B'] } } });
    reply({ answers: {} });
    assert.deepEqual(await client.call('probe', {}), { answer: { answers: { q: { answers: ['B'] } } }, count: 1 });
    assert.equal(errors.length, 0);
  } finally { client.close(); await rm(directory, { recursive: true, force: true }); }
});
