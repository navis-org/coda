# The assistant

Ask for a change in words; get a graph. `src/assistant/` is the headless half — the prompt, the
plan format, the applier — and `src/data/ai/` is the transport. `src/ui/panels/AssistantPanel.tsx`
is the drawer, and it is the only part that touches the store.

Two documents already cover the ends of this: `docs/ollama.md` is the user-facing setup, and the
long entry in `_TODOs.md` is the running log. This page is the middle — **what the model is told,
and how each thing it is told came to be there**, because every one of them was added after
watching a plan go wrong in a specific way, and the measurement is the part that does not survive
in a diff.

## The one decision everything else hangs off

A plan is a *description of an edit*, not a sequence of tool calls. `applyPlan` checks it whole and
the store commits it once, so the canvas only ever holds a graph the type system already accepted
and ⌘Z takes the whole edit back. Tool calls would put a half-built graph on screen, validated one
step at a time, with an undo step each.

That choice is why this page is mostly about **the prompt**. When the model gets something wrong
there is no loop to fix it in — there is a refusal, one repair round, and whatever the prompt said.
So the prompt is the product, and the work is finding out what it fails to say.

## Two halves, and the split is type versus instance

The system prompt is the **cached prefix**: rules plus a catalogue generated from the node registry.
It must stay byte-identical between calls — Anthropic caches it, and llama.cpp reuses the KV cache
for the longest common prefix, which is a 27x difference on the first question of a session
(120 s → 4.4 s). Anything per-request goes in the **user turn** instead, where `describeGraph`
renders the canvas.

Everything below is an instance of one question: *is this fact about the node type, or about this
node as it is wired right now?* The catalogue gets the first, the graph listing gets the second,
and getting it wrong is how a fix lands that measures as no improvement at all.

## What the model is told, and what each line cost to learn

### Columns a port carries — `carries:`

Inference says what a port holds, so a Bar Chart fed by a Connectivity node can have its category
and value set rather than left blank. The catalogue under-reports (a node type does not know what a
dataset adds) and `describeGraph` corrects it per node.

**The gap that closed it:** `describeGraph` called `inferGraph(graph)` bare while the store called
`inferGraph(graph, { observedSchemas })`. After a run the app knew a Pivot's real columns and told
the assistant nothing, and the rules then instructed the model to leave the picker alone — advice
that was only correct because of the omission.

### Values a run produced — `ran:`

The other half of "can it inspect results", and it needed no tool either. The remaining questions —
which value to filter on, what a threshold should be, why a table came back empty — are all
**aggregates**, and aggregates can be pushed into the prompt where rows would have to be asked for.
`src/assistant/digest.ts`, ~1.7k characters on a fully-run seven-node graph.

Measured, on the case that cannot be answered any other way — *filter to the commonest partner
type*:

| | plan |
| --- | --- |
| with the digest | `postType \| eq \| PVLP002` — one node, no warnings |
| without | five nodes, six wires, two warnings, and no value at all |

The control is the interesting half. It did not guess wrong; it built a Group By, a Sort and a
filter, trying to *compute* what it could not be told, and left the pickers unfinished.

Four rules keep it from being confidently wrong, and each has a test that fails when the guard is
removed: only a **fresh** node answers (a stale cache entry describes a graph that no longer
exists, in a line that reads like a current one); a folded value list **names its total**
(`61 distinct, 8 commonest`, or eight read as all of them); the **id column is counted and never
listed** (invariant 8, from the one direction that has no type to stop it); and the arithmetic is
`describeOps`', so the median a plan is built on and the median the Describe card shows are the
same number by construction.

Three things only a measurement found: a passthrough chain summarises identically at every step and
emitted one block four times; a key column downstream of a Group By spent a third of every line on
the number `1`; and a Dataset value's line restated its own node type.

### Operators, by column type — `catalogueNote`

`core.filterTable`'s `op` options are a function of the chosen column's dtype, so the catalogue can
only say `(options depend on the input)`. Told that, a model wrote `op: "is"` — which is the
**label** of `eq`. Told nothing at all, it left `op` unset and inherited the numeric default `ge`
on a text column. Both apply, and both leave a warning on a card the user has to find, because
`validateParamValue` skips dynamic options by design.

