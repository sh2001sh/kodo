#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif

// The launcher supplies connected, overlapped pipe endpoints. This runner only
// inherits those endpoints; it never creates a pipe or changes the child token.
#include <node_api.h>
#include <uv.h>
#include <algorithm>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace kodo_sync {

struct Invalid {
  const char* message;
};

inline void CloseFd(int fd) {
  uv_fs_t request{};
  uv_fs_close(nullptr, &request, fd, nullptr);
  uv_fs_req_cleanup(&request);
}

inline napi_value Property(napi_env env, napi_value object, const char* name) {
  napi_value result;
  if (napi_get_named_property(env, object, name, &result) != napi_ok) throw Invalid{"unable to read normalized spawn option"};
  return result;
}
inline napi_valuetype Type(napi_env env, napi_value value) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) throw Invalid{"unable to read normalized spawn value"};
  return type;
}
inline bool Absent(napi_env env, napi_value value) {
  const napi_valuetype type = Type(env, value);
  return type == napi_undefined || type == napi_null;
}
inline std::string String(napi_env env, napi_value value) {
  size_t length = 0;
  if (Type(env, value) != napi_string || napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 1024 * 1024) throw Invalid{"spawn strings must be bounded UTF-8 text"};
  std::string text(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, &text[0], text.size(), &length) != napi_ok) throw Invalid{"unable to decode spawn string"};
  text.resize(length);
  if (text.find('\0') != std::string::npos) throw Invalid{"spawn strings cannot contain NUL"};
  return text;
}
inline double Number(napi_env env, napi_value value) {
  double number;
  if (Type(env, value) != napi_number || napi_get_value_double(env, value, &number) != napi_ok) throw Invalid{"spawn numeric option is invalid"};
  return number;
}
inline int Integer(napi_env env, napi_value value) {
  const double number = Number(env, value);
  if (!std::isfinite(number) || std::floor(number) != number || number < 0 || number > std::numeric_limits<int>::max()) throw Invalid{"spawn descriptor or index is invalid"};
  return static_cast<int>(number);
}
inline bool Boolean(napi_env env, napi_value object, const char* name) {
  napi_value value = Property(env, object, name);
  if (Absent(env, value)) return false;
  bool result;
  if (napi_get_value_bool(env, value, &result) != napi_ok) throw Invalid{"spawn boolean option is invalid"};
  return result;
}
inline uint32_t ArrayLength(napi_env env, napi_value value, uint32_t maximum) {
  bool array = false;
  uint32_t length = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array || napi_get_array_length(env, value, &length) != napi_ok || length > maximum) throw Invalid{"spawn array exceeds the supported bound"};
  return length;
}
inline napi_value Element(napi_env env, napi_value value, uint32_t index) {
  napi_value result;
  if (napi_get_element(env, value, index, &result) != napi_ok) throw Invalid{"unable to read spawn array"};
  return result;
}
inline std::vector<std::string> Strings(napi_env env, napi_value value, uint32_t maximum) {
  std::vector<std::string> output;
  const uint32_t count = ArrayLength(env, value, maximum);
  output.reserve(count);
  for (uint32_t i = 0; i < count; ++i) output.push_back(String(env, Element(env, value, i)));
  return output;
}
inline std::vector<char*> Pointers(std::vector<std::string>& values) {
  std::vector<char*> output;
  output.reserve(values.size() + 1);
  for (std::string& value : values) output.push_back(&value[0]);
  output.push_back(nullptr);
  return output;
}

struct Runner;
struct Pipe {
  Runner* runner = nullptr;
  int index = -1;
  int parent = -1;
  int child = -1;
  bool initialized = false;
  bool opened = false;
  bool readable = false;  // Child reads; parent writes.
  bool writable = false; // Child writes; parent reads.
  uv_pipe_t handle{};
  uv_write_t write{};
  uv_shutdown_t shutdown{};
  std::vector<char> input;
  std::vector<char> output;
};

