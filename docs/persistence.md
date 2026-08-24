# Persistence and sharing

Share links, the autosave across tabs, and the browser shelf.

Moved verbatim out of `CLAUDE.md`.


## Sharing a workflow

The **⧉ icon in the toolbar**, or the palette's `Graph ▸ Share Workflow…`: a link that opens
this graph. Neuroglancer's model, which is what makes a neuroglancer view mailable with no server
anywhere — the state goes after `#!`, and a fragment is the one part of a URL a browser never
sends to anybody.

**Two destinations, and the ordering is the design.** _In the link_ packs the graph into the
fragment itself; _GitHub Gist_ uploads it and leaves a forty-character link. The packed form is
the default and is strictly better right up to the point where it stops fitting: it cannot rot,
cannot be deleted by its author, needs no account and works for a recipient who has never heard
of any of this.

The numbers are what settle it. Measured across the five bundled examples, **deflate + base64url
is 1,540–2,004 characters** against 4,282–4,786 for the same graph as literal JSON — 2.8×, and
the difference between a workflow that pastes anywhere and one that does not. The case that
genuinely needs the gist is an Explore Dataset select-all: 10,000 neuron ids pack to **~56,000**, which
mail and chat clients cut short.

### The grammar

`#!` and one payload, dispatched on what it starts with:

| payload                | means                                            |
| ---------------------- | ------------------------------------------------ |
| `{…}`                  | the graph as literal JSON, percent-decoded first |
| `c1.<base64url>`       | deflate-raw of the minified JSON, format 1       |
| `gh://<user>/<gistId>` | a GitHub Gist, optionally `@<revision>`          |
| `gs://<bucket>/<path>` | an object on Google Cloud Storage                |
| `https://…`            | any JSON over https                              |

Coda writes the second and third and reads all five. **The literal form is kept because a link
you can read before opening is worth 2.8×** — it is what lets the docs print one, what makes a
hand-edited link work, and what the AI assistant would emit. Decoding is attempted and its
failure _ignored_, so a payload that was never encoded is not refused for containing a stray `%`.

**`c1.` names the format, not the algorithm.** An unrecognised blob then fails with a sentence
rather than an inflate error, and changing compressor later is a `c2` rather than a guess about
what the bytes were. **`deflate-raw`, not `gzip`**: measured 24 characters shorter, which is
exactly the gzip container — a header, a CRC and a length, none of which a URL wants.

**An unknown scheme is named.** `Coda cannot open "ftp://" workflow links` — the fix for `http://`
is a URL change and the fix for `file://` is to send the file, and a shared "bad link" helps with
neither.

**Base64 is chunked.** `String.fromCharCode(...bytes)` is the one-liner and blows the call stack
well below the size an Explore Dataset selection reaches, with nothing in the failure naming the array
that did it.

**Both writer promises are caught in `through()`.** A corrupt payload fails on _both_ ends of the
transform: the readable side rejects and is turned into a sentence, and the writable side rejects
with the same thing a tick later with nobody listening — an unhandled `Z_BUF_ERROR` beside a
message that had already explained itself properly. Found because a passing test printed a stack.

### Reading a link, and the two questions

`store/graphStore` reads `location.hash` **synchronously in its initialiser**, only to ask
_whether_ there is a link, which is a regex. That answer withholds the start page, and it has to
be settled in the tick the store is created: a link noticed an effect later means the welcome
modal is already up over a workflow the recipient has not seen. `useShareLink` does the reading
and the fetching an effect later.

**The fragment is cleared once handled, including on a decline.** Left in place, a reload after
ten minutes of editing silently reverts to the shared graph, which is the worst thing this
feature could do. The link is not the store; the dialog regenerates it.

Two confirmations, for two different questions, asked in the order that lets the first be
answered without touching the network:

1. **Fetch from this host?** — only for a bare `https://`, whose destination the recipient cannot
   see. Shortening a link is exactly the act of hiding where it goes. `gh://` and `gs://` name a
   known host _in the link itself_ and do not ask.
2. **Replace what is on the canvas?** — only when there is something to replace. `loadGraph`
   resets the history and the autosave is the only copy of what is about to go. Same shape as the
   start page's card confirm, and `window.confirm` is avoided for the same reason.

A fresh tab following a gist link answers neither, which is the common case.

