<img src="public/logo.svg" width="72" alt="">

# Coda

`Co`nnectome `d`ata `a`nalysis — Browser-based, node editor for querying and analyzing connectomic data.

> [!TIP]
> **Beta.** The core functionality is there, including support for (almost) all major connectome datasets. We're still adding features, improving the UI, and fixing bugs — but from here on we aim to keep saved workflows opening in later builds. Bug reports and feature requests are very welcome!

**Highlights**
- node-based editor for building analysis/exploration pipelines
- works with neuPrint, CAVE, CATMAID and local data
- download/export results as CSV, SWC, images, Neuroglancer URLs, etc.
- convert workflows to Python or R code to run locally
- AI assistant for generating workflows from natural language queries
- share workflows via links

## Quickstart

Just go to https://coda.science/.

Other useful links:
- ["Feature Overview"](https://coda.science/overview.html)
- ["Field Guide"](https://coda.science/tutorial.html)
- ["Node Guide"](https://coda.science/nodes.html)

Check out `?` ▶ `Guides` for in-app tutorials and `Examples` for pre-built workflows.

- add credentials to access neuPrint/CAVE/CATMAID datasets via `Connections` icon in the top toolbar
- `New` to create a new graph, either from scratch or using the Workflow Wizard/Examples/Preconfigured datastacks
- click and drag to pan, scroll to zoom
- **+** button (lower right) to add nodes or `Tab` to search for nodes
- `Space` for the command palette
- "Run" button or `⇧R` to run all stale nodes
- `I` to show/hide the inspector

## Why not just use neuPrint, Codex or CATMAID directly?

Codex and neuPrint are great for initial exploration of the datasets but if you want to do more than just look at a few neurons, you quickly hit a wall and have to start writing code. CATMAID (the oldest of these tools) has actually a lot of analysis tools, but hasn't made the transition to modern (segmentation + meshes) connectomics.

Coda is designed to fill the gap between exploration-only and full-on coding. Also: because we don't play favourites, you can combine data from multiple sources in one workflow! And if you do want to write code, Coda can help you get started by generate Python or R code from your workflow.

## Why "Coda"?

The neat acronym aside, a *coda* symbol in musical notation is a marker used for navigating through a complex piece - similar to what `Coda` does for connectomics data. Furthermore, the plural of *coda* (Italian for "tail") is *code* which is strangely fitting.

## Development

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

```bash
pnpm test         # 1143 tests
pnpm typecheck
pnpm lint
pnpm build        # static bundle in dist/
```

Requires Node ≥ 20 and pnpm. On a fresh machine: `brew install node && npm i -g pnpm`.
(Node 25+ no longer bundles corepack, so install pnpm directly.)

### Layout

```
src/
├─ core/          graph engine — headless, no React (lint-enforced)
│  ├─ types.ts        socket type system + column schemas
│  ├─ node.ts         the NodeDefinition contract
│  ├─ graph.ts        document model, topo sort, serialisation
│  ├─ inference.ts    edit-time type/schema propagation + link validation
│  └─ scheduler.ts    DAG executor, provenance-keyed cache, hybrid eval
├─ data/          DataSource interface + the mock connectome
├─ nodes/         node pack (query / table / output)
├─ store/         zustand document state, undo, persistence
├─ ui/            React Flow editor, param widgets, viewers
│  └─ panels/     command palette (+ fuzzy matcher), inspector, toolbar
└─ examples/      example graphs, built programmatically
```

`src/core` and `src/data` must stay headless — a lint rule blocks imports of React,
zustand, the store and the UI from those directories. The point is that the engine stays
unit-testable without a DOM, and reusable later by a non-React consumer (a CLI runner, or a Python-side executor consuming the same graph JSON).

### Known limitations / bugs

- **Muting blocks downstream** rather than passing input through Blender-style.
- **No virtualisation.** One DOM node per graph node, and table viewers cap rendered rows. Fine for tens of nodes; a 1000-node graph would need work. Explore Dataset pages rather than scrolling a long list for the same reason.
- **A non-default neuPrint deployment needs CORS or the dev server.** It is tried directly first; failing that, `pnpm dev` and `pnpm preview` proxy `/np/<deployment>/…` (https to public hosts only), and a static build has nothing serving that path.
- Not all nodes are currently able to emit Python or R code. The codegen is a work in progress.

## Analytics

The published site counts page views with
[GoatCounter](https://coda-science.goatcounter.com/), and **the dashboard is public** — that
link is the whole of what is collected, viewable by anybody.

No cookies, no `localStorage`, no tracker id, and no stored IP or full User-Agent: the beacon
reports a page name, a referrer, and the coarse browser/OS/country/screen-width facts
GoatCounter aggregates. There is deliberately **no event tracking** — nothing observes what you
build on the canvas. To opt out entirely, run `localStorage.setItem('skipgc', 't')` in the
console on any Coda page.

The tag is injected at build time and only when `CODA_ANALYTICS` is set, which happens in this
repository's deploy workflow and nowhere else — so a fork you build and host reports nothing to
anybody. See [docs/analytics.md](docs/analytics.md).

## Licence

MIT
