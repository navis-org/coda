/**
 * "Reading a card" — the annotated pair at the top of the node guide.
 *
 * ## What it is for
 *
 * Everything else on this page answers *which node do I want*. Nothing answered *what are all
 * these little buttons*, and a card carries eleven of them: a run badge, ▶, ⤢, ⇥, ?, ☰, ▾, a
 * cache clause, an edge-set button, a `… N more` line and a selection row. Each has a `title`,
 * which is a fine answer to "what is this one" and no answer at all to "what is on a card",
 * because a tooltip is only ever read by somebody who already suspected the control was there.
 *
 * So: two real cards, wired together — a neuPrint dataset feeding an Explore Dataset — with the
 * parts labelled. Two rather than one because the chrome is not the same on every card: the
 * dataset card is where an edge set and a cache age live, and ⤢/⇥/? appear only on a node that
 * has a result to open and a document to open beside it.
 *
 * ## Hand-written, like the socket legend and unlike everything else here
 *
 * `main.ts` names no node, no socket and no parameter — the grid, the detail pane and the
 * appendix are all read off the registry. This section names two, and that is the same exception
 * `LEGEND` already is: it is a *lesson* rather than an inventory. A figure generated from
 * whatever two nodes happen to sort first would draw whichever chrome those two happened to
 * carry, which is the one thing this section may not leave to chance.
 *
 * What is **not** hand-written is the run-state table: `STATE_GLYPH` and `STATE_TEXT` come out of
 * the app, in the app's own order, so a state added to the scheduler appears here rather than
 * leaving the guide short one glyph. `nodeGuide.test.ts` holds the rest to the card's source —
 * every glyph this figure draws has to appear in `CodaNodeView.tsx` with the same `title`, which
 * is the only thing standing between a renamed button and a guide that quietly describes the old
 * one.
 *
 * ## Static markup, spliced in at build time
 *
 * Same route as `appendix.ts`: `vite/nodeGuideData.ts` calls `anatomyHTML()` in Node and drops
 * the result into `nodes.html` at `<!--@node-anatomy-->`. That is not about weight — this module
 * would cost about a kilobyte in the page — but about the notes being *content*. They are the
 * paragraph that says what a Coda card is, and rendering them after load would put them in the
 * shipped file nowhere, which is the failure `appendix.ts` was written for.
 *
 * It also decides the fallback. The notes are ordinary text in the document; `nodeguide.css`
 * folds them into hover panels only once `main.ts` has claimed the layout, so a reader with no
 * script, a phone, and a crawler all get the same words laid out as a list.
 */

import { DATASET_GLYPHS, SPECIMEN_VIEWBOX, glyphMarkup } from '../ui/glyphs'
import { STATE_GLYPH, STATE_TEXT } from '../ui/nodes/runState'

/**
 * The stage's world, in px.
 *
 * The cards and the labels are placed in it by hand — the tutorial page's arrangement, and for
 * its reason: a leader line pointing at a 14px button has to be authored against a fixed
 * geometry, not composed by a layout that reflows.
 *
 * So this box never stretches. The section is as wide as the node grid below it, and the extra
 * width goes to the *canvas* around the stage (`.anat__canvas`) rather than to the stage itself:
 * widening the world would move every label away from the part it names, and an empty canvas is
 * the one thing in this figure that still means something when there is nothing on it. Below
 * `nodeguide.css`'s own breakpoint the whole arrangement stands down to a list rather than
 * scaling, because scaling a 10.5px label is how a figure about small controls becomes
 * unreadable.
 */
export const STAGE_W = 940
export const STAGE_H = 552

/** Where a note opens from its label. */
type NoteSide = 'up' | 'down'

interface Callout {
  /** Matches `data-anat` on the element being pointed at. */
  id: string
  /** The label on the stage. Two or three words — the sentence is in `note`. */
  label: string
  /** What it does, in one or two sentences. Shown on hover, and always in the list layout. */
  note: string
  /** Extra markup under the note — only the run-state table uses it. */
  extra?: string
  /** Top-left of the label, in stage px. */
  x: number
  y: number
  /** Label width, in stage px. */
  w: number
  /** Which way the label's text runs, which is also which side of it the leader leaves from. */
  align: 'left' | 'right' | 'center'
  /** Which way the hover panel opens. Authored, since only this file knows what is below. */
  noteSide: NoteSide
  /** A rectangle round the part, or a dot on it — the wire is the only thing that wants a dot. */
  mark?: 'box' | 'point'
}

