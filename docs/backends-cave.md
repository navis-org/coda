# Backends: CAVE

CAVE: deployments and sign-in, the datastack listing, tables and the row cap, discovery and segment
properties. Meshes and skeletons are in [backends-cave-geometry.md](backends-cave-geometry.md).
[backends.md](backends.md) holds what all of them share — the geometry cache and streaming.

## CAVE

`src/data/cave/`, and the second backend. FlyWire and everything else served by CAVE — the
info service that lists datastacks, a materialization engine that answers queries against a
frozen snapshot, and per-datastack annotation tables. Nothing above `src/data` knows it exists;
a CAVE dataset node is `dataset.flywire`, built from `DATASET_FAMILIES` exactly as the neuPrint
ones are.

**Everything below was probed live against `global.daf-apis.com` and `prod.flywire-daf.com`
rather than recalled**, and `live.test.ts` is that pass institutionalised — skipped without
`CAVE_TOKEN`, the standing `scripts/check-export.py` has when navis is absent.

### A deployment is a global server, and each has its own token

A CAVE **deployment** is one global info service and the local servers it fronts:
`global.daf-apis.com` lists FlyWire, BANC and MICrONS; `global.brain-wire-test.org` lists H01
(`h01_c3_flat`) beside `fish1_full` and `fish1_test`, and sends every query to
`local.brain-wire-test.org`. Measured live, September 2026: the two are separate `middle_auth`
installations with separate account tables — a `global.daf-apis.com` token is answered **401** by
`global.brain-wire-test.org`, and a tokenless request there is a 302 into its own `sticky_auth`.
Its `auth_info` answers with `ACAO: *` like the default's, so signing in works unchanged.

It used to be one token and one global-server setting, so reading H01 meant repointing the setting,
which dropped FlyWire's datastacks from the session and would have sent one deployment's token to
the other. The shape now is CATMAID's ([Credentials are a list](backends-catmaid.md#credentials-are-a-list-because-catmaid-is-software-rather-than-a-service)),
with one difference that decides the key:

  - **Rows are keyed by the global server, never matched by host.** One token is honoured by hosts
    nobody typed — the datastack's `local_server`, the chunkedgraph, the skeleton service — so a
    host-pattern match would miss every request that matters. Instead **a request names its
    deployment**: `CaveRequestOptions.deployment` is *required*, so a call site that forgets is a
    compile error rather than a request signed with the wrong token. `credentials.ts` holds
    `{server, token, session?}` rows under `coda.cave.credentials.v1`, and carries the old
    single-token keys into a row for the server they were stored beside, once.
  - **A source per deployment.** `deployments.ts` owns the vocabulary: the default keeps the bare
    `cave` source id every saved graph carries; any other is `cave:<origin>`, and
    `caveServerOfSource` reads it back. So the deployment rides on a Dataset's `sourceId`, and
    every node downstream learns its deployment from the wire. `registry.ts`' `caveSourceFor`
    creates them lazily. **The default is `registerBuiltinSources`' to register, never a node's**:
    Custom CAVE registering it from `inferOutputs` put an unlisted `cave` source under the
    exporter, which runs with none registered on purpose, and Find Neurons on FlyWire then checked
    its filter rows against a schema with no `type` and dropped the filter from the golden
    notebook. `publishedCaveSourceId` registers only a non-default one.
  - **Every memo is keyed by deployment** — datastack records, table lists and facts, the skeleton
    service, the L2 probe, root-id checks — so two deployments never share an answer and there is
    no "server changed, reset everything" clock. Each peek takes the deployment as its first
    argument, and `peekDatastacks` is gated on *that* deployment's token.
  - **A typed datastack means the default deployment.** `CAVE table`, `List CAVE tables` and
    `CAVE table info` take a `datastack:materialization` field with no room for a server, so a
    datastack elsewhere is reached by wiring its Dataset; the field's help says so. An annotation
    ref carries a `deployment` key **only where it is not the default**, because `refKey` writes
    every key into the annotation cache key and every ref saved before deployments is on the
    default.
  - **The export writes `server_address=` only for a non-default deployment.** caveclient's own
    default is `global.daf-apis.com`, so every FlyWire notebook and golden stays as it was.

`live.test.ts`'s H01 block (`CAVE_H01_TOKEN`) runs with H01's token **and no other**, so a request
that reached for the default's would go out unsigned and fail. Both H01 tables it reads answer root
ids in different JSON types — `nucleus` as strings, `cells` as numbers past 2^53 — and both arrive
as exact 18-digit text through `findNeurons`.

### Signing in, and why a static page can

`data/cave/oauth.ts` plus `ui/panels/caveSignIn.ts`, on the window machinery in
`ui/panels/popupSignIn.ts` that neuPrint's sign-in shares. CAVE's auth is seung-lab's `middle_auth`,
and it answers the question a page with no server has to ask: **how do you get a token without a
client secret and without an origin somebody had to approve?** The answer is that middle_auth is
itself the OAuth client — it holds Google's secret, it owns the redirect URI — and its callback
page hands the result to whoever opened the window:

```
window.opener.postMessage({token, app_urls}, "*")
```

There is no allowlist on that `"*"`. So the flow works from `localhost`, from a Pages deploy and
from a fork, with nothing registered and nothing to ship. Neuroglancer, a static app in the same
position, does exactly this; the shape below is its shape.

Measured live, September 2026, and each one decides a line of code:

  - **The prefix is per deployment.** `global.daf-apis.com` serves middle_auth under
    `/sticky_auth` — `/auth/api/v1/authorize` is a 404 there, while `/auth/api/v1/create_token`
    redirects into `/sticky_auth/…`, which is why the panel's long-standing help link still
    works and reading a path off it would not. So the prefix is read from `GET {server}/auth_info`
    (`{"login_url": "…/sticky_auth"}`, `ACAO: *`, no token needed), never assumed. A 401's
    `WWW-Authenticate` realm names the same URL and is exposed cross-origin, so there is a second
    source — deliberately unused, because signing in must be reachable *before* anything fails.
  - **Every auth endpoint reflects an arbitrary `Origin`** with `Access-Control-Allow-Credentials`
    and `WWW-Authenticate` exposed. Confirmed with a preflight from a github.io origin. That is
    what makes `fetchIdentity` a plain cross-origin GET.
  - **What comes back is a login token, not an API key**, and middle_auth issues those with a
    seven-day life (`DEFAULT_LOGIN_TOKEN_DURATION`). Coda stores it as it arrives and signs in
    again when it is refused. The alternative was `create_token`, which mints a key that never
    expires: a permanent credential in `localStorage`, and a row on the user's CAVE account that
    Coda would then own. Nothing is created on their account by signing in here.

**The failure modes are the feature.** The happy path is nine lines; the rest of
`popupSignIn.ts` is that a login window has four ways to end and three are silent.

  1. **The browser refuses to open it.** `window.open` answers `null`, which is not an error
     anywhere. Hence also the ordering: the popup is opened on `about:blank` *first* and
     navigated after `auth_info` lands, because a window opened after an `await` is no longer
     inside the click that asked for it and is blocked.
  2. **The user closes it.** Nothing is raised and the promise would never settle, so the handle
     is polled — the same answer neuroglancer's `monitorAuthPopupWindow` reaches.
  3. **The flow ends somewhere that posts nothing.** middle_auth delivers from its callback
     page, and three exits never reach it: a missing session cookie ("Invalid Request, are
     third-party cookies enabled?"), a state that has expired, and an OAuth error — each renders
     a page and stops. At the moment it happens this is indistinguishable from (2), so the
     closed-window message names it, and it is part of why the paste field stays on the panel.
  **What is *not* a dead end, though it was written up as one.** A **first-ever login** is
  diverted to a "choose a username" form before it finishes — and that form delivers: it posts
  back to a URL still carrying `new_account=true`, and `register_choose_username_post` sets
  `template_name = None` for precisely that case ("don't show template during new account flow"),
  so the flow falls through `maybe_handle_tos` to the `postMessage`. Signing in also *creates*
  the account, into the group literally named `default`; what that group may read is deployment
  data, so the realistic first-run failure is a 403 on a datastack **after** a sign-in that
  worked, not a sign-in that hangs. A pending terms-of-service is not a dead end here either:
  that diversion fires only when `/authorize` is called with an explicit `tos_id`, which Coda
  never passes. Both were read as dead ends on the first pass and the shipped copy said so; the
  message a user sees was corrected to name the error pages instead.

  4. **Something else posts a message.** `"*"` cuts both ways. Two checks, neither sufficient
     alone: the event's `source` must be the window we opened (identity survives the navigation
     through Google), and its `origin` must be the service discovered *before* it was opened.
     `readAuthMessage` is the third check, and it is not decoration — middle_auth's TOS
     acceptance posts the bare string `"success"`, which stored as a credential gives somebody a
     session that fails on its first query with nothing to say why.

