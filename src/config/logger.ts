import pino from 'pino';

/**
 * Custom logger wrapper for consistent use across the application.
 * Abstracts Pino configuration details.
 */
export const createLogger = () => {
    const logger = pino({
        level: process.env.LOG_LEVEL || "info",
        timestamp: pino.stdTimeFunctions.isoTime,
    }, pino.destination("log.log"));

    // Add file transport for persistent logging of major events
    logger.info("Logger initialized.");
    return logger;
};