**What a shared graph runs is nothing, and that is a property rather than a promise.**
`loadGraph` schedules the _cheap_ pass, so anything `cheap` executes without the recipient
pressing anything — and `core.tableFromUrl`, the only node that fetches a URL written into the
document, is `expensive`. It is expensive for its own reason (invariant 6: its URL is a text
field, and `cheap` would fire a request per keystroke), but that reason is now smaller than the
one that depends on it, so `store/shareLoad.test.ts` pins it. The rest follows from what already
exists: `deserializeGraph` validates and drops, note and blurb markdown goes through an AST
parser that cannot emit raw HTML, and no credential is ever inside a graph.

### The gist half

`api.github.com` is **fully CORS-open**, verified rather than assumed: the `POST /gists`
preflight answers 204 with `Access-Control-Allow-Origin: *`, `Allow-Headers` including
`Authorization`, `Content-Type` and `X-GitHub-Api-Version`, and `Allow-Methods` including POST.
Reads carry ACAO too, and so do `gist.githubusercontent.com` raw URLs. So this works from the
static GitHub Pages build, where the Cypher API cannot reach — the same finding shape as the AI
providers.

**Anonymous gists do not exist.** GitHub removed them in March 2018 and an unauthenticated POST
is a 401. That is the whole reason a token is needed, and it is recorded so nobody re-checks it
hoping otherwise. **Reading needs no token**, which is what makes a link work for a recipient who
has never opened Connections.

**A third section in Connections**, beside Data sources and AI assistant. The top level there is
_what kind of connection_, and a GitHub token is a third kind — filing it under the sources would
make it a fourth connectome. `gist` scope and nothing else; the panel links to a token page with
that scope pre-selected, because the obvious thing to do when a page asks for a GitHub token is
to tick everything.

Four things that each produce a plausible wrong result:

- **`public` is rejected on a PATCH.** A gist's visibility is fixed at creation, so sending it
  anyway is a 422 on an otherwise perfectly good update. The secret checkbox is disabled once a
  gist exists for the same reason.
- **`truncated`.** The API stops inlining file content above 1 MB and hands back a `raw_url`.
  Coda's graphs are far under it and a graph carrying a large selection is not obviously so — and
  the failure mode is a _partial_ graph that parses, which is worse than one that does not.
- **Which file.** A gist can hold several and people add notes to them, so the one ending
  `.coda.json` wins; a single-file gist is taken as-is whatever it is called, so a link to
  somebody's hand-written `workflow.json` still opens.
- **One `GET /user` for concurrent askers.** The login cache is written when the answer _lands_,
  so two callers a tick apart both miss it. Not hypothetical: `StrictMode` invokes the dialog's
  effect twice, and that was observed live as two calls against a rate-limited API for one dialog
  opening. Same in-flight-promise idiom as `loadCachedTable`.

**`meta.gist` rides in the document**, which is what lets Share _update_ the link somebody
already has instead of littering a gist every time it is pressed. A gist id is public by
construction, so nothing private travels with it — and `owner` is what makes it safe: a graph you
were _sent_ names somebody else's gist, and PATCHing that is a 404 with nothing to explain it, so
Share offers Create instead. Note the chicken-and-egg that makes this work out on its own: the
uploaded JSON predates the id, so a recipient's copy carries no `meta.gist` and re-sharing
correctly creates their own.

It is committed with `autoRun: false` — bookkeeping about a link is not an edit, and a workflow
going stale because somebody copied its address would read as a scheduler bug. Same standing a
resize has.

### The advisories, and why this is a dialog

A menu item that copied a link would be smaller and would be wrong: what a shared workflow does
_not_ carry is not obvious, and the moment to say so is while the sender still has it in front of
them and can attach the file or mention the token. `ui/shareAdvisories.ts` is the rule, pure and
headless — `canExport.ts` in an advisory mood, and nothing here refuses a share, because unlike a
notebook on a connectome that does not exist outside the tab, a link is worth having in every one
of these cases.

- **An upload names the _file_**, never the content hash, because the filename is the only part
  of this anybody can act on. The rows are in IndexedDB by content address, exactly as a
  `.coda.json` has always been.