Two smaller decisions. A sign-in **commits**, where everything else in that dialog is a draft
until Save: the user has already confirmed it at Google in a window of its own, and leaving the
result unsaved in a textarea means closing the panel undoes the ceremony they just completed. And
what is stored beside the token is a **label, not an expiry** — the account it was issued to, and
the date. The seven days is a server-side default no response states, so a countdown computed
from a copied constant would keep claiming a token was good after the deployment shortened it;
the 401 is the only thing that knows. The account is worth the extra request because a token is
32 characters that look like every other token, and one person's CAVE account and neuPrint
account are routinely two different Google identities.

**What the panel does with it.** Three arrangements, and each replaced something that had grown
wrong. The tab is **one line per point with the paragraph on a `?`** (`Why`, a `title` — the
tooltip every other explain-this in this app already uses), because four paragraphs of copy in
front of a button somebody was going to press anyway *is* the interface, and it was this feature
that pushed it over. The paste field sits behind a **disclosure** — still reachable, since the
two arms above are the only way to meet it, but no longer the first thing on the tab. And the
**alert that opened the panel is dismissed by the tab that answered it**: "No CAVE token" is a
fact about the moment it opened, so leaving it above a tab now reading "Signed in as …" is the
dialog contradicting itself. `Dialog` holds the reason in state and `onResolved` carries the
*tab's* id, because two sources fail independently and answering neuPrint must not clear a
warning about CAVE — a new failure re-states it either way.

The split follows invariant 1. `data/cave/oauth.ts` is what is true about CAVE — where a
deployment logs in, whose a token is — and holds no reference to a window; `ui/panels/popupSignIn.ts`
is what is true about a browser, with `caveSignIn.ts` the few lines joining the two. What counts as
a token arriving is `data/signIn.ts`, shared with neuPrint. Nothing in the window half is
reachable from jsdom, so `openWindow` is a seam and the gesture itself was walked in a real
browser against `global.daf-apis.com`.

### The datastack listing is a fact about the credential, so its peek is gated on one

`/info/api/v2/datastacks` is filtered by permission, which is what makes it worth putting behind
the Custom CAVE card's Datastack field as completions (`peekDatastacks`, `datastack.ts`) — but
**it is filtered by `view` with the terms of service deliberately skipped**, and that gap is load
bearing. Read off `AnnotationFrameworkInfoService`, `datasets/api.py`:

```python
@auth_required                                     #  ← the listing
def get(self):
    return [d["name"] for d in DataStackService.get_all()
            if user_has_permission("view", d["name"], "datastack", ignore_tos=True)]

@auth_requires_permission("view", table_arg="datastack",
                          resource_namespace="datastack")   # ← /datastack/full/<name>, no ignore_tos
```

So a listed datastack is one the account may *view* once it has agreed to that dataset's terms —
not one it can query today. Everything downstream enforces the terms, and `middle_auth_client`
answers a `Bearer` request that has not accepted them with **`403 missing_tos`**, carrying
`tos_id`, `tos_name` and a `tos_form_url` in the body (a browser-shaped request gets a `302` to
that form instead). A genuine non-member gets `403 missing_permission`. Which is to say: **a
listing longer than what works is the ordinary state of a fresh account**, and the completions
have to be read as spelling aids rather than as a list of datastacks that will answer.

Three more things were established against `global.daf-apis.com` rather than assumed, and the
gate follows from the first two.

- **With a token, even a wrong one, it is a clean `401`** carrying `access-control-allow-origin`
  and `access-control-expose-headers: WWW-Authenticate`. That is the behaviour the module header
  already records, and it is why an expired token surfaces as a message rather than as silence.
- **With no `Authorization` header at all it is a `302`**, into `sticky_auth/api/v1/authorize`
  and on to Google's sign-in page. From a page that is a cross-origin redirect chain a `fetch`
  follows and then cannot read — a CORS failure rather than any status, so there is nothing to
  report and nothing to distinguish it from the host being down.
- **`client.ts` refuses a tokenless request before it is sent, and fires `reportAuthFailure` as
  it does.** Which is right for a query somebody pressed Run on, and wrong for a peek: the peek is
  read from a card that renders on every graph mutation, so an ungated one would put "No CAVE
  token" in the status bar at somebody who has only dragged a node onto the canvas.

