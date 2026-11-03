'use strict';
// This preload changes Node's pipe transport only. Node still normalizes spawn
// options, constructs ChildProcess streams and owns its JSON/advanced IPC codec.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const addon = require('./node-pipes.node');
const directory = process.env.KODO_PIPE_DIRECTORY;
if (process.platform !== 'win32' || !directory || !path.isAbsolute(directory)) throw new Error('KODO_PIPE_BROKER: a host pipe directory is required');
// The N-API surface is stable, but this transport also uses Node's private
// Process/PipeWrap and libuv's Windows IPC peer field. Bind to the exact runtime.
if (addon.nodeVersion !== process.version || addon.uvVersion !== process.versions.uv) throw Object.assign(new Error(`KODO_PIPE_UNAVAILABLE: addon built for ${addon.nodeVersion}/libuv ${addon.uvVersion}; rebuild for ${process.version}/libuv ${process.versions.uv}`), { code: 'KODO_PIPE_UNAVAILABLE' });
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitMs = 10_000;
const error = message => Object.assign(new Error(`KODO_PIPE_BROKER: ${message}`), { code: 'KODO_PIPE_BROKER' });
const remove = file => {
  try { fs.unlinkSync(file); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
};

/** Every delivered handle has one owner: an adopted fd, or this cleanup list. */
function receive(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw error('one spawn may request at most 32 pipes');
  const id = randomUUID();
  const request = path.join(directory, `${id}.request.json`);
  const response = path.join(directory, `${id}.response.json`);
  const temporary = path.join(directory, `${id}.pending`);
  const deadline = Date.now() + waitMs;
  let reply;
  const adopted = [];
  const unadopted = new Set();
  try {
    fs.writeFileSync(temporary, JSON.stringify({ id, pid: process.pid, count, deadline }), { flag: 'wx', encoding: 'utf8' });
    fs.renameSync(temporary, request);
    // Host and Node use separate processes. Blocking here preserves spawnSync
    // and the synchronous ChildProcess.spawn API without creating another pipe.
    while (Date.now() < deadline + 1000) {
      try {
        const body = fs.readFileSync(response, 'utf8');
        try { reply = JSON.parse(body); break; }
        catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; }
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      Atomics.wait(pause, 0, 0, 10);
    }
    if (!reply) throw error('host did not provide pipes before the deadline');
    if (reply.error) throw error(String(reply.error));
    if (!Array.isArray(reply.pairs) || reply.pairs.length !== count) throw error('host returned an incomplete pipe batch');
    for (const pair of reply.pairs) {
      if (!pair || !/^\d+$/.test(pair.parent) || !/^\d+$/.test(pair.child)) throw error('host returned an invalid pipe handle');
      unadopted.add(pair.parent);
      unadopted.add(pair.child);
    }
    for (const pair of reply.pairs) {
      const parentFd = addon.adopt(pair.parent);
      unadopted.delete(pair.parent);
      adopted.push(parentFd);
      const childFd = addon.adopt(pair.child);
      unadopted.delete(pair.child);
      adopted.push(childFd);
    }
    return reply.pairs.map((_pair, index) => ({ parentFd: adopted[index * 2], childFd: adopted[index * 2 + 1] }));
  } catch (cause) {
    const cleanup = [];
    for (const fd of adopted) { try { addon.close(fd); } catch (failure) { cleanup.push(failure); } }
    for (const handle of unadopted) { try { addon.closeHandle(handle); } catch (failure) { cleanup.push(failure); } }
    if (cleanup.length) throw new AggregateError([cause, ...cleanup], 'pipe handoff and cleanup failed', { cause });
    throw cause;
  } finally {
    // Removing a response is file cleanup, not a remote close acknowledgement:
    // a delivered handle may already have been closed/reused in this process.
    // Unconsumed responses remain bounded by the broker's invocation quota and
    // all corresponding handles are reclaimed when the Job ends.
    remove(temporary);
    remove(request);
    remove(response);
  }
}

const needsPipe = stream => stream.type === 'pipe' || stream.type === 'overlapped';
const preload = `--require "${path.join(path.dirname(module.filename), 'kodo-node-compat.cjs').replaceAll('\\', '/')}"`;
const adapterOptions = `--preserve-symlinks --preserve-symlinks-main ${preload}`;
function preserveAdapter(options, ipc) {
  // Public Node normalization supplies envPairs even for env:{}. Preserve that
  // caller-selected environment and add only this invocation's adapter binding.
  const pairs = options.envPairs || Object.entries(process.env).map(([name, value]) => `${name}=${value}`);
  const configured = pairs.find(value => /^NODE_OPTIONS=/i.test(value));
  const nodeOptions = configured ? configured.slice(configured.indexOf('=') + 1).replaceAll(adapterOptions, '').replaceAll(preload, '').trim() : '';
  options.envPairs = pairs.filter(value => !/^(NODE_OPTIONS|KODO_PIPE_DIRECTORY|KODO_PIPE_PARENT_PID)=/i.test(value));
  options.envPairs.push(`NODE_OPTIONS=${adapterOptions}${nodeOptions ? ` ${nodeOptions}` : ''}`, `KODO_PIPE_DIRECTORY=${directory}`);
  if (ipc) options.envPairs.push(`KODO_PIPE_PARENT_PID=${process.pid}`);
}
const Process = process.binding('process_wrap').Process;
const { UV_EMFILE, UV_ENFILE } = process.binding('uv');
const originalSpawn = Process.prototype.spawn;
Process.prototype.spawn = function spawnWithHostPipes(options) {
  const entries = options.stdio.map((stream, index) => ({ stream, index })).filter(entry => needsPipe(entry.stream));
  preserveAdapter(options, entries.some(entry => entry.stream.ipc));
  if (!entries.length) return originalSpawn.call(this, options);
  let pairs = [];
  const opened = new Set();
  const previousTypes = entries.map(entry => entry.stream.type);
  let spawned = false;
  try {
    pairs = receive(entries.length);
    entries.forEach(({ stream }, index) => {
      const result = stream.handle.open(pairs[index].parentFd);
      if (result !== 0) throw error(`could not open the delivered parent pipe (${result})`);
      opened.add(index);
      stream.type = 'fd';
      stream.fd = pairs[index].childFd;
    });
    const result = originalSpawn.call(this, options);
    spawned = result === 0;
    if (spawned) entries.forEach(({ stream }, index) => { if (stream.ipc) addon.setPeer(pairs[index].parentFd, this.pid); });
    // Node returns immediately for descriptor exhaustion, before constructing
    // streams that would own our opened endpoints. ENOENT/EACCES/EAGAIN instead
    // proceed through Socket/IPC setup and drain EOF after childFd is closed;
    // every other error has Node's own pipe-close path.
    else if (result === UV_EMFILE || result === UV_ENFILE) entries.forEach(({ stream }) => stream.handle.close());
    return result;
  } catch (cause) {
    // A post-spawn setup failure cannot leave an unreported child running.
    if (spawned) this.kill(9);
    entries.forEach(({ stream }, index) => {
      if (opened.has(index)) stream.handle.close();
      else {
        if (pairs[index]) addon.close(pairs[index].parentFd);
        stream.handle.close();
      }
    });
    throw cause;
  } finally {
    entries.forEach(({ stream }, index) => {
      stream.type = previousTypes[index];
      delete stream.fd;
      if (pairs[index]) addon.close(pairs[index].childFd);
    });
  }
};

const syncBinding = process.binding('spawn_sync');
const originalSync = syncBinding.spawn;
syncBinding.spawn = function spawnSyncWithHostPipes(options) {
  const entries = options.stdio.map((stream, index) => ({ stream, index })).filter(entry => needsPipe(entry.stream));
  preserveAdapter(options, false);
  if (!entries.length) return originalSync.call(this, options);
  const pairs = receive(entries.length);
  // The native synchronous runner takes ownership of every fd, including on
  // validation failure. It uses a private uv loop and bounded captured buffers.
  return addon.spawnSync({ ...options, hostPairs: pairs.map((pair, index) => ({ ...pair, index: entries[index].index })) });
};

// Node creates a forked child's channel before running preloads. Correct the
// peer identity of that existing IPC stream; do not replace its framing/codec.
if (process.channel && process.env.KODO_PIPE_PARENT_PID) {
  const peer = Number(process.env.KODO_PIPE_PARENT_PID);
  if (!Number.isSafeInteger(peer) || peer < 1 || peer > 0xffffffff) throw error('invalid inherited IPC parent identity');
  addon.setPeer(process.channel.fd, peer);
}