/**
 * Every run state, drawn as the card draws it.
 *
 * In `STATE_GLYPH`'s own order rather than one chosen here: a second ordering is a second thing
 * to keep in step, and the table's order is already the one the scheduler reads best in. `idle`
 * draws an empty disc, which is exactly what the card draws — the state's whole point is that it
 * is the absence of a mark.
 */
function stateTable(): string {
  const rows = Object.entries(STATE_GLYPH)
    .map(
      ([state, glyph]) =>
        `<div class="anat__state"><i class="state-badge" data-state="${state}">${glyph}</i>` +
        `<span>${STATE_TEXT[state as keyof typeof STATE_TEXT]}</span></div>`,
    )
    .join('')
  return `<div class="anat__states">${rows}</div>`
}

/**
 * The eighteen labelled parts.
 *
 * Ordered as somebody reads a card — its header first, then what it takes and hands on, then its
 * settings, then what it says about the last run — because that order is also the list the narrow
 * layout falls back to, where nothing is pointing at anything.
 *
 * The coordinates are the fiddly half and were adjusted against a browser, not reasoned about:
 * `pnpm probe:node-anatomy` is what says whether a leader crosses a card or a box has drifted off
 * the button it names.
 */
const CALLOUTS: readonly Callout[] = [
  // --- the dataset card's header -------------------------------------------
  {
    id: 'state',
    label: 'Run state',
    note: 'Whether the card’s result is current. A glyph as well as a colour, so it reads without telling the hues apart; the stripe down the left edge repeats it.',
    extra: stateTable(),
    x: 0,
    y: 184,
    w: 104,
    align: 'right',
    noteSide: 'down',
  },
  {
    id: 'title',
    label: 'The node’s name',
    note: 'Double-click to rename. The name is saved with the workflow; the node’s type underneath it does not change.',
    x: 8,
    y: 120,
    w: 130,
    align: 'center',
    noteSide: 'up',
  },
  {
    id: 'fold',
    label: 'Hide settings and ports',
    note: 'Folds the settings and socket rows away, giving the space to what the card draws. Wires stay connected — the sockets move onto the header.',
    x: 150,
    y: 136,
    w: 130,
    align: 'center',
    noteSide: 'up',
  },
  {
    id: 'collapse',
    label: 'Collapse',
    note: 'Folds the whole card down to its header. Unlike ☰, nothing below the header is kept.',
    x: 236,
    y: 90,
    w: 110,
    align: 'center',
    noteSide: 'down',
  },
  {
    id: 'tint',
    label: 'Category and state colour',
    note: 'The header is the node’s category — green dataset, blue query. The stripe down the left edge is the run state, readable at a zoom where the badge is not.',
    x: 0,
    y: 280,
    w: 104,
    align: 'right',
    noteSide: 'down',
  },

  // --- the dataset card's body and foot ------------------------------------
  {
    id: 'edges',
    label: 'Bring your own edges',
    note: 'Attaches a user-supplied edge list of pre, post, weight. Connectivity below this card is then answered from the file rather than the server.',
    x: 44,
    y: 508,
    w: 152,
    align: 'center',
    noteSide: 'up',
  },
  {
    id: 'cache',
    label: 'How old the data is',
    note: 'The age of this dataset’s downloaded neuron table, which is kept for a month. Click to drop it and fetch again.',
    x: 226,
    y: 508,
    w: 144,
    align: 'center',
    noteSide: 'up',
  },
  {
    id: 'issue',
    label: 'Warnings and errors',
    note: 'What the node reports about itself. Amber warns and the result stands; red means there is no result. The inspector lists the rest.',
    x: 366,
    y: 446,
    w: 104,
    align: 'left',
    noteSide: 'up',
  },

  // --- the wire ------------------------------------------------------------
  {
    id: 'wire',
    label: 'The wire',
    note: 'Colour, shape and the socket label all give the type — here, a Dataset. A wire only connects sockets whose types match; dragging one dims the rest.',
    x: 380,
    y: 262,
    w: 92,
    align: 'left',
    noteSide: 'down',
    mark: 'point',
  },

  // --- the Explore card's header -------------------------------------------
  {
    id: 'run',
    label: 'Run this node',
    note: 'Runs this node and any stale nodes above it, not the whole graph. Disabled when the result is current, and ■ while a run is going.',
    x: 486,
    y: 26,
    w: 112,
    align: 'center',
    noteSide: 'down',
  },
  {
    id: 'expand',
    label: 'Open full size',
    note: 'Opens the result full size over the canvas. Double-clicking the drawing on the card does the same.',
    x: 606,
    y: 26,
    w: 106,
    align: 'center',
    noteSide: 'down',
  },
  {
    id: 'pin',
    label: 'Pin beside the canvas',
    note: 'Docks the result beside the canvas, where it stays while you work on other cards. One node at a time.',
    x: 714,
    y: 26,
    w: 118,
    align: 'center',
    noteSide: 'down',
  },
  {
    id: 'help',
    label: 'Show help',
    note: 'Opens this node’s help document. Present only on node types that have one written.',
    x: 836,
    y: 26,
    w: 76,
    align: 'center',
    noteSide: 'down',
  },

  // --- the Explore card's ports and settings -------------------------------
  {
    id: 'in',
    label: 'Input socket',
    note: 'Typed for the value it accepts. A required input left unwired is why a card reports that it has nothing to work on.',
    x: 328,
    y: 148,
    w: 116,
    align: 'right',
    noteSide: 'down',
  },
  {
    id: 'out',
    label: 'Output sockets',
    note: 'Which one the wire leaves from decides what the rest of the graph sees. Hover a socket to preview the value on it.',
    x: 800,
    y: 152,
    w: 140,
    align: 'left',
    noteSide: 'down',
  },
  {
    id: 'more',
    label: 'Additional hidden settings',
    note: 'Settings that live in the inspector rather than on the card. Click to select the node and open it; any that have been changed are counted.',
    x: 800,
    y: 240,
    w: 140,
    align: 'left',
    noteSide: 'down',
  },
  {
    id: 'selection',
    label: 'Picking neurons',
    note: '+ page selects this page and + all every match; the count clears the selection. It leaves by the Selected port and is saved with the workflow.',
    x: 800,
    y: 386,
    w: 140,
    align: 'left',
    noteSide: 'up',
  },
  {
    id: 'footer',
    label: 'The last result',
    note: 'The value this node produced, in the shape the rest of the graph sees it, plus the duration of the run that made it.',
    x: 800,
    y: 454,
    w: 140,
    align: 'left',
    noteSide: 'up',
  },
]

