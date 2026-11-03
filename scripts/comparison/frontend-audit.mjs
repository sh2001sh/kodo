import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

const root=path.resolve(process.argv[2]);
const normalizedRoot=root.replaceAll('\\','/');
const results=JSON.parse(await readFile(path.join(root,'results.json'),'utf8')).results;
const audit=[];
for(const row of results){
  const wire=path.join(row.directory,'wire');const stats=JSON.parse(await readFile(path.join(wire,'relay.json'),'utf8'));
  const requests=[];const responseModels=new Set();const toolCalls=new Map();const offered=new Set();
  for(const file of (await readdir(wire)).filter(f=>/^request-\d+\.json$/.test(f))){
    const body=JSON.parse(await readFile(path.join(wire,file),'utf8'));requests.push({file,model:body.model,output:body.max_tokens??body.max_completion_tokens});
    for(const tool of body.tools??[])offered.add(tool.function?.name??tool.name);
    for(const message of body.messages??[])for(const t of message.tool_calls??[]){const fn=t.function??{};let args;try{args=JSON.parse(fn.arguments);}catch{args=fn.arguments;}const key=JSON.stringify([t.id,fn.name,args]);toolCalls.set(key,{id:t.id,name:fn.name,args});}
  }
  for(const file of (await readdir(wire)).filter(f=>/^response-\d+\.sse$/.test(f))){
    for(const line of (await readFile(path.join(wire,file),'utf8')).split('\n'))if(line.startsWith('data:')){try{const item=JSON.parse(line.slice(5));if(item.model)responseModels.add(item.model);}catch{/* [DONE] and non-JSON event lines have no model identity. */}}
  }
  const outcome=JSON.parse(await readFile(path.join(row.directory,'outcome.json'),'utf8'));
  const details=outcome.details??[];
  const kodoTools=details.flatMap(d=>d.calls.filter(c=>c.kind==='tool').map(c=>({runId:d.run.id,parentId:d.run.parentId,name:c.name,status:c.status,request:c.request,result:c.result})));
  // Include last actions even when failure/termination prevented another model request.
  const native=row.profile==='kodo'?kodoTools.map(c=>({id:c.request.id,name:c.name.replaceAll('.','_'),args:JSON.parse(c.request.arguments)})):row.profile==='pi'?(outcome.events??[]).filter(e=>e.type==='tool_execution_start').map(e=>({id:e.toolCallId,name:e.toolName,args:e.args})):(outcome.toolParts??[]).map(p=>({id:p.callID,name:p.tool,args:p.state.input}));
  for(const call of native)toolCalls.set(JSON.stringify([call.id,call.name,call.args]),call);
  const proposed=[...toolCalls.values()];
  const autonomy={
    offered:[...offered].filter(n=>/agent|task|inspect|wait/i.test(n)),
    proposed:proposed.filter(c=>/spawn_agent|agent_route|agent_search|agent_directory|list_agents|inspect_run|wait_for_events|send_message|^task$/.test(c.name)),
    actualKodo:kodoTools.filter(c=>/spawn_agent|agent.route|agent.search|agent.directory|list_agents|inspect_run|wait_for_events|send_message/.test(c.name)),
    children:details.filter(d=>d.run.parentId).map(d=>({id:d.run.id,parentId:d.run.parentId,status:d.run.status,objective:d.run.objective,scope:d.run.scope,text:d.text,tools:d.calls.filter(c=>c.kind==='tool').length})),
  };
  const verificationCalls=proposed.filter(c=>/bash|shell|powershell|process|exec/.test(c.name));
  const boundaryFlags=proposed.filter(c=>{
    const args=JSON.stringify(c.args).replaceAll('\\\\','/').replaceAll('\\','/');
    const privateRoots=['kernel','evaluation-source','control-','oracle-correction-controls'].some(n=>args.includes(normalizedRoot+'/'+n));
    const otherTrial=results.some(other=>other.id!==row.id&&args.includes(normalizedRoot+'/'+other.id+'/'));
    return privateRoots||otherTrial;
  });
  const hostSideEffects=verificationCalls.filter(c=>{
    const command=c.args?.command??'';
    return (/Get-Process\s+-Name\s+chrome/i.test(command)&&/Stop-Process\s+-Force/i.test(command))||/taskkill[^\n]*\/{1,2}IM\s+["']?chrome\.exe/i.test(command)||(/Get-CimInstance\s+Win32_Process/i.test(command)&&command.includes("'*serve.mjs*'")&&command.includes('Stop-Process'));
  });
  const parentGitMetadata=verificationCalls.filter(c=>/git\s+status/.test(c.args?.command??''));
  const entry={id:row.id,models:{requested:[...new Set(requests.map(r=>r.model))],responded:[...responseModels],outputLimits:[...new Set(requests.map(r=>r.output))],requests:requests.length,measuredRequests:stats.calls.filter(c=>c.usage).length,httpStatuses:stats.calls.map(c=>c.httpStatus),rejected:stats.rejected},autonomy,kodoFailedTools:kodoTools.filter(c=>c.status!=='succeeded'),verificationCalls,boundaryFlags,hostSideEffects,parentGitMetadata,finalText:outcome.text};
  audit.push(entry);
  console.log(JSON.stringify({id:row.id,requested:entry.models.requested,responded:entry.models.responded,usage:`${entry.models.measuredRequests}/${requests.length}`,output:entry.models.outputLimits,children:autonomy.children.length,coordinationCalls:autonomy.proposed.length,kodoFailedTools:entry.kodoFailedTools.length}));
}
await writeFile(path.join(root,'audit.json'),JSON.stringify(audit,null,2));
