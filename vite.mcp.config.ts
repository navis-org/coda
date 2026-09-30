/**
 * The headless build the MCP server runs: `dist/mcp/v1/coda.js`, deployed beside the app.
 *
 * A second `vite build` rather than a fifth entry in `vite.config.ts`, because the two share
 * nothing a build step cares about. The app is a browser bundle with React, the SEO and analytics
 * plugins and `base: './'`; this is one self-contained ES module for Node, with every dependency
 * inlined, that nobody ever opens in a browser. Vite rather than a bare bundler because the node
 * pack reaches three Vite-only constructs (`import.meta.glob` in the help registry, a `?url` wasm
 * import in the Draco decoder, `import.meta.env.BASE_URL` in the landmark transforms), and building
 * it with the tool that already resolves them is what keeps this from being a second spelling.
 *
 * **The path carries the contract version, not the app's.** `v1` changes only when an export in
 * `src/mcp/index.ts` changes shape; see `docs/mcp.md` and `src/mcp/contract.test.ts`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** Stands in for `BUILD_ID` until the bundle knows which files it is made of. */
const BUILD_ID_PLACEHOLDER = '__CODA_MCP_BUILD_ID__'

/** Files that shape the bundle without being a module in it. */
const BUILD_INPUTS = ['package.json', 'pnpm-lock.yaml', 'vite.mcp.config.ts']

/**
 * `BUILD_ID`: the latest commit that changed a file this bundle is made of, with `-dirty` when one of
 * those files differs from it.
 *
 * **Not `HEAD`, which was the first version.** The server tells builds apart by the file's digest and
 * cannot unload a module, so a value that moved with every commit changed the bytes on every deploy:
 * a docs-only push made a long-running server import another copy of identical code, measured at
 * ~16 MB of RSS each, at about ten deploys a day. Asked of the modules Rollup actually bundled, the id
 * moves when the code does. `unknown` outside a git checkout rather than a failed build: the id
 * identifies a build, it does not gate one.
 */
/**
 * The measured size of `coda.js`, and the date it was measured.
 *
 * Raise it deliberately, with a reason — this is the only thing standing between the bundle and
 * the next library that reaches it. See `sizeBudget` below.
 *
 * 2,700 → 2,750 on 2026-09-29, for growth that is real rather than a library: the bundle measured
 * 2,691 kB before the Custom Dataset and the table-file nodes (Link Table, Read Rows) and
 * 2,740 kB after, the difference being their definitions, `CompositeSource` and the `data/files`
 * glue the catalogue reaches. The readers (`apache-arrow`, `hyparquet`, `lz4js`) are external
 * below; without that it was 3,216 kB.
 *
 * 2,750 → 2,800 the same day, for the help pages of Link Table and Read Rows (the node documents
 * ride in the bundle for `coda_node_details`), which took it to 2,757 kB. Prose, not a library.
 *
 * 2,800 → 2,850 on 2026-09-29, for the Custom Dataset's edge list and synapse table — the wired
 * edge sets, the synapse lookups and the node's params, which the catalogue reaches — at 2,801 kB.
 * Code of ours; the readers they call stay external.
 *
 * 2,850 → 2,900 the same day, having measured 2,837 kB once the rest of that work had landed:
 * the 2,801 above was taken part way through it, and 13 kB of headroom is not a loose budget.
 */
const SIZE_BUDGET_KB = 2_900

/**
 * Fail the build if the bundle outgrows its budget.
 *
 * **The `external` list below is a fact somebody has to remember; this is the thing that notices
 * when they do not.** `three` arrived in this file by a dynamic import three directories away and
 * took it from 2,482 kB to 4,345 kB — found by hand, after it had shipped, because the artifact
 * is produced on every push and nothing looked at it. `docs/mcp.md` records the size as prose,
 * which is a measurement rather than a check.
 *
 * `zoo-index --check` is the house precedent: a generated artifact carries the number that lets a
 * later run byte-compare it. The budget is deliberately loose — headroom for ordinary growth, not
 * a ratchet — so it fires on a renderer-sized arrival and on nothing else.
 */
/** The packages this bundle leaves out — see the `external` comment below for each one's reason. */
const EXTERNAL = [
  'three',
  'three-mesh-bvh',
  'apache-arrow',
  'hyparquet',
  'hyparquet/src/constants.js',
  'hyparquet/src/thrift.js',
  'hysnappy',
  'lz4js',
] as const

/**
 * Fail the build if an external is imported statically.
 *
 * An external is only safe as a *dynamic* import: the server that downloads this file installs
 * none of them, so a static one makes the whole module fail to load — every tool, not just the
 * node that needed the package. A module reached through `import()` is inlined here
 * (`inlineDynamicImports`), and its own top-level import of an external is hoisted to the top of
 * the bundle, so the rule is easy to break from three directories away.
 */
