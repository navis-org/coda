# Widgets: ROI Viewer

ROI Viewer: the volume rather than the cells. [widgets.md](widgets.md) is the index.

## ROI Viewer: the volume rather than the cells

`out.rois`, `Add ▸ Visualisation ▸ ROI Viewer`. Explore Dataset answers "which neuron?", Neuron Profile "what is this
cell?", Dataset Summary "what is in here?" — all three about *cells*. This one is about the space
they sit in: a dataset's neuropil shells drawn together in a named anatomical plane, coloured by
how completely each is traced. It is the only surface here that can answer "where is `LO(R)`, and
how much of it can I trust", which is otherwise two lookups and a mental model of fly anatomy.

**A Dataset Summary, not a 3D View.** The obvious sibling is `out.viewer3d`, since both draw
meshes, and it is the wrong one: that node takes geometry *on a wire* and something upstream
fetched it. This takes a Dataset and fetches for itself, which is `out.datasetSummary`'s
arrangement exactly — no outputs at all, a `withoutValue` entry in `VIEWERS`, and `cheap`
despite the widget downloading tens of megabytes, because `evaluate` confirms the input is a
dataset and returns nothing. What a viewer fetches for itself is not what the scheduler has to
reason about.

### Three planes and no camera, which is the decision everything rests on

x/y, x/z, y/z. There is no free rotation, and that is not a limitation worked around — it is what
makes the whole thing affordable.

With an arbitrary camera the geometry has to be **kept**, because any angle can be asked for at
any moment. With exactly three projections there are exactly three answers, so a region is
fetched once, flattened into all three, measured, and **discarded**. What survives is polyline:
measured at **42 kB for hemibrain's 63 regions and 95 kB for male-CNS's 139**, against 29–62 MB
of mesh. Roughly three orders of magnitude.

Three further consequences, each of which deleted code rather than adding it:

- **Rendering is free.** Drawing is one transform over cached points, so there is no re-projection
  per frame at any region count. An earlier 3D build needed a reduced trace grid while dragging
  and a rule about reusing the previous frame's explode solution; both went away.
- **The trace grid can be larger than an interactive budget allows.** It is paid once, so
  `TRACE_GRID` is 512 rather than 256 — measured over all three planes including the relaxation:
  63 regions 108ms, 144 regions 291ms. 768 buys a quarter more points for 60% more time and stops
  being visible.
- **Every view is reproducible.** "Frontal" is a claim anyone can check against the picture, where
  a camera that happens to be pointing that way is a pair of angles nobody can read off one.

### Outlines are traced from a raster, never swept from a centroid

The obvious outline is the maximum projected radius per angular bin, and it can only describe a
*star-shaped* region. Neuropils are not: the mushroom body lobes wrap the peduncle and the gnathal
ganglia are plainly concave, so a swept outline silently fills in its own notches and draws every
region larger than it is. `roiProjection.ts` rasterises the projected triangles and walks the
boundary instead; `raster.test.ts` asserts that a point in a C's hollow is *outside* the ring.

**`raster.ts` was extracted from `thumbnail.ts` rather than copied.** The barycentric fill is the
same arithmetic whether it is shading a neuron thumbnail or filling a neuropil, and two copies
would drift on exactly one thing — whether a pixel centred on an edge is inside — with the symptom
a one-pixel seam in one viewer and not the other.

**The tracer's stopping criterion is load-bearing and its failure is invisible.** Moore-neighbour
tracing with no Jacob criterion walks the boundary repeatedly: the first version returned 177
points for a 44-pixel perimeter. That *looks* like a correct outline — but an even number of
traversals doubles every ray crossing, so the ring reads as **inside-out** to point-in-polygon.
The concavity test reported the hollow solid and the solid parts hollow.

### The explode is collision relaxation, not a radial push

Sliding each region away from the centroid is the obvious rule and it does not work: scaling every
centre about one point is a **homothety** — a uniform scale of the arrangement. The shapes do not
scale with it, so once the frame refits, the only perceptible change is the regions getting
smaller. It reads as pulling the camera back.

