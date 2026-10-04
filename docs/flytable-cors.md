# Reaching FlyTable from a browser

**State on 2026-10-03:** the two seahub blocks below are in place — `/api/v2.1/workspaces/` and the
`access-token` path both answer a preflight `204, *`, and keep the header on a `403`. So Coda's
read path, and a write through `/dtable-server/` (`batch-update-rows`, preflight `204, *`), work
from the static build with no relay. SQL was the one closed endpoint, and was opened the same day
([the last section](#opening-sql-dtable-db)): verified from a real browser on `https://coda.science`
— preflight `204`, a `SELECT` against `main_test` answered 200 in 51 ms, exactly one
`Access-Control-Allow-Origin` on a 200 and on a 403, and every other `/dtable-db/` path still closed.

Measured against `https://flytable.mrc-lmb.cam.ac.uk` on 2026-08-21, after the
`app-access-token` block was added.

| endpoint | preflight | CORS on errors | who uses it |
| --- | --- | --- | --- |
| `= /api/v2.1/dtable/app-access-token/` | **204, `*`** | yes (`always`) | the base-token flow |
| `/api/v2.1/workspaces/` | 403, none | — | Coda's `listBases` |
| `/api/v2.1/workspace/{ws}/dtable/{base}/access-token/` | 403, none | — | Coda's `openBase` |
| `/dtable-server/api/v1/dtables/{uuid}/…` | **204, `*`** | yes, already | metadata and rows |

Two findings settle the shape of the problem:

- **`/dtable-server/` already sends its own CORS headers**, on success *and* on a 403.
  An earlier version of this document told you to add headers there. That was wrong and
  would have broken what works: two `Access-Control-Allow-Origin` headers on one
  response make browsers reject it. The same applies to `/dtable-db/`. Do not add
  either — the existing config comment is right.
- **An account token is refused by the opened endpoint** — `403 {"error_msg":
  "Permission denied."}`, verified. `app-access-token` takes a token minted *for one
  base*. So the block that is in place enables the documented browser flow, and Coda
  currently uses a different one.

The `*`-and-no-credentials reasoning in the config is worth restating because it is
sharper than "don't add `Allow-Credentials`": with a literal `*` a browser **refuses to
attach cookies at all**, so the session-cookie path is structurally unavailable rather
than merely unused. An echoed origin plus credentials would be exploitable, and
`SameSite=Lax` is not a backstop here because `ac.uk` is a public suffix — every
`*.cam.ac.uk` host is same-site with this server. Keep the literal `*`.

## What Coda's client does today

```
GET {host}/api/v2.1/workspaces/                                → bases, by workspace
GET {host}/api/v2.1/workspace/{ws}/dtable/{base}/access-token/ → JWT + uuid + dtable_server
GET {dtable_server}/api/v1/dtables/{uuid}/metadata/            → tables and columns
GET {dtable_server}/api/v1/dtables/{uuid}/rows/?table_name=…   → the rows
```

The first two are seahub and are closed; the last two already work. So one of the two
has to give.

## The change: open the two seahub endpoints Coda calls

Both blocks mirror the `app-access-token` one exactly, including the literal `*` and
the absence of `Allow-Credentials`, for the reason recorded there. `always` matters on
both: without it nginx drops the header on a 4xx, the browser will not let the page
read the status, and a rejected token becomes an unexplained network error instead of
"your token was rejected" — which is the channel Coda uses to open the Connections
panel on the right tab.

```nginx
    # -----------------------------------------------------------------------
    # CORS: account-token endpoints used by Coda
    #
    # WHY THESE TWO: Coda authenticates with an *account* token rather than a
    # base API token, so it never calls app-access-token above (that endpoint
    # answers "Permission denied" to an account token - verified). It lists the
    # account's bases, then mints a base JWT for one of them, then reads through
    # /dtable-server/, which already sends its own CORS headers.
    #
    # WHY EXACT (=) AND ANCHORED REGEX, not a /api/ prefix: a prefix would
    # expose all of seahub's v2.1 API - user info, sharing, admin. These two are
    # pinned to exactly the paths the client calls.
    #
    # WHY "*" AND NO Allow-Credentials: same reasoning as app-access-token
    # above - these endpoints also accept the Django session cookie, and a
    # literal "*" makes browsers refuse to attach cookies at all, so only the
    # Authorization: Token <account-token> path works. Do not swap for an echoed
    # origin.
    #
    # WHY "always": without it nginx drops the header on 4xx/5xx and the client
    # cannot read the status, so a rejected token looks like a dead host.
    #
    # DO NOT add CORS to /dtable-server/ or /dtable-db/ - they emit their own,
    # and two Access-Control-Allow-Origin headers make browsers reject every
    # response.
    # -----------------------------------------------------------------------
    location = /api/v2.1/workspaces/ {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  "*"                          always;
            add_header Access-Control-Allow-Methods "GET, OPTIONS"                always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
            add_header Access-Control-Max-Age       600                           always;
            add_header Content-Type   "text/plain; charset=utf-8";
            add_header Content-Length 0;
            return 204;
        }

        add_header Access-Control-Allow-Origin "*" always;

        proxy_pass http://localhost:8010;
        proxy_set_header Host $host;
    }

    location ~ ^/api/v2\.1/workspace/[^/]+/dtable/[^/]+/access-token/$ {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  "*"                          always;
            add_header Access-Control-Allow-Methods "GET, OPTIONS"                always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
            add_header Access-Control-Max-Age       600                           always;
            add_header Content-Type   "text/plain; charset=utf-8";
            add_header Content-Length 0;
            return 204;
        }

        add_header Access-Control-Allow-Origin "*" always;

        proxy_pass http://localhost:8010;
        proxy_set_header Host $host;
    }
```

Three notes on the placement, since nginx's matching rules decide whether these are
reached at all:

- **The regex is anchored at both ends** (`^…$`). Unanchored it would also match
  anything with that shape as a *substring* of a longer path.
- **Regex locations beat the `location /` catch-all** but lose to an exact `=` match,
  so this sits correctly alongside the `app-access-token` block whichever order they
  appear in. Between two regex locations order does matter; there is only one here.
- **The base name is percent-encoded by the client**, so `[^/]+` covers a base with a
  space or punctuation in its name. A base name containing a literal `/` is the one
  case this would not match, and no base here has one.

## The alternative, not taken

Coda could instead use the `app-access-token` endpoint already open, with a per-base
token — no nginx change, a smaller blast radius, and it would work on the static build
today. It was declined because it costs one token per base and the node's base listing,
and because opening these two keeps a single account token reaching everything, which
is what the Connections panel is built around. Recorded here because the trade is real
and may look different later: `cloud.seatable.io` opens `app-access-token` identically,
so that path would be one code path for both deployments.

## What Coda does meanwhile

The client tries the deployment directly, falls back to a same-origin relay served by
`vite.config.ts` (`/st/<encoded-origin>/<path>`), and remembers which answered.
Verified in a real browser: direct throws `TypeError: Failed to fetch`, the relay
returns the data, and `listBases` and `readMetadata` both complete.

That relay only exists under `pnpm dev` and `pnpm preview`. A static deploy serves
nothing at that path, which is why one of the options above is worth doing.

## Checking a change

```bash
# Preflight: 204, with the three headers, carrying no token.
curl -i -X OPTIONS -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  https://flytable.mrc-lmb.cam.ac.uk/api/v2.1/workspaces/

# The header must survive an error, or a browser cannot read the status and a
# rejected token is indistinguishable from an unreachable host.
curl -i -H 'Origin: http://localhost:5173' \
  https://flytable.mrc-lmb.cam.ac.uk/api/v2.1/workspaces/

# And exactly one Access-Control-Allow-Origin, never two.
curl -si -H 'Origin: http://localhost:5173' \
  https://flytable.mrc-lmb.cam.ac.uk/dtable-server/api/v1/dtables/x/metadata/ \
  | grep -ci access-control-allow-origin
```

## Opening SQL (`/dtable-db/`)

Measured 2026-10-03 against a scratch copy of FlyWire's `main.info` (`main_test.info_test`), with
`SELECT _id, root_783, cell_type, super_class … WHERE root_783 IN (…)`:

| ids | rows | bytes | time |
| --- | --- | --- | --- |
| 10 | 15 | 2 kB | 0.08 s |
| 100 | 118 | 14 kB | 0.13 s |
| 1,000 | 1,451 | 155 kB | 0.71 s |

Against that, `filtered-rows` took 1.6–2.7 s for 10–100 ids and 12.9 s for 1,000, returns every
column, and **cannot be called from a browser at all**: it takes its filters only as a JSON body
on a GET (`400 filters required` as query parameters, `404 Cannot POST`), and browsers refuse a
body on a GET. The whole-table read is ~79 MB in ~20 s. So SQL is what makes a per-selection read
— the annotation editor's — possible on FlyTable.

What blocks it is the opposite of the warning above: **`/dtable-db/api/v1/query/` sends no CORS
header** on a 200, and its preflight answers `405`. The earlier note that `/dtable-db/` "emits its
own" held for whatever was checked then and not for this path.

The host proxy has **no `/dtable-db/` block** — everything not pinned falls through to `location /`
and on to SeaTable's own nginx inside the container (whose edits are wiped on upgrade). So the
change is one more pinned block in the host config, beside the access-token one, and
`proxy_hide_header` makes it set exactly one header whether or not a later SeaTable version starts
sending its own:

```nginx
    location ~ ^/dtable-db/api/v1/query/[^/]+/$ {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  "*"                          always;
            add_header Access-Control-Allow-Methods "POST, OPTIONS"               always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
            add_header Access-Control-Max-Age       600                           always;
            add_header Content-Type   "text/plain; charset=utf-8";
            add_header Content-Length 0;
            return 204;
        }

        proxy_hide_header Access-Control-Allow-Origin;
        add_header Access-Control-Allow-Origin "*" always;

        proxy_pass http://localhost:8010;
        proxy_set_header Host $host;
    }
```

The existing comment saying not to add CORS to `/dtable-db/` should be narrowed to `/dtable-server/`
in the same edit, or the next reader removes this block on its authority.

Three things to check when applying it:

- **`add_header` in a block stops inheritance** of every `add_header` from the enclosing
  `server` block. FlyTable's sets none today; if HSTS or `X-Frame-Options` is ever added there,
  repeat it in this block or it silently disappears from query responses.
- **Same posture as `/dtable-server/`**: a literal `*`, no `Allow-Credentials`, and every call
  carries the base JWT — so this exposes nothing a browser holding a token could not already read
  through the rows endpoint, only faster and narrower.
- **Verify**: the preflight returns 204 with the headers, a real query response carries exactly
  one `Access-Control-Allow-Origin`, and a 401 keeps it:

```bash
curl -i -X OPTIONS -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  https://flytable.mrc-lmb.cam.ac.uk/dtable-db/api/v1/query/x/

curl -si -X POST -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT 1"}' https://flytable.mrc-lmb.cam.ac.uk/dtable-db/api/v1/query/x/ \
  | grep -ci access-control-allow-origin    # 1, on the 401 too
```
