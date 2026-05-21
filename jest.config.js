// Bound worker concurrency to keep ts-jest from OOM'ing the dev box.
// Override with JEST_MAX_WORKERS=N for CI machines with dedicated RAM.
const maxWorkers = process.env.JEST_MAX_WORKERS || '25%';

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  // Default to node; React hook tests under test/client/ use a
  // `@jest-environment jsdom` docblock to opt into the browser env.
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts', '<rootDir>/test/**/*.test.tsx'],
  testTimeout: 10_000,
  maxWorkers,
  workerIdleMemoryLimit: '512MB',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', esModuleInterop: true } }],
  },
};
