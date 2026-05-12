import pino from 'pino';

const isDev =
  process.env.VERCEL_ENV !== 'production' &&
  process.env.NODE_ENV !== 'production';

const logLevel = process.env.LOG_LEVEL?.trim() || (isDev ? 'debug' : 'info');

export const logger = pino({
  level: logLevel,
  base: {
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.secret',
      '*.token',
      '*.agent_token',
    ],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
