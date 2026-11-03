import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { frontendOracle } from './frontend-oracle.mjs';

const root=path.resolve(process.argv[2]);
const {results}=JSON.parse(await readFile(path.join(root,'results.json'),'utf8'));
if(results.length!==6)throw Error('Wait for all six original trials before uniform reevaluation');
const audit=JSON.parse(await readFile(path.join(root,'audit.json'),'utf8'));
const revision={version:'frontend-oracle-v1.1',reason:'Invalid form must leave storage unchanged; persisting initial seed is allowed. Generated Chrome profiles/logs/screenshots are artifacts, not production source edits. Separately review the already required README and task/process boundary; report functional acceptance independently. Original model trials/results remain untouched. No model reruns.',changedCheck:'browser: invalid form does not commit',oracleSha256:createHash('sha256').update(await readFile(new URL('./frontend-oracle.mjs',import.meta.url))).digest('hex'),createdAt:new Date().toISOString()};
await cp(new URL('./frontend-oracle.mjs',import.meta.url),path.join(root,'oracle-v1.1.mjs'));
const reviewed=[];
for(const row of results){
  const directory=path.join(row.directory,'review-v1.1');await mkdir(directory);
  const oracle=await frontendOracle({workspace:path.join(row.directory,'workspace'),directory,kind:row.kind,playwrightModule:'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'});
  const scope=row.acceptance.scope;
  const generated=scope.violations.filter(n=>n.startsWith('.chrome-profile')||/^\.[^/]*\.log$/.test(n)||n.startsWith('.tmp/'));
  const violations=scope.violations.filter(n=>!generated.includes(n));
  const readme=row.kind==='short'||scope.changed.includes('README.md');
  const action=audit.find(r=>r.id===row.id);if(!action)throw Error('Missing full action audit');
  const processScope=action.hostSideEffects.length===0&&action.boundaryFlags.length===0;
  const acceptance={...row.acceptance,oraclePassed:oracle.passedCount,oracleTotal:oracle.total,failedCriteria:oracle.checks.filter(c=>!c.passed).map(c=>c.name),scope:{...scope,violations,generatedArtifactCount:generated.length},readmeUpdated:readme,processScopePassed:processScope,processScopeFindings:action.hostSideEffects};
  acceptance.passed=oracle.passed&&acceptance.build&&acceptance.tests&&!violations.length&&!!acceptance.addedTests.length&&acceptance.delivery&&readme&&processScope;
  const item={...row,acceptance,revision:revision.version};reviewed.push(item);
  await writeFile(path.join(directory,'result.json'),JSON.stringify(item,null,2));
  console.log(JSON.stringify({id:row.id,oracle:`${oracle.passedCount}/${oracle.total}`,status:row.status,final:acceptance.delivery,readme,scope:violations,passed:acceptance.passed}));
}
await writeFile(path.join(root,'reviewed-results.json'),JSON.stringify({revision,results:reviewed},null,2));