struct Runner {
  uv_loop_t loop{};
  bool loopReady = false;
  uv_process_t process{};
  bool spawned = false;
  bool processReady = false;
  bool exited = false;
  uv_timer_t timer{};
  bool timerReady = false;
  int error = 0;
  int killSignal = SIGTERM;
  int termSignal = 0;
  int64_t exitStatus = 0;
  size_t maximum = 1024 * 1024;
  size_t captured = 0;
  std::vector<std::unique_ptr<Pipe>> pipes;
  std::vector<uv_stdio_container_t> stdio;

  void Close(Pipe& pipe) {
    if (pipe.initialized && !uv_is_closing(reinterpret_cast<uv_handle_t*>(&pipe.handle))) uv_close(reinterpret_cast<uv_handle_t*>(&pipe.handle), nullptr);
    if (!pipe.opened && pipe.parent >= 0) { CloseFd(pipe.parent); pipe.parent = -1; }
  }
  void CloseTimer() {
    if (timerReady && !uv_is_closing(reinterpret_cast<uv_handle_t*>(&timer))) {
      uv_timer_stop(&timer);
      uv_close(reinterpret_cast<uv_handle_t*>(&timer), nullptr);
    }
  }
  void Stop(int code) {
    if (!error) error = code;
    if (spawned && !exited) {
      const int killed = uv_process_kill(&process, killSignal);
      if (killed && killed != UV_ESRCH) uv_process_kill(&process, SIGKILL);
    }
    for (auto& pipe : pipes) Close(*pipe);
    CloseTimer();
  }
  ~Runner() {
    for (auto& pipe : pipes) {
      if (pipe->child >= 0) { CloseFd(pipe->child); pipe->child = -1; }
      Close(*pipe);
    }
    if (!loopReady) return;
    CloseTimer();
    if (spawned && !exited) uv_process_kill(&process, SIGKILL);
    if (processReady && !spawned && !uv_is_closing(reinterpret_cast<uv_handle_t*>(&process))) uv_close(reinterpret_cast<uv_handle_t*>(&process), nullptr);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
  }
};

inline void Allocate(uv_handle_t*, size_t suggested, uv_buf_t* buffer) {
  const size_t size = std::min<size_t>(std::max<size_t>(suggested, 1024), 65536);
  buffer->base = static_cast<char*>(std::malloc(size));
  buffer->len = buffer->base ? size : 0;
}
inline void Read(uv_stream_t* stream, ssize_t length, const uv_buf_t* buffer) {
  Pipe* pipe = static_cast<Pipe*>(stream->data);
  Runner* runner = pipe->runner;
  if (length > 0) {
    const size_t bytes = static_cast<size_t>(length);
    const size_t room = runner->maximum - std::min(runner->captured, runner->maximum);
    const size_t keep = std::min(bytes, room);
    try {
      pipe->output.insert(pipe->output.end(), buffer->base, buffer->base + keep);
      runner->captured += keep;
      if (bytes > room) runner->Stop(UV_ENOBUFS);
    } catch (const std::bad_alloc&) { runner->Stop(UV_ENOMEM); }
  } else if (length < 0) {
    if (length != UV_EOF && length != UV_ECANCELED) runner->Stop(static_cast<int>(length));
    else runner->Close(*pipe);
  }
  std::free(buffer->base);
}
inline void Shutdown(uv_shutdown_t* request, int status) {
  Pipe* pipe = static_cast<Pipe*>(request->data);
  if (status < 0 && status != UV_EPIPE && status != UV_ENOTCONN && status != UV_ECANCELED) pipe->runner->Stop(status);
  if (!pipe->writable) pipe->runner->Close(*pipe);
}
inline void Write(uv_write_t* request, int status) {
  Pipe* pipe = static_cast<Pipe*>(request->data);
  // A child may exit without consuming all of stdin, matching Node spawnSync.
  if (status < 0 && status != UV_EPIPE && status != UV_ECANCELED) pipe->runner->Stop(status);
}
inline void Exit(uv_process_t* process, int64_t status, int signal) {
  Runner* runner = static_cast<Runner*>(process->data);
  runner->exited = true;
  runner->exitStatus = status;
  runner->termSignal = signal;
  uv_close(reinterpret_cast<uv_handle_t*>(process), nullptr);
}
inline void Timeout(uv_timer_t* timer) { static_cast<Runner*>(timer->data)->Stop(UV_ETIMEDOUT); }

