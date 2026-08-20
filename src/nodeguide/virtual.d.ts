/**
 * The build-time registry dump, supplied by `vite/nodeGuideData.ts`.
 *
 * Typed `unknown` here and asserted in `main.ts`, which is the one arrangement that both
 * type-checks and lints. The two obvious alternatives do not:
 *
 *  - a top-level `import type` makes this file a *module*, at which point `declare module` is
 *    read as an augmentation of a module that does not exist;
 *  - an `import type` inside the block, and an inline `import('./data').GuideData`, both leave
 *    the export as `any` or trip `consistent-type-imports`.
 *
 * Nothing is lost by asserting: `nodeGuide.test.ts` calls `guideData()` directly, so the shape
 * this file cannot check is checked there against the real registry.
 */
declare module 'virtual:node-guide-data' {
  const data: unknown
  export default data
}
