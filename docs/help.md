# The `?` on a node

Long-form, in-app documentation for the nodes that need more than a sentence — the
overlay, the document format, and the figures that draw real registry objects.


## What this is, and what it is not

There are now four places a node describes itself, and they are not interchangeable:

| Where                              | Length          | Written in            | Read by                              |
| ---------------------------------- | --------------- | --------------------- | ------------------------------------ |
| `description`                      | one line        | the node definition   | the palette, the browser, the inspector |
| `guide`                            | 2–3 sentences   | the node definition   | the node guide page, and the overlay's lede |
| the node guide (`nodes.html`)      | a reference card | derived               | somebody with a node in mind         |
| **`src/help/nodes/<type>.md`**     | pages           | a markdown file       | somebody who needs to understand it  |

The overlay is a **reading** surface. The reference half — sockets, every setting, the preview
card — is the node guide's job and repeating it here would make the `?` open a worse copy of a
page that already exists. What belongs here is what neither can carry: why the node behaves the
way it does, what it quietly assumes, and the pipeline it is normally part of.

The `?` button exists **because a file exists** and for no other reason. There is no flag on
`NodeDefinition`, no list of documented nodes, and nothing to keep in step: drop
`src/help/nodes/neuron.nblast.md` into place and the NBLAST card grows a `?` on the next reload.
The alternative — a `hasDocs: true` beside the definition — is two things that can disagree, and
the failure when they do is a button that opens nothing.


## Writing one

Markdown, in `src/help/nodes/<the exact node type>.md`. Beyond the subset the dataset blurbs
use, a document may hold fenced figures, callouts, tables and images — see **The format** below.

**Start at `##`.** The overlay draws the node's name in its own header, and `help.test.ts` fails
a document with a level-1 heading rather than leaving two titles for somebody to notice.

**Do not re-introduce the node.** The overlay prints the registry's own `guide` above the
document under a **`TL;DR`** label, so a reader arriving from the node guide or the browser sees
the same sentence they already read, and a reader in a hurry has somewhere to stop. The document
is free to begin with detail.

That label is also a constraint on the node definition. `core/node.ts` asks every `guide` for two
or three sentences; `nodeGuide.test.ts` holds the floor at 120 characters, and `help.test.ts`
holds a **ceiling of 400 for a documented node**, because a nine-sentence paragraph labelled
TL;DR is a lie about itself. Writing a document is therefore usually an occasion to *shorten* the
node's `guide` and move the detail into the file — NBLAST's was 830 characters and is now 305.

**Cross-reference with a fragment**: `[Hierarchical Clustering](#cluster.linkage)`. That opens the
other node's document *in the same overlay*, with a Back button. The target must itself have a
document — a cross-reference that opens an empty page is a broken link, and the test says so.


## The format

`src/ui/markdown.ts` gained four block kinds, and they are **off by default**. That is a safety
property rather than a default: the parser's original job is a dataset blurb from whatever
deployment a Custom node is pointed at, and each extended kind hands that source something it
should not have — a fence is a directive some renderer may act on, and an image is an outbound
request to a host of the author's choosing, i.e. a tracking pixel that fires on anyone who opens
the card. `parseMarkdown(text, { extended: true })` opts in, and only `src/help` does.

- **Fences** — ```` ```lang ```` … ````` ``` `````. The info string is not interpreted by the
  parser; `MarkdownView`'s `renderFence` option is how a caller draws one, and a caller that
  passes nothing gets a `<pre>`. That is the seam that keeps the figure machinery, which needs
  the node registry, out of the component that renders a stranger's blurb.
- **Callouts** — `> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`, optionally with a title on the marker
  line. The body is parsed as a document of its own, so a warning can hold a list. A block quote
  with *no* marker is not a callout and falls through as text: block quotes stay unsupported,
  which is what stops this being a second syntax that quietly changes what a blurb can produce.
- **Tables** — pipe tables, `\|` for a literal pipe. The header decides the width; a short row is
  padded and a long one truncated, because a `<tr>` short of a `<td>` draws as a hole in the
  middle of the table with nothing to say why.
