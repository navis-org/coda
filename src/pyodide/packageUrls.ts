/**
 * Public wheels must resolve from the app root even with Vite's relative base (`./`).
 * In dev this module's caller is src/pyodide/runtime.ts; production puts the worker in
 * assets/ (Vite's default assetsDir). Resolving against origin loses a /coda/ deployment.
 */
export function packageUrls(
  paths: readonly string[],
  runtimeUrl: string,
  dev: boolean,
): string[] {
  const publicRoot = new URL(dev ? '../../' : '../', runtimeUrl)
  return paths.map((path) => new URL(path, publicRoot).href)
}
