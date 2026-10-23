# Closing the supervisor closes the job and terminates all descendants.
param([Parameter(Mandatory=$true)][string]$InvocationBase64)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PipelineJob {
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long perProcess, perJob; public uint flags;
        public UIntPtr min, max; public uint active; public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public Basic basic; public IO io;
        public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint size; public string reserved, desktop, title;
        public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
        public ushort show, reservedSize; public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process, thread; public uint pid, tid;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long user, kernel, periodUser, periodKernel;
        public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok) {
        if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    public static int Run(string line) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        ProcessInfo process = new ProcessInfo();
        try {
            Limits limits = new Limits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            Startup startup = new Startup();
            startup.size = (uint)Marshal.SizeOf(startup);
            startup.flags = 0x100;
            startup.input = GetStdHandle(-10);
            startup.output = GetStdHandle(-11);
            startup.error = GetStdHandle(-12);
            // Assign the suspended process before any deployment code can execute.
            Check(CreateProcess(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true,
                0x08000004, IntPtr.Zero, null, ref startup, out process));
            if (!AssignProcessToJobObject(job, process.process)) {
                TerminateProcess(process.process, 1);
                Check(false);
            }
            if (ResumeThread(process.thread) == UInt32.MaxValue) {
                TerminateProcess(process.process, 1);
                throw new Exception("Cannot resume deployment process");
            }
            WaitForSingleObject(process.process, UInt32.MaxValue);
            uint code;
            Check(GetExitCodeProcess(process.process, out code));
            Accounting accounting;
            // Job accounting may lag the process handle signal briefly.
            int attempts = 0;
            do {
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.active == 0) break;
                System.Threading.Thread.Sleep(10);
            } while (++attempts < 25);
            if (accounting.active != 0) {
                // The executor quarantines on this marker: a forced cleanup is never a normal finish.
                Console.Error.WriteLine("PIPELINE_JOB_FORCED_CLEANUP: command exited with live descendants; terminating the job");
                TerminateJobObject(job, 1);
                attempts = 0;
                do {
                    Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                    if (accounting.active == 0) break;
                    System.Threading.Thread.Sleep(20);
                } while (++attempts < 100);
                return 1;
            }
            return unchecked((int)code);
        } finally {
            CloseHandle(job);
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
        }
    }
}
'@
$line = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InvocationBase64))
exit [PipelineJob]::Run($line)
