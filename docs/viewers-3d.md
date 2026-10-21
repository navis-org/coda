# Viewers: 3D

The 3D viewer: building the scene, line widths, lights, ambient occlusion, picking, the renderer
kept between surfaces, and the legend. [viewers.md](viewers.md) holds what every viewer shares —
export, tooltips, table filtering and the styling sidebar.

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

**Vertex colours are linear light, and for a long time they were not.** three reads a `color`
attribute as already in its linear working space and encodes to sRGB on output, so the encoded
triplet `hexToRgbFloat` returned, written straight into a buffer, was encoded twice. Every skeleton
and synapse point drew lighter and greyer than the palette, its own legend swatch and
neuroglancer's hash — measured on a dimmed skeleton scene, a grey the dimming rule asked for as
`#8f`–`#97` rendered with its commonest pixel at `#c8`, and at `#90`–`#97` once converted (the
same scene in a real browser, 36% of the achromatic pixels in that bin). Meshes were right
throughout, because a
material's `color` goes through `THREE.Color`, which converts a hex on the way in; that is also
why nothing looked wrong in isolation, and it took a skeleton beside its swatch to see it.
The fix is at the parse rather than at the two buffer builders: it is `hexToLinearRgb` now, and
nothing in `src` wanted the encoded triplet, so no caller holds one to write by mistake — the next
vertex-colour writer included. The test case is a **mid grey** (`encoding.test.ts`): pure primaries
are 0 or 1 in both spaces and pass whether or not anything was converted, where `#808080` is 0.502
encoded and 0.216 linear.

**The canvas is stretched to its box with `!important`, and the reason is a coordinate-space
mismatch.** A renderer measures its container with `getBoundingClientRect` — _post_-transform
pixels — then writes that number back as a CSS width, which inside React Flow's transformed card
is _pre_-transform. The zoom is applied twice and the canvas comes out short by exactly the zoom
factor: measured on a card at 0.8, a 560px preview held a 458px canvas with 100px of dead surface
down one side and the scene sitting off-centre inside it. Only the element is stretched; the
drawing buffer keeps the screen-sized resolution the renderer chose, so this is not an upscale.

**The pointer had the same mismatch, and it outlived the fix above by a long way.** React Three
Fiber maps a click to the scene as `offsetX / size.width`: `offsetX` is the element's own,
untransformed CSS pixels and `size` is `getBoundingClientRect`'s zoomed ones, so at pane zoom *z*
every ray landed at 1/z of the click, measured from the canvas's top-left. Picking on a card
therefore worked only at 100% zoom, and it read as "selection only works in the expanded view".
Measured on a card at 0.48: a click on the neurons at its centre selected nothing, and a click at
0.24 of the way across — empty canvas — selected the neuron at the scene's centre.
`zoomSafeEvents` spreads the library's event manager and replaces only `compute`, through
`pointerNdc`, whose two operands are both on-screen pixels; the rect is read per event, since a pan
moves the element without resizing it. Outside a transform — the overlay, the dock, a dashboard
cell — the answer is the old one exactly.

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

**`by radius` is the default, and the fallback below is what makes that safe.** A card opens on
the calibre every backend already publishes rather than on a constant-calibre wire, which is the
one thing a neuron is not; a source with no radii lands on the uniform path with nothing said,
and nothing is refused. What the change needed was `absentMeans: 'uniform'` on
`skeletonWidthMode`: a document with no key for the mode was written by a build that drew one
width, so absence and the default differ and a saved graph would otherwise reopen looking
different. Presentational either way, so nothing downstream stales — but the picture is the whole
of what this node produces, which is why the third state is written in rather than left to read
as the default.

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

**Skeletons and neuron meshes are pickable; points and volumes are not.** For a long time only
skeletons were — the selection resolved against skeletons then meshes, but no mesh draw site ever
reported a hit, so a scene of meshes alone could be selected from the legend and nowhere else.
Both channels now go through one `usePick`, which owns the three rules that are the scene's
rather than a channel's: a drag is not a click, an item with no id selects nothing, and a hit
stops propagation, so the skeleton running through an opaque mesh — usually the same neuron —
does not toggle the selection straight back. Points are synapses and volumes are regions, so
neither carries a handler; that also keeps a neuropil shell out of the interaction set, where it
would otherwise catch every click aimed at the arbour inside it.