So `relaxShifts` does what nat.ggplot's exploding-neuropils does: each region is a disc *in the
projected plane*, and overlapping pairs nudge apart until none overlap. Non-uniform by
construction, so the picture un-stacks rather than scaling. Solving it in the view plane is the
other half — separation is guaranteed in the projection being looked at, which a 3D push never
promises, since two regions far apart in depth can sit exactly on top of each other on screen.

**The constants were measured against how much of each region is left visible** — rasterise in
depth order, nearest wins, count what survives. Frontal goes 61% → 93% mean visible and its worst
tenth 7% → 82%; lateral, nearly unreadable at rest, 23% → 88%. Disc radius is the **70th
percentile** vertex distance, because a disc around the furthest vertex of an elongated neuropil
claims far more room than the shape occupies. The anchor pull is **0.05**: at 0.22 it gives back a
third of the visibility to save a tenth of the frame growth.

**The push is biased sideways, and 100% is 1.5x just-separated.** A screen is wider than it is
tall and so is a brain, so vertical room is the scarce kind: unbiased, the frontal arrangement
explodes into a *portrait* block and wastes two fifths of a landscape card. `LATERAL_BIAS` rotates
each push toward the horizontal - a bias, not a constraint, so a pair stacked exactly vertically
still separates vertically. 1.7 is measured on share of a 620x460 card covered: frontal 62% -> 97%,
lateral 62% -> 98%, dorsal 99% either way. Past it the arrangement over-corrects into a letterbox
and the fill falls again, so it is an optimum rather than "more is better". `EXPLODE_GAIN` then
scales the finished displacements, because the solver stops at *just* separated and that reads on
screen as regions that have only barely stopped touching.

**The frame follows the arrangement, and this was the other way round.** It used to be held at
full explode for every value of the slider, on the argument that refitting per frame is the other
half of why a radial explode read as shrinking — the arrangement grows, the frame chases it down,
and size is the only thing left changing.

**That argument does not survive the mechanism it was written for being replaced.** A radial
explode is a *homothety*: every centre scaled about one point, so the arrangement is identical and
merely larger, and a refit leaves nothing on screen changing but the size. `relaxShifts` is not a
homothety — regions move relative to each other — so what a refit reveals is the separation. That
is pinned directly, and the test checks its own instrument first: the ratio of two inter-centre
distances is invariant under the radial push and is not under the relaxation.

What holding it cost was the picture. At rest the scene was drawn at 71–81% of the available scale
on a half brain and 64–87% on a whole one — and those were measurements on *primary* regions. With
`Primary regions only` off the relaxation separates every nested sub-region too, so hemibrain's 218
drawn regions reserved room for an arrangement several times the brain and the resting map sat in
a corner of the card. Reported from a canvas card, which is where it is worst: no rail, so the map
has the width, and nothing beside it to compare against.

**One array, four readers.** `explodedShifts` is where the slider is applied, and the frame, the
rings, the names and the label thinning all read its result. Each of them multiplying by the
fraction itself is exactly how the frame came to be fitted to an arrangement nothing was drawing.
The label half of that is worth stating on its own, because it is silent: judged at full explode
while drawn at the slider's setting, a region on screen loses its name because the arrangement it
is *not* in would have put it off the card, and that reads as the label mode being off. It is
pinned headlessly — on the mock connectome the two arrays agree at every setting of the slider
(measured at 0/25/50/75/100%), its six regions being large next to their displacements, so a
component test of it passes whatever the component does.

The trade this makes is real and is the one the old behaviour was avoiding: the regions do get
smaller as they spread. What is bought is that the resting map — the state the card is in unless
somebody drags the slider — uses the whole card.

**Homologous regions move as mirror images.** Left unconstrained the solve treats `ME(L)` and
`ME(R)` as two unrelated discs, so a bilaterally symmetric brain explodes lopsided — which reads
as a mistake, because the anatomy plainly is not. Each pass projects the shifts onto the
symmetric subspace: a pair's screen-x displacements are averaged to opposites, its screen-y to a
common value, and a midline structure is held on the midline. Enforced *inside* the loop, because
symmetrising a finished layout moves regions after the last collision check and can push them
back into each other.

Measured on a synthetic bilateral brain, worst pair mirror error against a shift scale of ~7,700:
frontal 11,283 → 0 with visibility 95% → 94%, dorsal 2,545 → 0 with visibility 79% → **81%**. The
free solve was putting pairs further out of step than the displacements themselves; the
constraint costs at most a point and dorsal gains two, because shrinking the search space lands
on a better arrangement rather than a worse one.

