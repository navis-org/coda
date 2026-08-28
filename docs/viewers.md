# Output widgets

Every viewer, its export path, and the styling panel they share.

Moved verbatim out of `CLAUDE.md`.

## Output widgets

`ValuePreview` picks a viewer by node type, then by value kind, and forwards a shared prop
bundle (`baseName`, `onExpand`, `onError`, `compact`) so a new viewer cannot silently ship
without export or expand.

- **Export** lives in `ui/export.ts`. CSV is built as chunked `Blob` parts rather than one
  string, because a 500k-row table would otherwise allocate ~30MB at once. SVG export
  clones the live `<svg>` and inlines the resolved `font-family` — the charts compute all
  their colours as literal hex in JS, which is the only reason vector export is nearly
  free; if a viewer ever starts using a CSS variable for a fill, exported files will lose
  that colour.
- **Tooltips are positioned in container coordinates, never viewport ones.** `.chart-tooltip`
  was `position: fixed` with `left: event.clientX` for the life of four viewers, which is
  correct everywhere except the place they are usually read: a **transformed ancestor becomes
  the containing block for `fixed` descendants too**, and React Flow's viewport pane carries
  `transform: translate(…) scale(z)`. So the tooltip was right in the expanded overlay, which
  sits outside that pane, and hundreds of pixels adrift on a node card. Measured before the
  fix: a dendrogram bracket hovered at (1254, 417) put its tooltip at (1787, 498), a heatmap
  cell at (1098, 655) put its at (1693, 950).

  Two corrections, and only doing one leaves it subtly wrong: the pointer has to be made
  relative to the containing block, **and** the distance divided by the zoom, because a length
  inside a `scale(z)` pane is drawn `z` times as long. `offsetWidth` ignores transforms where
  `getBoundingClientRect()` has applied them, so their ratio _is_ the zoom — the identity the
  auto-layout measurement leans on. `tooltipPoint()` is that, shared by Heatmap, Bar Chart,
  Scatter and Dendrogram; `NetworkViewer` never had the bug because it was already `absolute`
  over sigma's container coordinates, which is what `.viewer`'s own `position: relative` comment
  describes. Verified in a browser at three zoom levels — the gap tracks the camera at 4, 7 and
  10 px for 0.35, 0.60 and 0.86, being one constant 12 local px throughout.

  Note what the fix depends on: the container passed must be the tooltip's **containing block**.
  That is `.viewer__scroll` for three of them and `.viewer` for the scatter, whose tooltip is a
  sibling of its plot box — passing the wrong one is off by that element's own offset, which on
  a card looks like a styling choice rather than a bug.

- **Fullscreen** uses the real Fullscreen API on the overlay panel. `.overlay__panel:fullscreen`
  resets the backdrop padding and rounding, because in fullscreen the panel _is_ the root
  element and would otherwise render as a floating card with bars around it.
- **Table sorting is view-only** and shares `sortedRowIndices` with the Sort node, so null
  placement and numeric-vs-locale collation can't diverge between the two.
- jsdom has no `URL.createObjectURL`, no navigation and no Fullscreen API.
  `installDownloadCapture()` in `test/jsdomStubs.ts` intercepts the anchor-click download so
  tests can assert filename and content.

### Downloading a result

Two surfaces, one decision function. `ui/exportValue.ts`'s `formatsFor`/`planExport` answer what
a value can be written as and what the files are called; the **Download node**, the **viewers'
caption bar** and now **every card's foot** all read the same answer, so a format added in one
place appears in all three and none of them can disagree about a filename.

**A network exports as GraphML**, alongside the two CSVs it has always written. Chosen over GML —
the other format Cytoscape, NetworkX, Gephi, igraph and yEd all read — for one reason: it is the
only one that carries Coda's attribute tables _with their types_. A `<key>` declares `attr.type`
up front, so `i64` arrives as a long and `f64` as a double rather than as whatever the reader
infers from the first literal it meets, and an absent value is an omitted element rather than a
zero somebody has to notice. GML implies types by literal syntax and restricts key names to
something `sum_neuronId` survives and `pt root id` does not.

**Attributes only — no positions, no colours.** So the Network viewer and Build Network write
byte-identical files for the same network, and the document says what the data says rather than
what one viewer happened to be showing. Every reader here lays a graph out on import anyway.

Four things in the writer that each produce a plausible wrong file:

- **A null is an omitted element, never a zero.** The same trap `numeric()` exists for, one step
  downstream: a written `0` is a reading. A non-finite number goes the same way — XML Schema does
  spell `NaN` and `INF`, but the readers disagree and a number nobody can compare is not worth a
  parse error. An **empty string is kept**, unlike a null, because this is a serializer: an
  omitted element reads back as a missing key and turns a blank cell into a `KeyError`.
- **XML 1.0 forbids most C0 control characters outright**, and there is no escape for them —
  `&#1;` is as illegal as the byte, so a document carrying one is _rejected_ rather than read
  leniently. `xmlText` strips them; tab, newline and carriage return are legal and stay. Written
  as `\u0000`-style escapes for the reason `uploads.ts` records about its separator.
- **`id`, `source` and `target` are never repeated as attributes**, the same subtraction
  `keptEdgeColumns` makes: an id written twice becomes a redundant column beside the one the
  reader keyed on.
- **`<key>` ids are generated (`nd0`, `ed0`), never the column name.** A key id is an XML ID and a
  column name is arbitrary text; `attr.name` is what NetworkX reads back, so the generated id
  costs nothing.

The document is built as **string parts, not through `XMLSerializer`** — the whole point of
chunking at 2,000 rows is that a 20,000-node network never becomes one huge string, and a DOM is
that string plus an object per element. `exportValue.test.ts` still asserts against a _parsed_
document (hence its `@vitest-environment jsdom`), because a snapshot of well-formed-_looking_ XML
is exactly what a file with an unescaped `&` in a region name produces.

**CSV stays what `auto` picks.** GraphML is the better file for Cytoscape and NetworkX; a
spreadsheet cannot open it at all, and `auto` is what somebody gets without choosing.

### The ⤓ in a card's foot

`ResultDownload`, rendered in `.coda-node__footer` for any card whose result `planExport` can
write. Downloading a node's output used to mean wiring a Download node beside it — the right
answer for a repeatable pipeline and the wrong one for "let me have that table", since a download
is a verb people look for on the thing.

**Withheld where the card is already drawing a viewer.** That card carries its own ⤓ an inch
above, and it is the better of the two: it can offer the picture as SVG and PNG, which no amount
of looking at the value can produce. Same rule the `… N more` hint follows when it stands down on
a fold — do not say the same thing twice on one card.

**The rule bites on the dataset cards, and that is recorded rather than special-cased.**
`formatsFor` never comes back empty for a real value, because JSON is the universal fallback — so
"any node whose result is downloadable" is really "every node with a result", and the nine dataset
nodes gain a ⤓ writing a four-line JSON handle. It was kept because that file is valid and
meaningful (it names the _resolved_ version, which is the provenance question an unpinned
`Latest` leaves open), so it is a control that delivers rather than one that promises. The
narrowing, if it ever reads as noise, is `defaultFormat(value) !== 'json'` — one predicate, no
list — and `resultDownload.test.tsx` is where that case is pinned.

**`DownloadButton` is shared, not copied.** The ⤓, its menu, the dismiss and the busy state are
one component behind both `ViewerActions` and `ResultDownload`; the callers differ only in what a
format is called and what picking one does, because one asks a live viewer for its picture and the
other asks `planExport` about a value. Same call as `LegendKeys`, extracted from `NetworkLegend`
for the same reason. It carries its own `.download-button` positioning context: the menu is
absolute against it and must not anchor to the surrounding row, which holds ⤢ in a caption bar and
the summary in a foot.

### A length is not a count either

`formatCompact` is unit-blind — it reads magnitude and nothing else — so a cable length of
2,980,158 nm rendered as **`3M`**: a magnitude carried entirely by a suffix meaning _million_,
next to a stored unit meaning _nano_. About as misleading as a number can be, and it is the
figure every paper about a fly neuron quotes in millimetres.

`formatMeasure(value, unit)` in `ui/format.ts` walks the SI ladder — nm, µm, mm, m — picking the
coarsest rung the value fills and **flooring at the finest**, so a sub-nanometre length stays a
number instead of becoming `0 µm`. `2,980,158.182` reads `2.98 mm`; the giant fibre's
22,484,326 reads `22.48 mm`.

**The unit travels with the number here and does not for a count**, which is the asymmetry worth
knowing before adding a fourth unit. Which unit a _length_ wants depends on its magnitude, so
`2.98` alone says nothing — where `12.9K` beside a `pre` label says everything. So `synapses` and
`voxels` fall through to `formatCompact` unchanged: a count has no ladder, and a voxel is not a
fraction of anything. Those three are the only units declared anywhere in the tree.

**The rung is asked of the _rounded_ figure rather than the raw one**, which is not a refinement.
999,999 nm fills only µm, and at two decimals prints there as `1,000 µm` — a thousands separator,
which is the one thing the ladder exists to remove. Promoted only once the rounded figure has
actually climbed, so 999,994 still reads `999.99 µm` and keeps its own precision.

**The unit is looked up in the ladder, never tested against `'nm'`.** The table already names µm,
mm and m, so gating on the storage unit would silently drop the unit and reinstate `3M` the moment
a column declared one of the other three — an uploaded CSV of measurements, or a source publishing
µm. It is also **sorted where it is declared** rather than by convention, because the rung search
takes the last match: a `cm` added in reading order would otherwise become the answer for every
length, with no type error and nothing failing for the cases already covered.

**The schema half was already right, which is what made this a display bug rather than a data
one.** Every `cableLength` column has carried `'nm'` since `CANONICAL_SCHEMAS`, and Explore Dataset's row
_read_ it — through `statUnit` — and then used it only in a `title`. The value beside it went
through the unit-blind formatter. So the fix is where the two met, not in either half.

**Glanceable on screen, exact on hover.** The row's title carries the stored figure **verbatim** —
`cableLength (nm): 2980158.182` — rather than through `formatNumber`, which groups _and_ rounds:
that takes CATMAID's own 4003103.2328612693 down to `4,003,103.233`, which is neither exact nor
pasteable and so answers the one question the hover exists for with a different number. It goes
through `formatExact`, which is `formatCell`'s id branch renamed and exported: the reason is
identical in both places — a grouped number is a string no query accepts, and under another locale
not even the same string — and it had been written out privately for ids until a second caller
wanted it. The unit sits on the **label** rather than after the value, so it survives an absent one;
what a column is _in_ is the one thing an empty cell can still say.

The **Table** viewer is deliberately untouched: it prints the exact value with the unit in its
header, and a table is where exact values are read — the compact forms are for the glanceable
surfaces.

Note what is _not_ covered, and it is wider than one axis: **every chart that formats a magnitude
without seeing the column's unit still reads `3M`** — the scatter's axis ticks (`scatterDraw`), the
heatmap's colourbar and its printed cells, and both legend ramps (`LegendKeys`, `describeLegend`).
The scatter and the legends need the unit threaded through the plot spec and the encoding
resolution, which is a change to every viewer. The heatmap is nearer, and instructive about why it
is still not a one-liner: `pivotMatrix` copies the value column's unit into `MatrixValue.valueLabel`,
so `Pivot` on a `cableLength` draws `0 – 3M` beside a caption reading `· nm` today — but a chart
states its unit **once**, in that caption, so scaling the bar means scaling the printed cell values
with it and moving the caption to the _display_ unit. Doing only the bar leaves the card
disagreeing with itself, which is worse than the number it fixes.

**`nodes` joined `STATS` with it.** It is CATMAID's `size` — a skeleton's node count is what says
how much of a neuron was traced — and without it a CATMAID row had exactly one stat, since that
backend publishes none of the other six.

### An identifier is not a quantity

`formatCell` takes the **column name** as well as the value, and a column of identifiers is
printed verbatim: `527536`, not `527,536`. A thousands separator is a reading aid for
magnitude, and an identifier has none — body 527536 is not five hundred thousand of anything,
so the grouped form is a string no query accepts, and under another locale it is not even the
same string, which makes a column copied out of the table disagree with itself between two
machines. Worth knowing that the Table viewer's cell `title` has always been `String(cell)`,
so before this the hover and the cell under it disagreed on every id.

**The rule is the name, because nothing in a `DType` can say it.** That is the same gap
`BuildNetwork`'s merge rule documents — "summing added `preId` up to 24093454514" — and the one
the upload node's `Text columns` exists for; `isIdentifierColumn` in `ui/format.ts` is those
two answers applied to the formatter. It reads the name's **last word**, split on separators
and camelCase, which covers `neuronId`, `preId`/`postId`, `partnerId`, `sourceId`/`targetId` and
the `root_id` / `pt_root_id` spellings an uploaded CSV arrives under with no list to keep in
step. A plain `endsWith('id')` is not the same rule and is wrong: `centroid` and `valid` are
words that happen to end that way.

**An aggregate of an id column is a quantity again**, and is excluded by its prefix, derived
from `AGG_OPTIONS` rather than typed out. `groupBy` writes `<agg>_<column>`, so a count of
distinct partners is literally called `countDistinct_partnerId` — five figures on male-CNS, and
it does want its separator. What that costs is a column somebody else called `max_id`, which
reads as an aggregate and keeps its grouping; taken deliberately, since `sum_neuronId` is a name
Coda generates and `max_id` can only arrive in a file.

**The name is optional and absent means "a quantity"**, which is what every caller did before
it existed. It is passed wherever the caller has one — the table cell, the network tooltip and
edge label, the scatter tooltip's label/colour/shape rows, the Neuron Profile and Explore Dataset chips.
`Tiles`' `Facts` takes label/value pairs with no schema behind them and is left alone.

`format.test.ts` pins the rule and `viewers.test.tsx` pins the wiring, because a cell rendering
`formatCell(cell)` with the name dropped fails no type check and looks exactly like the bug
this fixed.

### Filtering a table, and the port it feeds

Each column header carries a filter field, and what survives leaves by a second output,
**`Filtered`**. `nodes/lib/tableFilter.ts` is the whole of the semantics, headless — the widget
filters its own copy on every keystroke and `evaluate` filters the real one on the committed
param, and a second implementation in the UI would draw a row count the port does not honour.

**A cell is the right-hand side of an Explore Dataset field term.** `>=10` under a count means what
`weight>=10` means in the Explore Dataset box: same operator table, same null rule (a missing value
satisfies `!=` and nothing else), same comparison semantics, because `resolveFilters` builds
real `FieldTerm`s and hands them to `neuronSearch.ts`'s own matcher. That reuse is why
`prepareFieldTerms`/`fieldTermsMatch` were extracted out of `runSearch` — two loops over one
matcher, rather than two matchers that part company on the first null. **Do not re-implement
the comparison here.**

**What a cell decides that a query token does not is the meaning of a bare value**, and it is
decided from the column's dtype. On a number `10` is `== 10` — read as a substring it would
match 100 and 210, which is nobody's intent in a synapse count. On text it is a substring,
compiled as an _escaped_ regex so `LC4(R)` matches itself rather than being read as a group.

**It does not agree with the Filter node, and that is recorded rather than fixed.** The header
_sort_ shares `sortedRowIndices` with the Sort node on a stated rule — collation and null
placement must not differ between a node and a header click. The header _filter_ borrows
Explore Dataset's grammar instead, so it lands elsewhere on both. Measured: `type == "lc4"` keeps 0 rows
in a Filter node (case-sensitive) and 1 in a header cell; `pre == 0` against a null keeps the
null row in a Filter node (`Number(null)` is 0) and none in a cell. Neither is wrong on its own,
but a graph can hold both an inch apart, so `tableFilter.ts` and `filterTable` each name the
other. Folding one onto the other is a decision about which semantics wins and changes what
every saved `core.filter` returns — not a tidy-up.

**Nothing in it ever throws.** A half-typed cell, a regex that does not compile, a column an
upstream edit removed — none of those may block the graph, because `out.table` is a tap and a
refusal there reaches everything downstream of the _pass-through_ too. A clause that cannot be
applied is dropped and reported; `validate` says so on the node and the cell wears
`data-invalid`. Note which way that errs: dropping shows **more** rows than intended, where
letting an unresolvable column reach `prepareFieldTerms` marks it `unknown`, which matches no
row — so one stale column name would empty the table and read as a node that had broken.

**A problem carries its column beside the message, never inside it.** The cell that draws the
red border has to know which column a problem belongs to, and recovering that by substring-
matching the prose is both fragile and wrong: `Filter on "pre": "abc" is not a number` quotes
the offending _value_ too, so a table with a column called `abc` would see that column marked
broken. Same reasoning as `reportAuthFailure` — matching on message text rots silently.
`validate` flattens to strings for the badge; the viewer indexes by column.

**`filterRowIndices` answers `undefined` for "every row", not an identity array.** The
unfiltered case is the common one and a table here can be the whole of male-CNS, so
`Array.from({length}, (_, i) => i)` is 165,000 elements built and discarded — once per
`evaluate` and once per _render_. Both callers already treat "all rows" specially, so the
sentinel costs neither a branch.

