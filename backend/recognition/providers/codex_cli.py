"""Codex CLI extractor, with no ORM and no implicit fake fallback."""
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

from recognition.process_supervisor import ProcessSupervisor
from recognition.process_supervisor.supervisor import MAX_STREAM_BYTES
from recognition.providers.base import ProviderError
from recognition.schema_validation import (
    MAX_OUTPUT_BYTES, SchemaValidationError, load_json, validate_detection, validate_observation,
)

PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def _positive(value):
    try:
        result = float(value)
        if isinstance(value, bool) or not math.isfinite(result) or result <= 0:
            raise ValueError
        return result
    except (ValueError, TypeError, OverflowError):
        raise ProviderError("configuration_error") from None


@dataclass(frozen=True)
class CodexConfig:
    executable: str
    model: str
    temp_root: Path
    detect_timeout_seconds: float = 90
    recognize_timeout_seconds: float = 180
    cancel_grace_seconds: float = 2
    codex_home: str | None = None

    def __post_init__(self):
        if not isinstance(self.executable, (str, Path)) or not str(self.executable):
            raise ProviderError("configuration_error")
        if not isinstance(self.model, str) or not self.model or any(ord(c) < 32 for c in self.model):
            raise ProviderError("configuration_error")
        if not isinstance(self.temp_root, Path) or not self.temp_root.is_absolute():
            raise ProviderError("configuration_error")
        if self.codex_home is not None and (not isinstance(self.codex_home, (str, Path)) or not Path(self.codex_home).is_absolute()):
            raise ProviderError("configuration_error")
        for seconds in (self.detect_timeout_seconds, self.recognize_timeout_seconds, self.cancel_grace_seconds):
            _positive(seconds)

    @classmethod
    def from_settings(cls):
        root = getattr(settings, "RECEIPT_OCR_TEMP_ROOT", Path(tempfile.gettempdir()) / "checkist-recognition")
        if not isinstance(root, (str, Path)) or not str(root):
            raise ProviderError("configuration_error")
        return cls(
            executable=getattr(settings, "RECEIPT_OCR_CODEX_EXECUTABLE", "codex"),
            model=getattr(settings, "RECEIPT_OCR_MODEL", "gpt-6.1-sol"),
            temp_root=Path(root),
            detect_timeout_seconds=_positive(getattr(settings, "RECEIPT_OCR_DETECT_TIMEOUT_SECONDS", 90)),
            recognize_timeout_seconds=_positive(getattr(settings, "RECEIPT_OCR_RECOGNIZE_TIMEOUT_SECONDS", 180)),
            cancel_grace_seconds=_positive(getattr(settings, "RECEIPT_OCR_CANCEL_GRACE_SECONDS", 2)),
            codex_home=getattr(settings, "RECEIPT_OCR_CODEX_HOME", None),
        )


def child_environment(codex_home=None):
    """Allow only OS/runtime, service auth directory and network configuration.

    ChatGPT auth is reused. No DB/Redis/ORCA variables or unused API keys.
    The caller's os.environ and Codex auth/config are never modified.
    """
    allowed = {"path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "home",
               "userprofile", "appdata", "localappdata", "username", "user", "logname",
               "homedrive", "homepath", "lang", "lc_all", "codex_home", "xdg_config_home",
               "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir"}
    env = {k: v for k, v in os.environ.items() if k.lower() in allowed}
    if codex_home:
        env["CODEX_HOME"] = str(codex_home)
    return env


def validate_prepared_image(image):
    # Same Pillow dependency as the preparation/cropping boundary in C1.
    try:
        from PIL import Image
    except ImportError:
        raise ProviderError("configuration_error") from None
    try:
        path = Path(image.path).resolve(strict=True)
        if not path.is_file() or not re.fullmatch(r"[0-9a-f]{64}", image.sha256):
            raise ValueError
        if type(image.width) is not int or type(image.height) is not int or min(image.width, image.height) <= 0:
            raise ValueError
        if image.width * image.height > 40_000_000 or path.stat().st_size > 160 * 1024 * 1024:
            raise ValueError
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != image.sha256:
                raise ValueError
        with Image.open(path) as decoded:
            if decoded.format not in ("PNG", "JPEG", "WEBP") or decoded.size != (image.width, image.height) or getattr(decoded, "n_frames", 1) != 1:
                raise ValueError
            decoded.verify()
        with Image.open(path) as decoded:
            if decoded.getexif().get(274, 1) != 1:
                raise ValueError
            decoded.load()
        return path
    except (OSError, ValueError, TypeError, AttributeError, Image.DecompressionBombError):
        raise ProviderError("invalid_input") from None


def build_argv(executable, model, work, schema, output, image):
    return [str(executable), "-a", "never", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "-C", str(work), "-m", model, "-s", "read-only",
            "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "multi_agent",
            "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
            "-c", 'model_reasoning_effort="low"', "--color", "never", "--json",
            "--output-schema", str(schema), "-o", str(output), "-i", str(image), "-"]


def _error_code(text):
    # Used only on private provider error events/diagnostics, never returned.
    lowered = text.lower()
    if any(s in lowered for s in ("unexpected argument", "unknown option", "unrecognized option", "invalid configuration", "invalid schema")):
        return "configuration_error"
    if any(s in lowered for s in ("invalid_api_key", "unauthorized", "authentication", "status 401", "status: 401", "not logged in")):
        return "auth_required"
    if any(s in lowered for s in ("rate_limit", "too many requests", "status 429", "status: 429", "usage limit")):
        return "rate_limited"
    if any(s in lowered for s in ("connection failed", "error sending request", "network", "dns", "connection refused")):
        return "network_unavailable"
    return "provider_unavailable"


