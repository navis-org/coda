# Reaching a public CATMAID from a browser

Measured against `https://catmaid-fafb.virtualflybrain.org` (CATMAID
`2021.12.21.dev295+g30203a5f8`, Django 3.2-era, Python 3.9) on 2026-08-22.

VFB's larval instance, `https://l1em.catmaid.virtualflybrain.org`, reports the **same build**
and was re-checked on 2026-08-27: anonymous `GET` 200, anonymous `POST` 403, no
`content-encoding` on a 449 kB skeleton. Both asks below are one deployment's, not one host's.

**Ask 1 was answered on 2026-08-29**, by the zero-code route below: VFB published an
anonymous-user API token for every instance they host, at
<https://virtualflybrain.org/data/EM/catmaid.json>. What Coda does with it is
[the last section](#what-coda-does-now); the rest of this document is kept as written,
because it is the evidence that the token is the *only* route and the argument is still
live for every other CATMAID with anonymous browse enabled. Ask 2 is still open.

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

### Where the token goes in Coda

`Connections ▸ Data sources ▸ CATMAID` is a list of instances rather than a single field, because
a CATMAID token is per user *and* per instance. Each row is a host — or a host pattern, so
`*.virtualflybrain.org` covers a whole deployment — plus a token, plus an optional HTTP basic user
and password for an instance behind web-server auth. Those last two are sent on `Authorization`
while the token is sent on `X-Authorization`, which is exactly the separation CATMAID's own
middleware describes, so both fit on one request.

So if a public token is minted for the anonymous user, a reader pastes it into one row and the
published build reaches the instance directly, with the relay below demoted to a fallback.

### One more gate, found while checking whether the handshake could be done in the page

Worth recording because it rules out the obvious "just do what curl does" fix, and because
it is invisible from the server side. Asked for a preflight with `X-CSRFToken`, the server
answers **204 with a static allow-list that does not contain it**:

```
Access-Control-Request-Headers: content-type,x-csrftoken
→ access-control-allow-headers: DNT,X-CustomHeader,Keep-Alive,User-Agent,X-Requested-With,
    If-Modified-Since,Cache-Control,Content-Type,X-Authorization,Authorization
```

The server never checks the requested headers, so it looks like a pass; the *browser*
compares and refuses to send. Driven from a page, the whole handshake fails four separate
ways, each with a different cause:

| from a browser page | result |
| --- | --- |
| `GET /` with `credentials: 'include'` | **Failed to fetch** — `ACAO: *` is invalid with credentials |
| read `Set-Cookie` off the response | **`null`** — a [forbidden response header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_response_header_name); visible headers are `cache-control, content-type` |
| `document.cookie` | **`""`** — another origin's cookies are not readable |
| `POST` + `X-CSRFToken` | **Failed to fetch** — preflight, per the allow-list above |
| `POST` with `csrfmiddlewaretoken` as a *form field* | **403** `Referer checking failed` — dodges the preflight, dies at gate one |

So there is no arrangement of headers that gets a page through, and in particular the
double-submit has nothing to submit: the page can never learn the token's value. Server-side
clients — `curl`, pymaid, GitHub Actions, Coda's own `/cm/` relay — pass trivially, which is
why this reads as a non-problem from everywhere except a browser.

### What Coda does now

The published tokens are a committed table in `src/data/catmaid/publicTokens.ts`, refreshed
from the manifest in the background. Two layers because each covers the other's failure: the
snapshot answers synchronously, offline, and in a unit test, and it is what keeps this from
being a network dependency; the refresh is what survives a rotation without a Coda release.

Five things the implementation is careful about, three of which would fail silently:

- **A published token loses to a user's own.** Somebody with a real VFB account has more than
  `can_browse`, and substituting the anonymous token would hide their own data with nothing on
  screen to say why. `client.ts` consults the table only where `credentialsFor` gave no token.
- **A rotated token falls back rather than raising.** The request loop stops at the first
  response it gets, so a `401 Invalid token` would otherwise be *worse* than never having
  shipped a token — it would fail where an anonymous `GET` used to work. A second pass drops
  the token and re-derives the routes, which is exactly the behaviour of the day before.
  A token the *user* configured is never dropped: that 401 really is about their credential.
- **The refresh starts from the request that uses a token**, not from the app entry. That is a
  privacy decision as much as a plumbing one: a reader who never opens a CATMAID node should not
  have their browser announce itself to virtualflybrain.org, and one who does is already talking
  to that host. It also keeps the unit suite off the network — anything reaching that line has
  stubbed `fetch` already.
- **The manifest is fetched `cache: 'no-cache'`**, because it is served
  `cache-control: max-age=31536000, immutable`. Left to the default the refresh would run once
  per browser and then never again — the exact failure it exists to prevent, presenting as the
  feature working.
- **FAFB answers on two hostnames.** `DEFAULT_CATMAID_SERVER` is
  `catmaid-fafb.virtualflybrain.org` and the manifest lists `fafb.catmaid.virtualflybrain.org`
  — one deployment, identical `/projects/`, one token — but `catmaidSourceId` hands out the
  bare `catmaid` id for that exact string, so the constant cannot move without re-keying every
  saved graph. The alias is written down instead.

The `/cm/` relay stays for what it was always for: a lab CATMAID that publishes no token, where
a POST still has no other route under `pnpm dev`. It is no longer on the path for VFB.

Measured on 2026-08-29: all eight instances answer `POST /{project}/skeleton/neuronnames` 200
with their token and 403 `CSRF Failed` without it, from a page at a foreign origin; and
`CATMAID_LIVE=1 pnpm vitest run src/data/catmaid/live.test.ts` passes 7/7 **with no token in
the environment**, where two of those tests previously skipped.

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
