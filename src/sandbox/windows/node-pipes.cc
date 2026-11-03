// Adopts only already-created pipe handles delivered by the invocation's host
// broker. The addon never creates a pipe name or opens another process.
#include <node_api.h>
#include <node_version.h>
#include <uv.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <string>

namespace kodo_pipes {

static napi_value Fail(napi_env env, const char* text) {
  napi_throw_error(env, "KODO_PIPE_HANDLE", text);
  return nullptr;
}

static bool HandleArgument(napi_env env, napi_value value, HANDLE* result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0 || length > 20) return false;
  char buffer[21] = {};
  if (napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) != napi_ok) return false;
  for (size_t i = 0; i < length; ++i) if (buffer[i] < '0' || buffer[i] > '9') return false;
  errno = 0;
  char* end = nullptr;
  const unsigned long long raw = std::strtoull(buffer, &end, 10);
  if (errno || end != buffer + length || raw == 0 || raw > UINTPTR_MAX || raw == UINTPTR_MAX) return false;
  *result = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(raw));
  return GetFileType(*result) == FILE_TYPE_PIPE;
}

static intptr_t OsHandle(int fd) {
  if (fd < 0) return -1;
  return reinterpret_cast<intptr_t>(uv_get_osfhandle(fd));
}

static napi_value Adopt(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t count = 1;
  HANDLE handle;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 || !HandleArgument(env, argument, &handle)) return Fail(env, "expected a delivered pipe handle");
  // Node owns its CRT descriptor table. Calling this addon's CRT directly would
  // create a descriptor that Node's PipeWrap/uv_spawn cannot use.
  const int fd = uv_open_osfhandle(handle);
  if (fd < 0) return Fail(env, "could not adopt the delivered pipe handle");
  napi_value result;
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t count = 1;
  int32_t fd;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 || napi_get_value_int32(env, argument, &fd) != napi_ok || OsHandle(fd) == -1) return Fail(env, "expected an open pipe descriptor");
  if (GetFileType(reinterpret_cast<HANDLE>(OsHandle(fd))) != FILE_TYPE_PIPE) return Fail(env, "expected a pipe descriptor");
  uv_fs_t request;
  const int closed = uv_fs_close(nullptr, &request, fd, nullptr);
  uv_fs_req_cleanup(&request);
  if (closed != 0) return Fail(env, "could not close the pipe descriptor");
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value CloseHandleValue(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t count = 1;
  HANDLE handle;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 || !HandleArgument(env, argument, &handle)) return Fail(env, "expected an unadopted pipe handle");
  if (!CloseHandle(handle)) return Fail(env, "could not close the unadopted pipe handle");
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

struct Peer { HANDLE handle; DWORD pid; bool found = false; };
static void UpdatePeer(uv_handle_t* handle, void* data) {
  Peer* peer = static_cast<Peer*>(data);
  if (handle->type != UV_NAMED_PIPE || uv_is_closing(handle)) return;
  uv_os_fd_t file;
  if (uv_fileno(handle, &file) != 0 || file != peer->handle) return;
  uv_pipe_t* pipe = reinterpret_cast<uv_pipe_t*>(handle);
  if (!pipe->ipc) return;
  // Both endpoints were created by the broker. Its process ID is not the IPC
  // recipient; preserve libuv's original peer PID for native handle messages.
  pipe->pipe.conn.ipc_remote_pid = peer->pid;
  peer->found = true;
}

static napi_value SetPeer(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  size_t count = 2;
  int32_t fd;
  uint32_t pid;
  if (napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr) != napi_ok || count != 2 || napi_get_value_int32(env, arguments[0], &fd) != napi_ok || napi_get_value_uint32(env, arguments[1], &pid) != napi_ok || !pid) return Fail(env, "expected a pipe descriptor and peer process ID");
  const intptr_t raw = OsHandle(fd);
  if (raw == -1) return Fail(env, "IPC descriptor is no longer open");
  uv_loop_t* loop;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok) return Fail(env, "Node event loop is unavailable");
  Peer peer{ reinterpret_cast<HANDLE>(raw), pid };
  uv_walk(loop, UpdatePeer, &peer);
  if (!peer.found) return Fail(env, "descriptor is not an open IPC pipe of this Node event loop");
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
}

#include "node-pipes-sync.h"

static napi_value Initialize(napi_env env, napi_value exports) {
  if (uv_version() != UV_VERSION_HEX) return kodo_pipes::Fail(env, "pipe addon must be built against this Node runtime's libuv version");
  napi_property_descriptor definitions[] = {
    { "adopt", nullptr, kodo_pipes::Adopt, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "close", nullptr, kodo_pipes::Close, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "closeHandle", nullptr, kodo_pipes::CloseHandleValue, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setPeer", nullptr, kodo_pipes::SetPeer, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "spawnSync", nullptr, kodo_sync::SpawnSync, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(definitions) / sizeof(definitions[0]), definitions);
  napi_value nodeVersion;
  napi_create_string_utf8(env, NODE_VERSION, NAPI_AUTO_LENGTH, &nodeVersion);
  napi_set_named_property(env, exports, "nodeVersion", nodeVersion);
  napi_value uvVersion;
  const std::string compiledUvVersion = std::to_string(UV_VERSION_MAJOR) + "." + std::to_string(UV_VERSION_MINOR) + "." + std::to_string(UV_VERSION_PATCH);
  napi_create_string_utf8(env, compiledUvVersion.c_str(), compiledUvVersion.size(), &uvVersion);
  napi_set_named_property(env, exports, "uvVersion", uvVersion);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
