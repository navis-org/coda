<img src="public/logo.svg" width="72" alt="">

# Coda

**Co**nnectome **d**ata **a**nalysis — node-graph analysis pipelines for connectomic data.

Browser-based, node editor for querying and analyzing connectomic data.

> [!TIP]
> **Alpha.** The core functionality is there, including support for (almost) all major connectome datasets. We're still adding features, improving the UI, and fixing bugs. Please report any issues you encounter!

**Highlights**
- node-based editor for building analysis/exploration pipelines
- works with neuPrint, CAVE, CATMAID and local data
- download/export results as CSV, SWC, images, Neuroglancer URLs, etc.
- convert workflows to Python or R code to run locally
- AI assistant for generating workflows from natural language queries
- share workflows via links

## Quickstart

Just open the [**Coda app**](https://navis-org.github.io/coda/).

Other useful links:
- ["Feature Overview"](https://navis-org.github.io/coda/overview.html)
- ["Field Guide"](https://navis-org.github.io/coda/tutorial.html)
- ["Node Guide"](https://navis-org.github.io/coda/nodes.html)

Proper tutorials are coming soon but in the meantime, here are some quick instructions for working with the app:

- add credentials to access neuPrint/CAVE/CATMAID datasets via `Connections` icon in the top toolbar
- `New` to create a new graph, optionally preconfigured for a specific datastack
- `Examples` menu contains some pre-built workflows
- click and drag to pan, scroll to zoom
- `Tab` or **+ Add** to add nodes
- `Space` for the command palette
- "Run" button or `⇧R` to run all stale nodes
- `I` to show/hide the inspector

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
unit-testable without a DOM, and reusable later by a non-React consumer (a CLI runner, or a
Python-side executor consuming the same graph JSON).

### Known limitations / bugs

- **Muting blocks downstream** rather than passing input through Blender-style.
- **No virtualisation.** One DOM node per graph node, and table viewers cap rendered rows.
  Fine for tens of nodes; a 1000-node graph would need work. Explore Dataset pages rather than
  scrolling a long list for the same reason.
- **A non-default neuPrint deployment needs CORS or the dev server.** It is tried directly
  first; failing that, `pnpm dev` and `pnpm preview` proxy `/np/<deployment>/…` (https to
  public hosts only), and a static build has nothing serving that path.
- Not all nodes are currently able to emit Python or R code. The codegen is a work in progress.

## Licence

MIT
