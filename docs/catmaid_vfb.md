# Reaching a public CATMAID from a browser

Measured against `https://catmaid-fafb.virtualflybrain.org` (CATMAID
`2021.12.21.dev295+g30203a5f8`, Django 3.2-era, Python 3.9) on 2026-08-22.

Two asks, and they are independent: the first is what makes the instance reachable
from a browser at all, the second is an eightfold saving on the single largest
transfer Coda makes against it. The first is really an **upstream CATMAID** question
rather than a VFB one — every instance with anonymous browse enabled has the same
wall for the same reason — so it is written that way.

## The good news first

CORS is already correct and needs no change:

```
access-control-allow-origin: *
access-control-allow-headers: DNT,X-CustomHeader,Keep-Alive,User-Agent,
                              X-Requested-With,If-Modified-Since,Cache-Control,
                              Content-Type,X-Authorization,Authorization
access-control-allow-methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
access-control-max-age: 1728000
```

The preflight for an authenticated `POST` answers **204** with all of the above, and
`X-Authorization` is explicitly allowed. Anonymous reads are intended and permitted:
`/permissions` reports `can_browse: [1]` and `/accounts/login` reports `userid: 1`.
Every plain `GET` Coda makes works today, cross-origin, unauthenticated.

## Ask 1 — do not enforce CSRF on anonymous reads

### The wall

CATMAID's core query endpoints are `POST`-only. Checked against `/apis/` rather than
by guessing — there is no `GET` alias for any of these:

```
POST /{project_id}/skeletons/connectivity
POST /{project_id}/annotations/query-targets
POST /{project_id}/skeleton/neuronnames
POST /{project_id}/skeletons/review-status
POST /{project_id}/skeleton/connectivity_matrix
```

Anonymously, every one of them is refused. Isolating the variables:

| request | response |
| --- | --- |
| no `Referer` | `CSRF Failed: Referer checking failed - no Referer` |
| `Origin` only, no `Referer` | `CSRF Failed: Referer checking failed - no Referer` |
| `Origin` + `Referer`, both foreign | `...does not match any trusted origins` |
| `Origin` foreign, `Referer` = server | `CSRF Failed: CSRF cookie not set` |
| HTTP Basic, bogus credentials | still a CSRF error |
| `Authorization: Token <bogus>` | **`Invalid token`** |

Four things this settles:

- **`Origin` is ignored entirely** — sending it alone still reports "no Referer". That
  is Django ≤3.2 CSRF semantics; `Origin` checking landed in Django 4.0.
- **There are two sequential gates**, Referer then cookie-vs-header. Satisfying the
  first only advances the error to the second.
- **`BasicAuthentication` is not enabled** — bogus Basic credentials still produce a
  CSRF error rather than an authentication one, so Basic is not a way in.
- **Token authentication is enabled and bypasses CSRF entirely.** A bogus token is
  answered `Invalid token`, not `CSRF Failed`, so the token class runs first and the
  session class is never reached. Both `X-Authorization: Token …` and plain
  `Authorization: Token …` work.

A **browser has no route through either gate.** `Referer` is a [forbidden header
name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name), so
`fetch` cannot set it — the browser sends our own origin, which fails the trusted-origins
check. And the CSRF cookie is `SameSite=Lax`, so it is never sent on a cross-site
`fetch` at all.

None of this affects Python. pymaid sets `Referer` to the server and replays the cookie,
which is exactly why this has never come up there.

### Why `CSRF_TRUSTED_ORIGINS` is the wrong fix

It clears gate one only. Gate two would additionally need `CSRF_COOKIE_SAMESITE =
'None'` plus `Secure`, which then requires the client to use `credentials: 'include'`,
which in turn requires `Access-Control-Allow-Origin` to **echo a specific origin
instead of `*`** with `Allow-Credentials: true`.

That is three coupled changes, of which the third is a regression for every other
anonymous browser consumer of this server, and the whole set has to be repeated for
every consumer origin — a developer's `localhost`, a GitHub Pages deploy, anyone's
fork. Please do not do this.

### The change

The enforcement is an artefact rather than a policy. The `{"detail": "CSRF Failed: …"}`
shape is DRF's `SessionAuthentication.enforce_csrf`, not Django's middleware — and DRF
only reaches that line once it has resolved an **active** user. CATMAID resolves one:
guardian's anonymous user, a real active row, whose only permission here is
`can_browse`. So DRF authenticates it and dutifully enforces CSRF on it.

CSRF exists to stop a hostile page making a **state-changing** request using a victim's
**ambient credentials**. On these endpoints:

- the request is a **read** — `POST` is for id-list length, not mutation;
- the user is **anonymous**, so there are no credentials to abuse;
- the data is **already public**, served to every origin over `GET` with `ACAO: *`.