**It stands down where it would mean nothing, and both cases matter.** A half brain — hemibrain
is one hemisphere plus the midline — has no twin for most regions, so pinning a midline
structure's sideways travel would buy symmetry the dataset does not have while costing the solver
a degree of freedom it could spend separating something. And **lateral is excluded entirely**:
that plane projects *down* x, so the mirror axis is the depth axis, homologous regions land on
exactly the same point, and "mirrored" degenerates to "identical" — which would pin every twin
superimposed forever, the one thing the explode is there to fix in that view. That superposition
is also why lateral leans on the coincident-centre tie-break, and most of why the `hemisphere`
filter exists.

### Zoom and pan: a window, never a transform

The gestures are `HeatmapViewer`'s and `DendrogramViewer`'s exactly — wheel through `useWheelZoom`,
drag to pan, ⤢ or double-click to fit, off the canvas only — and so is the rule underneath them:
**the zoom is an input to the drawing, not a transform over it.** An SVG `transform` on the scene
is the obvious version and it is wrong for this viewer twice over, because it scales the stroke
widths and carries every region name with it: zooming in would magnify the labels rather than
reveal more of them, which is the one thing a map is zoomed for.

So `RoiWindow` is a magnification plus the projection-unit point held at the centre, and
`windowFrame` restates the fit at that magnification. **Two frames, and the split is the design**:
`fitted` is the scene in the box at the slider's current setting — the automatic zoom, which is
just a fit of what is drawn — and `frame` is the one everything draws through — rings, labels and the SVG export by
one route, so a zoomed card exports the zoomed picture with no second code path.

**In projection units and not pixels**, `HeatmapWindow`'s reason: a resize then keeps what is on
screen on screen. The fitted state is `undefined` at the viewer and `windowFrame` returns the
fitted frame **by identity** at magnification 1, which is what lets `zoomed` be a `!==` rather
than a third piece of arithmetic the ⤢ button's disabled state and the caption could disagree
with.

**The pan bound is what is left over on each axis.** With the visible span wider than the scene
there is nothing to pan along, so the centre is *pinned* to the scene's — which makes
magnification 1 reproduce the fit exactly rather than approximately, and is why a fitted map
cannot be dragged at all. Past the edge, the scene's edge stops at the box's; the failure without
it is a map somebody has to zoom out of to find again.

**`MAX_ROI_ZOOM` is 8 and it is a fact about the data, not a taste.** What is drawn is a polyline
traced on a `TRACE_GRID` raster spanning the whole scene, so vertices are at best `scene / 512`
apart; on a 620px card at magnification Z the spacing on screen is about `620 · Z / 512` pixels,
and past 8 that is a visible staircase. A further zoom magnifies the tracer's pixels rather than
the region.

**The per-region sweeps are hoisted out of the gestures**, and that is what the frame following
the slider cost before it was noticed. A shift is a rigid translation: it moves a region's
bounding box and leaves its area alone. So `regionBounds` and `regionAreas` are computed once per
projection, `fitFrame` walks `n` boxes rather than every vertex of every ring, and the label pass
takes the areas rather than recomputing shoelaces from raw geometry — which it was doing on every
pointer move of a pan, since the window moves the frame and the frame is what that pass is keyed
on. On a whole published region list each of those was on the order of a million point visits per
frame. The label pass also keeps its top eighteen by bounded insertion rather than sorting a pool
of thousands to slice off the head.

**Labels are re-thinned for the window, and that is the point of zooming.** Ranked over every
region regardless, a magnified card spends its whole budget on neuropils no longer in the box —
so zooming into a crowded corner showed *fewer* names than the fitted picture. `autoLabelled` is
the rule, headless, taking the on-screen regions as its pool and their share of the *visible* area
as its threshold; at the fit that is what it always was, since everything `fitFrame` framed is in
the box by construction. `all` is still all: a name outside the box simply does not render.