**Filtering is data; sorting is still a view.** The two controls sit inches apart and mean
opposite things, so the caption carries both: `5 of 6 rows` for the filter, `sorted view only`
for the sort. Sorting stays out of the provenance key deliberately — a header click is the
cheapest gesture anyone makes on a table, and staling the graph for it would read as a
scheduler bug.

**The bill, which is not visible from the port that pays it.** A cache key is one per _node_, so
editing a filter invalidates `out.table` whole and reaches a chain hanging off `Table` as well —
whose bytes did not change. It lands there as `blocked` rather than `stale`. Same trade
`out.network`'s filters make, and `table.test.ts` pins it so nobody is surprised later.

**Draft now, commit in a moment.** Typing filters the drawing immediately and reaches the param
`COMMIT_DELAY_MS` (140ms) after the last keystroke — Explore Dataset's split, for Explore Dataset's reason: the
param is in the provenance key, so committing per keystroke is a re-run of everything downstream
between two letters of a cell type.

**Two memos, not one, and the decode is `ValuePreview`'s job.** The sort is keyed on
`[table, sort]` alone: folding it in with the filter re-ran `sortedRowIndices` on every
keystroke, which on 165k rows of a string column is hundreds of milliseconds of `localeCompare`
per character. And the clauses are decoded in a memo keyed on the stored `string[]` — decoded
inline they were a fresh array every store tick, and the viewer resets its draft whenever that
identity changes, so it discarded what was being typed and re-filtered and re-paged on each
tick. Same trap `useStable` was extracted for: **memoise by value.**

**The field lives inside its `<th>`, not in a second row.** `.data-table th` is
`position: sticky; top: 0`, so a second sticky row would need the first one's height as its
offset — a height that varies with whether the column declares a unit. One sticky element that
grows cannot drift. The knock-on is that the column _name_ became a `<button>`, which is what
sorts; clicking the field does not. `width: 100%; min-width: 0` on the field is what stops a
filtered column widening as somebody types.

**The controls are `out.table`'s alone.** `TableViewer` draws every table in the app — a Filter
node's own output, a Group By's, an upload's — and only this node has a port for the result, so
`ValuePreview` supplies `filters`/`onFiltersChange` for that one type. Both halves travel
together, or there is a state where the row can be edited and not stored.

**Clauses are stored as JSON pairs, not as a query string.** `parseSearch` reads a field name
only where it matches `FIELD_NAME`, and the columns this viewer draws routinely do not: a wide
pivot names its columns after label values (`LC11_02(R)`) and an uploaded CSV's header can hold
a space. Storing the whole filter as one re-parsed query would lose exactly the columns somebody
is most likely to be filtering. `["Cell Type","~^LC"]` also reads in a `.coda.json` people mail
each other, where a unit-separator join would not.

**The row is toggled from the caption and forced open whenever anything is set**, so an
unfiltered Table card looks exactly as it did before and a filtered one always says why it is
short. The toggle is `disabled` while a filter is live rather than absent — clearing the cells
is what closes the row.

**Both exporters emit real filter code**, since `Filtered` has to bind something or downstream
Python/R refers to a variable nothing assigns. Two disagreements had to be written out rather
than inherited: pandas and dplyr are both **case-sensitive** where Coda lowercases both sides
and carries the `i` flag, and `dplyr::filter` **drops `NA`** where a missing value satisfies
`!=` here. Every mask guards `isna`/`is.na` explicitly, including where the operator would have
got it right anyway — those are the ones that break quietly when edited. The fixture carries a
**second** Table node for the same reason it carries two Select One nodes: the first is fed by
the Pivot, whose wide schema is observed rather than inferred, so no clause on it resolves at
export time and the golden would record only the branch that binds `filtered = out`.

**One pre-existing bug surfaced with it.** The overlay's rail draws each param's label itself
_and_ passed no `variant` to `ParamField`, whose checkbox draws its own — so a presentational
boolean rendered `Show filter row / Show filter row`. `out.table`'s filter-row toggle is the
first boolean to reach that rail, which is why it had survived: every other param kind ignores
`showLabel`. The rail now passes `variant="inspector"`, as `ParamRows` already did. Exactly the
double-label trap `SelectOneBody` documents, in the other surface that pairs its own label with
a `ParamField`.

**Verified in a real browser** as well as headlessly, because the header cell's layout is the
class jsdom cannot see: the field sits inside the sticky header (`th` 129–177, field 152–171,
first row starting at 177), column widths do not move as a filter is typed (468/468/481 before
and after), the numeric, regex and invalid cases all behave, and the card shows the row at its
own width with the toggle disabled while filtering. What is _not_ covered anywhere is the light
theme, and a table wide enough to scroll the filter row sideways.

## Grouped params — the styling sidebar

`ParamBase.group` and `ParamBase.composite` plus `NodeDefinition.paramGroups` turn a node's
flat param list into a tabbed panel in the expanded viewer. `out.network` and `out.viewer3d`
use it; Cytoscape's Style tab is the reference.

**`out.viewer3d` groups by socket** — Skeletons, Meshes, Points, Volumes, Scene — where the
network groups by half of the drawing. Both are the node's own structure rather than a taxonomy
invented for the panel, which is the test to apply to a third one. Two things came out of it
that were not the point when it started. Five tabs do not fit 268px, so `.style-tabs` wraps
rather than scrolls: a horizontal scroller hides the last tab behind a gesture nothing on screen
suggests. And a tabbed panel is the shape that carries the header's `Style` toggle, so grouping
a node is also how its controls acquire a way to be _put away_ — the flat rail has none, which
is why it is always in the way on the one node whose whole face is a picture.

**It is opt-in, and the opt-out is the absence of `paramGroups`.** A node declaring no groups
keeps the flat horizontal rail it has always had, which is why adding this changed nothing for
the heatmap, the bar chart or the table. `overlay.test.tsx` asserts both halves.

**A composite is a statement about params, not about pixels.** An encoding is three params —
a mapping mode, a column, a constant — because that is what the graph has to _store_; on
screen it is one property with one label. `composite: { key, role }` binds the facets, with
`primary` (how the property is driven), `value` (what by) and `extra` (modifiers like a size
range). The two `value` members of a colour are `visibleIf`-exclusive, which is exactly what
lets one slot hold the column picker or the swatch and never both. It lives on the definition
rather than in a UI registry because deriving it from the `<prefix>ColorMode` naming
convention would be string-matching a factory's output, and rots the first time an encoding is
written by hand.

**Nothing is ever dropped.** A param whose `group` names no declared tab, or which has no
group at all, lands in a trailing `Other` tab rather than disappearing — a control that
silently vanishes is far worse than an untidy tab. `groupParams` is pure and tested against the
real `out.network` definition, and the load-bearing assertion is that the panel shows _exactly_
the set the rail's old filter produced.

**Composite keys are scoped per tab.** Both the node half and the link half call their row
"Label"; a global key would move one control into the other's tab.

**The sidebar's collapse is `panels.style`, and it defaults open** — unlike the inspector and
the minimap, whose closed default is a canvas argument that does not apply inside a modal
nobody opens by accident. Note the inverted read in `loadPanels`: an absent key means open, so
a preference written before the key existed is not read as the user having closed it. The
toggle is in the overlay header, _outside_ the panel it controls, for the same reason the
minimap's button is outside the minimap.

**The panel still shows presentational params only.** That filter is what makes the surface
safe to touch, and it is passed into `groupParams` rather than baked into it — which is the
hook a Filter tab of non-presentational params would come in through, along with something in
the UI admitting that those _do_ stale the graph.

**And `out.network`'s card draws only `Layout`.** Thirty-three params is the largest set in the
registry; fifteen of them showed at once on the default settings, as a column of generic pickers
stacked above the drawing they configure. Everything else is `advanced` now, which is the same
call `out.neuroglancer` and `out.rois` make and is cheaper here than on a smaller node, because
`advanced` is read by the _card_ alone: `paramsForPanel` and `groupParams` never look at it, so
every one of them still reaches the styling panel under the tab it was grouped for, and the
inspector still shows the full set. The `… 24 more` hint is what says so.

Two params are not styling and were still decided the same way. `Layout` stays because it is the
one control that decides what the picture _is_ rather than how it looks — and because a card with
no rows at all loses its `☰` fold and reads as a node with nothing to set, which is exactly what a
viewer this configurable should not be mistaken for. `selection` goes, though it is neither
styling nor layout: its row said `3 nodes · clear`, which the caption already says and clicking
the canvas already does.

Note what pins it. A param added without the flag fails no type check, is not caught by
`paramGroups.test.ts` — which asks about the panel, where `advanced` changes nothing — and simply
appears on the card, so the column starts growing back one param at a time. `network.test.ts`
asserts the card's contents exactly.

## Network Viewer + 3D widgets

**Value model.** `Network`, `Skeletons`, `Meshes` and `Points` all pair geometry/topology
with an ordinary Coda **attribute table** (one row per node/item/point, in the same order).
That is the whole trick: column pickers, encodings and future analysis nodes all reuse the
table machinery. `attributeSchema(type, part)` reads that schema off a type, which is why
"colour by [type]" populates on a Network socket exactly as on a Table.

**`BuildNetwork` carries edge attributes, and the merge rule is where the care went.** It used
to emit exactly `source`/`target`/`weight`/`edges`, dropping every other column of the incoming
edge table — which is also why a categorical _link_ colour had almost nothing to bind to.

**`Keep columns` empty means all of them**, not none. That matches the node half of this same
node, which has always taken every joined column, and the `chips` idiom where empty means
"decide for me". Four kinds never ride along: the four names this node owns, plus the source,
target and weight columns themselves, which are already carried under those names.

**Where parallel links merge, a value survives only if every merged row agrees on it** —
whatever its type — and is empty otherwise. A link standing for forty synapse groups across
five ROIs has no single ROI, and naming the first row's would be a confident lie; `edges` says
how many rows are behind it.

**Numbers are deliberately not summed, and this was got wrong first.** Summing is right only
for a measure, and nothing in a dtype separates a measure from an identifier or a code: on a
real male-CNS connectivity table it added `preId` up to 24093454514 — noise, and noise offered
to the numeric pickers where it could have driven a size encoding. `weight` is the one additive
channel; a second additive quantity belongs in a `groupBy` upstream, which names its result
honestly as `sum_x`.

Note the disanalogy that made summing look safe: `nodeSchemaFor` carries everything without a
merge rule because a node join is one row per node. Only edges merge.

`keptEdgeColumns` is called by both `inferOutputs` and `evaluate`, so invariant 3 holds by
construction. And loading does _not_ fill missing params with defaults, so a graph saved before
the param existed has no `keep` key — `resolveColumns` reads that as `[]`, which is why empty
had to mean "all" for those files to gain anything.

The viewer was never the culprit: `out.network` passes the network through and `filterNetwork`
uses `selectRows`, which preserves the schema whole.

**Encodings** live in `ui/encoding.ts` (resolution) and `nodes/lib/encodingParams.ts` (param
factories, headless). Never re-implement colour mapping in a viewer — the 8-slot cap, the
achromatic Other fold, area-scaled sizes and null-as-grey are enforced in one place.
`numeric()` exists because `Number(null)` is `0`, which silently painted missing data as the
ramp's minimum.

**Sequential colour is for area marks, not for hairlines — and that is measured.** Link
colour offers `constant` and `categorical` only. The blue ramp's receding end is **1.46:1**
against the dark surface: correct under a heatmap cell or a node disc, where a low value is
_supposed_ to recede into the page, and invisible on a 0.5px line. Clamping the ramp to clear
the 3:1 non-text floor works — dark reaches 3.23:1 using ramp steps 0–8, light 3.54:1 using
6–12 — but squeezes adjacent steps to ΔL **0.047** dark / **0.035** light against a 0.06 floor,
so it buys visibility with step separation and the validator fails it either way. Link weight
already has an honest channel in `Width`. `ColorParamOptions.modes` is how a caller declines a
mode; if someone re-adds `sequential` for links, `paramGroups.test.ts` is the tripwire.

**Node borders come from `@sigma/node-border`, and two things about it are load-bearing.**
Sigma itself ships only `NodeCircleProgram` and `NodePointProgram`, and a border is what stops
a node dissolving into the links crossing behind it. First, the outline eats _inward_ from the
radius, so `applyStyle` adds the border width back onto the encoded size — without that a
size-4 node loses 44% of its area to a 1px outline and the size legend stops telling the truth.
Second, `createNodeBorderProgram` accepts `drawLabel`/`drawHover`, and sigma prefers a
program's own drawers over the settings: passing them would silently discard the haloed labels
and the selection ring. It is called with neither, and its defaults are `undefined`.

**Alpha rides in the colour, because sigma takes one colour per mark.** `withAlpha` folds a
constant link opacity into `#rrggbbaa`, which sigma's `parseColor` reads. Two consequences
worth knowing: `mixHex` carries an alpha byte through a blend untouched — dimming a translucent
link must not make it opaque — and the SVG export calls `splitAlpha` to write `stroke-opacity`
rather than an eight-digit hex, because an exported file outlives the browser that made it.

**The legend strip keys four channels, and only two of them used to exist on screen.** Node
colour, node size, link colour, link width. Before this the screen drew categorical swatches
and nothing else, while `networkToSvg` had always appended a legend — so a sequential encoding
had no key at all on screen and neither size channel had one anywhere. In `compact` the
identity keys survive and the magnitude ramps stand down: a categorical colour without its key
says nothing, whereas a size ramp annotates a comparison the reader can already make by eye,
and its row costs a tenth of a 150px card.

**Selection is not presentational.** `kind: 'ids'` params are written by viewers, live in the
saved file, and take part in the provenance key. Marking one presentational would let a
stale downstream result survive a selection change.

**The Network Viewer filters its own output, and that is the one place it stops being a
tap.** `minLinkWeight`, `topNodes` and `hideIsolated` are **not** presentational: they change
what `evaluate` returns, so they join the provenance key and stale everything downstream. The
alternative — filtering only the drawing — leaves the picture disagreeing with every node
wired after it, which is worse than the cost. `networkOps.ts` holds the logic, headless.

No widget-local preview path exists, and that is deliberate: `out.network` is `cheap`, so the
ordinary 180ms pass already redraws while you drag. Explore Dataset's live-widget/debounced-commit
split is for an `expensive` node; copying it here would put a filtered picture beside a stale
downstream graph and have the two disagree, which is the failure being avoided.

**The three filters apply in a fixed order, and the order is the point.** Weight cut, then
top-N ranked _over the links that survived it_, then isolated nodes. Ranking before the cut
answers a different question — "the biggest players in the graph I am looking at" is the
useful one. Ties break on id, because the result reaches a provenance key.

**Filtering recomputes `degreeIn`/`degreeOut`/`weightIn`/`weightOut`.** They are roll-ups
`BuildNetwork` derives from the link set, so a node still claiming `degreeOut: 7` after four of
those links were cut is not merely stale — it is driving a size encoding and a tooltip that
contradict the picture beside them. Only those four names, only when the schema has them; a
network from elsewhere is untouched.

**A tab that changes data has to say so.** `ParamGroup.affectsData` is what widens the panel's
presentational-only admission rule (`paramsForPanel`), and it is also what makes the tab render
its warning. Presentational-only is the promise that makes a styling panel safe to touch;
breaking it silently, so a graph goes stale with no visible cause, is exactly the confusion the
note prevents. The caption carries the other half — `N nodes, M links filtered`, in the same
idiom as `labels thinned`, because a graph that is simply smaller than its data with nothing
saying why is the failure that note already exists to avoid.

**ForceAtlas2 runs in a web worker, and that changed `computeLayout`'s contract.** It used to
return finished positions; for the force layout it now returns only a _seed circle_, and
`startForceLayout` hands the live graph to `graphology-layout-forceatlas2/worker`, which
mutates positions as it settles. Four things about that:

- **Start it after the graph is complete.** The supervisor listens for `nodeAdded`/`edgeAdded`
  and respawns its worker on each one, so starting early restarts the layout once per node.
- **The seed is deliberately not normalised**, unlike every other layout here. Normalising
  would hand FA2 a 1000-unit box when its gravity and scaling were tuned against a 50-unit
  one; sigma's `autoRescale` frames the result regardless, including while it is still moving.
- **Animation is not free, and the worker is only used where it pays.** Each iteration costs a
  postMessage round trip, so 220 iterations is 220 round trips however trivial the graph.
  Measured synchronously at 220 iterations on a 3-regular graph: 100 nodes 18ms, 200 33ms, 400
  122ms, 600 254ms, 800 451ms, 1200 986ms. Below `FORCE_SYNC_BELOW` (600) `computeLayout`
  settles the graph itself and no supervisor starts: there is no convergence worth watching at
  that size, only a wait to sit through.
- **The supervised loop is compute-gated, not frame-gated** — an earlier note here said
  otherwise and was wrong. `handleMessage` applies positions and calls `askForIterations`
  synchronously, so a cycle is one round trip; sigma renders on its own `requestAnimationFrame`
  and never blocks it, and the apply pass is a single bulk `updateEachNodeAttributes` costing
  0.05ms at 3,000 nodes. Per-iteration compute: 1,000 nodes 4.7ms (~213/s), 3,000 14.2ms
  (~70/s), 6,000 20.8ms (~48/s). No single `MS_PER_ITERATION` is right at every size; it is
  calibrated around three thousand nodes and over-delivers below that.
