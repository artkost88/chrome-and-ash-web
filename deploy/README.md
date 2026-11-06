# Chrome & Ash — VDS deploy (loopback only)

Host: `179.66.186.98` (Timeweb, Docker + systemd + Caddy). The game is published **only on
`127.0.0.1:3100`** — no Caddy route, no public port. Access through an SSH tunnel:

```bash
ssh -i ~/.ssh/timeweb_vds_ed25519 -L 3100:127.0.0.1:3100 root@179.66.186.98
# then open http://127.0.0.1:3100
```

## Layout on the host

- `/opt/chrome-and-ash/app` — extracted source (server + chrome-and-ash-web + deploy)
- `/opt/chrome-and-ash/data/cna.db` — SQLite (mounted at `/data`)
- `/etc/chrome-and-ash.env` — secrets/config (chmod 600)
- `chrome-and-ash.service` — systemd unit running the container

## Install / update

```bash
# local
git archive --format=tar.gz -o /tmp/chrome-and-ash.tgz HEAD
scp /tmp/chrome-and-ash.tgz root@179.66.186.98:/tmp/
```

```bash
# host
mkdir -p /opt/chrome-and-ash/app /opt/chrome-and-ash/data
tar -xzf /tmp/chrome-and-ash.tgz -C /opt/chrome-and-ash/app
cd /opt/chrome-and-ash/app
docker build -q -f deploy/Dockerfile -t chrome-and-ash:latest .
install -m 644 deploy/chrome-and-ash.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now chrome-and-ash.service
```

`/etc/chrome-and-ash.env` (create once; keep `PEPPER` stable):

```ini
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
DB_PATH=/data/cna.db
CLIENT_DIR=/app/chrome-and-ash-web
PEPPER=<openssl rand -hex 32>
SESSION_TTL_DAYS=30
```

## Verify

```bash
curl -s http://127.0.0.1:3100/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/
ss -ltnp | grep 3100          # must be 127.0.0.1:3100
docker ps --filter name=chrome-and-ash
journalctl -u chrome-and-ash -n 30
```

To make it public later, add a Caddy route and publish the port on `0.0.0.0`; intentionally not done.
