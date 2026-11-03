import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectMcp } from '../src/extensions/mcp.js';
import type { ToolExecutionContext } from '../src/tools/registry.js';

it.skipIf(process.platform !== 'win32')('runs an actual MCP server in Windows AppContainer and denies private, outside and readonly writes', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodo-mcp-native-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'kodo-mcp-outside-'));
  const outsideFile = path.join(outside, 'secret.txt');
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    await writeFile(path.join(workspace, 'allowed.txt'), 'allowed');
    await writeFile(path.join(workspace, '.env'), 'private');
    await writeFile(outsideFile, 'outside');
    const server = path.join(workspace, 'server.mjs');
    await writeFile(server, `import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const denied=(fn)=>{try{fn();return false;}catch{return true;}};
createInterface({input:process.stdin}).on('line', line=>{
const m=JSON.parse(line);if(!m.id)return;
let result;
if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};
else if(m.method==='tools/list')result={tools:[{name:'probe',inputSchema:{type:'object'}}]};
else result={content:[{type:'text',text:JSON.stringify({allowed:readFileSync('allowed.txt','utf8'),privateDenied:denied(()=>readFileSync('.env')),outsideDenied:denied(()=>readFileSync(m.params.arguments.outside)),writeDenied:denied(()=>writeFileSync('forbidden.txt','bad'))})}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
    connection = await connectMcp({ id: 'native', transport: 'stdio', command: process.execPath, args: [server], sandbox: { workspace }, timeoutMs: 30000, tools: { probe: { permission: 'read', effect: 'read' } } });
    const context = { run: {}, session: { workspace, permissions: ['read'] }, signal: new AbortController().signal, markEffectStarted() {} } as unknown as ToolExecutionContext;
    const result = await connection.tools[0]!.execute(context, { outside: outsideFile }) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toEqual({ allowed: 'allowed', privateDenied: true, outsideDenied: true, writeDenied: true });
    await connection.close();
    connection = undefined;
    expect(await readFile(path.join(workspace, '.env'), 'utf8')).toBe('private');
    await expect(readFile(path.join(workspace, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await connection?.close(); await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
}, 60000);
