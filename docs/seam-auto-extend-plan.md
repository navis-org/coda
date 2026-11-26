# Auto-extend — a piece extended until nothing clears the cutoff

Status: **built 2026-11-18, experimental.** Checked in Chrome the same day (reads only, below);
whether what it accepts is right is not measured yet. Follows [seam-extend-plan.md](seam-extend-plan.md), whose Extend is the one step
this repeats.

The ask (user, 2026-11-18): the Extend button gets a menu, like Reject's, with a second choice. It
searches the piece, accepts every candidate above the cutoff, and extends those the same way. It
stops when nothing clears the cutoff, or more than ten layers out.

## Decisions (user, 2026-11-18)

| Question | Decision |
| --- | --- |
| Names | The menu item is **Auto-extend**. The old toggle `Auto-extend` (extend a piece as you accept it) became **Extend on accept**, param `extendOnAccept`, `formerId: 'autoExtend'`. |
| The cutoff | **SEAM's own**: the tip's `shown`, read only as an explicit `true`. A search with no assessor publishes no `shown`, so Auto-extend is greyed out there (`autoUnavailable`). |
| Which candidates at an end | **The first only**, if it clears. The second at an end is usually the alternative to the first. |
| Where the recursion runs | **In Find Merge Candidates, with the card working out the same tree.** One press is one param edit and one undo step. The automatic accepts are never written. |
| A large candidate (41+ chunks) | **Not accepted.** |
| The ten layers | **Counted from the piece it was pressed on.** Layer ten is accepted and not searched, and keeps an Extend button. A press nested inside another's tree starts its own count. |
| Submit | **Merges them.** The confirm dialog tags them `auto`, counts them, and they can be unticked there. |

Also not accepted: an organelle-flagged first candidate (read through `searchCell`, the tables'
own cut), an id that is not a chunkedgraph id, a seed, a piece the reader extended by hand, a piece
already in the tree, and any pair it could take that the reader gave a verdict other than accept.

## The design

**One rule, two readers.** `autoTakes` (in `pieces.ts`) decides whether an end's first candidate is
taken: `shown === true`, not an organelle, under `LARGE_PIECE_CHUNKS`, a real id. `growAuto` grows
the tree from it. The search applies it to the ends in its run book (`firstsOf`). The card
applies it to the published rows (`autoFirsts`): the tip's `shown`, and the rank-1 candidate's
`organelle` and `n_l2`. Both see the same numbers, so both grow the same tree. No column was
added to `Tips`.

**`growAuto` works in rounds and only adds.** It starts from the pairs extended by hand. In each
round, every searched piece below an Auto-extend press, and fewer than `AUTO_DEPTH` layers below
it, offers its first candidates. A candidate already in the tree, or extended by hand, is never
taken, so no piece is taken twice and the rounds always end. (A piece the reader extended beyond
one Auto-extend took can move nearer the seed once that one is placed; the run book searches it
again there.) When two pieces in one round offer the same candidate, it
goes to the one nearer the seed, then to the lower id (`piecesOf`'s rule). The result depends only
on the pairs and on what the ends say, never on the order of clicks.

**What Review tells the search.** `Extended` (and the reference that reads it) gained a `mode`
column: `extend`, `auto` (a pair the reader pressed Auto-extend on), and `refused`. A Reject of a
piece Auto-extend took has to reach the search, but the params cannot say which pieces those are.
**The press can**: a verdict other than accept on a pair Auto-extend could take (`autoOffered`,
the same rule over the rows) is written into a third param, `autoRefused`, in the same edit
(`judgedParams`); accepting or clearing takes it out. Choosing Auto-extend also writes down the
earlier refusals it could now take (`extendParams`), since a reject given before an assessor ran
was not one it could take then. **The `refused` rows are those, sent only while an Auto-extend is
live.** So a Reject of anything else moves no key and retires no search in flight; the first
version sent every non-accept verdict, and the second review round found each unrelated Reject
restarting a 200-second run. A table without `mode` reads as all `extend`.

**Params.** `autoRoots` holds the pressed pairs, `autoRefused` the refusals above. Each is also in `extend`, so "is it extended" is
still one param. `judgedParams` takes a press out of `autoRoots` when it takes the pair out of
`extend`. `extendParams` writes a menu choice. Extending a piece Auto-extend took also writes its
accept as the reader's, since `extend` counts only a pair the reader accepted.

**The search** (`suggestMerges.ts`, `grow`). The three passes over pieces became calls to one
`grow`: the memory pass and the ahead pass for one neuron at a time, the last pass for all of them.
`grow` recomputes `growAuto` from the book, hands the book the new order (`RunBook.reorder`),
settles every piece, and repeats until the order stops changing. **Every round starts afresh from
the book**, never added to: a piece taken early has draft ends, and what Auto-extend took from
them may not stand. The last call, made once every end is in, grows the tree a plain run grows.
`reorder` drops the record of a piece whose path moved, and so of the pieces beyond it, since
their ends were searched with another path read as the neuron (`aliasOf`, compared by
`pathKey`). It asks again where a parent's pieces join it only for a parent whose pieces changed:
that is a walk of every end of the parent. The loop is capped at
`MAX_GROW_ROUNDS` (100), and says so if it ever stops there.

**One derivation of what is accepted** (`reviewQueue.ts`): `planTexts` (the plan as three texts
of sorted keys, the refusals empty while no Auto-extend is live), `planOfTexts`, `reviewGrowth`,
and `autoJudged`, which returns the verdicts everything reads and `unjudged`, the accepts that are
Auto-extend's alone. `reviewStateOf` makes the four calls for Review's `evaluate` and for
Submit's plan (`mergeSession.ts`). The card makes the same calls one memo at a time, so a press
that changes none of the texts rebuilds no tree. `Tips` and `Verdicts` carry the reader's word
alone, and "judged" counts it. How a row's piece is extended (the reader's choice, or held by a
press further up) is `rowExtend`. An `auto` row has a dashed `auto` tag, and its Extend button
shows progress and cannot be pressed; a row on the last layer offers Extend.

