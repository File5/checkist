# Recognition provider interface

No provider reads or writes ORM. The worker owns preparation, persistence, crop,
retry policy, identity resolution, transaction and the final cancellation fence.
No public HTTP form from K2 §5 is changed here.

```python
from recognition.dto import PreparedImage, PreparedReceiptImage
from recognition.providers import RunContext, ProviderError, get_provider

# deadline is an absolute time.monotonic() value, NOT Unix time/datetime.
run = RunContext(deadline, is_cancelled=read_durable_cancel, on_stage=save_stage)
provider = get_provider()
detected = provider.detect(PreparedImage(path, sha256, width, height), run)
observation = provider.recognize(
    PreparedReceiptImage(crop_path, crop_sha256, crop_width, crop_height, position=1), run
)
```

Both methods also accept `run=run`. `run_id` defaults to a UUID string; pass the
attempt/run UUID explicitly when needed. `PreparedImage.orientation` defaults
to 1. `PreparedReceiptCrop` aliases `PreparedReceiptImage`.
`PreparedReceiptImage.rotation_degrees` defaults to 0; the pipeline copies the
persisted signed clockwise text angle into each recognize input. Bbox crops
retain that angle. Detect quad is TL, TR, BR, BL relative to the text, clockwise
with image y down; validators preserve cyclic starts and never sort by x+y.
Angles are [-180, 180], positive clockwise, negative counterclockwise; 270 is -90.
`on_stage` receives exactly `detect` or `recognize`; the worker maps these to
its persisted/public stage enum, rather than passing them to the HTTP API.

DTOs are frozen dataclasses, arrays are tuples, nested objects have typed
attributes. All money, quantity, package quantity and tax rates are `Decimal`
internally. `dto.to_dict()` creates independent JSON-ready objects with decimal
strings and arrays. No floats are used for money. Detection v1 matches K1;
receipt v2 adds the two required timestamp objects specified by K2.

`validate_detection(data, *, width, height)` and `validate_observation(data)`
accept a dict, UTF-8 bytes or JSON string. Missing/unknown/duplicate JSON keys,
invalid enum/type/scale/size, invalid dates/times/pointers and geometry are
rejected with `SchemaValidationError` (safe `path`/`reason`, no input values).
Nullable observations remain nullable. `observation_issues(dto)` reports safe
`{code, path}` review reasons for missing facts, conflicting times/evidence,
links, signs and sums. It does not replace importer full_clean, timezone,
country/FK resolution, deduplication or validate_receipt in a transaction.
Store results and issues on ReceiptImage even when import is impossible.

Provider errors expose `code`, fixed `message`, `retryable`, optional
`retry_after`. `invalid_output` can have `reason="too_many_receipts"`; the worker
maps this fixed hint to the domain job error. On malformed CLI output,
`private_output` retains at most 64 KiB for PRIVATE RecognitionAttempt storage.
It can contain receipt data: never put it in API errors, callbacks or logs.
Cancelled/expired output is never returned as a success. The importer must
check durable cancellation again under the job lock before commit.

## Explicit fake selection

Factory settings (load root environment into Django settings in C1):

```dotenv
RECEIPT_OCR_PROVIDER=fake
RECEIPT_OCR_FAKE_SCENARIO=success2
```

`RECEIPT_OCR_FAKE_SCENARIO` is an additive server-only demo setting to K2 §4.5,
default `success2`. `get_provider(scenario="one_receipt")` overrides it only
when the configured provider is fake. Do not expose provider/scenario selection
in upload bodies. Codex failure never selects fake.

