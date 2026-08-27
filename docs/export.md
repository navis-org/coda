# Exporting a notebook and an R Markdown document

The `src/export` tree: both language exporters, the refusal policy, and the goldens.

Moved verbatim out of `CLAUDE.md`.


## Exporting a notebook

`Save ▸ Export as Jupyter Notebook`, or the palette's `Graph ▸ Export as Jupyter Notebook`, writes the graph as
a `.ipynb` built on **neuprint-python, pandas and navis** and nothing else. `src/export/python/` is the whole of it; nothing in `src/core`,
`src/data` or `src/nodes` knows it exists, because the exporter reads the graph and the graph
never reads back.

**The contract is a faithful starting point, not a bit-identical reproduction.** It runs, and
for the common path it answers what the canvas answered — but it is meant to be read and
edited, so where Coda and neuprint-python genuinely differ the cell says so in a `NOTE` rather
than contorting itself. That choice is what keeps the tier-3 nodes (Connectivity's traversal,
Explore Dataset's search) at one generated helper each instead of a Python port of `src/nodes/lib`.

**The exporter is loaded on demand.** `downloadNotebook` does `await import('./python/exporter')`,
because every emitter and every generated Python helper is inert string-building that only runs
when somebody asks for a notebook — statically importing it put **54 kB (17.6 kB gzipped)** into
the main chunk, paid on first paint by everyone. Same doctrine as elkjs, three.js and sigma;
verify with `pnpm build` that `exporter-*.js` stays its own file.

**`src/export/canExport.ts` is the light half, and it exists for that reason.** Whether a graph
can be exported is asked by two surfaces, one of them (`buildCommandItems`) on **every store
change** — so answering it must not reach the exporter. It is also the single statement of the
refusal policy: `reason`, `detail` for the menu's paragraph and `fix` for the palette's one
breadcrumb segment. Two lengths, one rule; the surfaces differ in room, not in what they consider
unexportable.

**Emitters live in their own registry, keyed by node type** (`registry.ts`), not on the
`NodeDefinition`. Two reasons: a viewer's emitter can reach `src/ui`'s palette, and a node type
with no emitter degrades to a TODO cell rather than failing to compile. The cost is real and is
the thing to watch — an emitter can quietly stop agreeing with the `evaluate` it mirrors, and
nothing type-checks the pair. `coverage.test.ts` is the tripwire: every registered type either
has an emitter or is named in `NO_EMITTER` with a reason.

### The softer half: warning that an export will have gaps in it

A refusal says the export is not worth making. Beside it, both surfaces now say how much of a
graph the walk **could not translate** — `⚠ 2 steps will be left as TODO` on a palette row, and
a sentence naming them under the Save menu's item. The row still works: an export with gaps in it
is worth having, which is why this sits *on* the item rather than replacing it the way a refusal
does.

**The only honest way to answer is to run the exporter**, and that is the decision the design
turns on. The obvious alternative is a static table of which node types emit in which language:
instant, main-chunk, and a mirror of two registries that nothing type-checks against them — the
`NO_EMITTER` shape, which works only because `coverage.test.ts` pins it. Worse, it could not see
most of what actually becomes a TODO. A cell comes out as one for five different reasons, and
only the first is a fact about the *type*:

1. no emitter for this language,
2. a backend the emitter was not written against (`emitterBackends`),
3. a required port nobody wired,
4. an upstream that was itself a TODO,
5. the emitter refusing on its own params — `Paths` with `Collapse types` on, a dataset that
   could not be resolved, a column nobody picked.

Running the real walk sees all five by construction and cannot drift. So both walks report
`todos: TodoStep[]` — recorded where `emittedTodo` already is, plus the unknown-node-type branch,
which `continue`s before that check and is the worst case there is, since it binds nothing and
blocks everything downstream. Reported as `{nodeId, label}` rather than recovered from the
finished document by scanning for `# TODO:`, which would be matching on prose.

**A walk clears only the guard it was started under**, which is the one thing about the in-flight
bookkeeping that is not obvious. `requestExportWarnings` replaces the `running` set *wholesale*
when a newer graph arrives, so a walk that outlived its graph and deleted its language from the
module binding cleared the **current** graph's guard — after which the next surface to ask saw no
answer and nothing running, and started a second exporter walk over a graph already being walked.
The set is passed in, so a walk can only ever clear its own. Not covered by a test, and that is
recorded in the file: reaching the window needs a hook between two `compute` continuations, and
vitest hands the *real* exporter to a second concurrent dynamic import of a mocked module, so the
walks cannot be counted or told apart. Two tests were written for it and both were vacuous under
mutation, which is worse than none.

**`src/ui/exportWarnings.ts` is the `peek*` contract again**, with one deliberate split:

- **`peekExportWarnings` starts nothing.** It is a cache read. `buildCommandItems` calls it on
  every store change while the palette is open, and a peek that kicked off a walk there would run
  one per change. Same rule, and the same reason, as `peekBases`.
- **`requestExportWarnings` is the half that works**, called when a surface opens — the Save
  menu's own mount, and an effect on the palette's `menu` state. It loads the exporters lazily,
  so `canExport.ts` being separate is preserved exactly: nothing here is reachable until somebody
  opens one of those two.

The answer is keyed on the graph **object**, which the store mints afresh on every commit, so a
stale answer is structurally impossible — a changed graph is a cache miss. A newer graph arriving
while a walk is in flight owns the cache when it lands, which is the same ownership check the
root-drift advisory needs and for the same reason.

**It names the causes and counts the cascade.** A TODO binds nothing, so everything downstream
of one is a TODO too — and telling somebody their Table node "has no notebook equivalent" when
the Table is fine and the Explore Dataset in front of it is not sends them to the wrong card. That is the
walk's own unwired-versus-blocked split carried out to the surface, through `TodoStep.blocked`.
On the FlyWire starter the difference is the whole message: *"Explore Dataset" has no notebook
equivalent, so it and 2 steps after it will be left as TODO comments* rather than a list of three
nodes, two of which translate perfectly well. A muted node also binds nothing, so a graph can
carry blocked steps with no untranslated root — then naming the blocked ones is the only true
thing left to say.

**It still does not say *why* each root is untranslated.** Those reasons are genuinely different
and every one is already stated in the document itself, beside the step it is about.

**The Description card emits a note rather than a TODO**, and that is what keeps the whole
mechanism from crying wolf. `ctx.todo` means "no code came out of this", which is true of a
credit card — and it also means "this step is missing from the translation", which is not. It has
no outputs, so it blocks nothing, and `core/companion.ts` puts one on **every** published dataset
node: counting it would have put a warning on essentially every graph anybody exports. Nothing is
lost by the distinction, since `todo`'s only other effect is withholding output bindings and this
node has none. It also declares `backends: ['neuprint', 'cave']` — not a claim that it emits
caveclient code, since it emits none, but that the *card* is backend-independent, which is what
stops the guard turning it into a TODO on every CAVE graph.

**+1,890 bytes on the main chunk**, measured — the module, both surfaces and the CSS. `main` still
matches neither exporter; both stay behind `await import`.

**Verified in a real browser** over CDP, because this is colour and wrapping: both surfaces, both
themes, no console errors. `--status-warn` resolves to `#fab219` on the dark panel (9.78:1) and
`#8a5e00` on the light one (5.41:1) — the token's own measured values, and the reason it is
per-mode at all, since the bright gold is 1.74:1 on light. The Save panel is **315px wide with no
warning and 313px with one**: the sentence wraps inside the width the descriptions already set, so
the menu does not jump between the two states. That was the thing worth pointing a browser at.

**Both surfaces now refuse the same way, and the change is per-format coverage.** The palette
closes on pick, so a refusal has always had to be `disabled` plus a hint — there is nowhere to
put a sentence afterwards. The Save menu used to do the opposite: let the click through and
replace the whole export block with a paragraph. That was right while one answer served both
formats and became wrong the moment they could disagree, because replacing the block also took
away the format that *would* have worked — a FlyWire graph builds a notebook and no R document.
So the menu now disables the row it cannot honour and puts the reason under it, which is the same
answer with more room. The reason renders at full strength while the row above it dims; taking a
4.5:1 colour to half strength is how a message nobody can read ends up on screen.

`--status-refused` exists for that sentence, and for `--status-warn`'s reason one colour over:
`--status-error` is one value for both modes, which is fine for a badge dot and not for prose at
10.5px — `#d03b3b` is 4.56:1 on the light panel and **3.73:1** on the dark one. No single red
clears 4.5:1 on both, so it is per-mode: `#c22f2f` light, `#e05c5c` dark, both measured against
the panel rather than the canvas.

**Two things are refused; everything else is a TODO.** Every other gap emits a TODO,
because the surrounding cells are still worth having. A `dataset.mock.*` connectome is generated
in the browser: no server, no token, no id that means anything outside the tab — so the _first_
cell is the one with nothing behind it, and what would come out is a notebook nobody can fix
without knowing which real dataset was meant. Note the consequence: **all four bundled examples
are refused**, which is why the golden files are built on `fixture.ts` rather than on them.

**The second is a dataset from a backend *this format* has no emitter for**, which today means
CAVE in R and nothing in Python. The same reasoning arriving from the other direction: the dataset
cell is the one with nothing behind it, and the walk cascades a TODO to every node downstream, so
what comes out is a document of nothing but TODOs. `DatasetFamily.notebook` is the single
statement of which families each exporter can be built for, read by `canExportNotebook` and by
both dataset emitter loops — it had to be, because those two used to disagree: the loops keyed on
the *source id* while the refusal tested `synthetic` alone, so a FlyWire graph passed the check
and produced exactly that document. It is deliberately not derived from `sourceId`, since what
decides it is whether an emitter exists, not where the data comes from — and it is keyed **per
language**, since the day that distinction stopped being academic has arrived.

**A third kind of TODO came with it, and it is not a refusal.** A node whose *own* cell has only
been written for neuPrint, on a graph whose dataset is CAVE, emits a TODO naming the backend —
declared once per emitter through `registerEmitter`'s `backends` rather than guarded in each of
the seventeen that take a Dataset. See *The CAVE half of the notebook exporter* below.

**The walk decides whether an input arrived; emitters never ask.** `ctx.wired(port)` returns a
plain `string` because the walk refuses to call an emitter whose _required_ ports are unwired or
blocked — and `ctx.input(port)` returns `string | undefined` for the ports declared
`required: false`, where absence is a real case. That split removed ~25 hand-written
`if (!ctx.input('in')) return ctx.todo('Nothing is wired…')` guards, each of which hardcoded a
port id as a string. It is the same bug `ports.test.ts` exists for: the walk reads the ids off
`def.inputs` and cannot mistype one, where an emitter did, for months. The two failures are also
reported apart — _unwired_ is a graph somebody has not finished, _blocked_ is a node this
translation could not emit, and conflating them sends the reader to fix a wire that is already
there.

**A TODO binds nothing.** `ctx.todo()` is the single channel for "no code came out of this", and
the walk reads it to decide whether to bind the node's output variables. Without that, a node
that could not be translated still bound its names and everything downstream emitted working
code referring to variables nothing ever assigned. Blocking then cascades with the upstream
node _named_, which mirrors the scheduler reaching `blocked` down exactly the same edge —
"nothing is wired to this" would send somebody to the canvas to fix a wire that is already there.

**One `Client` per dataset node, and every fetch names it.** neuprint-python has a global default
client and every call would find it, which reads more tidily and is wrong the moment a graph
carries two datasets: the second `Client(...)` silently becomes the default and every earlier
query starts answering from the other connectome.

### What was verified rather than assumed

Six findings, each of which was a wrong answer before it was checked:

- **`merge(...).drop(columns=[rightKey])` deletes the wrong column, half the time.** pandas
  suffixes a join's right key where its name collides with a left column (`postType_r`) and
  leaves it alone where it does not — so one spelling is correct in one case and silently
  destroys the left table's own column in the other. Measured against pandas 2.3. The Join
  emitter renames the right key to a scratch name before merging, which makes the drop knowable
  without the schema. See *Join* in `docs/nodes.md` for what Coda's own shape is, and note the
  pre-existing bug this exposed: the emitter never dropped that column at all, so every join
  with differently-named keys produced a notebook column the canvas did not have.
- **`left_on` and `right_on` naming the *same* column already yield one coalesced key column**,
  under `how='outer'` and `'right'` alike — so the common case needs neither a fill nor a drop
  and gets neither. That is what makes the branch worth having rather than always scratching.
- **R does not accept a trailing comma in `c()`.** `c(a = 1,)` is `argument 2 is empty`, which
  is a parse error in a document knitr aborts on rather than a wart. Python takes one in a dict,
  so the same generated shape one language over is perfectly legal — which is how it got
  written. Caught by running the chunk, not by reading it.
- **`df.sample(random_state=n)` is the wrong sampler.** It is a Mersenne Twister; Coda's Sample
  node is mulberry32. Same seed, entirely different rows — a notebook that silently disagreed
  with the canvas while looking perfectly reasonable. `coda_sample_rows` is the generator
  transcribed into 32-bit masks, and it was checked against the TS stream across five seeds
  before being believed.
- **`coda_search` was cross-checked against `runSearch`** over 23 queries covering the rules
  that are easy to lose: a missing value satisfying `!=` and nothing else, unanchored regex,
  negation, `1200` matching a neuron id but not a synapse count. Zero divergence. It is
  deliberately **matching only** — no relevance ranking and no fuzzy fallback — and the
  docstring says so, because both change which rows come back where a result is capped.
- **`import navis` does not expose `navis.interfaces.neuprint`.** The package root does not
  import `interfaces`, so the obvious spelling is valid syntax, a well-bound name, and an
  `AttributeError` at runtime. Hence `import navis.interfaces.neuprint as neu`.

The first three were established by **running the emitted code against pandas 2.3 and dplyr 1.2
and comparing row-for-row with the op it mirrors** — all four join directions and both
key-naming cases. That pass also turned up a divergence that is being *kept*: dplyr's
`right_join` orders matched rows by the left table and unmatched right rows after them, where
Coda emits one row per right-table row in the right's order. The rows are identical, so the
chunk says so in a `NOTE` rather than adding a row-number column to arrange on and drop.

Every signature the emitters produce was read off **neuprint-python 0.6.3** and **navis 2.0**
by introspection, not recalled. Two that surprise: `fetch_neurons` returns a _pair_ (neurons,
roi_counts), and there is no `fetch_mesh_neuron` in neuprint at all — meshes are navis's, which
is also where the `lod` argument the `Detail` param maps onto lives.

### Testing, and the half golden files cannot do

`export.test.ts` writes `__fixtures__/everything.ipynb` from `fixture.ts` — one graph wiring up
every emitting type — and compares. Regenerate with `pnpm export:golden` and **read the diff**;
that is the whole point of the format.

**An emitter addresses its ports by string, and that is the registry's real cost.** `ports.test.ts`
runs every emitter against a context that records what it asks for and answers everything, then
checks the ids against the definition. It was written after `out.profile` was found reading an
input called `in` on a node whose port is `neurons` — so it reported "nothing is wired to this
Neuron Profile" for a node plainly wired on the canvas, and had done since it was written. It found four
more the same day: `out.scatter` _wrote_ `scatter_plot_table` while the walk bound
`scatter_plot_out`, so anything downstream referenced a variable nothing assigns; `out.neuroglancer`
bound a DataFrame to a port the graph types as a URL; and `out.viewer3d` was written as a
pass-through when it has three optional geometry sockets and emits only the selection. None of
these fail a type check, none produce invalid Python, and the golden file recorded every one of
them as correct.

**The fixture is checked too, and that is why they hid.** `everythingGraph` had wired the 3D
viewer to a socket it has never had — `addEdge` takes the handle it is given — so the export
said "nothing is wired", and the golden agreed. A fixture whose coverage is a claim rather than a
fact is worse than no fixture, because it is what everything else is checked against. So
`export.test.ts` now asserts that every fixture edge lands on a declared port _and_ that the
fixture reaches every emitting type. The second is what forced all six dataset families in
rather than `hemibrain` alone: they share one generated emitter, but `mushroombody` carries no
version in its dataset id and `neuron.dataset` reads its id from a param, and neither branch is
reachable through `hemibrain`.

**A snapshot cannot tell whether the Python is valid**, which is exactly how the navis bug got
in. `scripts/check-export.py` is the other half, in three passes: syntax, undefined names, and
attribute resolution against the _real_ installed libraries. The third is the one that earns the
script and the only one that can catch an import that does not expose what it looks like it
exposes; it is skipped with a notice where the libraries are absent, and `--strict` turns that
skip into a failure so a check that did not run cannot report success. Nothing is ever executed —
that would need a token and a network.

It runs in its own workflow (`.github/workflows/export.yml`) rather than in `deploy.yml`,
path-filtered to `src/export/**`: `pip install navis` is minutes against a deploy pipeline that
is otherwise well under one, and it is only ever worth paying when the exporter changes.

### The CAVE half of the notebook exporter

`src/export/python/emitters/cave.ts` and `caveHelpers.ts`. A FlyWire graph now exports as a
Jupyter notebook built on **caveclient, sea-serpent and pandas**, where before it was refused
outright.

**Every signature was read off caveclient 8.2.1 by introspection**, and three are not what an
experienced user would guess:

- **`CAVEclient(datastack, version=N)` pins the materialization for every later query** *and*
  sets `client.timestamp` to that materialization's instant. That is what makes the dataset cell
  the only place a version appears, and it is what `Update root IDs` asks its chunkedgraph
  questions *at*.
- **`client.materialize.version` reads back off the frameworkclient** rather than holding its own
  (`if self.fc is not None and self.fc.version is not None: return self.fc.version`). Checked in
  the source, because the alternative — a `materialization_version=` on every call — is a lot of
  argument for something that would silently query "latest" if the inheritance did not hold.
- **There is no token argument.** caveclient reads `~/.cloudvolume/secrets/cave-secret.json`,
  written once by `client.auth.setup_token()`, where neuprint-python takes one per client.

#### The refusal is per language now, and the policy is still one

`DatasetFamily.notebook` was `'neuprint' | undefined` and is now
`{ python?: …; r?: … }`; `canExportNotebook(graph, language)` takes which format is being asked
about. Forced rather than chosen: R's route into FlyWire is `fafbseg`, which wraps FlyWire
specifically rather than CAVE generally and has no emitter here — so one flag for both formats
would either refuse an export Python can produce or offer an R document of nothing but TODOs. The
palette asks twice and the two rows disagree, which is the honest state.

`src/export/fixture.ts` gained a **second graph** for the same reason: a CAVE node in
`everythingGraph` would make R refuse the whole thing and leave its golden with nothing in it.
`caveGraph` is exported as its own notebook and asserted to be *refused* on the R side.

#### A backend an emitter was not written against is a third kind of TODO

Seventeen Python emitters take a Dataset, and all of them are neuprint-python. Left alone, a
FlyWire graph would emit `fetch_neurons(..., client=<a CAVEclient>)` — valid Python, plausible
reading, an `AttributeError` at best and a wrong answer at worst.

So `registerEmitter` takes `{ backends }`, **defaulting to `['neuprint']`**, and the walk turns an
undeclared backend into a TODO naming it. Declared at the registration rather than guarded inside
each emitter, which is the call `emit.ts` already makes about unwired ports: seventeen
hand-written guards is seventeen chances to forget one, with nothing failing when somebody does.
The default is the narrow one deliberately — a new emitter that says nothing refuses a backend it
was never tested against.

The backend is read off `def.inputs` (any port whose declared type is `dataset`) rather than by
asking for a port called `dataset`, which is the bug class `ports.test.ts` exists for. An
*unresolved* dataset type refuses nothing: no `sourceId` is invariant 2's ordinary state on a cold
session.

#### A reference port yields no variable, and sometimes cannot

`referencesFirst` hoisted every referenced node to the front so a cell naming one would find it
bound. That is wrong for the wiring references exist for: in `CAVE table → Update root IDs →
Dataset` the dataset **consumes** both nodes referencing it, so hoisting it above them classified
it `blocked` by its own annotations and cascaded a false TODO to everything downstream — the very
failure the hoist was added to prevent, arrived at from the other side.

Two changes, and they are a pair:

- **Only a node with no dataflow inputs is lifted.** That is not a precaution, it is the condition
  that makes a reference sound in the first place — the referenced node's identity comes from its
  params alone — made checkable.
- **The walk does not treat an unbound reference port as blocking.** A reference is not a value
  dependency, so an emitter reading one falls back to the referenced node's *type*, which is all a
  reference ever promised.

`clientFor` in `cave.ts` is that fallback, in one place so the two readers cannot drift: the
bound variable's `.client` where the walk bound one, and a fresh `CAVEclient` built from the
reference's type where it did not. The golden covers both branches.

#### What a Coda Dataset is on CAVE, and why it is not a bare client

The neuPrint dataset cell binds a `Client`. This one binds a generated `CodaCaveDataset`, because
a CAVE dataset value is a client **and** a neuron table: the datastack's labels live in an
annotation table, and anything wired to the Annotations socket *replaces* them. One Python name
has to carry both.

**`labels` is fetched on first use, not at construction**, which is the point of the class rather
than a tuple. A graph that only cleans an annotation table never asks for the index, and on
FlyWire that is 139,255 rows over six queries.

#### The helpers, and the one that ran before it was believed

`coda_cave_neurons`, `coda_cave_table`, `coda_cave_tables`, `coda_cave_table_info`,
`coda_seatable`, `coda_join_annotations`, `coda_update_root_ids`, `coda_int64` — each mirroring a
specific piece of `src/data/cave` or `src/data/annotations`. Two
rules came across that produce a plausible wrong table rather than an error, and both are
transcribed rather than reinvented: the annotation table is read **one kind at a time** (the whole
of `hierarchical_neuron_annotations` is over CAVE's 500,000-row cap, which the server applies by
*truncating*), and a chained source **wins a collision falling back to the earlier one where it
has no value** — a coalesce rather than a replace.

**The discovery pair carries three things that were read off caveclient 8.2.1 by *running* it,
not by reading the annotations.** `get_views` is annotated `-> list[str]` and returns a **dict**
keyed by view name, so anything that indexed it would raise a `KeyError` from a signature that
promised otherwise; `sorted()` reads the keys either way, which is why this is a note in the
helper rather than a workaround. `query_table(..., split_positions=True)` is what makes the column
listing agree with Coda's — caveclient's default folds a bound point back into one object column
(`pt_position` holding an array) where the app's raw query args ask for `pt_position_x/y/z`, and
the two answer ten columns and sixteen against the same table. And the **two row counts** are two
methods on two sub-clients — `materialize.get_annotation_count` and
`annotation.get_annotation_count` — which is the clearest statement anyone has written of a
difference [backends.md](backends.md) records as having cost a debugging round trip; the notebook
prints both, labelled, as the card does.

The `type` column there reports the **pandas** dtype rather than Coda's four-name vocabulary, and
that is deliberate. `pt_root_id` is `Int64` in the notebook and `str` in the app, and both are
true of their own runtime — pandas holds an eighteen-digit id exactly where a float64 cannot,
which is why the app carries it as text (invariant 8). A notebook claiming Coda's answer would be
describing a frame the reader does not have.

**`merge_reference=False` is passed explicitly and the join is written out.** caveclient will
merge a reference table with its target for you and that is very likely the tidier call; it was
not verified against a live datastack, and a silently different frame is exactly what this
exporter refuses to guess at.

**`pd.to_numeric` is the wrong function for an id column, and it fails silently.** On a clean
column of decimal strings it answers `int64` and is exact — and one null anywhere, which a
supervoxel column has by design, forces `float64`: `720575940628857210` comes back as
`720575940628857344`, a **different neuron**, with every later comparison wrong about a value
nothing flagged. `coda_int64` parses per value with Python's `int`, exact at any width.

That was found by **running** the helpers, on the first try, and it is why
`scripts/probe-py-helpers.py` (`pnpm probe:helpers`) exists. It reads the generated helper cell out
of the golden notebook and exercises it against a stub client — `probe-nblast.mjs`'s idiom one
language over, and for its reason: the golden says the text is unchanged and `check-export.py`
says it parses and its module attributes resolve, but **nothing else executes a line of it**, and
every one of these helpers is pandas. It runs in `export.yml` and is the only step there that
executes generated code. Reading the code did not catch the bug; running it did.

#### What it costs, and what is not covered

**+281 bytes on the main chunk**, measured against a build of the same tree with the feature
stashed out — the family table's one field and the refusal's stack names. Everything else is in
`exporter-*.js`, which stays lazily loaded; `CodaCaveDataset` appears nowhere in `main`.

#### The query half, and why it was nearly free

**Explore Dataset and Find Neurons emit for CAVE**, and the reason is that neither is really a query on
this backend. A CAVE datastack has no server-side neuron search — its API has no regex worth
using — so `CaveSource` downloads the index once and filters it locally, and the notebook does
the same over the same frame. `coda_search` is already a port of Coda's matcher and does not care
where the frame came from, so **Explore Dataset's CAVE branch is one line**: `dataset.labels` instead of
`fetch_neurons(NeuronCriteria(...))`. That is why they were the first two written — on a FlyWire
graph Explore Dataset is usually the only thing between the dataset and everything else, so a TODO there
blocked the whole notebook.

Find Neurons is the same frame with pandas filters on it, and the filters are **Coda's semantics
rather than pandas' defaults**. Both backends now go through `filterMasks` — the compiler
`out.table`'s header filters already used — so the null rule (a missing value satisfies `!=` and
nothing else) and per-term case handling arrive written out rather than approximated, and a
`matches` row is anchored at both ends because that is what Neo4j's `=~` does.

