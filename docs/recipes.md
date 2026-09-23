# Recipes

A recipe is a set of cards somebody uses together — an annotation setup, a find-then-filter, a
viewer with its styling — saved so it can be put back in one gesture, attached to what it was
attached to before. `core/recipes.ts` is the format and the two operations, `store/recipes.ts`
the shelf, and `RecipeSaveDialog`, `RecipesDialog`, the palette, the node and frame menus and the
**+** menu the surfaces.

Read this before changing what a recipe records or how one attaches. Most of the decisions below
had an obvious alternative that fails without saying so: cards that land attached to nothing,
three bindings for one dataset, a half-wired chain under cards that all look configured.

## A recipe is a clipboard fragment that remembers its edges

The fragment half is `core/clipboard.ts`' and is **not reimplemented**. `fragmentBody` decides
what a selection takes (internal wires, whole frames, captions), `deserializeGraph` reads it back
and `insertFragment` re-identifies it. So a recipe saved months ago gets the renames
(`formerId`, `formerIds`), the `absentMeans` and the unknown-type drops that a file gets. A second
reader for "a saved set of nodes" is where those repairs would quietly stop happening, which is
`canvas.md`'s argument for the clipboard, reached again.

What a fragment throws away is every wire with one end outside the selection. That is right for a
paste, which must not steal an input. For the case this exists for it is useless: the FlyWire
annotation chain is six cards whose whole purpose is two reference wires *from* a dataset and one
wire back *into* its `annotations` port. Saved as a fragment, it comes back as six cards attached
to nothing.

So the crossing wires are recorded as **slots**. A recipe file is the fragment body with the
marker `coda.recipe` and a `recipe` field (name and slots) beside it. It is one document rather
than a fragment inside an envelope, which means **the text is also a fragment**: `readFragment`
ignores the fields it does not know, and ⌘V of a recipe file places its cards, framed and
unattached, rather than refusing them.

## A slot is one outside node, not one wire

`recipeFrom` groups the crossing wires by the node at their far end. The annotation chain's three
wires all touch one dataset. Listed as three slots, they would ask for that dataset three times
and could be bound to three different ones, which nothing downstream flags. Grouped, the chain has
one slot, and a slot's wires may run in both directions (`SlotWire.dir`).

A slot wire records the inside end (a fragment-local node id and port) and the outside port as a
**preference** (`outer`). The node a recipe is attached to need not be the type it was saved
against. A find-then-filter saved against hemibrain should attach to MANC. So `wireOne` tries the
saved port id first and then every other port on that side.

**Two different port lookups, deliberately.**
- The inside end is healed on read by `resolvePort` (`graph.ts`), the same function `deserializeGraph`'s edge loop uses, so a port renamed since the save is followed. It was split out of `healHandle` for this caller. `healHandle` keeps the fallbacks that only make sense for an old file (the sole port, the legacy `in`/`out`), and those must not reach a recipe, which always records its handles.
- The outside end is matched by **plain id**, not through `resolvePort`. A rename history belongs to one node type, and the attach target may be another type.

## Attaching

`insertRecipe(graph, recipe, { at, attach })`. Four rules, each with a failure behind it.

**The node to attach to is the caller's to say, and it is the selection, never a search.** When
exactly one card is selected, that card is used (`selectionAttach`, which the palette's hint asks
too, so the node a hint names is the node that is attached). Otherwise nothing is attached, and
the inserted cards show their ordinary "wire a Dataset" issues, which is honest and fixable.

From the palette a dropped wire opens, the node is the one the wire came from, **attached
through the port it came from** (`InsertOptions.via`): the slot with a wire running the dragged
way is tried first, and that wire tries the dragged port before its saved one. It shipped
attaching to the node alone, so a recipe listed because it fed the dragged input could attach by
reading that node's output instead: listed for one reason, attached for another.

A canvas-wide "the compatible one" was
considered and declined. Two datasets on one canvas are exactly where it guesses, and CLAUDE.md
records two automatic matchers (the demo scorer wiring Mirror to a neuron table; `resolveColumn`
rule 3) that picked a plausible wrong candidate with nothing to say so. Several selected cards
attach nothing: pairing them to slots by order and fit is a second guess of the same kind.

**The first slot that fits takes it, slots the recipe reads from first** (`first()` in
`insertRecipe`), unless a wire was dropped from an input, which asks what the recipe feeds.
Without the ordering, selecting a dataset for a find-then-filter recipe tried the slot that *fed*
a Table viewer and hung the filter's output on the dataset's table-typed
`annotations` input. That is a legal wire, and not what anybody meant.
`core/recipes.test.ts` "prefers the slot the recipe reads from" pins it.

