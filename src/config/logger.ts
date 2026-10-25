import pino from 'pino';

/** Folder for the log files. In Docker it's mounted from the host (`./logs`), so logs survive restarts and rebuilds. */
export const LOG_DIR = process.env.LOG_DIR || 'logs';
/** Days of logs kept (one file a day, plus extra files on days that pass `LOG_MAX_SIZE`). */
const LOG_KEEP = Number(process.env.LOG_KEEP_FILES || 30);

/**
 * Custom logger wrapper for consistent use across the application.
 * Abstracts Pino configuration details.
 *
 * Logs go to `LOG_DIR/sofia.<date>.<n>.log`, a new file each day (Singapore time in Docker), with `current.log` linking
 * to today's. They used to go to `log.log` inside the container, which was lost whenever the container was recreated.
 */
export const createLogger = () => {
    const logger = pino({
        level: process.env.LOG_LEVEL || "info",
        timestamp: pino.stdTimeFunctions.isoTime,
    }, pino.transport({
        target: 'pino-roll',
        options: {
            file: `${LOG_DIR}/sofia`,
            frequency: 'daily',
            dateFormat: 'yyyy-MM-dd',
            // A day with a crash loop or debug logging shouldn't fill the disk
            size: process.env.LOG_MAX_SIZE || '50m',
            mkdir: true,
            symlink: true,
            // Counts files left by earlier runs too, otherwise every restart's files would be kept forever
            limit: { count: LOG_KEEP, removeOtherLogFiles: true },
        },
    }));

    logger.info("Logger initialized.");
    return logger;
};