// ---------------------------------------------------------------------------
// The two cards
// ---------------------------------------------------------------------------

/**
 * The card's chrome, spelled the way `CodaNodeView` spells it.
 *
 * A button rather than a span, because these are buttons on the real card and a reader tabbing
 * through the figure should meet them in the same order. They do nothing — `disabled` says so
 * once, here, rather than eighteen times in the markup below.
 */
function chrome(anat: string, glyph: string, title: string, bare = false): string {
  return (
    `<button type="button" class="node__btn${bare ? ' node__btn--bare' : ''}" disabled ` +
    `data-anat="${anat}" title="${title}">${glyph}</button>`
  )
}

/**
 * A socket, on the card's edge rather than inside it.
 *
 * `.sock` is the preview card's own class, so the shape table is shared with the detail pane
 * below and neither can drift from `theme.css`'s socket colours.
 */
function sock(dir: 'in' | 'out', family: string, shape: string, end?: 'from' | 'to'): string {
  const tag = end ? ` data-wire="${end}"` : ''
  return `<i class="sock sock--${dir}" data-fam="${family}" data-shape="${shape}"${tag}></i>`
}

/**
 * The dataset card: a neuPrint node pointed at male-CNS.
 *
 * Male CNS rather than a generic one because the two things only a dataset card has — an edge
 * set and a cache age — are only interesting on a card that reaches a server. The numbers are
 * plausible rather than fetched: this is a picture of a card, and a figure that had to be run to
 * be right is a figure that goes stale in a way nobody notices.
 */
function datasetCard(): string {
  const art = glyphMarkup(DATASET_GLYPHS.fly_cns)
  return `<div class="node anat__card" data-cat="dataset" data-anat-card="dataset"
    style="--x:118px; --y:188px; --w:236px">
    <i class="node__bar" data-state="ok" data-anat="tint"></i>
    <div class="node__head">
      <i class="state-badge" data-state="ok" data-anat="state" title="up to date">${STATE_GLYPH.ok}</i>
      <span class="node__title" data-anat="title" title="Male CNS — dataset.neuprint">Male CNS</span>
      ${chrome('ds-run', '&#9654;', 'Already up to date')}
      ${chrome('fold', '&#9776;', 'Hide the parameters and ports, giving the space to what is below them', true)}
      ${chrome('collapse', '&#9662;', 'Collapse', true)}
    </div>
    <div class="node__ports">
      <div class="port">
        <span class="port__in"></span>
        <span class="port__out">Dataset${sock('out', 'dataset', 'square', 'from')}</span>
      </div>
    </div>
    <div class="node__more">&#8230; 3 more</div>
    <div class="ds">
      <div class="ds__art">
        <svg viewBox="${SPECIMEN_VIEWBOX}" fill="none" stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${art}</svg>
        <span class="ds__caption">v0.9 &middot; 4 versions</span>
      </div>
      <div class="prow"><span>Version</span><b class="is-picker">Latest</b></div>
      <div class="ds__pop">Using Superclass only</div>
      <div class="ds__foot">
        <span class="ds__id">male-cns:v0.9</span>
        <button type="button" class="ds__btn" disabled data-anat="edges"
          title="Attach a user-supplied edge list">&#8644; Edge data</button>
        <button type="button" class="ds__btn ds__btn--icon" disabled
          title="Re-fetch this dataset's metadata">&#10227;</button>
      </div>
    </div>
    <div class="node__issue" data-severity="warning" data-anat="issue">
      male-cns:v0.9 publishes no column for &ldquo;Superclass&rdquo;, so only the other filters
      apply here.
    </div>
    <div class="node__foot">
      <span>Dataset male-cns:v0.9</span>
      <button type="button" class="node__cache" disabled data-anat="cache"
        title="Data read 3d ago — click to fetch it again">cached 3d ago &#10227;</button>
    </div>
  </div>`
}