- **`iterations` is a budget, not a count.** The supervisor exposes no counter, so it stops on
  a timer (`settleDuration`), calibrated against the measured per-iteration compute above. It
  was 6ms, which under-delivered against the number asked for. The strip's ⏭ runs the
  remainder synchronously, which blocks;
  that is acceptable only because it takes an explicit press. `skipToSettled` bounds it at ten
  seconds, in batches of a hundred iterations — a backstop against an unbounded graph rather
  than a responsiveness guarantee, and the deadline is checked only between batches, so the
  last one can overrun it.
- **Link weight reaches the layout through the graph's `weight` edge attribute**, and
  graphology's getter coerces a missing one to 1 _without complaint_. That silence is what let
  the worker path ignore synapse counts entirely while the synchronous path used them: the two
  paths build different graphs — `toGraphology` sets `weight`, `NetworkViewer`'s own graph
  originally did not — so the same node laid out with different physics either side of
  `FORCE_SYNC_BELOW`. The viewer's graph now carries `weight` purely for the layout; sigma
  reads `size` for thickness and ignores it.
- **`edgeWeightInfluence` scales attraction only — it never switches weight off.**
  `ewc = pow(w, influence)`, so 0 flattens every edge to 1 for the pull; but
  `graphToByteArrays` accumulates node **mass as the raw weighted degree**, untouched by the
  influence, and mass drives repulsion and gravity. So `Weight pull: 0` means "weight does not
  pull", not "weight is ignored", and the help says so.
- **Kill it, don't stop it,** on unmount: a stopped supervisor keeps its worker alive.

The cost is the layout's determinism, and it is free here: positions are never persisted, and
`layout` is presentational.

**`networkRebuild.test.tsx` is the guard on the two-effect split.** jsdom has no WebGL so the
renderer never exists, but `computeLayout` is awaited in the same `Promise.all` as the sigma
import — so counting calls to it measures exactly how often the _structure_ effect ran. That
is the only handle available without a browser on the most expensive regression this component
has: anything slipping into that dependency list costs a full layout and throws away the user's
framing. Write the test before touching the effect.

**The action strip holds verbs; the styling panel holds settings.** Fit, re-layout, freeze and
find have no value to store, so they cannot be params. Re-layout works by bumping a nonce in
the structure effect's dependency list — heavy, and exactly what "lay it out again" means; the
camera survives because `sameIds` still matches. Find reuses the focus machinery but anchors on
_only_ the matches, with no neighbourhood: a hover asks "what does this touch?", a search asks
"where are these?". A live search owns the focus until the box is cleared, so neither a hover
nor a selection can take it back. Enter is the only thing here that writes to the graph.

**Layered gained a direction and a layer column; `grouped` is new.** Top-down swaps the axes
rather than rotating, so layer spacing stays on the layer axis. `layersFromValues` orders a
numeric column numerically (or 10 sorts before 2) and puts unlabelled nodes in a final layer of
their own rather than in layer zero, where they would read as the first stage. `grouped` rings
the groups by size and rings each group's members inside it, radius growing with √count —
entirely deterministic, no seeding, no relaxation.

**A settled layout survives the viewer closing** (`layoutMemo.ts`). A force layout at a few
thousand nodes is _earned_ — settled over seconds, skipped forward, frozen where it looked
right — and positions used to live in the renderer, which dies with the component. The memo is
module-level rather than a ref for exactly that reason, and it is keyed by the graph node, so
the card, the inspector and the overlay share one layout instead of each settling their own.

Deliberately **not** persisted to the document: positions are not provenance, they would add
two floats per node to every `.coda.json`, and `layout` stays presentational. A memo is reused
only while the node set _and_ a signature of every layout param still match — the re-layout
nonce is in that signature, which is what makes ↻ mean "do it again". **A restored layout does
not restart the supervisor**, since re-settling something somebody worked for is the loss the
memo exists to prevent.

**Spectral layout: eigenvectors of the Laplacian by power iteration on `cI − L`**, since power
iteration finds the largest eigenvalue and the wanted ones are the smallest. Unweighted on
purpose — synaptic weights span orders of magnitude and would let a few strong links dominate
the embedding. It declines rather than guessing when there is nothing to embed: fewer than
three nodes, or no edges at all, where `L` is the zero matrix and the iteration hands back
whatever it started from, which _looks_ non-degenerate to a spread check.

**Spectral seeding for ForceAtlas2 is offered and is not the default**, and that is a finding
rather than a preference. It is a standard technique and it should help; three synthetic
benchmarks each failed to show it, and each turned out to be measuring something else — a
blob's scale, a circulant cluster's own low eigenvalues swamping the between-cluster cut, and
finally index adjacency, which a circle seed satisfies by construction because it lays nodes
out in index order. Defaulting to an unvalidated change is the habit the palette rules exist to
prevent, so the circle stays until a real connectome says otherwise.

**Barnes-Hut is already on where it matters.** `inferSettings` enables it above 2,000 nodes, so
a 3,000-node graph is getting it before anyone asks. Measured at 100 iterations on a 3-regular
graph: 1,000 nodes 425ms → 259ms, 3,000 2656ms → 850ms, 6,000 10710ms → 2013ms. The `Quadtree`
param exists to force it on below the threshold, where it is still worth ~1.6×, or off when
comparing layouts.

**Layouts** are in `ui/viewers/networkLayout.ts`. `assignLayers` is deliberately not a
DAG algorithm — connectomes are full of recurrent loops, so it relaxes with a pass cap
rather than requiring acyclicity.

**`NetworkViewer` runs two effects, and the split is load-bearing.** _Structure_ (graph +
Sigma instance) rebuilds only on new data or a new layout, because building one resets the
camera and re-runs the layout. _Style_ (colours, sizes, labels, arrows, selection) mutates
the existing graph through `updateEach*Attributes` and repaints. Anything that lands in the
structure effect's dependency list by accident costs a full ForceAtlas2 run and throws away
the user's framing.

That is what `useStable` guards: `readColorSpec`/`readSizeSpec` mint a fresh object on every
render of the parent, so identity-keyed memos changed constantly and the renderer was being
rebuilt on every unrelated re-render. Memoise encoding specs **by value**.

It lives in `ui/viewers/useStable.ts` because the scatter plot needs exactly the same thing for
exactly the same reason — there it rebuilt the point set, the hit index and the canvas on every
store tick rather than resetting a camera. A second copy is how two viewers drift on what
"stable" means. `scatterRebuild.test.tsx` is its guard, in the same idiom as
`networkRebuild.test.tsx`: mock the one expensive call and count it.

**Both those files clear their mock in a `beforeEach` with a block body, and that is not
style.** `mockClear()` returns the mock for chaining, so a concise arrow _returns a function_
from the hook — which vitest reads as a teardown callback and duly invokes after every test,
with no arguments. It lands in the real function as `options === undefined` and reads as a bug
in the component under test.

**Reciprocal links bow apart, and both get the _same_ curvature.** The control point is
offset along the perpendicular of (target − source), which flips with the direction of
travel — so equal curvature puts A→B and B→A on opposite sides. Opposite curvatures would
stack them again. `assignCurvatures` in `ui/viewers/networkDraw.ts` owns this, and both the
WebGL path (`@sigma/edge-curve`) and the SVG export read it.

**Export re-draws rather than screenshots.** A WebGL drawing buffer can't be read back after
presentation without `preserveDrawingBuffer`, which taxes every frame. So `networkToSvg`
rebuilds the current view as SVG from sigma's _display_ data (post-reducer, so a focused
selection exports focused) and PNG rasterises that. Two consequences worth keeping: the
export is vector, and it is the only part of this viewer with real test coverage.

**Both viewers are lazy** (`LazyViewers.tsx`). three.js is ~900 kB; it must never enter the
main chunk. Verify with `pnpm build` — `Viewer3D-*.js` should stay a separate file, and
`sigma`, `graphology` and `sigma-edge-curve` should stay in theirs.

**Sigma culls labels three ways at once, and all three had to be dealt with.** A node
smaller than `labelRenderedSizeThreshold` (default 6px) never gets a label — and the default
node size is 4, so out of the box there were _no_ labels until you zoomed in. `labelDensity`
caps labels per 100px grid cell, so panning changes which node wins its cell and labels
blink. And `edgeLabelsToDisplayFromNodes` only draws a link label when **both** endpoints'
labels are already drawn, which made "Link labels" a no-op with node labels off. Fix:
`labelRenderedSizeThreshold: 0`, plus `forceLabel` on every item while the graph is under
`FORCE_NODE_LABELS_BELOW` / `FORCE_EDGE_LABELS_BELOW` — `forceLabel` bypasses all three.
Above the caps the culling returns and the caption says `labels thinned`; don't remove that
note, silent culling is exactly what made the viewer look broken.

**Sigma settings that exist for a reason.** `zoomingRatio: 1.25` + `zoomDuration: 110` (the
defaults animate a 1.7× jump over 250ms and drop any wheel tick inside 50ms of the last,
which on a trackpad reads as lag); `hideLabelsOnMove` only _above_ the force-label cap,
since hiding forced labels mid-gesture just makes them flicker; and `enableEdgeEvents` gated
on edge count because link hover costs a second render pass into a picking texture.

**Two sigma defaults are replaced outright, and one of them was a bug.** Sigma routes every
node carrying `highlighted` through `defaultDrawNodeHover`, whose stock implementation paints a
hardcoded `#FFF` label box with a black drop shadow — so marking a _selection_ lit a white blob
on the `#1a1a19` dark canvas, in a colour belonging to no palette. `makeSelectionRingDrawer`
replaces it with a ring, and three things about that are load-bearing:

- **It fills a disc, not a stroked circle.** Sigma repaints highlighted nodes in WebGL on top
  of the hover canvas, so the node's own colour covers the middle and what survives is a clean
  annulus. A stroke would simply be drawn over.
- **It rings only _selected_ nodes**, though sigma calls it for the hovered one too. Hover
  already reports itself through the focus dimming and the tooltip; a hovered node wearing the
  selection ring reads as having just been selected.
- **The ring is achromatic** (`CHART_INK.primary`). `--accent` is `#2a78d6` / `#3987e5`,
  byte-identical to categorical slot 0, so an accent-coloured ring would be invisible on
  exactly the nodes it marks.

The other replacement is `defaultDrawNodeLabel`, which gains the same halo `networkToSvg` has
always drawn. Until it did, the _exported file_ was more legible than the screen it came from.

**De-emphasis recedes; it never erases.** Dimming blends each mark's own colour towards the
surface, so the context around a focus keeps its structure. Replacing the colour with a flat
`CHART_INK.axis` — which this did — threw the categorical encoding away the instant anything
was selected, and `#383835` on `#1a1a19` is close enough to the background that selecting one
node read as deleting every other. Links recede further than nodes (`DIM_EDGE` > `DIM_NODE`)
because there are far more of them: at equal recession the dimmed mat is still a hairball.

**Focus is an ego network, anchored on the hover or else the selection.** A link is lit only
when it _touches an anchor_, not merely when both its ends are focused — otherwise hovering a
hub redraws that whole neighbourhood's internal structure, which is the thing being cut
through. Hover overrides the selection's focus rather than compounding with it, and hands it
back on leave; a hover is a momentary "show me this instead".

**`.viewer` must stay `position: relative`.** Both viewer overlays — the "laying out…" note
and the link tooltip — are positioned from the renderer's _container_ coordinates. Without a
containing block on `.viewer` they anchor to whatever distant ancestor happens to be
positioned (the node card, the overlay panel) and land nowhere near the pointer.

**No visual verification exists in the suite for these two.** jsdom has no WebGL, so sigma and
three cannot render in tests, and there is no browser automation checked in. Everything testable
is tested headlessly (layouts, encodings, geometry generation, node semantics).

The 3D viewer has since been driven by hand in a real browser — Chrome over CDP, against the
bundled morphology example — and four of the bugs recorded below were found that way and by no
other means. A green suite said nothing about any of them. If you change this viewer, do the
same: the failures here are not "slightly wrong output", they are a control that does nothing
and a gesture that does nothing.

## The 3D viewer

**Everything arithmetic lives in `viewer3dScene.ts`.** Segment building, the colour buffers,
the material decision, the camera framing, the caption's detail note. `Viewer3D.tsx` is a
`<Canvas>` and the components inside it, which no test can reach at all — so the split is not
tidiness, it is the difference between covered and uncovered. Same standing as `networkDraw.ts`
and `roiStyle.ts`.

**The scene is drawn at the origin.** Connectome coordinates are absolute nanometres, so a fly
brain sits ~10⁵ nm out; `SceneContents` translates by −centre and the camera orbits (0, 0, 0).
`framingFor` therefore returns a camera position **in the recentred space**, which is the one
thing about it worth remembering — it is not where the bounding box is. What forced it was the
compass: drei's `GizmoHelper` computes its snap radius as the camera's distance to the _world
origin_ rather than to the controls' target, so on an off-origin scene one click on an axis head
sent the camera a whole brain away. Recentring makes those two distances the same number.

**Four settings that did nothing, and why each was invisible.**

- **`Background`** was applied in `onCreated`, which fires once. The param moved and nothing
  happened, forever after the first frame; so did a theme switch. It is an effect on `gl` now,
  with an `invalidate` — under a demand frameloop a clear colour nobody redraws with is not
  visible either.
- **Picking.** three's raycaster defaults to a **1 world unit** line threshold. A world unit here
  is a nanometre, roughly a fiftieth of a pixel, so selecting a neuron meant clicking inside a
  line to a precision no pointer has. It read as a viewer that had decided not to respond.
  `PickRadius` scales it off the scene extent.
- **Rotation, after the camera became a trackball.** `TrackballControls` records a gesture in its
  pointer handlers but only _integrates_ it inside `update()`, which drei calls from `useFrame` —
  and `frameloop="demand"` runs `useFrame` only when something asked for a frame. The controls
  emit `change` from `update()`, so the event that would ask for the frame is the one the missing
  frame was supposed to produce. Dragging did nothing whatsoever. `InvalidateOnInput` asks for a
  frame while the pointer is down; `frameloop="always"` was the alternative and costs every card
  on the canvas 60fps forever. `OrbitControls` hid this by integrating in its own handlers, which
  is why swapping the camera model turned a working viewer into a still picture with no error.
- **`Line width`** did nothing because WebGL clamps `gl.lineWidth` to 1 in every browser that
  matters, and a material setting was never going to fix it. It needed different geometry
  entirely — see "different geometry, not a different material" below.

**Meshes are opaque, and `depthWrite` has to move with the opacity.** A translucent surface must
not write depth or the first triangle drawn hides the ones behind it and a neuron reads as a pile
of facets; an opaque one must, or it never occludes the skeleton running through the middle of
it — which is the entire reason to draw a surface. `surfaceStyle` owns both, together, and is
where a test can see them. The default flipped from a grey 0.25 ghost because a mesh set is far
more often the whole scene than a backdrop for one, and a scene of ghosts reads as a renderer
that has not finished loading.

**Mesh colour is a peer of skeleton colour**, same factory, same modes, neither `advanced`.
It was a constant grey in the advanced panel, which made "colour these by cell type" something
skeletons could do and meshes could not, for no reason either socket knows about.

**All three encodings resolve above the `<Canvas>`.** Not for speed — because the legend is not
in the canvas. Mesh and point colour used to resolve inside `SceneContents`, which is precisely
why they had no key on screen: the strip could not see them.

**The canvas is stretched to its box with `!important`, and the reason is a coordinate-space
mismatch.** A renderer measures its container with `getBoundingClientRect` — _post_-transform
pixels — then writes that number back as a CSS width, which inside React Flow's transformed card
is _pre_-transform. The zoom is applied twice and the canvas comes out short by exactly the zoom
factor: measured on a card at 0.8, a 560px preview held a 458px canvas with 100px of dead surface
down one side and the scene sitting off-centre inside it. Only the element is stretched; the
drawing buffer keeps the screen-sized resolution the renderer chose, so this is not an upscale.

**A flex child that refuses to shrink pushes the next one out of the bottom.** The card preview's
canvas floor was 150px inside a `.viewer` that had 125px to give, so the canvas kept everything
and the legend and caption were clipped away with nothing to suggest they had ever been there.
80px now, matching `.coda-node__preview`'s own minimum.

**PNG export is a read-back, not a re-drawing.** There is no vector form of a 3D scene, so
`ExportSource` grew a `png` accessor beside `svg`: render one frame and call `toDataURL` in the
_same task_, before the compositor gets a turn and the drawing buffer is gone.
`preserveDrawingBuffer` was the alternative and taxes every frame of every scene for a button
most sessions never press. The pixel ratio is raised to ≥2 for the read, matching the 2× every
other viewer gets from `downloadPng`, and the compass is left out — it lives in a HUD scene, and
a north arrow baked into a figure is somebody else's problem to undo.

That accessor is also why `ViewerActions` now registers **only the accessors a viewer actually
has**. It used to relay all four unconditionally, so presence meant nothing; the Download node
has to ask "could this give me a PNG" without paying for one, and for a 3D scene paying for one
means rendering a frame.