- **A real connectome names itself and the backend names the credential**, so the recipient is
  told they need their own *CAVE* or *neuPrint* token — and told that only Run needs it. It said
  `neuPrint token` for every dataset, which was true for as long as neuPrint was the only
  credentialled backend and became a **wrong instruction** the day a CAVE one shipped: it points
  somebody at the wrong tab of the Connections dialog, which is worse than saying nothing, because
  a sentence that specific reads as knowing what it is talking about. One sentence per backend
  rather than one compound one, since a graph can hold both and the recipient then needs two
  tokens from two places — hence the id is `token-<backend>`, which is what the dialog keys the
  list on. The backend comes from `backendForNodeType`, not from the family table alone, so
  **`Custom neuPrint` and `Custom CAVE` are counted too**: those name their server by hand and so
  have no family entry, which meant a graph built on one got no token advisory *at all* — the same
  failure with the sentence missing rather than wrong. A synthetic dataset earns no advisory,
  which is also what keeps `BACKENDS.mock`'s deliberately empty label from putting `a  token` on
  screen.

  Still unsaid: an annotation source needs its own credential and nothing here mentions it. On a
  CAVE graph `annotation.caveTable` is covered by the dataset's own sentence, but a FlyTable or
  SeaTable node wants `SEATABLE_TOKEN` and would need a second table keyed by node type.
- **A link over `LONG_LINK_CHARS` (8,000)** recommends the gist. Not a browser limit — Chrome
  carries about two megabytes and a fragment never reaches a server — but mail wraps, chat clients
  elide, and trackers linkify as far as they feel like.
- **A localhost origin** says so, because a link built on a dev server opens nowhere else.

**What does not travel**, and is not hidden: uploaded rows, both credentials, the panel and
layout preferences (per-user, deliberately never in the document), and the camera — `loadGraph`
bumps `fitRequest`, so a shared graph is framed by fit rather than by the sender's viewport,
which is right when the recipient's window is a different size.

### Small things the cleanup pass settled

- **`serializeGraph` gained `{ compact: true }`.** The codec was spelling the minify pass as
  `JSON.stringify(JSON.parse(serializeGraph(g)))` — three walks of the document and a throwaway
  copy of it, to undo indentation the same call had just added.
- **`deserializeGraph` validates `meta` now**, through a `validMeta` beside `validSize`. That
  block was passed through whole, which was harmless while it held a name and two timestamps
  nothing acted on. `meta.gist` names a gist `updateGist` will PATCH with the user's token, and a
  `.coda.json` is a file people mail each other.
- **`setGraphGist` does not go through `commit`.** `commit` runs `inferGraph`, refreshes every
  node's state and pushes a history entry unconditionally; no node can read `meta.gist`, so all
  of that was work for nothing on the largest graphs — and the new graph object it minted also
  re-ran the whole deflate behind the dialog. It sets and autosaves, the narrower path
  `afterSourceLearned` takes.
- **The gist filename comes from the caller**, through the same `slugify` `Download .coda.json`
  uses. Computing one user-facing name in two places is how the two come to disagree; they had
  already, over a length cap.
- **`copyText` lives in `ui/export.ts`**, shared with the neuroglancer link button. Its failure
  goes to the notice channel — the share dialog was writing it into `GistState`, which rendered a
  clipboard error in the gist result slot in *link* mode and, worse, overwrote `state: 'done'`,
  taking the freshly created `gh://` link off the screen when a copy failed.
- **`useDismissOnOutside` gained `outside`.** The share dialog had no Escape at all and the gate
  hand-rolled a sixth private listener. The gate passes `outside: false`, which is the reason the
  option exists: dismissing there discards a link somebody was sent, and on the replace prompt
  the other answer discards the canvas — a stray backdrop click is not an answer to either.

### What it costs, and why it is not lazy

**+22.9 kB raw / +7.3 kB gzipped on the main chunk**, measured against the same build with the
feature stashed out (930.75 → 953.63 kB). That is the codec, the resolver, the gist client, both
dialogs and the advisories.

**Splitting the dialog out was measured and declined.** `React.lazy` on `ShareDialog` yields a
6.72 kB chunk and takes only **1.78 kB gzipped** off main, because the half that cannot move is
the half that matters: `hasShareFragment` runs in the store's initialiser, the resolver and the
gate run on any page load carrying a link, and the advisories are read as the dialog opens. This
codebase's bar for a lazy boundary is the exporters at 17.6 kB gzipped and elkjs/three/sigma far
above that; under two kilobytes buys a `Suspense` boundary and a second code path for nothing.
Re-measure before adding to this — the number to beat is the one above, not the chunk size.

