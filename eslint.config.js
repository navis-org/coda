import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.vite` is vite's dependency pre-bundle. It is gitignored but can appear at the repo
  // root, and linting a few megabytes of transpiled vendor code buries every real finding.
  // `*.local` is already the gitignored spelling for a working directory that is nobody else's
  // business; lint agreeing with git is what keeps `pnpm lint` clean while one is in the tree.
  { ignores: ['dist', 'node_modules', 'coverage', '.vite', '*.local'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The engine throws Errors with prose messages; template literals over them are fine.
      '@typescript-eslint/restrict-template-expressions': 'off',
      eqeqeq: ['warn', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  /*
   * Maintenance scripts run under Node, not in a browser, so they get Node's globals rather
   * than the browser set every other file here uses — and `no-console` is lifted, since
   * printing to a terminal is the entire point of one.
   */
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  /*
   * The architectural boundary.
   *
   * `src/core` is the graph engine: type system, inference, scheduler. It must stay
   * headless so it can be unit-tested without a DOM and, later, reused by a non-React
   * consumer (a CLI runner, or a Python-side executor consuming the same graph JSON).
   * `src/data` is the same deal for backends. Enforced here rather than trusted to
   * discipline, because this is exactly the boundary that erodes first.
   *
   * `src/assistant` is in for the same reason and one of its own: it turns a model's reply
   * into a graph, and the one thing that keeps that safe is that it cannot commit anything —
   * it hands a `CodaGraph` back and the store decides. Give it the store and "validate, then
   * apply atomically" becomes "apply, and validate somewhere".
   */
  {
    files: [
      'src/core/**/*.ts',
      'src/data/**/*.ts',
      'src/assistant/**/*.ts',
      // In because `src/assistant` imports it: the property is transitive, the rule is not.
      'src/layout/**/*.ts',
      // A compute backend, same deal as `src/data`. It runs in a worker, where there is no
      // React and no store to reach for anyway — which is exactly when a boundary erodes.
      'src/pyodide/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'src/core and src/data must stay headless.' },
            { name: 'react-dom', message: 'src/core and src/data must stay headless.' },
            { name: 'zustand', message: 'State management belongs in src/store.' },
            { name: '@xyflow/react', message: 'src/core must not know about the editor.' },
          ],
          patterns: [
            {
              /*
               * Depth-independent. The enumerated `../ui/*` / `../../ui/*` form covered two
               * levels, and `src/data/ai/` is the first directory at three — the next nesting
               * would have escaped the rule silently.
               */
              group: ['**/ui/*', '**/store/*', '@/ui/*', '@/store/*'],
              message: 'src/core and src/data must not depend on the UI or the store.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-imports': 'off',
    },
  },
)
