import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from PIL import Image

from recognition.dto import PreparedImage, PreparedReceiptImage
from recognition.process_supervisor import ProcessResult
from recognition.providers import ProviderError, RunContext, get_provider
from recognition.providers.codex_cli import CodexCLIProvider, CodexConfig, build_argv, child_environment
from recognition.providers.fake import FakeProvider, detection_payload, receipt_payload
from recognition.schema_validation import observation_issues


class StubProcess:
    def __init__(self, test, *, payload=None, mode="success", events=None, code=0, stderr=b"", stdout=None):
        self.test, self.payload, self.mode = test, payload, mode
        self.events, self.code, self.stderr = events, code, stderr
        self.stdout = stdout
        self.calls = []

    def run(self, argv, *, cwd, env, stdin, run, output_path):
        self.calls.append((argv, cwd, env, stdin))
        self.test.assertFalse(output_path.exists())
        self.test.assertTrue(Path(argv[argv.index("--output-schema") + 1]).is_file())
        self.test.assertEqual(Path(argv[argv.index("-C") + 1]), cwd)
        if self.mode == "timeout":
            raise ProviderError("timeout")
        if self.mode == "cancelled":
            raise ProviderError("cancelled")
        if self.mode == "late":
            time.sleep(0.02)
        if self.mode != "missing":
            contents = json.dumps(self.payload).encode("utf-8")
            if self.mode == "truncated": contents = contents[:-10]
            if self.mode == "empty": contents = b""
            if self.mode == "invalid_utf8": contents = b"\xff"
            output_path.write_bytes(contents)
            if self.mode == "stale": os.utime(output_path, (1, 1))
        events = self.events if self.events is not None else [{"type":"thread.started"}, {"type":"turn.started"}, {"type":"turn.completed","usage":{}}]
        stdout = self.stdout if self.stdout is not None else b"\n".join(json.dumps(e).encode() for e in events)
        return ProcessResult(self.code, stdout, self.stderr)


