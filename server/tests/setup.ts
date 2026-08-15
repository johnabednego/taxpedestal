/**
 * Global Jest setup.
 *
 * Injects the minimum valid configuration so `src/config/env.ts` passes its
 * boot-time validation without a real .env file. Integration tests override
 * MONGODB_URI with an in-memory server address.
 */
process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/taxpedestal-test'
process.env.JWT_ACCESS_SECRET = 'test-access-secret-value-at-least-32-chars-long'
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-at-least-32-chars-different'
process.env.APP_URL = 'http://localhost:5173'
process.env.API_URL = 'http://localhost:4000'
process.env.CORS_ORIGINS = 'http://localhost:5173'
process.env.EMAIL_PROVIDER = 'console'
process.env.ENABLE_SCHEDULER = 'false'
process.env.LOG_LEVEL = 'silent'

jest.setTimeout(30_000)