**The compass axes are deliberately not from the chart palette.** They are chrome with a fixed
meaning, and a gizmo drawn in the categorical ramp would read as three data series parked in the
corner. Red/green/blue for X/Y/Z is what every 3D tool here shares, neuroglancer included, and
the labels carry the same information as the colour so nothing rests on telling red from green.
Its margin scales with the canvas: a margin is measured edge-to-centre, so drei's default 80px
parks the compass in the middle of a card-sized picture rather than in its corner.

**Camera up is −Y**, which is navis's default view and the convention the fly EM volumes here
follow — image Y increases ventrally, so a +Y up shows every brain upside down. A default only:
the trackball has no up constraint, and a re-frame restores it so one after a roll does not land
the new scene on its side.

### The scene fills in as it downloads

The card draws what has arrived while the fetch is still running — see **A partial result** in
[core.md](core.md) for the mechanism. Two consequences that belong here rather than there:

**Mesh items are keyed by id, not by id-and-index.** `onPartial` publishes what has arrived _in
final order_, which is a sparse list that gets denser: body 40 appears at index 3 and then at
index 27 as the ones before it land. Folding the index into the React key made every one of those
a different component — unmounted, and its `BufferGeometry` rebuilt — so a 300-body fill would
rebuild the whole scene a dozen times over for geometry that never changed. The index survives
only as a fallback for an item with no id.

**Skeletons pay a real cost per publish and meshes do not.** `SkeletonLines` is one merged
`LineSegments` for the whole channel, memoised on the value's identity — and a partial mints a
fresh identity by definition, so every publish rebuilds the merged vertex buffer. Meshes are a
component per body with its own memo, so a publish costs only the new ones. That asymmetry is
why the publish interval is a quarter second rather than a frame.

### The camera is framed once, then left alone

`CameraRig` replaced a "re-frame whenever the extent changes" rule that sounded helpful and was
not: an upstream node re-running under a view somebody had turned and pulled in threw it away,
and so did expanding a card to the overlay — those are two instances of one node, and a camera
that lives in the component dies with it. Exactly three things move it now: the **first** time
the scene has an extent at all (`size > 1`, not the first mount — a viewer with nothing run yet
has a placeholder extent of 1), a **remount** restoring from `cameraMemo`, and the **Reset view**
control, which forgets the memo and frames again.

A bounds change still updates the clip planes, because those describe the _space_ rather than
the view — a scene ten times larger under an unchanged camera clips through its own near plane.
That is the whole of what an extent change is allowed to touch.

`cameraMemo.ts` is `layoutMemo.ts`'s shape and exists for the same reasons: module-level so it
survives unmount, session-scoped so a camera never lands in a `.coda.json`, LRU-capped as a leak
guard. The recentred scene is what makes a stored camera meaningful across a data change at all
— swapping one neuron for a cell type moves the contents, not the space they are drawn in.

**A drag is not a click, and the DOM disagrees.** `click` fires on pointerup whatever happened
in between, so turning the scene selected whichever neuron was under the cursor when the hand
stopped — every time. It was invisible until the trackball started working: before that,
dragging did nothing, so nothing followed it. `PointerGestures` owns the pointer listeners (it
is also what asks for frames) and publishes a "this gesture moved" ref through context, which
the pick consults. `DRAG_SLOP` is 4px.

**`Line width` above 1 is different geometry, not a different material.** WebGL clamps
`gl.lineWidth` to 1 everywhere that matters, so the setting did nothing for as long as it
existed. Above 1 the skeletons are built as `LineSegments2` — every segment an instanced
camera-facing quad — at roughly four times the vertex data, which is why 1 keeps the cheap
`LineSegments` path rather than the fat one being the only one. Two things it needs that a
normal material does not: `resolution` must be the canvas size in CSS pixels and follow a
resize, or the shader has no idea how wide a pixel is; and a hit arrives as `faceIndex`, the
segment, where the hairline path reports a vertex. `raycaster.params.Line2.threshold` is its own
key too, in pixels rather than nanometres — `PickRadius` sets both.

### `by radius`: the width the data already carried

**`SkeletonGeometry.radii` was filled by every backend and drawn by none of them.** CATMAID's
annotated radii, CAVE's L2 `max_dt_nm`, neuPrint's SWC radius column — all three have been
arriving since skeletons did, and the viewer read `positions` and `parents` and stopped. So this
is not a new capability so much as the last step of one that was already paid for.

**three's `LineMaterial` takes one `linewidth` uniform**, so the fat path drew a constant-calibre
wire, which is the one thing a neuron is not. `flexLineMaterial.ts` rewrites the site in three's
own `line` vertex shader where that uniform is read, and adds `instanceWidthStart` /
`instanceWidthEnd` beside the `instanceColor*` pair the layout is copied from. Patching rather
than writing a shader is the whole point: the camera-facing quad, the endcaps, the clip-space
trim near the camera plane and the round-cap anti-aliasing are all hard and all already there,
and a replacement would inherit none of the fixes upstream makes to any of them.

pygfx has the identical limitation — `LineMaterial.thickness` is one number — and octarine's
`shaders/lines.py` solves it with the same three-line patch against `line.wgsl`. Two renderers,
two graphics APIs, one diff.

**Two width spaces, five patched sites.** The stock shader reads `linewidth` in three places and
which of them matter depends on `worldUnits`. In **screen space** there is one site,
`offset *= linewidth` in the vertex shader; the anti-aliasing runs in normalised `vUv` space that
the quad's own extent already scales, so a per-vertex width needs no varying and no fragment
change at all. In **world units** there are two, and they have to agree: `hw` in the vertex
shader extrudes the box, and `len / linewidth` in the fragment shader carves the tube out of it.
Patching only the first widens the box and leaves the silhouette where it was — a mode that draws
nothing extra; patching only the second carves a tube wider than its own box and clips it flat.
The other two sites are the shared width attributes and the varyings that carry the world width
across the stage boundary. Both spaces live in one shader source under three's own `WORLD_UNITS`
define, so `worldUnits` stays a runtime flag rather than a second material class.

**The endcaps come out right for free**, and this is why the patched sites are the ones they are.
In both spaces the width is applied *after* the endcap extension, so scaling by the vertex's own
width gives each end of a segment the cap of the node it sits on: a segment between two calibres
is a trapezoid in screen space and a cone in world units. That is what makes a taper continuous
across a node rather than stepping at every join — confirmed by eye at width 12 on the bundled
morphology example, which is the only way it could be confirmed.

**`flexLineVertexShader` and `flexLineFragmentShader` throw when an anchor moves, and a test runs
both.** This is the failure
mode of any shader patch: a `three` bump renames a variable, the patch matches nothing, the
material compiles, and every skeleton draws at the uniform width with no error anywhere.
`ShaderLib` is plain text and needs no GL context, so `flexLineMaterial.test.ts` is the one part
of the fat-line path jsdom can cover — and it is the part most likely to break silently. A throw
rather than octarine's warn-and-fall-back, and `pcf.py` records the distinction: a silent
fallback is right for an always-on tweak whose stock behaviour is still correct, and wrong for a
mode somebody selected by name.

**The scale is expressed at the thick end, and the reference is the p95 rather than the maximum.**
Radii here are derived, not measured — CATMAID's are annotated where anybody bothered, CAVE's are
a distance transform over voxels — and both produce a tail. Scaling against the maximum lets one
bad node decide how wide every other node is drawn, so a single runaway radius flattens the whole
arbour onto the floor and the mode reads as not working. `referenceRadius` takes the p95 by
nearest rank and `MAX_LINE_WIDTH` catches the tail beyond it.

**`MIN_LINE_WIDTH` is 1 and is not a style choice.** Below a pixel a line is not reliably drawn,
and every source here has nodes this catches: CATMAID stores −1 for "unset" and `CatmaidSource`
clamps it to 0, and a CAVE L2 chunk too small to have a `max_dt_nm` is 0 as well. Without the
floor the twigs leave the picture and it reads as a fetch that returned only trunks.

**A source with no radii at all gets `undefined`, not a buffer of floors**, and the caller falls
back to the uniform path. The two are not the same picture: a uniform 1px hairline is what the
thin path already draws cheaply, where a *fat* line of width 1 everywhere is that same picture at
four times the vertex data — the fat path's whole cost for none of its benefit. Which material is
built turns on the buffer rather than on the mode for the same reason, since a patched shader
reading an attribute that is not there draws every line at zero width, i.e. nothing.

**Two width params, exclusive by `visibleIf`, presented as one composite row** — the shape a
colour already uses for its column picker and its swatch. They cannot be one param because they
are not the same number: `Line width` under `uniform` is the width every node gets and starts at
1, and under `radius` it is the width of the *thickest* node and starts at 4. At a scale of 1
everything below the reference clamps to the floor and there is no visible taper at all, so a
single stored width would open a saved graph looking like the mode had done nothing. `to scale`
is a third, and it is the one that is a *multiplier* rather than a width — see below.

### `to scale`: the same radii, in nanometres

`by radius` is in pixels: radii are rescaled so the p95 node lands on the width you set, and the
arbour looks the same at every zoom level. `to scale` is in the scene's own units, so a 200 nm
neurite is drawn 200 nm across and thickens as you zoom into it. Nothing is normalised and
nothing is clamped — this is the calibre as published, and the only one of the three you could
measure a neurite off. pygfx spells the distinction `thickness_space`, and it is the mode
octarine defaults skeletons to.

**The two modes are the same buffer with a different unit**, which is why
`skeletonSegmentWorldWidths` is six lines beside `skeletonSegmentWidths`' rescale-and-clamp:
there is nothing to normalise against because the number already has a unit. Both ask
`referenceRadius` the same "has this source got radii at all" question, so they fall back to the
uniform path on exactly the same skeletons rather than one of them drawing an invisible scene.

**The pixel floor moved into the shader, and had to.** `MIN_LINE_WIDTH`'s counterpart cannot be a
number of nanometres: a floor in world units is a floor at one zoom level and invisible or
enormous at every other. So `MIN_WORLD_PIXELS` is applied per vertex where the projection is
known — `2.0 / ( projectionMatrix[1][1] * resolution.y )` scaled by `abs( clip.w )`, which is the
view depth under a perspective projection and exactly 1 under an orthographic one, so one
expression covers both cameras. pygfx has the same floor at `1.415 / l2p`; three has none, which
makes this the one part of the world-units path that is an addition rather than a substitution.
The floored widths go into the varyings rather than the raw attributes, because the fragment
shader must carve the tube at the width the box was built at.

**three's view ray is `1e5` units long, and this scene is measured in nanometres.** The one real
bug in the port, and it presents as the feature not existing. `vec3 rayEnd = normalize(
worldPos.xyz ) * 1e5` is a generous ray in a scene measured in metres and exactly 100 µm in one
measured in nanometres; past that the ray stops short of the neuron, `closestLineToLine` clamps
its parameter to `[0, 1]`, the closest point on the ray becomes the ray's own end, `norm` is
enormous and **every fragment discards**. The skeleton vanishes whole, in a single zoom step,
with nothing in the frame to say why. Measured on the optic-lobe mock, one neuron, ink against
on-screen extent: `to scale` went blank between 73 px and 60 px while `one width` and `by radius`
drew on down to 32 px. Scaling the ray to the segment's own view-space distance removes the
assumption rather than moving it, and is better conditioned besides — the stock ray overshoots a
nanometre scene by nine orders of magnitude before the dot products.

**The measurement that shows the mode is doing what it claims** is ink against extent as the
camera pulls back, since a screen-space width and a world-space one differ in the *exponent*
rather than in any single frame. Fitting `ink ∝ extent^p` over one neuron, eleven zoom steps from
251 px of extent to 32 px:

| mode | p over the first three steps | p over the whole sweep |
| --- | --- | --- |
| `one width` | 1.01 | 1.04 |
| `by radius` | 0.98 | 1.02 |
| `to scale` | 1.57 | 1.28 |

Both screen-space modes are exactly linear — only the length shrinks. `to scale` starts near the
quadratic case, both dimensions shrinking, and falls back toward linear as more and more of the
arbour reaches the pixel floor. The floor is visible in the data rather than only asserted.

**What world units do not buy: skeletons in the AO pass.** The obvious expectation, and it is
wrong for three reasons that are each enough on their own. The geometry is still a camera-facing
box; the tube is *discarded* out of it in the fragment shader, so only the fragment stage knows
its shape; and the vertex shader deliberately overwrites depth with the depth of the segment's
nearer endpoint (`clip.z = clipPose.z * clip.w`) so consecutive segments overlap without
z-fighting — leaving the depth buffer holding a staircase of flat discs rather than a surface.
And `GTAOPass` replaces every material with `MeshNormalMaterial` for its normal pass, so the line
shader does not run there at all. Skeletons in AO need real swept geometry; octarine's
`shaders/tubes.py` is what that costs, and its own header records four attempts at making a swept
arbour look right.

### The lights, and the debt `flat` left on them

The scene is an `ambientLight` and one `directionalLight`, and both were raised 50% —
`0.85 / 0.6` to `1.275 / 0.9` — with a `Light intensity` slider over the pair.

**The reason is a debt rather than a preference.** `<Canvas flat>` had to drop ACES tone mapping
so ambient occlusion would stop moving the background (below), and the curve's shoulder had been
carrying exactly the midtones a rough dielectric spends its range in. The same mesh pixel went
`#71a430` to `#61962d` at the time and it was recorded as a trade; the surfaces read muted from
then on. Raising the lights pays it back on the geometry rather than putting a curve back over
the background.

**One slider and not two**, because the *ratio* between fill and key is what decides how much
shape a surface shows and it was chosen once against the palette. `sceneLights` is the scaling,
and it falls back to the calibrated pair on a non-finite or negative value rather than to
darkness — it reads a stored param, and a graph that reopens black looks like a viewer that
failed to load rather than like a setting.

**50% more light is 17% more pixel**, and that is the sRGB curve rather than a mistake. The
renderer works in linear light and the framebuffer is encoded, so 1.5× radiance is
1.5^(1/2.2) ≈ 1.20× in the values a screenshot reads; 1.17 came back. Across the whole slider,
1 → 2 moves mean luminance only 105 → 135. Anyone asking why the numbers move less than the
setting has found this.

**`NoToneMapping` clips where a curve would roll off**, which is what makes the top of the slider
a real edge. Light past the point a channel saturates does not brighten a surface — it
desaturates it toward white and walks it out of the validated palette. Measured on four opaque
optic-lobe meshes, share of surface pixels with a saturated channel:

| slider | 0.25–1.4 | 1.5 | 1.75 | 2 |
| --- | --- | --- | --- | --- |
| saturated | 0% | 1.7% | 12.9% | 23.1% |
| mean luminance | 63.1 → 119.8 | 122.9 | 129.7 | 134.6 |

The range keeps its top — a limit warns, it does not refuse, and a blown highlight is a look
somebody may want — and the help carries the number. Note the headroom is a property of *this*
scene's albedos rather than a constant: a paler palette saturates sooner.

**Mask the compass before measuring any of this.** It is unlit UI drawn over the canvas, near
white, and identical at every setting — it supplied every "clipped" pixel in the first pass here
and made two different light levels look like they had the same ceiling.

### Ambient occlusion, and four things a composer changes underneath it

**`GTAOPass`, not `SSAOPass`** — same effect, better estimator, and both ship in three. Ported
from octarine, which has to hand-write the pass because pygfx has none; what carried over is not
the estimator but the two findings around it.

**It is mounted only where there is something to occlude.** three's own comment in
`GTAOPass.render` is "honor only meshes, points and lines do not contribute to AO", and lines and
points are hidden before the normal buffer is rendered. A skeleton scene is entirely lines, so
the pass would run over an empty g-buffer and blend a uniform white result — four passes and
three render targets to multiply the image by 1. octarine records the same finding from the other
side, recommending `edl` for lines. `wantsAmbientOcclusion` is that decision, and it is what
makes a default of **full strength** honest rather than a default nobody measured: the common
scene never constructs a composer at all.

**A fat line is a `Mesh`, and three's own list does not catch it.** `_overrideVisibility` tests
`isPoints || isLine || isLine2`, and `LineSegments2` — the class every skeleton above a width of
1 uses — matches none of the three: it extends `Mesh` and carries `isLineSegments2`, while
`isLine2` belongs to `Line2`, a *different* subclass this viewer does not use. So a fat skeleton
reached the normal pass, where `MeshNormalMaterial` ran over `LineSegmentsGeometry`'s instanced
template quad with none of the line shader that positions it, writing a two-unit box at the model
origin into the normal and depth buffers on every AO frame. Subpixel in a scene 10⁵ nm across,
which is why nobody saw it, and not subpixel at all the moment somebody views one small neuron.
`hidesFromGtao` is the predicate and `ambientOcclusion.test.ts` asserts the flags directly,
because this is a claim about three's classes rather than about ours. Note the type system agrees
with the finding and still could not have caught it: `@types/three` does not declare `isLine` on
`LineSegments2` either, but three's test is untyped property access on an `Object3D`.

