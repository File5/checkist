"""Documented Win32 ctypes APIs, no private subprocess/_winapi helpers.

CreateProcessW(CREATE_SUSPENDED) -> AssignProcessToJobObject -> ResumeThread.
Only three duplicated stream handles are inherited, never the job handle.
KILL_ON_JOB_CLOSE also stops ordinary descendants if the worker crashes.

References:
https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
"""
import ctypes as c
import subprocess
import time
from ctypes import wintypes as w

SIZE_T = c.c_size_t
ULONG_PTR = c.c_size_t
LARGE_INTEGER = c.c_longlong


class STARTUPINFO(c.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR),
                ("lpTitle", w.LPWSTR), ("dwX", w.DWORD), ("dwY", w.DWORD),
                ("dwXSize", w.DWORD), ("dwYSize", w.DWORD), ("dwXCountChars", w.DWORD),
                ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD), ("dwFlags", w.DWORD),
                ("wShowWindow", w.WORD), ("cbReserved2", w.WORD), ("lpReserved2", c.c_void_p),
                ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class STARTUPINFOEX(c.Structure):
    _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", c.c_void_p)]


class PROCESS_INFORMATION(c.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class BASIC_LIMIT(c.Structure):
    _fields_ = [("PerProcessUserTimeLimit", LARGE_INTEGER), ("PerJobUserTimeLimit", LARGE_INTEGER),
                ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", SIZE_T), ("MaximumWorkingSetSize", SIZE_T),
                ("ActiveProcessLimit", w.DWORD), ("Affinity", ULONG_PTR), ("PriorityClass", w.DWORD),
                ("SchedulingClass", w.DWORD)]


class IO_COUNTERS(c.Structure):
    _fields_ = [(name, c.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount",
                "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class EXTENDED_LIMIT(c.Structure):
    _fields_ = [("BasicLimitInformation", BASIC_LIMIT), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", SIZE_T), ("JobMemoryLimit", SIZE_T),
                ("PeakProcessMemoryUsed", SIZE_T), ("PeakJobMemoryUsed", SIZE_T)]


class ACCOUNTING(c.Structure):
    _fields_ = [(name, LARGE_INTEGER) for name in ("TotalUserTime", "TotalKernelTime",
                "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime")] + [
                (name, w.DWORD) for name in ("TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")]


def _api():
    dll = c.WinDLL("kernel32", use_last_error=True)
    specs = {
        "CreateJobObjectW": ([c.c_void_p, w.LPCWSTR], w.HANDLE),
        "SetInformationJobObject": ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
        "QueryInformationJobObject": ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p], w.BOOL),
        "AssignProcessToJobObject": ([w.HANDLE, w.HANDLE], w.BOOL),
        "TerminateJobObject": ([w.HANDLE, w.UINT], w.BOOL),
        "CreateProcessW": ([w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD,
                           c.c_void_p, w.LPCWSTR, c.c_void_p, c.POINTER(PROCESS_INFORMATION)], w.BOOL),
        "ResumeThread": ([w.HANDLE], w.DWORD),
        "TerminateProcess": ([w.HANDLE, w.UINT], w.BOOL),
        "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
        "GetExitCodeProcess": ([w.HANDLE, c.POINTER(w.DWORD)], w.BOOL),
        "CloseHandle": ([w.HANDLE], w.BOOL),
        "GetCurrentProcess": ([], w.HANDLE),
        "DuplicateHandle": ([w.HANDLE, w.HANDLE, w.HANDLE, c.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD], w.BOOL),
        "InitializeProcThreadAttributeList": ([c.c_void_p, w.DWORD, w.DWORD, c.POINTER(SIZE_T)], w.BOOL),
        "UpdateProcThreadAttribute": ([c.c_void_p, w.DWORD, SIZE_T, c.c_void_p, SIZE_T, c.c_void_p, c.c_void_p], w.BOOL),
        "DeleteProcThreadAttributeList": ([c.c_void_p], None),
    }
    for name, (args, result) in specs.items():
        fn = getattr(dll, name)
        fn.argtypes, fn.restype = args, result
    return dll


def _check(ok):
    if not ok:
        raise c.WinError(c.get_last_error())


class WindowsProcess:
    def __init__(self, argv, *, cwd, env, stdin, stdout, stderr, use_job=True):
        import msvcrt

        self.api = k = _api()
        self.job = self.handle = None
        self.pid = None
        duplicates = []
        attr = None
        thread = None
        try:
            if use_job:
                self.job = k.CreateJobObjectW(None, None)
                _check(self.job)
                limits = EXTENDED_LIMIT()
                limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
                _check(k.SetInformationJobObject(self.job, 9, c.byref(limits), c.sizeof(limits)))
            current = k.GetCurrentProcess()
            for stream in (stdin, stdout, stderr):
                duplicate = w.HANDLE()
                _check(k.DuplicateHandle(current, msvcrt.get_osfhandle(stream.fileno()), current,
                                        c.byref(duplicate), 0, True, 2))
                duplicates.append(duplicate.value)
            size = SIZE_T()
            k.InitializeProcThreadAttributeList(None, 1, 0, c.byref(size))
            attr_buffer = c.create_string_buffer(size.value)
            _check(k.InitializeProcThreadAttributeList(attr_buffer, 1, 0, c.byref(size)))
            attr = attr_buffer  # delete only a successfully initialized list
            handle_list = (w.HANDLE * 3)(*duplicates)
            _check(k.UpdateProcThreadAttribute(attr, 0, 0x20002, handle_list, c.sizeof(handle_list), None, None))
            info = STARTUPINFOEX()
            info.StartupInfo.cb = c.sizeof(info)
            info.StartupInfo.dwFlags = 0x100  # STARTF_USESTDHANDLES
            info.StartupInfo.hStdInput, info.StartupInfo.hStdOutput, info.StartupInfo.hStdError = duplicates
            info.lpAttributeList = c.cast(attr, c.c_void_p)
            proc_info = PROCESS_INFORMATION()
            block = c.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(env.items(), key=lambda p: p[0].upper())) + "\0\0")
            command = c.create_unicode_buffer(subprocess.list2cmdline([str(a) for a in argv]))
            # applicationName is explicit: executable paths with spaces are safe.
            _check(k.CreateProcessW(str(argv[0]), command, None, None, True,
                                   0x4 | 0x8000000 | 0x400 | 0x80000,
                                   block, str(cwd), c.byref(info), c.byref(proc_info)))
            self.handle, thread, self.pid = proc_info.hProcess, proc_info.hThread, proc_info.dwProcessId
            if self.job:
                _check(k.AssignProcessToJobObject(self.job, self.handle))
            if k.ResumeThread(thread) == 0xFFFFFFFF:
                _check(False)
        except BaseException:
            # Assignment/resume failures never run an uncontained child.
            if self.handle:
                k.TerminateProcess(self.handle, 1)
                k.WaitForSingleObject(self.handle, 5000)
            self.close()
            raise
        finally:
            if thread:
                k.CloseHandle(thread)
            if attr:
                k.DeleteProcThreadAttributeList(attr)
            for handle in duplicates:
                k.CloseHandle(handle)

    def poll(self):
        result = self.api.WaitForSingleObject(self.handle, 0)
        if result == 0x102:  # WAIT_TIMEOUT (don't confuse exit code 259 with STILL_ACTIVE)
            return None
        if result != 0:
            _check(False)
        code = w.DWORD()
        _check(self.api.GetExitCodeProcess(self.handle, c.byref(code)))
        return code.value

    def stop(self, grace=0):
        if self.job:
            # No assumption that Codex responds to console signals. Deadline
            # is external; force-stop the job and audit ActiveProcesses.
            _check(self.api.TerminateJobObject(self.job, 1))
            deadline = time.monotonic() + 5
            while True:
                stats = ACCOUNTING()
                _check(self.api.QueryInformationJobObject(self.job, 1, c.byref(stats), c.sizeof(stats), None))
                if not stats.ActiveProcesses:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("Process tree did not stop.")
                time.sleep(0.02)
        elif self.poll() is None:
            self.taskkill()
        if self.api.WaitForSingleObject(self.handle, 5000) != 0:
            raise TimeoutError("Process did not stop.")

    def taskkill(self):
        # Deliberately limited to the PID we created. No shell and no /IM.
        import os
        executable = os.path.join(os.environ["SystemRoot"], "System32", "taskkill.exe")
        result = subprocess.run([executable, "/PID", str(self.pid), "/T", "/F"], shell=False,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=0x8000000, timeout=5)
        if result.returncode and self.poll() is None:
            raise OSError("Process tree could not be stopped.")

    def close(self):
        if self.job:
            self.api.CloseHandle(self.job)
            self.job = None
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None