On neuPrint the node **partitions its rows**: what `NeuronCriteria` can carry goes into the query,
and the rest becomes a mask on the result — same rows, one larger response, said in a NOTE. That
partition is only ever valid because rows are ANDed; each is independent, so any subset can be
pushed down and the remainder applied afterwards. One OR group would break it, and is most of why
there is not one. `NeuronCriteria` has no disjunction at all.

**The row model retired a bug this exporter had recorded rather than caused.** Find Neurons'
`status` used to default to `Traced` while its picker on a CAVE dataset offered only `Any`
(`statuses: []`), so the default survived into the request, `CaveSource` dropped every row, and
the node answered nothing without anybody having chosen a status. The CAVE golden carried a cell
reproducing it and a NOTE naming the fix, because a notebook that returned nothing silently would
send the reader to look at their datastack. That cell is simply gone from the golden now: a fresh
Find Neurons carries no rows, and a status is a field a CAVE datastack does not publish, so there
is nothing for the card to offer and nothing for the notebook to reproduce.

**`selectionIds` answered `number[]`, which is invariant 8 at a seam nobody had looked at.** A
stored id is a string of digits and `Number('720575940628857210')` is `…216` — a different neuron,
written into a notebook with nothing to say so. Harmless while every exportable dataset was
neuPrint, and live the moment a CAVE selection could be exported. It answers exact text now, and
`pySelection` pairs it with `pyLongIntList` in one place, because `pyValue` would *quote* a string
and `isin(['1001'])` against an `i64` column matches nothing at all.