**Being the third copy is what extracted the drag**, which is `useWheelZoom`'s own history one
gesture over: that hook pulled out the *wheel* half at the third viewer, and the pointer half was
then copied line-for-line into the third and fourth. `usePanGesture` is now the one place, and the
copies had already drifted the way the second-consumer rule predicts — Heatmap and Scatter take
pointer capture on the press, which is exactly what the first rule below says must not happen.
Dendrogram and ROI are its two callers; Heatmap and Scatter are the next ones rather than a fifth
and sixth copy. Each of its rules was a silent failure in one of them first:

- **Pointer capture is taken at the slop, not at the press** — captured from `pointerdown`, the
  following `click` goes to the capturing element rather than to the region under it, and pinning
  stops working the moment anybody zooms in.
- **`dragged` is a ref**, because the click that must be swallowed arrives after the gesture has
  ended, and because a re-render per pointer move would reconcile every region's path. The last
  pointer position is a ref for the same reason; `panning` is the only piece a caller draws with,
  and it changes twice per gesture rather than per move.
- **A pan drags across the region names and the browser selects them**, so `user-select` is
  suppressed while a pan is live and only then. That one stays at the call site, with
  `touchAction` and the cursor: they are the caller's own layout.

What each viewer keeps is the one line the gesture is *for* — pixels into matrix cells, leaf
fractions, or nanometres.

One thing that is *not* carried over: there are no `nowheel`/`nodrag` classes on the map, because
the zoom is gated on `!compact` and so nothing is attached on the canvas at all — the same
protection by a different route.

### Getting the meshes, and why the card asks first

Everything below was established by `scripts/probe-roimeshes.mjs` against the live server. Each
would have produced a plausible wrong result.

- **`/api/roimeshes/…` 404s on `HEAD` and 200s on `GET`.** The probe's first version asked with
  HEAD and reported every dataset as having no meshes, directly above the megabytes of OBJ its own
  GETs had printed.
- **Coordinates are dataset voxels**, like skeletons and unlike the precomputed meshes. Unscaled,
  the shells sit a whole factor from every neuron drawn beside them, with nothing failing because
  both sets are internally consistent.
- **The OBJ dialect differs by dataset.** hemibrain writes bare `f 1 2 3` with no normals;
  male-CNS, MANC and optic-lobe write `f 1//1 2//2 3//3`. A parser assuming the first reads normal
  indices as vertex indices on three datasets out of four — and the counts match, so it builds the
  right number of triangles between the wrong points.
- **Four of thirteen datasets publish none at all** (banc, fib19, mushroombody, wasp3), which is
  what `capabilities.roiMeshes` declares. Within male-CNS exactly five regions refuse, and every
  one is an `-unspecified` bucket — unassigned synapses, not a shape. So a refusal is counted, not
  raised, and the caption says `139 of 144`.

### The two region lists, and why the second one asks again

**`Primary regions only` chooses which list is downloaded, not which is drawn.** The published
list nests — hemibrain 230 regions of which 63 tile the volume, male-CNS 5,619 of which 144 — so
filtering after the fetch would spend the larger download to show the smaller picture. It reaches
`loadRoiOutlines` for that reason, and `roiRegions` is the one function that answers it, because
three callers need it: the peek that decides whether there is a button, the download, and the
count the confirm names.

**It shipped declared, documented and unwired.** The param was on the node from the start, both
exporters honoured it — `client.primary_rois` against `client.all_rois` — and the loader asked
for `primaryRois` however the box sat. So unticking it changed the emitted notebook and nothing
on screen, on every dataset, for as long as the node has existed. Nothing failed and nothing
looked wrong: the map a user was told listed 230 regions listed 63, and both are plausible
pictures of a brain. The general shape is the one `refreshStates` records — a param honoured on
one surface and dropped on another is invisible from either.

**The two sets are two shelves, not two versions of one thing.** `cacheKey` carries a variant and
the hook's entry key carries the scope, so unticking and ticking back does not pay for the
primary set's 29–62 MB a second time — and two cards on one dataset with the box set differently
cannot be handed each other's answer. Primary keeps the bare cache key it has always had, so
outlines traced by an earlier build are still found. The fingerprint validates a shelf's
*contents*; the variant only stops the two evicting each other, which is why the pair cannot
drift into serving one set's shapes under the other's name. The failure the entry key prevents is
browser-only in the ordinary case and was found by mounting both cards in one test — the shared
state machine exists so two cards do not each paint a progress bar over one download, and what it
must never do is hand one of them the other's set.

