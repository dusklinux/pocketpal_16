const js = require('@eslint/js');
const parser = require('@typescript-eslint/parser');
const typescript = require('@typescript-eslint/eslint-plugin');
const hooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-plugin-prettier/recommended');
module.exports = [
  {ignores: ['node_modules/**', 'ios/**', 'build/**']},
  js.configs.recommended,
  {files: ['index.js'], languageOptions: {sourceType: 'module'}},
  {
    files: ['*.config.js', 'scripts/**/*.cjs', '.prettierrc.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser,
      globals: {setTimeout: 'readonly', clearTimeout: 'readonly'},
    },
    plugins: {'@typescript-eslint': typescript, 'react-hooks': hooks},
    rules: {
      ...typescript.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
      },
    },
    rules: {'@typescript-eslint/no-explicit-any': 'off'},
  },
  prettier,
];