### Two CSS notes, both found in a browser

**Both panels set `height: auto`.** `.overlay__panel` is `height: 100%` because the panels that
came before these are scrolling bodies wanting every pixel; the share dialog is a link, a sentence
and a few asides, and at full height it rendered as a 640px card with four hundred of them empty
below the text — which reads as content that failed to load. `max-height` still caps it. Same for
`.share-gate__panel`. jsdom performs no layout, so this is exactly the class the suite cannot see.

**Everything else is `.sources`'**: header, section bar, notes, field rows and result lines are
reused outright rather than copied. They are the same kind of object — a modal about something
outside the document — and a second set of near-identical rules is how two dialogs drift on what
a note looks like.

### What was checked in a real browser

Headless Chrome over CDP against `pnpm dev`, because the codebase's standing lesson is that
jsdom reports one stubbed size for everything: the round trip (the `LC outputs` example → a
1,743-character link → a fresh tab restoring all seven nodes, the name, and an empty address bar,
with no console errors), both confirmations, the unknown-scheme refusal, gist create and gist
update with `api.github.com` stubbed in the page, and the two panel heights above. The link
length matched the headless measurement exactly.

## The autosave, and more than one tab

`localStorage` is per **origin**, not per tab. The autosave was one key, written 800ms after
every commit and read exactly once, in the store's initialiser — so two tabs on two workflows
wrote the same slot and whichever was touched last silently owned it.

**The graph on screen was never wrong, which is what made this hard to see.** Nothing re-reads
the key, so both tabs went on showing their own work indefinitely. The loss landed at precisely
the moment the feature exists for: reload tab A, and it came back as tab B's workflow, with the
history reset and no route back. A second tab was also not a blank slate — it loaded the first
tab's graph — so "open another tab to try something else" started you on a copy of the thing you
were protecting and then overwrote its crash net on the first keystroke.

Note what it is *not*, because that shaped the fix: none of the app's existing guards were
missing. `loadGraph` confirms before replacing the canvas and `saveToLibrary` before replacing a
shelf entry. Nothing guarded the storage slot because until there were two tabs nothing could
contend for it.

### A slot per tab, over the shared key rather than instead of it

Three keys and one decision.

```text
coda.autosave.v1              most recent graph from any tab   (unchanged)
coda.autosave.v1.tab.<id>     this tab's own
coda.autosave.v1.index        which slots exist, how recent, how big
sessionStorage coda.tab.v1    this tab's id
```

**`sessionStorage` is the whole mechanism**, chosen for three properties at once: it is scoped
to one tab, it survives a reload, and browsers restore it with the tab after a crash or a
"reopen closed tab". That is exactly the set of events an autosave is for. `saveAutosave` writes
both keys; `loadAutosave` prefers the slot and falls back to the shared key.

**The slot is an _override_ of the shared key, not a replacement**, and every other decision
here leans on that. A fresh tab — a genuinely new one, or the app reopened after everything was
closed — has no slot and takes the shared key, which is what keeps the ordinary single-tab case
working: close it, come back tomorrow, and the last thing you were doing is still there. It is
also the entire degradation path. No `sessionStorage` (a private mode, a suite under plain
Node), a slot evicted under budget pressure, or an autosave written by a build from before slots
existed all land on it, and every one of them gets exactly the behaviour this file had before.
**Getting the new half wrong costs the old behaviour rather than the work**, which is what
licenses an eviction policy at all.

The cost of that choice, taken knowingly: a second tab still *opens* on the other tab's
workflow. That is now a duplicate rather than a theft — editing it no longer touches the first
tab's slot — and it is the same behaviour that makes reopening the app work.

**`tabId` is deliberately not memoised.** A `sessionStorage` read costs nothing beside the graph
serialisation it accompanies, and a module variable holding the id would be a second source of
truth no test could reset without a seam existing for it. Being a different tab is exactly
writing a different value there, which is what a browser does — so the suite simulates two tabs
by doing that, and needs no `vi.resetModules` for anything but the store initialiser.

### What bounds it

Slots accumulate — one per app-open that gets edited — so `pruneSlots` runs on the write path,
where the budget is actually consumed, and keeps the six most recently active within two
megabytes. Both bounds, because the failure shapes differ: six slots of a four-kilobyte example
is nothing and six of a graph carrying a 10,000-neuron Explore Dataset selection is most of the origin's
five. The writer's own slot is never evicted and is charged first, so a graph larger than the
whole budget clears everything else and is still attempted rather than refused.

