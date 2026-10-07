"""Backup copies of the database and MEDIA, and their restore into a new database and directory.

A copy is the directory ``checkist-YYYYMMDDTHHMMSSZ`` with ``db.dump`` (``pg_dump -Fc --no-owner``),
``media.tar.gz`` (the files of MEDIA_ROOT; recognition staging and scratch live outside it) and
``manifest.json``, which is written last: a directory without it is not a copy.

PostgreSQL client tools run without a shell. ``CHECKIST_PG_TOOLS_PREFIX`` is put in front of every tool,
for example ``docker compose -p checkist_qa exec -T postgres``. The user and the database name are
arguments, so they reach a tool behind such a prefix; the host, the port and the password are only in the
environment of the child process, so a tool inside a container uses its own local socket.
"""
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import tarfile
import zlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

from django.conf import settings

PREFIX_VARIABLE = "CHECKIST_PG_TOOLS_PREFIX"
FORMAT_VERSION = 1
DUMP, MEDIA, MANIFEST = "db.dump", "media.tar.gz", "manifest.json"
DUMP_MAGIC = b"PGDMP"
STAMP = "%Y%m%dT%H%M%SZ"
COPY_NAME = re.compile(r"^checkist-(\d{8}T\d{6}Z)$")
PARTIAL_NAME = re.compile(r"^\.checkist-(\d{8}T\d{6}Z)\.partial$")
DATABASE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
DEFAULT_KEEP_DAYS = 14
STALE_PARTIAL = timedelta(days=1)


class BackupError(Exception):
    pass


def database_settings():
    return settings.DATABASES["default"]


def tools_prefix():
    try:
        return shlex.split(os.environ.get(PREFIX_VARIABLE, ""))
    except ValueError:
        raise BackupError(f"{PREFIX_VARIABLE}: expected a command line with balanced quotes.") from None


def child_environment():
    database = database_settings()
    environment = os.environ.copy()
    for name, key in (("PGHOST", "HOST"), ("PGPORT", "PORT"), ("PGPASSWORD", "PASSWORD")):
        environment.pop(name, None)
        if database.get(key):
            environment[name] = str(database[key])
    return environment


def _stderr_tail(raw):
    text = (raw or b"").decode("utf-8", errors="replace")
    password = str(database_settings().get("PASSWORD") or "")
    if password:
        text = text.replace(password, "***")
    return " | ".join(line.strip() for line in text.splitlines()[-5:] if line.strip())


def run_tool(tool, arguments, *, stdin=None, stdout=None):
    command = [*tools_prefix(), tool, "--no-password", "--username", str(database_settings()["USER"]), *arguments]
    try:
        completed = subprocess.run(
            command, stdin=stdin if stdin is not None else subprocess.DEVNULL,
            stdout=stdout if stdout is not None else subprocess.PIPE, stderr=subprocess.PIPE,
            env=child_environment(), check=False,
        )
    except OSError:
        raise BackupError(f"{tool}: cannot be started. Check PATH and {PREFIX_VARIABLE}.") from None
    if completed.returncode != 0:
        detail = _stderr_tail(completed.stderr)
        raise BackupError(f"{tool}: exit {completed.returncode}." + (f" {detail}" if detail else ""))
    return completed.stdout