**Every world-unit uniform is rescaled, and there are two of them.** `GTAOPass` defaults to
`radius: 0.25` — a quarter of a nanometre here, an occlusion search that never leaves the pixel
it started in — so the radius is 4% of the scene's extent, which is octarine's number. That much
was the obvious half. The other is `thickness`, three's default `1`, which `GTAOShader` uses as
`if (abs(viewDelta.z) < thickness)` to decline occlusion from a thin object it can see past: at
one nanometre against a 555 nm radius, **every sample was rejected** and the pass blended a
uniform white for a fortnight of screenshots that looked almost right. `aoThicknessFor` keeps
three's own 4:1 ratio between them. Measured as the share of the frame carrying any occlusion at
radius 555: 0.1% at thickness 1 and 50, 0.2% at 200, 0.7% at 555, 6.3% at 2,200, 11.2% at 10,000.

The general form is worth keeping: a screen-space effect ported into a scene measured in
nanometres needs *every* world-unit uniform moved, because a library's defaults are a set that
agree with each other. Rescaling one is not a partial fix, it is a different kind of broken —
and it fails the way three's 1-world-unit raycast threshold did for picking: renders, does
nothing, looks like the control is off.

**A translucent surface must not cast occlusion**, and the stock pass has no notion of that.
`_renderOverride` sets `scene.overrideMaterial`, which replaces an object's material outright and
its `transparent` flag with it — so a neuropil shell at 0.12 writes normals and depth as though
solid, and the arbour inside it is occluded by a surface it is plainly visible through. It reads
as dirt on the render. `SurfaceGtaoPass` extends the visibility override, which also catches
*dimming* for free: `surfaceStyle` turns a dimmed mesh translucent, so selecting one neuron drops
the other twenty out of the g-buffer on the same rule.

**One number, not a toggle plus a strength.** `GTAOPass`'s blend is
`mix(vec3(1.), ao, blendIntensity)`, so 0 already means "no darkening" exactly — a checkbox
beside the slider would have been a second spelling of `strength === 0`, and two controls that
can disagree end up showing a scene with no occlusion in it and a box insisting the effect is on.
`wantsAmbientOcclusion` reads `strength > 0`, written that way round so a `NaN` from a malformed
saved param is off rather than full. It is `NumberParam.slider` because it is a proportion set by
feel and watched, which is that flag's own rule.

**The range runs to 2, which octarine's `intensity` does not**, and what happens past 1 is worth
stating because it is not "more of the same". 1 is where a *fully* occluded pixel reaches black,
so beyond it the effect **widens rather than deepens** — the mix extrapolates to `2*ao - 1` and
pulls the mid-occluded range down as well. Measured as mean darkening over the surface pixels:
**5.2% at 0.5, 13.1% at 1, 22.7% at 1.5, 29.7% at 2**, with the share of surface pixels reaching
black going 0 → 37 → 1,908 → 4,469 out of 48,122. So the crush is small up to 1 and real above
it — 9% of the surface at the top of the slider — which is the trade that range buys. It is safe
rather than merely tolerated: the blend is multiply, so an extrapolated negative clamps at the
framebuffer, and three selects the linear branch of the sRGB transfer with a `bvec` — a select,
not a lerp — so the `pow` of a negative never reaches the output as NaN.

**A mean that will not move is a broken effect until proven otherwise.** The first version of
this measured 91.6 against 91.8 over the same region — nothing — and the explanation written down
at the time was that these arbours are thin convex tubes with few crevices, so the effect must be
local and an aggregate the wrong instrument. That was wrong, and it was wrong in the most
expensive direction: a plausible story about *why the number is small* that stopped the
investigation one step short of `thickness`. What settled it was rendering
`GTAOPass.OUTPUT.Denoise` — the occlusion buffer alone, which is what octarine's `debug=True`
exists for. An almost entirely white frame with a few scattered specks is not a subtle effect; it
is an estimator finding nothing. **Look at the effect's own buffer before explaining its
magnitude.**

**The pass has to come out of the memo, not out of a ref written inside it.** The first version
did `passRef.current = ao` in the `useMemo` body and `passRef.current = null` in an effect
cleanup, which is a mismatch: a cleanup runs on every unmount, where a `useMemo` is free to hand
back its cached value without re-running the body. React 19's double-invoked effects are enough —
mount, clean up, mount again — and the second mount reused the composer, so the ref stayed null
for the rest of the component's life. The symptom is worth recognising because it is not "the
control does nothing": the *first* change applied and every later one silently did not.

**Cost, measured rather than assumed:** 21 meshes at 2× device scale, ANGLE Metal on an M3 Max,
a sustained trackball drag — 59.9 fps with the pass and 59.9 without, reproduced either side of
the toggle. Note the first attempt at this measured 14.5 fps against 5.9 and was worthless:
headless Chrome falls back to SwiftShader unless it is asked for a GPU, and a software rasteriser
penalises full-screen passes in a way no GPU does. `--use-angle=metal --enable-gpu`, and check
`UNMASKED_RENDERER_WEBGL` before believing a number.

#### The background broke twice, in two different ways

Both were invisible to every test and both changed the picture the moment AO was switched on.

**`RenderPass` sets the clear colour before it binds the target.** A renderer's clear colour is
converted to the colour space of whatever target is bound *at the moment it is set*, so the
surface was converted for the screen, written into the composer's linear buffer, and encoded a
second time by `OutputPass`. Measured: `#1a1a19` came out `#585855` — a dark canvas turning
mid-grey, with the geometry on top of it unchanged, because only the clear took the extra
conversion. The fix is `scene.background`, which is painted inside `renderer.render` after the
target is bound and is therefore converted against the buffer it lands in. One mechanism, both
paths — and `CaptureBridge` now drops the background *and* the clear alpha for a transparent
export, since dropping only the alpha would leave the background painted opaque over it.

**Tone mapping is per-material in the ordinary path and per-image through a composer.** React
Three Fiber defaults a canvas to `ACESFilmicToneMapping`; a scene background is a clear rather
than a material, so it never receives the curve directly, and receives it once through
`OutputPass`. Measured on `#1a1a19`: unchanged without the composer, `#080808` with it. Short of
pre-compensating there is no way to keep a curve on the geometry and off the background in a
composited path, so the canvas is `flat` — `NoToneMapping` — and the two paths agree, re-measured
at `#1a1a19` either way. **This changes how surfaces look and that is the trade, not a side
effect**: the same mesh pixel went from `#71a430` to `#61962d`. Reverting it means finding another
answer for the background, not just putting the curve back.

#### Two more seams a composer moves

**`EffectComposer.setSize` takes CSS pixels and applies its own `_pixelRatio`** — `addPass` sizes
each pass as `_width * _pixelRatio`. Handing it `getDrawingBufferSize` applies the ratio twice, so
on any retina display the targets are quadruple-area and the AO is sampled at the wrong scale;
it reads as a soft, misaligned effect rather than as an error. `setPixelRatio` is the seam, and it
re-runs `setSize` itself.

**PNG export renders its own frame and has to render it through the chain.** `CaptureBridge` takes
a ref that `AmbientOcclusion` fills while mounted, read at call time rather than captured — a
scene can gain and lose its composer while the bridge stays mounted, and a callback closed over a
disposed chain would export through it. The export also raises the pixel ratio for one frame, so
the composer is re-sized to match before that render and `RenderTarget.setSize` no-ops the rest of
the time.

### Picking is opt-in, and clearing is the count

**`Select by clicking` is off by default, and that is a reversal worth stating.** Every other
param on this node is presentational; `selection` is the one that is not. It takes part in the
provenance key, so a click marks everything downstream stale and re-runs it — which makes a
*stray* click a re-run of somebody's query rather than a cosmetic slip. `DRAG_SLOP` already
catches the gesture that turns the scene and then releases over a neurite, but nothing catches a
click that simply lands on one, and on a trackball there is no click-free way to say "I was only
looking". The asymmetry decides the default: switching the toggle on costs one click, and the
false positive costs a re-run.

**It gates the draw sites, not `onSelectionChange`.** Clearing the callback would have been one
line and would have taken the legend's label-select with it — and a label is the one route into a
selection that is unambiguous about what it names, which is exactly the property the toggle is
protecting. So the skeleton object carries no `onClick` at all when picking is off, which also
means it leaves React Three Fiber's interaction set and stops being raycast: "not pickable" in the
sense that costs nothing, rather than a handler that declines.

**Only skeletons were ever pickable.** Meshes, points and volumes carry no click handler — the
selection is of neurons and resolves against skeletons then meshes, but no mesh draw site ever
reported a hit. The toggle therefore gates exactly one handler, and the wording on the param says
"a click in the scene" rather than naming a socket.

**Clearing is the count itself, not a control beside it** — `3 selected ⨯`, the same affordance
the histogram, distribution and pie viewers already put in this row, down to the class and the
glyph. The count leaves the caption's joined text when the button is showing rather than being
restated in both places, and stays in the text for a read-only surface with no
`onSelectionChange` to offer. Shown only when there is a selection, for the reason the legend's
`show all` is: a permanent control for an empty state is a button that does nothing most of the
time. It matters more here than on the three chart viewers — with clicking off by default, a
selection made and then regretted would otherwise be undoable only through the inspector's
`Selected` row, which is a list of ids three panels away from the picture.

**Transparent PNG is a property of the clear, not of the scene.** The context has an alpha
channel all along; the background is opaque only because the clear alpha is 1. The cut-out drops
it to 0 for the length of one render. It is offered only by the read-back path, and that is not
an omission — a viewer that rasterises its own SVG has no background painted into it to begin
with, so "no background" is not a second thing to ask for there. Worth knowing: a cut-out of
hairlines arrives _pale_, because a one-pixel line is mostly coverage rather than colour, which
is one more reason for the fat-line path to exist.

**Opacity is a facet of the colour row** (`composite` `role: 'extra'`), not a control beside it,
and `NumberParam.slider` is what draws it as a range — opt-in, and only sensible where the
number is a proportion somebody sets by feel and watches the result of. A native colour input
has no alpha channel to expose, which is why this is a channel-wide setting rather than per-key:
per-key alpha would leave a categorical scene with no overrides unable to be translucent at all.

**Every param on `out.viewer3d` is `advanced`, leaving the card with no rows.** A deliberate
reversal of the note above about `out.network`: a card with no rows loses its `☰` fold and reads
as a node with nothing to set. On a viewer whose whole face _is_ the picture the trade goes the
other way — twelve rows of pickers above a scene is a settings panel with a thumbnail attached.
The legend does the colour work in place, and the caption already says what the `Selected` row
used to. `viewer3d.test.ts` asserts the empty card _and_ that everything still reaches the
inspector, which is what makes it safe.

### One live renderer per node

**A viewer is a renderer, not a picture, and the WebGL ones are not free to draw twice.** The
card, the inspector and the overlay are three independent `ValuePreview` mount points for the
same node. Measured in Chrome on the bundled 21-neuron morphology example, with all three up:

| Surfaces up                | Live WebGL contexts | Uploaded per context | Draw calls for one param change |
| -------------------------- | ------------------- | -------------------- | ------------------------------- |
| card                       | 1                   | 170 kB               | 55                              |
| card + inspector           | 2                   | 170 kB               | 99                              |
| card + inspector + overlay | 3                   | 170 kB               | 154                             |

Three contexts, three copies of the same geometry on the GPU, and every invalidation paid for
three times. It scales with the scene: a mesh set at the 1.5M-triangle budget is tens of
megabytes, times however many surfaces happen to be open. Chrome also caps live contexts at
about sixteen and kills the oldest to make room — and the one it kills is a card that then
renders blank with nothing on screen to explain it.

Two rules now keep it at one, and both were verified with the same instrumentation:

- **`summary` stands a WebGL viewer down.** The prop was introduced for the table — a
  60-column grid in a 320px panel is three columns behind a sideways scrollbar — and its note
  says a viewer with a drawing of its own keeps it, "because those already draw something sized
  to their box". True of an SVG or a canvas; false of these two in the way that costs. The
  inspector now names what it would have drawn and offers `Open full size`. `HAS_OWN_CONTEXT`
  in `ValuePreview.tsx` is the list, and it is short for a reason: what it names is "renders
  through WebGL", which is a property of the viewer component rather than of the node, so
  nothing on a `NodeDefinition` could answer it. `LazyViewers.tsx` is the other place that
  knows, about the same two.
- **A card does not draw while the overlay owns its node.** The overlay is modal and covers the
  canvas, so nothing behind it is visible; the card's `showPreview` takes `expandedNodeId` into
  account. The cost is a remount when the overlay closes, which re-frames the card's camera —
  the right way round, since somebody who has just been working full size is not also curating
  the thumbnail behind it.

Both are DOM facts, so `liveRenderers.test.tsx` covers them in jsdom even though the thing they
are protecting against is invisible there.

### The `Volumes` socket

**A second meshes input, and the duplication is the point.** A neuropil shell and a neuron are
the same `MeshesValue` and never the same mark: one is an opaque object somebody is looking at,
the other is faint context around it. Sharing the `Meshes` socket would mean one opacity and one
colour encoding for both, so drawing a neuron inside a region would either bury the neuron or
turn it to glass along with the region.

Everything that follows from that is a default, not a mechanism. `volumeOpacity` starts at 0.12
where `meshOpacity` starts at 1; `volumeColor` starts at a constant grey where the other three
start categorical, because a categorical encoding over 63 neuropils is eight hues plus `Other`
and reads as a claim that eight of them are special.

**Volumes come last in the bounds chain and never dim.** A shell is one to two orders of
magnitude larger than the arbour inside it, so framing on the union answers "show me this neuron
in LO(R)" with a picture of LO(R) and a speck — the existing first-one-wins precedence already
did the right thing, and volumes simply join the end of it. Dimming is the other half: a region
is not a neuron, so greying it when a neuron is selected would say it had been _deselected_, a
claim about something that was never in the selection.

They are excluded from the selection for the same reason points are — `evaluate` resolves
against skeletons then meshes, and a region has no neuron id — so the volumes legend key offers
hide and recolour but not select.

### The interactive legend

Three affordances per key — recolour, select, hide — and the split across files is the same one
the rest of this section records: what a key _means_ is shared, what a key _does_ is per viewer.

**`resolveColor` grew `labelAt`, which is the inverse of `legend`.** A key that can be clicked
has to say which rows it stands for, and only the resolver knows: it ranked the categories, it
decided which eight were kept, and it folded the rest. Rows past the cap answer with
`OTHER_LABEL` rather than with their own value — hiding `Other` has to hide all of them, which
it cannot do if each row answers with a name that is not on the strip. `labelAt` is absent for
constant, sequential and literal encodings, and callers read that as "not addressable by key"
rather than as an error.

**Colour overrides live in `ColorSpec`, not in the viewer.** `spec.overrides` is a
`{key: hex}` map applied inside `resolveColor` to `at()` _and_ to the legend entries, in one
pass. Applying it in a viewer instead would put the mark and the key it is filed under in two
different hands, which is the failure this module's opening paragraph exists to prevent. An
override that is not a colour is ignored — `literalColor` already owns what counts as one.

**Two params per channel, both `advanced`, both `presentational`, added by `colorParams` only
under `legend: true`.** `<prefix>Hidden` is an `ids` param (the read-only count plus `clear`
that `selection` already uses) and `<prefix>ColorOverrides` is the map as JSON. Per channel and
not shared, because `LC4` under a skeleton colour and `LC4` under a point colour are different
sets of rows that happen to share a word. `readColorOverrides` is deliberately tolerant: the
value is a string in a saved file, and an unreadable one means "no overrides", which is the
state every graph written before this existed is already in.

**Presentational is the whole distinction the Network Viewer's filters record from the other
side.** Hiding a key changes what is drawn and nothing else — the node still emits the same
selection — so it stays out of the provenance key and stales nothing. A control that changed
the output would have to be the opposite and say so on its tab.

**Both params are `visibleIf` non-empty, which is not the usual use of that hook.** At rest they
are an empty row and an empty text box in every panel: controls that look like something to fill
in and are not. They appear when they hold something, which is also when the `clear` beside the
count is worth having. Safe under invariant 4 either way, since presentational params were never
in the key for the hiding rule to change.

**A hidden item is left out of the buffers, not drawn transparent.** That is what also makes it
unpickable — geometry that is not there cannot be raycast — so hiding a key and clicking where
it used to be does nothing rather than quietly selecting an invisible neuron. It costs a
geometry rebuild, which is the one restyle that does, and it earns it.

**The caption counts what the legend is holding back.** Same rule as `labels thinned` and
`meshes simplified`: a scene drawing 12 of 21 neurons looks exactly like a scene that fetched
12, so nothing removes data from a picture silently.

**Selection is offered per channel, and points do not get it.** Their rows are synapses;
`evaluate` excludes their table from the selection for the same reason. `LegendControls` is all
optional fields precisely so a channel can decline one — the points key renders its label as
text where the skeleton key renders a button, because an affordance that would lie is left out
rather than disabled. Clicking a key that is already wholly selected releases it; a key that was
_partly_ picked by hand fills in instead, or the click meant to complete the set would throw the
set away.

**`useStable` on all three specs, which this viewer should have had from the start.**
`readColorSpec` mints a fresh object per render of the parent, so the colour memos invalidated
on every unrelated store tick and rebuilt a 40k-segment buffer each time. The rule in CLAUDE.md
is one line; the 3D viewer was the one place not following it. The overrides map made it
load-bearing rather than merely wasteful.