Three smaller rules, each of which is a wrong answer rather than an error:

- **Slots are enumerated from storage, not from the index.** A slot the index has lost track of
  is otherwise invisible and leaks until somebody clears the origin.
- **An unindexed slot is measured and ranked last, never dropped on sight.** A corrupt index
  would otherwise be a reason to throw away work that is perfectly readable.
- **A refused write takes its claim back.** If the slot write is refused where the shared key was
  not, leaving the index asserting bytes that do not exist drifts the budget until it starts
  evicting live tabs.

### The exception `sessionStorage` cannot see: a duplicated tab

`sessionStorage` is per tab with one exception, and it is a gesture people make: a browsing
context created *from* another — **Duplicate Tab**, or `window.open` — starts with a **copy** of
it, this tab's id included. Two tabs then write one slot, which is the original bug surviving in
the one case the mechanism cannot see for itself. Measured in Chrome rather than assumed: without
a fix, duplicating a tab and editing the copy left the original reloading onto the copy's graph.

**The `storage` event closes it with nothing else added**, because it fires only in *other*
documents on the origin. A tab that sees a write to its own slot has just been told, by the exact
act that would have caused the damage, that somebody else holds its id — so it takes a fresh one,
and since `tabId` re-reads `sessionStorage` every call the next save lands in the new slot with no
further plumbing. Exactly one tab moves: the other's write raised the event, and no tab hears its
own writes.

Two things about it are load-bearing and neither is obvious:

- **A removal is not a collision.** `pruneSlots` deletes the slots it evicts, and reading that as
  a duplicate would have every evicted tab churn its identity for no reason.
- **`reclaim` is required, and leaving it out was a hole rather than a missing refinement.** The
  event arrives *after* the write that raised it, so by the time a tab learns its id was taken the
  copy has already overwritten both the slot and the shared key. Re-minting alone leaves the
  original pointing at an empty slot and falling back to a shared key that now holds the copy's
  graph — the original failure, one step later. So the new slot is filled immediately with what
  the tab is actually holding, which is why `watchTabIdentity` takes the graph accessor as a
  *required* argument: an optional one is a caller that can silently reinstate the bug.

### Verified in a real browser, because jsdom cannot see the premise

The logic is pure storage, so jsdom is an adequate environment for it — but the design rests on
browser facts jsdom does not implement, so those were driven over CDP against `pnpm dev`: two
real tabs get distinct `sessionStorage`; the identity survives `Page.reload`; each tab reloads
onto its own graph and not the other's; a third tab adopts the most recent. Then the duplicate
case end to end — a copy booting under the original's identity and onto its graph, being edited,
and the original still reloading onto its own work.

One methodological note worth keeping. The first run reported a failure that was the *test*
racing: `.react-flow` existing does not mean it has drawn its nodes, so the DOM assertion had to
poll. And a `window.open` probe was inconclusive because headless Chrome blocks the popup — the
duplicate case was settled instead by putting two tabs into the state a duplicate lands in, which
is the state that matters however it is reached.

In the suite, the same distinction bit once more: dispatching a synthetic `StorageEvent` is *not*
what another tab does. A real one writes and then the browser raises the event, so a helper that
only dispatched left the slot holding whatever this tab last put there — and an assertion about
whose graph survives would have been checking nothing.

Eleven mutations were confirmed to fail a test, which is the only reason to believe any of the
above: the slot ignored on read, the shared key not written, an unindexed slot dropped on sight,
a refused write leaving its claim, eviction ranked the wrong way, either bound removed, the own
slot not charged first, the watcher inert, an eviction read as a collision, and the re-mint
without its reclaim.

**+1.62 kB raw / +0.60 kB gzipped on the main chunk**, measured against a build of the same tree
with the change stashed out.

### What is still shared between tabs, and is not fixed here

Everything else in `localStorage` is a preference read once at init and cached in a module
variable, so tabs drift rather than losing anything. Three are worth knowing about:

- **Auto-run is one key and its default is a safety default** (invariant 6). Turn it on in one
  tab and a tab opened or reloaded afterwards inherits it — with expensive nodes and a shared
  production Neo4j behind them, and nothing on screen saying where the setting came from.
