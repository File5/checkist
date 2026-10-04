"""Bounded streams, external deadline and process-tree cleanup on every exit."""
import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from recognition.providers.base import ProviderError, RunContext

MAX_STREAM_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes = b""
    stderr: bytes = b""  # private, never use as an exception message
    pid: int | None = None


class _PosixProcess:
    def __init__(self, argv, **kwargs):
        self.proc = subprocess.Popen(argv, shell=False, start_new_session=True, **kwargs)
        self.pid = self.proc.pid

    def poll(self):
        return self.proc.poll()

    def _signal(self, sig):
        try:
            os.killpg(self.pid, sig)
            return True
        except ProcessLookupError:
            return False

    def stop(self, grace=2):
        if self._signal(signal.SIGTERM):
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                try:
                    os.killpg(self.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.02)
            self._signal(signal.SIGKILL)
        self.proc.wait(timeout=5)

    def close(self):
        pass


class ProcessSupervisor:
    def __init__(self, *, cancel_grace_seconds=2, poll_interval=0.05, windows_use_job=True):
        self.cancel_grace_seconds = cancel_grace_seconds
        self.poll_interval = poll_interval
        # Explicit diagnostic fallback only. Assign/resume errors fail closed.
        self.windows_use_job = windows_use_job

    def run(self, argv, *, cwd, env, stdin, run: RunContext, output_path=None):
        run.check()
        cwd = Path(cwd)
        paths = [cwd / name for name in ("stdin.private", "stdout.private", "stderr.private")]
        proc = None
        try:
            # Exclusive files: reuse of an attempt is never accepted.
            with paths[0].open("xb") as stream:
                stream.write(stdin)
            with paths[0].open("rb") as source, paths[1].open("xb") as out, paths[2].open("xb") as err:
                if os.name == "nt":
                    from recognition.process_supervisor.windows import WindowsProcess
                    proc = WindowsProcess(argv, cwd=cwd, env=env, stdin=source, stdout=out,
                                          stderr=err, use_job=self.windows_use_job)
                else:
                    proc = _PosixProcess(argv, cwd=cwd, env=env, stdin=source, stdout=out, stderr=err)
                try:
                    while True:
                        # Check cancel/deadline before interpreting an exit.
                        run.check()
                        self._sizes(paths[1:], output_path)
                        code = proc.poll()
                        if code is not None:
                            break
                        time.sleep(self.poll_interval)
                    run.check()
                finally:
                    # Even normal root exit must not leave helper children.
                    proc.stop(self.cancel_grace_seconds)
                self._sizes(paths[1:], output_path)
                run.check()
                return ProcessResult(code, paths[1].read_bytes(), paths[2].read_bytes(), proc.pid)
        except ProviderError:
            raise
        except (FileNotFoundError, PermissionError, OSError, subprocess.SubprocessError):
            raise ProviderError("configuration_error") from None
        finally:
            if proc:
                proc.close()

    @staticmethod
    def _sizes(paths, output_path):
        for path in paths:
            if path.stat().st_size > MAX_STREAM_BYTES:
                raise ProviderError("invalid_output")
        if output_path is not None:
            try:
                if Path(output_path).stat().st_size > 4 * 1024 * 1024:
                    raise ProviderError("invalid_output")
            except FileNotFoundError:
                pass
