import hashlib
import io
import json
import os
import shlex
import sys
import tarfile
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, override_settings

from health import backup

# Stands in for pg_dump / pg_restore / createdb / psql through CHECKIST_PG_TOOLS_PREFIX.
FAKE_TOOL = """\
import json
import os
import sys

tool, arguments = sys.argv[1], sys.argv[2:]
record = {"tool": tool, "args": arguments, "env": {n: os.environ.get(n) for n in ("PGHOST", "PGPORT", "PGPASSWORD")}}
if tool == "pg_restore":
    record["stdin"] = len(sys.stdin.buffer.read())
with open(os.environ["FAKE_PG_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(record) + "\\n")
if tool in os.environ.get("FAKE_PG_FAIL", "").split(","):
    sys.stderr.write(f"{tool}: connection failed, password {os.environ.get('PGPASSWORD')}\\n")
    sys.exit(3)
if tool == "pg_dump":
    sys.stdout.buffer.write(os.environ.get("FAKE_PG_DUMP", "PGDMP fake dump body").encode())
if tool == "psql" and os.environ.get("FAKE_PG_EXISTS"):
    print("1")
"""
PASSWORD = "s3cret-backup-password"
DATABASE = {"NAME": "checkist_working", "USER": "backup_user", "PASSWORD": PASSWORD, "HOST": "db.test", "PORT": "6543"}
MEDIA_FILES = {
    "source-photos/2026/10/aaaa/photo.jpg": b"\xff\xd8 photo one",
    "source-photos/2026/10/bbbb/photo.png": b"\x89PNG photo two",
    "receipt-images/cccc/crop.jpg": b"\xff\xd8 crop",
}
OLD = datetime(2020, 1, 1, 3, 0, 0, tzinfo=UTC)


def copy_name(moment):
    return f"checkist-{moment.strftime(backup.STAMP)}"


def tree(root):
    root = Path(root)
    return {
        path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()
    }