def sha256(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def media_root():
    return Path(settings.MEDIA_ROOT).resolve()


def _overlap(first, second):
    return first.is_relative_to(second) or second.is_relative_to(first)


def _dump_database(target):
    with open(target, "wb") as stream:
        run_tool("pg_dump", ["-Fc", "--no-owner", "--dbname", str(database_settings()["NAME"])], stdout=stream)
    with open(target, "rb") as stream:
        if stream.read(len(DUMP_MAGIC)) != DUMP_MAGIC:
            raise BackupError("pg_dump: the output is not a custom-format dump.")


def _archive_media(target):
    root = media_root()
    count = 0
    with tarfile.open(target, "w:gz") as archive:
        if root.is_dir():
            for directory, directories, files in os.walk(root):
                directories.sort()
                for name in sorted(files):
                    path = Path(directory) / name
                    if path.is_symlink() or not path.is_file():
                        continue
                    archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
                    count += 1
    return count


def _stamp(name, pattern):
    match = pattern.match(name)
    if match is None:
        return None
    try:
        return datetime.strptime(match.group(1), STAMP).replace(tzinfo=UTC)
    except ValueError:
        return None


def _directories(directory, pattern):
    found = []
    for path in Path(directory).iterdir():
        stamp = _stamp(path.name, pattern)
        if stamp is not None and path.is_dir() and not path.is_symlink():
            found.append((stamp, path))
    return sorted(found)


def completed_copies(directory):
    """Finished copies, oldest first. The manifest is written last, so its presence marks success."""
    return [(stamp, path) for stamp, path in _directories(directory, COPY_NAME) if (path / MANIFEST).is_file()]


def prune(directory, keep_days, now=None):
    """Remove finished copies older than ``keep_days``. The last successful copy is never removed."""
    now = now or datetime.now(UTC)
    copies = completed_copies(directory)
    removed = []
    for stamp, path in copies[:-1]:
        if stamp < now - timedelta(days=keep_days):
            shutil.rmtree(path)
            removed.append(path.name)
    # Leftovers of interrupted runs; a fresh one may belong to a run still in progress.
    for stamp, path in _directories(directory, PARTIAL_NAME):
        if stamp < now - STALE_PARTIAL:
            shutil.rmtree(path)
    return removed


def create(directory, keep_days=DEFAULT_KEEP_DAYS, now=None):
    if keep_days < 0:
        raise BackupError("--keep-days: expected a non-negative number of days.")
    now = now or datetime.now(UTC)
    directory = Path(directory).resolve()
    if directory.is_relative_to(media_root()):
        raise BackupError("--dir: the copies directory must be outside MEDIA_ROOT.")
    directory.mkdir(parents=True, exist_ok=True)
    name = f"checkist-{now.strftime(STAMP)}"
    final, partial = directory / name, directory / f".{name}.partial"
    if final.exists() or partial.exists():
        raise BackupError(f"{name}: a copy with this timestamp already exists.")
    partial.mkdir(mode=0o700)
    try:
        # The dump goes first: files added to MEDIA meanwhile are extra, never missing.
        _dump_database(partial / DUMP)
        media_files = _archive_media(partial / MEDIA)
        manifest = {
            "version": FORMAT_VERSION,
            "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "database": str(database_settings()["NAME"]),
            "media_files": media_files,
            "files": {
                item: {"size": (partial / item).stat().st_size, "sha256": sha256(partial / item)}
                for item in (DUMP, MEDIA)
            },
        }
        (partial / MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n",
        )
        partial.rename(final)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    # Only a successful run prunes: a failed one leaves every earlier copy in place.
    return {"copy": str(final), "manifest": manifest, "removed": prune(directory, keep_days, now)}


def _read_manifest(copy):
    try:
        manifest = json.loads((copy / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise BackupError(f"{MANIFEST}: missing or unreadable; the directory is not a finished copy.") from None
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if (
        not isinstance(files, dict) or manifest.get("version") != FORMAT_VERSION or set(files) != {DUMP, MEDIA}
        or type(manifest.get("media_files")) is not int
        or any(
            not isinstance(entry, dict) or type(entry.get("size")) is not int
            or not isinstance(entry.get("sha256"), str)
            for entry in files.values()
        )
    ):
        raise BackupError(f"{MANIFEST}: unsupported version or contents.")
    return manifest


def _media_members(path):
    """Read the whole archive (the gzip checksum is checked at its end) and count the files."""
    count = 0
    try:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                if member.isfile():
                    stream = archive.extractfile(member)
                    while stream.read(1024 * 1024):
                        pass
                    count += 1
                elif not member.isdir():
                    raise BackupError(f"{MEDIA}: unexpected member type.")
    except (tarfile.TarError, OSError, EOFError, zlib.error):
        raise BackupError(f"{MEDIA}: the archive is unreadable.") from None
    return count


def verify(copy):
    copy = Path(copy).resolve()
    if not copy.is_dir():
        raise BackupError("The copy directory does not exist.")
    manifest = _read_manifest(copy)
    for name, entry in manifest["files"].items():
        path = copy / name
        if not path.is_file():
            raise BackupError(f"{name}: missing.")
        if path.stat().st_size != entry["size"] or sha256(path) != entry["sha256"]:
            raise BackupError(f"{name}: size or sha256 differs from {MANIFEST}.")
    with open(copy / DUMP, "rb") as stream:
        if stream.read(len(DUMP_MAGIC)) != DUMP_MAGIC:
            raise BackupError(f"{DUMP}: not a custom-format dump.")
    if _media_members(copy / MEDIA) != manifest["media_files"]:
        raise BackupError(f"{MEDIA}: the number of files differs from {MANIFEST}.")
    return manifest


def database_exists(name):
    output = run_tool("psql", [
        "-X", "-At", "--dbname", "postgres", "-c", f"SELECT 1 FROM pg_database WHERE datname = '{name}'",
    ])
    return bool(output.strip())


def restore(copy, database, target):
    """Restore into a new database and a new directory. The working database and MEDIA are not touched."""
    copy = Path(copy).resolve()
    manifest = verify(copy)
    if not DATABASE_NAME.match(database):
        raise BackupError("--database: expected a name of Latin letters, digits and underscores.")
    if database == str(database_settings()["NAME"]):
        raise BackupError("--database: this is the working database; name a new one.")
    target = Path(target).resolve()
    if _overlap(target, media_root()):
        raise BackupError("--media-root: this overlaps the working MEDIA_ROOT; name a new directory.")
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise BackupError("--media-root: the directory is not empty; name a new or empty one.")
    if database_exists(database):
        raise BackupError(f"--database: {database} already exists; name a new one.")
    run_tool("createdb", ["--template", "template0", "--encoding", "UTF8", database])
    try:
        with open(copy / DUMP, "rb") as stream:
            run_tool("pg_restore", ["--no-owner", "--exit-on-error", "--dbname", database], stdin=stream)
        target.mkdir(parents=True, exist_ok=True)
        with tarfile.open(copy / MEDIA, "r:gz") as archive:
            archive.extractall(target, filter="data")
    except (BackupError, OSError, tarfile.TarError) as error:
        raise BackupError(
            f"{error} The new database {database} was created and is incomplete: "
            "drop it (dropdb) and clear the new media directory before retrying."
        ) from None
    return {"database": database, "media_root": str(target), "media_files": manifest["media_files"]}