function importCheck(): Plugin {
  return {
    name: 'coda-mcp-import-check',
    generateBundle(_options, bundle) {
      const chunk = bundle['coda.js']
      if (!chunk || chunk.type !== 'chunk') return
      const external: readonly string[] = EXTERNAL
      const statics = chunk.imports.filter((id) => external.includes(id))
      if (statics.length === 0) return
      this.error(
        `dist/mcp/v1/coda.js imports ${statics.join(', ')} statically, so it cannot load where ` +
          'those packages are not installed — which is every deployed MCP server. Load them ' +
          "through `import('…')` at the point of use (`src/data/libraries.ts`), never at a " +
          "module's top.",
      )
    },
  }
}

function sizeBudget(): Plugin {
  return {
    name: 'coda-mcp-size-budget',
    generateBundle(_options, bundle) {
      const chunk = bundle['coda.js']
      if (!chunk || chunk.type !== 'chunk') return
      const kb = Math.round(Buffer.byteLength(chunk.code) / 1024)
      if (kb <= SIZE_BUDGET_KB) return
      this.error(
        `dist/mcp/v1/coda.js is ${kb} kB, past the ${SIZE_BUDGET_KB} kB budget in ` +
          "vite.mcp.config.ts. Almost always this is a library reached only from a node's " +
          '`evaluate`, which this bundle never runs — add it to `external` below. If the growth ' +
          'is real, raise the budget and say why.',
      )
    },
  }
}

function buildId(): Plugin {
  return {
    name: 'coda-mcp-build-id',
    renderChunk(code, chunk) {
      const modules = chunk.moduleIds
        .filter((id) => id.startsWith(root) && !id.includes('/node_modules/'))
        .map((id) => relative(root, id.replace(/\?.*$/, '')))
      return code.replaceAll(BUILD_ID_PLACEHOLDER, lastCommitOf([...BUILD_INPUTS, ...modules]))
    },
  }
}

function lastCommitOf(paths: string[]): string {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim()
  try {
    const commit = git('log', '-1', '--format=%H', '--', ...paths).slice(0, 12)
    if (!commit) return 'unknown'
    return git('status', '--porcelain', '--', ...paths) ? `${commit}-dirty` : commit
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_ID__: JSON.stringify(BUILD_ID_PLACEHOLDER),
  },
  plugins: [buildId(), sizeBudget(), importCheck()],
  // Everything bundled: the file is fetched on its own, so there is no node_modules beside it.
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: fileURLToPath(new URL('./src/mcp/index.ts', import.meta.url)),
    outDir: 'dist/mcp/v1',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'node20',
    rollupOptions: {
      /*
       * Libraries only a node's `evaluate` can reach stay out, and `inlineDynamicImports` is why
       * it needs saying.
       *
       * Nothing `src/mcp/index.ts` exports runs a node — it is a catalogue, a plan parser,
       * `applyPlan`, `check` and a share link — so every `evaluate` in the node pack is dead code
       * here, and Rollup cannot see that, the definitions being objects in a registry. In the
       * browser build a dynamic import inside one is a chunk fetched by the first Run; here
       * `inlineDynamicImports` puts it in the single file the server downloads and holds.
       * Measured on `three`: **2,482 kB → 4,345 kB**, 75% more for a renderer this bundle can
       * never reach. Externalising took it to **+12 kB**.
       *
       * The criterion is the reason, not the package name, which is why this is a list rather
       * than a pattern like `/^three/`: what qualifies is "reachable only from `evaluate`", and
       * that is not derivable from a name. `elkjs` (`src/layout/engine.ts`) is deliberately
       * **not** here — layout is reachable from `applyPlan`, so it is bundle work this server may
       * genuinely do.
       *
       * Two more meet the criterion and are not yet listed: `umap-js` (`src/umap/run.ts`, reached
       * from `core.embed`) and `graphology` + `graphology-communities-louvain`
       * (`nodes/lib/networkCentrality.ts`). Adding them measures **2,494 kB → 2,067 kB**. They
       * predate this list and moving them changes the artifact for nodes nobody was looking at,
       * so they are recorded here rather than done quietly.
       *
       * `apache-arrow`, `hyparquet` and `lz4js` are the table-file readers (`src/data/files`),
       * reached from Link Table's and Read Rows' `evaluate` — they took the file past its budget,
       * **2,700 kB → 3,216 kB**, on arrival. `hysnappy` and the two `hyparquet/src/…` modules are
       * the Parquet fast path's (`src/data/files/pages.ts`), each subpath named, a bare
       * `'hyparquet'` matching only the package's root. **All of them are loaded through
       * `src/data/libraries.ts`, never imported at a module's top**: an external that a lazily
       * reached *module* imports statically is hoisted into a static import of this whole file,
       * which then fails to load on every server that has not installed the package — shipped
       * that way once, and found by an audit. `importCheck` below refuses it.
       *
       * Left as a bare `import("three")` in the output rather than stubbed, so a future path that
       * really did reach one fails loudly at the call — `docs/mcp.md`'s terms, where a breaking
       * change is a `v2` directory and a silent wrong answer is the thing to avoid.
       */
      external: [...EXTERNAL],
      output: {
        format: 'es',
        entryFileNames: 'coda.js',
        // One file, so the server downloads one URL and caches one thing.
        inlineDynamicImports: true,
      },
    },
  },
})