def validate_events(result):
    if len(result.stdout) > MAX_STREAM_BYTES or len(result.stderr) > MAX_STREAM_BYTES:
        raise ProviderError("invalid_output")
    completed = 0
    failed = []
    turn_started = False
    try:
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            event = load_json(line, max_bytes=MAX_STREAM_BYTES)
            if type(event) is not dict or type(event.get("type")) is not str:
                raise SchemaValidationError()
            kind = event["type"]
            if completed:
                raise SchemaValidationError()
            if kind.startswith("item."):
                item = event.get("item")
                if not turn_started or type(item) is not dict or item.get("type") not in ("agent_message", "reasoning"):
                    # Reject all tool calls, including new unknown item types.
                    raise ProviderError("invalid_output")
            elif kind == "turn.completed":
                if not turn_started:
                    raise SchemaValidationError()
                completed += 1
            elif kind == "turn.started":
                if turn_started:
                    raise SchemaValidationError()
                turn_started = True
            elif kind in ("error", "turn.failed"):
                failed.append(_error_code(json.dumps(event)))
            elif kind != "thread.started":
                raise SchemaValidationError()
    except SchemaValidationError:
        raise ProviderError("invalid_output") from None
    if failed:
        raise ProviderError(failed[-1])
    if result.returncode:
        # Returncode alone never implies auth or cancellation.
        raise ProviderError(_error_code(result.stderr.decode("utf-8", errors="replace")))
    if completed != 1:
        raise ProviderError("invalid_output")


class CodexCLIProvider:
    def __init__(self, *, config=None, supervisor=None):
        self.config = config or CodexConfig.from_settings()
        self.supervisor = supervisor or ProcessSupervisor(cancel_grace_seconds=self.config.cancel_grace_seconds)

    def detect(self, prepared_image, run):
        return self._call("detect", prepared_image, run)

    def recognize(self, prepared_crop, run):
        return self._call("recognize", prepared_crop, run)

    def _call(self, phase, image, run):
        timeout = self.config.detect_timeout_seconds if phase == "detect" else self.config.recognize_timeout_seconds
        run = run.limited(_positive(timeout))
        run.stage(phase)
        image_path = validate_prepared_image(image)
        run.check()
        executable = shutil.which(str(self.config.executable))
        if executable is None or (os.name == "nt" and Path(executable).suffix.lower() != ".exe"):
            raise ProviderError("configuration_error")
        if not self.config.model or any(ord(c) < 32 for c in self.config.model):
            raise ProviderError("configuration_error")
        root = self.config.temp_root.resolve()
        media = getattr(settings, "MEDIA_ROOT", "")
        if media and root.is_relative_to(Path(media).resolve()):
            raise ProviderError("configuration_error")
        try:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.TemporaryDirectory(prefix="attempt-", dir=root) as folder:
                work = Path(folder).resolve()
                schema = work / "output.schema.json"
                name = "detect" if phase == "detect" else "receipt"
                shutil.copyfile(PACKAGE_ROOT / "schemas" / f"{name}.schema.json", schema)
                output = work / "result.json"  # must not exist before launch
                prompt = (PACKAGE_ROOT / "prompts" / f"{name}.txt").read_text(encoding="utf-8")
                if phase == "detect":
                    prompt = prompt.format(width=image.width, height=image.height)
                if output.exists():
                    raise ProviderError("invalid_output")
                # Use the filesystem's own clock/resolution as the fence:
                # time.time_ns() can be slightly ahead of NTFS timestamps.
                started_ns = schema.stat().st_mtime_ns
                try:
                    result = self.supervisor.run(
                        build_argv(executable, self.config.model, work, schema, output, image_path),
                        cwd=work, env=child_environment(self.config.codex_home), stdin=prompt.encode("utf-8"),
                        run=run, output_path=output,
                    )
                    run.check()
                    validate_events(result)
                    if not output.is_file() or output.is_symlink():
                        raise ProviderError("invalid_output")
                    stat = output.stat()
                    # Fresh directory + absent-before-start + creation/mtime fence.
                    if not 0 < stat.st_size <= MAX_OUTPUT_BYTES or stat.st_mtime_ns < started_ns:
                        raise ProviderError("invalid_output")
                    data = load_json(output.read_bytes())
                    if phase == "detect":
                        if type(data) is dict and ((type(data.get("receipt_count")) is int and data["receipt_count"] > 10) or
                                (type(data.get("warnings")) is list and "too_many_receipts" in data["warnings"])):
                            raise ProviderError("invalid_output", reason="too_many_receipts")
                        value = validate_detection(data, width=image.width, height=image.height)
                    else:
                        value = validate_observation(data)
                    run.check()
                    return value
                except SchemaValidationError:
                    error = ProviderError("invalid_output")
                    error.private_output = _private_fragment(output)
                    raise error from None
                except ProviderError as error:
                    if error.code == "invalid_output":
                        error.private_output = _private_fragment(output)
                    raise
        except SchemaValidationError:
            raise ProviderError("invalid_output") from None
        except (OSError, ValueError):
            raise ProviderError("configuration_error") from None


def _private_fragment(output):
    try:
        if output.is_file() and not output.is_symlink():
            with output.open("rb") as stream:
                value = stream.read(64 * 1024).decode("utf-8", errors="replace")
                return value.encode("utf-8")[:64 * 1024].decode("utf-8", errors="ignore")
    except OSError:
        pass
    return None
