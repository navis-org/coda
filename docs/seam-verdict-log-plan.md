# The verdict log: review verdicts sent to the lab's server, for SEAM's calibration

**Status:** built 2026-11-18, all five phases, each reviewed (/simplify, then /code-review
medium). Two repositories: the server is `~/Github/transform_service` (`app/verdicts.py`, FastAPI
on flyem1 behind nginx at `/transform-service`; its README's "Review verdicts"), the client this
one. Deployed and checked end to end the same day: two verdicts from the card reached the server
and its export. **The server's `ends` (phase 4) has to be deployed before a Coda that sends it.**
SEAM's guide to reading the export: `~/Github/SEAM/docs/handoffs/verdict-log-from-coda.md`.

Kept under its plan's name because the code points here by it.

## Why

SEAM's `r` is fitted on tips somebody judged, and those judgements came from one-off pages SEAM
published (`rv4_check.py`: 123 tips, one person). Readers of the Review Suggestions card give the
same judgement on far more tips, and it was lost to SEAM: the verdicts lived only in each reader's
workflow. Now a reader who opts in sends each one to the lab's server, and SEAM reads them back.

## Decided (user, 2026-11-18)

1. **The reader opts in, per browser.** "Help improve" in the card's foot, off until turned on,
   kept in `localStorage` with the name and email — **never in the workflow**, so opening a
   shared workflow sends nothing for anybody. The server is not even asked what it collects until
   a reader turns it on.
2. **Coda never sends the reader's CAVE token.** The server proves the reader can read the dataset
   with a challenge — a supervoxel's root at a moment, both of its choosing — answered through the
   reader's own access. It works only for datasets the server can read too, which are the only
   ones whose training data is wanted.
3. **A name and an email, both optional**, are what the reader typed and nothing more.
4. **Sent on each press, as an append-only log.** A changed mind is a newer record; a second press
   on the same verdict sends `cleared`. **Presses only**: Ctrl+Z changes the verdicts without a
   press and sends nothing, so a misclick and its undo leave the misclick, outranked by any later
   record for the same neuron and candidate.
5. **Both kinds of review, each labelled by its source** — a published set by its version, a live
   Suggest Merges run by its models' manifests — since a single-seed `q` must never be read against
   production's cutoff or `r` (SEAM, `coda-note-sort-by-q.md`). A tip that cannot say is not sent.
6. **A fourth verdict, `ends`:** a rejection because the neuron ends at this tip, apart from
   `reject`, a wrong continuation. On the candidate shown, like the others. Reject, Ends and Unsure
   share a split button (face one press, ▾ a menu). Only `accept` merges.
7. **The foot:** a "Help improve" checkbox, a ⚙ opening a panel with the name, the email and the
   user's own sentence on what is sent, and a count — "3 sent · 1 waiting", the last problem, or
   "Not collected for …".

## The challenge

```
Coda                                   server                              chunkedgraph
 │ GET /verdicts/challenge?datastack=   │                                       │
 │ ───────────────────────────────────▶ │ pick a supervoxel, T = now            │
 │ ◀─── {challenge, sv, T, datastack}   │ sign {sv, T, datastack, nonce, exp}   │
 │ root(sv, T) ──────────────────────────────────────────────────────────────▶  │  (reader's token)
 │ POST /verdicts/session {challenge, root}                                     │
 │ ───────────────────────────────────▶ │ check signature, expiry; spend nonce  │
 │                                      │ root(sv, T) ────────────────────────▶ │  (server's token)
 │ ◀─── {session, expires}              │ sign {datastack, session id, exp}     │
 │ POST /verdicts (Bearer session)      │                                       │
 │ ───────────────────────────────────▶ │ append records                        │
```

- **The server picks the supervoxel and the moment.** The supervoxel comes from a pool per
  datastack, filled from one random chunk of the server's local segmentation (zeros dropped); the
  moment is now, in whole seconds.
- **Signed, not stored** (HMAC, `VERDICT_SECRET`), so any gunicorn worker checks it. Only the nonce
  is written, so each challenge gets one answer, right or wrong. It lapses in 5 minutes.
- **A right answer buys a session** for that datastack, 12 hours, kept in the browser.
- **Checking an answer is a chunkedgraph call under the server's credentials**, so each worker
  checks at most 30 a minute; past that a 429, before the challenge is spent. On the client a
  failed challenge rests that datastack a minute, so a reader whose answers fail does not spend
  that budget on every press.
- **What it proves:** that the poster can look up the dataset's roots, or holds a recent copy of
  its root table (which answers for every supervoxel not edited since). **Not** who they are.
- **Only a chunkedgraph that refuses anonymous lookups is worth it**, so a dataset offers verdicts
  only by a line in the server's config (`"verdicts"` among its `services`, with its `datastack`
  and `verdict_scale`). Aedes was checked: an anonymous root lookup is sent to the sign-in page.

## A record