**A mesh raycast is linear in triangles, and React Three Fiber pays it on every pointerdown.**
Measured in Node on one mesh with a ray through its centre (a neuron's bounding sphere covers most
of the screen, so the sphere early-out rarely helps): three's `Mesh.raycast` took 2.2 ms at 50k
triangles, 6.8 ms at 200k, 17 ms at 500k and **49 ms at 1.5M** — the Meshes node's *default*
budget for a set, with `high` at 6M. R3F raycasts every interactive object on `pointerdown` as well
as on the click (it keeps the first hits to check the click landed on the same object), so with
picking on that is paid twice per click and once at the start of **every trackball drag**. So
meshes raycast through `three-mesh-bvh` (`meshPicking.ts`): under 0.03 ms a ray at every size, for
a one-off build of ~330 ms per 1.5M triangles. The build runs only while `Select by clicking` is
on, one mesh per task so input interleaves, and a mesh whose tree is pending falls back to three's
raycast — slow, never wrong.

**`indirect: true` is the load-bearing option, and dropping it would change nothing on screen.**
`MeshBVH`'s default build reorders the geometry's index array in place, and `MeshItem`'s index
attribute wraps the `MeshesValue`'s own `Uint32Array` without copying. A reordered index draws the
same surface, so the viewer would look right while every other reader of the value got its
triangles in a new order. `meshPicking.test.ts` pins the array untouched and the hit's `faceIndex`
in the geometry's numbering rather than the tree's.

The toggle's wording says "a click in the scene" rather than naming a socket, which is why it
needed no change when meshes joined.