Still not written, and each declines with a TODO naming the backend rather than emitting neuPrint
code: **Connectivity, Adjacency, Skeletons, Meshes, Synapses, Neuron Profile, Dataset Summary, ROI Viewer,
Neuroglancer**. The table ops downstream are backend-agnostic and already work.

#### SeaTable, through sea-serpent

`annotation.flyTable` and `annotation.seaTable` emit too, on
[`sea-serpent`](https://github.com/schlegelp/sea-serpent) — one registration each over one
emitter, exactly as the nodes are two registrations over one implementation. Everything below was
established **live against FlyTable**, not read off a README.

- **`Table(name, base=…)` resolves the base itself** by enumerating the account's workspaces
  (`find_base`), so Coda's `Workspace` param has no argument to map onto — it exists because the
  REST API addresses a base by workspace *and* name, which is bookkeeping sea-serpent does for
  you. Where one is set on the canvas the cell says so rather than dropping it silently.
- **`to_frame()` rather than `query()`, and the reason is dtypes.** sea-serpent sanitises on the
  way out: a text column stays text — so an eighteen-digit root id arrives exact under pandas'
  `string` dtype, which is the whole of invariant 8 at this seam — a date column becomes
  datetimes and a checkbox becomes booleans, which is `dtypeFor`'s mapping and better. `query()`
  hands back raw records and loses all of it.
- **The `query` narrowing is offered as a comment where `Columns` is set.** Measured live:
  `to_frame()` is **3.3 s** for all 52 columns of `main.info` (58,340 rows, ~134 MB in memory)
  against **0.8 s** for three through `query(..., no_limit=True)`. Worth having and not worth
  defaulting to — and note this is the one place the notebook is simply *unblocked* where the
  canvas is not, since `/dtable-db/api/v1/query/` sends no CORS headers at all.
- **`query` auto-appends `FROM {TABLENAME}`**, so anything following the column list — a `LIMIT`,
  a `WHERE` — needs the `FROM` written explicitly or the server answers `parse error: unexpected
  LIMIT`. Backticked names are accepted, which is what makes a generated column list safe.
- **sea-serpent names its columns with numpy `str_`.** They index fine and read oddly anywhere the
  column list is printed, so `coda_seatable` normalises them.

**The generated FlyTable cell was run verbatim against the real base**, helpers and all, and
reproduces what the canvas reports: 58,340 rows, **56,309 distinct ids** — the same duplicate
count recorded above — every id text, exact at eighteen digits, and all 58,340 beyond double
precision.

**The credential is `SEATABLE_TOKEN`**, which sea-serpent reads from the environment itself and
the cell passes explicitly anyway, so what it needs is visible. Two deployments are two unrelated
accounts, so a graph reading both wants two tokens and one env var cannot serve them; each cell
names its `server=`.

#### What has not been run

**Nothing has been run against a live CAVE datastack.** `CAVE_TOKEN` is absent here, so for that
half what is verified is the signatures (against the installed caveclient 8.2.1), the syntax and
name resolution (`check-export.py`), and the pandas (`probe-py-helpers.py` against a stub). The
wire format is `src/data/cave`'s business and is covered by `live.test.ts` there. The SeaTable
half *has* been run live, as above.

### The R Markdown exporter

`Save ▸ Export as R Markdown` writes the same graph as an `.Rmd` on **neuprintr, dplyr, nat,
ggplot2 and igraph**. `src/export/r/`, lazily loaded exactly like the notebook exporter, and it
gets its own chunk (`exporter-*.js` × 2 — verify both stay out of `main` with `pnpm build`).

**The two exporters share the fixture graph and the refusal policy, and nothing else.** The walk
is a **copy**, taken deliberately: a change to how R chunks are assembled cannot reach the
notebook. The cost is real and is the thing to watch — topological order, variable naming,
unwired-versus-blocked and where the notes land now exist twice, so **if you fix one, look at the
other**. What stops them drifting on *coverage* is `src/export/fixture.ts`: `everythingGraph`,
two golden files, and a node that emits Python but nothing in R shows up as a TODO rather than as
a document nobody noticed was shorter.

**The one place they have parted company is the backend.** `caveGraph` is the second fixture and
R refuses it outright — `canExportNotebook` is asked per language now, and
`DatasetFamily.notebook` names a client per language. That is a real coverage gap rather than a
loophole, and R's `export.test.ts` asserts the refusal so it cannot become a silent one; see
*The CAVE half of the notebook exporter* above. The refusal message points at the notebook, or
"no document can be built" reads as "Coda cannot export this at all".

**R's stack is the same lineage, which is why the mapping is clean** — navis is the Python port
of `nat`, and neuprintr is the natverse's neuPrint client. Three things are genuinely *better*
here: `neuprint_connection_table()` is query-relative, which is the shape Neuron Profile wants (so the
Connectivity emitter reorients *into* pre/post, the opposite direction to the Python one);
`neuprint_get_paths()` takes a hop budget, which `fetch_shortest_paths` does not; and
`neuprint_ROI_connectivity()` maps straight onto the ROI Connectivity node.

**One capability is missing outright: neuron meshes.** `neuprint_ROI_mesh()` reads ROI shells,
not neurons, so `neuron.meshes` emits a TODO pointing at the Skeletons node.

Four R-specific traps, each of which produces a document that looks right:

- **`neuprintr` publishes `bodyid`; every Coda table uses `neuronId`.** `df$neuronId` on a tibble is
  `NULL` rather than an error, so the mismatch travels silently until something reports zero
  neurons far from the cause. `coda_neurons()` normalises at every neuprintr seam; the helpers
  that read raw `neuprint_connection_table()` output keep its own names, which is the one place
  `bodyid` is correct.
- **`neuprint_fetch_custom` names columns after the RETURN expressions**, so a query without
  `AS` yields a column literally called `n.bodyId`.
- **knitr aborts a render on a duplicate chunk label**, which nothing in R's parser sees. Labels
  come from the walk's already-deduplicated variable names for exactly that reason, and
  `export.test.ts` asserts uniqueness.
- **A variable named `filter` or `select` masks the dplyr verb the next chunk calls** — and those
  are literally two node labels. `rIdent` suffixes `_df`; Python's builtin shadowing is a
  nuisance, this one breaks the document.

**`neuprintr` is not on CRAN**, so the setup chunk emits `remotes::install_github` for it and
`install.packages` for the rest — one line covering both would fail on the package the document
cannot run without.

**The R sample reproduces Coda's draw exactly**, and getting there needed care: R has no
unsigned 32-bit integer and `bitwOr` returns `NA` above 2^31, so mulberry32 runs in doubles with
explicit modulo and the two `|` operations are done arithmetically. Checked against the same JS
reference stream as the Python port — five seeds, identical.

`scripts/check-export.R` is the counterpart of the Python checker: it parses every chunk,
catches duplicate labels, and resolves functions where the packages are installed (skipped with
a notice otherwise, `--strict` to fail instead).

### Neuron Profile exports its metrics

`out.profile` is the one viewer whose translation is worth more than a pass-through, because
almost everything the card _shows_ is an ordinary roll-up rather than a drawing.
`coda_profile(body_ids, client, min_weight, top_n)` returns the tiles as named frames —
`summary`, `upstream_types`, `downstream_types`, `top_upstream`, `top_downstream`, `regions`,
`hemispheres` — ported from `nodes/lib/profileStats.ts`.

**It costs three requests however many neurons are asked for**, because `fetch_adjacencies` and
`fetch_neurons` both take the whole id list. The widget pages one neuron at a time and pays
three per neuron _viewed_, so the notebook can do the entire table for the price of the pinned
one — the emitted call passes the pinned neuron because that is what the canvas was showing,
and widening it is editing one argument. This is the one place the export is straightforwardly
better than the thing it exports.

Four rules came across with it, each of which produces a plausible wrong number rather than an
error, and each was cross-checked against the TS rather than trusted: untyped partners keep
their own bucket (merging them puts a fictitious type at the top of the list on male-CNS);
synapses are summed _and_ distinct partners counted, because forty synapses onto one neuron is
not forty onto forty; `roiInfo` nests, so regions are filtered to `fetch_primary_rois` before
summing or the totals roughly double; and a null type sorts **last** on a tie, matching
`collate`, which `na_position="last"` reproduces.

### Known gaps, all of them stated in the notebook

- **`Paths` with `Collapse types` on has no equivalent, and this one is not laziness.** Coda
  traverses the _type-collapsed_ graph, which finds `LC4 → PLP1 → DNp01` even where no single
  PLP1 neuron both receives from an LC4 and projects to a DNp01 — not recoverable by collapsing
  a neuron-level result afterwards, because the neuron-level search never returns either edge.
  Cypher cannot walk a derived graph without GDS, so neither `fetch_shortest_paths` nor
  `fetch_paths` can express it. Neuron-level mode exports.
- **The Network Viewer hands over a `networkx` object with the layout commented out.**
  ForceAtlas2 has no drop-in twin, `spring_layout` is a different algorithm, and the
  hierarchical layouts need graphviz — a system package a generated notebook has no business
  requiring. Three options are offered as comments.
- **Upload Table names its file rather than carrying it.** The rows live in IndexedDB, so a
  `.coda.json` already arrives without them; the notebook emits `pd.read_csv("<filename>")`,
  which is the same accepted cost with the same honest statement of it.
- **Neuroglancer** emits a note: the URL is built from a published scene, which is a fetch this
  translation does not make.
