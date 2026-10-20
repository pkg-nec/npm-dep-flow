import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/tmp/**',
    '**/coverage/**',
    '**/dist/**',
    '**/.cache/**',
  ]),
  {
    files: [
      'tools/{npm-dep-paths,npm-dep-audit,npm-dep-upgrade-plan,npm-dep-upgrade}/**/*.{js,mjs,cjs}',
      'dev-tooling/**/*.{js,mjs,cjs}',
    ],
    extends: [js.configs.recommended, stylistic.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
])