### A colour per neuron: neuroglancer's hash

`segmentColor.ts`, the `hash` colour mode, and the default for the Skeletons and Meshes sockets.

**The palette was answering the wrong question.** `categorical` has eight validated slots and
folds the ninth value into an achromatic `Other` — the right rule for a _series_, where a
repeated hue would claim two things are the same. On `neuronId` it is a claim about identity,
and a scene of twenty neurons drew twelve of them identically grey. Colour there is not a
category; it is _which one this is_, and identity has no cap.

**It is neuroglancer's hash, not a hash.** That is the whole value: people already have these
colours on screen, so a neuron being teal here and teal in FlyWire is the difference between two
views of one dataset and two unrelated pictures. Inventing one would have produced colours that
are fine and match nothing. `segmentColor.ts` is a transcription of `segment_color.ts` and
`gpu_hash/hash_function.ts` from google/neuroglancer (Apache-2.0), down to the rotation amounts
and the omitted final avalanche — it is _not_ a complete MurmurHash, and completing it would
give a perfectly good hash with different colours.

**Seed 0 is the default because `toJSON` omits it.** `SegmentColorHash.getDefault()` is seeded
0 and serialises to nothing, so a link carrying no `segmentColorSeed` is a link on seed 0 —
which is every link `out.neuroglancer` emits. The agreement is by construction rather than by
eye, and `segmentColor.test.ts` pins the colours of specific ids so a "harmless" refactor of the
bit twiddling cannot quietly change them. Nothing there would throw; it would just be different.

**Ids are hashed as text, and that is invariant 8 in the one place it would be invisible.**
`Number('720575940621039145')` and `Number('720575940621039144')` are the same float64, so a
hash taken after a numeric conversion is the hash of a _neighbouring segment_ — and what comes
out is a perfectly plausible colour. `BigInt` on the text, masked to 64 bits, split into the two
32-bit halves neuroglancer combines.

**Value is pinned at 1**, neuroglancer's own choice: every hash colour is fully bright, so the
set reads on black and washes out on white. One more reason the `Background` control exists, and
one reason this mode is **not** claimed to be accessible — the hues cover the whole circle with
no regard for the colourblind-safety gate `colors.ts` documents. That is the trade identity
makes, and it is why the hash lives in its own file rather than joining the validated palette,
which stays the thing to use when colour carries meaning.

**The legend keeps working, which is why the mode is not `literal`.** Every distinct value is
its own key, so hide, solo, select and recolour stay per neuron. Two departures from
`categorical`: keys are listed in **first-appearance order** (there are no slots to rank for),
and the strip lists at most `HASH_LEGEND_KEYS` = 12, because a hundred 18-digit root ids is not
a legend. The remainder is **unlisted, not folded** — those neurons still have colours of their
own — so `CategoricalLegend.unlisted` carries the count and the strip prints `+9 more`. Twelve
keys over twenty-one neurons with nothing said would read as a scene of twelve.

**Points stay categorical.** A synapse table's useful columns are groups — polarity, partner
type, region — and hashing four values spends the mode's one advantage on a column with no
individuals in it, in exchange for four unvalidated hues.

**`allowHash` is opt-in, and `out.neuroglancer` deliberately does not take it.** That node
already offers `default`, which sends no colours and lets neuroglancer hash them; since Coda's
hash _is_ neuroglancer's, adding the mode there would put two spellings of one behaviour in one
dropdown.

### Switching a whole socket off

`showSkeletons` / `showMeshes` / `showPoints` / `showVolumes`, and the switches at the head of
the legend strip.

**The legend could not ask this question.** Keys exist only where an encoding is categorical, so
a _constant_ colour produces no legend at all — which is what neuropil shells ship with. The one
channel most often in the way was the one with no control anywhere that could remove it.

**Folded into the `visible` predicates rather than checked at each draw site.** `NEVER` replaces
the channel's predicate, so the caption's hidden count, the geometry builder and the raycast get
the same answer without four places remembering to consult a flag. The socket is _also_ skipped
in the tree — an empty buffer handed to a material still costs a pass on every restyle — so
`visible` is the authority for rows and the render gate is the authority for sockets.

**The switch and the group's name are one control.** The strip already prints "skeletons" as a
group title when more than one channel is on screen; a separate row of switches put the same
four words in the strip twice. So `LegendControls.onToggleChannel` turns the title into the
switch, and `ChannelToggle` is exported so the _keyless_ case — the constant colour above — can
draw the identical thing on its own.

**Shown only above one wired socket**, on both counts: naming the only subject in a scene
restates what the card is, and switching it off is a control whose single use is making the
viewer blank.

**Presentational, like the hidden-keys list and for the same reason.** What is drawn changes;
what `Selected` carries does not, so turning a channel down to see behind it must not stale
everything downstream.

**`shown` is read as `!== false` at the ValuePreview seam.** A graph saved before these params
existed has no key for them, and `=== true` would open every old file with an empty scene.

## Scatter plot

`out.scatter`, `Add ▸ Visualisation ▸ Scatter Plot`. seaborn's `scatterplot` — x, y and the
three encoding channels hue, size and style — plus what this data needs on top: log axes, a
linear fit, and a lasso that hands the enclosed neurons back to the graph. `Table → Scatter`
passes the table through and emits `Selected`, so it is a tap like every other viewer here.

**Canvas rather than SVG, and that follows from what it is for.** The `Embedding` node in the
TODO list feeds this one, and an embedding is of a _whole dataset_ — male-CNS is 165,122
traced neurons. One `<circle>` per row is a hundred and sixty thousand DOM elements. Export
re-draws the same spec as vector (`scatterDraw.ts`), so what is given up is the DOM and not
the vector file. Same doctrine as `networkToSvg`, arrived at from the same constraint.

**Everything geometric is in `scatterPlot.ts`, headless, and that is not tidiness.** jsdom has
no canvas, so anything left in `ScatterViewer.tsx` is covered by nothing at all — the same
standing `networkLayout.ts` and `networkDraw.ts` have. Scales, ticks, the point budget,
projection, hit testing, lasso containment and the least-squares fit all live there.

**Two coordinate spaces, and mixing them is the trap.** _Value space_ is what is in the
column and what a tooltip prints; _transformed space_ is that under the axis scale, i.e.
`log10(value)` on a log axis. Domains, ticks, the viewport and the trend fit are all
transformed, because that is the space the picture is linear in. `forward`/`inverse` are the
only crossings and everything named `*T` is transformed.

**`Max points` thins the drawing and nothing else — so it is presentational, and the Network Viewer
viewer's filters are not.** That contrast is the whole of it. `out` is the input table
unchanged, and a lasso is tested against **every usable row rather than the drawn sample**, so
no output can tell whether a point was painted. `out.network`'s `minLinkWeight`/`topNodes`
genuinely subtract from what it returns, which is why they stale everything downstream and
carry an `affectsData` tab. Getting this backwards would have a graph go stale every time
somebody raised a drawing cap, which reads as a scheduler bug.

The sample is a **deterministic stride**, not a random draw: a random one reshuffles per
render, so points would flicker in and out during a pan and the picture would never be the
same twice. The caption says `showing 50,000 of 165,122`, in the same idiom as
`labels thinned`.

**Selection is by id, with the row index as an admitted fallback.** `nodes/lib/rowIds.ts` owns
it and _both_ the viewer and the node import it — what a selected point is called has to mean
the same thing to the code writing the ids and the code resolving them, and two agreeing
implementations drift the first time either is touched. `idColumn` defaults to `neuronId`
through `optional: true`, which is what makes the resolver answer "nothing" rather than
reaching for the first column when the table has none. The fallback exists because the tables
least likely to carry an id — an uploaded CSV of embeddings, a `groupBy` roll-up — are exactly
the ones a scatter is for, and a dead lasso there is worse than a fragile selection the caption
labels `by row index`.

`idColumn` is therefore **not presentational**, alongside `selection`. It decides which rows
`Selected` carries; marking it presentational would let a stale downstream result survive a
change to the very thing identifying the rows. Those two are also the only params outside the
tabbed panel, which is what keeps every tab's presentational-only promise true without an
`affectsData` warning anywhere.

**Reading a cell refuses what `Number()` accepts.** `Number(null)` and `Number('')` are both
0, so a plain conversion draws a dense stripe of data that does not exist along each axis.
Same trap `numeric()` in `encoding.ts` exists for, same answer. Rows that cannot be placed are
**counted and reported** (`N unplottable`) rather than silently absent — which matters most
for the log axes, since nothing about flipping a switch suggests values at or below zero would
leave the picture.

**Shape follows the colour rules exactly, because it is the same kind of channel.** Ranked by
frequency, capped, and the tail folded into one residual mark rather than reusing one — a
repeated mark implies two categories are the same thing, which is why the palette never cycles
a ninth hue either. Six marks rather than eight: shape is coarser than hue at the size a point
is drawn, and a seventh that reads as "a slightly different blob" is worse than an honest fold.
Marks are **area-matched** (`SQUARE = √π/2`), or a square at the circle's radius would be 27%
larger and shape would start encoding magnitude by accident.

**A card gets tick labels; only the titles are held back for the overlay.** `drawScatter` used
to return before the labels under `compact`, and `MARGIN_COMPACT` was 6px on every side — so a
card showed a grid and an axis line with no numbers against them, which is a box of dots, since
an axis without a scale is decoration. The numbers are what say whether the cloud spans ten
synapses or ten thousand. The axis *titles* still stand down: they need another ~22px below the
ticks, and the caption already reads `post vs pre`, so on that surface they are the one label
that is genuinely redundant.

**Gestures match the canvas underneath.** Bare drag pans, Shift-drag lassos, ⌘/Ctrl-drag boxes
— the same assignment `panOnDrag` and `selectionKeyCode="Shift"` give the editor, so the hand
does not change modes when the pointer crosses into a card. Navigation is far more frequent
than selection and gets the bare gesture. Below `CLICK_SLOP` a drag is read as a click: a plain
one selects the point under it or clears, a modified one toggles. The marquee is an SVG overlay
rather than part of the repaint — a gesture that redrew fifty thousand marks per pointer move
is not a gesture.

The wheel handler is a **native listener with `passive: false`**. React routes `onWheel`
through a passive root listener, so `preventDefault` there is ignored and the page scrolls
behind the chart; `nowheel` on the wrapper is the other half, stopping React Flow zooming the
canvas underneath.

**Framing resets on a new question and never on a resize.** The viewport is cleared when the
table or either column or scale changes, because a zoom framed on one pair of columns says
nothing about the next — but a resize changes how much fits, not which picture it is, and
throwing away a zoom because somebody dragged the card's corner is the loss the layout memo
exists to prevent. `equal` aspect is re-imposed after a resize instead, and it **widens the
tighter axis, never narrows the looser one**: narrowing would push data outside the plot, and
an aspect setting that hides points is not an aspect setting.

**The trend fits in transformed space, and per _resolved colour_.** Transformed, so the line is
straight on screen — which makes a log-log fit a power law and a semi-log fit an exponential,
the reading anyone puts a log axis on to get. Grouped by the colour rather than the raw column
value, so each line corresponds exactly to a legend entry: the eight-slot cap and the
achromatic `Other` fold have already happened, so a ninth category's line is drawn for the
bucket the legend actually names. A constant colour therefore collapses to one line by
construction. It declines rather than drawing through fewer than two points or a vertical
cloud — a line through one point is a claim about a relationship nobody observed.

**Ticks needed a second implementation, and that is not duplication.** `niceTicks` in
`format.ts` always starts at zero because a bar chart's baseline does; a scatter's window
routinely excludes zero and always does after a zoom. `axisTicks` covers an arbitrary domain,
and subdivides a narrow log window into 1/2/5 rather than showing two labels a decade apart.

**Marks are batched by `colour|shape`, one fill per bucket.** With a categorical encoding that
is at most nine buckets for any number of points, which is the difference between a redraw
that keeps up with a pan and one that does not. A sequential ramp defeats it by construction —
every value is its own colour — and is left to, rather than quantised: quantising would put a
colour on screen that `resolveColor` never returned.

**`LegendKeys.tsx` was extracted from `NetworkLegend`, not copied.** Two viewers drawing their
own swatches is how two viewers end up disagreeing about what the palette's `Other` bucket
looks like. `ShapeKey` draws the marks through the same `markPath` the plot does, because a
legend that approximated its own marks would be the one place on screen where what is drawn
and what it says may differ — and shape is the fallback channel for exactly the readers a
colour key cannot serve.

**The axes open on named defaults**, `pre` and `post`, rather than empty ones. An empty default
means "the first compatible column", which is the _same_ answer for both axes — so a node
dropped on a neuron table would open drawing a column against itself, a diagonal that looks
like a broken viewer. `resolveColumn` falls back to the first numeric column wherever those
names are absent, so nothing is worse off.

**`evaluate` never refuses over an unpicked column**, and the reason is worth keeping. `out` is
the input unchanged, so throwing because a _drawing_ cannot be configured blocks every node
downstream for a reason that has nothing to do with them — and on the graph that exposed it,
`Pivot → Scatter` reloaded from a file, it was not even true: the pivot publishes no schema
until it has run, so the first Run errored `no numeric columns` while holding a table whose
numeric column the message listed. Passing through lets the run finish, after which the store
re-infers against the schema the pivot has now published and the widget draws — no second Run.
`validate` says nothing at all while the incoming schema is unknown, and the widget's empty
state distinguishes _not known yet_ from _nothing to pick_. See invariant 5's corollary.

**No visual verification exists.** jsdom has no canvas beyond the accept-everything stub, so
the marks have not been looked at by anyone; what is checked is the geometry, the exported SVG
and the caption. Same standing as the WebGL viewers.

## Histogram, pie and box plot

Three nodes — `out.histogram`, `out.pie`, `out.distribution` — added together because they make
one design decision together, and because that decision is the opposite of the scatter's.

### Five charts, three nodes

`out.pie` carries a `shape` enum and `out.distribution` a `style` enum, so pie/donut and
box/violin are one node each. Both toggles change the inner radius or which marks are drawn and
nothing else, so both are `presentational` and switching never stales anything. Two node types
apiece would have been two glyphs, two emitters, two guide entries and two sets of tests for one
number and one boolean.

The histogram is **vertical** where the Bar Chart beside it is horizontal, and that is forced
rather than stylistic: a bar chart's categories are ROI and cell-type names, which need rotated
labels as columns, while a histogram's axis is a *number line* — and a number line that runs
downwards is not something anybody reads. The box plot **defaults** to horizontal for the bar
chart's reason, since its axis of names is the category one.

### The box plot's two orientations, and the one thing that knows about them

`orientation` offers groups along the bottom as well as down the side. The default is argued —
these names need rotating 45° as columns — but a box plot is the panel most likely to have to
sit in a figure beside other vertical ones, which is worth the rotated labels.

**One `Frame` knows which axis is which, and nothing else does.** Every mark is placed in
`(value, across)` and mapped once: the violin, the swarm, five box parts, the hit area, the
selection outline, the gridlines and both label rails. A second `if (vertical)` anywhere else is
how two orientations become two charts that agree about the box and disagree about the violin —
and the asymmetry that makes that likely is written into `valuePx`: **screen y grows downwards
and a value axis does not**, so the columns layout runs its axis bottom-to-top. Getting that
backwards everywhere is obvious; getting it backwards in one mark is not.

**The band block is centred in whatever it does not fill**, and the gridlines and the value-axis
labels move with the block rather than with the box. Eight columns capped at 72px use 576px of
an expanded viewer's 1,470; pinned to one end, with the axis stranded at the far edge, that
reads as a chart that stopped drawing half way. Seen in a browser, twice — once per axis.

### The swarm is packed, capped, and drawn last

`swarmOffsets` walks the values in order and gives each mark the offset **nearest the centre
line** that clears everything already placed, taking its candidates from the neighbours
themselves (`offset ± √(4r² − d²)`). A fixed ladder of offsets — 0, ±r, ±2r — is what makes a
swarm look like a bar chart of stacked dots; this one interlocks, which is the shape that reads
as a distribution. Since the input is sorted, the neighbours in range are a sliding window
rather than a scan.

It packs in **pixels**, not in values, because whether two circles overlap is a question about
the screen — so the viewer projects first and packs second, and `Frame.alongPoint` exists so a
swarm never round-trips its positions back through the scale (which under a log axis is not the
identity). A group that packs wider than its band is **scaled** to fit rather than clipped, so a
squeezed swarm does not read as a skewed one.

Two capping decisions. 300 marks per group, then a stable stride and `swarm thinned` in the
caption — a swarm is a plot of every observation, which is its point and also its ceiling. And
the Tukey outliers are **not** drawn on top of one: a swarm already shows them, and drawing them
again doubles the marks that matter most.

**Drawn last, over the box, and the box loses its fill.** The first version painted the swarm
first, so the marks inside the IQR — most of them — were covered by the box, which is a swarm
you cannot see. Order is violin, box, swarm; under a swarm the box is stroke-only. Same order
`sns.boxplot` then `sns.swarmplot` gives, and both emitters follow it.

### A mark is not a row, so a selection is not a set of ids

This is the whole of the design and it is the one place these three depart from `out.scatter`.

