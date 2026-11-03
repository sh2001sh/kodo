'use strict';
// Preloaded into Node programs started by the Windows AppContainer sandbox.
// It only changes behavior that otherwise fails or hangs inside the container.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nativeUserInfo = os.userInfo;
// uv_os_get_passwd cannot read the profile of an AppContainer token.
os.userInfo = function userInfo(options) {
  try { return nativeUserInfo.call(os, options); } catch (error) {
    if (!error || error.code !== 'ERR_SYSTEM_ERROR') throw error;
    return { uid: -1, gid: -1, username: process.env.USERNAME || 'kodo-sandbox', homedir: os.homedir(), shell: null };
  }
};

// Ancestors of granted roots are not readable, so realpath walks fail with EPERM.
// Scoped paths contain no links (the launcher rejects reparse points), so the
// resolved absolute path is the canonical path when the object itself exists.
const realpathFallback = (target, error) => {
  if (!error || error.code !== 'EPERM') throw error;
  const resolved = path.resolve(String(target));
  fs.lstatSync(resolved);
  return resolved;
};
const syncRealpath = (original) => function realpathSync(target, options) {
  try { return original.call(fs, target, options); } catch (error) { return realpathFallback(target, error); }
};
const asyncRealpath = (original) => function realpath(target, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const forward = typeof options === 'function' ? undefined : options;
  return original.call(fs, target, forward, (error, value) => {
    if (!error) return done(null, value);
    try { done(null, realpathFallback(target, error)); } catch (fallback) { done(fallback); }
  });
};
const nativeSync = fs.realpathSync.native;
const nativeAsync = fs.realpath.native;
fs.realpathSync = syncRealpath(fs.realpathSync);
fs.realpathSync.native = syncRealpath(nativeSync);
fs.realpath = asyncRealpath(fs.realpath);
fs.realpath.native = asyncRealpath(nativeAsync);
const promiseRealpath = fs.promises.realpath;
fs.promises.realpath = async function realpath(target, options) {
  try { return await promiseRealpath.call(fs.promises, target, options); } catch (error) { return realpathFallback(target, error); }
};

// A configured invocation broker creates pipe handles outside the restricted
// token and passes only those handles into this Job. Without it, retain the
// explicit unsupported result instead of asking libuv to create a pipe name.
if (process.env.KODO_PIPE_DIRECTORY) {
  require('./node-pipes.cjs');
} else {
const piped = (stdio, ipc) => {
  const entries = typeof stdio === 'string' ? [stdio, stdio, stdio] : Array.isArray(stdio) ? [...stdio] : [];
  while (entries.length < 3) entries.push(undefined);
  return ipc || entries.some((entry, index) => entry === 'pipe' || entry === 'overlapped' || entry === 'ipc' || (entry == null && index < 3));
};
const unsupported = () => Object.assign(new Error('Kodo Windows sandbox does not support creating child piped or IPC stdio; use inherited stdio, run Node tests with --test-isolation=none, or use the host-approved verify.run backend'), { code: 'KODO_SANDBOX_PIPE_UNSUPPORTED' });
const optionsOf = (args) => args.find((value, index) => index > 0 && value && typeof value === 'object' && !Array.isArray(value));
const guard = (name, ipc = false) => {
  const original = childProcess[name];
  childProcess[name] = function guarded(...args) {
    const options = optionsOf(args) ?? {};
    if (piped(options.stdio, ipc)) throw unsupported();
    return original.apply(this, args);
  };
};
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) guard(name);
for (const name of ['exec', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = function guarded(command, ...rest) {
    const options = rest.find(value => value && typeof value === 'object') ?? {};
    if (piped(options.stdio)) throw unsupported();
    return original.call(this, command, ...rest);
  };
}
guard('fork', true);
}
