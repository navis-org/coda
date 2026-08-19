import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.vite` is vite's dependency pre-bundle. It is gitignored but can appear at the repo
  // root, and linting a few megabytes of transpiled vendor code buries every real finding.
  { ignores: ['dist', 'node_modules', 'coverage', '.vite'] },

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
   */
  {
    files: ['src/core/**/*.ts', 'src/data/**/*.ts'],
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
              group: ['../ui/*', '../../ui/*', '@/ui/*', '../store/*', '../../store/*', '@/store/*'],
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
