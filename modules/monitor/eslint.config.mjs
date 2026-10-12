import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';
import environments from 'globals';

const globals = Object.fromEntries([
  'console', 'process', 'Buffer', 'URL', 'URLSearchParams', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'fetch', 'AbortController', 'AbortSignal',
  'Request', 'Response', 'Headers', 'TextEncoder', 'TextDecoder', 'structuredClone',
  'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'performance',
  'EventSource', 'WebSocket', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'MutationObserver', 'DOMParser', 'CustomEvent', 'Event', 'HTMLElement',
  'HTMLInputElement', 'Node', 'CSS', 'matchMedia', 'btoa', 'atob', 'crypto', 'Blob',
].map(name => [name, 'readonly']));

export default defineConfig([
  globalIgnores(['node_modules/**', 'dist/**', '.build-cache/**', '.next/**', '.vinext/**', '.wrangler/**', '.sites-runtime/**', 'build/**', 'next-env.d.ts', 'output/**', 'outputs/**']),
  {
    ...js.configs.recommended,
    languageOptions: { globals: { ...environments.browser, ...environments.node, ...globals } },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Input validators intentionally reject control bytes; data feeds use
      // finally guards to discard generations that became stale while waiting.
      'no-control-regex': 'off',
      'no-unsafe-finally': 'off',
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipJSXText: true }],
      'no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.{ts,tsx}'] })),
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: { react, 'react-hooks': hooks },
    settings: { react: { version: 'detect' } },
    rules: { ...react.configs.recommended.rules, ...react.configs['jsx-runtime'].rules, ...hooks.configs.recommended.rules, 'react/prop-types': 'off' },
  },
  {
    files: ['components/ui/**/*.{ts,tsx}', 'hooks/use-mobile.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off', 'react-hooks/purity': 'off', 'react-hooks/set-state-in-effect': 'off' },
  },
]);