| field | from | meaning |
|---|---|---|
| `id` | minted in the browser | a retried post is kept once (unique on the server) |
| `source` | the tip's `source` column | which `q`, cutoff and `r`: `set:<version>`, or `model:<ranker>@<digest>/<assessor>@<digest>` (`/none` with no assessor) |
| `neuron`, `piece` | the tip's `seed` and root | the neuron, and the root the tip is on (a piece accepted onto it, or the neuron) |
| `end_uid`, `kind`, `x`, `y`, `z` | the tip | the tip, in nm; the position survives a change of root |
| `candidate`, `rank` | the candidate judged | which piece, and its place in the tip's list |
| `q`, `r`, `p_tip` | the tip | the tip's numbers — about its **first** candidate, whichever is judged |
| `conf`, `shown`, `organelle` | the candidate | its own; `organelle` is `true` or null (not known), never a guessed `false` |
| `verdict` | the press | `accept`, `reject`, `ends`, `unsure`, or `cleared` |
| `at` | the browser's clock | when it was pressed |
| `searched_at` | — | always null: the card does not know the run's moment; the ids and `at` say it |
| `coda` | `__APP_VERSION__` | Coda's version |
| `name`, `email` | the reader | as typed, or null |

The server adds `datastack` (the session's, never the client's), `session` (one reader's records
together even with no name) and `received_at` (stamped under the write lock, so posts are stored in
stamp order and an export resumed from the last `received_at` misses nothing).

**A verdict is about a piece for a neuron, not about one tip.** The card stores it so and shows it
on every tip the piece is listed at, so the latest record for a `neuron` and `candidate` stands,
whichever `end_uid` it was given at — `ends` included, though a neuron ends at one tip.

## Where the code is

**Server** (`transform_service`): `app/verdicts.py` — `GET /verdicts/datastacks`, `GET
/verdicts/challenge`, `POST /verdicts/session`, `POST /verdicts` (≤ 500 records; one bad record
refuses the batch and is named by index), `GET /verdicts/export` (JSON lines, admin key). SQLite
(`VERDICTS_DB_PATH`), append-only. `open_graph` in `sparsevol_live.py` opens a chunkedgraph without
requiring the sparsevol service. Tests: `test_verdicts.py`.

**Client:**

- `src/data/verdictLog.ts` — the machinery, which does not look inside a record: sharing, the
  challenge (`rootsForSupervoxels` with `{ now }`), a session per datastack, the queue, the flush,
  and `verdictLogState` for the card (other tabs heard through the `storage` event).
  - The queue is capped at `MAX_QUEUE_CHARS` (512 k characters, ~1 MiB stored: a fifth of the
    quota the open document shares; ~800 records); past it the oldest are dropped and counted. A
    write storage refuses is said (`'storage full'`), never reported as queued.
  - A flush sends a datastack at a time. A lapsed session is renewed and the batch resent; a 422
    drops the record it names, or splits a batch it names none of; what waits for a datastack is
    dropped only when the server's own list lacks it (a proxy's 404 leaves it waiting); anything
    else leaves the queue and sets `problem`.
  - It refuses to queue for a datastack the server's list (fresh within `COLLECTED_FOR_MS`, 10
    minutes) lacks.
- `src/data/verdictServer.ts` — the address alone, so the test guard can load it without the CAVE
  client.
- `src/data/fetchText.ts` — `StatusError` (status and body); `NotFoundError` is one.
- `src/packs/seam/verdictRecord.ts` — what a SEAM verdict holds (`verdictInput`) and which are sent
  (`isSeamSource`, on the shared `set:`/`model:` prefixes); the card calls `queueVerdict`.
- `src/packs/seam/suggestionTables.ts`, `suggestions.ts`, `searchTips.ts`, `suggestMerges.ts` —
  `source` on both tips tables (phase 2):
  - Merge Suggestions fills it from the manifest's `version`, through `Field.filled` (a column the
    loader fills, which `candidateId` uses too); both exporters read the version the same way.
  - Suggest Merges writes it on every row it searched (`runSource`), keeping an incoming set's on
    the rest. The digest is the first 12 hex characters of the manifest's SHA-256
    (`LoadedManifest.digest`), because a refit keeps a model's id. Both manifests are read once,
    before the run's key is built: the memory of finished ends is keyed on each model's id and full
    digest (`modelVersion`), both models are opened from that read, and `openSeamModel` refuses
    where the worker read a different version.
- `src/packs/seam/reviewQueue.ts` — the `ends` verdict, `NOT_ACCEPT` and `faceOf`, and
  `judgedParams`' `said` (the verdict a press left), which is what is sent.
- `src/ui/seam/VerdictButtons.tsx` — the split button (its own outside-press handling, so ▾
  toggles; keyboard into the menu). `src/ui/seam/VerdictSharing.tsx` — the foot.
  `ReviewBody.tsx`'s `judge` sends — the press, never `evaluate` or the param, so the node's key
  and answer are untouched (invariant 4).
- `src/test/writeGuard.ts` — no test reaches the verdict server, as none reaches a chunkedgraph
  edit.

## Measured

- Alignment of the foot, Chrome, 2× (`scratchpad` probe, injected into the running app): the old
  checkbox-led control sat 2–2.75 px off the foot's text line; with the label's words carrying the
  baseline, 0 px.
- A record is ~620 characters as JSON (stored as UTF-16, ~1.2 KB).
- Manifest digests (hosted, 2026-11-18): ranker `d0da2c7b5fe6`, assessor `c1a615400751` — Coda's
  digest of the text equals `sha256sum` of the file for both.

## Open

- **Keeping and deleting.** An email is personal data. Who may ask for their records to be
  removed, and how (the README gives the SQL), is the user's to settle before "Help improve" is
  offered outside the lab.
- **The challenge is weaker than it first read:** a recent copy of a dataset's root table answers
  it. Acceptable for a lab tool; revisit if the server is ever opened wider.
- **An older Coda drops `ends` from a saved workflow** (its `VERDICTS` lacks it). Older builds do
  not read newer workflows anywhere else either.