`operatorVocabulary()` in `nodes/lib/tableOps.ts` writes the vocabulary out, **generated by calling
`opsForDType`** so a new operator cannot go missing from it — `filtersNote()`'s rule on
`findNeurons.filters`, for the same reason. It rides on `catalogueNote`, one of the few things
`lean` keeps, because a note says how a value is *written* rather than what it means.

**Worth a note only where the vocabulary is closed and known to the type.** ROI names,
materializations and a file's columns are not — there is no static union to print, which is what
the per-node line below is for.

`SkeletonRouteId` and the synapse-unit tuple are, and they are the sharpest case, because their
options function is *both* dynamic and peeking: `optionLines` refuses it (see
`optionsWithoutPeek`), so without a note there is no legal value anywhere in the prompt. Asked for
skeletons "from the level-2 cache", a model wrote `"level-2"` five times, `"level2"` three and
`"L2"` once in ten runs. The id is `l2`.

| skeleton route, 10 runs each | wrote a real id |
| --- | --- |
| without the vocabulary | **1/10** |
| with it | **10/10**, every one `l2` |

`skeletonRouteVocabulary()` and `synapseUnitVocabulary()` live beside their tables in
`data/skeletonRoutes.ts` and `data/synapseUnits.ts`, generated from them, so a route added later
cannot go missing. Both lean on Automatic: empty is the default and almost always right, and a pin
is a provenance decision somebody has to have asked for — a route the dataset lacks is an error,
never a substitution.

### Live options on this node — `options:`

The instance half of the same problem: `optionLines()` prints what a param actually offers on the
node as it stands. It covers *editing*, where the note covers *adding* — a distinction that only
showed up when the note was missing and the first fix measured as no help at all.

**Not every dynamic param may be resolved, and that is a safety property.** `dataset.*.version`
reads `versionsFor` → `peekDatasets`, one of the two peeks that *start the fetch they cannot
answer*, so a listing that resolved everything would fire a dataset listing per dataset node — at
two CATMAID servers and CAVE — because somebody typed a question. Hence `optionsWithoutPeek`, an
**opt-in** flag: the unsafe default fails invisibly and remotely.

Two things about it are load-bearing. It is **named for the negative**, because almost every
dynamic options function is "derived from the input" in an ordinary reading, `dataset.*.version`
included — a positive name is set correctly by its own wording and wrongly by its contract. And the
pin **watches the deny-listed methods by name**, not `fetch`: `skeletonSourcesFor` starts its probe
through an `await` chain that bails before any request in a fresh process, so a `fetch` spy stays
green on exactly the param that proved the flag needed the rename. That param — `skeletonSource` —
was flagged on day one and is not any more.

An empty option prints as `""` and never as a word: four of these params default to it, so it is
the commonest *correct* answer, and `(empty)` goes into a plan verbatim and is refused.

### Which input a picker reads — `(reads the annotations input)`

**The first change here with evidence that it helps rather than merely costs nothing.**

Asked to label a dendrogram's leaves by cell type, a model set `labelColumn` and wired nothing:
*"Configure the dendrogram to use the 'type' column for leaf labels"* — `0 added, 0 wired, 1 set`.
The value is right and the picker is inert because `annotations` is empty. Nothing refuses it: an
unwired optional port is an ordinary half-built graph. A plan that looks finished and does nothing.

`ColumnParam.from` had named the port all along and was simply not rendered.

| dendrogram case, 20 runs | pass |
| --- | --- |
| without the hint | **5/10** |
| with it | **10/10** |

**Only for an optional port.** 97 column params read a required input, where the model has to wire
it to use the node at all, so saying so spends 2.4k characters repeating what the port list already
forces. Sixteen read an optional one, across eleven node types — `out.viewer3d`'s four colour
pickers, `net.build.nodeKey`, both `cluster.*ToNeurons` matchers — and those are exactly the params
that can be set while the port stays empty.

### What switches a param off — `(not with agg=count)`