**The button.** `ExtendButtons.tsx` is a split button: the face does what it did, and the ▾ offers
Extend and Auto-extend as radio items, with the reader's own choice ticked. Pressing the ticked
item stops extending, as pressing a row's own verdict takes it back. The menu mechanics are
`splitMenu.tsx` (`useSplitMenu`, `SplitMenu`), shared with `VerdictButtons.tsx`.

**Help improve** (user, 2026-11-18). A piece Auto-extend accepted is never sent as `accept`: that
would feed SEAM its own pick as a reader's verdict. When Submit merges one the reader never judged,
it is sent as `auto-accepted` (`mergeSession.ts`, `PlannedMerge.auto`); a reader's press on it is
sent as any press is. See `docs/seam-verdict-log-plan.md`.

**In Neuroglancer** (user, 2026-11-18). A piece taken showed in the list before the Neuroglancer
node: it arrives with the tips of the piece it was taken on, so `Layers`' points change in the same
update, and an update that is more than a selection waited for the pointer to leave the frame and
for the search to stop publishing. Coda's frame now sets a local annotation layer's points in
place as well as the segments (`inPlaceChanges`, see
[viewers-neuroglancer.md](viewers-neuroglancer.md)), so the whole update applies at once, under the
pointer, with nothing rebuilt.

## Auto-extend listed (user, 2026-11-19)

The ask: a button that adds every visible piece above the cutoff to the Auto-extend queue, unless
it is rejected. Decisions: **what it accepts is Auto-extend's, not the reader's** (tagged `auto`,
sent to SEAM as `auto-accepted` if merged), and **any verdict other than accept** keeps a row out,
the rule Auto-extend keeps further out.

**Which rows** (`listedAutoPairs`): the rows `arrangeTree` lists through the filters, scrolled
into view or not, that show their tip's first candidate where Auto-extend would take it
(`autoOffered`), less the turned-down, a piece in the neuron already by another road
(`acceptedElsewhere`), and **a piece extended already**, by hand or by Auto-extend (`rowExtend`) —
the first /code-review found the button turning a hand Extend into an Auto-extend, on the one
kind of row a filter cannot hide (`arrangeTree` always lists a row hosting an extended piece). Past that, **the row's own Auto-extend item decides** (`extendMenu`): a row
whose item is greyed out (blocked, held by a press further up) or would stop one is left out, so a
new reason to grey the item out reaches the button too. A piece two rows offer goes to one parent
by `growAuto`'s rule (`nearerClaim`, shared). Why a piece is blocked is one callback on the card
(`blockedOf`), read by the rows and the button.

**What it writes** (`listedAutoParams`): what `extendParams` writes for one Auto-extend press, for
each pair — the pair in `extend` and `autoRoots`, and the refusals it could now take
(`refusalsBefore`, shared) — **but no verdict**. One `setParams`, one undo step, then a run of the
search.