- **Images** — `![alt](file.png)` alone on a line, resolved against `src/help/images/` by
  **bare filename**. Deliberately not a path: a document is not at a URL, so a relative path in
  one has no honest meaning. The alt text doubles as the caption, so a figure cannot end up
  captioned and unreadable to a screen reader at the same time. An image with no file draws its
  alt text, and `help.test.ts` fails the build.

A callout's **title is parsed as inline markdown**, which is not a nicety: a warning is very
often about a named setting, and `` `Normalise` `` in one was rendering as three literal
characters plus its backticks. It is parsed in the renderer rather than in `markdown.ts`, which
keeps `title` a plain string for the tone default.

Figure images get a **white plate**, and that is not cosmetic either. These diagrams are drawn on
white or on transparency with black ink, which in dark mode is a bright rectangle with a hard
edge or — worse — black ink on a dark surface and therefore invisible. Inverting instead was
rejected: they use colour semantically, and an inverted red query neuron is a different claim.


## Figures: actual Coda objects

Three fence languages, all resolved against the live node registry:

````markdown
```coda-graph
caption: The usual all-by-all.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
neuron.nblast as nb { symmetry: mean }
ds -> find
ds -> skel:dataset
find:neurons -> skel:neurons
skel -> nb:query
```
````

**Nothing in a figure is drawn from what the author typed.** The label, the category tint, the
sockets with their real shapes and colour families, the settings with the values the pickers
would show — all of it is read off the `NodeDefinition` at render time. Rename a port, add a
setting, change a default, and every document that draws that node is correct on the next reload
with nobody opening `src/help`. It is the property `src/nodeguide/data.ts` buys the node guide,
for the same reason, and `helpOverlay.test.tsx` pins it: the words "Find Neurons" appear nowhere
in the NBLAST document, and are on screen because the registry answered with them.

The grammar is four line forms — a directive, a node, a wire, a comment — and nothing nests.
Deliberately not YAML or JSON: a figure is read and edited far more often than it is written, and
the shape worth optimising for is the one where a wire is a line that looks like a wire.

- `type`, `type as alias`, `type as alias "Title"`, any of them followed by `{ setting: value }`.
  The alias defaults to the type, so a figure with one of each node needs no `as` at all.
- `a -> b`, `a:port -> b:port`. **Both ends may be left out, and the rules differ.** A source
  with no port takes the first output. A target with no port takes the first input the source's
  type is *assignable* to — which is what lets `find -> skel` mean the obvious thing on a node
  whose first input is a Dataset and whose second is Neurons.
- `caption:` and `focus:`.

**`coda-node` and `coda-graph` differ in one thing, and it is not the number of cards.** A
`coda-node` figure with two nodes and a wire is a `coda-graph`. What differs is which settings a
card draws: `coda-node` is an anatomy diagram and shows the full band the real card would;
`coda-graph` is about the shape of a pipeline, so each card shows only the settings the figure
names and counts the rest. Four cards each showing eleven settings is a figure nobody reads.

**`coda-params`** is the third: a node type and some setting ids, rendered as rows carrying the
`help` the app itself shows. It exists rather than a hand-written table because a settings table
goes stale the day a default changes, and the two things worth saying about a setting — its
default and its tooltip — are both already in the definition. What the document adds is *which*
settings are worth a paragraph, which is the one thing the registry cannot know.

**Nothing throws.** A document is data, and a typo in one is not a reason for the overlay to
render white. An unknown type, a port that does not exist, a wire between incompatible types —
each lands in `problems` and is drawn as a visible complaint. Every document in the repository is
asserted to produce none, which is what turns "renders a complaint" from a tolerated state into a
build-time check; what the complaint actually serves is the person editing a document with the
app open beside them.


## Headless, so the node guide can adopt it

`src/help/figures.ts` produces a **model** — cards with positions and sizes, wires with an SVG
path — and a renderer turns it into elements. No React, no store, no DOM. `src/ui/help/FigureView.tsx`
is the app's renderer; `nodes.html`, which has no React at all, can grow a second one over the
same model without a line of content moving.

That split is also what makes the geometry testable. **jsdom performs no layout**, so a figure
positioned by CSS would be covered by nothing — the same standing `networkDraw.ts` and
`edgeRoute.ts` have, and the reason the layout is arithmetic in a headless module rather than a
flex container.