Building a chart from scratch, a model set `core.groupBy`'s `agg: 'count'` **and** its
`value: ['weight']` — count the rows, and also aggregate a column. `value` is
`visibleIf: (params) => params.agg !== 'count'`, so `applyPlan` refuses the whole plan, correctly:
dropping the param quietly is the silent success that module is arranged to avoid. The repair round
was handed the exact error and made the same mistake again. About one run in ten.

The gate was rendered nowhere, so the two read as independent settings.

**Derived by probing the predicate, never transcribed.** `visibleIf` is an arbitrary function, so
there is nothing to read — but there is something to ask: hold every other param at its default,
flip one through its own declared values, and see whether this param's visibility moves. What comes
out cannot drift from the gate `configurableParams` enforces, because it *is* that gate answering.

| pipeline case | failures |
| --- | --- |
| without gate notes | 1/10 |
| with them | **0/20** |

137 params carry a `visibleIf`; **93 answer to a single flip**. The rest — gates needing two params
set together, or reading something the probe cannot enumerate — stay silent, which is the same
"unknown, never none" a missing `carries:` line means. Static enums, booleans and the is-it-set-at-all
case for `string`/`column` are probed; a dynamic `options` function is skipped for
`optionsWithoutPeek`'s reason, and a `multiEnum` would mean enumerating a power set.

### Which node fills a port — `comes from`

