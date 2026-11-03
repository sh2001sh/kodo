// Own an ordinary Windows process tree without changing its permissions.
// Assign the target while suspended so even its earliest descendants inherit
// the kill-on-close job. Terminating this launcher closes the sole job handle.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class ProcessTreeLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags;
    public short showWindow,reserved2; public IntPtr reservedPtr,stdInput,stdOutput,stdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet;
    public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass,schedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
    public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint faults,totalProcesses,activeProcesses,terminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMITS limits,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING accounting,int size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION child);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  // Windows argv quoting: preserve empty arguments, embedded quotes and trailing backslashes.
  static string Quote(string value) {
    StringBuilder result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') slashes++;
      else { result.Append('\\',c=='"'?slashes*2+1:slashes); slashes=0; result.Append(c); }
    }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }

  public static int Main(string[] args) {
    IntPtr job=IntPtr.Zero; PROCESS_INFORMATION child=new PROCESS_INFORMATION();
    try {
      if(args.Length==0) throw new ArgumentException("Expected a target executable and its arguments");
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create process job");
      EXTENDED_LIMITS limits=new EXTENDED_LIMITS(); limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"configure process job");
      STARTUPINFO startup=new STARTUPINFO(); startup.cb=Marshal.SizeOf(startup); startup.flags=0x100; // STARTF_USESTDHANDLES
      startup.stdInput=GetStdHandle(-10); startup.stdOutput=GetStdHandle(-11); startup.stdError=GetStdHandle(-12);
      StringBuilder command=new StringBuilder();
      foreach(string arg in args) { if(command.Length>0) command.Append(' '); command.Append(Quote(arg)); }
      Check(CreateProcess(args[0],command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref startup,out child),"start target suspended");
      Check(AssignProcessToJobObject(job,child.process),"assign target to process job");
      Check(ResumeThread(child.thread)!=UInt32.MaxValue,"resume target");
      Check(WaitForSingleObject(child.process,UInt32.MaxValue)==0,"wait for target");
      uint code; Check(GetExitCodeProcess(child.process,out code),"read target exit code");
      // A root that exits before its children does not end the invocation. Keep
      // ownership until every descendant exits or the host cancels the launcher.
      while(true) {
        ACCOUNTING accounting;
        Check(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero),"query process job");
        if(accounting.activeProcesses==0) break;
        Thread.Sleep(10);
      }
      return unchecked((int)code);
    } catch(Exception error) {
      Console.Error.WriteLine("Kodo process-tree launcher: "+error.Message);
      if(child.process!=IntPtr.Zero) TerminateProcess(child.process,125);
      return 125;
    } finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
    }
  }
}
