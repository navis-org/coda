# The MCP server

People asked to build Coda workflows with their own LLM rather than the in-app assistant. The
answer is [`navis-org/coda-mcp`](https://github.com/navis-org/coda-mcp), an MCP server in its own
repository, plus **one file in this one**: `dist/mcp/v1/coda.js`, built from `src/mcp/index.ts` by
`vite.mcp.config.ts` and deployed with the site. This document is the seam between the two.

## Where it is advertised

`mcp.html` is the user-facing page (`docs/pages.md` has its construction), and six surfaces point
at it in one sentence each: `README.md`, `index.html`'s `<noscript>` list, the overview page's AI
section, `?` ▸ Documentation, the assistant drawer's empty state, and the Connections dialog's
**AI assistant** tab — where it is the *first* thing the band says, the two routes being a choice
and only one of them needing the key field below (`docs/ui-shell.md`). The rule those follow is
that **the page carries the endpoint and they carry none of it**: a hostname in an in-app note is
a hostname that outlives the deployment it names, and none of them can carry the per-client setup
anyway. The single exception is `llms.txt`, which exists so a model need not fetch a second
document — [seo.md](seo.md) argues it, and a test holds the two spellings together.

## Being found at all, which is not this repository's problem to fix

Worth stating because the work above looks like discoverability and mostly is not. Measured in
September 2026: the endpoint is reachable, unauthenticated and works; and **nothing points at it**.
`navis-org/coda-mcp` does not appear in a web search naming this project, the official MCP registry
holds no connectome server of any kind, there is no `.well-known` discovery on the host, and the
repository has no topics and no homepage. Every surface listed above is read by somebody who has
already found *Coda*; none of them is read by somebody who has an MCP client and a question.

The three things that would change that are all outside this repository, in rough order of effect:
publishing to the [official registry](https://registry.modelcontextprotocol.io) (which is what the
client directories index in turn), giving the server repository a description and topics naming
connectomics rather than "the MCP server for coda.science", and listing it in the third-party
directories. `seo.md` records the naming half of the same problem: "Coda MCP" is Coda.io's phrase
and this project will not win it. The rule those four follow is
that **the page carries the endpoint and they carry none of it** — a hostname in an in-app note is
a hostname that outlives the deployment it names, and none of those surfaces can carry the
per-client setup anyway.

## What each side owns

**This repository owns every fact about Coda.** The node catalogue, the plan format and its
applier, the graph listing the assistant is shown, edit-time checking, the `.coda.json` loader and
the share-link encoder are all re-exported from `src/mcp/index.ts` — the same functions the app
and the in-app assistant call. A node added next month reaches every installed server on the next
deploy, with nobody touching the other repository.

**The server owns everything that is not a fact about Coda**: the MCP transports, the tool definitions
and their wording, a draft graph and an undo history per session, short links, downloading and
caching the build, and the environment variables.

**Hosted is the primary path, and that was decided on friction.** A local server means installing
Node, editing a client's config and restarting it, and browser chat apps cannot launch one at all —
where a hosted one is a URL pasted into a connector setting. Every step of setup loses users. The
server still serves stdio, for development and for anyone who launches it themselves, but nothing
user-facing is built around it.

The test for which side something belongs on: if a change to a node could make it wrong, it
belongs here.

## Why the server downloads the build rather than depending on a package

Measured against the goal, which is that nobody has to babysit a second project:

- **An npm package of Coda's headless core** is the conventional answer. It adds a versioned
  release to this repository, and every installed server keeps whichever version it was built with
  — so it writes links naming node types and ports the live app has since renamed. Params and port
  groups migrate on load (`formerId`, `formerIds`); a renamed node **type** is dropped.
- **A git submodule built by the server** needs no publishing and freezes the server at a commit
  in exactly the same way.
- **Serving the build beside the app** makes every deploy update it, so a server checks graphs
  against the definitions the app it links to will load. What it costs is below.

The costs of the chosen shape, stated so they are not rediscovered:

- **The server executes code it downloads.** From this domain, over HTTPS — the trust already
  extended by `npx`. A checksum beside the file would be the next step if that is not enough.
- **A first run needs a network.** The server caches the file and falls back to the cache, saying
  it may be stale.
- **The exports are a public interface** with consumers this repository cannot see. Hence the
  version in the path and the contract test.

## The contract

| Export | What it is |
| ------ | ---------- |
| `CONTRACT_VERSION`, `APP_VERSION`, `BUILD_ID` | `1`; package.json's version, which does **not** change between deploys; the commit, with `-dirty` for a modified tree |
| `guide(detail)` | the plan rules framed for a model working through tools, then the catalogue (`buildSystemPrompt(detail, 'mcp')`) |
| `nodeTypeIds()` | every type a plan may name |
| `nodeEntry(type, detail)`, `nodeHelp(type)` | one node's catalogue entry (`full` by default); its `?` document as markdown |
| `planSchema()`, `parsePlan(text)` | the plan's JSON Schema; the lenient reader that normalises a model's reply |
| `newGraph(name)`, `applyPlan(graph, plan)` | an empty graph; the atomic applier with its warnings |
| `describe(graph)` | the graph listing the assistant is shown (`describeGraph`) |
| `check(graph)` | every edit-time issue on every node, with `aboutColumns` carried |
| `toJson(graph)` | a `.coda.json` document |
| `shareLink(graph, siteUrl)` | a packed `#!c1.` link |
| `setCredentials({ neuprint, cave })` | tokens held in memory, for the opt-in network mode |

Five rules:

1. **Re-exports only.** Anything here that is not a one-line call into the app is a second
   implementation that will drift from the first. `check` is `collectWarnings` unscoped — the loop
   the plan applier already runs — because its first version was a loop of its own and had already
   named a card differently from the plan's warnings (`||` against `??` on an empty title).
2. **Adding an export is not a breaking change; removing, renaming or reshaping one is** — so nothing
   is exported ahead of a caller (`catalogue`, `fromJson` and `onSourceLearned` were, and went). A
   breaking change goes in a `v2` directory, and `v1` stays served until the server's releases have
   moved — an installed server asks for the major it was built against.
3. **`src/mcp/contract.test.ts` pins the names and a round trip**, offline: a plan on the synthetic
   dataset applied, checked, described and packed into a link that decodes back to the same nodes.
   This is the half that catches a rename at the moment it is made. The other half is a scheduled
   smoke run in the server's repository against the *deployed* file, which catches this side moving
   under an installed server.
4. **A type id may carry a colon.** A pack's node is `pack:name` (`zapbench:traces`), so
   `nodeTypeIds()` returns ids a check written against `family.name` refuses — the server must take
   the app's ids as given. The three ZapBench types were renamed from `zapbench.*`; `nodeEntry`,
   `nodeHelp` and a plan's `add` read a former id as its successor (`liveType`), and an open draft
   never meets the rename, keeping the build it started on. `nodeEntry('core.missing')` answers
   nothing: the placeholder is not a node a plan can name.
5. **`src/mcp` is in the headless lint boundary.** The file runs in Node, so a UI import would build
   green and throw on load in somebody else's process.

## Offline by default, and why that is not optional

**Asking the build for its catalogue makes requests; importing it does not.** This was recorded the
other way round first. Measured with `fetch` logged: the import fires nothing, and the first
`guide()` fires five — Virtual Fly Brain's token manifest, two CATMAID project listings, and the same
two again under `/cm/`, a relative path Node cannot fetch at all. The cause is `producedColumns` in
`catalogue.ts`, which renders a `carries:` line by inferring each node type on a one-node graph, and
a CATMAID dataset node's inference starts a project listing. **The same five leave the browser the
first time the in-app assistant builds its prompt**, and describing a node *type* has no business
fetching; that is an app-side fix, recorded here rather than made. Beyond the catalogue, inference on
a dataset node *peeks*, starting the listing it cannot yet answer — so a checker that ran inference
freely would put traffic on shared production servers from every LLM session that touched a dataset
node, the trap `wizard/demo.ts` hit when scoring on a click.

So the server replaces `fetch` before anything calls into the build, keeping the real one for its own
download. `fetch` is the right depth rather than a switch in this entry: nine-plus call sites across
the CAVE, CATMAID and listing code start requests, and `fetch` is the one thing they share. Offline, a
real dataset node reports its columns as unknown, which `inferOutputs` already degrades to (invariant
2), and the synthetic dataset answers everything.

The opt-in (`CODA_MCP_NETWORK=1`, tokens by environment) lets the peeks through, and then a check has
to wait for what it started. The server's `fetch` wrapper counts requests in flight until each body
has arrived, and a check is repeated each time they drain — an arrival can make the next question
askable, a dataset's schema once its id resolves — until one starts nothing, or eight seconds pass.
The first version was a quiet timer on `reportSourceLearned`, which charged 750 ms to every call with
nothing pending and could return before a slower listing had arrived at all.

`setCredentials` needs no special path: `localStore.ts` already swallows the missing `window`, so
a token set in Node is held in memory for the process.

## What a link from the server looks like

**Cards are placed.** `applyPlan` positions what it adds (`positionsFor`), so a graph built entirely
through plans does not arrive stacked at the origin — the failure a hand-written graph JSON would
have, since opening a link runs no layout pass. The three-node contract plan lands at x = 60, 398
and 848 and packs to a **525-character** link.

**Opening it runs nothing expensive** — `docs/persistence.md` records why that is a property of
share links rather than a promise, and it holds identically for a link a model wrote.

## Picking up a new deploy

**A hosted server runs for days, so it re-asks every ten minutes** (`CODA_MCP_REFRESH_MINUTES`) and
gives a newer build to **new sessions only**. An open draft keeps the build it was started against:
moving it would re-check a draft against different definitions mid-conversation, with the model's
picture of the catalogue still the old one. A stdio server needs none of this, its client relaunching
it about once per conversation.

Four things the obvious version gets wrong:

- **`APP_VERSION` cannot tell two deploys apart**, being package.json's and set by hand. `BUILD_ID`
  is for people and logs; the server identifies a build by a SHA-256 of the file's bytes, which needs
  nothing from this side to be right.
- **So nothing in the file may change with every commit.** `BUILD_ID` was `HEAD` first, which made
  the bytes differ on every deploy — a docs-only push included — and a long-running server imported
  another copy of identical code each time, measured at ~16 MB of RSS a copy against about ten deploys
  a day. It is now the latest commit that changed a file Rollup actually bundled, filled in after
  bundling (`renderChunk`), so it moves when the code does.
- **Node caches a module by URL**, so importing the refreshed file at its old path hands back the
  old build. The server imports it with a query naming the digest.
- **A module cannot be unloaded**, so every build a long-lived process has loaded stays in memory,
  bounded by the number of deploys during the process's life and paid back by an occasional
  restart. Running the file in a worker thread would free it at the cost of an async boundary on
  every call. This note used to say that was the right shape "if an instance is ever hosted", and
  hosting is now the primary path — so the condition has arrived, and the worker is not built yet.
  Until it is, **restart a hosted instance now and then**, at a quiet hour, since a restart also
  drops the drafts open in it.

Each loaded copy also has its own credential store, so the server applies tokens to a refreshed build
before any session sees it.

## Short links

**A packed link is the wrong thing to hand a model.** A person copies it; a model retypes it,
character by character, from the tool result into its reply, and base64 is exactly the text one
wrong character makes unreadable. A three-node workflow is 525 characters, the old bundled examples
1,500–2,000, a 10,000-neuron selection ~56,000. So a hosted server stores the draft and returns
`https://<host>/w/<id>`, and it is the server's feature rather than Coda's, because Coda has no
server to put one on. Six decisions:

- **The id is 22 base64url characters of SHA-256 over the draft**, so asking twice is one entry and
  an id cannot be guessed without the workflow. Over the draft object, not the `.coda.json`:
  `serializeGraph` stamps `modifiedAt` on every call, so a hash of its output never repeats.
- **`/w/<id>` redirects to the packed link, encoded when it is opened.** A browser keeps the fragment
  through a redirect, so Coda opens it exactly as a link it made — no prompt, no cross-origin read, and
  nothing in this repository changed. What is stored is the `.coda.json`, which both routes serve;
  the redirect packs it on each open, measured at under 10 ms for a draft carrying 20,000 ids. Nothing
  is migrated on the server — the browser's loader does that on arrival, as it does for any link.
- **Past `CODA_MCP_REDIRECT_MAX_CHARS` (16,000) it redirects to `#!https://<host>/w/<id>.json`
  instead.** nginx reads an upstream's response headers into `proxy_buffer_size`, one memory page by
  default, and answers 502 ("upstream sent too big header") when they do not fit — nginx's documented
  behaviour, not measured here, and worth checking on the real proxy before relying on it. The
  server's nginx block raises the buffer to 32k and the threshold sits under it. The JSON form goes
  through `fetchText`, which sends no credentials and needs only an `Access-Control-Allow-Origin`
  header — and Coda asks the recipient first, since a bare `https://` hides where it goes. That
  prompt is correct, and it is why this form is the fallback.
- **Kept forever unless a retention is set**, and opening a link counts as use. A packed link cannot
  rot; a short one dies with the server's directory.
- **The redirect carries `?ref=coda-mcp`**, which is the only way an open through the server is
  countable. A browser carries the referrer of the *original* navigation through a 302, so the
  server's own host never reaches the site's analytics, and a link clicked in a chat client or a
  terminal arrives with no referrer at all — identical to a pasted one. GoatCounter reads `ref` in
  place of the HTTP referrer, the marker goes before the fragment (which is the workflow), and
  nothing in Coda reads `location.search`, so it is inert here. `CODA_MCP_REFERRER_MARK` is the
  server's setting for it, and `full_link` — which reaches no server — carries no marker at all.
  See [docs/analytics.md](analytics.md).
- **The threshold is a stopgap, and the fix belongs in this repository.** The prompt on the JSON form
  exists because a bare `https://` names a host nobody has heard of, and the hosted server is not
  that. Once its domain is chosen, trusting it in `resolve.ts`'s `shareTarget` — a host list, or a
  named scheme beside `gh://` — lets `/w/<id>` always redirect to the fixed-length JSON form, and the
  threshold, the nginx buffer setting and the per-open packing all go. Not done yet only because
  there is no domain to trust.

## Numbers, measured on the first build

- `coda.js`: **2.46 MB**, **625 kB gzipped**, one file (`inlineDynamicImports`)
- import in Node 26: **47 ms**
- `guide('lean')`: 68,033 characters; `guide('full')`: 133,052
- 109 listable node types

## Traps

- **Under stdio, stdout is the protocol.** Anything the bundle writes with `console.log` corrupts
  the stream, so the server points `console.log` at stderr before import.
- **The SSR build does not emit assets.** The Draco decoder's `?url` wasm is referenced and not
  written, so decoding a mesh would fail. Nothing in authoring decodes one; `build.ssrEmitAssets` is
  the switch if a future export needs it.
- **A hosted instance receives every workflow built through it** — the property share links were
  designed to avoid (`docs/persistence.md`) — and stores each one behind a short link. That was
  accepted on purpose, for the friction above, and the server's README says so to its users. The
  `full_link` option is the way out for anyone who wants nothing stored: the packed link, which
  never reaches a server.

## Deliberately not built

- **Running a workflow.** The server authors and checks; results need the app, a browser and, for
  most datasets, a person's own token.
- **Loading an existing graph or share link into a draft.** It needs `deserializeGraph` in the
  contract, which is an additive export. It would not bring run results with it — a file or a link
  carries the graph, not a session — so the guide's missing `ran:` rules stay right. Those come back
  (`RUN_RULES` in the `mcp` assembly, `catalogue.ts`) only if the server ever runs or previews nodes.
- **Wizard starters.** `buildWorkflow` would be a strong first step for a complex request, and adding
  it is an additive export.
- **Open-in-browser and save-to-file tools.** They were the answer to long links for a *local*
  server, and hosting made them moot: a hosted server cannot open anybody's browser, and short links
  answer the length.
