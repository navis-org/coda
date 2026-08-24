/**
 * Vite's `?url` asset imports. Declared here rather than pulling in `vite/client`, which
 * also declares `import.meta.env` and a pile of other globals this project does not use.
 */
declare module '*?url' {
  const url: string
  export default url
}

/**
 * Vite's `?worker` imports, declared here for the same reason `*?url` is: this project does not
 * pull in `vite/client`. Used by `ui/layout/engine.ts` to load elkjs's worker build.
 */
declare module '*?worker' {
  const WorkerConstructor: new () => Worker
  export default WorkerConstructor
}

/**
 * Vite's `?raw` imports. `pyodide/runtime.ts` loads `nblast.py` this way, so the Python stays a
 * real `.py` file — readable, diffable, and runnable against the same wheel by
 * `scripts/probe-nblast.mjs` rather than only through a browser.
 */
declare module '*?raw' {
  const source: string
  export default source
}

/** The Draco decoder is a universal Emscripten build; see `precomputed/draco.ts`. */
declare module 'draco3d/draco_decoder_nodejs.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createDecoderModule: (options?: Record<string, unknown>) => Promise<any>
  export default createDecoderModule
}

/** Injected by vite's `define` from package.json — see `vite.config.ts`. */
declare const __APP_VERSION__: string

/**
 * The one `import.meta.env` field this project uses, for the same reason `*?url` is declared
 * above rather than pulling in `vite/client`.
 *
 * `BASE_URL` matters because `base` is `'./'` so the build works from a subpath: an asset in
 * `public/` referenced as `/start/backdrop.svg` resolves to the domain root on GitHub Pages and
 * 404s. Prefixing with `BASE_URL` is the documented way to reference one.
 */
interface ImportMetaEnv {
  readonly BASE_URL: string
}

/**
 * `import.meta.glob`, declared minimally for the same reason everything else here is: this
 * project does not pull in `vite/client`.
 *
 * Typed as `Record<string, unknown>` rather than with the conditional overloads Vite ships,
 * because the two shapes a caller wants — a lazy `() => Promise<string>` and an eager `string` —
 * are decided by `eager`, and encoding that here would be a type-level restatement of Vite's
 * own. `src/help/registry.ts` asserts the shape it asked for at each call site, which is one
 * assertion beside the options that produced it rather than a generic three lines deep.
 */
interface ImportMeta {
  readonly env: ImportMetaEnv
  glob(
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, unknown>
}
