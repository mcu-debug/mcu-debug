import winston from 'winston';

/**
 * Central application logger. Platform-agnostic — no transports are added here.
 * Each entry point (CLI, VS Code extension) adds its own transports on startup.
 *
 * Usage:
 *   import { logger } from '../common/logger';
 *   logger.info('something happened', { key: 'value' });
 *   logger.error('failed', { error: e });
 */
export const logger = winston.createLogger({
    level: 'info',
});
