"""gunicorn for the server deployment: `gunicorn config.wsgi:application -c deploy/gunicorn.conf.py`.

Started by deploy/systemd/checkist-web.service from /opt/checkist/backend. Linux only.
"""

# Loopback only: the outside world reaches Django through Caddy (deploy/Caddyfile).
bind = "127.0.0.1:8000"
# Threads: a slow 20 MB upload from a phone occupies a thread, not the whole worker.
worker_class = "gthread"
workers = 2
threads = 4
timeout = 60
graceful_timeout = 30
# gunicorn must not decide the request scheme: by default it trusts X-Forwarded-Proto
# from 127.0.0.1 and would make the request secure even with DJANGO_TRUST_PROXY=0.
# Only Django reads the header (SECURE_PROXY_SSL_HEADER), and only with DJANGO_TRUST_PROXY=1.
secure_scheme_headers = {}
# The control socket would live in ~/.gunicorn: the unit keeps the home directory read-only,
# and nothing here manages gunicorn through it.
control_socket_disable = True
# No access log: request paths and queries carry receipt and product ids.
accesslog = None
errorlog = "-"
loglevel = "info"
