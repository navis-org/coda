## Four sockets, one space

Skeletons, meshes and synapse points are three different answers to "what does this cell look like"; volumes are the room they sit in. This node draws all four at once, and only one of them has to be filled: a scene of meshes alone is a perfectly good thing to look at, and so is a cloud of synapses with nothing else in it.

They line up because everything upstream converts to **nanometres** at its own edge. A skeleton fetched from one query and a mesh fetched from another are the same neuron in the same place, without either node knowing about the other.

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

> [!NOTE] Why `Volumes` is a second meshes socket rather than the same one
> A neuropil shell and a neuron are the same *type* and never the same *mark*. One is an opaque object you are looking at; the other is faint context around it. Sharing a socket would mean one opacity and one colour encoding for both, so drawing a neuron inside a region would either bury the neuron or turn it to glass along with the region.

## Colour is a column picker, three times over

Every input arrives with an **attribute table** beside its geometry — one row per skeleton, per mesh, per point, in the same order. So "colour these by cell type" is the ordinary column picker you would use on a table, not a special case built into the viewer.

The three encodings are independent, which is the point of keeping them apart: neurons can be coloured by cell type while their synapses are coloured by polarity, in one picture. Each one that resolves to a category gets its own key in the legend strip under the canvas, named when more than one is on screen.

**Skeletons and meshes start on `a colour each`, hashed from `neuronId`.** Every neuron gets a colour of its own, computed from its id — and it is **the same colour neuroglancer gives it**, because it is neuroglancer's own hash. A cell you recognise as teal in a FlyWire view is teal here.

| Mode | Use it when |
| --- | --- |
| `a colour each` | the colour stands for *which neuron this is*. No cap: forty neurons, forty colours |
| `by category` | the colour stands for a *group* — `type`, `side`, a cluster number |
| `by value` | the column is a number and the order matters — cable length, synapse count |
| `single colour` | the colour is not carrying anything, and something else in the scene is |
| `colours in a column` | something upstream already decided, and you want it honoured |

> [!NOTE] Which of the first two you want
> `by category` uses eight validated, colourblind-checked slots and folds everything past them into an achromatic `Other` — the right thing when eight groups is what you have, and mostly grey when forty neurons is. `a colour each` never runs out, and pays for it: the hues cover the whole circle with no such check, so two of forty may land near each other. Identity is what it is for; meaning is what the palette is for.

> [!NOTE] The legend lists twelve, not forty
> A hash key is one row per neuron, so the strip shows the first twelve and says `+28 more` after them. The rest are still drawn, still in colours of their own — they just have no key to click. Colour by a column that groups them if you need to reach them all from the strip.

## The legend is a control panel

Every key in the strip does three things, and each is a different part of the key.

| Part of the key | What it does |
| --- | --- |
| the swatch | opens a colour picker — that key's colour, overriding the palette slot |
| the label | selects every item under it; click again to let it go |
| the dot after it | hides that key from the scene; `Alt`-click (`Option` on a Mac) shows **only** it |

**Hiding is how you read a crowded scene.** Twelve cell types in one arbour is a tangle no palette separates; `Alt`-click isolates one, and `Alt`-clicking it again brings the rest back. A hidden neuron is not drawn at all rather than drawn faintly, so it also stops being clickable — and the caption says how many are hidden, because a scene showing 12 of 21 neurons otherwise looks exactly like a scene that only fetched 12.

**Selecting from the legend is the same selection as clicking in the scene.** It feeds the `Selected` output, so "every LC4 in this picture" becomes the input to the next query. A key whose neurons you had already picked one by one fills in the rest on the first click rather than clearing them.

Synapse keys can be hidden and recoloured but not selected — their rows are synapses, and the selection this node carries is of neurons, so those labels are text rather than buttons.

**Both are saved with the workflow**, and both are presentational: a hidden key changes the picture and nothing downstream, unlike the selection. `show all` and `reset colours` appear at the end of the strip whenever there is something to undo.

### Switching a whole socket off

Where more than one socket has something on it, each group's **name** in the strip is itself a switch — `● skeletons`, `● volumes` — and clicking it takes that socket out of the picture entirely.