So the peek answers `undefined` with no token and issues nothing. What re-arms it is the
**credential changing**: the listing is memoised against the token it was asked for, so a signed-in
account's list is never shown to the next one, a failing token is asked once rather than once per
keystroke (`asked`'s rule, reached by comparing the credential instead of by a second flag), and
signing in is what fills a field that was drawn bare — with no listing button anywhere, because
there is nowhere sensible to put one on a card.

**The source's own listing peek is gated the same way**, and was not until the assistant found
it. `CaveSource.peekDatasets` started `runListing`, whose first request is this one, with no token
check, so any code that merely *inferred* a CAVE dataset node raised "No CAVE token". The
assistant's system prompt infers a one-card graph for every node type it describes, CAVE datasets
included, so every first question put the Connections dialog over an answer about a neuPrint
dataset — for anybody without a CAVE token, which is most people. `peekDatasets` now returns before
`listing.peek` without one, so nothing is spent and the first peek after signing in still starts
it; `cave.test.ts` pins both halves.

neuPrint had the same hole, and **the gate now lives in `DatasetListing` as `credential`** (its
rule 4) rather than in each source: a listing given one does not peek without it, and one that
failed under a token is asked again under the next — rule 2's once-per-instance becoming once per
credential. neuPrint's second peek, `schemasFor`, starts discovery and is gated the same way, since
its queries are refused by the client for the same missing token: five reports to the Connections
channel per inferred node. **The old neuPrint test had watched `fetch` and passed throughout** — the
client refuses a tokenless request *before* fetching, so the report went out with no request to
count. It watches the auth channel now. **The discovery gate fixes a second bug it had been hiding**:
`runDiscovery` catches each of its three queries, so with every one refused it still stored a
schema "discovered" from nothing and never asked again — a tokenless session's hemibrain claimed no
`superclass` until a reload, sign-in or not. `datasetBody.test.tsx` had been reading exactly that
as a real discovery; it now sets a token and stubs a server that answers.

**The two geometry peeks were the same hole with a longer memory.** `skeletonSourcesFor` and
`meshLevelsFor` read the published neuroglancer state through the same client, ungated, so
inferring a Skeletons or Meshes card without a token opened the Connections dialog. And `ngState`
caught *every* failure as `scene: null` — no token, a 401, a 5xx, a cancel — which
`publishedSkeletonsFor` and `meshSourceFor` then cached as "publishes none" on top: after one blip,
or after signing in, the Skeletons card offered one route and the Meshes card no levels for the rest
of the session. The CAVE rule, arrived at independently: **only neuPrint's own 404 is a verdict**
(`isNotFound`), and a same-origin 404 from a host with no proxy rule is marked `unreached` so it
cannot pass for one. `ngState` now *rejects* on anything else, `caveGetOr404`'s shape, so no reader
can cache a failure by accident, and replays a failure for `RETRY_AFTER_MS` per token rather than
asking once per thumbnail and per restyle. Both peeks are gated on a token and keyed on it through
`PeekGate` (`src/data/peekGate.ts`), which `DatasetListing` shares — three hand-written copies had
already diverged on whether they remembered a flag or a token. CAVE's `schemasFor` discovery had the
same hole — a one-shot flag and no token check, so dragging a FlyWire card onto the canvas without a
CAVE token reported "No CAVE token" — and now takes the gate too, with `quiet` on the discovery it
starts, since a refusal of something nobody asked for is not a reason to open the dialog; a Run still
reports.

**Then every credentialed peek was swept, and five more had it.** `src/data/peeks.test.ts` calls each
with no token and asserts no request *and* no report, then signs in and asserts a request — both
halves, since each hides the other. Three reported into the dialog from a render: CAVE's skeleton
service peek, the CAVE-table annotations' kinds and SeaTable's base metadata. Two were already
`quiet` but spent their one ask on the tokenless refusal, so the answer stayed unknown after signing
in until something awaited it: `peekMaterializations` (a Custom CAVE node's versions) and
`peekL2Cache`. All five are on `PeekGate` now — `PeekGates` for the module-level ones, which also
took `peekTableList` and the table-sample peeks off their own flags — keyed on their own credential,
CAVE's per deployment and SeaTable's per host, and the CAVE ones are `quiet`. The flat-bucket and
NeuronBridge peeks read public buckets and keep a plain once-flag, correctly. The sweep's last test
reads every exported `peek*` function in `src/data` and fails on one that is neither swept nor listed
in `NO_CREDENTIAL` with a reason, so the next peek cannot be missed the way these five were. The
test that pins the gate has to watch the auth channel *and* let the first read settle: a pending
read is joined rather than repeated, and a tokenless one is refused before `fetch`, so a URL count
stayed green against the ungated version twice before it was written that way. And the assistant's prompt no longer infers dataset nodes at
all (`producedColumns`, `docs/assistant.md`), which is what had been reaching these peeks.

**One memo, two readers.** `CaveSource.runListing` narrows the very same list to the datastacks
with a spec, so `datastacksFor` in `datastack.ts` is what both go through — one fact, one request,
one invalidation rule. Written as a second call it was two round trips per session cached two ways
(the card's re-asked on a token change, the source's only on a server change), which is the
arrangement this module was extracted to dissolve when the annotation providers became a second
consumer.

The Connections panel asks the same endpoint for its Test button and deliberately does **not**
share it: it checks a **candidate** token, one the user may not save, and priming a memo other
cards read from an unsaved credential is how a card comes to offer a list nothing it does can
use.

### A refusal about a datastack nobody asked for must not raise a credential alarm

The gap above is not only a fact about a picker. It produced a bug worth keeping the shape of.

**Reported**: sign in with Google, press Test, get green and a list of datastacks. Return to the
canvas, press Run — the Connections dialog opens demanding a token. Dismiss it and the graph runs
perfectly. Every Run, forever. The trace:

```
GET  https://global.daf-apis.com/info/api/v2/datastacks                                    200
GET  https://global.daf-apis.com/info/api/v2/datastack/full/minnie65_public                403
GET  https://prod.flywire-daf.com/materialize/…/flywire_fafb_public/metadata               200
GET  https://cave.fanc-fly.com/materialize/…/brain_and_nerve_cord_public/metadata          200
```

Three things had to be true at once. `listDatasets` **does not cache** — a fresh listing is the
only thing that notices a materialization expiring — so every Run re-asks. It asks about **every
specced datastack**, because it is filling a picker rather than answering a question, and the
three live on three deployments. And the listing that named them was filtered `ignore_tos=True`,
so one of them refuses. `listOne` had always caught that refusal into an empty list, which is why
the run was unaffected — but `client.ts` had already called `reportAuthFailure`, and that opens
the panel. **The tolerated failure and the global alarm were the same line.**

So the rule: **`quiet` marks a request whose failure the caller has already decided to tolerate**,
and the test for it is whether the caller can carry on without an answer — not whether the failure
is likely or the endpoint unimportant. A 401 on something a graph is waiting for still has to
reach the panel; that is the whole of how a stale token gets replaced.

**The peeks are the other set that passes that test**, and one of them is reachable from the
feature that provoked all this: the Datastack field offers every datastack the listing names,
refusable ones included, and picking one makes the Materialization dropdown beside it call
`peekMaterializations` → `datastackRecord` → the same 403 — so the dialog reopened **from a
render** rather than from a Run. `peekMaterializations` and `peekL2Cache` are therefore quiet too.
`datastacksFor` deliberately is **not**: that one is the credential-level question, where a
refusal really does mean the token.

**Enforced in one place, or it is a promise the module does not keep.** `refuseAuth` builds the
sentence, reports unless the caller is quiet, and throws — reached from all four refusal sites in
`client.ts`. Three of them had drifted: `cavePostBinary` and `caveGetBytes` never read the body
and never honoured `quiet`, so a terms-gated *skeleton* fetch still told somebody their token had
expired; and the tokenless refusal, spelled three times, ignored `quiet` as well, which is why a
speculative caller had to gate on `getToken()` itself. That gate stays — a request that must fail
is not worth sending — but it is now a caller's choice rather than the only way out.

Two things around it that the obvious fix leaves broken:

- **The backstop.** A token the info service accepts and no *deployment* does leaves every spec
  failing, and the global call cannot see it — different service. So `runListing` reports **once**
  if nothing at all came back, rather than once per datastack. One refusal among two answers is a
  fact about one dataset; three refusals and nothing else is a fact about the credential.
- **The sentence.** `middle_auth_client` answers three distinguishable ways and Coda told
  everybody the same one. `missing_tos` carries `tos_name` and a `tos_form_url` — the account may
  view the dataset and has not agreed to its terms — so "your token may have expired" sends
  somebody to sign in again, which cannot lift a terms gate, and is exactly what the reporter did.
  `authRefusal` reads the body: the terms case names the form, the `missing_permission` case says
  it is a permission on the dataset, and only an unrecognised body falls back to the token.

**And a tolerated refusal is still an answer somebody needs.** Silencing the panel left the node
*pointed at* the refused datastack reporting

```
MICrONS Minnie65 public (CAVE): no dataset "(none)" on CAVE. Available: flywire_fafb_public:783, …
```

— which describes the symptom, names nothing that can be acted on, and reads as a bug in Coda.
Every part of it is a consequence of the tolerance working: the id is `(none)` because no
materialization came back, and the two datasets listed are the ones that answered, i.e. exactly
the datasets the reader did not ask about. The reason was three frames away and being thrown out.

So `runListing` **keeps** its failures, and `DataSource.whyDatasetMissing(ref)` is where a node
asks. Four things about that seam:

- It takes a dataset id **or** a bare family key, because the case that needs it most is the one
  where no id could be resolved — there is no `datastack:version` to ask about. Each source splits
  the ref at its own edge.
- It is **synchronous and network-free**, because `validate` reads it: the node nobody can run is
  now marked *before* anybody presses Run. `validate`'s old silence on an empty listing could not
  tell "has not arrived" from "was refused"; those are different states and only the first is the
  Connections panel's story.
- The failures are **replaced wholesale each listing**, so a datastack that starts answering stops
  being explained, and dropped in `reset` with everything else the old server taught us.
- `undefined` means **nothing is known**, which is not "it is fine" — a listing that has not run
  answers it too, so the generic sentence stays as the fallback rather than being replaced.

`CaveSource` prefixes the datastack onto a message that does not already name it. `missing_tos`
and `missing_permission` name the dataset themselves; the token fallback does not, and "CAVE
rejected the token (403)" on a card is a complaint about a credential with nothing tying it to the
one node in the graph that is broken.

### neuPrint is queried; CAVE is downloaded

The single decision the whole module follows from. neuPrint runs Cypher against a shared
production Neo4j, so `findNeurons` compiles a pattern into a query and every question is a round
trip. CAVE's query API has **no regex worth using, no `GROUP BY`, and a 500,000-row cap** — but
its annotations are a few tens of megabytes and are *already* what the Explore Dataset widget wants. So
`CaveSource` fetches the neuron index once per dataset through the machinery Explore Dataset already
has, pivots it, and answers `findNeurons` from memory: 139,255 neurons in **6.7 s**, then every
query after that is local. The cost is that the first one waits.

That is why `data/neuronFilter.ts` exists. Filtering locally means *Coda* decides what a pattern
means, and it has to decide the same thing the mock does and the same thing Neo4j's `=~` does —
`^(?:…)$`, so `LC.*` matches `LC4` and not `LPLC1` — or one graph pointed at two backends
quietly returns two answers. `compileRegex` and `compileLabelMatch` moved out of `MockSource`
when CAVE became their second consumer; a copy is how the two drift.

**`preparedRows` is the third thing in it, and it is what a local source runs a query with.** A
`FindNeuronsRequest` carries `rows` — `{field, operator, value}`, ANDed — and this compiles them
against the neuron index that will answer them, through `resolveRows` and `prepareFieldTerms`.
Both of those are shared with Explore's search box and the Table viewer's header cells, which is
the strongest form of the rule above: not two implementations that agree, one function.

**An unfilterable row throws rather than matching nothing**, and that is the decision worth
defending. `prepareFieldTerms` marks a column the table does not have as `unknown`, which matches
no row — right for the Table viewer, where an emptied table reads as a node that has broken and
can be seen. Here it would answer a *query* with nothing at all, indistinguishable from a dataset
that genuinely holds no such neurons.

That failure is what the row model retired, and it is worth recording what it replaced.
`refuseUnfilterable` used to take `minSize` and `roi` as named fields of the request, because the
card offered **Min size** and **In ROI** whatever was wired to it. `CaveSource` read
`index.data.size` — a column no CAVE index has — through `Number(undefined ?? 0)`, so any non-zero
**Min size** compared 0 against the threshold and dropped every row: a node reporting "0 neurons"
for a datastack full of them. `CatmaidSource` never read `req.roi` at all while publishing eighty
regions to pick from, so the answer came back too *large*. An empty result and an unnarrowed one
both look like answers, which is what makes a refusal the only one of the three that can be acted
on; it names the field as the card labels it.

Two of those three are now unreachable rather than caught. A row names a field of the dataset's
**own** neuron schema, so `size` on a CAVE datastack is not a filter that gets refused — it is a
field that was never in the dropdown, and the same goes for `status` on CATMAID. What is left is a
graph saved against one backend and repointed at another, which `resolveRows` reports on the card
before anything runs and `preparedRows` refuses at the seam if it gets that far.

**`refuseUnfilterableRoi` is all that survives, and a region is why.** It cannot become a row
because it is not a column in any schema: in neuPrint a neuron carries one boolean property per
ROI it innervates. So it stays a named axis, and the card gates it on `capabilities.roiFilter` —
whether the source can *answer* one — rather than on `DatasetInfo.rois` being non-empty. Those two
came apart on CATMAID and that is exactly the flag's reason for existing.

It is also deliberately **not** `compileLabelMatch`'s rule, whose absent value matches nothing on
purpose: that is neuPrint's `WHERE` semantics for a *property* a dataset may legitimately lack per
neuron, and every backend has to agree about it. These two are whole-query facts about the backend,
known before a single row is read.

### The 64-bit problem, at the other end of the seam

Invariant 8 was written for this. A FlyWire root id is eighteen digits, and **`JSON.parse`
rounds it**:

```text
raw text   "pt_root_id":720575940628857210
JSON.parse  720575940628857200   ✗ a different neuron, silently
json.ts    "720575940628857210"  ✓ matches the bytes on the wire
```

No reviver helps — a reviver is handed the value *after* parsing, so the digits are already
gone. The exact value exists only in the response text, so `json.ts` quotes every integer
literal too wide for a double before the parser sees it. Four things about it:

- **The scan matches a complete string literal first**, so it never looks inside one. The
  obvious `raw.replace(/:(\d{16,})/g, ':"$1"')` is wrong on real data: `neuron_information_v2`
  is free-text user annotation, so a tag reading `root:720575940628857210` gets quotes spliced
  into the middle of a string and the document stops parsing.
- **The decision is per match, by `Number.isSafeInteger`.** A 16-digit value that is genuinely
  exact stays a number; only what a double cannot hold becomes text.
- **The delimiter is part of the match** rather than a lookbehind, which is also what stops the
  fractional digits of `0.1234567890123456789` starting a match.
- **721 ms on the real 64 MB index response**, against 108 ms for a naive parse. Paid once per
  dataset behind the IndexedDB cache and against ~6 s of network — but worth knowing before
  anyone puts it on a hot path.

**The other leg is free, and that was checked rather than assumed: CAVE accepts a *quoted*
eighteen-digit id in `filter_in_dict`** and answers identically to an unquoted one. So ids go
out as text and come back as text, and no number is ever formed on either side. Had it not, the
request body would have needed the mirror image of the same rewrite.

### The row cap is a per-deployment number, and counting is the only tell

The materialization engine truncates a result and says so in a `warning` header — which its
`Access-Control-Expose-Headers` does **not** list, so a browser cannot read it. Truncation is
therefore detected by counting, and refused rather than returned: a short index is not a visible
failure, it is a dataset that silently lacks neurons.

**What it counts *against* is the part that was wrong for a year.** The number is
`QUERY_LIMIT_SIZE`, the engine's own config, defaulting to 200,000 and set per deployment — not
a property of CAVE. Measured the same day with the same request shape:

```text
deployment              table                              rows back    warning header
prod.flywire-daf.com    hierarchical_neuron_annotations      500,000    201 - "Limited query to 500000 rows
cave.fanc-fly.com       codex_annotations                  1,994,371    (none)
```

So `CAVE_MAX_ROWS = 500_000` describes FlyWire's deployment and nothing else, and comparing row
counts against it did both halves of the wrong thing. It was written `rows >= CAVE_MAX_ROWS`,
which refused BANC's **complete** two-million-row `codex_annotations` for being *larger* than a
cap that server does not apply — reporting it to the user as CAVE having truncated the table. And
even spelled `===`, as this file and `limits.md` both described it, it waves through a genuinely
truncated read on any deployment configured below 500,000.

**The honest test is the server's own `COUNT` of the same query.** `countTable` posts the read's
filters to the single-table query endpoint under `?count=true`, and `refuseIfCapped` refuses when
fewer rows came back than the count. `queryTableCounted` issues the two **concurrently**, so the
check costs no wall clock: on every call site the count is the faster by an order of magnitude.
A count that fails is not a read that fails — it degrades to `undefined` and the old
exactly-the-cap tell, which is no worse than what it replaced.

**Only the filters go into a count body.** Columns and resolutions describe a shape a count does
not have, and a `limit` would make the count agree with a deliberately short read by
construction.

**Cheap only where the query is**, which is why no aggregating view is counted and every call site
is either filtered or reading a table the browser was going to download anyway. A view that only
*joins* counts like a table, which is what `queryViewChecked` is for. Measured:

```text
count query                                                   time
synapses_nt_v1 filtered to one root id                        0.6 s
valid_synapses_nt_v2_view (a join view) filtered to one root  0.8 s
codex_annotations, whole table (1,994,371 rows)               0.7 s
synapses_nt_v1, unfiltered (~130M rows)                     > 180 s   (times out)
valid_connection_v2 — an aggregating view                   > 300 s   (times out)
```

That last pair is the same finding `tables.ts` records for `limit` not pushing down into an
aggregating view, arrived at from the other direction.

**A view's count gets a grace, not a veto.** Nothing about a view says which kind it is, and the
generic `CAVE table` card reads whatever view somebody picks — minnie65's `aibs_cell_info` among
them. So `queryViewChecked` starts the count beside the query and, once the rows are in, waits
`VIEW_COUNT_GRACE_MS` (5 s) and no more: a count that has not answered is treated as one that
failed, and `refuseIfCapped` judges by the row cap. Without it, a card pointed at an aggregating
view waited on a count that never returns.

**`hierarchical_neuron_annotations` is over the cap**, which is why the index reads it **one
`classification_system` at a time** — five queries of 17k to 139k rows instead of one that comes
back quietly short. The kinds come from discovery, which has already run, so the split costs no
extra round trip.

That was found by `live.test.ts` on its first run, and it is exactly the class of bug the fixture
suite cannot see. Note the tell that pointed the wrong way: the `table/{t}/count` endpoint reports
**377,699** for that table and **127,978** for `proofread_neurons`, while the tables themselves
yield over 500,000 rows and 139,255 distinct root ids. Whatever it counts, it is not the rows a
query returns — which is also why `DatasetInfo.neuronCount` is filled in from the index after the
fact rather than asked for at listing time.

**That was half the picture, and the other half turned up while writing `CAVE table info`: there
are two count endpoints and the one above is the wrong one to ask.** The materialization engine's
`materialize/api/v3/…/version/{v}/table/{t}/count` counts the frozen snapshot; the *annotation*
service keeps its own at `annotation/api/v2/aligned_volume/{av}/table/{t}/count`, and that one is
version-independent and counts the table as it stands. Probed against v783:

```text
table                            materialize   annotation   what a query yields
nuclei_v1                            143,140      143,140
proofread_neurons                    127,978      139,540    139,255 distinct root ids
hierarchical_neuron_annotations      377,699      512,957    500,000 — truncated
```

So the tell above was not "this endpoint counts something else" but "this is not the endpoint
that answers that question" — and *neither* of these two is either. A `count=true` query is a
third number, and the only one that predicts truncation: 512,957 and 139,255 for the two rows
above. That is what `refuseIfCapped` checks against, and reaching for the cheap precomputed
`materializedCount` instead would undercount every table and wave a truncated read straight
through.
caveclient spells the difference as two methods on two sub-clients — `materialize.
get_annotation_count` and `annotation.get_annotation_count` — which is the clearest statement of
it anyone has written down. Neither is wrong; showing one of them without saying which it is, is.
`tables.ts` reports both side by side and the card labels them, and the notebook exporter does the
same. Note this changes nothing about `neuronCount`: the annotation count is still not the count
of *neurons*, since `proofread_neurons` has 139,540 rows and 139,255 distinct root ids.

### A synapse table is pre→post links, so there is no presynaptic site to collapse onto

A CAVE synapse table is a list of predicted clefts, one row per pre→post link with its own
coordinate. Nothing in it identifies a presynaptic *site*: `pre_pt_supervoxel_id` names a
supervoxel, which is a chunk of segmentation and not a T-bar. So this source declares
`synapseUnits = ['links']`, and a pinned `sites` is refused rather than answered with its links
under that name — see [nodes-morphology.md](nodes-morphology.md), where the same rule is why the Skeletons node refuses
a route a dataset lacks. The refusal is at the **node**, not here: `SynapseRequest.unit` is
required, so the single caller resolves it before asking and this method is handed a decision
rather than re-deriving one.

The confidence cut goes to the **server**, as an `atLeast` on the table's own score column, which
is the one filter that reduces the download. **Most tables have no such column.** `spec.ts` names
one for FlyWire (`cleft_score`) and for nothing else: Aedes has `size`, which is a cleft area
rather than a confidence, and a datastack whose synapse table is merely *declared* gets
`STANDARD_SYNAPSE_COLUMNS`, which deliberately names none. Those cases now `onWarn` and return
everything. Silence was defensible only while the node's default was 1 and excluded nothing; a
control that starts at off is one somebody has set by the time it arrives here. And the scale is
the column's own — `cleft_score` runs to a few hundred and is conventionally cut at 50, which is
why nothing tries to normalise the three backends onto one number.

### A datastack does not describe itself

neuPrint's graph has a `:Neuron` label with properties on it. A CAVE datastack is a bag of
annotation tables with no privileged one — `flywire_fafb_public` publishes six, of which
`proofread_neurons` is the neuron set, `hierarchical_neuron_annotations` is the cell typing, and
`valid_connection_v2` is a **view** rather than a table. Nothing in the metadata says so; the
schema types (`representative_point`, `cell_type_reference`) describe the shape of a row, not
the role of the table.

### A reference table has no root id in it anywhere

`cell_type_reference` is the second table shape, and the difference is not cosmetic: such a table
annotates *another table* rather than the segmentation. Its rows carry `target_id` into the
target's `id`, and the root id lives over there. BANC's `codex_annotations` references
`cell_representative_point`; FlyWire's `hierarchical_neuron_annotations` references
`proofread_neurons`.

Reading one without the join is not merely incomplete — it is a **500**, because `select_columns`
is validated against the table's own model:

```text
POST .../table/codex_annotations/query   {"select_columns": ["pt_root_id", "cell_type"]}
  →  500  pt_root_id not in model or models for codex_annotations
```

So a reference read goes to the **join** endpoint, which is the same v3 path with no table name
in it and `tables` in the body. `CaveReference` on a `CaveQuery` is what switches it, and the
endpoint differs in three ways that are each a silent wrong answer rather than an error:

1. It takes `select_column_map` and **only** the map, where the single-table endpoint takes
   `select_columns` and only the list — each rejects the other outright. And naming one side of
   the map **drops the other side's columns entirely** rather than defaulting them, so a caller
   that cannot name its own columns has to ask for the whole join instead. That is why a wide
   read of a reference table samples the table's own column set with a `limit: 1` query first;
   without it, `id_ref`, `created_ref` and `pt_position_x` are offered to somebody as annotations.
2. `suffix_map` decides what collides, and a name only one side has arrives **bare** —
   `pt_root_id`, not `pt_root_id_ref` — which is what lets the same shaper read the row either
   way.
3. **`count=true` is not honoured on it**: it answers rows. `countTable` therefore counts the
   *base* table, which is exact because the join is many-to-one on a foreign key the annotation
   service maintains. Checked rather than assumed — all five BANC kinds probed returned join rows
   equal to the base count to the row, and `live.test.ts` is what would notice if that changed.

`caveclient` does the same thing under the name `merge_reference`, reading `reference_table` off
the metadata and switching to the join. That is why a table Coda refused answers fine in Python,
and the discrepancy is worth recognising: it is not a permissions or version difference.

`CaveSource` still writes its own join for the built-in path, and that is not duplication — but
not for the reason it first looks. The two do **not** join different tables: `flywire_fafb_public`
is the only spec with an `annotations` block, and there its `neurons.table` and
`hierarchical_neuron_annotations`' `reference_table` are the same table, `proofread_neurons`. What
keeps them apart is cost. `buildIndex` has already read the neuron rows for the population list,
so its `rootById` join is a Map over rows it is holding, where routing it through `CaveReference`
would buy a server-side join on each per-kind query to learn what is already in hand.

### A datastack still does not describe itself

So `spec.ts` holds one entry per datastack, static for the reason `datasetFamilies.ts` is
static, and it is a deliberately faithful port of the idea `connecto` arrived at in Python for
the same problem. **A datastack with no entry is not offered** — the info service lists thirteen
and most would fail on the first Run, and a dataset that appears in the picker and then fails is
worse than one that is absent.

**And the four bindings are shown to the user**, appended to the publisher's blurb on the
Description card as "Coda reads this datastack as:" — because a decision taken in this file is
otherwise visible nowhere in the app, and "why are there no cell types on BANC?" had no answer.
An unbound role gets a line saying so rather than being left out. See
[datasets.md](datasets.md#attribution-the-description-companion).

**`species` is on the spec too**, and used to be `'Drosophila melanogaster'` hardcoded in
`datasetInfoFor` — which was true while FlyWire was the only entry and made Dataset Summary
describe `minnie65_public`'s mouse visual cortex as a fly.

**Connectivity prefers that view and falls back to counting synapses**, which is `connecto`'s
shape and arrived at for its reason. `valid_connection_v2` is the server having done the
aggregation once: one row per ordered (pre, post) pair with `n_syn`, filterable by root id *and*
by `n_syn`, so a minimum weight is applied before anything is sent — on one neuron's outputs,
4,818 rows / 410 kB unfiltered against 183 / 16 kB at `n_syn >= 5`.

minnie65 publishes one too, `connections_with_nuclei`, and for a while nobody had noticed: the
Description said Connectivity was counted from `synapses_pni_2`. It is the same count rather than a
filtered one — on v1621, `n_syn` and `sum_size` equal a local count of the raw table on every one
of a neuron's 1,454 output and 2,514 input partners, the only difference being that **the view
leaves out autapses** — and it answered that neuron's outputs in 1.6 s against 6.4 s. **A view is
per materialization**: v117 predates views altogether (its `/views` listing is a server error), so
`ConnectionViewSpec.since` names the first version that has it and `connectionViewAt` is the one
reading of it, for the edge list and the Description line alike. A version before it counts
synapses, which is what it did before.

Where there is no such view — **which is most datastacks; FlyWire and minnie65 are the exceptions** — the
edge list is built by asking the synapse table for its two id columns and counting locally. The
query API has no `GROUP BY`, so neither the grouping nor the weight cut can be pushed down: every
synapse of every queried neuron is transferred, and `minWeight` is applied *after* counting.
That is still worth having by a long way, because the alternative is not a cheaper query but no
connectivity at all. Measured against Aedes, exactly that case: one neuron's 719 synapses arrive
in 1.1 s and 111 kB and collapse to 508 partners.

Two things about the synapse path were established live rather than assumed. **`select_columns`
sends more than it is asked for** — naming a `*_pt_root_id` returns the whole bound point, so the
supervoxel id rides along and the transfer is about twice what two columns suggest. And
**`refuseIfCapped` is the real bound**: a hub neuron or a large seed set can reach whatever the
deployment truncates at, where the view path is one row per pair and cannot.

**Which synapse table is three answers in order, and the order matters.** A configured
`spec.synapses` wins, because it can name a curated table and the column that scores it —
FlyWire's `valid_synapses_nt_v2_view` with `cleft_score`, on a datastack that declares
`synapse_table: null`. That one is a **view** (`SynapseTableSpec.kind`), chosen so a synapse cloud
counts what `valid_connection_v2`'s weights count: the raw `synapses_nt_v1` held about 1.5× the
weight on a neuron's top partners, and 1.3× even at `cleft_score >= 50`. The view matched `n_syn`
on every one of 4,818 output and 1,072 input partners. See [nodes-morphology.md](nodes-morphology.md), Synapses Between. Otherwise the datastack's **own declaration**, which is what makes a
hand-named datastack work with no configuration at all: 7 of the 13 the info service lists set
it, `wclee_aedes_brain` among them — and a Custom CAVE node's **Synapse table** picks another where
that declaration is wrong. Its columns are `STANDARD_SYNAPSE_COLUMNS`, which is a definition
rather than a guess — every synapse schema in `emannotationschemas` derives from
`BaseSynapseSchema`, which defines `pre_pt` and `post_pt`, so `pre_pt_root_id`,
`post_pt_root_id` and `pre_pt_position` are on every one. **The cleft centre is not**:
`ctr_pt_position` was the default once, checked against a `synapse`-schema table, but `ctr_pt`
belongs to that schema alone (`NoCleftSynapse`, `NoCenterSynapse` and the Buhmann schemas have
none). The one table that default was ever read for, Aedes' declared `synapses`, has it; the
Synapse table picker made a table of any other schema one click away. What CAVE answers for a
missing name in `select_columns` was not measured. Only a spec that knows its table's schema
names it (BANC, minnie65). `fetchSynapses` resolves the same way, so a
datastack that can answer connectivity by aggregation can also draw the synapses it aggregated;
`positionColumn` is a *stem* the API splits into `_x`/`_y`/`_z`, verified to behave identically
on both.

### Endpoint shapes that are not what a reasonable person would guess

Read off live responses and cross-checked against `caveclient` 8.0.1's own endpoint table:

- **`arrow_format=false` returns `application/json`**, which is what keeps Arrow, a WASM decoder
  and anything new in the main chunk out of this entirely. The cost is `json.ts`.
- **`tables` sits on a v2 path inside the v3 API.** caveclient's v3 map points it at `mat_v2_api`
  while everything around it moved; the v3 spelling 404s.
- **`select_columns` and `select_column_map` are not interchangeable, and each endpoint takes
  exactly one.** A single-table or view query rejects the map —
  `{"schema_errors":{"select_columns":["Not a valid list."]}}` — and a *join* accepts the list
  while warning that it "will attempt to select the first column it finds of this name in any
  table, but if there are more than one such column it will not select both", which is a
  silently wrong column rather than an error.
- **One `/metadata` call lists every materialization with its timestamps**, where `versions`
  returns bare integers and a per-version call turns a listing into a request per entry.
- **`unique_string_values` is the cheap half of discovery**: 52 kB and about a second, against
  tens of megabytes for the annotations. That is what lets discovery run from inference
  (invariant 2) while the index waits until something actually asks for neurons.
- **`table/{t}/metadata` is v3 where `tables` is v2, and the two answer different names.** v2
  reports `table_name: "nuclei_v1__fly_v31"` — the materialized table — where v3 reports
  `nuclei_v1`, which is the name `tables` listed and the name a query takes. A card built from
  the v2 spelling shows somebody a name they cannot type back in.
- **`limit` works on the query endpoint, and does not push down into an aggregating view.** A
  one-row query against `proofread_neurons_view` answered in **0.77 s**; the same against
  `nt_summary_view` and `valid_connection_v2` had not answered after **45 s**. Those two are
  `GROUP BY` roll-ups, so the server builds the whole result and then takes one row off it —
  the same fact as "CAVE has no `GROUP BY` for us", seen from the other side.
- **A view has no metadata endpoint and no count.** `/table/{v}/metadata` 404s,
  `/table/{v}/count` answers a **500** wrapping a 404, and `/views/{v}/count` is not a route.
  The `views` listing is a *map* rather than a list of names, so a view's description arrives
  with the listing and costs nothing extra — which is the asymmetry `tables.ts` is built around.

### Discovery: what is in a datastack

`tables.ts`, and the two nodes over it — `List CAVE tables` and `CAVE table info`. It exists
because of the section above: a datastack does not describe itself, and until these the only way
to find out which table was the cell typing was to already know. `CAVE table`'s field has
`nuclei_v1` as its placeholder and answers a 404 at Run for anything else.

Two things in it are decisions rather than plumbing.

**The facts and the column sample are two memos, not one record.** The card peeks the facts —
metadata and the two counts, never a query — so an edit-time look at a view cannot start a request
that runs for minutes at a shared production server. Only `evaluate` samples columns, where there
is a `ctx.signal` to cancel with and a `ctx.warn` naming the wait before it starts. A rail warns
and does not refuse ([limits.md](limits.md)), and time is never a refusal.

**The facts peek is gated on the listing already knowing the name.** Without that gate, typing
`nuclei_v1` a character at a time would fire a metadata read and two counts for `n`, `nu`, `nuc`
and so on — nine sets of 404s for one table anybody wanted. The listing is one or two small
requests per datastack and everything else hangs off it.

### What it costs, and what it declines

**+16.4 kB raw / +5.2 kB gzipped on the main chunk** (1,010.02 → 1,026.39 kB), measured against
a build of the same tree with the feature stashed out. Far under this codebase's bar for a lazy
boundary.

`SourceCapabilities` does the rest, and every `false` is a node that declines at edit time rather
than failing at run time: no `paths` (it needs a hop aggregated server-side, which CAVE has no
endpoint for), no `rawQuery`, and none of the three ROI
flags — FlyWire's neuropil assignments are a reference table on *synapses*, so there is no
per-region completeness table to read, and a per-neuron breakdown would mean reading a neuron's
synapses and grouping them, which is the work the connection roll-up exists to avoid.
`neuronIndex`, `meshes`, `synapses` and `viewerScene` are true for the source; `skeletons` is
answered **per dataset** through `capabilitiesFor`, because a datastack has one only if it has a
level-2 cache or a flat bucket beside it — see **Skeletons** below.

**The scene is built rather than fetched, and that is the whole of `viewerScene` here.** neuPrint
publishes a curated state per dataset — EM, ROI shells, synapse layers, a framing — which
`buildScene` edits. CAVE publishes no such document, which is why this reported "publishes no
neuroglancer scene"; but its info record names every *part* of one, so `cave/scene.ts` assembles
two layers from it and stops. Anything beyond those two is curation, and inventing it would be
claiming the datastack said something it did not. `layout` and `showSlices` are left off, because
`buildScene` supplies them when absent and a second rule here is a second place for the two to
disagree.

Three things in it, and two of them disagree with `caveclient` on purpose:

- **The segmentation source is published plain**, `caveclient`'s `format_graphene`. It used to
  carry `graphene://middleauth+…` unconditionally, which is wrong and is written up under
  *`middleauth+` is spelunker's, not neuroglancer's* below. Worth keeping from the first pass: an
  *insertion* rather than the reparse the Python does, since `urlparse` reads
  `graphene://https://host/p` as `netloc='https:'` and rebuilding from the parts only happens to
  come out right.
- **The image source is passed through, where `caveclient` answers `None`.**
  `format_cave_explorer` routes a `precomputed://` scheme to `format_precomputed_neuroglancer`,
  which handles `gs://`, `http://` and `https://` and falls through to `None` for a URL that
  already carries its scheme — established by *running* it, not by reading it. Every datastack
  probed publishes exactly that form, so porting the formatter faithfully would ship no image
  layer at all.
- **`viewer_resolution_*` is nanometres and neuroglancer's dimensions are metres, divided rather
  than multiplied.** `45 * 1e-9` is `4.5000000000000006e-8` in float64 and that artefact would be
  serialised into the URL verbatim; `45 / 1e9` is exact. 16, 4, 40 and 8 are unaffected either
  way, which is why it survived the first reading — 45 and 50 are not.

**The `#!+` merge works in spelunker too**, which was the open question the moment a CAVE dataset
started opening there rather than in mainline neuroglancer — the merge form was established
against the deployed Google viewer. Confirmed by reading spelunker's own bundle: its
`updateFromUrlHash` branches on `#!+` *before* the `#!` case and calls `restoreState` with no
`reset()`, which is exactly the semantic the camera-preserving update depends on.

**`DatasetInfo.viewerSite` came with it**, and it is a fact about the dataset rather than a
preference: `out.neuroglancer`'s `Viewer` param defaults to *empty*, meaning the dataset's own
deployment and only then the built-in. A CAVE segmentation only loads in a viewer that
authenticates the way its source is written for, and which way that is depends on the deployment —
see below. Absent on every neuPrint dataset, whose states open anywhere.

#### `middleauth+` is spelunker's, not neuroglancer's

The prefix was applied to every CAVE segmentation source, on a note here claiming it "is what
makes the segmentation load at all". That is true of one flavour of viewer and **breaks the
other**, and the other is the one FlyWire publishes.

`caveclient` says so in a fork the first transcription read straight past. `output_map` in
`format_utils.py` routes `"neuroglancer"` to `format_graphene` — plain — and
`"cave-explorer"`/`"spelunker"` to `format_verbose_graphene`, which adds the prefix; and
`build_neuroglancer_url` sets `auth_text = ""` for `seunglab` against `"middleauth+"` for the
rest. Transcribing `format_verbose_graphene` alone was transcribing one of two branches.

**The failure is symmetric and neither half is loud.** A seunglab fork runs its own login and
refuses the prefixed source; a spelunker build without it shows the segmentation layer present
and empty. Both read as "the viewer is broken".

**It is decided at `sceneUrl`/`scenePatchUrl`, which is the only place a scene meets a viewer.**
`caveScene` runs inside `fetchViewerScene`, and a `DataSource` has no idea which deployment the
node will open — so the prefix was being chosen a whole layer before the fact it depends on
existed. Both URL builders funnel through one rewrite, which is what stops the navigation and the
merge disagreeing; `SCENE_PATCH_KEYS` is `['layers']`, so a patch carries the sources too and
would break the segmentation exactly as a navigation would. The rewrite **normalises** rather
than only adding, so a hand-written state or a datastack that names its source with the prefix
already on it comes out right either way.

**caveclient's own test is unavailable to a browser**, which is why this is a table rather than a
probe. It fetches `<viewer>/version.json` — 404 on a seunglab fork, 200 on the others — and
measured against both deployments **that endpoint sends no `Access-Control-*` headers at all**.
So `SEUNGLAB_HOSTS` in `neuroglancer/scene.ts` carries what was measured, and the measurement is
in the comment beside it:

```text
ngl.flywire.ai                404  seunglab   ← flywire_fafb_public's own viewer_site
neuroglancer.neuvue.io        404  seunglab   ← caveclient's own fallback_ngl_url
neuroglancer.bossdb.io        404  seunglab
spelunker.cave-explorer.org   200  spelunker
ngl.cave-explorer.org         200  spelunker
ngl.microns-explorer.org      200  spelunker
neuroglancer-demo.appspot.com 200  spelunker  ← DEFAULT_NEUROGLANCER_URL
```

`ngl.cave-explorer.org` is in that list because it was **guessed** into the seunglab set on the
strength of its name and is not one. The names do not tell you; probe before adding a row.

**Unknown reads as spelunker**, and `out.neuroglancer` grew a `Viewer type` param
(`auto`/`spelunker`/`seunglab`, advanced) as the escape hatch — because `Viewer` is free text, so
the table can never be complete, and a wrong answer is a scene with no segmentation in it and
nothing naming the cause.

#### The layer type is the other thing the two flavours disagree about

The Seung-lab fork has a layer type of its own for a chunked-graph source, and banners the
plain name:

```text
The layer specification for graphene://… is deprecated.
Key 'layerType' must be 'segmentation_with_graph'. Please reload this page.
```

That sits along the bottom of the frame and, as it says, **only a document reload clears it** —
which on an unexpanded node card is a real share of the drawing, indefinitely.

`nglui` is the reference and its rule is the **source scheme**, not the datastack:
`_smart_add_segmentation_layer` builds a `ChunkedgraphSegmentationLayer` — which is
`type="segmentation_with_graph"` — for a `graphene://` source and a plain `SegmentationLayer`
for `precomputed://`. Mainline knows no such type, and nglui 4.x, which targets spelunker only,
emits `segmentation` throughout. So it normalises **both** ways beside the prefix, in the same
`sceneForViewer` pass: a scene read back out of a seunglab URL and re-sent to a spelunker viewer
would otherwise carry a layer type that viewer cannot construct.

**The ordering is what keeps it safe, and it is worth knowing before touching either end.**
`segmentationLayerIndex` matches `type === 'segmentation'` exactly, and it runs inside
`buildScene` — on the scene `fetchViewerScene` published, which is always the plain form. The
rewrite happens later, at the URL. Do it earlier and the neuron layer stops being findable, so
the scene comes out with no selection in it. `spliceSegments` is unaffected either way, since
`ownedLayerName` finds the layer by its `segments` array rather than by its type. Both facts are
pinned by tests, one of which asserts the segments survive the rename.

**Not confirmed in a browser**, and that is a real gap rather than an oversight: `ngl.flywire.ai`
refuses to boot without a FlyWire session — headless it answers *"Oops! There was an error and
Neuroglancer…"* whichever type it is handed, so the warning cannot be observed appearing or
disappearing here. What is established is the rule (nglui, both versions) and the required value
(the warning names it outright).

#### Reloading the frame

There is no other way to clear a warning the viewer has already put up, and until now Coda had
no way to ask. `contentWindow.location.reload()` is blocked on a foreign-origin frame, and
re-assigning the same `src` is a **same-document fragment navigation** — the very property the
`#!+` merge depends on, working against us here. What is left is remounting the element, which
is a `key` on the `<iframe>` and a counter in the effect's dependency list.

Two refs are cleared with it and both are load-bearing:

- **`appliedRef`**, because the effect's first act is to return early for a URL already applied.
  Leave it set and the remount produces a permanently blank frame.
- **`loadedRef`**, because it decides merge-versus-replace. The reload's own navigation sets
  `appliedRef` again, so the *next* upstream edit is an ordinary merge — and if the new document
  has not booted yet, that patch lands on neuroglancer's defaults instead of the published
  scene. This is the same window the flag was added for, reached from the other side.

The second was **vacuously covered at first**: the obvious test clicks reload and asserts a full
navigation, which passes on `appliedRef` alone. It only bites when the URL changes *between* the
reload and the new document's `load`, which is what the test does now — confirmed by mutation,
where the first version did not.

The button is worth having beyond this warning: an embedded WebGL application can wedge for
reasons nothing here can see, and every other route out of that was reloading the whole of Coda.

**Ask `viewerKind` about a deployment, never about a proxy path.** `NeuroglancerViewer` rewrites
its base to the same-origin `/ng` prefix so it can read the live state back, and `/ng` is a path
on this origin that names no viewer at all — so that caller passes the kind of the base it
started from. An inverse lookup inside `viewerKind` was written first and removed: it was correct
and **unobservable**, since the only proxied deployment is the default and both it and the
unknown fallback are spelunker, so a test on it passed under mutation while defending nothing.

The existing test asserted the prefix unconditionally and passed, because the fixture's
`viewer_site` happens to be `spelunker.cave-explorer.org`. Two more of the new tests were vacuous
on the first pass for the same shape of reason — a plain source makes "no prefix" true whether or
not anything ran — and both now assert **both directions**. Four mutations confirmed: always-
spelunker, add-without-normalising, patch-not-rewritten, and the explicit kind ignored.

**`roiCounts` is new, and `fetchRoiCounts` became optional to make room for it.** It was the one
per-backend method on the seam that was required and ungated, and the cost of that showed up two
levels away rather than at the node: `out.profile` fetches its regions in a `Promise.all` beside
two connectivity queries, so a source that rejected there took all three down and **every tile on
the card reported an error** — on a neuron whose partners had loaded perfectly well. The regions
leg is now independently absent, which is the widget's own "a tile renders only when its data
exists" rule, and `neuron.roiCounts` gained the `sourceSupports` gate its two ROI siblings
already had.

Two absences show up as data rather than as flags. A CAVE dataset reports **no ROIs and no
statuses** — and since a filter row names a field of the datastack's own neuron schema, and the
region picker reads `capabilities.roiFilter`, neither is offered on the card at all. That is the
honest state rather than a control that would match nothing, and it is stronger than the state
before the row model, where both were offered and answered wrongly.

### Segment properties, and what they unlock

`segmentProperties.ts` reads the `neuroglancer_segment_properties` sidecar — one inline document
listing every segment a source names. It is what turns a bucket of eighteen-digit keys into
something a person can pick from, and it is the single dependency behind three answers that are
otherwise impossible here: region *names* for the ROI Meshes picker, a browsable index for
Explore, and a `findNeurons` filtered by anything the sidecar publishes.

**It is not read by the probe.** The probe runs from an edit-time peek on a `cheap` node, and this
is a much larger document — hemibrain's segmentation publishes 22,706 labelled ids against its ROI
source's 63 — so downloading it because somebody typed a URL is invariant 6's hazard. It loads on
first *ask*, and the peek that cannot answer starts it and fires `reportSourceLearned`, which is
how the region picker fills a moment later.

**The URL comes off whatever the `info` is, not off a volume.** A mesh or skeleton directory names
a sidecar as readily as a volume does — neuroglancer's own `parseMeshMetadata` and
`parseSkeletonMetadata` read `segment_properties` with the same line its volume parser uses — and
the probe read the field in the volume branch alone. So
`https://flyem.mrc-lmb.cam.ac.uk/flyconnectome/aedes/al_meshes`, a `neuroglancer_legacy_mesh`
directory of 144 mosquito antennal-lobe glomeruli naming `segment_properties` beside itself, came
back nameless — and since `capabilities.roiMeshes` is gated on a mesh directory **and** names, ROI
Meshes refused a source publishing precisely what it asks for. Read once at the top of `classify`
and spread into all three branches, or the next bucket shaped like this one is a second report of
the same line.

**A refusal has to name a remedy its caller can take.** The listing refusal points at an
`Input IDs` node, which is the answer for Explore and Find Neurons and unreachable from ROI Meshes:
that node's only input is a Dataset, so somebody following the sentence finds nowhere to plug the
ids in — reported, in as many words, as "there is no apparent way to supply ids instead". So
`fetchRoiMeshes` asks the question itself, ahead of the `neuronIndex` that would otherwise answer
for it — `describe` is the probe's memo, which the next line reads anyway, so it costs no request —
and names what a *region* fetch can do instead: an Input IDs node into a Meshes node, wired to the
3D View's Volumes socket.

**That remedy was still one step short, and the node now takes the ids itself.** Reported against
FlyWire's neuropil bucket (`gs://flywire_neuropil_meshes/neuropils/neuropil_mesh_v141_v6`: meshes,
no sidecar): the sentence was accurate and the person reading it was on an ROI Meshes card, which
could not do what it said. So `roiMeshes` is gated on the **mesh directory alone**, a nameless one
sets `DatasetInfo.regionsById`, and the region picker's `+` dropdown gives way to a free-text adder
for segment ids (`MultiEnumParam.freeEntry`, the adder `StringParam.chips` already had; a pasted
`1, 2, 5` is three chips). Chips and `string[]` either way, so swapping to a source that names its
regions leaves the entries exactly where they were. Each shell is then named by its id,
there being nothing better to call it. The switch is a **stated fact** from the probe, never an
empty `rois`, because an empty list is also a sidecar that has not landed — and a picker turning
into a free-text one for the first second of a session would take a half-typed entry with it. On such
a source empty means nothing rather than a default set, and a non-id is refused rather than
dropped. The grammar is **`parseIdList`**, the one `Input IDs` and the Neuroglancer Source's own
`Segments` field read, so the same paste works on both cards; the node's `typedRegionIds` is the one
sentence `validate` shows and `evaluate` throws, and the source keeps only its seam's empty guard.

**A `#…` tail on a source URL is neuroglancer's options, never the address.** The same user first
pasted `…/neuropil_mesh_v141_v6#type=mesh`, which is how neuroglancer is told a directory holds
meshes. Kept on the location, the probe appended `/info` *after* the fragment, so the browser asked
for the directory itself and the bucket answered 404. `parseNgSource` takes it off every pipe
segment into `NgSourceRef.options`, outside `canonical`, so every spelling with or without one is
the same source — Coda reads the `info` anyway. The Layers output re-attaches it from the node's
own parse (not `source.ref`, which is whichever spelling registered first), since neuroglancer is
the one reader that needs it: `#type=mesh` is for a directory whose `info` does not say.

**Every route to it goes through `neuronIndex`**, i.e. through `loadCachedTable` like every other
source's index — so it persists across sessions, honours Explore's refresh and the node menu's
Clear Cache, and reports its age to the dataset card. It had a memo of its own, which got none of
that and meant the region picker read a copy the cached path could never invalidate.

**Every property becomes a column, and the type decides which.** `label` and `description` are
named by their *type* rather than their id — the id of a label property need not be `label`, and a
picker downstream expects one name on every source that publishes one. `tags` is an index list
into a shared vocabulary, folded to one cell with `JOIN_SEPARATOR` so Explore splits it back into
chips. A `number` without a recognised `data_type` is skipped rather than guessed at, and a
property whose `values` length does not match the id count is dropped whole — a short array shifts
every label onto the wrong segment, which is a table that looks well-formed and names the wrong
neurons.

**`findNeurons` is answered locally**, through the same `preparedRows`/`compileLabelMatch` helpers
`CaveSource` and `CatmaidSource` use, so `LC.*` means the same anchored thing on all three.
Checked live: `LC1[0-2]` over hemibrain's 22,706 returns exactly LC10, LC11 and LC12.

**Region shells default to every label, and `primary` is always true.** Both differ from neuPrint,
where the default is the subset that tiles the volume — because nothing in a sidecar says which of
its labels nest. `primary` is the licence to sum, and a source that cannot distinguish has no
grounds to withhold it from some rows and not others. `MeshGeometry.id` carries the *label*, not
the segment id, because that is what `ROI_MESH_SCHEMA` says a region is called.

**Unsharded multi-resolution meshes exist after all.** `readManifest` used to refuse them —
"no source in use here is built this way" — and hemibrain's region shells are built exactly that
way: `v1.2/rois/mesh` publishes `1` and `1.index` side by side. The manifest is the `.index`
object and the fragments are the plain one, so `dataStart` is **0** rather than
`manifestOffset - Σ sizes`: that subtraction exists because in a shard the fragments sit
immediately before the manifest in one file with no pointer to them, and here they are a separate
object starting at its first byte.

### Smaller decisions

- **`neuronId` is `str` on this source, and `type` is the only other renamed column.**
  `pt_root_id` → `neuronId` and the `cell_type` annotation kind → `type`; everything else keeps
  CAVE's own spelling (`super_class`, `cell_class`), the same call neuPrint's passthroughs make.
  What `str` costs is numeric sorting of ids and their appearance in numeric pickers, neither of
  which is a loss.
- **A failed discovery is asked for once, not once per keystroke.** `schemasFor` runs from
  edit-time inference and `runDiscovery` sets its schema only on success — so without a
  `discoveryRequested` flag every failure was retried on every graph mutation: one 52 kB request
  per keystroke, or one auth-failure popup per keystroke with no token. Exactly the rule
  `peekDatasets` already states for the listing beside it, and the reason neither flag is cleared
  on failure. The listing's half is `data/datasetListing.ts`, one class for neuPrint, CAVE and
  CATMAID: a peek starts the listing once per instance, and a failed listing is retried by the
  next *awaited* caller — the three had been doing that retry three different ways. Pressing Run
  still retries, because the index path calls `discover` regardless.
- **The index's two legs run together.** The annotation queries depend on nothing from the neuron
  table — only on the server and the discovered kinds — so awaiting it first cost a round trip
  plus 139,255 rows of transfer. Measured against live CAVE: 5.76 s to 4.04 s.
- **`typesOf` is memoised on the index's identity.** `fetchConnectivity` is called once per hop
  per direction, so `Hops: 3, Direction: both` built the same ~108,000-entry map six times in one
  Run, and Neuron Profile built two per page turn. A `WeakMap` on the `TableValue` is safe rather than
  merely likely to hit: `cacheGet` promotes a hit into `cache.ts`'s module map and hands back the
  same object. Same idiom as `searchIndexFor` and `statsFor`.
- **A dataset id is `datastack:materialization`** — `flywire_fafb_public:783` — following
  neuPrint's `family:version` convention exactly, which is what lets the existing version
  dropdown carry a materialization with **no new control**: `compareVersions` orders bare
  integers, so 783 sorts above 630 and a pinned 630 stays 630.
- **The index is deduplicated on the root id.** A CAVE neuron table is keyed by a *point* — a
  soma, a nucleus, a representative vertex — so one segment carrying two of them is two rows for
  one neuron, and a repeated row is double-counted by everything downstream that sums a weight.
- **Connectivity types come from the index**, not from a second query. A connectivity table
  without them is readable by nothing, and by the time anyone runs Connectivity the index is
  already in hand. A partner outside the annotated set has no type, which is honest rather than
  a gap.
- **There is no Base URL field**, unlike neuPrint's, and its absence is the finding: every CAVE
  service Coda calls answers a browser directly, **including on its 401s**, which is the part
  `reportAuthFailure` depends on. What the Connections tab does carry is a row per *global server*,
  which is a different thing — CAVE splits into one service that knows which datastacks exist
  and a per-datastack `local_server` that answers queries, and only the first is ever named.
- **A CAVE 401 opens the CAVE tab.** `reportAuthFailure` carries no source id, so the Connections
  panel used to declare one `authTab` per section, hardcoded to neuPrint. Harmless while neuPrint
  was the only credentialed backend and wrong the moment CAVE arrived; the *tab* is now named by
  whoever subscribes. The `section.authTab ? …` branch that chose whether to wrap a body was
  reading an auth detail to answer a layout question and is now an explicit `tabbed` flag.
- **Both exporters skip it, and the export is refused outright.** `dataset.flywire` is named in
  each `NO_EMITTER` with its reason — the notebooks are built on neuprint-python and neuprintr,
  and emitting neuPrint code against a dataset neuPrint has never heard of would produce a
  document that runs and answers nothing. The loops and `canExportNotebook` both read
  `DatasetFamily.notebook`; see [export.md](export.md#the-softer-half-warning-that-an-export-will-have-gaps-in-it)
  for why that is one field rather than a test repeated at each site.

### What is not done

Skeletons, until the skeleton cache has anything in it (above). The annotation-source
abstraction that would let a FlyTable or a GitHub TSV join onto root ids, and the
materialization/annotation dropdowns and per-source morphology ceilings. Aedes needs the
annotation half before it is usable at all: its CAVE datastack publishes synapses and nuclei and
*no* annotations, so type, class and side live in FlyTable.

Not looked at in a browser yet — the module is headless and both suites are headless, so what has
not been seen is a FlyWire dataset node on a real canvas: the Explore Dataset widget over 139,255 neurons,
and twenty decimated meshes with their synapses in the 3D view. Same standing as the WebGL
viewers, and the mesh path is the half most worth looking at, since a decimation grid is a
judgement about a picture.
