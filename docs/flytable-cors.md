# Enabling CORS on FlyTable

FlyTable is currently unreachable from a browser. Measured against
`https://flytable.mrc-lmb.cam.ac.uk` on 2026-08-21:

```
OPTIONS /api/v2.1/workspaces/       → 403, no Access-Control-* headers at all
GET     /api/v2.1/workspaces/       → 403, no Access-Control-* headers at all
```

The absence is unconditional — four different `Origin` values were tried
(`flytable.mrc-lmb.cam.ac.uk`, `cloud.seatable.io`, `localhost:3000`,
`philippschlegel.github.io`) and none produced a single `Access-Control-*` header, so
it is a missing configuration rather than an allowlist that we are not on. The same
API answers a non-browser client perfectly with the same token, which is what makes
this a browser problem and not a credential one.

For comparison, `cloud.seatable.io` — the hosted deployment of the same software —
answers the same preflight:

```
HTTP/2 204
access-control-allow-origin: *
access-control-allow-headers: Content-Type, Accept, authorization, token, deviceType, x-seafile-otp
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-max-age: 7200
```

## The four things that have to be true

Each of these fails on its own, and three of them fail *silently* — the browser
reports the same opaque "Failed to fetch" whichever one is missing.

1. **The preflight must succeed before authentication runs.** A browser sends
   `OPTIONS` with **no** `Authorization` header, so it currently reaches Django and
   comes back `403 {"detail":"Authentication credentials were not provided."}`. nginx
   has to answer `OPTIONS` itself, with the headers, and never proxy it.

2. **`Authorization` must be in `Access-Control-Allow-Headers`.** It is not a
   safelisted header, so without it the preflight is refused even when it returns 200.

3. **The headers must be on _every_ response, including 401, 403, 404 and 5xx.** This
   is the one most configurations get wrong. A browser only lets a page read a
   response's *status* if that response itself carries `Access-Control-Allow-Origin` —
   so without `always`, a rejected token surfaces as an unexplained network error
   rather than as "your token was rejected", and the app cannot tell you which it was.

4. **It must be repeated per location block.** nginx's `add_header` does not inherit
   into a `location` that has any `add_header` of its own, and SeaTable serves the API
   from four separate prefixes. Hence the `include` file below rather than four copies.

## The configuration

Create `/etc/nginx/snippets/coda-cors.conf`:

```nginx
# CORS for API clients. `always` is required: without it these are omitted from 4xx
# and 5xx responses, and a browser then cannot read the status — so a rejected token
# is indistinguishable from an unreachable host.
add_header Access-Control-Allow-Origin  $cors_origin always;
add_header Access-Control-Allow-Headers 'Authorization, Content-Type, Accept' always;
add_header Access-Control-Allow-Methods 'GET, POST, PUT, DELETE, OPTIONS' always;
add_header Access-Control-Max-Age       7200 always;
add_header Vary                         Origin always;

# The preflight carries no credentials, so it must be answered here rather than
# proxied — Django replies 403 to an unauthenticated OPTIONS.
if ($request_method = OPTIONS) {
    return 204;
}
```

In the `http { }` block (e.g. `/etc/nginx/nginx.conf`), decide which origins may read:

```nginx
# Option A — any origin. This is what cloud.seatable.io does. Safe in the sense that
# FlyTable takes no cookies: a request is only authorised by an account token, which a
# third-party page does not have and cannot obtain from this header.
map $http_origin $cors_origin { default "*"; }
```

```nginx
# Option B — an allowlist, if you would rather. Must echo the origin rather than list
# them, since the header takes a single value. An unlisted origin gets an empty value,
# which nginx omits, and the browser then refuses — the current behaviour.
map $http_origin $cors_origin {
    default                             "";
    "~^https://.*\.mrc-lmb\.cam\.ac\.uk$" $http_origin;
    "https://<your-github-user>.github.io" $http_origin;
    "~^http://localhost:[0-9]+$"          $http_origin;   # local development
}
```

Then include the snippet in each API location of the FlyTable server block:

```nginx
location /api/           { include snippets/coda-cors.conf; ... existing proxy_pass ... }
location /api2/          { include snippets/coda-cors.conf; ... existing proxy_pass ... }
location /dtable-server/ { include snippets/coda-cors.conf; ... existing proxy_pass ... }
location /dtable-db/     { include snippets/coda-cors.conf; ... existing proxy_pass ... }
```

`/api/` and `/dtable-server/` are the two Coda needs today — workspaces and the base
access token come from the first, metadata and rows from the second. `/api2/` and
`/dtable-db/` are included so a future client is not a second config change.

**Do not add `Access-Control-Allow-Credentials: true` alongside Option A.** A browser
rejects `Allow-Origin: *` on a credentialed request, so the pair silently breaks the
case it looks like it enables. Coda sends no cookies and does not need it.

## Checking it

```bash
# 1. Preflight must be 204 (or 200) and carry the three headers, with no token.
curl -i -X OPTIONS \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  https://flytable.mrc-lmb.cam.ac.uk/api/v2.1/workspaces/

# 2. The headers must survive an *error*. This is the one that is easy to miss:
#    it should be 403 AND carry access-control-allow-origin.
curl -i -H 'Origin: http://localhost:5173' \
  https://flytable.mrc-lmb.cam.ac.uk/api/v2.1/workspaces/

# 3. And on the second host prefix.
curl -i -X OPTIONS -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  https://flytable.mrc-lmb.cam.ac.uk/dtable-server/api/v1/dtables/x/metadata/
```

## What Coda does meanwhile

Nothing here is required for Coda to work in development: the client tries the
deployment directly, and falls back to a same-origin relay served by `vite.config.ts`
(`/st/<encoded-origin>/<path>`), remembering which one answered. Verified in a real
browser — direct throws `TypeError: Failed to fetch`, the relay returns the data.

What the relay cannot do is work on a **static deploy**: GitHub Pages serves nothing
at that path, so FlyTable is unreachable from the published build until the headers
above exist. That is the same position neuPrint was in before Janelia enabled CORS on
`neuprint-test.janelia.org`, and the reason this is worth doing rather than working
around.

The direct route is tried first, so once the headers are in place Coda uses them with
no change and no setting — the relay simply stops being reached.