**A press with no verdict is the button's accept** (`extendedKeys`, `PlanTexts.taken`). Every other
writer of `autoRoots` writes an accept with it (the menu is on accepted rows only, and
`extendParams` writes the accept of a pair Auto-extend took), and a verdict press or a stop changes
the state: a verdict stores one, and Reject, Ends, Unsure, clearing and a stop take the pair out of
`autoRoots`. So no param says which presses the button made: a first version kept one,
`autoTaken`, and the /simplify pass found it derivable. `extendedKeys` counts such a pair as
extended, and `autoJudged` adds it to `unjudged`, each to itself, which tags the row `auto`, counts
it, and marks the merge `auto` at Submit. Writing the reader's accept instead would send SEAM its
own pick back as a reader's. **The search is told nothing new**: to it these are Auto-extend
presses like any other, so `suggestMerges.ts` did not change.

**How a taken pair stops being Auto-extend's.** Accept makes it the reader's, and the press stays.
Any other verdict takes the press out with the pair. Stopping its Auto-extend (`off`) leaves it
with no verdict and no press, so not accepted; `Extend` from the menu writes the reader's accept,
as it does for any unjudged pair.

## Auto-extend min q (user, 2026-11-19)

The reader's own floor on `q`, over SEAM's cutoff: `autoTakes(first, minQ)` takes a first candidate
only where it is `shown` **and** `q >= minQ`, so the floor can raise the bar and never lower it (a
candidate with no `q` is not taken under a floor). One param on the card, `autoMinQ` — text, as
`Min confidence` is, empty being SEAM's cutoff alone (`autoMinQOf`) — and one rule on both sides:

- **The search** is told it in `Extended`'s `auto_min_q` column, the same on every row
  (`ExtendPlan.autoMinQ`, `extendPlanOf`), and applies it in `firstsOf`.
- **The card** grows its tree by the plan's (`reviewGrowth` → `autoFirsts(queue, plan.autoMinQ)`),
  so the two trees cannot disagree, and reads the param itself for what a press *would* take
  (`autoOffered(queue, minQ)`): the refusals it writes down, the menu, `Auto-extend listed`.
- **Sent only while an Auto-extend is live** (`PlanTexts.minQ`), as the refusals are: setting it with
  none pressed re-keys no search. Changing it under a live one re-runs the search, and the tree is
  grown afresh by the new rule; pieces it no longer takes leave with what lies beyond them.

Not checked at the node: no test drives the search's own Auto-extend (none did before either); the
plan's round trip and the card's growth are tested, and the search's change is the one call.

## Where a chain stopped on a large piece (user, 2026-11-21)

A chain that reaches a candidate of 41 chunks or more stops there, and that is usually a false
merge — in the large piece, or in a piece earlier in the chain that has led it into another
neuron. The row used to say nothing; now it carries a `!` in `--status-warn`, and a sentence on
hover with the piece's size, its `q`, the limit and what to look at (`autoStoppedNote`).

- **Which rows** is `autoStoppedLarge(queue, growth, plan)`: a tip of a piece Auto-extend reads
  (`AutoGrowth.autoRead` — under a press, fewer than `AUTO_DEPTH` layers down, as `growAuto`
  itself reports) whose first candidate is turned down **for its size alone** (`autoTooLarge`, which is `autoTakes` with
  the size left out, so the two cannot drift). An organelle, or a candidate under the cutoff or
  the reader's floor, would have stopped the chain anyway and is not marked.
- **By tip, not by pair** (`tipKey` → the piece and its size): the stop is one end's first
  candidate, so another end listing the same piece lower down — or a rank-2 row per candidate —
  is not marked, and the note's `q` is the stopped end's.
- **Not marked:** a large candidate on a piece extended by hand outside any press (nothing was
  going to take it); one `growAuto` passes over whatever its size — a seed, a piece extended by
  hand, one already in the tree; and a pair the reader turned down (`ExtendPlan.refused`: they
  have looked). An accept of it keeps the mark: accepting merges it, and the warning is about
  exactly that.
- **A chip with a title takes the pointer back** (`.review-row__id > [title]`, checked in Chrome):
  `.review-row__id` gives the pointer up to the row's click layer, so before this no chip's title
  showed on hover — `auto`, `by hand`, `outdated` and `in this neuron` included. A click on a chip
  bubbles to the id line's own `onClick`, which picks the row; the line's text still gives the
  pointer up, so the pick never runs twice. It does not focus the row's button; left, since the
  card's keys follow `current`, never focus, and Firefox on macOS focuses no button on a click.

## Known, and left

