// Trusted launcher: never loaded into the AppContainer. All child descendants share
// a kill-on-close job and the same restricted AppContainer identity.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Threading;
using System.Security.Cryptography;

internal static class SandboxLauncher {
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string reserved; public string desktop; public string title; public uint x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags; public short showWindow,reserved2; public IntPtr reservedPtr,stdInput,stdOutput,stdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr AttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION value,int length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int infoClass,IntPtr value,int length,IntPtr returned);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint millis);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ConvertStringSidToSid(string value,out IntPtr sid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value,uint revision,out IntPtr descriptor,out uint length);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string path,int type,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor,out ushort control,out uint revision);
  [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name,out IntPtr groups,out uint groupCount,out IntPtr capabilities,out uint capabilityCount);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetFileSecurity(string target,uint information,byte[] descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string path,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,uint revision,uint information,out IntPtr text,out uint length);

  public sealed class Config { public string program; public string[] args; public string cwd; public Dictionary<string,string> env; public string[] read; public string[] resources; public string[] write; public string[] deny; public string network; public ulong memoryBytes; public uint maxProcesses; public string profile; public string journal; public bool workspaceWrite; public string writerState; public string pipeDirectory; }
  public sealed class Change { public string path; public bool directory; public string label; public bool acl; public bool recursive; public bool inherited; }
  public sealed class Journal { public string profile; public string sid; public string[] write; public string[] deny; public List<Change> changes=new List<Change>(); public bool cleaned; public bool workspaceWrite; public string writerState; }
  static Journal journal;
  static string journalPath;
  static SecurityIdentifier identity;
  static Mutex writerGate;
  static void Check(bool value,string action) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(),action+" (Windows error "+Marshal.GetLastWin32Error()+")"); }
  static void Save() { byte[] bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer { MaxJsonLength=64*1024*1024 }.Serialize(journal)); using(FileStream file=new FileStream(journalPath,FileMode.Create,FileAccess.Write,FileShare.Read)) { file.Write(bytes,0,bytes.Length); file.Flush(true); } }
  static void Record(Change change) { byte[] bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(change)+"\n"); using(FileStream file=new FileStream(journalPath+".changes",FileMode.Append,FileAccess.Write,FileShare.Read)) { file.Write(bytes,0,bytes.Length); file.Flush(true); } journal.changes.Add(change); }
  static Journal ReadJournal(string target) { Journal value=new JavaScriptSerializer { MaxJsonLength=64*1024*1024 }.Deserialize<Journal>(File.ReadAllText(target,Encoding.UTF8)); if(!value.cleaned&&File.Exists(target+".changes")) { value.changes.Clear(); foreach(string line in File.ReadLines(target+".changes",Encoding.UTF8)) if(line.Length>0) value.changes.Add(new JavaScriptSerializer().Deserialize<Change>(line)); } return value; }
  static string Quote(string value) { if (value.Length>0 && value.IndexOfAny(new char[]{' ','\t','\n','\v','"'})<0) return value; StringBuilder b=new StringBuilder("\""); int slashes=0; foreach(char c in value) { if(c=='\\') slashes++; else { if(c=='"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes); slashes=0; b.Append(c); } } b.Append('\\',slashes*2); return b.Append('"').ToString(); }
  static Mutex ObjectLock(string target) { string hash; using(SHA256 algorithm=SHA256.Create()) hash=BitConverter.ToString(algorithm.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(target).ToUpperInvariant()))).Replace("-",""); Mutex mutex=new Mutex(false,"Global\\KodoSandboxAcl-"+hash); try { mutex.WaitOne(); } catch(AbandonedMutexException) {} return mutex; }
  static void Persist(string target,FileSystemSecurity security) { Check(SetFileSecurity(target,4,security.GetSecurityDescriptorBinaryForm()),"update scoped file ACL"); }
  static bool Redirected(string target) { for(string current=Path.GetFullPath(target);current!=null;current=Path.GetDirectoryName(current)) if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) return true; return false; }
  static void Grant(string target,FileSystemRights rights,AccessControlType type,bool inherit=false) {
    bool directory=Directory.Exists(target); if (!directory && !File.Exists(target)) throw new IOException("Sandbox path does not exist: "+target);
    if(Redirected(target)) throw new IOException("Sandbox grant cannot traverse a reparse point");
    using(Mutex mutex=ObjectLock(target)) try {
    FileSystemSecurity security=directory?(FileSystemSecurity)Directory.GetAccessControl(target):File.GetAccessControl(target);
    if(journal.changes.Count>=50000) throw new IOException("Windows sandbox scope exceeds 50000 objects; use a narrower scope");
    Record(new Change { path=target,directory=directory,acl=true });
    security.AddAccessRule(new FileSystemAccessRule(identity,rights,directory&&inherit?InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit:InheritanceFlags.None,PropagationFlags.None,type));
    // SetFileSecurity deliberately avoids propagating the parent's new ACE to
    // existing children. Existing objects get explicit grants only after scope
    // checks; future objects inherit the grant when the child creates them.
    Persist(target,security);
    } finally { mutex.ReleaseMutex(); }
  }
  static void RemoveGrant(string target) {
    if(!File.Exists(target)&&!Directory.Exists(target)) return;
    if(Redirected(target)) return;
    using(Mutex mutex=ObjectLock(target)) try {
      FileSystemSecurity security=Directory.Exists(target)?(FileSystemSecurity)Directory.GetAccessControl(target):File.GetAccessControl(target);
      RawSecurityDescriptor descriptor=new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(),0);
      bool changed=false;
      if(descriptor.DiscretionaryAcl!=null) for(int i=descriptor.DiscretionaryAcl.Count-1;i>=0;i--) { KnownAce ace=descriptor.DiscretionaryAcl[i] as KnownAce; if(ace!=null&&ace.SecurityIdentifier.Equals(identity)) { descriptor.DiscretionaryAcl.RemoveAce(i); changed=true; } }
      if(!changed) return;
      byte[] bytes=new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes,0);
      Check(SetFileSecurity(target,4,bytes),"remove sandbox ACL");
    } finally { mutex.ReleaseMutex(); }
  }
  // Inheritance propagation rewrites every descendant from its parent's DACL, so
  // two sandboxes propagating over the same tree could drop each other's ACEs.
  static Mutex TreeLock() { Mutex mutex=new Mutex(false,"Global\\KodoSandboxAclTree"); try { mutex.WaitOne(); } catch(AbandonedMutexException) {} return mutex; }
  static void AccessTree(string target,string operation,string rights=null,bool recursive=true) {
    if(!File.Exists(target)&&!Directory.Exists(target)) throw new IOException("Sandbox path does not exist: "+target);
    if(Redirected(target)) throw new IOException("Sandbox grant cannot traverse a reparse point");
    string sid="*"+identity.Value;
    string rule=Directory.Exists(target)?"(OI)(CI)"+(rights??""):rights??"";
    ProcessStartInfo info=new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"icacls.exe")); info.UseShellExecute=false; info.CreateNoWindow=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
    info.Arguments=Quote(target)+" /"+operation+" "+Quote(operation=="remove"?sid:sid+":"+rule)+(recursive?" /T /C":"")+" /Q";
    using(Mutex mutex=TreeLock()) try {
      using(Process child=Process.Start(info)) { string output=child.StandardOutput.ReadToEnd(); string error=child.StandardError.ReadToEnd(); child.WaitForExit(); if(child.ExitCode!=0) throw new IOException("icacls "+operation+" failed for "+target+" (exit "+child.ExitCode+"): "+error+output); }
    } finally { mutex.ReleaseMutex(); }
  }
  // Reads only the descriptor control bits; the managed ACL wrappers cost far more per object on large trees.
  static bool ProtectedDacl(string target) {
    IntPtr owner,group,dacl,sacl,descriptor; uint error=GetNamedSecurityInfo(target,1,0x4,out owner,out group,out dacl,out sacl,out descriptor); if(error!=0) throw new Win32Exception((int)error,"read DACL control for "+target);
    try { ushort control; uint revision; Check(GetSecurityDescriptorControl(descriptor,out control,out revision),"read DACL control"); return (control&0x1000)!=0; } finally { LocalFree(descriptor); }
  }
  // One inheritable grant on the root reaches every existing descendant through
  // native propagation (and new objects on creation), instead of an explicit
  // per-object pass over large dependency trees. Objects with a protected DACL
  // do not inherit, so each receives its own inheritable grant.
  static void GrantTree(string target,string rights,bool deny=false) {
    Record(new Change { path=target,directory=Directory.Exists(target),acl=true,recursive=true,inherited=true });
    AccessTree(target,deny?"deny":"grant",rights,false);
    foreach(string path in Tree(target)) if(!path.Equals(target,StringComparison.OrdinalIgnoreCase)&&ProtectedDacl(path)) {
      Record(new Change { path=path,directory=Directory.Exists(path),acl=true,recursive=true,inherited=true });
      AccessTree(path,deny?"deny":"grant",rights,false);
    }
  }
  // Journals written before inheritance mode carry explicit per-object ACEs and keep the /T revert.
  static void RemoveGrantTree(string target,bool inherited) { if(!File.Exists(target)&&!Directory.Exists(target)) return; AccessTree(target,"remove",null,!inherited); }
  static void AcquireWriter() {
    if(writerGate!=null) return;
    Mutex mutex=new Mutex(false,"Global\\KodoSandboxWriter-"+WindowsIdentity.GetCurrent().User.Value);
    bool acquired=false; try { acquired=mutex.WaitOne(0); } catch(AbandonedMutexException) { acquired=true; }
    if(!acquired) { mutex.Dispose(); throw new IOException("Another Windows workspace-writing sandbox is active; close it before starting another writer"); }
    writerGate=mutex;
  }
  static void RecoverWriter(string state) {
    if(!File.Exists(state)) return;
    string previous=File.ReadAllText(state,Encoding.UTF8);
    if(!File.Exists(previous)) throw new IOException("Previous sandbox cleanup journal is missing: "+previous);
    journalPath=previous; journal=ReadJournal(previous);
    Cleanup(); journal=null; journalPath=null;
  }
  static string ReadLabel(string target) { IntPtr owner,group,dacl,sacl,descriptor; uint error=GetNamedSecurityInfo(target,1,0x10,out owner,out group,out dacl,out sacl,out descriptor); if(error!=0) throw new Win32Exception((int)error,"read integrity label"); try { IntPtr text; uint length; Check(ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,0x10,out text,out length),"encode integrity label"); try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); } } finally { LocalFree(descriptor); } }
  static uint SetLabel(string target,IntPtr sacl) { return SetNamedSecurityInfo(target,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl); }
  static void Label(string target,string value) {
    IntPtr descriptor; uint length; Check(ConvertStringSecurityDescriptorToSecurityDescriptor(string.IsNullOrEmpty(value)?"S:":value,1,out descriptor,out length),"create integrity label");
    try {
      bool present,defaulted; IntPtr sacl; Check(GetSecurityDescriptorSacl(descriptor,out present,out sacl,out defaulted),"read integrity label");
      uint error=SetLabel(target,sacl); if(error==0) return;
      if(error!=5) throw new Win32Exception((int)error,"set integrity label for "+target+" (Windows error "+error+")");
      // LABEL_SECURITY_INFORMATION requires WRITE_OWNER. Repository volumes may
      // intentionally give the owner only Modify rights, so grant that one bit
      // while changing the label and then restore the exact original DACL.
      // Objects created inside the AppContainer can carry a non-canonical DACL;
      // FileSystemSecurity refuses to edit those, so use the raw descriptor.
      // The restored DACL snapshot includes inherited ACEs; hold the tree lock so a
      // concurrent propagation cannot land between the snapshot and the restore.
      using(Mutex tree=TreeLock()) try { using(Mutex mutex=ObjectLock(target)) try {
        bool directory=Directory.Exists(target);
        FileSystemSecurity security=directory?(FileSystemSecurity)Directory.GetAccessControl(target):File.GetAccessControl(target);
        byte[] original=security.GetSecurityDescriptorBinaryForm();
        RawSecurityDescriptor raw=new RawSecurityDescriptor(original,0);
        RawAcl acl=raw.DiscretionaryAcl??new RawAcl(GenericAcl.AclRevision,1);
        acl.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,(int)FileSystemRights.TakeOwnership,WindowsIdentity.GetCurrent().User,false,null));
        raw.DiscretionaryAcl=acl;
        byte[] widened=new byte[raw.BinaryLength]; raw.GetBinaryForm(widened,0);
        Check(SetFileSecurity(target,4,widened),"grant temporary WRITE_OWNER for integrity label update");
        try { error=SetLabel(target,sacl); if(error!=0) throw new Win32Exception((int)error,"set integrity label for "+target+" (Windows error "+error+")"); }
        finally { Check(SetFileSecurity(target,4,original),"restore host DACL after integrity label update"); }
      } finally { mutex.ReleaseMutex(); } } finally { tree.ReleaseMutex(); }
    } finally { LocalFree(descriptor); }
  }
  static bool Denied(string path) { foreach(string denied in journal.deny) if(path.Equals(denied,StringComparison.OrdinalIgnoreCase)||path.StartsWith(denied.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) return true; return false; }
  // Iterative walk over enumerated entry attributes: nested iterators plus a stat per
  // entry cost seconds on dependency trees. Denied and reparse entries are skipped whole.
  static IEnumerable<string> Tree(string path) {
    if(Denied(path)||(!File.Exists(path)&&!Directory.Exists(path))) yield break;
    if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) yield break;
    yield return path;
    if(!Directory.Exists(path)) yield break;
    Stack<DirectoryInfo> pending=new Stack<DirectoryInfo>(); pending.Push(new DirectoryInfo(path));
    while(pending.Count>0) foreach(FileSystemInfo item in pending.Pop().EnumerateFileSystemInfos()) {
      if(Denied(item.FullName)||(item.Attributes&FileAttributes.ReparsePoint)!=0) continue;
      yield return item.FullName;
      DirectoryInfo directory=item as DirectoryInfo; if(directory!=null) pending.Push(directory);
    }
  }
  static IEnumerable<string> ResourceTree(string path) { if(!File.Exists(path)&&!Directory.Exists(path)) throw new IOException("Sandbox resource is missing"); if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) throw new IOException("Sandbox resources cannot contain reparse points"); yield return path; if(Directory.Exists(path)) foreach(string item in Directory.EnumerateFileSystemEntries(path)) foreach(string nested in ResourceTree(item)) yield return nested; }
  static void Writable(string root) { foreach(string path in Tree(root)) { if(journal.changes.Count>=50000) throw new IOException("Windows sandbox writable scope exceeds 50000 objects; use a narrower scope"); Record(new Change { path=path,directory=Directory.Exists(path),label=ReadLabel(path) }); Label(path,"S:(ML;;NW;;;LW)"); } }
  static void Cleanup() {
    if(journal==null||journal.cleaned) return;
    if(journal.workspaceWrite) AcquireWriter();
    IntPtr active=OpenJobObject(0x0008|0x0004,false,journal.profile);
    if(active!=IntPtr.Zero) try { Check(TerminateJobObject(active,125),"terminate sandbox job"); IntPtr info=Marshal.AllocHGlobal(48); try { bool empty=false; for(int attempt=0;attempt<200;attempt++) { Check(QueryInformationJobObject(active,1,info,48,IntPtr.Zero),"query sandbox job"); if(Marshal.ReadInt32(info,40)==0) { empty=true; break; } System.Threading.Thread.Sleep(50); } if(!empty) throw new IOException("Sandbox process tree has not stopped; permissions were not removed"); } finally { Marshal.FreeHGlobal(info); } } finally { CloseHandle(active); }
    identity=new SecurityIdentifier(journal.sid);
    // Every recorded object existed before the child process started. This also
    // remains true when preparation was interrupted after ACL grants but before
    // Writable() recorded integrity labels.
    HashSet<string> existing=new HashSet<string>(StringComparer.OrdinalIgnoreCase); foreach(Change c in journal.changes) existing.Add(c.path);
    // Newly-created low-integrity files belong to this invocation. Restore the
    // normal medium label before removing the temporary AppContainer grants.
    foreach(string root in journal.write) foreach(string path in Tree(root)) if(!existing.Contains(path)) {
      // A host may have created normal files after an interrupted sandbox but
      // before journal recovery. Only sandbox-created Low Integrity objects need
      // promotion; forcing a label onto an already-normal host object can fail.
      string current=ReadLabel(path); if(current!=null&&current.IndexOf(";;;LW",StringComparison.OrdinalIgnoreCase)>=0) Label(path,"S:(ML;;NW;;;ME)");
      RemoveGrant(path);
    }
    for(int i=journal.changes.Count-1;i>=0;i--) { Change change=journal.changes[i]; if(!Directory.Exists(change.path)&&!File.Exists(change.path)) continue; if(Redirected(change.path)) continue; if(!change.acl) { Label(change.path,change.label); continue; } if(change.recursive) RemoveGrantTree(change.path,change.inherited); else RemoveGrant(change.path); }
    int deleted=DeleteAppContainerProfile(journal.profile); if(deleted<0 && deleted!=unchecked((int)0x80070002)) Marshal.ThrowExceptionForHR(deleted);
    journal.cleaned=true; Save();
    if(journal.workspaceWrite && File.Exists(journal.writerState) && File.ReadAllText(journal.writerState,Encoding.UTF8)==journalPath) File.Delete(journal.writerState);
  }
  public static int Main(string[] arguments) {
    IntPtr sid=IntPtr.Zero,job=IntPtr.Zero,attributes=IntPtr.Zero,capabilities=IntPtr.Zero,environment=IntPtr.Zero,networkSid=IntPtr.Zero,networkArray=IntPtr.Zero,optOut=IntPtr.Zero; PROCESS_INFORMATION child=new PROCESS_INFORMATION(); int code=125;
    List<IntPtr> derivedAllocations=new List<IntPtr>();
    SandboxPipeBroker pipeBroker=null;
    try {
      if(arguments.Length==2 && arguments[0]=="--cleanup") { journalPath=arguments[1]; if(!File.Exists(journalPath)) return 0; journal=ReadJournal(journalPath); Cleanup(); return 0; }
      if(arguments.Length!=1) throw new ArgumentException("Expected a trusted configuration path");
      Config config=new JavaScriptSerializer().Deserialize<Config>(File.ReadAllText(arguments[0],Encoding.UTF8));
      if(config.workspaceWrite) { AcquireWriter(); RecoverWriter(config.writerState); }
      int result=CreateAppContainerProfile(config.profile,config.profile,"Kodo isolated process",IntPtr.Zero,0,out sid); if(result<0) Marshal.ThrowExceptionForHR(result);
      identity=new SecurityIdentifier(sid);
      journalPath=config.journal; journal=new Journal { profile=config.profile,sid=identity.Value,write=config.write,deny=config.deny,workspaceWrite=config.workspaceWrite,writerState=config.writerState }; Save();
      if(config.workspaceWrite) File.WriteAllText(config.writerState,journalPath,Encoding.UTF8);
      // Inherited allow ACEs cannot reliably be overridden for an AppContainer
      // restricting SID on every supported Windows build. Keep the original
      // per-object path whenever protected entries exist; use native bulk ACLs
      // only for a scanned tree with no deny paths.
      if(config.deny.Length>0) {
        foreach(string root in config.read) foreach(string p in Tree(root)) Grant(p,FileSystemRights.ReadAndExecute,AccessControlType.Allow);
        foreach(string root in config.write) { foreach(string p in Tree(root)) Grant(p,FileSystemRights.Modify,AccessControlType.Allow,true); Writable(root); }
        foreach(string root in config.resources??new string[0]) foreach(string p in ResourceTree(root)) Grant(p,FileSystemRights.ReadAndExecute,AccessControlType.Allow);
      } else {
        foreach(string root in config.read) GrantTree(root,"RX");
        foreach(string root in config.write) { GrantTree(root,"M"); Writable(root); }
        foreach(string root in config.resources??new string[0]) { foreach(string ignored in ResourceTree(root)) break; GrantTree(root,"RX"); }
      }
      if(!string.IsNullOrEmpty(config.pipeDirectory)) {
        // The parent control directory is inaccessible to the AppContainer.
        // Grant file creation/removal inside this directory, but never DELETE
        // on the directory itself, so broker paths remain anchored here.
        Grant(config.pipeDirectory,FileSystemRights.ReadAndExecute|FileSystemRights.Write|FileSystemRights.DeleteSubdirectoriesAndFiles,AccessControlType.Allow,true);
        Writable(config.pipeDirectory);
      }
      SECURITY_CAPABILITIES sc=new SECURITY_CAPABILITIES { AppContainerSid=sid };
      List<IntPtr> childCapabilities=new List<IntPtr>();
      IntPtr groups,derived; uint groupCount,capabilityCount;
      Check(DeriveCapabilitySidsFromName("registryRead",out groups,out groupCount,out derived,out capabilityCount),"derive restricted registry capability");
      for(uint i=0;i<groupCount;i++) derivedAllocations.Add(Marshal.ReadIntPtr(groups,(int)i*IntPtr.Size));
      derivedAllocations.Add(groups);
      for(uint i=0;i<capabilityCount;i++) { IntPtr value=Marshal.ReadIntPtr(derived,(int)i*IntPtr.Size); derivedAllocations.Add(value); childCapabilities.Add(value); }
      derivedAllocations.Add(derived);
      if(config.network=="allow") { Check(ConvertStringSidToSid("S-1-15-3-1",out networkSid),"internet capability"); childCapabilities.Add(networkSid); }
      int sidSize=Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)); networkArray=Marshal.AllocHGlobal(sidSize*childCapabilities.Count);
      for(int i=0;i<childCapabilities.Count;i++) Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { Sid=childCapabilities[i],Attributes=4 },IntPtr.Add(networkArray,i*sidSize),false);
      sc.Capabilities=networkArray; sc.CapabilityCount=(uint)childCapabilities.Count;
      capabilities=Marshal.AllocHGlobal(Marshal.SizeOf(sc)); Marshal.StructureToPtr(sc,capabilities,false);
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size); attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,2,0,ref size),"initialize security attributes"); Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20009),capabilities,new IntPtr(Marshal.SizeOf(sc)),IntPtr.Zero,IntPtr.Zero),"AppContainer security capabilities");
      optOut=Marshal.AllocHGlobal(4); Marshal.WriteInt32(optOut,1); Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000f),optOut,new IntPtr(4),IntPtr.Zero,IntPtr.Zero),"restricted AppContainer policy");
      STARTUPINFOEX startup=new STARTUPINFOEX(); startup.StartupInfo.cb=Marshal.SizeOf(startup); startup.AttributeList=attributes; startup.StartupInfo.flags=0x100; startup.StartupInfo.stdInput=GetStdHandle(-10); startup.StartupInfo.stdOutput=GetStdHandle(-11); startup.StartupInfo.stdError=GetStdHandle(-12); SetHandleInformation(startup.StartupInfo.stdInput,1,1); SetHandleInformation(startup.StartupInfo.stdOutput,1,1); SetHandleInformation(startup.StartupInfo.stdError,1,1);
      List<string> vars=new List<string>(); foreach(KeyValuePair<string,string> pair in config.env) vars.Add(pair.Key+"="+pair.Value); vars.Sort(StringComparer.OrdinalIgnoreCase); environment=Marshal.StringToHGlobalUni(string.Join("\0",vars.ToArray())+"\0\0");
      StringBuilder command=new StringBuilder(Quote(config.program)); foreach(string arg in config.args) command.Append(" ").Append(Quote(arg));
      job=CreateJobObject(IntPtr.Zero,config.profile); Check(job!=IntPtr.Zero,"create job"); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags=0x2000;
      if(config.memoryBytes>0) { limits.BasicLimitInformation.LimitFlags|=0x200; limits.JobMemoryLimit=new UIntPtr(config.memoryBytes); }
      if(config.maxProcesses>0) { limits.BasicLimitInformation.LimitFlags|=0x8; limits.BasicLimitInformation.ActiveProcessLimit=config.maxProcesses; }
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"job resource limits and kill-on-close");
      Check(CreateProcess(config.program,command,IntPtr.Zero,IntPtr.Zero,true,0x00080000|0x00000400|0x00000004|0x08000000,environment,config.cwd,ref startup,out child),"create AppContainer process");
      Check(AssignProcessToJobObject(job,child.process),"assign AppContainer to job");
      if(!string.IsNullOrEmpty(config.pipeDirectory)) pipeBroker=new SandboxPipeBroker(config.pipeDirectory,job);
      if(ResumeThread(child.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(),"resume process"); WaitForSingleObject(child.process,0xffffffff); uint exit; Check(GetExitCodeProcess(child.process,out exit),"child exit code"); code=unchecked((int)exit);
    } catch(Exception error) { Console.Error.WriteLine("KODO_SANDBOX: "+error.Message); }
    finally {
      if(pipeBroker!=null) try { pipeBroker.Dispose(); } catch(Exception error) { Console.Error.WriteLine("KODO_PIPE_BROKER: "+error.Message); code=125; }
      try { Cleanup(); } catch(Exception error) { Console.Error.WriteLine("KODO_SANDBOX_CLEANUP: "+error.Message); code=125; }
      if(job!=IntPtr.Zero) CloseHandle(job); if(child.process!=IntPtr.Zero) { TerminateProcess(child.process,125); CloseHandle(child.process); } if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); } if(capabilities!=IntPtr.Zero) Marshal.FreeHGlobal(capabilities); if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment); if(networkArray!=IntPtr.Zero) Marshal.FreeHGlobal(networkArray); if(networkSid!=IntPtr.Zero) LocalFree(networkSid); if(optOut!=IntPtr.Zero) Marshal.FreeHGlobal(optOut); foreach(IntPtr value in derivedAllocations) if(value!=IntPtr.Zero) LocalFree(value); if(sid!=IntPtr.Zero) FreeSid(sid);
      if(writerGate!=null) { writerGate.ReleaseMutex(); writerGate.Dispose(); }
    }
    return code;
  }
}