inline void Input(napi_env env, napi_value value, std::vector<char>& target) {
  if (Absent(env, value)) return;
  void* data = nullptr;
  size_t size = 0;
  bool buffer = false;
  if (napi_is_buffer(env, value, &buffer) != napi_ok) throw Invalid{"unable to inspect stdin buffer"};
  if (buffer) {
    if (napi_get_buffer_info(env, value, &data, &size) != napi_ok) throw Invalid{"invalid stdin buffer"};
  } else {
    bool typed = false;
    bool view = false;
    napi_is_typedarray(env, value, &typed);
    napi_is_dataview(env, value, &view);
    napi_value backing;
    size_t offset = 0;
    if (typed) {
      napi_typedarray_type type;
      size_t count = 0;
      if (napi_get_typedarray_info(env, value, &type, &count, &data, &backing, &offset) != napi_ok) throw Invalid{"invalid stdin typed array"};
      size_t width = 1;
      if (type == napi_int16_array || type == napi_uint16_array) width = 2;
      else if (type == napi_int32_array || type == napi_uint32_array || type == napi_float32_array) width = 4;
      else if (type == napi_float64_array || type == napi_bigint64_array || type == napi_biguint64_array) width = 8;
      if (count > (16 * 1024 * 1024) / width) throw Invalid{"synchronous stdin exceeds 16 MiB"};
      size = count * width;
    } else if (view) {
      if (napi_get_dataview_info(env, value, &size, &data, &backing, &offset) != napi_ok) throw Invalid{"invalid stdin data view"};
    } else throw Invalid{"synchronous stdin must be a Buffer or ArrayBuffer view"};
  }
  if (size > 16 * 1024 * 1024) throw Invalid{"synchronous stdin exceeds 16 MiB"};
  if (size) target.assign(static_cast<char*>(data), static_cast<char*>(data) + size);
}

inline napi_value NumberValue(napi_env env, int64_t number) {
  napi_value result;
  napi_create_int64(env, number, &result);
  return result;
}
inline napi_value Null(napi_env env) { napi_value result; napi_get_null(env, &result); return result; }
inline napi_value Signal(napi_env env, int signal) {
  const char* name = signal == SIGTERM ? "SIGTERM" : signal == SIGKILL ? "SIGKILL" : signal == SIGINT ? "SIGINT" : nullptr;
  if (!name) return Null(env);
  napi_value result;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &result);
  return result;
}

