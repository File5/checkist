import ctypes
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest import skipUnless
from unittest.mock import patch

from django.test import SimpleTestCase

from recognition.process_supervisor import ProcessSupervisor
from recognition.providers.base import ProviderError, RunContext

TREE = """
import os, subprocess, sys, time
from pathlib import Path
root, level = Path(sys.argv[1]), int(sys.argv[2])
(root / ('pid' + str(level))).write_text(str(os.getpid()))
if level < 2:
    subprocess.Popen([sys.executable, __file__, str(root), str(level+1)])
time.sleep(60)
"""


def alive(pid):
    if os.name == "nt":
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
        if not handle:
            if ctypes.get_last_error() == 87: return False
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x102
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # Linux zombie has stopped execution; its reaping belongs to its parent.
    stat = Path(f"/proc/{pid}/stat")
    if stat.exists() and stat.read_text().split(")",1)[1].strip().startswith("Z"):
        return False
    return True


class SupervisorTests(SimpleTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="checkist-c2-supervisor-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pids = []

    def ready(self):
        files = list(self.root.glob("pid*"))
        if len(files) != 3: return False
        try: pids = [int(p.read_text()) for p in sorted(files)]
        except ValueError: return False
        if all(alive(pid) for pid in pids):
            self.pids = pids
            return True
        return False

    def assert_tree_dead(self):
        self.assertEqual(len(self.pids), 3, "Tree must have been running before cancellation.")
        deadline = time.monotonic()+5
        while any(alive(pid) for pid in self.pids) and time.monotonic()<deadline:
            time.sleep(0.02)
        self.assertFalse(any(alive(pid) for pid in self.pids), "A process in our test tree survived.")

    def tree_args(self):
        script = self.root/"tree.py"
        script.write_text(TREE,encoding="utf-8")
        return [sys.executable, str(script), str(self.root), "0"]

    def test_cancel_stops_root_child_grandchild(self):
        with self.assertRaises(ProviderError) as raised:
            ProcessSupervisor(cancel_grace_seconds=0.1).run(self.tree_args(), cwd=self.root,
                env=os.environ.copy(), stdin=b"", run=RunContext(time.monotonic()+10,is_cancelled=self.ready))
        self.assertEqual(raised.exception.code,"cancelled")
        self.assert_tree_dead()

    def test_deadline_stops_root_child_grandchild(self):
        # Set the short deadline only after readiness; no guessed startup sleep.
        deadline=[time.monotonic()+10]
        class TreeDeadline:
            def check(inner):
                if self.ready() and deadline[0] > time.monotonic()+1:
                    deadline[0]=time.monotonic()+0.1
                if time.monotonic() >= deadline[0]: raise ProviderError("timeout")
        with self.assertRaises(ProviderError) as raised:
            ProcessSupervisor(cancel_grace_seconds=0.1).run(self.tree_args(),cwd=self.root,
                env=os.environ.copy(),stdin=b"",run=TreeDeadline())
        self.assertEqual(raised.exception.code,"timeout")
        self.assert_tree_dead()

    def test_cancel_and_timeout_before_spawn_and_cancel_priority(self):
        for run, expected in ((RunContext(time.monotonic()-1),"timeout"),
                              (RunContext(time.monotonic()-1,is_cancelled=lambda:True),"cancelled")):
            with self.subTest(expected=expected),self.assertRaises(ProviderError) as raised:
                ProcessSupervisor().run([sys.executable,"-c","raise Exception()"],cwd=self.root,
                    env=os.environ.copy(),stdin=b"",run=run)
            self.assertEqual(raised.exception.code,expected)
        self.assertFalse((self.root/"stdin.private").exists())

    def test_stdin_utf8_streams_and_exitcode(self):
        script="import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.buffer.write(b'private'); sys.exit(7)"
        result=ProcessSupervisor().run([sys.executable,"-c",script],cwd=self.root,env=os.environ.copy(),
            stdin="тест\n".encode(),run=RunContext(time.monotonic()+5))
        self.assertEqual(result.returncode,7)
        self.assertEqual(result.stdout,"тест\n".encode())
        self.assertEqual(result.stderr,b"private")
        self.assertFalse(alive(result.pid))

    def test_stream_limit_stops_tree(self):
        script=self.root/"tree.py"
        script.write_text(TREE.replace("time.sleep(60)", "\nif level == 0:\n    while not (root/'pid2').exists(): time.sleep(0.01)\n    sys.stdout.buffer.write(b'x' * 100000)\n    sys.stdout.buffer.flush()\ntime.sleep(60)"),encoding="utf-8")
        def capture():
            self.ready()
            return False
        with patch("recognition.process_supervisor.supervisor.MAX_STREAM_BYTES",1024):
            with self.assertRaises(ProviderError) as raised:
                ProcessSupervisor(cancel_grace_seconds=0.1).run([sys.executable,str(script),str(self.root),"0"],
                    cwd=self.root,env=os.environ.copy(),stdin=b"",run=RunContext(time.monotonic()+10,is_cancelled=capture))
        self.assertEqual(raised.exception.code,"invalid_output")
        self.assert_tree_dead()

    def test_root_exit_also_cleans_its_children(self):
        script=self.root/"tree.py"
        script.write_text(TREE.replace("time.sleep(60)", "\nif level == 0:\n    while not (root/'pid2').exists(): time.sleep(0.01)\n    time.sleep(0.1)\nelse: time.sleep(60)"),encoding="utf-8")
        def capture():
            self.ready()
            return False
        result=ProcessSupervisor(cancel_grace_seconds=0.1).run([sys.executable,str(script),str(self.root),"0"],
            cwd=self.root,env=os.environ.copy(),stdin=b"",run=RunContext(time.monotonic()+10,is_cancelled=capture))
        self.assertEqual(result.returncode,0)
        self.assert_tree_dead()

    def test_callback_failure_still_stops_tree(self):
        def fail():
            if self.ready(): raise RuntimeError("worker callback failed")
            return False
        with self.assertRaisesRegex(RuntimeError,"worker callback failed"):
            ProcessSupervisor(cancel_grace_seconds=0.1).run(self.tree_args(),cwd=self.root,
                env=os.environ.copy(),stdin=b"",run=RunContext(time.monotonic()+10,is_cancelled=fail))
        self.assert_tree_dead()

    @skipUnless(os.name == "nt", "Windows taskkill path")
    def test_windows_taskkill_fallback(self):
        with self.assertRaises(ProviderError) as raised:
            ProcessSupervisor(windows_use_job=False).run(self.tree_args(),cwd=self.root,
                env=os.environ.copy(),stdin=b"",run=RunContext(time.monotonic()+10,is_cancelled=self.ready))
        self.assertEqual(raised.exception.code,"cancelled")
        self.assert_tree_dead()

    @skipUnless(os.name == "nt", "Windows suspended process path")
    def test_windows_assign_failure_never_executes_child(self):
        from recognition.process_supervisor import windows
        kernel=windows._api()
        created=[]
        create=kernel.CreateProcessW
        def record(*args):
            result=create(*args)
            if result:
                info=ctypes.cast(args[-1],ctypes.POINTER(windows.PROCESS_INFORMATION)).contents
                created.append(info.dwProcessId)
            return result
        kernel.CreateProcessW=record
        def reject(*args):
            ctypes.set_last_error(5)
            return 0
        kernel.AssignProcessToJobObject=reject
        with patch.object(windows,"_api",return_value=kernel), self.assertRaises(ProviderError) as raised:
            ProcessSupervisor().run(self.tree_args(),cwd=self.root,env=os.environ.copy(),stdin=b"",
                run=RunContext(time.monotonic()+10))
        self.assertEqual(raised.exception.code,"configuration_error")
        self.assertEqual(len(created),1)
        self.assertFalse(alive(created[0]))
        self.assertEqual(list(self.root.glob("pid*")),[])

    @skipUnless(os.name == "nt", "Windows Job Object path")
    def test_windows_last_job_handle_close_kills_all_descendants(self):
        from recognition.process_supervisor.windows import WindowsProcess
        with (self.root/"in").open("w+b") as source, (self.root/"out").open("w+b") as out, (self.root/"err").open("w+b") as err:
            proc=WindowsProcess(self.tree_args(),cwd=self.root,env=os.environ.copy(),stdin=source,stdout=out,stderr=err)
            try:
                deadline=time.monotonic()+5
                while not self.ready() and time.monotonic()<deadline:
                    time.sleep(0.02)
                self.assertTrue(self.ready())
                # No TerminateJobObject or taskkill: tests KILL_ON_JOB_CLOSE.
                proc.close()
                self.assert_tree_dead()
            finally:
                proc.close()