/** One row of the neuron list, which is what Explore draws instead of a preview. */
function neuronRow(
  type: string,
  id: string,
  sub: string,
  post: string,
  ticked: boolean,
): string {
  return `<div class="ex__row">
    <i class="ex__tick"${ticked ? ' data-on="1"' : ''}></i>
    <svg class="ex__thumb" viewBox="0 0 30 24" fill="none" stroke="currentColor"
      stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 21 C 10 16 11 12 13 8 M13 8 C 15 5 18 4 21 3 M13 8 C 12 6 10 5 8 4
        M13 8 C 16 9 19 9 23 8 M13 8 C 13 11 15 14 18 16 M18 16 C 20 17 22 17 24 16" />
      <circle cx="6" cy="21" r="1.6" fill="currentColor" stroke="none" />
    </svg>
    <span class="ex__name"><b>${type}</b> <span class="ex__id">${id}</span>
      <span class="ex__sub">${sub}</span></span>
    <span class="ex__num"><b>${post}</b><span>post</span></span>
  </div>`
}

/**
 * The Explore Dataset card.
 *
 * Drawn at 320px where the real one is 520 — the one place this figure is not to scale, and the
 * same licence the preview card in the detail pane takes. Everything a callout points at is on
 * it; a 520px card would have pushed the right-hand labels off the stage to show four columns of
 * numbers nobody is being told anything about.
 */
function exploreCard(): string {
  return `<div class="node anat__card" data-cat="query" data-anat-card="explore"
    style="--x:470px; --y:128px; --w:320px">
    <i class="node__bar" data-state="stale"></i>
    <div class="node__head">
      <i class="state-badge" data-state="stale" title="needs run">${STATE_GLYPH.stale}</i>
      <span class="node__title" title="Explore Dataset — neuron.explore">Explore Dataset</span>
      ${chrome('run', '&#9654;', 'Run this node and everything it needs')}
      ${chrome('expand', '&#10530;', 'Open this result full size')}
      ${chrome('pin', '&#8677;', 'Pin this result to the side of the canvas')}
      ${chrome('help', '?', 'What Explore Dataset does, and what it assumes', true)}
      ${chrome('ex-fold', '&#9776;', 'Hide the parameters and ports, giving the space to what is below them', true)}
      ${chrome('ex-collapse', '&#9662;', 'Collapse', true)}
    </div>
    <div class="node__ports">
      <div class="port">
        <span class="port__in">Dataset${sock('in', 'dataset', 'square', 'to')}</span>
        <span class="port__out">Hits${sock('out', 'table', 'circle')}</span>
      </div>
      <div class="port">
        <span class="port__in"></span>
        <span class="port__out">Selected${sock('out', 'table', 'circle')}</span>
      </div>
      <div class="port">
        <span class="port__in"></span>
        <span class="port__out">All${sock('out', 'table', 'circle')}</span>
      </div>
      <i class="port__group port__group--in" data-anat="in"></i>
      <i class="port__group" data-anat="out"></i>
    </div>
    <div class="node__more" data-anat="more">&#8230; 4 more</div>
    <div class="ex">
      <div class="ex__search"><span>Search neurons&#8230;</span><i>&#10227;</i></div>
      ${neuronRow('LC4', '1047576697', 'LC4_R &middot; Traced', '276', true)}
      ${neuronRow('LC4', '1047576860', 'LC4_R &middot; Traced', '304', true)}
      ${neuronRow('LPLC2', '1047577691', 'LPLC2_L &middot; Traced', '377', false)}
      <div class="ex__foot" data-anat="selection">
        <span class="ex__count">401 neurons</span>
        <button type="button" class="ex__link" disabled>43 selected &#10005;</button>
        <button type="button" class="ex__link" disabled>+ page</button>
        <button type="button" class="ex__link" disabled>+ all</button>
        <span class="ex__pager">&#8249; 1 / 17 &#8250;</span>
      </div>
    </div>
    <div class="node__foot" data-anat="footer">
      <span>401 rows &times; 7 col</span>
      <span class="node__timing">50ms</span>
    </div>
  </div>`
}