**A deselected neuron dims to a grey of its own, laid into a band — and the band is the third
version.** It was `CHART_INK.muted` for every skeleton and mesh, which answered "which is
selected" and nothing else: pick one neuron of twenty and the other nineteen became one grey mass,
the colour that separated them being exactly what dimming threw away. `dimFor` now places each
item by how far its lightness sits from the scene's surface, as a fraction of the furthest any
colour can be, and lays that fraction linearly across a band: from 3:1 against the surface
(`DIMMED_MIN_CONTRAST`, the non-text floor `CHART_INK.grid` sits under *so that* it is invisible)
to the scene's **secondary** ink. So a yellow neuron dims paler than a blue one on a dark ground,
every dimmed item stays visible, none is brighter than the chart's secondary register, and two
share a grey only if they shared a lightness. Both ends come from the surface the scene is drawn
on (`sceneDim`), so a pinned light background recedes *upwards* by the same rule. A per-node
colour (Topology's compartments) dims through the same rule, so a dimmed arbour keeps its
compartments apart. Lightness is CIE L* over relative luminance in linear light — a sum of the
*encoded* channels puts pure blue at 7% of the way to white rather than ~30%.

Measured over 400 neuroglancer-hash colours (the default for both channels; in colour they span
L* 34–97, median 71), against the old grey's L* 56 — reproduced by calling `sceneDim` over
`segmentColor` for 400 ids and converting the result to L*:

| rule | dark surface: L*, median | at one grey | light surface: L*, median | at one grey |
| --- | --- | --- | --- | --- |
| hue out, luminance kept | 34–97, 71 | — | as in colour | — |
| pulled towards the surface by one factor, floored at 3:1 | 43–76, 56 | 60 of 400 | 57–61; p10 to max all 60.9 | ~all |
| **floor → secondary ink band** (shipped) | **52–77, 67** | 1 | **44–61, 54** | 2 |

The first kept every item's contrast exactly — and with it the brightness: 311 of 400 dimmed
*lighter* than the old grey, and the one neuron in colour became the hardest thing on screen to
find. The second fixed that and collapsed the order against its clamp — worst on a light surface,
where most hashed colours already sit near white. The band has no clamp to pile against.

**What it does not buy, measured rather than assumed.** On the dark surface the band pulls the
top down (97 → 77) but moves the middle little, so 381 of 400 still sit above the old uniform
grey; the room between "visible" (43) and the secondary ink (78) is all there is, and lowering the
ceiling darkens the context by narrowing the spread with it — `muted` as the ceiling leaves 13 L*
for 400 neurons. Meshes recede further regardless, dimming also capping them at 0.35 opacity. And
**no grey separates hues of equal lightness**, which is what the validated categorical palette is
made of: its eight slots dim to L* 58–63 on dark and 43–54 on light, two of them to the same
grey. That is the network viewer's reason to keep a dimmed mark's hue and blend it towards the
surface instead ("de-emphasis recedes, it never erases"); this viewer chose shades of grey, and
`by category` scenes pay for it.

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
  account. For the 3D viewers that no longer costs the scene: the renderer is handed back to the
  card rather than rebuilt (below). The network viewer still remounts, restoring its layout and
  camera from `layoutMemo`.

Both are DOM facts, so `liveRenderers.test.tsx` covers them in jsdom even though the thing they
are protecting against is invisible there.

### A 3D renderer is handed between surfaces, not rebuilt

**Standing down kept the count at one, and every switch still paid for a whole renderer.** The
card and the overlay are two mounts, so expanding a node destroyed one WebGL context and built
another: every geometry and its vertex normals, every upload, every program, and every mesh's pick
tree. Measured with `pnpm probe:viewer3d-switch` on 40 LC10 meshes from male-CNS (M3 Max, ANGLE
Metal, dev server), each direction alike:

| scene | main thread busy | longest task | contexts | uploaded | programs |
| --- | --- | --- | --- | --- | --- |
| 1.3 M triangles, before | ~270 ms | ~150 ms | 1 | 31 MB | 10 |
| 7.7 M triangles, before | ~1.06 s | ~850 ms | 1 | 180 MB | 10 |
| 7.7 M triangles, picking on, before | ~2.8 s | ~870 ms | 1 | 180 MB | 10 |
| 7.7 M triangles, picking on, **after** | **~45 ms** | **none** | **0** | **0** | **0** |

Before, normals were ~780 ms of the 7.7 M switch and pick trees another ~1.6 s. What is left
after is React re-rendering the chrome (dev mode) and one `setSize` for the new box.

**Caching the CPU half was the alternative and was measured first.** Normals are 6 B per triangle
and pick trees another 11–13, so keeping them across mounts would have cost 46 MB — 143 MB with
picking — beside 134 MB of mesh data, and still re-uploaded and recompiled on every switch. Keeping
the renderer costs nothing extra while a surface shows the node, and a parked one for 5 s after.

**What is kept is the renderer core, never the viewer component.** `PersistentCanvas` replaces
React Three Fiber's `<Canvas>` — a thin wrapper around `createRoot(canvas)` that measures, calls
`configure({ size })` and `render(children)` on every commit — with one whose root, canvas and
event host live in `persistentRoots.ts` under a key. The next surface renders the same element tree
into the same root, React Three Fiber reconciles it in place, and every memo in the scene survives.
The whole-viewer version (an app-level host portalling the viewer into whichever surface is live)
was designed and rejected before a line of it was written: React events follow the component tree,
and React Flow's click-to-select, double-click and node context menu are React props on the node
wrapper, as is the card's own double-click to expand. A portal owned elsewhere would draw correctly
and stop answering all of them.

Four rules, each silent when wrong:

- **No context bridge.** `<Canvas>` forwards DOM-side contexts into the scene through a component
  minted per instance, so a new surface would hand the root a new component type at the top of
  its tree and remount everything under it — the one cost this exists to avoid. Nothing in the
  scene reads a DOM-side context; one that starts to will quietly get its default.
- **The key names the workflow as well as the node** (`scopedKey`, off the `WorkflowScope` context `App` provides once; the camera memo uses the same
  key), because two documents
  opened from one file share node ids and one root answering for both draws the wrong scene.
- **A second live lease on one key gets a private root**, which is the old behaviour: the inspector draws
  a Topology card beside the canvas one. A root that throws is discarded rather than handed on.
- **Parked in a hidden lot in the document, released after `RELEASE_AFTER_MS` (5 s).** Long enough
  for a switch, a dashboard round trip or a glance at another workflow; short enough that a
  collapsed card or a closed document does not hold a context — Chrome keeps about sixteen and
  kills the oldest.

`persistentRoots.test.ts` covers the lease, park and release rules with counters for roots. That
the canvas really is handed over, draws, still picks, still turns, keeps the camera and is released
is a browser fact: `pnpm probe:viewer3d-switch -- --detail 6000000 --pick --cycles 2 --interact`.

**Neuron Topology gets it for free**, drawing through `Viewer3D` — with one consequence that had to
be paid for. Its camera was framed afresh on a new neuron only by accident, when an uncached page
unmounted the viewer (a cached page never was), and a kept renderer keeps its camera, so every page
opened at the last neuron's distance and angle. It names the neuron it draws as `frameKey` now — the
skeleton's id, not the page, so nothing frames onto the last arbour while the next loads — and a new
one is framed (`shouldFrame`); the camera memo stores the key, so a restore onto another neuron
frames too. `pnpm probe:viewer3d-switch -- --topology --dataset dataset.hemibrain --cycles 1
--interact` checks both halves. **The network viewer does not
yet**: sigma is built and killed in one effect whose handlers close over local state, it already
restores layout and camera from `layoutMemo`, and its switch cost has not been measured.

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

### `by value`'s controls: the Heatmap's colour domain, shared

A ramp, two ends, a centre and a log on `by value`, through `colorParams({ valueScale: true })`.
On for all four 3D sockets, Scatter's point colour and Network's **node** colour — not its links,
whose `by value` was withheld for the hairline measurement recorded above.

**One arithmetic, lifted rather than copied.** `ColorDomain`, `normalize`, `rampDomain`,
`RAMP_STEPS`, `bucketOf` and `rampColors` live in `style/encoding.ts`, and the Heatmap and
`resolveColor` both read them; the typed ends go through `parseColorLimits`, which
`readColorLimits` is now a caller of. So a palette name, an inverted pair being ignored, the
symmetric centred ramp and the log's `log1p(v − lo) / log1p(span)` each mean one thing app-wide.
`rampDomain` differs between its callers in one default only: **an automatic bottom is the data's
minimum** for `by value`, which is what it always drew, where the Heatmap's `colorDomain` passes
`floor: 'zero'`. `valueDomain` adds the one refusal `by value` needs on top — a single typed end on
the wrong side of the data — which the Heatmap does not make. `encoding.test.ts` pins that a node
on the defaults draws the ramp it drew before, legend included.

**`by value` reads the Heatmap's lookup table.** A row is a bucket into `rampColors`' 512 steps
rather than a ramp sample — the 65 ms against 2 ms `RAMP_STEPS` records, paid here per synapse
point — and the same measurement is what says the quantisation is within a channel value or two
of exact. It also turns the 3D viewer's per-colour parse cache from a miss per point into a hit.

**A centred ramp is symmetric about its centre** — the Heatmap's zero-centred rule, generalised
off zero. One magnitude sets both ends, so equal steps of colour are equal amounts either side and
the middle colour means the centre. The alternative, min → centre → max with each arm stretched on
its own, honours three typed numbers and makes a colour step mean a different amount on each side,
which is the thing a diverging ramp is read for. So there is no `Min` there, `Max` is the distance
from the centre to either end, a spread not above zero is ignored with a reason, and there is no
`Log` (a log across a centre compresses the arms differently). `readValueScale` enforces those on a
stored value too, since `visibleIf` hides a stale `Min` from the panel and not from the params.

**One dropdown for both kinds of ramp**, where the Heatmap has a `Colour scale` beside two palette
params. The Heatmap's shape keeps a palette choice when the scale is toggled; this one spends one
control rather than three in a colour row that already holds a mode, a column and, on a surface,
an opacity. The names are the Heatmap's either way. The lists share a value space, and `coda`
names a ramp in each, so a diverging value carries a `diverging:` prefix.

**"When the column is numeric" is a picker restriction, because `visibleIf` cannot see a schema.**
`ColorBy`'s `dtypes` is a function of the mode: numbers under `by value`, anything otherwise. That
needed one change in `validateColumnParams`: a stored column present in the table but of a type
the picker currently refuses said `Missing column: type`, sending somebody looking for a column
that is right there. It says `Column "type" is not i64/f64, which "…" needs` now, and says nothing
when the stored value is the declared default — `neuronId` on a 3D socket switched to `by value`
falls through to the first numeric column, and nobody chose the one it replaced.

**What a colour bar would misstate is `rampNotes`, one list for every surface.** `centred on …`
(non-zero only), `values clipped`, `log colour` and `limits ignored`, read by `ColorKey` — the one
colour bar the three viewers share — by the Heatmap's caption, and by `rampLabel`, which titles an
exported bar and leaves out `limits ignored`: the file's ends are then the data's, which is
already true of the picture.

**Not reproduced in either exported document.** Scatter's `hue=` and `colour =` choose their own ramp
over the data's range, as they did before these controls. `valueScaleNote` says what the card does
that the plot does not, rather than drawing a different picture in silence. Reproducing it
(`hue_norm`, `scale_colour_viridis_c(limits =)`, a centred norm) wants the Heatmap exporters'
treatment: written, then checked by running both.

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
