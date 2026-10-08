import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

from django.conf import settings
from django.test import SimpleTestCase

from .test_deploy_files import (
    AUTH_MODE, DOMAIN, SECRETS, SERVER_KEY, SERVER_PASSWORD, SPA_ROOT, UPSTREAM, caddy_block, uncommented,
)

# A static comparison of the Docker deployment files with each other, with the settings and with
# the systemd variant in deploy/. It builds no image and starts no container: that is QA.
ROOT = settings.BASE_DIR.parent
DOCKER = ROOT / "deploy" / "docker"
FILES = {
    "Dockerfile": ROOT / "Dockerfile", ".dockerignore": ROOT / ".dockerignore",
    "compose.prod.yaml": ROOT / "compose.prod.yaml", "Caddyfile": DOCKER / "Caddyfile",
    "checkist.env.example": DOCKER / "checkist.env.example", "ck": DOCKER / "ck", "deploy.sh": DOCKER / "deploy.sh",
}
SITE = "{$CHECKIST_SITE_ADDRESS}"
DOCKER_UPSTREAM = "web:8000"
HSTS = "{$DJANGO_HSTS_SECONDS}"
STATIC_ROOT = "/var/lib/checkist/static"
DATA_MOUNT = "data:/var/lib/checkist"
SCRATCH_MOUNT = "ocr_scratch:/var/lib/checkist-scratch"
CODEX_HOME = "/home/checkist/.codex"
SERVICES = {"postgres", "redis", "web", "celery", "proxy", "recognition"}
VOLUMES = {"postgres_data", "redis_data", "data", "ocr_scratch", "codex_home", "caddy_data", "caddy_config"}
# Read by Compose, the proxy or the scripts; Django settings never see them.
COMPOSE_ONLY = {
    "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "CHECKIST_SITE_ADDRESS", "CHECKIST_HTTP_BIND",
    "CHECKIST_HTTPS_BIND", "CHECKIST_BACKUP_DIR", "CHECKIST_ENV_FILE", "CODEX_HOME",
}


def text(name):
    return FILES[name].read_text(encoding="utf-8")


def code(name):
    """Lines of a file without blank lines and whole-line comments."""
    return "\n".join(
        line for line in text(name).splitlines() if line.strip() and not line.lstrip().startswith("#")
    )


def env_example():
    values = {}
    for line in code("checkist.env.example").splitlines():
        name, separator, value = line.partition("=")
        assert separator and name not in values, line
        values[name] = value
    return values


def settings_source():
    return (settings.BASE_DIR / "config" / "settings.py").read_text(encoding="utf-8")


def compose_sections():
    """Top-level sections of compose.prod.yaml: {key: text of its indented body}."""
    sections, current = {}, None
    for line in code("compose.prod.yaml").splitlines():
        if not line.startswith(" "):
            current, _, rest = line.partition(":")
            sections[current] = [rest.strip()] if rest.strip() else []
        else:
            sections[current].append(line)
    return {key: "\n".join(lines) for key, lines in sections.items()}


def compose_services():
    """Services of compose.prod.yaml: {name: text of the service body}."""
    services, current = {}, None
    for line in compose_sections()["services"].splitlines():
        match = re.fullmatch(r"  ([a-z_]+):", line)
        if match:
            current = services.setdefault(match.group(1), [])
        else:
            assert current is not None and line.startswith("    "), line
            current.append(line)
    return {name: "\n".join(lines) for name, lines in services.items()}


def mounts(service):
    """Short-syntax volume entries of a service body: ["source:target", ...]."""
    block = re.search(r"^    volumes:\n((?:      - .+\n?)+)", service, flags=re.MULTILINE)
    return [line.strip()[2:] for line in block.group(1).splitlines()] if block else []


def command(service):
    return json.loads(re.search(r"^    command: (\[.+\])$", service, flags=re.MULTILINE).group(1))