class BackupCase(SimpleTestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.media = self.root / "media"
        self.copies = self.root / "copies"
        for name, content in MEDIA_FILES.items():
            path = self.media / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        script = self.root / "fake_pg_tool.py"
        script.write_text(FAKE_TOOL, encoding="utf-8")
        self.log = self.root / "tools.jsonl"
        self.enterContext(override_settings(MEDIA_ROOT=self.media))
        self.enterContext(patch.object(backup, "database_settings", return_value=DATABASE))
        self.environment = self.enterContext(patch.dict(os.environ, {
            backup.PREFIX_VARIABLE: shlex.join([sys.executable, str(script)]), "FAKE_PG_LOG": str(self.log),
            # Inherited values must not reach the child: only the settings of the working database do.
            "PGPASSWORD": "inherited-password", "PGHOST": "inherited.test",
        }))
        for name in ("FAKE_PG_FAIL", "FAKE_PG_DUMP", "FAKE_PG_EXISTS"):
            os.environ.pop(name, None)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def command(self, *arguments):
        output = io.StringIO()
        call_command("backup", *arguments, stdout=output, stderr=io.StringIO())
        return output.getvalue()

    def refused(self, *arguments):
        with self.assertRaises(CommandError) as raised:
            self.command(*arguments)
        self.assertNotIn(PASSWORD, str(raised.exception))
        return str(raised.exception)

    def entries(self, directory=None):
        directory = directory or self.copies
        return sorted(path.name for path in directory.iterdir()) if directory.exists() else []

    def finished(self, moment, directory=None):
        path = (directory or self.copies) / copy_name(moment)
        path.mkdir(parents=True)
        (path / backup.DUMP).write_bytes(b"PGDMP earlier")
        (path / backup.MANIFEST).write_text("{}", encoding="utf-8")
        return path

    def create(self):
        payload = json.loads(self.command("create", "--dir", str(self.copies)))
        return Path(payload["copy"]), payload


class BackupCreateTests(BackupCase):
    def test_copy_holds_the_dump_the_media_archive_and_the_manifest(self):
        copy, payload = self.create()
        self.assertEqual(self.entries(), [copy.name])
        self.assertRegex(copy.name, r"^checkist-\d{8}T\d{6}Z$")
        self.assertEqual(self.entries(copy), ["db.dump", "manifest.json", "media.tar.gz"])
        self.assertEqual((copy / "db.dump").read_bytes(), b"PGDMP fake dump body")
        with tarfile.open(copy / "media.tar.gz", "r:gz") as archive:
            archived = {
                member.name: archive.extractfile(member).read() for member in archive.getmembers() if member.isfile()
            }
        self.assertEqual(archived, MEDIA_FILES)
        manifest = json.loads((copy / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest, payload["manifest"])
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["database"], "checkist_working")
        self.assertEqual(manifest["media_files"], 3)
        self.assertEqual(manifest["created_at"], datetime.strptime(
            copy.name.removeprefix("checkist-"), backup.STAMP,
        ).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.assertEqual(set(manifest["files"]), {"db.dump", "media.tar.gz"})
        for name, entry in manifest["files"].items():
            content = (copy / name).read_bytes()
            self.assertEqual(entry, {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()})
        self.assertEqual(payload["removed"], [])

    def test_pg_dump_gets_the_password_only_through_its_environment(self):
        output = self.command("create", "--dir", str(self.copies))
        self.assertEqual(self.calls(), [{
            "tool": "pg_dump",
            "args": ["--no-password", "--username", "backup_user", "-Fc", "--no-owner", "--dbname", "checkist_working"],
            "env": {"PGHOST": "db.test", "PGPORT": "6543", "PGPASSWORD": PASSWORD},
        }])
        self.assertNotIn(PASSWORD, output)
        self.assertNotIn(PASSWORD, json.dumps(tree(self.copies), default=repr))
        # The command's own environment is left as it was.
        self.assertEqual(os.environ["PGPASSWORD"], "inherited-password")

    def test_prefix_is_read_from_the_environment_not_from_settings(self):
        self.assertFalse(hasattr(settings, backup.PREFIX_VARIABLE))
        os.environ[backup.PREFIX_VARIABLE] = shlex.join([str(self.root / "nonexistent-checkist-pg-tool")])
        message = self.refused("create", "--dir", str(self.copies))
        self.assertIn("pg_dump: cannot be started", message)
        self.assertEqual(self.entries(), [])

    def test_unbalanced_prefix_is_refused(self):
        os.environ[backup.PREFIX_VARIABLE] = "docker 'compose"
        self.assertIn("CHECKIST_PG_TOOLS_PREFIX", self.refused("create", "--dir", str(self.copies)))
        self.assertEqual(self.entries(), [])

    def test_failed_dump_leaves_no_copy_and_keeps_the_earlier_ones(self):
        earlier = [self.finished(OLD), self.finished(OLD + timedelta(days=1))]
        os.environ["FAKE_PG_FAIL"] = "pg_dump"
        message = self.refused("create", "--dir", str(self.copies))
        self.assertIn("pg_dump: exit 3.", message)
        self.assertIn("password ***", message)
        self.assertEqual(self.entries(), [path.name for path in earlier])

    def test_output_that_is_not_a_dump_is_refused(self):
        earlier = self.finished(OLD)
        os.environ["FAKE_PG_DUMP"] = "Error: no such service"
        self.assertIn("not a custom-format dump", self.refused("create", "--dir", str(self.copies)))
        self.assertEqual(self.entries(), [earlier.name])

    def test_missing_media_root_gives_an_empty_archive(self):
        with override_settings(MEDIA_ROOT=self.root / "absent"):
            copy, payload = self.create()
        self.assertEqual(payload["manifest"]["media_files"], 0)
        with tarfile.open(copy / "media.tar.gz", "r:gz") as archive:
            self.assertEqual(archive.getmembers(), [])
        self.assertFalse((self.root / "absent").exists())

    def test_copies_directory_inside_media_is_refused(self):
        for directory in (self.media, self.media / "copies"):
            with self.subTest(directory=directory.name):
                self.assertIn("outside MEDIA_ROOT", self.refused("create", "--dir", str(directory)))
        self.assertEqual(tree(self.media), MEDIA_FILES)
        self.assertEqual(self.calls(), [])

    def test_same_timestamp_is_refused_without_touching_the_existing_copy(self):
        now = datetime(2026, 10, 7, 12, 0, 0, tzinfo=UTC)
        first = backup.create(self.copies, now=now)
        before = tree(self.copies)
        with self.assertRaises(backup.BackupError):
            backup.create(self.copies, now=now)
        self.assertEqual(tree(self.copies), before)
        self.assertEqual(self.entries(), [Path(first["copy"]).name])

    def test_verify_accepts_a_created_copy(self):
        copy, payload = self.create()
        verified = json.loads(self.command("verify", str(copy)))
        self.assertEqual(verified["manifest"], payload["manifest"])
        self.assertEqual(len(self.calls()), 1)  # verify starts no PostgreSQL tool

    def test_verify_refuses_a_damaged_copy(self):
        def changed_dump(copy):
            (copy / "db.dump").write_bytes(b"PGDMP fake dump bodY")

        def truncated_archive(copy):
            content = (copy / "media.tar.gz").read_bytes()
            (copy / "media.tar.gz").write_bytes(content[:-8])

        def missing_archive(copy):
            (copy / "media.tar.gz").unlink()

        def missing_manifest(copy):
            (copy / "manifest.json").unlink()

        def foreign_version(copy):
            manifest = json.loads((copy / "manifest.json").read_text(encoding="utf-8"))
            (copy / "manifest.json").write_text(json.dumps({**manifest, "version": 2}), encoding="utf-8")

        def wrong_file_count(copy):
            manifest = json.loads((copy / "manifest.json").read_text(encoding="utf-8"))
            (copy / "manifest.json").write_text(json.dumps({**manifest, "media_files": 2}), encoding="utf-8")

        cases = (changed_dump, truncated_archive, missing_archive, missing_manifest, foreign_version, wrong_file_count)
        for number, damage in enumerate(cases):
            with self.subTest(damage=damage.__name__):
                copy = Path(backup.create(
                    self.copies, now=datetime(2026, 10, 7, 12, 0, number, tzinfo=UTC),
                )["copy"])
                damage(copy)
                self.refused("verify", str(copy))
        self.refused("verify", str(self.copies / "checkist-absent"))


class BackupRetentionTests(BackupCase):
    NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=UTC)

    def test_copies_older_than_the_term_are_removed(self):
        expired = [
            self.finished(self.NOW - timedelta(days=30)), self.finished(self.NOW - timedelta(days=14, seconds=1)),
        ]
        kept = [self.finished(self.NOW - timedelta(days=14)), self.finished(self.NOW - timedelta(days=1))]
        removed = backup.prune(self.copies, 14, self.NOW)
        self.assertEqual(removed, [path.name for path in expired])
        self.assertEqual(self.entries(), [path.name for path in kept])

    def test_last_successful_copy_is_never_removed(self):
        expired = self.finished(self.NOW - timedelta(days=400))
        last = self.finished(self.NOW - timedelta(days=300))
        for keep_days in (14, 0):
            with self.subTest(keep_days=keep_days):
                self.assertEqual(backup.prune(self.copies, keep_days, self.NOW), [expired.name] if keep_days else [])
                self.assertEqual(self.entries(), [last.name])

    def test_unfinished_directory_does_not_count_as_the_last_copy(self):
        last = self.finished(self.NOW - timedelta(days=300))
        unfinished = self.copies / copy_name(self.NOW - timedelta(days=1))
        unfinished.mkdir()
        (unfinished / backup.DUMP).write_bytes(b"PGDMP half")
        self.assertEqual(backup.prune(self.copies, 14, self.NOW), [])
        self.assertEqual(self.entries(), sorted([last.name, unfinished.name]))

    def test_foreign_entries_are_left_alone(self):
        self.finished(self.NOW)
        foreign = self.copies / "checkist-notes"
        foreign.mkdir()
        (foreign / backup.MANIFEST).write_text("{}", encoding="utf-8")
        impossible = self.copies / "checkist-20201340T000000Z"
        impossible.mkdir()
        (impossible / backup.MANIFEST).write_text("{}", encoding="utf-8")
        (self.copies / "checkist-20200101T000000Z.txt").write_text("note", encoding="utf-8")
        (self.copies / "checkist-20200102T000000Z").write_text("a file, not a copy", encoding="utf-8")
        before = self.entries()
        self.assertEqual(backup.prune(self.copies, 14, self.NOW), [])
        self.assertEqual(self.entries(), before)

    def test_stale_partial_directory_is_removed_and_a_fresh_one_is_kept(self):
        self.finished(self.NOW)
        stale = self.copies / f".{copy_name(self.NOW - timedelta(days=2))}.partial"
        fresh = self.copies / f".{copy_name(self.NOW - timedelta(hours=1))}.partial"
        stale.mkdir()
        fresh.mkdir()
        backup.prune(self.copies, 14, self.NOW)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_create_prunes_after_success(self):
        expired = self.finished(OLD)
        recent = self.finished(datetime.now(UTC) - timedelta(days=3))
        copy, payload = self.create()
        self.assertEqual(payload["removed"], [expired.name])
        self.assertEqual(self.entries(), sorted([recent.name, copy.name]))

    def test_keep_days_option(self):
        recent = self.finished(datetime.now(UTC) - timedelta(days=3))
        payload = json.loads(self.command("create", "--dir", str(self.copies), "--keep-days", "2"))
        self.assertEqual(payload["removed"], [recent.name])
        self.assertEqual(self.entries(), [Path(payload["copy"]).name])

    def test_default_term_is_fourteen_days(self):
        self.assertEqual(backup.DEFAULT_KEEP_DAYS, 14)
        inside = self.finished(datetime.now(UTC) - timedelta(days=13))
        outside = self.finished(datetime.now(UTC) - timedelta(days=15))
        _copy, payload = self.create()
        self.assertEqual(payload["removed"], [outside.name])
        self.assertTrue(inside.exists())

    def test_negative_term_is_refused_before_any_work(self):
        earlier = self.finished(OLD)
        self.refused("create", "--dir", str(self.copies), "--keep-days", "-1")
        self.assertEqual(self.entries(), [earlier.name])
        self.assertEqual(self.calls(), [])

    def test_failed_run_does_not_prune(self):
        earlier = [self.finished(OLD), self.finished(OLD + timedelta(days=1))]
        os.environ["FAKE_PG_FAIL"] = "pg_dump"
        self.refused("create", "--dir", str(self.copies), "--keep-days", "0")
        self.assertEqual(self.entries(), [path.name for path in earlier])


class BackupRestoreGuardTests(BackupCase):
    def setUp(self):
        super().setUp()
        self.copy, _payload = self.create()
        self.log.unlink()
        self.target = self.root / "restored-media"

    def restore(self, database="checkist_restored", target=None):
        return ("restore", str(self.copy), "--database", database, "--media-root", str(target or self.target))

    def tools(self):
        return [call["tool"] for call in self.calls()]

    def test_restore_into_a_new_database_and_directory(self):
        payload = json.loads(self.command(*self.restore()))
        self.assertEqual(payload, {
            "database": "checkist_restored", "media_root": str(self.target), "media_files": 3,
        })
        calls = self.calls()
        self.assertEqual([call["tool"] for call in calls], ["psql", "createdb", "pg_restore"])
        common = ["--no-password", "--username", "backup_user"]
        self.assertEqual(calls[0]["args"], [
            *common, "-X", "-At", "--dbname", "postgres", "-c",
            "SELECT 1 FROM pg_database WHERE datname = 'checkist_restored'",
        ])
        self.assertEqual(calls[1]["args"], [
            *common, "--template", "template0", "--encoding", "UTF8", "checkist_restored",
        ])
        self.assertEqual(calls[2]["args"], [
            *common, "--no-owner", "--exit-on-error", "--dbname", "checkist_restored",
        ])
        self.assertEqual(calls[2]["stdin"], len(b"PGDMP fake dump body"))
        for call in calls:
            self.assertEqual(call["env"], {"PGHOST": "db.test", "PGPORT": "6543", "PGPASSWORD": PASSWORD})
            self.assertNotIn("checkist_working", call["args"])
            self.assertNotIn(PASSWORD, " ".join(call["args"]))
        self.assertEqual(tree(self.target), MEDIA_FILES)
        self.assertEqual(tree(self.media), MEDIA_FILES)

    def test_empty_existing_directory_is_accepted(self):
        self.target.mkdir()
        self.command(*self.restore())
        self.assertEqual(tree(self.target), MEDIA_FILES)

    def test_existing_database_is_refused(self):
        os.environ["FAKE_PG_EXISTS"] = "1"
        message = self.refused(*self.restore())
        self.assertIn("checkist_restored already exists", message)
        self.assertEqual(self.tools(), ["psql"])
        self.assertFalse(self.target.exists())

    def test_non_empty_directory_is_refused(self):
        self.target.mkdir()
        (self.target / "keep.txt").write_bytes(b"mine")
        self.assertIn("not empty", self.refused(*self.restore()))
        self.assertEqual(self.tools(), [])
        self.assertEqual(tree(self.target), {"keep.txt": b"mine"})

    def test_file_in_place_of_the_directory_is_refused(self):
        self.target.write_bytes(b"mine")
        self.refused(*self.restore())
        self.assertEqual(self.tools(), [])
        self.assertEqual(self.target.read_bytes(), b"mine")

    def test_working_database_is_refused(self):
        self.assertIn("working database", self.refused(*self.restore(database="checkist_working")))
        self.assertEqual(self.tools(), [])
        self.assertFalse(self.target.exists())

    def test_working_media_is_refused(self):
        empty_media = self.root / "empty-media"
        empty_media.mkdir()
        with override_settings(MEDIA_ROOT=empty_media):
            for target in (empty_media, empty_media / "inside"):
                with self.subTest(target=target.name):
                    self.assertIn("working MEDIA_ROOT", self.refused(*self.restore(target=target)))
        self.assertEqual(self.tools(), [])
        self.assertEqual(self.entries(empty_media), [])

    def test_unsafe_database_name_is_refused(self):
        for name in ("", "new-base", "new base", "x'; DROP DATABASE checkist_working; --", "1base", "b" * 64):
            with self.subTest(name=name):
                self.assertIn("--database", self.refused(*self.restore(database=name)))
        self.assertEqual(self.tools(), [])

    def test_damaged_copy_is_refused_before_anything_is_created(self):
        (self.copy / "db.dump").write_bytes(b"PGDMP fake dump bodY")
        self.assertIn("db.dump", self.refused(*self.restore()))
        self.assertEqual(self.tools(), [])
        self.assertFalse(self.target.exists())

    def test_failed_restore_reports_the_incomplete_database_and_extracts_nothing(self):
        os.environ["FAKE_PG_FAIL"] = "pg_restore"
        message = self.refused(*self.restore())
        self.assertIn("pg_restore: exit 3.", message)
        self.assertIn("checkist_restored was created and is incomplete", message)
        self.assertEqual(self.tools(), ["psql", "createdb", "pg_restore"])
        self.assertFalse(self.target.exists())
        self.assertEqual(tree(self.media), MEDIA_FILES)

    def test_failed_createdb_stops_the_restore(self):
        os.environ["FAKE_PG_FAIL"] = "createdb"
        message = self.refused(*self.restore())
        self.assertIn("createdb: exit 3.", message)
        self.assertNotIn("incomplete", message)
        self.assertEqual(self.tools(), ["psql", "createdb"])
        self.assertFalse(self.target.exists())