**Past `ROI_CONFIRM_REGIONS` the card asks a second time.** `Load 144 regions` and
`Load 5,619 regions` are the same button and not the same wait: one request per region at
`ROI_MESH_CONCURRENCY` of four is, for male-CNS's published list, well over a thousand sequential
rounds against a shared production server, and nothing is stored until it finishes. The confirm
names both numbers — 5,619 against 144 is what makes somebody press Cancel — and refuses nothing.
The threshold is **conventional, not measured**, and `roiOutlines.ts` says so rather than
implying a finding: nobody here has run male-CNS's whole list, which is exactly why the card asks.
What 500 has to clear is every primary set (144) and hemibrain's whole published list (230), so
that unticking the box on a dataset whose list barely nests still costs one press. It is gated on
the **count**, not on which box is ticked: a dataset whose primary set were that large would
deserve the same question.

**It is 29 MB gzipped for hemibrain and 62 MB for male-CNS** — four to nine times Explore Dataset's
whole-dataset neuron index. So the card opens on an explicit `Load N regions` rather than fetching
on mount. What lands is the polyline above, cached, so the second open has no button and no wait:
`idle` means "not stored", never "never loaded".

**The precomputed buckets were investigated and do not generalise.** hemibrain publishes
`neuroglancer_multilod_draco` ROI meshes at 0.4 MB for every region at finest detail — 73× better.
male-CNS and MANC publish `neuroglancer_legacy_mesh`, single-resolution, ~128 MB. There is no
uniform win, so the OBJ endpoint is the route and hemibrain's bucket is a fast path if it is ever
worth the special case. Worth knowing that `/api/npexplorer/nglayers/…` answers **unauthenticated**
and names the ROI layer outright for MANC, male-CNS and optic-lobe — **on the public deployment**.
That is a fact about that server rather than about the endpoint: another Janelia instance answers
401 on the same path. Nothing depends on it, since `client.ts` sends the token on every neuPrint
request regardless, but do not build anything on the endpoint being open.

**A byte budget is the wrong lever, which is counter-intuitive.** Fetching cheapest-first would
drop `ME(R)`, `LO(R)` and `LOP(R)`: the largest files are the largest *structures*, so a budget
silently deletes the map's dominant features.

**Meshes are decimated as they arrive, not after the batch** (`data/meshDecimate.ts`). Vertex
clustering rather than quadric error — deterministic, one linear pass, and what it preserves best
is the silhouette, which is all the tracer reads. `DEFAULT_DECIMATE_GRID` is 32 because surface
cells go as `π · grid²`, so 32 lands near 3,200 vertices; 64 was the first guess and is *finer*
than several regions' own vertex spacing, merging almost nothing.

### Colour, and the one place the palette rule does not apply

Completeness (pre or post) on a sequential ramp, `region`, `side`, or flat. The two sequential
modes get a labelled ramp over the map - reusing `.colorbar` from the network legend rather than
growing a second one - and the others get none, because three colours and one need no key.

**Presynaptic reads red and postsynaptic blue**, which is the one place this app runs two
sequential hues. They are otherwise the same picture over different numbers, so with a single hue
a glance cannot say which measure is on screen - and on hemibrain the two differ by more than
fifty points, which is exactly the gap somebody could take off the wrong one. It is not an
all-pairs case: a viewer shows one or the other, never both. `sequentialColor` gained a hue
argument rather than a sibling function, because a second copy of the mode flip is how a
dark-mode ramp comes to read as a negative.

`RED_RAMP` was already in the validated palette as the diverging scale's positive arm; what is new
is using the whole of it, so its sequential claim was checked rather than assumed - monotonic in
lightness, luminance 0.729 to 0.055 against blue's 0.743 to 0.038, minimum step 0.032 against
blue's 0.018, end contrasts matching blue's within a tenth of a stop.