| Scenario | Behavior |
| --- | --- |
| success2 (alias success) | K1 two synthetic DE/EUR receipts, totals 4.42 and 6.00 |
| one_receipt (single) | One detection, first receipt |
| rotated_receipt | single_rotated.png, first paper/text at -12 degrees, total 4.42 |
| rotated_two_receipts | double_rotated.png, first upright, second at -12 degrees, totals 4.42 and 6.00 |
| no_receipts | Empty detection |
| too_many_receipts | invalid_output, nonretryable, reason too_many_receipts |
| provider_auth_failure | auth_required, nonretryable |
| provider_error | provider_unavailable, retryable |
| malformed_schema (invalid_output) | Strictly rejected schema; no success DTO |
| partial_missing_quantity (incomplete) | Unknown quantity and unit price with unreadable evidence, needs review |
| partial_success | First receipt complete; second lacks quantity and unit price |
| inconsistent_total | Structurally valid contradictory total, review reason total_mismatch |
| duplicate_strong (repeat) | Always first receipt's fiscal identity, including crop position 2 |
| duplicate_weak | Repeated store/time/total with no fiscal identifiers |
| pause_detect (pause), pause_recognize | Block selected stage until gate, cancel or deadline |
| late_completion | Block both stages; released gate still checks cancel/deadline |

`FakeProvider(scenario, gate=Event(), entered=Event())` supports deterministic
tests: wait for entered, then set cancellation or gate. Without a gate, pause
continues to cancellation/deadline. The fake never imports a receipt and does
not simulate a database commit gate; that belongs in worker/importer tests.
Crop `position` is 1-based; position 2 selects K1 receipt 2, others select 1.
K1 bbox coordinates are scaled fractions of the actual image dimensions.
For accurate visual demo crops, use the K1 synthetic single/double image layout.
Fake cannot validate OCR quality on arbitrary photographs.

## Codex / process supervision

`CodexConfig.from_settings()` reads K2 RECEIPT_OCR_CODEX_EXECUTABLE, MODEL,
TEMP_ROOT, DETECT_TIMEOUT_SECONDS, RECOGNIZE_TIMEOUT_SECONDS and
CANCEL_GRACE_SECONDS via getattr defaults. An optional RECEIPT_OCR_CODEX_HOME
preserves service auth; absent means reuse the host user's existing auth.
No setting, dependency lock or auth file is changed by this module. C1 must
install its agreed Pillow dependency and load settings from root env.

Command flags are those verified by K1, including disabled shell/unified_exec,
multi_agent, web_search, user config and rules, read-only sandbox and ephemeral
mode. Unsupported flags are configuration_error; there is no unsafe fallback.
Every invocation uses a new private attempt directory outside MEDIA, UTF-8
stdin, --output-schema and an absent-before-launch output file. Input file,
hash, actual decode, W/H and upright orientation are checked. Success requires
uncancelled unexpired run, exit 0, terminal JSONL completion, no tool events,
new nonempty output and strict validation. Events after completion are rejected.
Stderr remains private. Output is limited to 4 MiB, streams to 8 MiB each;
size is polled during execution and checked after tree shutdown. Temporary
files can exceed that threshold between polls, but oversized data is rejected.

Windows uses documented ctypes CreateProcessW suspended, restricted inheritance
of three duplicated stream handles, AssignProcessToJobObject before ResumeThread,
KILL_ON_JOB_CLOSE with no breakaway. Assign/resume errors terminate the suspended
child and fail closed. Cancellation force-stops the job immediately and audits
ActiveProcesses until zero (bounded 5 seconds); no console grace protocol is
assumed. Normal root exit also stops remaining helpers. This immediate Windows
termination is a refinement of K2's optional grace, not an HTTP contract change.
`ProcessSupervisor(windows_use_job=False)` is an explicit diagnostic fallback:
taskkill /PID of its root /T /F, never /IM. Its known PID-reuse/escaped-child/root
exit limitations make Job Object the default. POSIX starts a new session and
signals the process group TERM, then KILL after grace (default 2 seconds).
No POSIX watchdog is implemented, per the human's simplified v1 decision;
children deliberately escaping with setsid and a killed POSIX worker remain
outside this guarantee. Process returncode does not determine cancellation.

Technical sources: [OpenAI CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

For human end-to-end acceptance after C1/C3/C4 integration: use isolated QA
DB/MEDIA/scratch, run recognition_worker with fake/success2, upload the matching
synthetic photo, confirm two crops and two totals, repeat it, then check
partial_success and cancel pause_detect/pause_recognize. Only the human checks
browser visuals/interactions. Real Codex quality/auth/network is a separate
human QA run on approved photographs; these tests never invoke Codex.