A lasso encloses **rows**, so the scatter stores row ids and `nodes/lib/rowIds.ts` owns what a
row is called. A pie slice, a box and a histogram bar are **aggregates**: each stands for
anywhere between one row and a hundred thousand. Storing the rows behind one would put a
category's worth of ids into every saved file and every share link for a gesture whose meaning
is one word — and the ids would then have to survive an upstream re-run, which "the LC4 slice"
does for free.

So `nodes/lib/chartSelection.ts` stores a categorical mark as **its label** and a histogram bar
as **its range**, and both the viewer writing it and the node resolving it import that one
module. Two agreeing implementations of "what is this mark called" drift the first time either
is touched — the standing reason `rowIds.ts` is one module, and the reason this is too.

Three consequences, each of which had to be got right:

- **The range is the bar's own edges, half-open, with a closed flag on the top bar.** The flag
  travels with the range rather than being inferred, because bin count is `presentational` and
  therefore absent from the cache key — `evaluate` has to resolve one bar without knowing how
  many there were. Without it the largest value in the table falls outside every bar in a
  picture that plainly contains it.
- **The residual slice hands back the categories folded into it, not the word `Other`.** Same
  reason: the fold depends on `maxSlices`, which is presentational, so a stored `"Other"` would
  quietly come to mean a different set of rows after somebody widened the chart, with nothing
  re-running to say so.
- **Exactly one column param per node is not `presentational`** — the one the selection is
  resolved against. `value` on the histogram, `category` on the pie, `group` on the box plot.
  It decides which rows `Selected` carries, so marking it presentational would let a stale
  downstream result survive a change to it (invariant 4). Precisely the call `out.scatter`
  makes for `idColumn`, and note that it lands on a *different* param each time: the histogram
  names its bars after the value column and the box plot names its boxes after the group one.

The cost, stated: those params are absent from the overlay's presentational-only rail, exactly
as `idColumn` is on the scatter. They are still on the card and in the inspector.

### The caps, and what each does with its tail

Every one of them is a drawing decision that reports itself rather than a refusal — see
[limits.md](limits.md).

| | cap | the tail |
| --- | --- | --- |
| Histogram | 80 automatic bins, 200 by hand | — |
| Histogram series | 8 + `Other` | folded, achromatic |
| Pie | `maxSlices`, default 8 | folded, achromatic, and it remembers its members |
| Box plot | `maxGroups`, default 24 | **dropped**, and counted in the caption |
| Violin | 4,000 values per kernel estimate | stable stride |
| Swarm | 300 marks per group | stable stride, `swarm thinned` in the caption |
| Outliers | 200 marks per group | stable stride, count in the tooltip |

The box plot is the odd one and deliberately so. Folding a tail into one achromatic bucket works
for a bar and a slice because those are **sums**; pooling fifty cell types into one box makes a
distribution that describes nothing. Dropping and saying so is the honest version of the same
cap.

Both strides are stable rather than random, for the scatter's reason: a random sample reshuffles
per render, so a violin's shape and its outlier dots would move on every repaint and the picture
would never be the same twice.

The eight-slot fold itself is **`foldByRank` in `colors.ts`**, shared with the bar chart. It was
four copies of one loop until these three arrived, and the copies had already drifted: two
tie-broke equal totals by label and two did not, so two charts assigned hues from `Map`
insertion order — i.e. from whichever row the backend happened to return first — and two were
stable. The shared one keeps the tie-break.

### Freedman–Diaconis needs a fallback, and the fallback is the interesting half

`chooseBinCount` sizes a bin from the interquartile range. A column whose middle half is one
value — `pre` on a table that is mostly zero, which is an ordinary table here — gives a width of
zero and an infinite bin count. Sturges answers from `n` alone and cannot, which is what makes
it the fallback rather than a second opinion. The 80-bin ceiling is the other half: FD on a
heavy-tailed integer column asks for thousands of mostly empty bars, and the picture at 80 and
the picture at 3,000 answer the same question.

Neither exporter reproduces this exactly and both say so in a note. seaborn's `bins="auto"` is
the larger of FD and Sturges with no cap; ggplot has no automatic rule at all and defaults to
30. A bar count that differs is the kind of thing that gets blamed on the data.

### Quantiles are computed in value space; the kernel estimate is not

A quantile survives any monotone transform, so `Log axis` leaves the median, the quartiles and
the box exactly where they were. The **Tukey fence is not** invariant, and computing fences in
log space would silently reclassify outliers the moment somebody flipped a switch that is
supposed to change only the axis. The violin's kernel estimate *is* computed in the space the
axis is drawn in, because a density is a statement about area and a log axis redistributes it —
the same rule the scatter's trend line follows.

Two smaller decisions in `boxStats.ts` worth not undoing. The whisker ends at the **most extreme
value inside the fence**, not at the fence: drawing the fence puts the whisker end at a number
no row holds and makes it stick out past the data whenever the tail is short. And every violin is
normalised against **one peak across all the groups**, so widths compare between them — rescaling
each to its own maximum makes a flat distribution and a sharp one the same shape.

### A pie refuses negatives, and it is the only chart here that refuses anything

An angle is a share of a whole and a share cannot be less than nothing. A `-40` beside a `100`
either draws backwards over its neighbour or quietly makes the total 60, and both are a picture
that lies. Negatives are dropped, counted, and reported in the caption. A bar of −40 is perfectly
readable, which is why this is a property of the pie rather than a rule.

The full-circle arc is the other thing to know: a 360° sweep starts and ends at the same point,
so a single elliptical arc renders as **nothing at all**. `arcPath` draws it as two half arcs,
and a single-category pie is not a rare case.

### Selection reads as displacement, not as colour

Colour is already the categorical channel and every slice is using it, so a "selected" hue would
either collide with a category's or say two things at once. A selected slice pulls out along its
own bisector; a selected histogram bar takes an outline and the unselected ones dim; a selected
box takes a band outline. Dimming is applied to the **unselected** marks rather than as a
highlight on the selected one, so with nothing selected — the common case — every mark is at full
strength.

Every bar and every box also carries a **full-height transparent hit area** under it. Without one,
a two-pixel bar in a long tail is a two-pixel target, and the tail is what somebody clicking a
histogram is nearly always after.

### The row scan is memoised apart from the drawing

Each of the three splits its work in two — `scanValues`/`binScan`, `groupValues`/`summarise`,
`tallyCategories`/`pieSlices` — and the viewer keys the two halves on different things. The
first is O(rows) and depends only on the table and the columns; everything a styling control
touches is in the second, which is O(bars) or O(groups).

That split is not premature. `NumberField` fires `onChange` on **every pointer-move** of a
scrub-drag rather than on commit, so `Bins`, `Max slices` and `Max groups` each emit ~60 param
changes a second while dragged — in up to three live viewer instances at once. Keyed as one
memo, a drag on `Bins` re-walked 165,000 rows per frame.

Two measured numbers came out of the same pass. Freedman–Diaconis needs quartiles and therefore
a sort; a fixed bin count needs neither, and the extent comes from the scan — so the sort is
taken **only on the automatic branch**: 20.6 ms against 0.2 ms on 165,122 values. And
`kdeCurve` walks a two-pointer window rather than testing every value at every grid point,
which is what the sortedness of both inputs is for: 9.5 ms against 5.3 ms at the default cap,
bit-identical output, and a test pins it against the naive form because a pointer that reset
one element late would still draw a plausible violin.

### What was checked in a real browser

The suite covers the arithmetic (`histogramBins.ts`, `pieLayout.ts`, `boxStats.ts`, all
headless), the mark counts, and — the part that matters most — **what a click writes back**,
since that string is what a node resolves into rows. It cannot cover anything about pixels, so
these were driven in Chrome against the mock optic lobe, in the card and in the expanded
overlay. Three things it caught, all of them invisible to a green suite:

- **The box plot's bands were a fixed height.** Ten groups clustered in the top third of an
  expanded viewer with six hundred pixels of gridline under them and the tick labels pinned to
  the bottom of the card — which reads as a chart that failed to draw. Bands now stretch to fill
  and stop at 72px, the gridlines end where the bands do, and the axis sits directly under them.
- **`niceTicks` rounds its top up past the data**, so the box plot drew a `600` label out in the
  right margin with no gridline under it. Ticks are now bounded at both ends of the domain.
- **Two `defaultSize`s were too short and one label step too tight.** The pie's ring had no
  height left at all once its params, legend and caption were laid out — a card drawing a key to
  a picture that was not there — and the histogram's edge labels touched at 34px per label
  (`formatCompact(126.4)` is five glyphs at ~5.6px). All three numbers are measured now, and
  `sortSlices` moved to the inspector to buy the ring its rows back.

## Heatmap: more cells than pixels

`out.heatmap` used to refuse above **20,000 cells**, and that number was a fact about SVG rather
than about matrices: every cell was a `<g>` wrapping a `<rect>` carrying its own `onMouseMove`
and `onMouseLeave`, so the cap was really 40,000 DOM nodes and as many listeners on one card. It
landed on exactly the pictures this viewer exists for — an NBLAST score matrix at the Skeletons
node's own 500-neuron ceiling is 250,000 cells, and `Linkage → Ordered → Heatmap` is _meant_ to
be read at that size, where the structure is texture rather than cells.

There are two numbers now, and the same reasoning ran a second time. `HEATMAP_CELLS_WARN`
(**4,000,000**) was the refusal; it is now where the caption says `large matrix`, because the
measurement above says paint tracks the **grid** rather than the matrix — sixteen times the
cells is sixteen times one 23 ms fold on first layout, not sixteen times every frame. The
refusal moved out to `CRASH_FLOOR_CELLS` itself, read straight rather than aliased, so this
viewer draws anything a Pivot or an NBLAST can build and declines only what could not have been
built. See [limits.md](limits.md).

**The fold is the part that scales, and it is on the resize path.** `buildHeatmapSpec` is
memoised on the card's width and height and `useElementSize` has no debounce, so a resize drag
re-folds once per pixel step: 12 ms at 2M cells, 40–56 ms at 8M, 65–104 ms at 16M. Below the old
4M ceiling that was invisible; at the new one it is a laggy drag on a matrix that could not
previously be drawn at all, which is the trade the caption names.

`heatmapPlot.ts` is the headless half — geometry, the fold, the hit test — and `heatmapDraw.ts`
is the canvas pass and the standalone SVG, both reading one spec. `scatterPlot`/`scatterDraw`'s
arrangement, for its reasons: jsdom has no canvas, so anything left in the component is covered
by nothing, and one spec is what makes the exported file the picture on screen.

### The fold is the whole of it

**A cell smaller than a pixel is not drawn.** The matrix is folded onto a grid of at most one
cell per CSS pixel of the plot, and the canvas pass, the SVG export and the hit test all work on
that grid — so **drawing costs the card rather than the data**. Only the two passes that cannot
be bounded stay O(n): the extent scan and the fold itself. Measured in a browser at 1400×700,
spec build then first paint: 90,000 cells 1.2/5.6 ms, 250,000 3.2/17 ms, 1,000,000 11/37 ms,
4,000,000 20/46 ms. So the ceiling costs about 65 ms of one frame, on a resize or a theme flip
and never on a hover.

**CSS pixels, not device pixels**, so the picture does not change between a retina screen and a
projector, and the exported SVG — which draws the same grid — is the same file whoever exported
it. What is given up is the sub-CSS-pixel detail a 2× screen could have shown.

**A block keeps its strongest cell, never the mean.** A connectivity matrix is sparse, and
averaging one strong connection across the hundred empty cells beside it puts it at a fraction of
a percent of the ramp — off the picture, which is the only thing in it. Strength is measured from
the scale's own neutral end (the low end for sequential, zero for diverging), so a diverging fold
keeps both tails rather than only the positive one, and a sequential fold keeps the largest value
rather than the largest magnitude. Same brightest-wins rule as `raster.ts`.

**The winning cell's index is kept**, so the tooltip over a folded block names a real row, column
and value — and says `strongest of ~N cells` beside it. That admission is on the _card_ as well
as in the overlay, which matters, because the caption's `cells merged` note stands down under
`compact` as every viewer note here does. A folded picture that said nothing anywhere would be
the failure `labels thinned` already exists to prevent.

### Canvas for the cells, SVG for everything else

This is the one place the viewer departs from `ScatterViewer`'s all-canvas call, and the
arithmetic licenses it rather than taste. A scatter's tick labels are a handful either way; a
heatmap's axis labels are bounded by **pixels**, since only so many 10px names fit down an edge
however large the matrix is. So the labels, the printed cell values and the hover outline stay in
an SVG overlay: real text that can be selected, found and read aloud, laid out by the browser
rather than by `measureText` — and a hover that costs one element rather than a repaint of four
million cells. `.heatmap-overlay` is `pointer-events: none`, or a label would put a dead strip
across the row it names.

Axis labels are **thinned to a legible pitch and the drop is counted**, which the old code never
had to do because it never drew a matrix taller than its own labels.

### The chrome is shared, not drawn twice

The cells were shared from the start (`cornersByBucket`), and the labels and printed values were
not — two independent drawings carrying the same magic numbers, and they **had already parted
company** after one afternoon: a cell whose bucket is `-1` took ramp-bottom ink on screen and
black in the file. `axisMarks`/`valueMarks` in `heatmapPlot.ts` now return placed, coloured
`TextMark`s that the overlay maps to JSX and the exporter to `<text>`, so the file matches the
card for the chrome as well as for the cells.

**A `TextMark` carries its baseline, and absent means alphabetic.** `dominant-baseline: central`
centres text across its _reading_ direction, so on a column label turned -90° it moves the label
sideways by half a cap height and the whole band drifts off the columns it names. Applying it
uniformly is the obvious tidy-up and it is wrong; it was caught by pixel-diffing against the
previous build, since jsdom performs no layout and nothing else here can see a two-pixel move.
`heatmapPlot.test.ts` pins the row/column distinction.

### Two things measured rather than assumed

- **The ramp is a 512-entry lookup table, and that is not the quantisation `ScatterViewer`
  refuses.** That viewer declines to quantise a sequential ramp — "quantising would put a colour
  on screen that `resolveColor` never returned" — so this was checked over 200,000 samples of
  both scales in both modes. The ramps are piecewise-linear in RGB and the output is 8 bits a
  channel, so the whole blue ramp is **453 distinct colours** and the diverging scale 621–1,006;
  against those, 512 steps is within **one** channel value of exact for sequential and **two** for
  diverging, and 256 measures the same. The scatter's objection is real for a _categorical_
  palette, where a substituted slot means a different category; here a colour is a magnitude and
  the substitute is the same magnitude to within a rounding step. Without the table, 285,000
  `sequentialColor` calls cost **65 ms against 2 ms**, per render.
- **Cells are batched by ramp bucket, and carried as flat corners.** One path and one fill per
  bucket, so a bounded number of fills for any number of cells — the scatter's colour+shape
  batching arrived at from the other direction, since there the sequential ramp defeats the
  batching and here the ramp _is_ the batching. Every cell is the same size, so only `x, y` is
  stored per cell and the width and height are read off the spec once: that alone took a
  four-million-cell repaint from **77 ms to 46 ms**, most of the difference being garbage no
  longer made.