class DockerDeployFilesTests(SimpleTestCase):
    def test_files_are_present_utf8_and_lf(self):
        for name, path in FILES.items():
            with self.subTest(name=name):
                data = path.read_bytes()
                self.assertNotIn(b"\r", data)
                self.assertTrue(data.endswith(b"\n"))
                data.decode("utf-8")

    def test_no_secret_values_in_the_files(self):
        for name in FILES:
            with self.subTest(name=name):
                source = text(name)
                self.assertNotIn(settings.DEV_SECRET_KEY, source)
                self.assertNotIn("checkist_dev_only", source)
                for secret in SECRETS:
                    self.assertIsNone(re.search(rf"{secret}[ \t]*=[ \t]*\S", source))

    def test_local_files_of_a_server_are_ignored_by_git(self):
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn(".deploy-previous", ignored)
        self.assertIn(".env.prod", ignored)

    # Environment sample

    def test_env_example_is_a_server_configuration(self):
        variables = env_example()
        expected = {
            AUTH_MODE: "accounts", "DJANGO_DEBUG": "0", "DJANGO_TRUST_PROXY": "1", "DJANGO_SECURE_COOKIES": "1",
            "DJANGO_HSTS_SECONDS": "3600", "CHECKIST_SITE_ADDRESS": DOMAIN,
            "DJANGO_ALLOWED_HOSTS": DOMAIN, "DJANGO_CSRF_TRUSTED_ORIGINS": f"https://{DOMAIN}",
            "ALLOW_LOCAL_RECOGNITION_API": "0", "PRODUCT_MERGE_AUTO_DETECT": "0",
            "PRODUCT_CLASSIFICATION_AUTO_SUGGEST": "0", "POSTGRES_HOST": "postgres", "POSTGRES_PORT": "5432",
            "MEDIA_ROOT": "/var/lib/checkist/media", "RECEIPT_OCR_TEMP_ROOT": "/var/lib/checkist-scratch",
            "RECEIPT_OCR_PROVIDER": "codex_cli",
        }
        self.assertEqual({name: variables[name] for name in expected}, expected)
        for name in SECRETS:
            with self.subTest(name=name):
                self.assertEqual(variables[name], "")
        for name in ("CELERY_BROKER_URL", "CELERY_RESULT_BACKEND", "DJANGO_CACHE_URL"):
            with self.subTest(name=name):
                self.assertTrue(variables[name].startswith("redis://redis:6379/"), variables[name])

    def test_env_example_is_a_plain_environment_file(self):
        # Compose expands `$` and strips quotes in an environment file; the sample has neither.
        for line in code("checkist.env.example").splitlines():
            with self.subTest(line=line):
                self.assertRegex(line, r"^[A-Z][A-Z0-9_]*=[^\s\"'$`\\]*$")

    def test_env_example_names_only_known_variables(self):
        source = settings_source()
        # Commented assignments are part of the sample too.
        commented = re.findall(r"^# ([A-Z][A-Z0-9_]*)=", text("checkist.env.example"), flags=re.MULTILINE)
        self.assertEqual(
            set(commented),
            {"CHECKIST_HTTP_BIND", "CHECKIST_HTTPS_BIND", "CHECKIST_BACKUP_DIR", "COMPOSE_PROFILES",
             "COMPOSE_PROJECT_NAME"},
        )
        for name in (*env_example(), *commented):
            with self.subTest(name=name):
                if name in COMPOSE_ONLY:
                    self.assertNotIn(f'"{name}"', source)
                else:
                    self.assertIn(f'"{name}"', source)

    def test_compose_interpolates_only_known_variables(self):
        source = settings_source()
        names = set(re.findall(r"\$\{([A-Z][A-Z0-9_]*)", text("compose.prod.yaml")))
        self.assertLessEqual(
            {"CHECKIST_ENV_FILE", "CHECKIST_SITE_ADDRESS", "CHECKIST_HTTP_BIND", "CHECKIST_HTTPS_BIND",
             "CHECKIST_BACKUP_DIR", "POSTGRES_PASSWORD", "DJANGO_HSTS_SECONDS"},
            names,
        )
        for name in names:
            with self.subTest(name=name):
                self.assertTrue(name in COMPOSE_ONLY or f'"{name}"' in source)

    def load_settings(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            # Container paths are POSIX; any absolute directories of this machine stand in for them.
            environment = {
                **os.environ, **env_example(),
                "MEDIA_ROOT": str(Path(directory) / "data" / "media"),
                "RECEIPT_OCR_TEMP_ROOT": str(Path(directory) / "scratch"),
                "DJANGO_SECRET_KEY": SERVER_KEY, "POSTGRES_PASSWORD": SERVER_PASSWORD, **overrides,
            }
            return subprocess.run(
                [sys.executable, "-X", "utf8", "-c",
                 "import json\n"
                 "from unittest.mock import patch\n"
                 "with patch('dotenv.load_dotenv'):\n"
                 "    import config.settings as s\n"
                 "print(json.dumps({name: getattr(s, name) for name in ('DEBUG', 'CHECKIST_AUTH_MODE', "
                 "'TRUST_PROXY', 'SECURE_SSL_REDIRECT', 'SESSION_COOKIE_SECURE', 'CSRF_COOKIE_SECURE', "
                 "'SECURE_HSTS_SECONDS', 'ALLOWED_HOSTS', 'CSRF_TRUSTED_ORIGINS', "
                 "'ALLOW_LOCAL_RECOGNITION_API')}))\n"],
                cwd=settings.BASE_DIR, env=environment, capture_output=True, text=True, encoding="utf-8",
                timeout=20,
            )

    def test_settings_load_from_the_env_example_once_secrets_are_filled(self):
        result = self.load_settings()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "DEBUG": False, "CHECKIST_AUTH_MODE": "accounts", "TRUST_PROXY": True, "SECURE_SSL_REDIRECT": True,
            "SESSION_COOKIE_SECURE": True, "CSRF_COOKIE_SECURE": True, "SECURE_HSTS_SECONDS": 3600,
            "ALLOWED_HOSTS": [DOMAIN], "CSRF_TRUSTED_ORIGINS": [f"https://{DOMAIN}"],
            "ALLOW_LOCAL_RECOGNITION_API": False,
        })

    def test_settings_refuse_the_env_example_with_an_empty_secret(self):
        for name in SECRETS:
            with self.subTest(name=name):
                result = self.load_settings(**{name: ""})
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(f"ImproperlyConfigured: {name}:", result.stderr)
                self.assertEqual(result.stdout, "")

    # Caddy

    def test_caddy_rules_equal_the_systemd_caddyfile(self):
        # The same routes, headers and body limit; only the three deployment-specific values differ.
        expected = uncommented("Caddyfile")
        for old, new in (
            (f"{DOMAIN} {{", f"{SITE} {{"),
            (f"reverse_proxy {UPSTREAM}", f"reverse_proxy {DOCKER_UPSTREAM}"),
            ('"max-age=3600"', f'"max-age={HSTS}"'),
        ):
            self.assertEqual(expected.count(old), 1, old)
            expected = expected.replace(old, new)
        self.assertEqual(code("Caddyfile"), expected)

    def test_caddy_site_address_upstream_and_hsts_come_from_the_environment(self):
        caddy = code("Caddyfile")
        self.assertEqual(re.findall(r"^(\S.*) \{$", caddy, flags=re.MULTILINE), [SITE])
        self.assertEqual(caddy_block(caddy, "handle @django").split(), ["reverse_proxy", DOCKER_UPSTREAM])
        self.assertEqual(
            re.findall(r'Strict-Transport-Security "max-age=([^"]+)"', caddy), [HSTS],
        )
        self.assertEqual(set(re.findall(r"\{\$([A-Z0-9_]+)", caddy)), {"CHECKIST_SITE_ADDRESS", "DJANGO_HSTS_SECONDS"})
        for forbidden in ("http://", "auto_https", "tls internal", "trusted_proxies", DOMAIN, UPSTREAM):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, caddy)
        self.assertIsNone(re.search(r"^\s*log\b", caddy, flags=re.MULTILINE))

    def test_caddy_passes_the_same_django_paths(self):
        def paths(source):
            return set(re.search(r"^\s*@django path (.+)$", source, flags=re.MULTILINE).group(1).split())

        self.assertEqual(paths(code("Caddyfile")), paths(uncommented("Caddyfile")))
        self.assertEqual(paths(code("Caddyfile")), {"/api/*", "/admin", "/admin/*", "/media/*", "/robots.txt"})

    def test_caddy_never_reads_media_or_scratch_from_disk(self):
        caddy, variables = code("Caddyfile"), env_example()
        self.assertNotIn(variables["MEDIA_ROOT"], caddy)
        self.assertNotIn(variables["RECEIPT_OCR_TEMP_ROOT"], caddy)
        self.assertNotIn("scratch", caddy.lower())
        roots = set(re.findall(r"^\s*root \* (\S+)$", caddy, flags=re.MULTILINE))
        self.assertEqual(roots, {STATIC_ROOT, SPA_ROOT})
        for root in roots:
            self.assertFalse(PurePosixPath(variables["MEDIA_ROOT"]).is_relative_to(root))
        # Every mention of media is the proxied path.
        self.assertEqual(re.findall(r"\S*media\S*", caddy, flags=re.IGNORECASE), ["/media/*"])
        # The proxy container has neither the data volume nor the scratch volume.
        proxy = mounts(compose_services()["proxy"])
        self.assertEqual(proxy, ["caddy_data:/data", "caddy_config:/config"])

    # Compose

    def test_compose_project_services_and_volumes(self):
        sections = compose_sections()
        self.assertEqual(sections["name"], "checkist")
        self.assertEqual(set(compose_services()), SERVICES)
        self.assertEqual(set(re.findall(r"^  ([a-z_]+):$", sections["volumes"], flags=re.MULTILINE)), VOLUMES)
        dev = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        for name in ("postgres", "redis"):
            with self.subTest(name=name):
                image = re.search(r"^    image: (\S+)$", compose_services()[name], flags=re.MULTILINE).group(1)
                self.assertRegex(image, rf"^{name}:\d+\.\d+(\.\d+)?-alpine$")
                self.assertIn(f"image: {image}\n", dev)

    def test_only_the_proxy_publishes_ports(self):
        services = compose_services()
        for name in SERVICES - {"proxy"}:
            with self.subTest(name=name):
                self.assertNotIn("ports:", services[name])
                self.assertNotIn("network_mode", services[name])
        published = re.search(r"^    ports:\n((?:      - .+\n)+)", services["proxy"], flags=re.MULTILINE).group(1)
        self.assertEqual(
            [line.strip() for line in published.splitlines()],
            ['- "${CHECKIST_HTTP_BIND:-80}:80"', '- "${CHECKIST_HTTPS_BIND:-443}:443"'],
        )

    def test_data_volume_is_the_parent_of_media(self):
        services, variables = compose_services(), env_example()
        target = DATA_MOUNT.partition(":")[2]
        # Storage stages renames next to MEDIA: the volume holds the parent directory as a whole.
        self.assertEqual(target, str(PurePosixPath(variables["MEDIA_ROOT"]).parent))
        self.assertIn(DATA_MOUNT, mounts(services["web"]))
        self.assertIn(DATA_MOUNT, mounts(services["recognition"]))
        for name, service in services.items():
            for mount in mounts(service):
                with self.subTest(name=name, mount=mount):
                    self.assertNotEqual(mount.rpartition(":")[2], variables["MEDIA_ROOT"])
        # Copies go to a host directory, outside the data volume and MEDIA.
        self.assertIn("${CHECKIST_BACKUP_DIR:-/var/backups/checkist}:/backups", mounts(services["web"]))
        self.assertEqual(mounts(services["celery"]), [])

    def test_scratch_and_codex_login_belong_to_the_recognition_service_only(self):
        services, variables = compose_services(), env_example()
        self.assertEqual(SCRATCH_MOUNT.partition(":")[2], variables["RECEIPT_OCR_TEMP_ROOT"])
        self.assertEqual(
            mounts(services["recognition"]), [DATA_MOUNT, SCRATCH_MOUNT, f"codex_home:{CODEX_HOME}"],
        )
        for name in SERVICES - {"recognition"}:
            with self.subTest(name=name):
                self.assertNotIn("ocr_scratch", services[name])
                self.assertNotIn("codex", services[name].lower())

    def test_recognition_service_is_a_profile_stopped_by_sigint(self):
        service = compose_services()["recognition"]
        self.assertIn('    profiles: ["recognition"]\n', service)
        self.assertEqual(command(service), ["python", "manage.py", "recognition_worker"])
        # The worker releases its job only on KeyboardInterrupt.
        self.assertIn("    stop_signal: SIGINT\n", service)
        self.assertIn("    init: true\n", service)
        grace = re.search(r"^    stop_grace_period: (\d+)s$", service, flags=re.MULTILINE)
        self.assertGreater(int(grace.group(1)), settings.RECEIPT_OCR_CANCEL_GRACE_SECONDS)
        self.assertIn(f"      CODEX_HOME: {CODEX_HOME}\n", service)
        self.assertEqual(
            sum(len(re.findall(r"^    profiles:", body, flags=re.MULTILINE)) for body in compose_services().values()),
            1,
        )

    def test_web_and_celery_commands(self):
        services = compose_services()
        self.assertEqual(command(services["web"]), [
            "gunicorn", "config.wsgi:application", "-c", "/app/deploy/gunicorn.conf.py", "--bind", "0.0.0.0:8000",
        ])
        self.assertEqual(settings.WSGI_APPLICATION, "config.wsgi.application")
        self.assertEqual(DOCKER_UPSTREAM, "web:8000")
        celery = command(services["celery"])
        self.assertEqual(celery[:4], ["celery", "-A", "config", "worker"])
        unit = (ROOT / "deploy" / "systemd" / "checkist-celery.service").read_text(encoding="utf-8")
        for flag in ("--pool=prefork", "--concurrency=1", "--hostname=checkist@worker"):
            with self.subTest(flag=flag):
                self.assertIn(flag, celery)
                self.assertIn(flag, unit)
        self.assertNotIn("beat", " ".join(celery))

    def test_services_restart_wait_for_dependencies_and_report_health(self):
        services = compose_services()
        shared = compose_sections()["x-app"]
        self.assertIn("  restart: unless-stopped", shared)
        self.assertIn("    - ${CHECKIST_ENV_FILE:-.env.prod}", shared)
        for name, service in services.items():
            with self.subTest(name=name):
                if "<<: *app" in service:
                    self.assertNotIn("restart:", service)
                else:
                    self.assertIn("    restart: unless-stopped", service)
                    # Only the application services read the whole environment file.
                    self.assertNotIn("env_file", service)
                self.assertNotIn("service_started", service)
                if name != "recognition":
                    self.assertIn("    healthcheck:", service)
        for name in ("web", "celery"):
            with self.subTest(name=name):
                self.assertEqual(
                    re.findall(r"^      ([a-z]+):\n        condition: service_healthy$", services[name],
                               flags=re.MULTILINE),
                    ["postgres", "redis"],
                )
        self.assertIn("      web:\n        condition: service_healthy", services["proxy"])

    # Dockerfile

    def test_dockerfile_stages_and_pinned_images(self):
        dockerfile = code("Dockerfile")
        stages = re.findall(r"^FROM (\S+) AS (\S+)$", dockerfile, flags=re.MULTILINE)
        names = {name: image for image, name in stages}
        # Every stage is named, and no name repeats.
        self.assertEqual(len(names), len(re.findall(r"^FROM ", dockerfile, flags=re.MULTILINE)))
        self.assertLessEqual({"frontend-build", "app", "static", "recognition", "proxy"}, set(names))
        self.assertRegex(names["frontend-build"], r"^node:24\.\d+\.\d+-")
        self.assertRegex(names["app"], r"^python:3\.13\.\d+-")
        self.assertRegex(names["proxy"], r"^caddy:2\.\d+\.\d+-")
        self.assertEqual((names["static"], names["recognition"]), ("app", "app"))
        self.assertNotIn(":latest", dockerfile)
        self.assertRegex(dockerfile, r"(?m)^ARG CODEX_VERSION=\d+\.\d+\.\d+$")
        self.assertEqual(len(re.findall(r"(?m)^ARG CODEX_SHA256_[A-Z0-9]+=[0-9a-f]{64}$", dockerfile)), 2)
        for target in ("app", "proxy", "recognition"):
            with self.subTest(target=target):
                self.assertIn(f"    target: {target}\n", text("compose.prod.yaml"))

    def test_dockerfile_user_paths_and_tools(self):
        dockerfile, variables = code("Dockerfile"), env_example()
        self.assertIn("groupadd --gid 10001 checkist", dockerfile)
        self.assertIn("useradd --uid 10001 --gid 10001", dockerfile)
        created = " ".join(re.findall(r"install -d -o checkist -g checkist -m \d+ ([^\\\n]+)", dockerfile)).split()
        self.assertEqual(
            set(created),
            {str(PurePosixPath(variables["MEDIA_ROOT"]).parent), variables["MEDIA_ROOT"],
             variables["RECEIPT_OCR_TEMP_ROOT"], CODEX_HOME},
        )
        # The PostgreSQL client matches the major version of the server image.
        major = re.search(r"image: postgres:(\d+)\.", text("compose.prod.yaml")).group(1)
        self.assertIn(f"postgresql-client-{major}", dockerfile)
        self.assertIn("COPY backend/ /app/backend/", dockerfile)
        self.assertIn("COPY deploy/gunicorn.conf.py /app/deploy/gunicorn.conf.py", dockerfile)
        self.assertIn("/usr/local/bin/codex", dockerfile)
        self.assertEqual(variables["RECEIPT_OCR_CODEX_EXECUTABLE"], "/usr/local/bin/codex")
        # The last USER of the application images is the unprivileged one.
        for stage in ("app", "recognition"):
            with self.subTest(stage=stage):
                body = re.search(rf"^FROM \S+ AS {stage}$(.*?)(?=^FROM |\Z)", dockerfile, flags=re.MULTILINE | re.DOTALL)
                self.assertEqual(re.findall(r"^USER (\S+)$", body.group(1), flags=re.MULTILINE)[-1], "checkist")
        self.assertIn("COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile", dockerfile)
        self.assertIn(f"COPY --from=frontend-build /src/frontend/dist {SPA_ROOT}", dockerfile)
        self.assertIn(f"DJANGO_STATIC_ROOT={STATIC_ROOT} python manage.py collectstatic --noinput", dockerfile)
        self.assertIn(f"COPY --from=static {STATIC_ROOT} {STATIC_ROOT}", dockerfile)

    def test_dockerignore_keeps_secrets_and_local_data_out_of_the_context(self):
        ignored = code(".dockerignore").splitlines()
        for pattern in (".git", ".env*", "**/.env*", "**/node_modules", "**/.venv", "media/", "frontend/dist",
                        "frontend/*-preview/"):
            with self.subTest(pattern=pattern):
                self.assertIn(pattern, ignored)
        # Everything the stages copy stays in the context.
        for kept in ("backend", "backend/", "frontend", "frontend/", "deploy", "deploy/", "deploy/docker",
                     "deploy/docker/"):
            with self.subTest(kept=kept):
                self.assertNotIn(kept, ignored)

    # Scripts

    def test_scripts_are_strict_bash_and_never_remove_volumes(self):
        for name in ("ck", "deploy.sh"):
            with self.subTest(name=name):
                source = text(name)
                self.assertTrue(source.startswith("#!/usr/bin/env bash\n"))
                self.assertIn("\nset -euo pipefail\n", source)
                for forbidden in ("down -v", "--volumes", "volume rm", "volume prune", "system prune", "rm -rf"):
                    self.assertNotIn(forbidden, source)
                self.assertIsNone(re.search(r"compose[^\n]*\bdown\b", code(name)))

    def test_ck_names_the_compose_file_and_the_environment_file(self):
        source = code("ck")
        self.assertIn('env_file="${CHECKIST_ENV_FILE:-.env.prod}"', source)
        self.assertIn('compose=(docker compose -f compose.prod.yaml --env-file "$env_file")', source)
        # Without a terminal (cron) the one-off container gets no TTY.
        self.assertIn("tty=(-T)", source)
        self.assertIn("run --rm", source)

    def test_deploy_script_steps_come_in_order(self):
        source = code("deploy.sh")
        main = source[source.index("main() {"):source.index("update_code() {")]
        steps = [
            'exec "$self"', "compose config --quiet", "compose build", "stop recognition",
            "backup create --dir /backups --keep-days $backup_keep_days", "compose stop web celery",
            "manage.py migrate --noinput", "manage.py check --deploy",
            "compose up -d --wait --wait-timeout 300 --remove-orphans", "$health_probe", "docker image prune -f",
        ]
        positions = [main.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("backup_keep_days=14", source)
        self.assertIn("git pull --ff-only", source)
        self.assertIn('printf \'%s\\n\' "$before" > "$previous_file"', source)
        self.assertIn('previous_file="$root/.deploy-previous"', source)
        self.assertIn("/api/health/", source)
        for flag in ("--no-pull)", "--no-backup)", "--ref)"):
            with self.subTest(flag=flag):
                self.assertIn(flag, main)