This is one step coarser than the per-key dot beside it, and it reaches somewhere the keys cannot. A key only exists where the colour is a category, so a socket on a single colour has none — which is what neuropil shells arrive as. The shell in front of your arbour is exactly the thing you want gone in one click, and until this it was the one thing on screen with no control that could remove it.

An off socket is not drawn at all rather than drawn faintly, so it costs nothing and cannot be clicked; the caption counts it as hidden, like everything else the legend holds back.

## Getting around

The camera is a **trackball**, like neuroglancer's: drag to turn, and there is no up axis holding you level. That is what lets you look at a brain from underneath, and it is also how a scene ends up rolled with no idea which way is anterior — which is what the compass in the corner is for. It tracks the current orientation, and **clicking an axis head flies to that view**.

Scroll zooms.

**The camera is framed once and then left alone.** It centres itself the first time the scene has anything in it, and after that nothing moves it on its own — not an upstream node re-running, not expanding the card to full size and closing it again. A framing is something you arrange, and the two of those used to throw it away. **Reset view** (`⟲` in the caption) is the way back: it frames the whole scene again, and it is the only thing that does.

## Picking neurons, and the pick is an output

Selected neurons keep their colour while everything else dims to grey, and the selection leaves the node through `Selected` as an ordinary neuron table — so "the three I liked the look of" becomes the input to a connectivity query, another fetch, or a second scene.

**Clicking in the scene is off until you switch it on.** `Select by clicking`, on the **Scene** tab, is what turns it on; after that a click on a skeleton selects it and a second click lets it go.

> [!NOTE] Why that is off by default
> The selection is the one thing on this node that is *not* just how the picture looks — it takes part in the provenance key, so changing it marks everything downstream stale and re-runs it. A trackball has no way to say "I was only looking", and a click that happens to land on a neurite while you are turning the scene would silently re-run a query. Switch it on when picking is what you came to do.

**Legend labels select either way.** A label names what it selects, so it is never the accident the toggle exists to prevent — clicking `LC4` in the strip picks every LC4 whatever the toggle says.

**The count in the caption is the way out.** `3 selected ⨯` clears the whole selection in one click, and it is only there when there is one to clear.

Selection is saved with the workflow and takes part in the provenance key. Changing it marks what is downstream of it stale, because it genuinely changed what this node emits.

## Where the settings are

The card shows no settings at all — it is ports, the picture and the legend. Expand it (`⤢`) and everything is in the **Style** panel down the right-hand side, with **a tab per socket** plus one for the scene, so a control sits under the thing it acts on rather than in a list of fourteen.

The **Style** button in the header puts the panel away and gives the whole window to the scene. It stays where you left it, for every viewer.

## Surfaces, dots and the background

```coda-params
caption: The three settings most worth changing, all of them presentational — they change the picture and nothing downstream.
out.viewer3d: meshOpacity, pointSize, background
```

**Meshes are opaque; volumes are not.** Same control, opposite job, and both live as a slider in their own colour's row rather than as a setting somewhere else — a colour and how much of it comes through are one decision. `Mesh opacity` starts at 1, because a mesh set is more often the whole scene than a backdrop for one, and a surface that occludes is what makes it read as a solid object rather than as a renderer that has not finished loading. `Volume opacity` starts at 0.12, because a shell is drawn so that something else can be seen inside it. Either can be moved to the other's setting.

**Volume colour is a single grey by default**, where skeletons and meshes start on a colour each. A categorical encoding over 63 neuropils is eight hues and a grey `Other`, which reads as a claim that eight of them are special. Switch it to `by category` on `roi` when the regions are the subject rather than the room.

**Point size is in nanometres**, not pixels, so synapses keep their size relative to the neuron as you zoom. On a whole-brain scene the default is a speck; raise it until the cloud reads.

**`Light intensity`** scales the scene's lighting. 1 is the default the palette was checked against; below it surfaces get moodier, above it they get brighter — up to a point. Past about 1.4 the brightest surfaces start to **clip**: the renderer has no highlight roll-off, so light beyond what a channel can hold washes a surface toward white instead of brightening it. At the top of the slider roughly a quarter of the visible surface is white rather than its own colour, which is a look you might want and is not more light.