- **Credentials cache behind a `loaded` flag.** Paste a token in one tab and the other keeps
  401ing while its Connections panel shows the old value; touching that field then overwrites the
  fix. A `storage` listener re-running `load()` and firing the existing `changed` channel would
  close it.
- **`saveToLibrary` resolves name→id from the tab's cached listing**, so a save landing before
  `refreshLibrary` resolves can mint a second entry under a name that already exists — which
  `library.ts`'s own header says cannot happen.

And one that is inert today and will not stay that way: **no IndexedDB opener installs
`onversionchange`**, so the first `DB_VERSION` bump with an old tab open has the old tab block the
upgrade while the new one degrades — permanently in `cache.ts`, which memoises the failed
`dbPromise`, and as "this browser has no storage" in the three that reject. Cheap insurance to add
before the schema moves.

## The workflow library

`Save ▸ Save in this browser` keeps a graph on the browser's own shelf; `store/library.ts` owns
it, the Open and Save menus show it, and the start page grows a _Your workflows_ rail when
anything is on it. It complements the download rather than replacing it — browser storage is
per-origin, per-profile, cleared with the site data and absent in a private window, so the file
is still the only durable artefact and the UI says so in both menus.

**IndexedDB, and its own database.** Not `localStorage`: the autosave already keeps a full copy
of the working graph in the ~5 MB origin budget, and an Explore Dataset select-all is ~110 kB of params
in one node, so a handful of saved graphs would hit quota — silently, since `saveAutosave`
swallows that by design. Not `data/cache.ts` either, despite the IndexedDB wrapper already being
there: that module is a _cache_, with expiry, fingerprint-as-miss and a `cacheClear`, and a graph
someone saved must never be evictable by anything that clears caches. A separate database also
keeps the two from racing on a version bump of the same `coda` one.

**Writes reject; reads resolve — and this is the one place the codebase's storage idiom
inverts.** Everywhere else a storage failure degrades silently, because a failure to _remember_ a
value is not a failure to compute it. That reasoning does not survive contact with a save: a save
that silently did not save is data loss, and reporting success would be worse than refusing. So
there is **no in-memory fallback** — where IndexedDB is missing there is nowhere durable, and
something that lives until the tab reloads is not a save — and `saveToLibrary` is the one action
that puts a storage error in front of the user.

The write path waits for the transaction's `complete`, not for its requests: a quota failure lets
the `put` succeed and _then_ aborts, so awaiting the request would report a save that was rolled
back.

**The stored graph is the string `serializeGraph` produces**, so a shelf entry is byte-identical
to what the download writes and the two paths cannot drift; reading goes back through
`deserializeGraph`, which is what gives a stored graph the same lenient loading and the same
warnings a file gets. Opening one routes through `loadGraph` like every other open, so the
history reset and the fit-on-load request are not reimplemented.

**An entry is a document keyed by its name, normalised.** Saving under a name already on the
shelf replaces that entry — after an inline confirm — and keeps its `createdAt`; renaming the
graph in the toolbar is what makes a second one. `normalizeName` folds case and repeated
whitespace, because "LC4 sweep" and "lc4 sweep" as two entries is a shelf nobody can keep tidy.
The alternative, appending a snapshot per save, fills the menu with copies that are
indistinguishable at a glance.

**The shelf is read lazily**, when a surface that shows it opens (`onOpen` on the two menus, an
effect on the start page) and after every write. Someone who never uses the feature never opens
the database. `libraryLoaded` is a separate flag from `library.length` on purpose: the rail hides
on empty and renders on loaded, and collapsing the two flashes a rail on every launch.

**`WorkflowSummary` carries `nodeTypes`**, which is why the start page can draw a tile per entry
without reading a megabyte of JSON per card. The list rather than a chosen type — deciding which
node stands for a graph is a UI question, and `startCards.tileNode` already answers it for the
examples. Same doctrine as everywhere else here: derived art, never per-item.

Two test-shaped notes. `store/library.test.ts` runs against **fake-indexeddb** (a devDependency),
because a persistence layer verified against an in-memory shim verifies the shim; each case gets
a fresh `IDBFactory` _and_ calls `resetLibrary()`, or every case after the first writes into a
dead database. And in `ui/panels/library.test.tsx`, never put a `fireEvent` inside a `waitFor` —
the click mutates the DOM, the observer re-invokes the callback, and the two chase each other
without ever yielding to the poll's own timeout. It hangs the run rather than failing it.