The stylesheet lives with the model (`src/help/figure.css`) for the same reason. Every colour in
it is a token from `theme.css`: a figure and the node it draws cannot disagree about what a
Dataset socket looks like, and both follow a theme switch together.

**A figure is scrolled, never scaled.** `FIGURE_FIT_WIDTH` (988px) is what the overlay can draw
without scrolling sideways, and the card metrics are sized so a **five-layer pipeline fits** —
`Dataset → Find Neurons → Skeletons → NBLAST → Heatmap`, which is the longest chain a document has
wanted. Six scrolls. `help.test.ts` fails a document that exceeds it, because a figure silently
needing a sideways scroll reads as a figure with cards missing off the right-hand edge, and
scaling one to fit would put its 10px labels at 7px. `.help-panel`'s `max-width` is that constant
plus its padding; CSS cannot import it, so the relationship is a comment at both ends.

That constraint is also why a figure card is 156px against the canvas's 232: five canvas-width
cards plus their gaps is 1450px, and no reading panel is that wide.

**The other thing only the model can check is overlap.** jsdom performs no layout, so two cards
landing on top of each other is asserted against the model or against nothing.

**The layout is Sugiyama's first two phases and none of the rest** — layers by longest path, then
one downward pass placing each card at the mean height of its upstream sockets and pushing
overlaps apart. Enough because a figure is four or five cards: the crossing-reduction phase a
real engine spends its time in has nothing to reduce at this size, and ELK, which the canvas
uses, is asynchronous and 200 kB. A cycle cannot hang it — the depth pass relaxes a bounded
number of times and stops.

The wire is React Flow's bezier written out in six lines rather than imported, because importing
`getBezierPath` would make the module depend on React, which is the one thing the guide page
cannot have.


## Where the button is, and where it is not

Four entry points, all opening the same overlay keyed on the node **type**:

- the **card header**, beside the fold — rendered only where a document exists, so most cards
  never acquire a fifth control;
- the **inspector header**, beside the collapse chevron, since the inspector scrolls and a
  control that scrolls away is one somebody has to go looking for;
- the **node context menu**, as *What this node does* — not "Help", which in an app with three
  published guides is ambiguous about which of them it opens;
- the **expanded viewer's header**, so a document is reachable from the surface a viewer node is
  usually read on.

**Not the node browser**, and that is a markup fact rather than a decision about usefulness: a
browser row is itself a `<button>`, and nesting an interactive element inside one is invalid. The
browser's footer already links the node guide, which is the reference the row's reader wants.

Keyed on the type rather than on a node id is the whole design. A document is about a *kind* of
node, which is what lets the same overlay open from a card, from a menu, and from a
cross-reference inside another document — a node id would have made the last of those meaningless.


## Loading, and what it costs

`import.meta.glob` twice, and the two calls differ on purpose. The **keys** of a glob are known at
build time without any file being loaded, so `hasHelp(type)` costs zero bytes: the app ships a
list of node types and nothing else until somebody presses `?`. The values are dynamic imports,
so each document is its own lazy chunk.

Images are the opposite and are globbed **eagerly**, because what an eager `?url` glob yields is
not the image — it is the hashed path Vite gave it, a short string per file. Lazily would buy a
few hundred bytes and cost the renderer the ability to resolve `![](x.png)` while it draws.

Measured against the same commit without any of this:

| Chunk                    | Before      | After       | Delta            |
| ------------------------ | ----------- | ----------- | ---------------- |
| `main-*.js`              | 1170.56 kB  | 1188.35 kB  | +17.79 (+5.81 gz) |
| `main-*.css`             | 108.97 kB   | 116.65 kB   | +7.68 (+1.35 gz)  |
| `nodes-*.js` (the guide) | 123.50 kB   | 123.50 kB   | **byte-identical** |
| `neuron.nblast-*.js`     | —           | 4.71 kB     | lazy              |
| `cluster.linkage-*.js`   | —           | 3.38 kB     | lazy              |
| `nblast-dotprops-*.png`  | —           | 98.20 kB    | its own asset, fetched when the figure renders |

The guide chunk being *byte*-identical is worth keeping: it is what says the shared
`help/paramText.ts` — extracted from `nodeguide/data.ts`, which had the only copy of how a
parameter's default prints — changed nothing about the page that used to own it.