It protects nothing that `GET` does not already give away.

```python
class AnonymousCsrfExemptSessionAuthentication(SessionAuthentication):
    """Skip CSRF for the anonymous user: read-only, no privileges, already public."""

    def enforce_csrf(self, request):
        user = getattr(request._request, 'user', None)
        if user is None or user.id == settings.ANONYMOUS_USER_ID:
            return
        return super().enforce_csrf(request)
```

No allowlist, no per-origin maintenance, and nothing changes for logged-in users.

### The zero-code alternative

`manage.py drf_create_token <anonymous-user>`, published. Token auth already bypasses
CSRF, proved above, so this works from every origin immediately — including from a
static deploy. A token whose only permission is `can_browse` on a public project is not
a secret; it is a public API key, which is how most public read APIs work. The cost is
that it cannot be rotated without breaking consumers, and that it *looks* like a secret
to anyone who finds it.

### Confirmed from a real browser

Everything above was established with `curl`, which can set headers a page cannot. Driven through
headless Chrome against a dev server, from a page origin, the picture holds — and the browser
produces a *third* variant of the refusal:

| from the page | result |
| --- | --- |
| `GET https://…/projects/` direct | **200** — CORS is genuinely open for reads |
| `POST https://…/1/skeleton/neuronnames` direct | **403** `CSRF Failed: Referer checking failed - Referer is insecure while host is secure` |
| the same POST through the relay | **200**, `{"16": "Uniglomerular mALT VA6 adPN 017 DB"}` |

The third message is Django refusing an `http://localhost` Referer for an `https` host; from a
published `https` origin it becomes the "does not match any trusted origins" form instead. The
distinction does not matter — a page cannot set `Referer` at all, so it is refused whichever
branch it lands in — but it is worth knowing that the message differs between a developer's
machine and a deploy, because the two look like different problems.

### What Coda does meanwhile

`routeMemory.ts`'s try-and-remember: a token where the user has one (direct, works in
the published build), otherwise a same-origin `/cm/` dev proxy that performs the CSRF
dance server-side. The proxy works under `pnpm dev` and **404s on a static deploy**,
exactly as `/st/` does for FlyTable. So public FAFB is usable in development today and
in the published build once either change above lands.

One implementation note for anyone writing such a proxy: **the CSRF cookie name is
suffixed per instance** — `csrftoken_6666cd76f96956469e7be39d750cc7d9`, not
`csrftoken` — so the name has to be discovered from `Set-Cookie` rather than assumed.

## Ask 2 — turn on gzip

Verified: byte-identical responses with and without `Accept-Encoding: gzip, deflate,
br`, and no `Content-Encoding` header on either. **Nothing is compressed.**

```
GET /1/skeletons/16/compact-detail
  Accept-Encoding: identity          → 931,502 bytes
  Accept-Encoding: gzip, deflate, br → 931,502 bytes, no content-encoding
```

This is the largest cost in the backend by a wide margin. Skeletons here are densely
traced — 16,840 nodes for one antennal-lobe PN, 64,385 for a large descending neuron —
so a single neuron is roughly 0.9–1.3 MB, and Coda's Skeletons node is built to fetch
hundreds at a time. Everything else is small enough not to matter much: the whole
5,601-skeleton annotation index is 1.42 MB, the volume list 13 kB, one neuropil mesh
93 kB.

These payloads are highly repetitive JSON arrays of numbers and compress extremely
well; an eightfold reduction is the usual figure for this shape. For nginx:

```nginx
    gzip              on;
    gzip_types        application/json;
    gzip_min_length   1024;
    gzip_proxied      any;
    gzip_comp_level   5;
    gzip_vary         on;
```

`gzip_vary on` matters — the responses already carry `Vary: Accept, Cookie`, and adding
`Accept-Encoding` to it keeps any cache in front of the server from serving a compressed
body to a client that did not ask for one.

## Appendix: the parameter-encoding trap

Not an ask, but it belongs with the rest and it fails silently, so it is worth writing
down for the next person.

`/apis/` documents these list parameters as `skeleton_ids[]`. **That form returns only
the last id** — not an error, a short answer:

```
skeleton_ids[0]=16&skeleton_ids[1]=27&skeleton_ids[2]=717   → {"16":…, "27":…, "717":…}
skeleton_ids=16&skeleton_ids=27&skeleton_ids=717            → {"16":…, "27":…, "717":…}
skeleton_ids[]=16&skeleton_ids[]=27&skeleton_ids[]=717      → {"717":…}          ← documented form
```

Confirmed on both `/1/skeletons/summary` and `/1/skeletons/cable-length`, over `GET`
and `POST` alike, so it is the view rather than the method. Coda uses the indexed form
throughout, which is also what pymaid does.