/**
 * The wire between them — an empty path, filled in by `anatomyStage.ts`.
 *
 * The cubic it draws is React Flow's shape, because a straight line between two sockets is the
 * one thing on this figure that would not look like the canvas. Its two ends are *measured* from
 * the sockets they leave, for the reason every box here is measured: a `d` written out beside a
 * card is a `d` that comes adrift the first time the card grows a row, and it comes adrift
 * silently — a wire ending an inch under its socket still looks like a wire.
 *
 * It is `data-anat`'d like any other part, and takes a dot rather than a rectangle: a box round a
 * diagonal is a box round mostly nothing.
 */
function wire(): string {
  return `<svg class="anat__wire" viewBox="0 0 ${STAGE_W} ${STAGE_H}" aria-hidden="true">
    <path data-anat="wire" data-fam="dataset" d="" />
  </svg>`
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/**
 * How wide a hover panel is, and the only reason this file knows: which end of the label it
 * hangs from has to be decided where the label's own x is known.
 *
 * A panel is `visibility: hidden` until it opens, which still takes part in layout — so one
 * hanging off the right of a right-hand label makes the *document* wider than the viewport at
 * every width, silently, and the page acquires a sideways scrollbar nobody can trace to
 * anything visible. It must be kept inside the stage rather than positioned on the way out.
 */
const NOTE_W = 252

function calloutHTML(c: Callout, index: number): string {
  const id = `anat-note-${c.id}`
  const notex = c.x + NOTE_W > STAGE_W ? 'r' : 'l'
  return `<li class="anat__item" data-for="${c.id}" data-align="${c.align}"
      data-note="${c.noteSide}" data-notex="${notex}" data-mark="${c.mark ?? 'box'}"
      style="--x:${c.x}px; --y:${c.y}px; --w:${c.w}px">
      <button type="button" class="anat__label" aria-describedby="${id}">
        <span class="anat__n">${index + 1}</span>${c.label}
      </button>
      <div class="anat__note" id="${id}" role="tooltip">
        <p>${c.note}</p>${c.extra ?? ''}
      </div>
      <i class="anat__box" aria-hidden="true"></i>
    </li>`
}

/**
 * The whole section, as the markup that replaces `<!--@node-anatomy-->` in `nodes.html`.
 *
 * The order of the three blocks is the order they are read in when nothing is positioned: the
 * lede, the two cards, then the parts as a numbered list. That is also the fallback layout, which
 * is why the list comes last rather than being interleaved with the cards it points at.
 *
 * **Two boxes round them, because two things want different widths.** `anat__canvas` is the
 * page's own column — the same width as the node grid below, so the section shares the
 * document's left and right edge rather than sitting in a narrower one of its own.
 * `anat__stage` inside it is the fixed px world every label is placed in, centred there and
 * never stretched: `--x` and `--y` are authored against exactly this box, so widening it would
 * move every label away from the part it names. The extra width goes to the canvas, which is
 * the one part of this figure that means something when it is empty.
 */
export function anatomyHTML(): string {
  return `<section class="anat" id="anatomy" aria-labelledby="anatomy-h">
    <div class="shell">
      <h2 class="anat__h" id="anatomy-h">Reading a card</h2>
      <p class="anat__lede">
        The legend below illustrates the most important elements you will find on a node.<br>
        Hover a label to see a short description.
      </p>
      <div class="anat__canvas">
        <div class="anat__stage" style="--stage-w:${STAGE_W}px; --stage-h:${STAGE_H}px">
          <div class="anat__cards">
            ${datasetCard()}
            ${exploreCard()}
            ${wire()}
          </div>
          <svg class="anat__leads" viewBox="0 0 ${STAGE_W} ${STAGE_H}" aria-hidden="true"></svg>
          <ol class="anat__marks">
            ${CALLOUTS.map(calloutHTML).join('\n            ')}
          </ol>
        </div>
      </div>
    </div>
  </section>`
}

/** The callout table, for the test that checks each one points at something. */
export const ANATOMY_PARTS: readonly string[] = CALLOUTS.map((c) => c.id)
