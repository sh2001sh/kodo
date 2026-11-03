import { existsSync, appendFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import ts from 'typescript';
import { createBudgetRelay } from './comparison/relay.mjs';
import { runPiNative, piEntry } from './comparison/pi-native.mjs';
import { runOpenCode } from './comparison/opencode.mjs';
import { execute, treeManifest } from './comparison/real-tasks.mjs';
import { usageScorecard } from './comparison/real-scorecard.mjs';
import { prepareFrontend, longObjective, shortObjective } from './comparison/frontend-cases.mjs';
import { frontendOracle } from './comparison/frontend-oracle.mjs';

const {values}=parseArgs({options:{root:{type:'string'},'provider-config':{type:'string'},provider:{type:'string',default:'codego1'},'controls-only':{type:'boolean'},'playwright-module':{type:'string',default:'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'}}});
const repository=path.resolve(import.meta.dirname,'..');
const root=path.resolve(values.root??path.join(repository,'.kodo',`frontend-${Date.now()}`));
if(existsSync(root))throw Error('Evidence root already exists; use a fresh path');
await mkdir(root,{recursive:true});
const emit=value=>{console.log(JSON.stringify(value));appendFileSync(path.join(root,'progress.jsonl'),JSON.stringify({...value,time:new Date().toISOString()})+'\n');};
const model='deepseek-v4.1-flash';
const limits={contextWindowTokens:1000000,maxOutputTokens:393216};
const kernel=path.join(root,'kernel');await mkdir(kernel);
for(const name of ['src','dist','package.json','package-lock.json'])await cp(path.join(repository,name),path.join(kernel,name),{recursive:true});
const source=await treeManifest(kernel);const dist=await treeManifest(path.join(kernel,'dist'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const harnessSource={};for(const file of ['scripts/benchmark-frontend.mjs','scripts/comparison/frontend-cases.mjs','scripts/comparison/frontend-oracle.mjs','scripts/comparison/frontend-kodo-worker.mjs','scripts/comparison/pi-native.mjs','scripts/comparison/opencode.mjs','scripts/comparison/relay.mjs','scripts/comparison/real-scorecard.mjs']){harnessSource[file]=sha(await readFile(path.join(repository,file)));const dest=path.join(root,'evaluation-source',file);await mkdir(path.dirname(dest),{recursive:true});await cp(path.join(repository,file),dest);}
const manifest={version:'frontend-native-autonomy-v1',createdAt:new Date().toISOString(),model,limits,attempts:6,repeats:1,
  tasks:{long:{objective:longObjective,timeoutMs:1200000,order:['kodo','pi','opencode']},short:{objective:shortObjective,timeoutMs:300000,order:['opencode','pi','kodo']}},
  environment:{platform:process.platform,node:process.version,release:os.release(),cpu:os.cpus()[0].model},
  kernel:{identity:'current working tree, built and copied before model runs',source:Object.fromEntries(source),dist:Object.fromEntries(dist),sha256:sha(JSON.stringify({source,dist}))},
  harnesses:{pi:{version:JSON.parse(await readFile(path.resolve(piEntry,'../../../package.json'),'utf8')).version,sha256:sha(await readFile(piEntry)),native:true,extensions:false},opencode:JSON.parse(await readFile(path.join(repository,'.kodo/competitor-sources/opencode/info.json'),'utf8')),kodo:{defaultCard:'general/0.4.0',maxChildren:8,maxConcurrentModels:2}},harnessSource,
  design:{nativeTools:true,neutralPrompt:true,subagents:'Kodo and OpenCode native tools enabled; Pi native CLI without third-party extensions',accounting:'All relay requests, including children, native retries and errors; usage unknown when upstream omits it. Historical price estimate is not actual billing.',timing:'Native process lifecycle (startup and agent verification included). Independent oracle and OpenCode session export excluded. Kodo worker includes Application construction and shutdown.',isolation:'Independent source fixtures/native state. No OS-enforced boundary; audit tool actions. No harness sees real credentials. Evaluator outside workspace.',oracle:'Predeclared domain and browser checks; desktop/mobile screenshots; negative and positive controls. Syntax build is not a bundler/TypeScript build.',limitations:'One trial per cell; exploratory observation only, not a statistical ranking. Model identity checked by request/response alias, underlying weights unverified.'}};
await writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));
emit({event:'preparing',root,model});
for(const kind of ['long','short'])for(const positive of [false,true]){
  const directory=path.join(root,`control-${kind}-${positive?'positive':'negative'}`);const workspace=path.join(directory,'workspace');await prepareFrontend(workspace,kind,positive);
  const result=await frontendOracle({workspace,directory,kind,playwrightModule:values['playwright-module']});
  emit({event:'control',kind,positive,passed:result.passedCount,total:result.total});
  if(result.passed!==positive)throw Error(`Invalid ${kind} ${positive?'positive':'negative'} control`);
}
if(values['controls-only']){emit({event:'controls.finished'});process.exit(0);}
let key=process.env.KODO_API_KEY??process.env.OPENAI_API_KEY;let upstream=process.env.KODO_BASE_URL;
if(values['provider-config']){const file=path.resolve(values['provider-config']);const parsed=ts.parseConfigFileTextToJson(file,await readFile(file,'utf8'));if(parsed.error)throw Error('Provider config parse error');const options=parsed.config?.provider?.[values.provider]?.options;key??=options?.apiKey;upstream??=options?.baseURL;}
if(!key||!upstream)throw Error('Provider configuration missing');
const endpoint=new URL(upstream);if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('Invalid provider URL');
manifest.providerOrigin=endpoint.origin;await writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));
const results=[];
for(const kind of ['long','short'])for(const profile of manifest.tasks[kind].order){
  const id=kind+'-'+profile;const directory=path.join(root,id);const workspace=path.join(directory,'workspace');await prepareFrontend(workspace,kind);
  const before=await treeManifest(workspace);const wire=path.join(directory,'wire');await mkdir(wire);
  const relay=await createBudgetRelay({directory:wire,upstream,key,model,...limits,maxContextChars:Number.MAX_SAFE_INTEGER,unrestricted:true});
  const objective=`当前项目工作区：${workspace}。仅在此目录完成任务。\n${manifest.tasks[kind].objective}`;
  await writeFile(path.join(directory,'objective.txt'),objective);
  const trace=(type,data)=>appendFileSync(path.join(directory,'trace.jsonl'),JSON.stringify({type,time:Date.now(),...data}).replaceAll(key,'[redacted]')+'\n');
  const options={workspace,directory:path.join(directory,'native'),objective,baseURL:relay.baseURL,model,...limits,timeoutMs:manifest.tasks[kind].timeoutMs,trace};
  emit({event:'trial.started',id});let outcome;let executionMs;const started=Date.now();
  try{
    if(profile==='pi')outcome=await runPiNative(options);
    else if(profile==='opencode')outcome=await runOpenCode({...options,maxModelCalls:Number.MAX_SAFE_INTEGER,singleAgent:false,unrestricted:true});
    else{
      const config=path.join(directory,'worker.json');await writeFile(config,JSON.stringify({...options,kernel,directory}));
      const child=await execute(process.execPath,[path.join(repository,'scripts/comparison/frontend-kodo-worker.mjs'),config],workspace,path.join(directory,'worker-process.json'),options.timeoutMs);
      executionMs=child.elapsedMs;
      outcome=await readFile(path.join(directory,'kodo-result.json'),'utf8').then(JSON.parse).catch(()=>({status:'failed',error:child.timedOut?'Task timeout':child.stderr,text:''}));
      if(child.timedOut||child.code!==0){outcome.status='failed';outcome.error=child.timedOut?'Task timeout':child.stderr;}
    }
    executionMs??=outcome.executionMs;
  }catch(error){outcome={status:'failed',error:error.message,text:''};executionMs=Date.now()-started;}
  finally{await relay.close();}
  await writeFile(path.join(directory,'outcome.json'),JSON.stringify(outcome,null,2));
  const nativeCalls=profile==='kodo'?(outcome.details??[]).flatMap(d=>d.calls.filter(c=>c.kind==='tool').map(c=>({name:c.name,failed:c.status!=='succeeded',runId:d.run.id}))):profile==='pi'?(outcome.events??[]).filter(e=>e.type==='tool_execution_end').map(e=>({name:e.toolName,failed:!!e.isError})):(outcome.toolParts??[]).map(p=>({name:p.tool,failed:['error','cancelled'].includes(p.state?.status)}));
  const oracle=await frontendOracle({workspace,directory,kind,playwrightModule:values['playwright-module']});
  const build=await execute(process.execPath,['scripts/check.mjs'],workspace,path.join(directory,'build.json'));
  const tests=await execute(process.execPath,['--test','tests/*.test.mjs'],workspace,path.join(directory,'tests.json'));
  const after=await treeManifest(workspace);const changed=after.filter(([name,hash])=>new Map(before).get(name)!==hash).map(([name])=>name);const removed=before.filter(([name])=>!new Map(after).has(name)).map(([name])=>name);
  const allowed=name=>(kind==='long'&&(name==='index.html'||name==='README.md'||name.startsWith('src/')))||(kind==='short'&&name==='src/model.js')||(name.startsWith('tests/')&&!before.some(([old])=>old===name));
  const scope={changed,removed,violations:[...changed,...removed].filter(name=>!allowed(name))};
  const addedTests=(await readdir(path.join(workspace,'tests'))).filter(f=>f!=='baseline.test.mjs'&&f.endsWith('.test.mjs'));
  const delivery=outcome.status==='completed'&&!!outcome.text?.trim();
  const row={id,kind,profile,directory,status:outcome.status,error:outcome.error,executionMs,usage:usageScorecard(relay.stats),tools:{total:nativeCalls.length,failed:nativeCalls.filter(c=>c.failed).length,byName:Object.fromEntries([...new Set(nativeCalls.map(c=>c.name))].map(n=>[n,nativeCalls.filter(c=>c.name===n).length]))},children:profile==='kodo'?(outcome.details??[]).filter(d=>d.run.parentId).map(d=>({id:d.run.id,objective:d.run.objective,status:d.run.status,createdAt:d.run.createdAt,calls:d.calls.length})):undefined,acceptance:{passed:oracle.passed&&build.code===0&&tests.code===0&&!scope.violations.length&&!!addedTests.length&&delivery,oraclePassed:oracle.passedCount,oracleTotal:oracle.total,failedCriteria:oracle.checks.filter(c=>!c.passed).map(c=>c.name),build:build.code===0,tests:tests.code===0,addedTests,scope,delivery}};
  results.push(row);await writeFile(path.join(directory,'result.json'),JSON.stringify(row,null,2));await writeFile(path.join(root,'results.json'),JSON.stringify({results},null,2));
  emit({event:'trial.finished',id,seconds:executionMs/1000,status:row.status,oracle:`${oracle.passedCount}/${oracle.total}`,tokens:row.usage.total,requests:row.usage.requests,children:row.children?.length,passed:row.acceptance.passed,failed:row.acceptance.failedCriteria});
}
emit({event:'benchmark.finished',root});
