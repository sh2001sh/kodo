using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Runs in the trusted launcher. It allocates channels only; it never executes a
// requested command or opens a client-supplied path. Both endpoints are delivered
// to a process already contained in this invocation's job.
internal sealed class SandboxPipeBroker : IDisposable {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle file);
  [StructLayout(LayoutKind.Sequential)] struct AttributeTag { public uint attributes; public uint tag; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int infoClass,out AttributeTag attributes,uint length);
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential)] struct Overlapped { public IntPtr internalLow,internalHigh; public uint offset,offsetHigh; public IntPtr wait; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateNamedPipe(string name,uint openMode,uint pipeMode,uint instances,uint outSize,uint inSize,uint timeout,ref SecurityAttributes security);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ConnectNamedPipe(SafeFileHandle pipe,ref Overlapped overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetOverlappedResult(SafeFileHandle file,ref Overlapped overlapped,out uint transferred,bool wait);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CancelIoEx(SafeFileHandle file,ref Overlapped overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateEvent(IntPtr attributes,bool manual,bool initial,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr allocation);
  sealed class Request { public string id; public uint pid; public int count; public long deadline; }
  sealed class Pair { public string parent; public string child; }
  readonly string directory;
  readonly IntPtr job;
  readonly SecurityIdentifier user;
  readonly ManualResetEvent stopped=new ManualResetEvent(false);
  readonly Thread worker;
  int issued;

  internal SandboxPipeBroker(string directory,IntPtr job) {
    this.directory=directory; this.job=job;
    using(WindowsIdentity identity=WindowsIdentity.GetCurrent()) user=identity.User;
    worker=new Thread(Serve); worker.IsBackground=true; worker.Name="Kodo pipe broker"; worker.Start();
  }
  static void Check(bool success,string operation) {
    if(!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),operation);
  }
  Pair Allocate(IntPtr process,List<IntPtr> transferred) {
    // Do not use NamedPipeServerStream.BeginWaitForConnection here: it binds
    // the endpoint to the launcher's IO completion port. A duplicated endpoint
    // must still be free for the recipient's own libuv completion port.
    IntPtr descriptor; uint size;
    Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;"+user.Value+")",1,out descriptor,out size),"create internal pipe descriptor");
    try {
      SecurityAttributes security=new SecurityAttributes { length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=descriptor };
      string name="\\\\.\\pipe\\Kodo.Internal."+Guid.NewGuid().ToString("N");
      using(SafeFileHandle server=CreateNamedPipe(name,3|0x40000000|0x00080000,8,1,65536,65536,0,ref security)) {
        Check(!server.IsInvalid,"create internal pipe");
        using(SafeFileHandle client=CreateFile(name,0xC0000000,0,IntPtr.Zero,3,0x40000000,IntPtr.Zero)) {
          Check(!client.IsInvalid,"connect internal pipe");
          IntPtr ready=CreateEvent(IntPtr.Zero,true,false,null); Check(ready!=IntPtr.Zero,"create pipe connection event");
          try {
            Overlapped pending=new Overlapped { wait=ready };
            if(!ConnectNamedPipe(server,ref pending)) {
              int error=Marshal.GetLastWin32Error();
              if(error==997) {
                uint count;
                if(WaitForSingleObject(ready,2000)!=0) {
                  CancelIoEx(server,ref pending); GetOverlappedResult(server,ref pending,out count,true);
                  throw new IOException("Internal pipe connection timed out");
                }
                Check(GetOverlappedResult(server,ref pending,out count,false),"complete internal pipe connection");
              } else if(error!=535) throw new System.ComponentModel.Win32Exception(error,"connect internal pipe");
            }
          } finally { CloseHandle(ready); }
          IntPtr parent,child;
          Check(DuplicateHandle(GetCurrentProcess(),server.DangerousGetHandle(),process,out parent,0,false,2),"deliver parent pipe endpoint");
          transferred.Add(parent);
          Check(DuplicateHandle(GetCurrentProcess(),client.DangerousGetHandle(),process,out child,0,false,2),"deliver child pipe endpoint");
          transferred.Add(child); issued++;
          return new Pair { parent=parent.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),child=child.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture) };
        }
      }
    } finally { LocalFree(descriptor); }
  }
  void Serve() {
    while(!stopped.WaitOne(5)) {
      try {
        foreach(string file in Directory.EnumerateFiles(directory,"*.request.json",SearchOption.TopDirectoryOnly)) {
          if(stopped.WaitOne(0)) return;
          string name=Path.GetFileName(file);
          string id=name.Substring(0,name.Length-".request.json".Length);
          Guid parsed;
          if(!Guid.TryParseExact(id,"D",out parsed)) continue;
          ProcessRequest(file,id);
        }
      } catch(Exception error) {
        Console.Error.WriteLine("KODO_PIPE_BROKER: "+error.Message);
        if(stopped.WaitOne(100)) return;
      }
    }
  }
  void ProcessRequest(string file,string id) {
    string response=Path.Combine(directory,id+".response.json");
    if(File.Exists(response)) return;
    IntPtr process=IntPtr.Zero;
    List<IntPtr> transferred=new List<IntPtr>();
    bool published=false;
    try {
      // CreateNew prevents an existing client-created entry from being followed
      // or overwritten. The directory itself cannot be renamed by the child.
      using(FileStream output=new FileStream(response,FileMode.CreateNew,FileAccess.Write,FileShare.Read|FileShare.Delete)) {
        object result;
        try {
          string text;
          // Inspect the same handle that will be read; never follow a request
          // entry through a reparse point or rely on a preceding path check.
          using(SafeFileHandle handle=CreateFile(file,0x80000000,1,IntPtr.Zero,3,0x00200000|0x08000000,IntPtr.Zero)) {
            Check(!handle.IsInvalid,"open pipe request");
            AttributeTag attributes;
            Check(GetFileInformationByHandleEx(handle,9,out attributes,(uint)Marshal.SizeOf(typeof(AttributeTag))),"inspect pipe request");
            if(GetFileType(handle)!=1||(attributes.attributes&0x400)!=0) throw new IOException("Pipe request must be a regular file");
            using(FileStream input=new FileStream(handle,FileAccess.Read)) {
              if(input.Length>2048) throw new IOException("Pipe request exceeds its size limit");
              using(StreamReader reader=new StreamReader(input,Encoding.UTF8)) text=reader.ReadToEnd();
            }
          }
          File.Delete(file);
          Request request=new JavaScriptSerializer().Deserialize<Request>(text);
          if(request==null||request.id!=id||request.pid==0||request.count<1||request.count>32) throw new IOException("Invalid pipe request");
          long now=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
          if(request.deadline<=now||request.deadline>now+30000) throw new IOException("Pipe request deadline is invalid or expired");
          if(issued+request.count>8192) throw new IOException("Invocation pipe allocation limit reached");
          process=OpenProcess(0x0040|0x1000,false,request.pid);
          Check(process!=IntPtr.Zero,"open pipe recipient");
          bool member; Check(IsProcessInJob(process,job,out member),"check pipe recipient job");
          if(!member) throw new IOException("Pipe recipient does not belong to this invocation");
          List<Pair> pairs=new List<Pair>();
          for(int i=0;i<request.count;i++) {
            if(stopped.WaitOne(0)) throw new IOException("Pipe broker is stopping");
            if((long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds>=request.deadline) throw new IOException("Pipe request expired during allocation");
            pairs.Add(Allocate(process,transferred));
          }
          if((long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds>=request.deadline) throw new IOException("Pipe request expired before delivery");
          result=new { pairs=pairs };
        } catch(Exception error) { result=new { error=error.Message }; }
        if(result.GetType().GetProperty("error")!=null&&process!=IntPtr.Zero) {
          foreach(IntPtr handle in transferred) { IntPtr reclaimed; if(DuplicateHandle(process,handle,GetCurrentProcess(),out reclaimed,0,false,1|2)) CloseHandle(reclaimed); }
          transferred.Clear();
        }
        byte[] bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(result));
        // Once publication starts, the receiver may adopt and reuse a numeric
        // handle. Never close it remotely based on a missing acknowledgement.
        // Unconsumed allocations are bounded above and die with the job.
        published=true;
        output.Write(bytes,0,bytes.Length); output.Flush();
      }
    } catch(IOException error) {
      Console.Error.WriteLine("KODO_PIPE_BROKER: "+error.Message);
    } finally {
      if(!published&&process!=IntPtr.Zero) foreach(IntPtr handle in transferred) {
        IntPtr reclaimed;
        if(DuplicateHandle(process,handle,GetCurrentProcess(),out reclaimed,0,false,1|2)) CloseHandle(reclaimed);
      }
      if(process!=IntPtr.Zero) CloseHandle(process);
    }
  }
  public void Dispose() {
    stopped.Set();
    // A local pipe connection has a bounded two-second deadline.
    if(!worker.Join(3000)) throw new IOException("Pipe broker did not stop within its deadline");
    stopped.Dispose();
  }
}