- **The wait is not priced** for pieces Auto-extend has yet to find. `warnOverWait` counts what is
  known at the start: the pressed piece and what an earlier run kept.
- **Clear Cache reaches Auto-extend's pieces as each is reached**, not before anything is measured
  (`foreseePieces` covers the pressed pieces only). A run cancelled part way leaves the pieces it
  never reached answering from before the Clear Cache on the next run.
- **`Extended` carries the `refused` rows too** while an Auto-extend is live, told apart only by
  `mode`. The port exists to be
  wired back into Find Merge Candidates, and its table is the reference's by rule (one function for
  both). Anything else wired to it has to filter on `mode`.
- **A piece accepted on another piece but not extended can be taken again** under another parent.
  Submit merges it once (one merge per piece), but the row on the other parent reads `auto`.
  Telling the search about every accept would re-key it on every Accept.
- **A refusal is written down only where the pair could be taken when it was given, or when
  Auto-extend is chosen.** A reject of a pair that becomes takeable later still (another assessor,
  say) is not one Auto-extend knows of.
- **`firstsOf` re-reads every piece's ends each round** (no memo on the book's version): a few ms
  at a few hundred pieces.
- **Submit's Re-check grows the tree from the queue as it was at the press** (`request.queue`), as
  every Submit plans from. An Auto-extend pressed after Submit was opened is not in that plan.
- **Two quick presses on different rows can be one undo step.** The store merges edits with the
  same tag within 700 ms, and every Extend or Auto-extend press writes `extend` and `autoRoots`.
  This was already true of Extend.
- **A false merge costs more than a missed one, and Auto-extend makes it easy to send many.**
  SEAM's `r` estimates how often a `shown` first candidate is right; over ten layers the misses
  add up, and a wrong piece brings what lies beyond it. Nothing here measures that on a real
  neuron yet.

## Checked in Chrome (2026-11-18, reads only)

A scratch probe loaded the on-demand chain (Aedes, the 8 or 12 best ends by `e_tip`, assessor
`n3_mal_mask_s0`, real GPU, auto-run on). It pressed Auto-extend the way the card does
(`judgedParams`, then `extendParams`, then a run of Find Merge Candidates) and compared the card's tree
(`reviewGrowth`) with the search's `Tips`. Nothing was merged. Submit's dialog was opened, read,
and closed without pressing Merge.

| Run | Took | What it showed |
| --- | --- | --- |
| Current root `…585551219`, presses on four cleared firsts | 6.7–15.9 s each | 0 or 1 piece taken: a neuron after the 27-merge batch has little left in reach |
| The same root, a fifth (`…519781754`, q 0.24, 5 chunks) | 200 s | **23 pieces taken, eight layers deep** (1, 4, 5, 6, 3, 2, 1, 1), then nothing cleared. 68 tip rows |
| Root from before the batch `…558097460`, `…506675550` (q 0.80) | 33 s | 3 pieces, a chain three layers deep |
| Card against search, every press | — | the same pieces, parents and steps. One taken piece was searched and published no rows; its button reads `nothing to search` |
| Invalidate Results, then run | 0.55 s and 0.96 s | from memory; the tables byte for byte the same (227 kB and 505 kB) |
| Reject the first layer of the 23 | card at once; search 0.56 s when run | all 23 gone from the card on the click, and from `Tips` once the search ran; `refused` on the wire |
| Reject a candidate it could never take (after the review rounds) | — | only the verdict written; the search stayed `ok`, its key unmoved |
| The card | — | `auto` tags on the taken rows, their Extend showing progress and disabled, `auto · 1 end searched` on the pressed row; foot `24 pieces extended · 23 by Auto-extend · Submit (24)` |
| Submit's dialog | — | 24 rows, 23 marked `auto`, the head saying `23 accepted by Auto-extend`; closed with nothing sent |

**After a reject the search is `stale`, not re-run**, auto-run on or not: it is `expensive`, and a
reject is not an Extend press. The card is right on the click. The tables still hold the rejected
pieces' rows (unread) until the search next runs, as they do when Extend is switched off.

**The 23 pieces came from one press on a first candidate at q 0.24**, just above the cutoff (0.159).
Each was taken on SEAM's word alone, and Submit would have sent all 23 on one confirm.

## Not checked yet

- Whether what it takes is right. A probe against the fixture neuron (`pnpm probe:seam-extend`'s
  ground truth) would count how many Auto-extend accepts are right at each layer, and so say
  whether ten layers is too many.
- Firefox, which is where it is used.
