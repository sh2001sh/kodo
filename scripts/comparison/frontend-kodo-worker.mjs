import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const {Application}=await import(pathToFileURL(path.join(config.kernel,'dist/application/index.js')).href);
process.env.KODO_FRONTEND_RELAY_KEY='fixture-relay-key';
const app=new Application(path.join(config.directory,'kodo-state'));
let result;
try{
  const run=app.createRun({objective:config.objective,workspace:config.workspace,
    binding:{protocol:'chat-completions',model:config.model,baseURL:config.baseURL,apiKeyEnv:'KODO_FRONTEND_RELAY_KEY',limits:{context:config.contextWindowTokens,output:config.maxOutputTokens}},
    permissions:['read','write','exec'],budget:{maxDurationMs:config.timeoutMs,maxContextTokens:config.contextWindowTokens,maxOutputTokens:config.maxOutputTokens}});
  app.store.subscribe(event=>appendFileSync(path.join(config.directory,'kodo-events.jsonl'),JSON.stringify(event)+'\n'));
  const final=await app.run(run.id);
  const runs=app.store.listRuns(run.sessionId);
  const details=runs.map(r=>({run:r,calls:app.store.calls(r.id).map(call=>({...call,
    request:app.store.readBlob(call.requestRef),
    result:call.resultRef?app.store.readBlob(call.resultRef):undefined,
  })),events:app.store.events(r.id),text:r.resultRef?app.store.readBlob(r.resultRef).text:''}));
  result={status:final.status,error:final.error,text:final.resultRef?app.store.readBlob(final.resultRef).text:'',runId:run.id,session:app.store.session(run.sessionId),details,messages:app.store.messages(run.sessionId)};
}finally{await app.shutdown();}
await writeFile(path.join(config.directory,'kodo-result.json'),JSON.stringify(result,null,2));
