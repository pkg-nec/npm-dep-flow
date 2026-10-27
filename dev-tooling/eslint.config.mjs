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
      'tools/{npm-dep-versions,npm-dep-paths,npm-dep-audit,npm-dep-upgrade-plan,npm-dep-upgrade}/**/*.{js,mjs,cjs}',
      'dev-tooling/**/*.{js,mjs,cjs}',
    ],
    extends: [js.configs.recommended, stylistic.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
  },
  {
    files: [
      'tools/{npm-dep-versions,npm-dep-paths,npm-dep-audit,npm-dep-upgrade-plan,npm-dep-upgrade}/**/*.{js,mjs,cjs}',
      'dev-tooling/**/*.{js,mjs,cjs}',
    ],
    // Additional readability rules; these never override a rule from the recommended sets above.
    rules: {
      '@stylistic/padding-line-between-statements': ['error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: 'function', next: '*' },
      ],
      'default-case-last': 'error',
      'default-param-last': 'error',
      'dot-notation': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      'no-multi-assign': 'error',
      'no-negated-condition': 'error',
      'no-nested-ternary': 'error',
      'no-return-assign': 'error',
      'no-unneeded-ternary': 'error',
      'no-use-before-define': ['error', { functions: false }],
      'no-useless-concat': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'prefer-exponentiation-operator': 'error',
      'prefer-object-spread': 'error',
      'prefer-regex-literals': 'error',
      'yoda': 'error',
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
