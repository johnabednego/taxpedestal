/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  globalSetup: '<rootDir>/tests/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/globalTeardown.ts',
  testTimeout: 30000,
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/scripts/**',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    global: { branches: 55, functions: 60, lines: 65, statements: 65 },
    './src/services/tax/': { branches: 85, functions: 90, lines: 90, statements: 90 },
    './src/core/money.ts': { branches: 90, functions: 100, lines: 95, statements: 95 },
  },
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
}
