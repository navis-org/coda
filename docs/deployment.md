# MCP server deployment

[`coda-mcp`](https://github.com/navis-org/coda-mcp) at `https://flyem.mrc-lmb.cam.ac.uk/coda-mcp/`.
Connector URL: `https://flyem.mrc-lmb.cam.ac.uk/coda-mcp/mcp`. Design and contract: [mcp.md](mcp.md).

Status (2026-09-15): deployed, Coda build `a917eae1bda7`. Verified from outside: MCP session, short
link redirect, a 15,494-char `Location` through nginx, and the `.json` fallback for a 29,664-char link.
Network mode (schema peeking) on since 2026-09-15.

## Host

| | |
| - | - |
| Machine | `flyem1.lmb`, Ubuntu 20.04, x86_64 |
| Public name | `flyem.mrc-lmb.cam.ac.uk` (131.111.85.46 → 172.31.0.46), served by this machine's nginx |
| TLS | nginx site `catmaid`, Let's Encrypt via certbot |
| Service user | `jefferis`; `sudo` needs a password |

## Installed

| Path | |
| ---- | - |
| `~/.local/opt/node-v24.21.0-linux-x64/` | Node 24.21.0. System `/usr/bin/node` (v16) untouched |
| `~/dev/coda-mcp/` | git clone; `pnpm install --frozen-lockfile && pnpm build` → `dist/cli.js` |
| `~/dev/coda-mcp-deploy/start.sh` | launcher: environment + `exec node --env-file=…/secrets.env dist/cli.js --http --host 127.0.0.1 --port 8787` |
| `~/dev/coda-mcp-deploy/secrets.env` | `NEUPRINT_APPLICATION_CREDENTIALS`, `CODA_CAVE_TOKENS` (`{"https://global.daf-apis.com":"…"}`); mode `600` |
| `~/dev/coda-mcp-deploy/logs/coda-mcp.log` | stdout/stderr, rotated by supervisor (10 MB × 4) |
| `~/dev/coda-mcp-deploy/cache/` | downloaded Coda build |
| `/fafbz/coda/mcp/links/` | short links, one `<id>.json` each; owner `jefferis`, mode `700`. Back up |

`~` is `/home/jefferis`.

## Configuration

Set in `start.sh`; everything else is the server's default.

| Variable | Value |
| -------- | ----- |
| `CODA_MCP_PUBLIC_URL` | `https://flyem.mrc-lmb.cam.ac.uk/coda-mcp` |
| `CODA_MCP_LINK_DIR` | `/fafbz/coda/mcp/links` (overridable from the environment) |
| `CODA_MCP_CACHE` | `/home/jefferis/dev/coda-mcp-deploy/cache` |
| `CODA_MCP_NETWORK` | `1` |
| tokens | from `secrets.env` via `node --env-file` |

Defaults in effect: Coda build `https://coda.science/mcp/v1/coda.js`, re-checked every 10 min;
links kept forever; redirect ≤ 16000 chars; accepted `Host` = public host + loopback.

## supervisor

`/etc/supervisor/conf.d/coda-mcp.conf`:

```ini
[program:coda-mcp]
command=/home/jefferis/dev/coda-mcp-deploy/start.sh
user=jefferis
autostart=true
autorestart=true
stopasgroup=true
redirect_stderr=true
stdout_logfile=/home/jefferis/dev/coda-mcp-deploy/logs/coda-mcp.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
```

## nginx

`/etc/nginx/sites-available/catmaid` (backup: `catmaid.bak-2026-09-15`). Top of file, beside the
`upstream` block:

```nginx
limit_req_zone $binary_remote_addr zone=coda_mcp:10m rate=20r/s;
```

Inside `server { … }`:

```nginx
  location /coda-mcp/ {
    proxy_pass http://127.0.0.1:8787/;     # strips /coda-mcp
    proxy_http_version 1.1;
    proxy_set_header Host $host;           # server accepts flyem.mrc-lmb.cam.ac.uk only
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;                   # SSE
    proxy_read_timeout 1h;
    proxy_buffer_size 32k;                 # > redirect max, else 502
    proxy_buffers 8 32k;                   # nginx -t refuses buffer_size 32k with the defaults
    proxy_busy_buffers_size 64k;
    gzip off;
    limit_req zone=coda_mcp burst=100 nodelay;
  }
```

## Operations

All as `jefferis`, with `export PATH=~/.local/opt/node-v24.21.0-linux-x64/bin:$PATH` for `pnpm`.

| Task | Command |
| ---- | ------- |
| Status | `sudo supervisorctl status coda-mcp` |
| Logs | `tail -f ~/dev/coda-mcp-deploy/logs/coda-mcp.log` |
| Restart | `sudo supervisorctl restart coda-mcp` |
| Update server | `cd ~/dev/coda-mcp && git pull && pnpm install --frozen-lockfile && pnpm build && sudo supervisorctl restart coda-mcp` |
| Update Coda | none: deploy coda.science; new sessions use it within 10 min |
| Upgrade Node | unpack into `~/.local/opt/`, edit `PATH` in `start.sh`, rebuild, restart |
| Check from outside | `curl -sI https://flyem.mrc-lmb.cam.ac.uk/coda-mcp/w/AAAAAAAAAAAAAAAAAAAAAA` → `404` |

## Notes

- `sudo` only for supervisor, nginx and the link folder's ownership.
- `/home` is ~97% full (2.5 GB free at install); links live on `/fafbz` for that reason.
- `/mcp` is unauthenticated. Rate limit is per IP; Claude connectors share Anthropic's IPs, hence 20 r/s.
- Network mode peeks with `jefferis`'s neuPrint and CAVE tokens: every connector user sees the schemas,
  versions and table listings those accounts can see. Metadata only; nothing is queried or run.
- `secrets.env` is read by Node, not a shell: values unquoted, no `export`. `~/.bash_profile` is not
  read (supervisor starts `start.sh` without a login shell).
- Rotate a token: edit `secrets.env`, then restart.
- Restart occasionally: every Coda build with changed code stays in memory (~16 MB) until restart,
  and a restart drops open drafts.
- Short links are stored workflows; treat `/fafbz/coda/mcp/links/` as user data.