`buckets` is **mode-independent** by construction, so a theme flip re-resolves the ramp's hex and
repaints rather than re-folding the matrix — and `cornersByBucket` is memoised against the spec in
a `WeakMap` (`rowFields.ts`'s `slotCache` idiom), so that repaint does not re-walk 900,000 grid
cells to change nothing but 512 `fillStyle` strings. Measured, it took the four-million-cell
repaint from 46 ms to 27 ms and made an export cost no third walk.

**`Show values` is applied at render, never in the fold.** It reached `buildHeatmapSpec` only to
decide one boolean, which put it in the dependency list of a pass that walks every cell — so
toggling it on a four-million-cell matrix re-scanned the whole thing to compute `false`.
`labelsFit` is now the size test alone and the param is `&&`-ed in beside it.

### The export

`svg: () => heatmapToSvg(...)` rather than the live element, because the live element no longer
holds the cells. **A folded picture exports folded** — the cells below a pixel were not on screen,
so drawing them would be a document claiming detail nobody saw, and one rect per cell of a
four-million-cell matrix is a file nothing opens. Bucket-batched there too: a 356×356 matrix
exports as 54 `<path>` elements carrying 82,236 subpaths, 2.0 MB, and parses clean.

**Two pre-existing bugs in the shared export path had to be fixed to get there**, and both are
the same shape: two owners for one declaration.

`serializeSvg` set the namespace with `setAttribute('xmlns', …)`, which creates an ordinary
attribute in the _null_ namespace that merely happens to be spelled `xmlns` — so `XMLSerializer`
emitted it beside the declaration it already writes for an element created in the SVG namespace,
and **every chart this app exported carried `xmlns` twice**. A duplicate attribute is a fatal XML
well-formedness error rather than something a reader recovers from, and SVG is parsed as XML:
`DOMParser` returns a `parsererror` document for it. It affected the bar chart, the scatter, the
network and the dendrogram alike, and it failed to _parse_ rather than looking slightly wrong,
which is why nothing about the string ever caught it.

And `serializeSvg` appended a `<style>` inlining the font **unconditionally**, beside the one each
builder already appends — measured on a real export: two style blocks, the serializer's saying
`sans-serif`, because `getComputedStyle` on a _detached_ element resolves nothing and a
synthesised export is always detached. Only document order saved it: `insertBefore` happened to
put the dead declaration first. Moving that to an append, or a builder dropping its own, would
have silently stripped the typeface from every exported chart.

**The fix is structural rather than advisory, which is the point.** `setAttributeNS` makes the
namespace a real declaration so exactly one is written, the font is inlined only when the element
carries none, and `svgElement.ts`'s **`svgRoot()` has no parameter for `xmlns` or `font` at all** —
so a fourth builder cannot reintroduce either by copying a third. The first pass fixed this with
three identical comments saying "do not set xmlns", which was verified to be worthless:
re-adding the attribute to `networkToSvg` left all 43 builder tests green, because
`networkDraw.test.ts` asserts `toContain('xmlns="…"')` and that passes just as happily when it is
written twice. `svgBuilders.test.ts` is the tripwire under it — every builder's output through the
real `serializeSvg` and a real XML parse — and both halves were confirmed by mutation.

### What was checked in a real browser

Headless Chrome over CDP against `pnpm dev`, because this is the class jsdom cannot see.

- **The small case is unchanged.** The bundled matrix example rendered before and after and
  pixel-diffed: **cell interiors byte-identical**, and the only differences are the two output
  pixels the 1px separator straddles, where the canvas and SVG rasterisers weight a sub-pixel
  edge differently by 1–11 values. 3.6% of the frame, all of it on the separator lines. The same
  diff was re-run after the shared-chrome refactor and came back at **zero** differing pixels,
  which is how the baseline regression above was found.
- A 356 × 356 adjacency (126,736 cells) drawn on a card and expanded, against the old build
  answering `205 × 356 is too large to draw (72,980 cells)` on the same graph.
- The tooltip on a folded card, saying `strongest of ~2 cells` and landing under the pointer.
- The SVG export captured off `URL.createObjectURL` and re-parsed in the page: no `parsererror`,
  one `xmlns`, 54 paths, labels present.
- **Light theme, loaded fresh**: labels `#52514e`, the low end resolving to `#cde2fb` and the
  surface to `#fcfcfb` — all through `currentMode()`, so a viewer computing hex in JS survives.

**A live theme switch does not repaint this viewer, and that is pre-existing** — checked against
the old build, which left its labels `#ffffff` and its cells `#134789` on a light card in exactly
the same way. `currentMode()` is read during render and nothing re-renders the card on a theme
change; any subsequent edit fixes it. Not introduced here and not fixed here, because it is one
symptom of something several viewers share.

**+6.7 kB raw / +2.5 kB gzipped on the main chunk** (1,002.41 → 1,009.11 kB), measured against a
build of the same tree with the feature absent. Far under this codebase's bar for a lazy boundary.

Three things were lifted out rather than copied a third time, on the second-consumer rule this
codebase states repeatedly (`useStable`, `LegendKeys`, `Tiles`, `raster`): `svgElement.ts` holds
`SVG_NS`, `round`, `element`, `textNode` and `svgRoot` for all three SVG builders; `canvas2d.ts`
holds the HiDPI setup the scatter and the heatmap share — and it now skips the `canvas.width`
write when the size is unchanged, which was reallocating a ~16 MB backing store on every theme
flip; and `labelStep` moved from `dendrogramLayout.ts` to `format.ts` beside `truncateLabel`,
because two thinning rules that round differently drop different numbers of labels under captions
that both say `labels thinned`.

What has **not** been looked at is a matrix at the four-million ceiling in a browser — the mock
connectome tops out at 401 neurons, so the ceiling's cost is measured against synthetic data
through the real functions rather than through a real graph.

## Neuroglancer

`out.neuroglancer` emits a **URL** and the widget is an iframe on it. There is no SDK and no
bundled copy of neuroglancer; the entire integration is `src/data/neuroglancer/scene.ts`
(headless, source-agnostic — FlyWire and CAVE publish states too) plus one endpoint call in
`neuprint/nglayers.ts`.

**A published scene is edited, never rebuilt.** The camera, the EM volume, the ROI meshes and
the synapse layer wired to the segmentation are the reason to reuse it. Verified shapes,
because they are not uniform and the differences are load-bearing:

| dataset            | what it publishes                                                              |
| ------------------ | ------------------------------------------------------------------------------ |
| `hemibrain:v1.2.1` | `{ layers }` and nothing else — no dimensions, position or layout              |
| `hemibrain:v1.1`   | `{ layers, badlayers }`; `badlayers` is Explorer bookkeeping, not viewer state |
| `manc:v1.2.3`      | full state, `layout: "3d"`, and a stray `segmentColors` for one body           |
| `male-cns:v0.9`    | full state, 38 layers, 38 kB before a single neuron id is added                |

So the module supplies `layout` and `showSlices` when absent — neuroglancer's own defaults
open hemibrain in 4-panel with EM planes cutting through the neurons — clears manc's stray
colour rather than merging into it, and strips `badlayers`.

**Layers of your own go on the end.** The `Extra layers` socket takes what a
`Neuroglancer Source` node emits, and `buildScene` appends them after the published list —
appended rather than merged in, because order is neuroglancer's draw and panel order and a
published scene is somebody's curated arrangement. They survive `Layers: neurons only`, which is
about how much of the *dataset's* scene to carry: a layer somebody wired up is not published
context to trim. A name that collides with a published layer is suffixed, because neuroglancer
keys layers by name and a duplicate is not a merge — the second wins and the first becomes
unreachable, silently.

**Which layers are ours cannot be read off the scene, and assuming it could was a bug twice.**
The tempting test is "carries a `segments` array". Measured against the live endpoint, that is
**sixteen of male-CNS's thirty-eight layers**, eight of MANC's eleven and seven of optic-lobe's
seventeen — published shells and neuropil layers that ship a preset selection and have nothing to
do with us. Reading those as ours means the splice copies our copy of a shell over the user's live
one, and — worse — a user who deletes any one of the sixteen makes the splice bail to the merge
tier, throwing away every layer edit they had made. Silently.

So `ownedLayerNames(scene, datasetId, extraCount)` applies `buildScene`'s own two rules instead:
the dataset's own segmentation layer, found by `segmentationLayerIndex`, and the extras appended
to the end. Neither fact is in the scene, so both arrive as props on the viewer — for exactly the
reason `viewerType` does, which that file already documents: the URL cannot carry them. Without a
`datasetId` the splice is skipped and updates fall to the merge tier, which is the honest degrade:
writing into somebody's live state is worse done wrongly than not at all.

The single-layer version that came before was correct only by luck — the published layers carrying
`segments` happen to sit *after* the dataset's own on both real multi-layer states.

**A layer of ours missing from the live state declines the splice altogether.** The list itself has
changed rather than a selection within it (a datasource wired up after the frame loaded, or a layer
the user deleted), and the merge tier below already sends the whole list, which is exactly what
that needs.

**Two published defaults are overridden, not offered as options.** `showAxisLines` goes to
false — the lines cross the middle of the volume and read as anatomy at a glance — and
`selectedLayer.visible` goes to false, keeping the panel's `flex`/`size`/`layer`. MANC and
male-CNS both publish it open, which costs about 70% of a card that is already far smaller
than the browser window those states were framed for. Neither key is in `SCENE_PATCH_KEYS`,
and that is deliberate: they are _opening_ defaults, so a later merge does not slam shut a
panel the user has since opened. Note that neuroglancer drops `visible` from its own
serialisation once it is false, since that is its default — so a round-trip will not show it.

**Find the neuron layer by name, not by type.** male-CNS ships thirty segmentation layers:
ROI shells, nuclei, cross-dataset mesh overlays. Writing neuron ids into `brain-shell` renders
nothing with nothing to blame. Same family-name rule as `meshSourceFromState`.

**This is the one node with no presentational params, and that is the invariant.** Its output
_is_ the styled artefact — the colours are inside the URL — so marking a colour param
presentational would leave the node `ok` while its link still carried the old palette. That
is why `colorParams` grew a `presentational` opt-out; do not use it anywhere else.

**It imports `resolveColor` from `src/ui`** — the only `nodes → ui` edge in the tree. That is
deliberate: "never re-implement colour mapping" applies to an external viewer too, and
reusing it is what makes a neuron the same colour in the 3D view and in neuroglancer. Both
modules are pure, so it stays testable headlessly. Colours resolve in `'dark'` regardless of
Coda's theme, because neuroglancer renders on black.

**`cheap`, despite fetching**, because the fetch is one small JSON per dataset that
`NeuPrintSource` caches — the failure included, since a `cheap` node re-runs on every
restyle. Everything after that is string building.

**The frame is mounted in the node body, not only in the overlay.** That is a real cost —
each one is a full WebGL application that starts fetching EM on mount, and a canvas can hold
a dozen — and it is paid deliberately, because a viewer you have to open before anything
appears is not an exploration surface. The escapes are the resize handles and the ordinary
collapse toggle, which unmounts the preview.

**`uiScale` is the one presentational param, and it marks the line.** Everything else reaches
the URL, so it belongs in the provenance key; scaling the _frame_ cannot change a byte of what
`evaluate` returns. The frame is laid out at `1/scale` and drawn at `scale`, so it fills the
card exactly while neuroglancer believes it has a larger viewport — which is what makes its
chrome take a smaller share. A `transform` rather than the `zoom` property: it composites
instead of relaying out, and pointer coordinates into an iframe map through it correctly. Not
called "zoom" on purpose, since neuroglancer has a camera zoom and two of those on one card is
a trap.

**Every param is `advanced`, i.e. inspector-only.** A row of pickers above a 400px embed
takes a tenth of the space someone opened the node for. The inspector shows the full set for
the selected node, which is where a control that rebuilds a scene belongs. Note the
consequence: these params are _not_ presentational, so they never appear in the overlay's
rail either — the inspector is the only place they live.

**Colour mode `default` sends nothing at all** and lets neuroglancer hash-colour each
segment, and it is **this node's default**. Distinct from `constant`, which sends one
`segmentDefaultColor`; the point is that no colour data travels, which is also the shortest
link — and this is the one node whose entire output is a URL somebody pastes into mail.

It is the right default rather than merely the cheapest, and the reason is the palette's own
rule: Coda caps a categorical encoding at eight slots and folds everything past them into one
achromatic bucket, because in a legend a repeated hue claims two series are the same thing. A
scene has no legend, and past the eighth cell type every remaining neuron would be the same
grey. Neuroglancer gives every segment a distinct colour and needs no legend to do it.
`defaultColumn: 'type'` is still there for the moment somebody picks a data-driven mode —
`neuronId` is the first compatible column and is the wrong answer for the same eight-slot
reason.

`colorParams` only offers the mode when a caller opts in with `allowDefault`, because no in-app
viewer can honour it — `resolveColor` degrades it to the flat colour so it is harmless if it
ever leaks.

**Updates go through neuroglancer's `#!+` merge form, and this is the load-bearing part.**
The plain `#!` form makes neuroglancer `reset()` before restoring, so every upstream edit threw
away the camera, the layout and every runtime tweak — change a filter three nodes away and the
framing you had just set up was gone. `#!+` restores _over_ the live state: keys it does not
mention keep their current values. So `scenePatchUrl` sends only `SCENE_PATCH_KEYS` — the three
things this app owns — and the camera survives.

Four facts behind that, all established against the deployed viewer rather than reasoned:

1. **Assigning `src` a URL differing only in fragment does not reload the document.** It is a
   same-document fragment navigation; neuroglancer keeps its meshes and handles `hashchange`.
2. **The iframe element's `load` event fires on fragment navigations too**, so a load counter
   in the parent reports a reload that did not happen. That measurement said the opposite of
   the truth for a while. Only a signal from inside the frame distinguishes them.
3. **`layers` must be the whole list in a patch.** The merge is per top-level key, not per
   layer: a patch naming only the segmentation layer deletes the EM volume and every ROI mesh.
4. **Per-layer runtime state cannot survive**, precisely because of (3) — a visibility toggle
   or a randomised colour seed is rebuilt from what we send. That is the limit of what an
   iframe allows; reading the live state back would need a same-origin frame.

**`SCENE_PATCH_KEYS` is one key, and shrinking it was a bug fix.** It held
`['layers', 'layout', 'showSlices']` until neuroglancer was reported erroring under rapid
updates: a cascade of `can't access property "generation" of undefined` ending in
`Error restoring property "layout"` — which names the key. Restoring `layers` tears down and
rebuilds every layer; restoring `layout` in the same pass rebuilds the panels holding
references to them, and doing both while someone is dragging is asking the two to race.
Sending only `layers` takes the named property out of the update path. The cost is that
`layout` and `showSlices` fall into `sceneIdentity`, so changing either re-navigates and the
camera returns to the published framing — right trade, since they are structural and rare
while selection changes are constant.

**Where the viewer is proxied same-origin, updates are _spliced_ rather than merged.** This is
the answer to "why can't we just change the segments and leave everything else alone": a merge's
finest granularity is a top-level key, `layers` is one key, and restoring it replaces the whole
list — so a merge sends _our_ layer list and takes with it any layer the user hid, added or
reordered. Verified in both the array and the name-keyed map forms; neither reconciles per layer.

The way round it is to stop sending our list. `spliceSegments` reads what the frame is currently
showing, writes only that one layer's `segments`/`segmentColors`/`segmentDefaultColor` into it,
and sends _that_ back — so the list written already contains everything the user did. Reading
`location.hash` needs same-origin, which is the only reason `/ng` exists in `vite.config.ts`;
neuroglancer frames fine cross-origin. Without the proxy the embed still works and falls back to
merging, so a static deploy loses the preservation, not the viewer.

Note the split: the **frame** goes to the proxied path, the **link** stays the absolute public
URL. A copyable link that pointed at `/ng` on someone's dev server would be useless.

**A remount is the other way the state dies, and none of the above touches it.** Expanding a
Neuroglancer card reset the view, and closing the expansion reset it again — because the card
stands down while the overlay owns the node (`showPreview` in `CodaNodeView`, and the reason is
measured: two instances of a viewer are two of everything it holds), so each transition is an
unmount and a fresh mount with an empty frame. Nothing about merging helps when the component
itself has gone.

`sceneMemo` is the answer, and it is `cameraMemo` one seam further out: a module-level,
session-scoped map, keyed by the graph node id, holding what the frame was last showing. Read on
the way out; the next mount navigates to *that*, with the current selection spliced in, instead of
to the published scene. It carries the whole state rather than a camera because there is no
smaller unit that helps — the frame is re-pointed with one URL either way — and because the panel
layout and the layers the user hid or added die with the iframe exactly as the camera does.

Three things it has to get right, each of which was a way to get it wrong:

1. **The gate is the *applied* scene's identity, not the stored state's.** A live scene differs
   from the built one on precisely the keys the user moved, so `sceneIdentity(live)` would never
   match anything and the memo would be dead code. What the memo stores alongside the state is
   the identity of the scene that was *asked for* when it was read — the same comparison
   `canMerge` makes, which is the same question: same place, same deployment.
2. **The read is a `useLayoutEffect` cleanup.** React runs a layout cleanup while the subtree is
   still in the document and a passive one after the host node has been removed, and **a detached
   iframe has no browsing context** — so from `useEffect` the read returns null every time, and a
   null here is indistinguishable from the cross-origin degrade. The test's `contentWindow` stub
   is a getter that honours `isConnected` for that reason; move the capture to `useEffect` and one
   test fails.
3. **Reload forgets.** That button is how somebody escapes a frame that has gone wrong, so
   resuming into the state it went wrong in is the one outcome it must not have.

Same-origin only, since it reuses the same read `spliceSegments` needs, and it degrades the same
way: no proxy, no memory, and the embed behaves as it did. The frame in `Neuron Profile` passes no
`viewerId` and so remembers nothing — it is a tile showing one neuron at the published framing,
with no identity of its own to hand anything to.

**Merges are debounced** (`MERGE_DEBOUNCE_MS`), trailing-edge, and only merges — the first
navigation is immediate. Auto-run turns one upstream edit into a scene per keystroke, and
applying each had neuroglancer rebuilding its layers several times a second. Only the last of
a burst is worth anything.

Worth knowing for the next person who chases this: it did not reproduce in Chrome or in
headless Firefox (no WebGL there, so the render paths that touch `generation` never run). The
fix is reasoned from the error text, not from a repro.

A full navigation returns when `sceneIdentity` changes — everything outside the patch keys,
i.e. a different dataset or viewer. Merging across those would keep a camera framed on the old
volume, leaving you in empty space beside the one you asked for. The component also refuses to
merge before the frame's first `load`, or a selection changed during the second neuroglancer
takes to boot would merge onto its defaults.

**The Neurons port is `required: false`, and the empty cases do not throw.** A dataset alone
resolves to the published scene with no segments, which is a perfectly good thing to look at
— and an empty _table_ means the same thing, because that is what an untouched Explore Dataset
selection is and what a starter graph opens in. Only a port wired to something that is not a
table is an error. Getting this wrong turned the node into a dead card until someone had
ticked a neuron, which is the opposite of an exploration surface.

No `Selected` output, and there never will be one through an iframe: a foreign-origin frame
cannot be read. Picking neurons stays upstream.