**All or nothing per slot.** A half-attached annotation chain would have its references wired and
its output refused, because the dataset's `annotations` port was already taken. It reads the
datastack and feeds nothing, under cards that all look configured. Either every wire of the slot
fits, or none is made and the reasons come back in `refusals` for the status bar.

**An input already wired is never taken.** `addEdge` evicts whatever feeds a port, so wiring into
one would be an attach silently stealing an input. That is the same rule `subgraphOf` follows for
a copy.

Each wire is checked with `checkConnection` against a **fresh inference** of the graph as it
stands, incoming wires first. A passthrough's output type is its input's, so an outgoing wire only
checks once the incoming ones are in. The assistant's plan applier makes the same call for the
same reason. Cost: one `inferGraph` per wire tried, milliseconds, on a gesture.

The whole insertion is one `commit`, so it is one undo step. It arrives selected, and the store
says in `notice` what it attached to, or why the selection took no slot.

## The frame, and why the name is stored twice

`recipeFrom` puts a frame titled with the recipe's name **into the fragment**, so what arrives is
visibly one thing and ⇧⌘G takes it apart. It arrives framed by *either* way in, insert or ⌘V of
the file. It was first added at insert time, which left the file path unframed. Two exceptions:
- A selection that carries frames of its own is not wrapped. Groups do not nest, and `createGroup` would pull its cards out of their frames.
- A single card is not wrapped: a frame around it hides nothing (`foldChain`'s rule).

That makes the name two copies of one fact: `Recipe.name` and the frame's title. **A rename
writes both**, through `renamedRecipeText`, which retitles every frame whose title equals the old
name. That includes a frame of the user's own that the recipe was named after, which is the same
box by the same name, so the same rename. An imported recipe given a free name goes through the
same function, and is then stored **as text** (`saveRecipeText`). It first went through a read
recipe and `saveRecipe`, which re-serialised what `readRecipe` had healed, and so lost exactly the
cards the rename rule below exists to keep.

**A rename edits the stored text, never a read recipe.** `readRecipe` heals what it reads, and a
card from a newer build is *dropped*. Writing that back would make a rename in an older tab delete
the card for the build that knows it. `core/recipes.test.ts` "keeps a card this build does not
know" pins it.

## Parameters are kept, and a card can be reset

The configuration is usually why a set was worth saving, so params are kept verbatim.
`RecipeOptions.reset` names cards whose params go back to `defaultParams` for values that belong
to the workflow rather than the recipe: an id list, a file name. The dialog offers this per card,
all unticked, under a collapsed "Reset parameters to their defaults". A reset touches params only;
a title somebody typed is not configuration.

## The shelf

`store/recipes.ts`, and the workflow library's rules for the workflow library's reasons
(`persistence.md`):
- IndexedDB, not `localStorage`.
- **Writes reject, reads resolve.**
- No in-memory fallback.
- Summaries are kept apart from the text, so listing the shelf parses no recipe.
- Identity is the normalised name.

Two things are its own.

**Its own database, `coda-recipes`**, not a third store in `coda-library`, which was proposed and
refused. Two modules opening one database with different version numbers race on the upgrade.
`data/idb.ts` records that as the reason each module keeps its own.

**`store/shelf.ts` holds what the two shelves share**: `normalizeName`, `findByName`,
`newestFirst`, and `freeName` for an arrival nobody confirmed. A generic shelf module owning the
two-store transactions as well was considered and deferred; `library.ts` and `recipes.ts` are
still near-copies there.

`RecipeSummary.reads`/`feeds` are the sockets a wire can attach the recipe by (`recipeSockets`),
so the palette a dropped wire opens can filter without reading one recipe. They are **declared**
sockets, not inferred ones: nothing is inferred on a fragment without its inputs. That makes them
a filter rather than a promise. A declared `any` passes anything, which is `socketAccepts`' rule,
and the attach is still `checkConnection`'s. The direction of a drag is **`dragReaches`**
(`core/sockets.ts`), shared with the node rows' `bestPort`. The two had each written the flip out,
and only one refused a backwards drag onto a port that cannot originate what it passes on. They
are recorded at save and not refreshed by a rename, so a port retyped in a later build filters on
the old type until the recipe is saved again.

## The surfaces

- **Saving.** The node menu (the clicked card, or the whole selection if it is in one) and the frame menu (its cards) open **Save as Recipe…** through `savingRecipe` in the store, which is `editingHint`'s arrangement and kept per document for its reason: node ids mean nothing in the next graph. The dialog shows the slots **before** the save. They are the part of a recipe nobody chose, and a card left out of the selection shows up as a slot nobody expected, which is the cheapest place to notice it. It offers the frame's title as the name when the cards are exactly one frame. A name already on the shelf turns Save into **Replace**, said before the click. Live under the lock, like Copy.
- **Inserting, from the palette.** Each recipe is an `Add ▸ Recipe ▸ name` row. It shipped for a round under a `Recipe:` prefix of its own and moved: a right-click on empty canvas opens the palette prefilled with `Add:`, which is exactly where somebody looks for something to put down, and the prefix hid recipes there. Saving and managing are `Edit` rows. A picked recipe lands at **`CommandContext.insertPoint`**, where the palette was opened (the point node rows use), not at `pastePoint`: by the time a row is picked the pointer is on the row. Palette Paste still uses `pastePoint`.
- **Inserting, from a dropped wire.** The palette a dropped wire opens lists the recipes that could take it (`recipeTakesWire`, over the summary's sockets), and a pick attaches through the dragged port of the node the wire came from rather than to the selection. That port is what the gesture pointed at and what the recipe was listed for.
- **Inserting, from the + menu.** A **Saved recipes** button at the top of the rail appears only once something is saved. An always-present button opening an empty band would be a way to learn the feature exists by being told there is nothing in it. Its band is the categories' band: `snakeRows` and the alignment are generic over `BandItem`, not written twice. A recipe's disc wears **its first card's** glyph and tint. That is the one drawing already in the table that says what it starts with, where a mark of its own would be a key no node resolves to. The rail button's two-cards mark is drawn in `AddMenu`, like the browser's, for that reason.
- **Managing.** `RecipesDialog`: insert, rename, delete, download, import. The rows are `ShelfRow`, extracted from the Open menu's library row so both shelves ask in place the same way. Opening is disabled under the lock; tidying the shelf is not. **Only the list scrolls**: with the body scrolling as one, twenty recipes (990px of rows in a 640px panel) pushed Import below the fold. From six recipes a filter appears, matching the name by `normalizeName`, and the panel holds its height so the centred modal does not jump while a filter narrows it. **A download is the stored text byte for byte** (`recipeFileText`), saved as `*.coda-recipe.json`. **An import lands under a free name** (`freeName`: `Search (2)`) rather than over an entry of the same name, because nobody confirmed replacing one, and is stored as the file's text (`saveRecipeText`). `freeName` does not strip a suffix it finds, so importing `Search (2)` over a taken `Search (2)` gives `Search (2) (2)`; `graphStore`'s `copyName` does strip its own, and the two are not yet one helper. A file is how a recipe leaves this browser; the shelf is per profile.

## The lock

`store/lock.test.ts` classifies every action. `insertRecipe` is **frozen**, like a paste, and
refused before it reads the shelf. `saveRecipe`, `importRecipe`, `renameRecipe`, `deleteRecipe`,
`refreshRecipes`, `openRecipeSave` and `openRecipes` are **live**: none of them touches the
canvas. Saving is Copy's argument: a frozen graph is exactly the one somebody lifts a setup out
of.

## Deliberately absent

- **Built-in recipes.** `DatasetFamily.annotationChain` is structurally a recipe with one slot, and deriving "FlyWire annotations" as a built-in was proposed and declined. The chains stay the wizard's and the starters'.
- **The assistant.** The catalogue is the cached prefix and gets facts about node *types* (`assistant.md`); a recipe is per-browser instance data. Telling the model about recipes would be a graph-listing decision, not a catalogue one, and has not been made.
- **A keyboard shortcut** for saving. It is rare, and the good chords are taken.

## What was checked in a real browser, and what was not

`pnpm dev` driven over the DevTools protocol, screenshots read back:
- the save dialog from a card's menu, with the slot list;
- the palette's recipe rows and an insert;
- Manage Recipes;
- the **+** band. Its bottom row sits level with the rail button it came out of, 458px against 458px, which is the measurement jsdom cannot take (`canvas.md`, "The **+** menu").
- the wire-drop palette listing a recipe first when dropped from Sort's output.

**Not checked in a browser:** the file picker and the download (jsdom has neither, and the probe
did not drive them), a recipe band wider than one row, and anything outside Chrome.

## Tests

Listed in `testing-layers.md`. The dataset → Find Neurons → Filter graph most of them cut from is
`findAndFilter()` in `src/test/graph.ts`.