class ProviderTests(SimpleTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="checkist-c2-provider-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        path = self.root / "снимок с пробелом.png"
        Image.new("RGB", (80, 110), "white").save(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.image = PreparedImage(path, digest, 80, 110)
        self.crop = PreparedReceiptImage(path, digest, 80, 110, position=1)
        self.config = CodexConfig(sys.executable, "gpt-6.1-sol", self.root / "scratch")

    def run_context(self, **kwargs):
        return RunContext(time.monotonic() + 5, **kwargs)

    def provider(self, **kwargs):
        kwargs.setdefault("payload", detection_payload(self.image))
        stub = StubProcess(self, **kwargs)
        return CodexCLIProvider(config=self.config, supervisor=stub), stub

    def test_adapter_argv_stdin_isolation_and_cleanup(self):
        stages = []
        provider, stub = self.provider()
        with patch.dict(os.environ, {"POSTGRES_PASSWORD":"secret", "ORCA_DISPATCH_ID":"secret", "OPENAI_API_KEY":"secret"}):
            self.assertEqual(provider.detect(self.image, self.run_context(on_stage=stages.append)).receipt_count, 2)
            self.assertEqual(provider.detect(self.image, self.run_context()).receipt_count, 2)
        self.assertEqual(stages, ["detect"])
        argv, work, env, prompt = stub.calls[0]
        self.assertNotEqual(work, stub.calls[1][1])
        self.assertFalse(work.exists())
        self.assertIn(b"80 x 110", prompt)
        for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", "--output-schema"):
            self.assertIn(flag, argv)
        for tool in ("shell_tool", "unified_exec", "multi_agent"): self.assertIn(tool, argv)
        self.assertEqual(argv[-1], "-")
        self.assertEqual(argv[argv.index("-i") + 1], str(self.image.path.resolve()))
        for key in ("POSTGRES_PASSWORD", "ORCA_DISPATCH_ID", "OPENAI_API_KEY"): self.assertNotIn(key, env)

    def test_adapter_recognition_decimal_and_v2(self):
        provider, stub = self.provider(payload=receipt_payload())
        observation = provider.recognize(self.crop, self.run_context())
        self.assertEqual(str(observation.total), "4.42")
        self.assertIn(b"schema v2", stub.calls[0][3])

    def test_adapter_with_real_supervised_substitute_process(self):
        # This is a safe Python stand-in, never an installed Codex invocation.
        payload = detection_payload(self.image)
        script = self.root / "substitute.py"
        script.write_text(
            "import json, pathlib, sys\n"
            "prompt = sys.stdin.buffer.read().decode('utf-8')\n"
            "assert '80 x 110' in prompt\n"
            "output = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])\n"
            f"output.write_text({json.dumps(json.dumps(payload))}, encoding='utf-8')\n"
            "print(json.dumps({'type':'thread.started'}))\n"
            "print(json.dumps({'type':'turn.started'}))\n"
            "print(json.dumps({'type':'turn.completed','usage':{}}))\n",
            encoding="utf-8",
        )
        def substitute(*args):
            return [sys.executable, str(script), *build_argv(*args)[1:]]
        with patch("recognition.providers.codex_cli.build_argv", side_effect=substitute):
            provider = CodexCLIProvider(config=self.config)
            self.assertEqual(provider.detect(self.image, self.run_context()).to_dict(), payload)
        self.assertEqual(list(self.config.temp_root.iterdir()), [])

    def test_zero_exit_does_not_accept_missing_empty_truncated_stale_or_invalid(self):
        for mode in ("missing", "empty", "truncated", "stale", "invalid_utf8"):
            provider, _ = self.provider(mode=mode)
            with self.subTest(mode=mode), self.assertRaises(ProviderError) as raised:
                provider.detect(self.image, self.run_context())
            self.assertEqual(raised.exception.code, "invalid_output")
            self.assertFalse(raised.exception.retryable)
            if mode in ("truncated", "stale"):
                self.assertIsInstance(raised.exception.private_output, str)
        provider, _ = self.provider(payload={"total":4.42})
        with self.assertRaises(ProviderError) as raised: provider.detect(self.image, self.run_context())
        self.assertEqual(raised.exception.code, "invalid_output")

    def test_terminal_event_and_tool_execution_validation(self):
        for events in ([], [{"type":"turn.started"}], [{"type":"turn.completed"}] * 2,
                       [{"type":"item.completed","item":{"type":"command_execution"}}, {"type":"turn.completed"}],
                       [{"type":"item.started","item":{"type":"mcp_tool_call"}}], [{"type":"new.unknown"}]):
            provider, _ = self.provider(events=events)
            with self.subTest(events=events), self.assertRaises(ProviderError) as raised:
                provider.detect(self.image, self.run_context())
            self.assertEqual(raised.exception.code, "invalid_output")

    def test_events_after_completion_and_bad_jsonl_are_rejected(self):
        events = [{"type":"turn.started"},{"type":"turn.completed"},
                  {"type":"item.completed","item":{"type":"agent_message"}}]
        provider, _ = self.provider(events=events)
        with self.assertRaises(ProviderError) as raised:
            provider.detect(self.image,self.run_context())
        self.assertEqual(raised.exception.code,"invalid_output")
        for stdout in (b"not-json",b'{"type":"turn.started","type":"turn.completed"}'):
            provider,_=self.provider(stdout=stdout)
            with self.subTest(stdout=stdout),self.assertRaises(ProviderError) as raised:
                provider.detect(self.image,self.run_context())
            self.assertEqual(raised.exception.code,"invalid_output")

    def test_too_many_receipts_has_fixed_domain_hint(self):
        for payload in (detection_payload(self.image,11),
                        {**detection_payload(self.image,0),"warnings":["too_many_receipts"]}):
            provider, _=self.provider(payload=payload)
            with self.subTest(payload=payload["receipt_count"]),self.assertRaises(ProviderError) as raised:
                provider.detect(self.image,self.run_context())
            self.assertEqual(raised.exception.code,"invalid_output")
            self.assertEqual(raised.exception.reason,"too_many_receipts")

    def test_normalized_provider_failures_are_safe(self):
        for message, expected in (("unexpected status: 401 private receipt", "auth_required"),
                                  ("status 429 Too Many Requests private receipt", "rate_limited"),
                                  ("Connection failed: error sending request private receipt", "network_unavailable"),
                                  ("unknown upstream private receipt", "provider_unavailable")):
            provider, _ = self.provider(events=[{"type":"turn.failed","error":{"message":message}}], code=1, stderr=message.encode())
            with self.subTest(expected=expected), self.assertRaises(ProviderError) as raised:
                provider.detect(self.image, self.run_context())
            self.assertEqual(raised.exception.code, expected)
            self.assertNotIn("private receipt", str(raised.exception))
        provider, _ = self.provider(code=2, stderr=b"unexpected argument --ignore-rules private receipt")
        with self.assertRaises(ProviderError) as raised: provider.detect(self.image, self.run_context())
        self.assertEqual(raised.exception.code, "configuration_error")

    def test_cancellation_timeout_and_late_completion_override_zero_exit(self):
        for mode, code in (("cancelled", "cancelled"), ("timeout", "timeout"), ("late", "timeout")):
            provider, _ = self.provider(mode=mode)
            run = RunContext(time.monotonic() + (0.01 if mode == "late" else 2))
            with self.subTest(mode=mode), self.assertRaises(ProviderError) as raised: provider.detect(self.image, run)
            self.assertEqual(raised.exception.code, code)

    def test_input_missing_hash_dimensions_invalid_decode_before_spawn(self):
        for image in (PreparedImage(self.root/"missing.png", "a"*64,80,110),
                      PreparedImage(self.image.path,"a"*64,80,110),
                      PreparedImage(self.image.path,self.image.sha256,81,110)):
            provider, stub = self.provider()
            with self.subTest(image=image), self.assertRaises(ProviderError) as raised: provider.detect(image,self.run_context())
            self.assertEqual(raised.exception.code,"invalid_input")
            self.assertEqual(stub.calls,[])
        path = self.root/"broken.png"
        path.write_bytes(b"not an image")
        provider, stub = self.provider()
        with self.assertRaises(ProviderError): provider.detect(PreparedImage(path,hashlib.sha256(path.read_bytes()).hexdigest(),1,1),self.run_context())
        self.assertEqual(stub.calls,[])

    @override_settings(RECEIPT_OCR_PROVIDER="fake", RECEIPT_OCR_FAKE_SCENARIO="one_receipt")
    def test_factory_explicit_selection(self):
        self.assertEqual(get_provider().detect(self.image,self.run_context()).receipt_count,1)
        self.assertEqual(get_provider(scenario="no_receipts").detect(self.image,self.run_context()).receipt_count,0)
        with override_settings(RECEIPT_OCR_PROVIDER="unknown"):
            with self.assertRaises(ProviderError): get_provider()
        with override_settings(RECEIPT_OCR_PROVIDER="codex_cli",RECEIPT_OCR_CODEX_EXECUTABLE="missing-executable"):
            self.assertIsInstance(get_provider(),CodexCLIProvider)
            with self.assertRaises(ProviderError) as raised: get_provider().detect(self.image,self.run_context())
            self.assertEqual(raised.exception.code,"configuration_error")

    def test_fake_k1_single_double_no_receipts_failure_partial_repeat(self):
        for scenario, count in (("success2",2),("one_receipt",1),("no_receipts",0)):
            self.assertEqual(FakeProvider(scenario).detect(self.image,self.run_context()).receipt_count,count)
        for scenario, code in (("too_many_receipts","invalid_output"),("provider_auth_failure","auth_required"),
                               ("provider_error","provider_unavailable"),("malformed_schema","invalid_output")):
            with self.subTest(scenario=scenario), self.assertRaises(ProviderError) as raised: FakeProvider(scenario).detect(self.image,self.run_context())
            self.assertEqual(raised.exception.code,code)
        for scenario, expected in (("partial_missing_quantity","missing_required"),("inconsistent_total","total_mismatch")):
            obs=FakeProvider(scenario).recognize(self.crop,self.run_context())
            self.assertIn(expected,[v["code"] for v in observation_issues(obs)])
        provider=FakeProvider("duplicate_strong")
        self.assertEqual(provider.recognize(self.crop,self.run_context()),provider.recognize(self.crop,self.run_context()))
        second=PreparedReceiptImage(self.image.path,self.image.sha256,80,110,position=2)
        self.assertEqual(provider.recognize(second,self.run_context()).total,provider.recognize(self.crop,self.run_context()).total)
        self.assertEqual(FakeProvider("success2").recognize(second,self.run_context()).total,6)

    def test_fake_pause_gate_cancel_and_late_release(self):
        for phase in ("detect","recognize"):
            gate, entered, cancel=threading.Event(),threading.Event(),threading.Event()
            errors=[]
            provider=FakeProvider("pause_"+phase,gate=gate,entered=entered)
            def invoke():
                try: getattr(provider,phase)(self.crop,self.run_context(is_cancelled=cancel.is_set))
                except ProviderError as exc: errors.append(exc.code)
            thread=threading.Thread(target=invoke)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                cancel.set()
                gate.set()
            finally:
                cancel.set(); gate.set(); thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors,["cancelled"])

    def test_codex_home_preserved_and_other_secrets_removed(self):
        with patch.dict(os.environ,{"CODEX_HOME":"authorized-home","DB_PASSWORD":"secret","ANTHROPIC_API_KEY":"secret"}):
            env=child_environment()
            self.assertEqual(env["CODEX_HOME"],"authorized-home")
            self.assertNotIn("DB_PASSWORD",env)
            self.assertNotIn("ANTHROPIC_API_KEY",env)
            self.assertEqual(child_environment("service-home")["CODEX_HOME"],"service-home")

    def test_scratch_under_media_rejected(self):
        provider, stub=self.provider()
        with override_settings(MEDIA_ROOT=self.root):
            with self.assertRaises(ProviderError) as raised: provider.detect(self.image,self.run_context())
        self.assertEqual(raised.exception.code,"configuration_error")
        self.assertEqual(stub.calls,[])

    def test_invalid_configuration_is_normalized(self):
        for kwargs in ({"model":None},{"temp_root":Path("relative")},{"codex_home":"relative"},
                       {"detect_timeout_seconds":float("nan")},{"recognize_timeout_seconds":False},
                       {"cancel_grace_seconds":-1}):
            values = {**self.config.__dict__, **kwargs}
            with self.subTest(kwargs=kwargs), self.assertRaises(ProviderError) as raised:
                CodexConfig(**values)
            self.assertEqual(raised.exception.code,"configuration_error")

    def test_partial_success_scenario_one_complete_one_review(self):
        provider=FakeProvider("partial_success")
        first=provider.recognize(self.crop,self.run_context())
        second_crop=PreparedReceiptImage(self.image.path,self.image.sha256,80,110,position=2)
        second=provider.recognize(second_crop,self.run_context())
        self.assertEqual(observation_issues(first),[])
        self.assertIn("missing_required",[i["code"] for i in observation_issues(second)])
