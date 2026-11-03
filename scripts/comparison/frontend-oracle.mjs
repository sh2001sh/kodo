/* global document, window, localStorage, innerWidth */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, URL } from 'node:url';
import path from 'node:path';
import { seed } from './frontend-cases.mjs';

// Held out of model workspaces. Uses Playwright's library, never @playwright/test.
export async function frontendOracle({workspace,directory,kind,playwrightModule}) {
  const checks=[];const errors=[];
  const check=async(name,fn)=>{try{const evidence=await fn();checks.push({name,passed:true,...(evidence===undefined?{}:{evidence})});}catch(error){checks.push({name,passed:false,error:error.message.slice(0,1800)});}};
  const model=await import(pathToFileURL(path.join(workspace,'src/model.js')).href+'?oracle='+Date.now()).catch(()=>({}));
  if(kind==='long'){
    await check('domain: combined case-insensitive search/status',()=>assert.deepEqual(model.selectTickets(seed,{query:'  aLeX ',status:'todo'}).map(t=>t.id),['r09','r02']));
    await check('domain: priority/due order and immutable input',()=>{const input=globalThis.structuredClone(seed);assert.deepEqual(model.selectTickets(input,{sort:'due'}).map(t=>t.id),['r03','r05','r01','r04','r08','r06','r09','r02','r07','r10','r11','r12']);assert.deepEqual(input,seed);assert.notEqual(model.selectTickets(input),input);});
    await check('domain: global summary',()=>assert.deepEqual(model.summarize(seed),{total:12,todo:5,doing:4,done:3}));
    await check('domain: valid draft and 80-character boundary',()=>{assert.deepEqual(model.validateDraft({...seed[0],title:'a'.repeat(80)}),{});assert.ok(model.validateDraft({...seed[0],title:'a'.repeat(81)}).title);assert.ok(model.validateDraft({...seed[0],title:'   '}).title);});
    await check('domain: required owner, enums and real calendar dates',()=>{for(const [field,value] of [['owner',' '],['priority','urgent'],['status','other'],['due','2026-02-30'],['due','bad']])assert.ok(model.validateDraft({...seed[0],[field]:value})[field],field+':'+value);assert.deepEqual(model.validateDraft({...seed[0],due:'2028-02-29'}),{});});
    const storage=await import(pathToFileURL(path.join(workspace,'src/storage.js')).href+'?oracle='+Date.now()).catch(()=>({}));
    await check('storage: missing, valid, malformed and wrong shape',()=>{const load=raw=>storage.loadTickets({getItem:()=>raw},seed);assert.deepEqual(load(null),{tickets:seed,recovered:false});assert.deepEqual(load(JSON.stringify([seed[0]])),{tickets:[seed[0]],recovered:false});for(const raw of ['{broken','{}','[null]','[{"id":"x"}]'])assert.deepEqual(load(raw),{tickets:seed,recovered:true},raw);});
  }else{
    await check('pagination: search across all pages',()=>{const r=model.pageItems(seed,{query:'  aLeX '});assert.deepEqual(r.items.map(t=>t.id),['r02','r04','r09']);assert.equal(r.total,3);assert.equal(r.pageCount,1);});
    await check('pagination: later pages and source immutability',()=>{const input=globalThis.structuredClone(seed);const r=model.pageItems(input,{page:2,pageSize:5});assert.deepEqual(r.items.map(t=>t.id),seed.slice(5,10).map(t=>t.id));assert.deepEqual(input,seed);assert.equal(r.total,12);assert.equal(r.pageCount,3);});
    await check('pagination: filter before slice, title search',()=>{const r=model.pageItems(seed,{query:'a',page:2,pageSize:2});const all=seed.filter(t=>(t.title+' '+t.owner).toLowerCase().includes('a'));assert.deepEqual(r.items.map(t=>t.id),all.slice(2,4).map(t=>t.id));assert.equal(r.total,all.length);assert.equal(model.pageItems(seed,{query:'发布登录'}).items[0].id,'r01');});
    await check('pagination: empty input and empty matches',()=>{for(const items of [seed,[]]){const r=model.pageItems(items,{query:'no-such-ticket',page:99});assert.deepEqual(r,{items:[],total:0,page:1,pageCount:1});}});
    await check('pagination: clamp/floor/non-finite page',()=>{for(const [value,expected] of [[-8,1],[0,1],[2.9,2],[999,3],[NaN,1],[Infinity,1]])assert.equal(model.pageItems(seed,{page:value}).page,expected,String(value));});
    await check('pagination: pageSize normalization',()=>{for(const [value,size] of [[0,1],[-2,1],[2.9,2],[NaN,5],[Infinity,5]]){const r=model.pageItems(seed,{pageSize:value});assert.equal(r.items.length,size,String(value));assert.equal(r.pageCount,Math.ceil(12/size));}});
  }
  const server=createServer(async(req,res)=>{
    const requestPath=new URL(req.url,'http://local').pathname;
    if(requestPath==='/favicon.ico'){res.writeHead(204);res.end();return;}
    const file=path.resolve(workspace,'.'+decodeURIComponent(requestPath==='/'?'/index.html':requestPath));
    if(!file.startsWith(workspace+path.sep)){res.writeHead(403);res.end();return;}
    try{res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'})[path.extname(file)]??'text/plain');res.end(await readFile(file));}catch{res.writeHead(404);res.end('Missing');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let browser;
  try{
    const {chromium}=await import(pathToFileURL(playwrightModule).href);
    browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();page.setDefaultTimeout(1800);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    const url=`http://127.0.0.1:${server.address().port}`;const $=id=>page.getByTestId(id);const ids=()=> $('ticket-card').evaluateAll(els=>els.map(el=>el.dataset.id));
    const open=async()=>{await page.goto(url);await page.waitForTimeout(160);};
    const reset=async(raw)=>{await page.evaluate(raw=>{localStorage.clear();if(raw!==null)localStorage.setItem('relay.tickets.v1',raw);},raw??null);await open();};
    await open();
    if(kind==='long'){
      await check('browser: initial 12 records and global statistics',async()=>{assert.equal((await ids()).length,12);for(const [k,v] of Object.entries({total:12,todo:5,doing:4,done:3}))assert.equal((await $('summary-'+k).innerText()).trim(),String(v));});
      await check('browser: combined filters and unchanged statistics',async()=>{await $('search').fill('  aLeX ');await $('status-filter').selectOption('todo');assert.deepEqual(await ids(),['r09','r02']);assert.equal((await $('summary-total').innerText()).trim(),'12');});
      await check('browser: empty state and reset',async()=>{await $('search').fill('no-such-ticket');assert.ok(await $('empty-state').isVisible());assert.equal((await ids()).length,0);await $('reset-filters').click();assert.equal((await ids()).length,12);});
      await check('browser: due sorting',async()=>{await reset();await $('sort').selectOption('due');assert.deepEqual((await ids()).slice(0,3),['r03','r05','r01']);});
      await check('browser: dialog focus, Escape and return focus',async()=>{await reset();await $('new-ticket').click();assert.ok(await $('ticket-dialog').isVisible());assert.ok(await $('ticket-dialog').evaluate(el=>el.contains(document.activeElement)));await page.keyboard.press('Escape');assert.ok(!(await $('ticket-dialog').isVisible()));assert.ok(await $('new-ticket').evaluate(el=>el===document.activeElement));});
      await check('browser: invalid form does not commit',async()=>{await reset();await $('new-ticket').click();await $('form-title').fill('   ');await $('form-owner').fill('');const before=await page.evaluate(()=>localStorage.getItem('relay.tickets.v1'));await $('submit-ticket').click();assert.ok(await $('ticket-dialog').isVisible());assert.ok((await $('dialog-errors').innerText()).trim().length>0);assert.equal(await page.evaluate(()=>localStorage.getItem('relay.tickets.v1')),before);await $('cancel-ticket').click();assert.equal((await ids()).length,12);});
      await check('browser: create, text escaping, summary and refresh persistence',async()=>{await reset();await $('new-ticket').click();await $('form-title').fill(' <img src=x onerror="window.pwned=1"> ');await $('form-owner').fill(' 新成员 ');await $('form-priority').selectOption('high');await $('form-status').selectOption('todo');await $('form-due').fill('2026-12-15');await $('submit-ticket').click();assert.ok(!(await $('ticket-dialog').isVisible()));assert.equal((await ids()).length,13);assert.equal(await page.evaluate(()=>window.pwned??0),0);assert.ok((await $('ticket-card').allTextContents()).some(t=>t.includes('<img src=x')));assert.equal((await $('summary-total').innerText()).trim(),'13');await open();assert.equal((await ids()).length,13);const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('relay.tickets.v1')));assert.equal(stored.find(t=>t.owner==='新成员').title,'<img src=x onerror="window.pwned=1">');});
      await check('browser: edit status updates data, counters and persists',async()=>{await reset();await $('ticket-card').filter({has:page.locator('[data-testid="open-ticket"]')}).filter({hasText:'发布登录改版'}).getByTestId('open-ticket').click();await $('form-title').fill('登录发布已验收');await $('form-status').selectOption('done');await $('submit-ticket').click();assert.equal((await $('summary-doing').innerText()).trim(),'3');assert.equal((await $('summary-done').innerText()).trim(),'4');await open();assert.ok((await $('ticket-card').allTextContents()).some(t=>t.includes('登录发布已验收')));const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('relay.tickets.v1')));assert.equal(stored.find(t=>t.id==='r01').status,'done');});
      await check('browser: malformed persisted state recovers visibly',async()=>{await reset('{broken');assert.equal((await ids()).length,12);assert.ok(await $('storage-warning').isVisible());});
      await check('browser: invalid persisted array recovers visibly',async()=>{await reset('[null]');assert.equal((await ids()).length,12);assert.ok(await $('storage-warning').isVisible());});
    }else{
      await check('browser: initial pagination and next/previous',async()=>{assert.deepEqual(await ids(),seed.slice(0,5).map(t=>t.id));await $('next').click();assert.deepEqual(await ids(),seed.slice(5,10).map(t=>t.id));await $('prev').click();assert.deepEqual(await ids(),seed.slice(0,5).map(t=>t.id));});
      await check('browser: full-list search counts and disabled pagination',async()=>{await $('search').fill(' Alex ');assert.deepEqual(await ids(),['r02','r04','r09']);assert.equal((await $('total').innerText()).trim(),'3');assert.equal((await $('page-info').innerText()).trim(),'1 / 1');assert.ok(await $('next').isDisabled());});
      await check('browser: search after last page resets/clamps page',async()=>{await $('search').fill('');await $('next').click();await $('next').click();assert.equal((await $('page-info').innerText()).trim(),'3 / 3');await $('search').fill('Sam');assert.deepEqual(await ids(),['r06','r08','r11']);assert.equal((await $('page-info').innerText()).trim(),'1 / 1');});
      await check('browser: no matches displays empty state',async()=>{await $('search').fill('no-such-ticket');assert.ok(await $('empty-state').isVisible());assert.equal((await ids()).length,0);assert.equal((await $('total').innerText()).trim(),'0');assert.equal((await $('page-info').innerText()).trim(),'1 / 1');});
    }
    await reset();
    await check('browser: desktop no horizontal overflow',async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)));
    await page.screenshot({path:path.join(directory,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await check('browser: mobile 390px no horizontal overflow',async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)));
    if(kind==='long')await check('browser: mobile dialog remains usable',async()=>{await $('new-ticket').click();const box=await $('ticket-dialog').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=390);await $('form-title').fill('移动端事项');await $('cancel-ticket').click();});
    await page.screenshot({path:path.join(directory,'mobile.png'),fullPage:true});
    await writeFile(path.join(directory,'page.html'),await page.content());
    await writeFile(path.join(directory,'accessibility-snapshot.txt'),await page.locator('body').ariaSnapshot());
    await check('browser: no console/runtime errors',()=>assert.deepEqual(errors,[]));
    await context.close();
  }catch(error){checks.push({name:'browser: infrastructure',passed:false,error:error.message});}
  finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  const result={checks,passed:checks.every(c=>c.passed),passedCount:checks.filter(c=>c.passed).length,total:checks.length,errors};
  await writeFile(path.join(directory,'oracle.json'),JSON.stringify(result,null,2));return result;
}
