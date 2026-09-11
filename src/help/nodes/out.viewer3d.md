## Four sockets, one space

Skeletons, meshes and synapse points are three views of the same cell; volumes are the room they sit in. Only one socket has to be filled.

They line up because everything upstream converts to **nanometres** at its own edge: a skeleton from one query and a mesh from another are the same neuron in the same place.

```coda-graph
caption: One neuron search feeds both morphology queries, so the wire frame and the synapses are about the same cells. The regions come from the dataset alone.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
neuron.synapses as syn
neuron.roiMeshes as rois
out.viewer3d as view
ds -> find
ds -> skel:dataset
ds -> syn:dataset
ds -> rois:dataset
find:neurons -> skel:neurons
find:neurons -> syn:neurons
skel -> view:skeletons
syn:points -> view:points
rois:meshes -> view:volumes
```

| Socket | What it draws | Comes from |
| --- | --- | --- |
| `Skeletons` | the branching wire frame, one line per parent link | `Skeletons` |
| `Meshes` | the filled surface — the shape a neurite actually has | `Meshes` |
| `Points` | one dot per synapse, or per soma, or per anything else with a position | `Synapses` |
| `Volumes` | neuropil shells — the room the cells are in | [`ROI Meshes`](#neuron.roiMeshes) |

`Volumes` is a second meshes socket rather than the same one so that a shell and a neuron can carry their own opacity and their own colour encoding.

## Colour is a column picker, three times over

Every input arrives with an **attribute table** beside its geometry — one row per skeleton, per mesh, per point, in the same order. So "colour these by cell type" is the ordinary column picker, not a special case built into the viewer.

The three encodings are independent: neurons by cell type while their synapses go by polarity. Each one that resolves to a category gets its own key in the legend strip under the canvas.

**Skeletons and meshes start on `a colour each`, hashed from `neuronId`** — **neuroglancer's own hash**, so a cell that is teal in a FlyWire view is teal here.

| Mode | Use it when |
| --- | --- |
| `a colour each` | the colour stands for *which neuron this is*. No cap: forty neurons, forty colours |
| `by category` | the colour stands for a *group* — `type`, `side`, a cluster number |
| `by value` | the column is a number and the order matters — cable length, synapse count |
| `single colour` | the colour is not carrying anything, and something else in the scene is |
| `colours in a column` | something upstream already decided, and you want it honoured |

`by category` ranks values by frequency and hands them the palette's eight colours in that order, coming round to the first after the eighth; the caption says when it has repeated. `a colour each` derives a colour per value, so it never runs out — but the hues cover the whole circle with no colourblind check.

> [!NOTE] The legend lists twelve
> A hash key is one row per neuron, so the strip shows the first twelve and says `+28 more`. The rest are still drawn in colours of their own; they just have no key to click.

## The legend is a control panel

| Part of the key | What it does |
| --- | --- |
| the swatch | opens a colour picker — that key's colour, overriding the palette slot |
| the label | selects every item under it; click again to let it go |
| the dot after it | hides that key from the scene; `Alt`-click (`Option` on a Mac) shows **only** it |

A hidden neuron is not drawn at all rather than drawn faintly, so it also stops being clickable. The caption says how many are hidden, since a scene showing 12 of 21 neurons otherwise looks like a scene that only fetched 12.

**Selecting from the legend is the same selection as clicking in the scene**, and feeds the `Selected` output. Synapse keys can be hidden and recoloured but not selected: their rows are synapses, and the selection this node carries is of neurons.

Hidden keys and colour overrides are saved with the workflow and both presentational. `show all` and `reset colours` appear at the end of the strip when there is something to undo.

**Where more than one socket has something on it, each group's name is itself a switch** — `● skeletons`, `● volumes` — taking that socket out of the picture. This reaches somewhere the per-key dots cannot: a key only exists where the colour is a category, so a socket on a single colour has none, which is what neuropil shells arrive as.

## Getting around

The camera is a **trackball**, like neuroglancer's: drag to turn, with no up axis holding you level. The compass in the corner tracks the current orientation, and **clicking an axis head flies to that view**. Scroll zooms.

**The camera is framed once and then left alone.** It centres itself the first time the scene has anything in it; after that nothing moves it — not an upstream node re-running, not expanding the card and closing it again. **Reset view** (`⟲` in the caption) frames the whole scene again, and is the only thing that does.

## Picking neurons, and the pick is an output

Selected neurons keep their colour while everything else dims to **a grey of its own**: lighter colours to lighter greys, all of them pulled back towards the background, so the neurons you did not pick can still be told apart without competing with the ones you did. Colours of similar lightness — the eight of `by category` among them — dim to much the same grey. The selection leaves through `Selected` as an ordinary neuron table.

**Clicking in the scene is off until you switch it on**, with `Select by clicking` on the **Scene** tab. After that a click on a skeleton or a mesh selects that neuron and a second click lets it go. Synapse points and volumes are not clickable, so a click passes through a neuropil shell to the neuron inside it.

> [!NOTE] Why that is off by default
> The selection takes part in the provenance key, so changing it marks everything downstream stale and re-runs it. A click that lands on a neurite while you are turning the scene would do that silently.

**Legend labels select either way**, whatever the toggle says. `3 selected ⨯` in the caption clears the whole selection, and is only there when there is one to clear.

## Where the settings are

The card shows no settings at all — ports, the picture and the legend. Expand it (`⤢`) and everything is in the **Style** panel down the right-hand side, with **a tab per socket** plus one for the scene. The **Style** button in the header puts the panel away.

```coda-params
caption: The three settings most worth changing, all of them presentational — they change the picture and nothing downstream.
out.viewer3d: meshOpacity, pointSize, background
```

**Meshes are opaque; volumes are not.** Both are a slider in their own colour's row. `Mesh opacity` starts at 1, `Volume opacity` at 0.12; either can be moved to the other's setting.

**Volume colour is a single grey by default**, where skeletons and meshes start on a colour each: 63 neuropils over an eight-colour palette repeats a hue every eighth region. Switch it to `by category` on `roi` when the regions are the subject rather than the room.

**Point size is in nanometres**, not pixels, so synapses keep their size relative to the neuron as you zoom. On a whole-brain scene the default is a speck.

**`Light intensity`** scales the scene's lighting; 1 is the default the palette was checked against. Past about 1.4 the brightest surfaces **clip** — there is no highlight roll-off — and at the top of the slider roughly a quarter of the visible surface is white rather than its own colour.

**Ambient occlusion** darkens creases, cavities and the places where surfaces meet. **0 turns it off**; at 100% a fully occluded pixel goes black, and above that the effect widens rather than deepens. Only opaque meshes and volumes can cast it, so a scene of skeletons alone is unaffected.

**Background** pins the canvas regardless of the app's theme. `black` is its own option and not the same as `dark`, whose surface is a very dark grey.

## Line width

**Three modes, and a new card opens on `by radius`.** `one width` draws every neurite the same. `by radius` and `to scale` both draw each one at its recorded calibre — CATMAID's annotated radii, CAVE's level-2 chunk sizes, neuPrint's SWC column.

Under `by radius` the number is the width of the **thickest** neurites, in pixels; everything thinner is drawn in proportion, down to a one-pixel floor. `to scale` is the same radii in the scene's own units, so the number is a **multiplier**: at 1 a 200 nm neurite is drawn 200 nm across and thickens as you zoom into it. Nodes with no recorded radius stay a hairline, and a source that publishes none falls back to one width.

`by radius` keeps the arbour looking the same at every zoom, which suits a figure about branching pattern. `to scale` is the honest one for calibre, but zoom out far enough and thin neurites all reach the hairline floor together.

Anything above 1 costs more to draw: at 1 the skeletons are hairlines, the only width WebGL draws, and above it each segment becomes a camera-facing quad at about four times the vertex data.

## Getting a picture out

The download button offers **PNG** — the scene as it stands, at twice screen resolution, with the compass left out. It is a read-back of the live frame rather than a re-drawing. **`PNG, no background`** is the same frame for dropping onto a figure. `CSV` writes the attribute table behind the geometry, not the picture.

> [!NOTE] A cut-out of hairlines is faint
> On a transparent background a one-pixel line is mostly *coverage* rather than colour, so it arrives pale. Raise `Line width` before exporting a cut-out.

A `Download` node wired to this one can write the same PNG as part of a run, as long as this card is on screen while it runs — a picture only exists where it is being drawn.

## What it is not

- **It is not a segmentation browser.** For EM sections, published scenes and neuron meshes served straight from a bucket, use `Neuroglancer`, which fetches its own geometry rather than taking it on a wire.
- **It is not the ROI map.** `ROI Viewer` answers "where in the brain is this region, and how well is it traced" with its own fetch and its own 2D projection, and nothing it downloads can leave it. Use [`ROI Meshes`](#neuron.roiMeshes) to put the same shells on a wire and draw them in here.
- **Everything it draws was fetched first.** The morphology nodes are `expensive` and capped, so this is a viewer for tens of neurons, not thousands.