**Ambient occlusion** darkens creases, cavities and the places where surfaces meet, which is what makes a mesh read as a solid object rather than as a flat silhouette. It is a strength rather than a switch: **0 turns it off**, and at 100% a fully occluded pixel goes black. Above 100% the effect widens rather than deepens — the darkest places are already black, so what the extra buys is pulling the half-shadowed places down with them. Useful for a figure that needs the depth to read at a glance; heavy-handed on a surface that already has a lot of contact in it.

> [!NOTE] It only does something where there are surfaces
> Only meshes and volumes can cast occlusion — a line has no surface to occlude, so a scene of skeletons alone is unaffected and the effect is not computed there at all. Translucent surfaces are left out too: a neuropil shell at 12% is context, and letting it darken the arbour you can see through it looks like dirt on the picture rather than like shading.

**Background** pins the canvas regardless of the app's theme, which is the setting a figure wants. `black` is its own option and not the same as `dark`: the dark theme's surface is a very dark grey, and a figure usually wants the real thing.

**`Line width` has three modes.** `one width` draws every neurite the same. `by radius` and `to scale` both draw each one at the calibre it was traced or segmented at — so a primary neurite reads as one and the twigs at the edge of an arbour read as twigs. The radius is data your source already published: CATMAID's annotated radii, CAVE's level-2 chunk sizes, neuPrint's SWC column.

Under `by radius` the number is the width of the **thickest** neurites, not a width every node gets. Everything thinner is drawn in proportion, down to a one-pixel floor — so raising it stretches the range rather than thickening the whole picture. A source that publishes no radii falls back to one width on its own.

`to scale` is the same radii in the scene's own units instead of in pixels: a 200 nm neurite is drawn 200 nm across, and thickens as you zoom into it. Nothing is rescaled, so the number here is a **multiplier** — 1 is the arbour exactly as the source recorded it, which is the one setting you could measure a neurite off. Nodes with no recorded radius stay a hairline rather than disappearing.

> [!NOTE] Which of the two radius modes you want
> It depends on what the picture is of. `by radius` keeps the arbour looking the same at every zoom level, which suits a figure about branching pattern. `to scale` is the honest one for calibre — but zoom out far enough and thin neurites all reach the hairline floor together, so a whole-brain view shows you less than `by radius` would.

> [!NOTE] Why anything above 1 costs more
> At 1 the skeletons are hairlines — one pixel wide whatever any setting says, because that is the only width WebGL draws. Above it, and in either radius mode at any width, each segment becomes a camera-facing quad: a real width, at about four times the vertex data. Worth it for a figure, and worth leaving alone for a scene you are exploring.

## Getting a picture out

The download button offers **PNG** — the scene as it stands, at twice screen resolution, with the compass left out. It is a read-back of the live frame rather than a re-drawing, so what lands in the file is the view you framed. **`PNG, no background`** is the same frame with the background left out entirely, for dropping onto a figure. `CSV` writes the attribute table behind the geometry, not the picture.

> [!NOTE] A cut-out of hairlines is faint
> On a transparent background a one-pixel line is mostly *coverage* rather than colour, so it arrives pale. Raise `Line width` before exporting a cut-out and the marks come out solid.

A `Download` node wired to this one can write the same PNG as part of a run, as long as this card is on screen while it runs — a picture only exists where it is being drawn.

## What it is not

- **It is not a segmentation browser.** For EM sections, published scenes and neuron meshes served straight from a bucket, use `Neuroglancer` — it is the tool built for that, and it fetches its own geometry rather than taking it on a wire.
- **It is not the ROI map.** `ROI Viewer` answers "where in the brain is this region, and how well is it traced" with its own fetch and its own 2D projection, and nothing it downloads can leave it. Use [`ROI Meshes`](#neuron.roiMeshes) to put the same shells on a wire and draw them in here.
- **Everything it draws was fetched first.** The morphology nodes are `expensive` and capped, so this is a viewer for tens of neurons, not thousands.
