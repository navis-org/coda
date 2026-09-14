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
  plugins: [buildId()],
  // Everything bundled: the file is fetched on its own, so there is no node_modules beside it.
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: fileURLToPath(new URL('./src/mcp/index.ts', import.meta.url)),
    outDir: 'dist/mcp/v1',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'node20',
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'coda.js',
        // One file, so the server downloads one URL and caches one thing.
        inlineDynamicImports: true,
      },
    },
  },
})
