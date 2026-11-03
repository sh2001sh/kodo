// Reads each harness's own session records after a trial: exports them as plain JSONL under process/native/
// and extracts per-tool-call start/end times, so tool execution can be separated from harness overhead.
import { Buffer } from 'node:buffer';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const sqlite = async () => (await import('node:sqlite')).DatabaseSync;
const lines = text => text.split(/\r?\n/u).filter(Boolean);
const parse = line => { try { return JSON.parse(line); } catch { return null; } };
const files = (directory, pattern) => existsSync(directory) ? readdirSync(directory, { recursive: true }).map(String).filter(name => pattern.test(name)).map(name => path.join(directory, name)) : [];

/** DeepSeek Harness appends one zstd frame per flush; decode each frame and concatenate. */
export function decodeZstdFrames(buffer) {
  const starts = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset++) if (buffer.readUInt32LE(offset) === 0xFD2FB528) starts.push(offset);
  starts.push(buffer.length);
  const parts = [];
  for (let index = 0, from = 0; index < starts.length - 1; index++) {
    // A magic number can occur inside compressed data; extend the frame until it decodes.
    try { parts.push(zstdDecompressSync(buffer.subarray(starts[from], starts[index + 1]))); from = index + 1; } catch { /* keep extending */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

async function kodo(state) {
  const file = path.join(state, 'kodo', 'kodo.sqlite');
  if (!existsSync(file)) return { exports: {}, tools: [] };
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const events = db.prepare('select seq, time, run_id as runId, type, data from events order by seq').all().map(row => ({ ...row, data: parse(row.data) }));
    const calls = db.prepare('select data from calls').all().map(row => parse(row.data));
    const started = new Map();
    const tools = [];
    for (const event of events) {
      if (event.type === 'tool.started') started.set(event.data.callId, Date.parse(event.time));
      if (event.type === 'tool.finished') {
        const callId = String(event.data.callId);
        tools.push({ runId: event.runId, callId: callId.slice(callId.indexOf(':') + 1), name: event.data.name, startMs: started.get(event.data.callId) ?? null, endMs: Date.parse(event.time), status: event.data.status ?? null });
      }
    }
    return { exports: { 'kodo-events.jsonl': events, 'kodo-calls.jsonl': calls }, tools };
  } finally { db.close(); }
}

async function opencode(state) {
  const [file] = files(path.join(state, 'opencode'), /opencode\.db$/u);
  if (!file) return { exports: {}, tools: [] };
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const messages = db.prepare('select id, time_created as created, data from message order by time_created').all().map(row => ({ ...row, data: parse(row.data) }));
    const parts = db.prepare('select id, message_id as messageId, time_created as created, data from part order by time_created').all().map(row => ({ ...row, data: parse(row.data) }));
    const tools = parts.filter(part => part.data?.type === 'tool').map(({ data }) => ({ callId: data.callID, name: data.tool, startMs: data.state?.time?.start ?? null, endMs: data.state?.time?.end ?? null, status: data.state?.status ?? null }));
    return { exports: { 'opencode-messages.jsonl': messages, 'opencode-parts.jsonl': parts }, tools };
  } finally { db.close(); }
}

function dsh(state) {
  const [file] = files(path.join(state, 'dsh', 'sessions'), /session\.v4\.jsonl\.zstd$/u);
  if (!file) return { exports: {}, tools: [] };
  const records = lines(decodeZstdFrames(readFileSync(file))).map(parse).filter(Boolean);
  const names = new Map(records.filter(record => record.type === 'tool/call').map(record => [record.data.callId, record.data.name]));
  const tools = records.filter(record => record.type === 'job/settled' && record.data?.toolCall?.callId).map(record => ({
    callId: record.data.toolCall.callId, name: names.get(record.data.toolCall.callId) ?? record.data.kind, startMs: record.data.startedAt ?? null, endMs: record.time, status: record.data.status ?? record.data.outcome ?? null,
  }));
  return { exports: { 'dsh-session.jsonl': records }, tools };
}

/** Pi's JSON event stream has no clock; the recorder's docker timestamps supply it. */
function pi(state, processDir) {
  const exports = {};
  const tools = [];
  const timestamped = path.join(processDir, 'agent.timestamped.log');
  if (existsSync(timestamped)) {
    const started = new Map();
    for (const line of lines(readFileSync(timestamped, 'utf8'))) {
      const space = line.indexOf(' ');
      const at = Date.parse(line.slice(0, space));
      const event = parse(line.slice(space + 1));
      if (!event || Number.isNaN(at)) continue;
      if (event.type === 'tool_execution_start') started.set(event.toolCallId, { at, name: event.toolName });
      if (event.type === 'tool_execution_end') tools.push({ callId: event.toolCallId, name: started.get(event.toolCallId)?.name ?? event.toolName, startMs: started.get(event.toolCallId)?.at ?? null, endMs: at, status: event.isError ? 'error' : 'completed' });
    }
  }
  return { exports, tools, copy: files(path.join(state, 'pi-sessions'), /\.jsonl$/u) };
}

/** Writes process/native/* and process/tools.jsonl for one cell; returns the tool timings. */
export async function exportNative(cellDir, harness) {
  const state = path.join(cellDir, 'state');
  const processDir = path.join(cellDir, 'process');
  const nativeDir = path.join(processDir, 'native');
  await mkdir(nativeDir, { recursive: true });
  const reader = { kodo, opencode, dsh, pi }[harness];
  if (!reader) throw new Error(`no native reader for ${harness}`);
  const result = await reader(state, processDir);
  for (const [name, rows] of Object.entries(result.exports)) await writeFile(path.join(nativeDir, name), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  for (const file of result.copy ?? []) await copyFile(file, path.join(nativeDir, `pi-${path.basename(file)}`));
  await writeFile(path.join(processDir, 'tools.jsonl'), result.tools.map(tool => JSON.stringify(tool)).join('\n') + (result.tools.length ? '\n' : ''));
  return result.tools;
}
