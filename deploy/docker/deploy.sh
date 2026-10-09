#!/usr/bin/env bash
# Checkist in Docker: first start and every update with one command.
#
#   deploy/docker/deploy.sh                  git pull, then build, backup, migrate, restart
#   deploy/docker/deploy.sh --no-pull        the same for the code already checked out (first start)
#   deploy/docker/deploy.sh --ref <commit>   check out this commit instead of pulling (rollback)
#   deploy/docker/deploy.sh --no-backup      skip the backup copy before the migrations
#
# The commit that was running before a pull or --ref is kept in .deploy-previous:
#   deploy/docker/deploy.sh --ref "$(cat .deploy-previous)"
# Any failed step stops the script. The site is down only between "stop web and celery" and "start";
# a failure there prints the command that brings the site back (--no-pull --no-backup).
# Volumes are never removed here.
set -euo pipefail

# Git Bash on Windows would rewrite container paths such as /backups.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
self="$root/deploy/docker/deploy.sh"
ck="$root/deploy/docker/ck"
previous_file="$root/.deploy-previous"
backup_keep_days=14

usage() {
    sed -n '2,13p' "$self" | sed 's/^# \{0,1\}//' >&2
}

current_step="reading the arguments"
site_stopped=0
# running | stopped | absent: the web service container before this run touched anything.
web_before=""
# made | no-backup | first-start: how the copy step of this run ended.
copy_state=""
# What a failed run prints while web is stopped; docs/deployment-docker.md names the same commands.
recover="deploy/docker/deploy.sh --no-pull --no-backup"
manual_copy="deploy/docker/ck manage backup create --dir /backups --keep-days $backup_keep_days"

step() {
    current_step="$1"
    printf '\n==> %s\n' "$1"
}

die() {
    printf 'deploy: %s\n' "$*" >&2
    exit 1
}

# The service container of web; one-off containers of `ck manage` (compose run) are not it,
# though `ps --all` lists them as well.
web_state() {
    local running ids id oneoff oneoff_label='{{ index .Config.Labels "com.docker.compose.oneoff" }}'
    running="$("$ck" compose ps --quiet --status running web)" || return 1
    if [ -n "$running" ]; then
        echo running
        return
    fi
    ids="$("$ck" compose ps --all --quiet web)" || return 1
    for id in $ids; do
        # A one-off container may be removed between the two commands.
        oneoff="$(docker inspect --format "$oneoff_label" "$id" 2>/dev/null)" || continue
        case "$oneoff" in
            [Tt]rue) ;;
            *)
                echo stopped
                return
                ;;
        esac
    done
    echo absent
}

no_copy_note() {
    echo "deploy: This run made NO copy ($1), and the commands below do not make one either." >&2
    echo "deploy: To make one first:" >&2
    echo "deploy:   $manual_copy" >&2
}

on_exit() {
    local code=$?
    [ "$code" -eq 0 ] && return
    printf '\ndeploy: FAILED at step "%s" (exit %s). Nothing after it was done.\n' "$current_step" "$code" >&2
    if [ "$site_stopped" -eq 1 ]; then
        echo "deploy: this run stopped web and celery and did not bring them back - the site is down." >&2
        case "$copy_state" in
            made) echo "deploy: The copy of this run is already made: the commands below skip it." >&2 ;;
            no-backup) no_copy_note "--no-backup was given" ;;
            *) no_copy_note "there was no web container to take it from" ;;
        esac
        echo "deploy: Fix the cause and bring the site up:" >&2
        echo "deploy:   $recover" >&2
        if [ -s "$previous_file" ]; then
            echo "deploy: or return to the previous commit (see the rollback rules for migrations first):" >&2
            echo "deploy:   deploy/docker/deploy.sh --ref $(cat "$previous_file") --no-backup" >&2
        fi
        echo "deploy: A repeat without --no-backup stops at the copy step while web is stopped." >&2
        return
    fi
    # A failure before the state was read: ask now, quietly.
    [ -n "$web_before" ] || web_before="$(web_state 2>/dev/null || true)"
    if [ "$web_before" = stopped ]; then
        echo "deploy: this run stopped nothing, but web was stopped before it - the site is down." >&2
        echo "deploy: Fix the cause and bring the site up; this command makes no copy:" >&2
        echo "deploy:   $recover" >&2
        echo "deploy: If the run that stopped web made no copy either, make one first:" >&2
        echo "deploy:   $manual_copy" >&2
    else
        echo "deploy: the running containers were not touched." >&2
    fi
}