**`region` gives each neuropil its own hue and is deliberately not a categorical encoding.**
`colors.ts` never cycles a ninth hue, because in a chart a repeated colour claims two series are
the same thing. Nothing is encoded here: there are 63 to 152 regions, no legend could list them,
and the hue means only "this shape is not that shape" - the job neuroglancer's segment colours do,
hashed for the same reason. It is keyed on the **homology key**, so `ME(L)` and `ME(R)` come out
identical: they are one structure seen twice, and different hues would say the opposite. Hue is
the hash times the golden angle rather than `hash % 360`, which leaves consecutively named regions
looking alike often enough to notice.

### The level above the primary regions

Some datasets publish an ROI hierarchy, and the group above a primary region is what lets a map
of 144 of them be read a system at a time. When one is available the control bar grows a
**Groups** dropdown of checkable items beside the colour selector; when it is not, there is no
dropdown at all.

**`Meta.roiHierarchy` is the source**, a nested `{name, children}` tree, and it arrives as a JSON
*string* — neuprint-python decodes it server-side with `apoc.convert.fromJsonMap`, which this does
not depend on, so it is parsed in `roiHierarchy.ts`. Worth recording that
`Client.fetch_roi_hierarchy` **does not exist**: it is `neuprint.fetch_roi_hierarchy`, a
module-level function. The same shape as the `navis.interfaces.neuprint` trap — the obvious
spelling is a well-bound name and an AttributeError.

**A super ROI is the nearest ancestor that is neither primary nor the root**, and both exclusions
earn their place. The root is the dataset itself, so admitting it yields one group containing
everything: a control that does nothing dressed as one that does. And a primary region's own
children are *sub*-primary — they nest inside it — so the walk stops rather than mapping them to a
group they are only indirectly in.

**A region with no group is never hidden by a group filter.** hemibrain lists `AL(L)` and `GNG`
directly under the root, so ungrouped is the common case rather than an oddity — and no box could
ever be ticked to bring such a region back.

**Empty means every group**, the `chips` idiom, which makes the first untick the interesting one:
it expands to the full list minus one rather than starting from nothing, or unticking a single
group would hide every other and read as the control being inverted. Unticking back down to the
full set returns to empty, so "everything" has one stored form rather than two.

The mock declares a hierarchy of its own (`MOCK_ROI_GROUPS`) rather than going without, so the
control is demonstrable with no token — and the groups are the anatomy those regions really belong
to, because a control demonstrated on nonsense teaches the wrong thing about what it is for.

### Volume is carried and is marked an estimate

neuprint-python's own docstring says these meshes are "intended for visualization only. (They are
not suitable for quantitative analysis.)" — and Coda decimates them further before measuring. The
number is still carried, because nothing else in the app can say anything at all about a region's
size, and the tile is captioned `≈ from display mesh`. An unlabelled `7.9 × 10⁶ µm³` on a card
reads as a measurement.

### Smaller things that would each be a quiet lie

- **The `ValuePreview` branch is above the `!value` guard.** No outputs means the value is
  `undefined` forever, so a branch below it is unreachable and the card reads "No result yet"
  permanently. `out.datasetSummary` shipped exactly that with a green suite, because every test
  rendered the viewer directly — so `rois.test.tsx` drives `ValuePreview` itself.
- **Every param is `advanced`**, `out.neuroglancer`'s call: the map draws its own control bar, so
  generic rows above it would be the same four controls twice, spending a fifth of a 460px card.
  They stay `presentational`, so the expanded view's rail still offers them.
- **An absent `primary` column reads as unknown, not as nested.** A source that says nothing has
  not said its regions sit inside others — the same unknown-is-not-empty rule as `columnSchemaFor`.
- **The outline cache's fingerprint carries the format version, the trace grid and the region list
  by name.** Once the meshes are released these polylines are the only copy, so nothing about a
  stored set reveals which tracer produced it. That is the thumbnail cache's lesson, which
  persisted *refusals* and silently outlived the byte ceiling that created them.
- **Regions are focusable and named** (`role="button"`, `aria-label`). Colour is never the only
  channel here, and it is also what lets `.roi__label` stay `pointer-events: none` so a name never
  blocks the shape under it.

**No visual verification exists**, on the standing of the WebGL viewers: jsdom does no layout, so
the grid areas, the outline geometry at real sizes and the label thinning have not been looked at
by anyone. Everything testable is tested headlessly, and the mock source generates synthetic
shells so the node works offline and on every bundled example.
