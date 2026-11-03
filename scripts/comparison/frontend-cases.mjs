import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const seed = [
  ['r01','发布登录改版','林悦','doing','high','2026-11-03'],
  ['r02','Billing export','Alex','todo','medium','2026-11-08'],
  ['r03','移动端导航','周宁','done','low','2026-11-01'],
  ['r04','Search index','Alex','doing','high','2026-11-04'],
  ['r05','无障碍审查','林悦','todo','high','2026-11-02'],
  ['r06','API docs','Sam','done','medium','2026-11-06'],
  ['r07','通知中心','周宁','todo','low','2026-11-09'],
  ['r08','Cache metrics','Sam','doing','medium','2026-11-05'],
  ['r09','Release checklist','Alex','todo','high','2026-11-07'],
  ['r10','主题设置','林悦','done','low','2026-11-10'],
  ['r11','Audit trail','Sam','todo','medium','2026-11-11'],
  ['r12','Dashboard polish','周宁','doing','low','2026-11-12'],
].map(([id,title,owner,status,priority,due])=>({id,title,owner,status,priority,due}));

const contract = `# Relay 前端任务约定

这是一个零依赖、原生 ES modules 的前端。Node 24 已安装；不要联网安装包。只读写当前工作区，不读父目录源码、宿主配置、其他试验、评测程序。无需调用外部模型。依赖此任务自身即可运行。

- npm start：静态服务器，默认 4173；可用 PORT 环境变量设置端口。
- npm run build：检查所有 src/*.js 语法和入口文件；npm test：node --test tests/*.test.mjs。
- data/seed.json 是固定初始数据，不得修改。package.json、scripts/、tests/baseline.test.mjs、START_HERE.md 不得修改。可新增测试，生产代码限 index.html、src/。
- 不向用户提问，自行做合理实现选择，执行验证，最后简要说明完成项、验证结果和剩余问题。
`;
export const longObjective = `把现有 Relay 雏形做成可交付的“项目发布台”，面向小团队管理发布事项。先读 START_HERE.md。请同时完成以下要求：
1. 精致、清晰的中文主界面：品牌和导航、页头、四个统计卡（总数/待办/进行中/已完成）、筛选工具栏、事项列表、状态/优先级/负责人/日期。桌面 1440px 与手机 390px 均可用，无整页横向溢出；按钮/表单有可访问名称、明显焦点。可自行选择布局与视觉风格，不依赖外部图片、字体或网络。
2. 根据 data/seed.json 首次加载12条事项。标题和负责人支持去首尾空格、不区分英文大小写的搜索；状态筛选 all/todo/doing/done；二者取交集。排序 priority（high→medium→low，同优先级按id升序）或 due（日期升序，同日期按id）。空结果有说明和重置入口。统计始终基于全部事项，不随筛选变化。
3. 新建事项，编辑已有事项（包括状态）。标题去空格后1..80字符，负责人必填，优先级/状态为有效枚举，日期为真实 YYYY-MM-DD；错误显示给用户且不写入。成功后列表/统计即时更新，localStorage键 relay.tickets.v1 持久化。刷新保持结果；损坏JSON或非事项数组时恢复种子数据并显示恢复提示。用户字符串按文本渲染，不执行HTML。
4. 新建/编辑使用对话框，打开移入焦点，Escape关闭并返回触发按钮。至少新增覆盖过滤/排序/校验/损坏数据的自动化测试，运行 build 和 test，README说明运行与实现边界。
5. 保持以下公开接口，以便集成：src/model.js 导出 selectTickets(tickets,{query='',status='all',sort='priority'}={})（返回新数组、不修改入参）、summarize(tickets)（返回 {total,todo,doing,done}）、validateDraft(draft)（返回字段名到错误文本的对象，合法返回{}）。src/storage.js 导出 loadTickets(storage,seed) 返回 {tickets,recovered}，storage为标准getItem/setItem对象。
6. 页面集成标记 data-testid：search、status-filter、sort、summary-total、summary-todo、summary-doing、summary-done；每张事项 ticket-card 且 data-id=事项id，卡内 open-ticket 按钮；new-ticket；dialog= ticket-dialog（原生dialog或role=dialog均可）；对话框内 form-title/form-owner/form-priority/form-due/form-status、submit-ticket、cancel-ticket、dialog-errors；empty-state、reset-filters；恢复提示 storage-warning。统计标记文本只包含数字。`;
export const shortObjective = `修复发布事项分页：当前页面在搜索之前分页，导致搜索“Alex”时只找到部分记录，页数与空态也错误。先读 START_HERE.md。只修改 src/model.js，可新增 tests/*.test.mjs，不修改其他已有文件。pageItems(items,{query='',page=1,pageSize=5}={}) 应先按标题或负责人搜索（去空格、不区分大小写），再分页，返回 {items,total,page,pageCount}；total是匹配数；pageCount至少1；page向下取整并夹在1..pageCount；非有限数page按1；pageSize向下取整且至少1，非有限数按5。不修改输入数组。保持现有界面和空结果提示，添加回归及边界测试并执行 build 和 test。`;

