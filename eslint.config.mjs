import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  // Fixture workspaces are standalone node projects under test, not product sources.
  { ignores: ['scripts/comparison/continuation/assets/**', 'scripts/comparison/continuation/.authoring/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  // SQL stays behind named Store methods; only the storage layer touches the connection.
  { files: ['src/**/*.ts', 'src/**/*.tsx'], ignores: ['src/storage/**'], rules: {
    'no-restricted-syntax': ['error', { selector: "MemberExpression[property.name='db'], MemberExpression[computed=true][property.value='db']", message: 'Direct database access is reserved for src/storage; add a named Store method instead.' }],
    'no-restricted-imports': ['error', { patterns: [{ group: ['**/storage/test-access.js'], message: 'The storage test connection is for migration fixtures only; use named Store methods.' }] }],
  } },
  // The Windows sandbox Node preload is loaded with --require, so it must stay CommonJS.
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', process: 'readonly', module: 'writable' } }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
