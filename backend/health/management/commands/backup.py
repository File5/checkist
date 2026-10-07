import json
import tarfile

from django.core.management.base import BaseCommand, CommandError

from health import backup


class Command(BaseCommand):
    help = (
        "Backup copies of the database and MEDIA: `create --dir <directory> [--keep-days 14]` writes a copy "
        "and removes finished copies older than the term (never the last successful one); `verify <copy>` "
        "checks sha256 and the archive; `restore <copy> --database <new> --media-root <new>` restores into "
        "a new database and a new directory only. CHECKIST_PG_TOOLS_PREFIX is put in front of "
        "pg_dump / pg_restore / createdb / psql."
    )

    def add_arguments(self, parser):
        actions = parser.add_subparsers(dest="action", required=True)
        create = actions.add_parser("create")
        create.add_argument("--dir", required=True, help="directory of the copies; created when missing.")
        create.add_argument(
            "--keep-days", type=int, default=backup.DEFAULT_KEEP_DAYS,
            help="finished copies older than this are removed after a successful run.",
        )
        verify = actions.add_parser("verify")
        verify.add_argument("copy")
        restore = actions.add_parser("restore")
        restore.add_argument("copy")
        restore.add_argument("--database", required=True, help="name of a database that does not exist yet.")
        restore.add_argument("--media-root", required=True, help="a missing or empty directory.")

    def handle(self, *args, **options):
        try:
            if options["action"] == "create":
                payload = backup.create(options["dir"], options["keep_days"])
            elif options["action"] == "verify":
                payload = {"copy": options["copy"], "manifest": backup.verify(options["copy"])}
            else:
                payload = backup.restore(options["copy"], options["database"], options["media_root"])
        except backup.BackupError as error:
            raise CommandError(str(error)) from None
        except (OSError, tarfile.TarError) as error:
            raise CommandError(f"Backup storage error: {error}") from None
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