main() {
    local pull=1 ref="" backup=1 state
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --no-pull) pull=0 ;;
            --no-backup) backup=0 ;;
            --ref)
                [ "$#" -ge 2 ] || die "--ref needs a commit."
                ref="$2"
                shift
                ;;
            -h|--help) usage; exit 0 ;;
            *) usage; die "unknown argument: $1" ;;
        esac
        shift
    done

    trap on_exit EXIT
    cd "$root"

    if [ -n "$ref" ] || [ "$pull" -eq 1 ]; then
        update_code "$ref"
        # The rest runs from the version just checked out.
        local again=(--no-pull)
        [ "$backup" -eq 1 ] || again+=(--no-backup)
        [ -x "$self" ] || die "$self is missing or not executable in this commit."
        trap - EXIT
        exec "$self" "${again[@]}"
    fi

    step "check the configuration"
    docker compose version >/dev/null || die "Docker with the Compose plugin is required."
    "$ck" compose config --quiet
    web_before="$(web_state)"

    step "build the images (the site keeps running)"
    "$ck" compose build

    step "stop the recognition worker"
    if [ -n "$("$ck" compose --profile recognition ps --quiet --status running recognition)" ]; then
        # SIGINT: the worker returns its job to the queue.
        "$ck" compose --profile recognition stop recognition
    else
        echo "not running"
    fi

    step "backup copy of the database and MEDIA"
    if [ "$backup" -eq 0 ]; then
        copy_state="no-backup"
        echo "skipped: --no-backup"
    else
        state="$(web_state)"
        case "$state" in
            running)
                if ! "$ck" compose exec -T web sh -c \
                    "umask 077 && exec python manage.py backup create --dir /backups --keep-days $backup_keep_days"; then
                    echo "deploy: the copies directory on the host is CHECKIST_BACKUP_DIR (default /var/backups/checkist):" >&2
                    echo "deploy:   sudo install -d -o 10001 -g 10001 -m 0700 /var/backups/checkist" >&2
                    exit 1
                fi
                copy_state="made"
                ;;
            stopped)
                # on_exit names the commands.
                web_before="stopped"
                die "the web container exists but is not running: this step takes the copy only from a running web."
                ;;
            *)
                copy_state="first-start"
                echo "skipped: no web container yet (first start)"
                ;;
        esac
    fi

    step "stop web and celery (the site is down from here)"
    site_stopped=1
    "$ck" compose stop web celery

    step "apply the migrations"
    "$ck" compose run --rm -T web python manage.py migrate --noinput

    step "manage.py check --deploy"
    "$ck" compose run --rm -T web python manage.py check --deploy

    step "start the services and wait until they are healthy"
    "$ck" compose up -d --wait --wait-timeout 300 --remove-orphans

    step "ask /api/health/"
    "$ck" compose exec -T web python -c "$health_probe"
    site_stopped=0

    step "remove dangling images"
    docker image prune -f

    current_step="done"
    printf '\ndeploy: done, version %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    "$ck" compose ps
}

# Records the commit that was running, then moves the working tree: --ref or git pull.
update_code() {
    local ref="$1" before after
    step "update the code"
    git rev-parse --git-dir >/dev/null || die "$root is not a git repository."
    before="$(git rev-parse HEAD)"
    if [ -n "$ref" ]; then
        if ! git cat-file -e "$ref^{commit}" 2>/dev/null; then
            git fetch --tags
        fi
        git checkout --detach "$ref"
        echo "HEAD is detached at $ref. Before the next plain update return to the branch: git switch -"
    else
        git symbolic-ref --quiet HEAD >/dev/null || die "HEAD is detached (after --ref)." \
            "Return to the branch first: git switch <branch>, or name a commit with --ref."
        git pull --ff-only
    fi
    after="$(git rev-parse HEAD)"
    if [ "$before" != "$after" ]; then
        printf '%s\n' "$before" > "$previous_file"
        echo "previous commit $before saved in .deploy-previous"
    else
        echo "no new commits"
    fi
}

# Runs inside the web container, past the proxy: the host and the scheme are named as Caddy would.
health_probe='
import json, os, sys, time, urllib.error, urllib.request

host = os.environ["DJANGO_ALLOWED_HOSTS"].split(",")[0].strip()
request = urllib.request.Request(
    "http://127.0.0.1:8000/api/health/", headers={"Host": host, "X-Forwarded-Proto": "https"},
)
last = ""
for attempt in range(20):
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.load(response)
        if body.get("status") == "ok":
            print("health: ok", json.dumps(body["checks"]))
            sys.exit(0)
        last = json.dumps(body)
    except urllib.error.HTTPError as error:
        last = "HTTP %s: %s" % (error.code, error.read(2000).decode("utf-8", "replace"))
    except (OSError, ValueError) as error:
        last = repr(error)
    time.sleep(3)
print("health: not ok after a minute:", last, file=sys.stderr)
sys.exit(1)
'

main "$@"
exit