const baseModel = `export function selectTickets(tickets){return [...tickets];}
export function summarize(tickets){return {total:tickets.length,todo:0,doing:0,done:0};}
export function validateDraft(){return {};}
`;
export const referenceModel = `export function selectTickets(tickets,{query='',status='all',sort='priority'}={}){
const q=query.trim().toLowerCase();const ranks={high:0,medium:1,low:2};
return tickets.filter(t=>(status==='all'||t.status===status)&&(!q||(t.title+' '+t.owner).toLowerCase().includes(q))).sort((a,b)=>(sort==='due'?a.due.localeCompare(b.due):ranks[a.priority]-ranks[b.priority])||a.id.localeCompare(b.id));}
export function summarize(tickets){return {total:tickets.length,todo:tickets.filter(t=>t.status==='todo').length,doing:tickets.filter(t=>t.status==='doing').length,done:tickets.filter(t=>t.status==='done').length};}
export function validateDraft(d){const e={};if(typeof d.title!=='string'||!d.title.trim()||d.title.trim().length>80)e.title='标题1..80字';if(typeof d.owner!=='string'||!d.owner.trim())e.owner='负责人必填';if(!['high','medium','low'].includes(d.priority))e.priority='无效优先级';if(!['todo','doing','done'].includes(d.status))e.status='无效状态';if(typeof d.due!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(d.due)||!Number.isFinite(Date.parse(d.due))||new Date(d.due).toISOString().slice(0,10)!==d.due)e.due='无效日期';return e;}
`;
export const referenceStorage = `import {validateDraft} from './model.js';
export function loadTickets(storage,seed){try{const raw=storage.getItem('relay.tickets.v1');if(raw===null)return {tickets:structuredClone(seed),recovered:false};const tickets=JSON.parse(raw);if(!Array.isArray(tickets)||tickets.some(t=>!t||typeof t.id!=='string'||Object.keys(validateDraft(t)).length))throw Error('invalid');return {tickets,recovered:false};}catch{return {tickets:structuredClone(seed),recovered:true};}}
`;
export const referencePage = `export function pageItems(items,{query='',page=1,pageSize=5}={}){const q=query.trim().toLowerCase();const size=Number.isFinite(pageSize)?Math.max(1,Math.floor(pageSize)):5;const filtered=items.filter(t=>(t.title+' '+t.owner).toLowerCase().includes(q));const total=filtered.length;const pageCount=Math.max(1,Math.ceil(total/size));const current=Math.max(1,Math.min(pageCount,Number.isFinite(page)?Math.floor(page):1));return {items:filtered.slice((current-1)*size,current*size),total,page:current,pageCount};}
`;
const brokenPage = `export function pageItems(items,{query='',page=1,pageSize=5}={}){const q=query.trim().toLowerCase();return {items:items.slice((page-1)*pageSize,page*pageSize).filter(t=>(t.title+' '+t.owner).toLowerCase().includes(q)),total:items.length,page,pageCount:Math.ceil(items.length/pageSize)};}
`;
const shortApp = `import {pageItems} from './model.js';
const tickets=await fetch('/data/seed.json').then(r=>r.json());let page=1;const $=id=>document.querySelector('[data-testid="'+id+'"]');
function render(){const result=pageItems(tickets,{query:$('search').value,page});page=result.page;$('results').replaceChildren(...result.items.map(t=>{const li=document.createElement('li');li.dataset.testid='ticket-card';li.dataset.id=t.id;li.textContent=t.title+' · '+t.owner;return li;}));$('total').textContent=result.total;$('page-info').textContent=result.page+' / '+result.pageCount;$('empty-state').hidden=result.items.length!==0;$('prev').disabled=page<=1;$('next').disabled=page>=result.pageCount;}
$('search').addEventListener('input',()=>{page=1;render();});$('prev').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};render();
`;
export const referenceApp = `import {selectTickets,summarize,validateDraft} from './model.js';import {loadTickets} from './storage.js';
const seed=await fetch('/data/seed.json').then(r=>r.json());const loaded=loadTickets(localStorage,seed);let tickets=loaded.tickets;let editing;let trigger;
const $=id=>document.querySelector('[data-testid="'+id+'"]');const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(){const stats=summarize(tickets);for(const k of ['total','todo','doing','done'])$('summary-'+k).textContent=stats[k];const shown=selectTickets(tickets,{query:$('search').value,status:$('status-filter').value,sort:$('sort').value});$('results').innerHTML=shown.map(t=>'<article data-testid="ticket-card" data-id="'+esc(t.id)+'"><button data-testid="open-ticket">'+esc(t.title)+'</button><p>'+esc(t.owner)+' · '+esc(t.status)+' · '+esc(t.priority)+' · '+esc(t.due)+'</p></article>').join('');$('empty-state').hidden=shown.length>0;for(const el of document.querySelectorAll('[data-testid="open-ticket"]'))el.onclick=()=>open(tickets.find(t=>t.id===el.closest('article').dataset.id),el);}
function open(t,button){editing=t?.id;trigger=button;const d=t??{title:'',owner:'',priority:'medium',status:'todo',due:'2026-11-15'};for(const k of ['title','owner','priority','status','due'])$('form-'+k).value=d[k];$('dialog-errors').textContent='';$('ticket-dialog').showModal();$('form-title').focus();}
function close(){$('ticket-dialog').close();trigger?.focus();}
$('ticket-dialog').addEventListener('cancel',e=>{e.preventDefault();close();});$('cancel-ticket').onclick=close;$('new-ticket').onclick=e=>open(null,e.currentTarget);
$('ticket-form').onsubmit=e=>{e.preventDefault();const draft=Object.fromEntries(['title','owner','priority','status','due'].map(k=>[k,$('form-'+k).value]));const errors=validateDraft(draft);$('dialog-errors').textContent=Object.values(errors).join('；');if(Object.keys(errors).length)return;draft.title=draft.title.trim();draft.owner=draft.owner.trim();const next={...draft,id:editing??crypto.randomUUID()};tickets=editing?tickets.map(t=>t.id===editing?next:t):[...tickets,next];localStorage.setItem('relay.tickets.v1',JSON.stringify(tickets));close();render();};
for(const k of ['search','status-filter','sort'])$(k).addEventListener(k==='search'?'input':'change',render);$('reset-filters').onclick=()=>{$('search').value='';$('status-filter').value='all';render();};$('storage-warning').hidden=!loaded.recovered;render();
`;
const longHTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay 项目发布台</title><link rel="stylesheet" href="/src/style.css"><body><header>Relay</header><main><h1>项目发布台</h1><p>从想法到发布</p><section class="stats">${['total','todo','doing','done'].map((k,i)=>`<div>${['总数','待办','进行中','已完成'][i]} <strong data-testid="summary-${k}">0</strong></div>`).join('')}</section><p data-testid="storage-warning" hidden>本地数据损坏，已恢复初始事项</p><div class="toolbar"><label>搜索<input data-testid="search" aria-label="搜索事项"></label><label>状态<select data-testid="status-filter"><option value="all">全部</option><option value="todo">待办</option><option value="doing">进行中</option><option value="done">已完成</option></select></label><label>排序<select data-testid="sort"><option value="priority">优先级</option><option value="due">截止日期</option></select></label><button data-testid="new-ticket">新建事项</button></div><section data-testid="results"></section><div data-testid="empty-state" hidden>没有匹配事项<button data-testid="reset-filters">重置筛选</button></div></main><dialog data-testid="ticket-dialog"><form data-testid="ticket-form" novalidate><h2>事项</h2><label>标题<input data-testid="form-title"></label><label>负责人<input data-testid="form-owner"></label><label>优先级<select data-testid="form-priority"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label><label>状态<select data-testid="form-status"><option value="todo">待办</option><option value="doing">进行中</option><option value="done">已完成</option></select></label><label>截止日期<input type="date" data-testid="form-due"></label><p data-testid="dialog-errors" role="alert"></p><button data-testid="submit-ticket" type="submit">保存</button><button data-testid="cancel-ticket" type="button">取消</button></form></dialog><script type="module" src="/src/app.js"></script></body></html>`;
const shortHTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay 事项列表</title><link rel="stylesheet" href="/src/style.css"><body><main><h1>发布事项</h1><label>搜索标题或负责人<input data-testid="search"></label><p>共 <span data-testid="total"></span> 条</p><ul data-testid="results"></ul><p data-testid="empty-state" hidden>没有匹配事项</p><nav aria-label="分页"><button data-testid="prev">上一页</button><span data-testid="page-info"></span><button data-testid="next">下一页</button></nav></main><script type="module" src="/src/app.js"></script></body></html>`;
const style = `*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#172132;font:16px/1.5 system-ui}header{padding:20px;background:#132d43;color:white}main{max-width:1100px;margin:auto;padding:24px}.stats,.toolbar{display:flex;gap:16px;flex-wrap:wrap}.stats>div,article{padding:16px;background:white;border:1px solid #dce1e7;border-radius:10px;margin:12px 0}input,select,button{font:inherit;padding:10px;border:1px solid #8d98a5;border-radius:6px;max-width:100%}button{cursor:pointer;background:#fff}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #087bcb;outline-offset:2px}label{display:flex;flex-direction:column;gap:4px}dialog{max-width:calc(100vw - 24px);width:430px;border:0;border-radius:12px;padding:24px}dialog::backdrop{background:#10203088}form{display:grid;gap:12px}[hidden]{display:none!important}@media(max-width:600px){main{padding:16px}.toolbar{flex-direction:column}.stats>div{flex:1 1 40%}}`;
export async function prepareFrontend(workspace, kind, reference=false) {
  await mkdir(workspace,{recursive:true});
  const files={
    'package.json':JSON.stringify({name:'relay-frontend-fixture',version:'1.0.0',private:true,type:'module',scripts:{start:'node scripts/serve.mjs',build:'node scripts/check.mjs',test:'node --test tests/*.test.mjs'}},null,2),
    'data/seed.json':JSON.stringify(seed,null,2),
    'START_HERE.md':contract,
    'README.md':'# Relay\n零依赖前端雏形。npm start / npm run build / npm test。\n',
    'index.html':kind==='long'?longHTML:shortHTML,
    'src/style.css':style,
    'src/model.js':kind==='long'?(reference?referenceModel:baseModel):(reference?referencePage:brokenPage),
    'src/app.js':kind==='long'?(reference?referenceApp:`import {selectTickets,summarize} from './model.js';\nconst tickets=await fetch('/data/seed.json').then(r=>r.json());const stats=summarize(tickets);for(const k of ['total','todo','doing','done'])document.querySelector('[data-testid="summary-'+k+'"]').textContent=stats[k];document.querySelector('[data-testid="results"]').textContent=selectTickets(tickets).map(t=>t.title).join(' · ');`):shortApp,
    'scripts/serve.mjs':`import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import path from 'node:path';const root=process.cwd();const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};createServer(async(req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname==='/'?'/index.html':new URL(req.url,'http://local').pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}try{res.setHeader('Content-Type',types[path.extname(file)]??'text/plain');res.end(await readFile(file));}catch{res.writeHead(404);res.end('Not found');}}).listen(Number(process.env.PORT??4173),'127.0.0.1',()=>console.log('Relay ready'));`,
    'scripts/check.mjs':`import {readdir,readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';await readFile('index.html');for(const f of await readdir('src'))if(f.endsWith('.js')){const p=spawnSync(process.execPath,['--check','src/'+f],{encoding:'utf8'});if(p.status!==0){console.error(p.stderr);process.exit(1);}}console.log('Frontend syntax build passed');`,
    'tests/baseline.test.mjs':kind==='long'?`import {test} from 'node:test';import assert from 'node:assert/strict';import {selectTickets,summarize,validateDraft} from '../src/model.js';test('public exports preserve empty list',()=>{assert.deepEqual(selectTickets([]),[]);assert.equal(summarize([]).total,0);assert.equal(typeof validateDraft({}), 'object');});`:`import {test} from 'node:test';import assert from 'node:assert/strict';import {pageItems} from '../src/model.js';test('first page retains basic shape',()=>{const r=pageItems([{id:'a',title:'Alpha',owner:'Lin'}]);assert.equal(r.items[0].id,'a');assert.equal(r.total,1);assert.equal(r.page,1);assert.equal(r.pageCount,1);});`,
  };
  if(kind==='long')files['src/storage.js']=reference?referenceStorage:`export function loadTickets(storage,seed){return {tickets:structuredClone(seed),recovered:false};}\n`;
  for(const [name,content] of Object.entries(files)){await mkdir(path.dirname(path.join(workspace,name)),{recursive:true});await writeFile(path.join(workspace,name),content,'utf8');}
  return files;
}