Two nodes compose because one makes what the other consumes, and **nothing in the catalogue could
say so.** `isAssignable` ignores schema, so `Compare Connectivity`'s Labels port and `Match Cell
Types`' labels output are both `Table{?}` and the pair is invisible. Asked to compare connectivity
for one cell type across three connectomes, a model built the whole chain correctly and then wired
each dataset's *own* neuron table into Labels — five runs out of five, on an empty canvas. Nothing
refused it: the plan is structurally perfect, and the comparison it describes is meaningless.

`PortDef.producedBy` is the declaration; `producerLines` renders it. What is worth recording is the
ranking, because it is not the one the sizes suggest — five runs each, `gemma4:31b-cloud`:

| what the model was told | runs |
| --- | --- |
| nothing (the port is `Table{?}`) | 0/5 |
| the port declared as `Table{neuronId, label}` | 0/5 |
| `def.guide`, whose first sentence names the node, for +35k characters | 1/5 |
| `labels1 (Table{?}) [from compare.matchTypes]` in the port list | 0/5 |
| `labels1 comes from compare.matchTypes (Match Cell Types): add one and wire its labels1 output here.` | **6/10, 7/10** |

**So it is not an information gap.** The fact was on the page, on the very port, and was ignored
nine times in ten. What the model reads is the line-per-fact block under the ports — the one `RULES`
teaches it to read for `carries:` — and what it acts on is a whole sentence saying what to *do*.
Declaring the schema was actively worse: the model started hand-rolling `core.select` and
`core.rename` to manufacture something label-shaped rather than reaching for the node that already
emits it. The ceiling is 3/3, which naming the node in the request has always got, so this was
discovery and never capability.

Rendered at `lean` as well as `full`, per that level's rule: a fact a plan can be wrong about, not
what a setting means. Both halves are checked against the registry by a test rather than by
`registerNode`, since a producer may register after its consumer.

It is a `{ type, port? }` pair rather than a bare type, and `port` defaults to this port's own id.
The bare form looked sufficient on the only member that exists — and cannot express the obvious
second one: `neuron.partnerVectors` wants the same declaration on a port called `labels`, fed by
`compare.matchTypes`' `labels1`. **That second member is deliberately not declared yet**, because
every number on this page was measured and that one has not been.

**A second line borrows that shape, and is deliberately labelled unmeasured.**
`PortDef.exclusiveGroup` says that a node's optional inputs are *alternatives* rather than a set
that composes, and `exclusiveLines` renders it in the same block, in the same imperative form:
`wire exactly one of: matrix, features, neighbours — they are alternatives.` One node declares a
group today (`core.embed`), so five runs per side would be measuring one prompt line against the
noise of a single case, and the honest thing is to say so rather than let the numbers above rub
off on it.

What makes it worth shipping unmeasured is that it is the *cheap* half of a loop that already
closes: `applyPlan` type-checks a plan and accepts two of those wired, and the advisory round
below is what then hands back the node's own `validate` line naming the port to disconnect. The
same fact reaches the model twice, once before the plan and once after — which is not true of
`producedBy`, whose absence produced a graph nothing complained about.

### A plan that is legal and still wrong — the advisory round

`applyPlan` checks types, ports, params and cycles. It cannot check meaning, and the case above is
what that costs. Meanwhile the node's own `validate` had the exact sentence — *"wire the matching
Labels table from Match Cell Types"* — and **nothing in `src/assistant` read node issues at all.**

So `runTurn` now previews each plan with the pure `applyPlan` and spends its one repair round handing
back what that plan leaves on the cards. Five rules, each of which the obvious version gets wrong:

- **The list is `ApplyOk.warnings`, not a second walk.** This started as a before/after diff of two
  bare `inferGraph` passes, and every part of it already existed: `collectWarnings` runs the
  inference once inside the `applyPlan` the caller has just made, and its header states the same
  premise. Two walks had already drifted on how a node is named and on whether `severity` survives —
  so the user's warning list and the model's are now one list.
- **Scoped to what the plan touched**, which is the precise version of what the diff was
  approximating: added nodes, `setParams` targets, and both ends of every wire. A node the plan
  wired into is therefore reported even for a complaint it was already making, which is right —
  the plan is about that node. A graph complaining three nodes away is not this turn's doing.
- **Column issues are dropped** (`NodeIssue.aboutColumns`, set by `validateColumnParams` and nothing
  else, carried through `ApplyWarning`). The model has already been told a column it cannot know yet
  is fine; raising them again contradicts the system prompt, and on a live build there were four to
  six of them around the one actionable line — which is how the actionable line gets ignored. The
  panel still renders them, because the card is where you *see* that a schema is late.
- **Held, not applied.** The plan is valid and is kept, so the whole turn stays one commit and one
  undo step, and the prompt has to say the graph is *unchanged* — a model told its edit landed sends
  a diff against a graph that does not exist.
- **Doing nothing is an answer.** It is a warning, not a refusal, so an empty plan means "these are
  all fine" and the held plan is used. Without that the model invents an edit to justify the round.
  And if the follow-up does not fit, the held plan is applied anyway: an advisory round must never
  leave the user with less than they would have had.

**It measured at zero.** Ten runs each side, everything else equal: **6/10 with the round, 6/10
without.** It is shipped because it is the only thing that can catch a wire nothing refuses, because
the model does engage with it — the replacement plans come back saying *"resolving via Match Cell
Types"* — and because the cost is concentrated where it is least avoidable: the diff cancels on an
edit turn, so the extra call falls almost entirely on from-scratch builds, which is also where the
model has no feedback at all. **Re-measure it on Sonnet 5 before trusting the 6/10.**

The half that made the shape check possible is on the node: `Compare Connectivity` now says a Labels
table with no `label` column is not a labels table. It has to, because nothing else notices —
`idColumn` and `labelColumn` are required pickers on their declared defaults, so `resolveColumn`'s
rule 3 substitutes the first compatible column, `neuronId` matches by luck and `label` silently
becomes `type`. It fires **only where the schema is known** and **only while both pickers are still
on their declared defaults**, since a name somebody chose is a decision. `defaultParams` writes those
defaults at creation, so "untouched" is the value *equal* to the default rather than an absent one.

## Three levers, and where they live

Apart from the model: **Full node help** (the catalogue's `lean`/`full` split), **Send run values**
(the digest), and **Let the model reason** (Ollama's `think`). All three are in the drawer's header,
because the first and last are what you reach for when an answer comes back *wrong* — a moment three
clicks and a dialog away from the Connections panel, where reasoning used to live.

**Send run values is the odd one, and the only one that is on by default.** The other two change how
hard the model works; this one decides whether *data* rather than structure leaves the machine — the
graph already names your datasets and the filter values you typed, and the digest adds aggregates
over what those queries returned. It stays on because it was measured to help and the failure when
off is silent (no error, just worse plans), and it is refusable because a behaviour named in three
privacy notices with no control reads as an oversight. Storage is inverted for it: the table keeps
only a *departure* from the default, so what is written is `off`.

A targeted version — send aggregates of published connectome data but not of your own annotations —
**cannot be built**, and the reason is a good one. Annotations travel downstream as an ordinary
neuron table, deliberately, so a Filter or a Sort can sit in the chain; `DatasetAnnotations` is on
the `DatasetValue`, not on the table. By the time the digest sees a `TableValue` there is no signal
saying where its columns came from.

Note the header stays short for most people: reasoning renders only for Ollama, so a cloud provider
shows two switches and not three.

They take effect on the click, inverting that panel's own draft-until-Save rule: there is no Save in
a drawer, and the next question is the confirmation. Kept **per provider**, because what the extra
33k characters cost differs — a cached read on Anthropic, KV memory and a re-prefill on a laptop.

`lean` is the default and it was measured: 15/15 either way against Sonnet 5, with the case `help`
prose should matter most for producing the identical graph on all six runs.

## Measuring it

`src/assistant/live.test.ts`, gated on `ASSISTANT_LIVE=1` — **separately from the key**, because
`ANTHROPIC_API_KEY` is the standard name and an un-gated suite spends a developer's money without
mentioning it. Seven cases. Any provider through `CODA_ASSISTANT_PROVIDER` / `_MODEL` / `_CATALOGUE`.

**Read what it prints, not the pass/fail** — and take one run for what it is. Measured on
`gemma4:31b-cloud`, single cases sat at 5/10 and 9/10 while the suite reported 5/7 twice with a
*different pair* failing each time. Two conclusions were drawn from n=2 during this work and both
were wrong: one "regression" was noise (3/5 on both sides), and one green mutation check was a
`sed` that had silently not matched. **Five runs per side is the floor for a prompt change**, and
every number on this page is at least that.

The free path is real and is what the last two rounds were measured on: `ollama signin`, then
`gemma4:31b-cloud`. Note it is a *cloud* model — the catalogue, the graph and the digest go to
ollama.com. `docs/ollama.md` records it as 5/5 in 16 s; on today's seven-case suite it is nearer
6/7 at ~25 s with two cases that flake, so read that figure as more deterministic than the model is.

## What is deliberately not built

**No tool loop.** It was the plan for the values half until the questions turned out to be
aggregates. What is left for one is a single deep case — the full distinct list of a column the
digest folded — against a real cost: `tools` and `format` cannot be sent together (with both set
the grammar wins from token 0 and the model *narrates* calling the tool inside the JSON), so it
needs phase separation, a second prompt shape and prefill, and a loop across four provider APIs
that disagree. The assistant can also answer that case by *building a Group By* and reading it on
the next turn, which is a legitimate answer from a pipeline builder.

**No query tool, ever.** Query nodes hit a shared production database and both peeks start the
fetch they cannot answer, so a tool looping over datasets fires a request per call. That is
invariant 6's `cheap`/`expensive` decision handed to a model.

**The assistant cannot commit anything.** It hands a `CodaGraph` back and the store decides —
which is why `src/assistant/**` is in `eslint.config.js`'s boundary block.

**That rule catches a direct import and the property is transitive**, which is not a distinction
anyone makes until it costs something. `digest.ts` reuses `describeTable` — so a plan's median and
the Describe card's are the same number — and `describeOps` reached `ui/viewers/boxStats` for
`quantileSorted`, which reaches `ui/colors`. Three files deep, lint clean, property false.

The shared arithmetic moved down rather than the reach going sideways: `quantileSorted` is
`core/stats.ts` now, and `src/core` is in the boundary block, so lint enforces it for the two
`nodes/lib` callers as well. What lint still cannot do is follow an edge two files deep, so
`assistant.test.ts` walks the import graph from every non-test module in `src/assistant` and
asserts nothing under `src/ui` or `src/store` is reachable at any depth. Reinstating the old import
makes it fail naming the whole chain.