// Takes ownership of every pair submitted in hostPairs. All descriptors are
// released before returning, including after failed spawn or partial setup.
inline napi_value SpawnSync(napi_env env, napi_callback_info info) {
  Runner runner;
  try {
    napi_value argument;
    size_t argc = 1;
    if (napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr) != napi_ok || argc != 1 || Type(env, argument) != napi_object) throw Invalid{"spawnSync requires normalized options"};
    napi_value pairs = Property(env, argument, "hostPairs");
    const uint32_t pairCount = ArrayLength(env, pairs, 32);
    std::set<int> descriptors;
    std::set<int> indexes;
    for (uint32_t i = 0; i < pairCount; ++i) {
      napi_value pair = Element(env, pairs, i);
      auto pipe = std::make_unique<Pipe>();
      pipe->runner = &runner;
      pipe->index = Integer(env, Property(env, pair, "index"));
      pipe->parent = Integer(env, Property(env, pair, "parentFd"));
      pipe->child = Integer(env, Property(env, pair, "childFd"));
      if (pipe->parent < 3 || pipe->child < 3 || !indexes.insert(pipe->index).second || !descriptors.insert(pipe->parent).second || !descriptors.insert(pipe->child).second) throw Invalid{"host pipe descriptors must be distinct owned descriptors above stdio"};
      runner.pipes.push_back(std::move(pipe));
    }
    std::string file = String(env, Property(env, argument, "file"));
    auto args = Strings(env, Property(env, argument, "args"), 4096);
    auto argv = Pointers(args);
    napi_value environment = Property(env, argument, "envPairs");
    std::vector<std::string> envStrings;
    std::vector<char*> envp;
    if (!Absent(env, environment)) { envStrings = Strings(env, environment, 8192); envp = Pointers(envStrings); }
    std::string cwd;
    napi_value directory = Property(env, argument, "cwd");
    if (!Absent(env, directory)) cwd = String(env, directory);
    napi_value timeoutValue = Property(env, argument, "timeout");
    double timeout = Absent(env, timeoutValue) ? 0 : Number(env, timeoutValue);
    if (!std::isfinite(timeout) || timeout < 0 || std::floor(timeout) != timeout || timeout > 9007199254740991.0) throw Invalid{"timeout must be a finite nonnegative integer"};
    napi_value maximum = Property(env, argument, "maxBuffer");
    const double maximumNumber = Absent(env, maximum) ? 1024 * 1024 : Number(env, maximum);
    if (!std::isfinite(maximumNumber) || maximumNumber < 0 || maximumNumber > 16 * 1024 * 1024) throw Invalid{"the broker requires a finite maxBuffer between 0 and 16 MiB; larger captures are unsupported"};
    runner.maximum = static_cast<size_t>(maximumNumber);
    napi_value signal = Property(env, argument, "killSignal");
    if (!Absent(env, signal)) runner.killSignal = Integer(env, signal);
    if (runner.killSignal != SIGTERM && runner.killSignal != SIGKILL && runner.killSignal != SIGINT) throw Invalid{"Windows broker supports SIGTERM, SIGKILL or SIGINT for synchronous cancellation"};
    if (!Absent(env, Property(env, argument, "uid")) || !Absent(env, Property(env, argument, "gid"))) throw Invalid{"Windows does not support uid/gid spawn options"};
    napi_value stdio = Property(env, argument, "stdio");
    const uint32_t count = ArrayLength(env, stdio, 32);
    runner.stdio.resize(count);
    for (const auto& pipe : runner.pipes) if (pipe->index >= static_cast<int>(count)) throw Invalid{"host pipe index exceeds stdio"};
    for (uint32_t i = 0; i < count; ++i) {
      napi_value entry = Element(env, stdio, i);
      const std::string type = String(env, Property(env, entry, "type"));
      Pipe* pipe = nullptr;
      for (auto& candidate : runner.pipes) if (candidate->index == static_cast<int>(i)) pipe = candidate.get();
      if (type == "pipe" || type == "overlapped") {
        if (!pipe || Boolean(env, entry, "ipc")) throw Invalid{"synchronous pipe requires a broker pair and cannot be IPC"};
        pipe->readable = Boolean(env, entry, "readable");
        pipe->writable = Boolean(env, entry, "writable");
        if (!pipe->readable && !pipe->writable) throw Invalid{"synchronous pipe has no direction"};
        if (pipe->readable) Input(env, Property(env, entry, "input"), pipe->input);
        runner.stdio[i].flags = UV_INHERIT_FD;
        runner.stdio[i].data.fd = pipe->child;
      } else {
        if (pipe) throw Invalid{"host pair does not correspond to a pipe"};
        if (type == "ignore") runner.stdio[i].flags = UV_IGNORE;
        else if (type == "fd" || type == "inherit") { runner.stdio[i].flags = UV_INHERIT_FD; runner.stdio[i].data.fd = Integer(env, Property(env, entry, "fd")); }
        else throw Invalid{"synchronous broker supports pipe, inherit, fd or ignore stdio only"};
      }
    }
    uv_process_options_t options{};
    options.file = file.c_str();
    options.args = argv.data();
    options.env = envp.empty() ? nullptr : envp.data();
    options.cwd = cwd.empty() ? nullptr : cwd.c_str();
    options.stdio_count = static_cast<int>(runner.stdio.size());
    options.stdio = runner.stdio.data();
    options.exit_cb = Exit;
    if (Boolean(env, argument, "windowsHide")) options.flags |= UV_PROCESS_WINDOWS_HIDE;
    if (Boolean(env, argument, "windowsVerbatimArguments")) options.flags |= UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS;
    if (Boolean(env, argument, "detached")) options.flags |= UV_PROCESS_DETACHED;
    int status = uv_loop_init(&runner.loop);
    if (status) runner.error = status;
    else {
      runner.loopReady = true;
      for (auto& pipe : runner.pipes) {
        status = uv_pipe_init(&runner.loop, &pipe->handle, 0);
        if (status) { runner.error = status; break; }
        pipe->initialized = true;
        pipe->handle.data = pipe.get();
        status = uv_pipe_open(&pipe->handle, pipe->parent);
        if (status) { runner.error = status; break; }
        pipe->opened = true;
      }
      if (!runner.error) {
        runner.process.data = &runner;
        status = uv_spawn(&runner.loop, &runner.process, &options);
        runner.processReady = true;
        if (status) { runner.error = status; uv_close(reinterpret_cast<uv_handle_t*>(&runner.process), nullptr); }
        else runner.spawned = true;
      }
      for (auto& pipe : runner.pipes) { if (pipe->child >= 0) CloseFd(pipe->child); pipe->child = -1; }
      if (!runner.error) {
        for (auto& pipe : runner.pipes) {
          if (pipe->writable) {
            status = uv_read_start(reinterpret_cast<uv_stream_t*>(&pipe->handle), Allocate, Read);
            if (status) { runner.Stop(status); break; }
          }
          if (pipe->readable) {
            if (!pipe->input.empty()) {
              pipe->write.data = pipe.get();
              uv_buf_t input = uv_buf_init(pipe->input.data(), static_cast<unsigned int>(pipe->input.size()));
              status = uv_write(&pipe->write, reinterpret_cast<uv_stream_t*>(&pipe->handle), &input, 1, Write);
              if (status) { runner.Stop(status); break; }
            }
            pipe->shutdown.data = pipe.get();
            status = uv_shutdown(&pipe->shutdown, reinterpret_cast<uv_stream_t*>(&pipe->handle), Shutdown);
            if (status) { runner.Stop(status); break; }
          }
        }
        if (!runner.error && timeout > 0) {
          status = uv_timer_init(&runner.loop, &runner.timer);
          if (status) runner.Stop(status);
          else {
            runner.timerReady = true;
            runner.timer.data = &runner;
            // The timer bounds inherited output handles too, but does not keep
            // an otherwise completed command alive until its deadline.
            uv_unref(reinterpret_cast<uv_handle_t*>(&runner.timer));
            status = uv_timer_start(&runner.timer, Timeout, static_cast<uint64_t>(timeout), 0);
            if (status) runner.Stop(status);
          }
        }
      }
      if (runner.error) runner.Stop(runner.error);
      uv_run(&runner.loop, UV_RUN_DEFAULT);
    }
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "pid", NumberValue(env, runner.spawned ? runner.process.pid : 0));
    napi_set_named_property(env, result, "status", runner.spawned && runner.exited && !runner.termSignal ? NumberValue(env, runner.exitStatus) : Null(env));
    napi_set_named_property(env, result, "signal", Signal(env, runner.termSignal));
    if (runner.error) napi_set_named_property(env, result, "error", NumberValue(env, runner.error));
    napi_value output = Null(env);
    if (runner.spawned) {
      napi_create_array_with_length(env, count, &output);
      for (uint32_t i = 0; i < count; ++i) {
        napi_value chunk = Null(env);
        for (const auto& pipe : runner.pipes) if (pipe->index == static_cast<int>(i) && pipe->writable) {
          napi_create_buffer_copy(env, pipe->output.size(), pipe->output.empty() ? nullptr : pipe->output.data(), nullptr, &chunk);
          break;
        }
        napi_set_element(env, output, i, chunk);
      }
    }
    napi_set_named_property(env, result, "output", output);
    return result;
  } catch (const Invalid& error) {
    napi_throw_error(env, "ERR_KODO_PIPE_UNSUPPORTED", error.message);
    return nullptr;
  } catch (const std::bad_alloc&) {
    napi_throw_error(env, "ERR_KODO_PIPE_MEMORY", "synchronous pipe capture could not allocate bounded memory");
    return nullptr;
  }
}

} // namespace kodo_sync
