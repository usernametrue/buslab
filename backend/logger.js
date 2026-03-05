const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format with timezone
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: () => {
      // Add +5 timezone (Tashkent/Uzbekistan)
      const now = new Date();
      const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      const tashkentTime = new Date(utc + (5 * 3600000)); // UTC+5
      return tashkentTime.toISOString().replace('T', ' ').replace(/\..+/, '');
    }
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += ` | ${JSON.stringify(meta)}`;
    }

    // Add stack trace for errors
    if (stack) {
      log += `\n${stack}`;
    }

    return log;
  })
);

// Console format for development with timezone
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: () => {
      // Add +5 timezone for console output too
      const now = new Date();
      const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      const tashkentTime = new Date(utc + (5 * 3600000)); // UTC+5
      return tashkentTime.toLocaleString('en-GB', {
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$2-$1');
    }
  }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} ${level}: ${message}`;

    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta, null, 2)}`;
    }

    return log;
  })
);

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'legalbot' },
  transports: [
    // Error logs - separate file for errors only
    new DailyRotateFile({
      filename: path.join(logsDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '100m',
      maxFiles: '5',
      zippedArchive: true,
      handleExceptions: true,
      handleRejections: true
    }),

    // Combined logs - all levels
    new DailyRotateFile({
      filename: path.join(logsDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '100m',
      maxFiles: '5', // Keep 5 days worth of logs (500MB total at 100MB per day)
      zippedArchive: true
    }),

    // Console output
    new winston.transports.Console({
      format: consoleFormat,
      handleExceptions: true,
      handleRejections: true
    })
  ],

  // Don't exit on handled exceptions
  exitOnError: false
});

/**
 * Log an action in the system
 * @param {String} action - Action name (e.g., 'user_sent_request')
 * @param {Object} details - Details of the action (userId, requestId, etc.)
 * @param {String} level - Log level (default: 'info')
 */
const logAction = (action, details = {}, level = 'info') => {
  try {
    logger.log(level, action, details);
  } catch (error) {
    // Fallback to console if Winston fails
    console.error(`Error logging action ${action}:`, error);
    console.log(`Fallback log - ${action}:`, details);
  }
};

/**
 * Log user messages
 * @param {Object} user - Telegram user object
 * @param {String} message - Message text
 */
const logUserMessage = (user, message) => {
  const username = user.username ? `@${user.username}` : `ID:${user.id}`;
  const firstName = user.first_name || '';
  const lastName = user.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim();

  logAction('user_message', {
    userId: user.id,
    username: user.username,
    fullName: fullName || null,
    message: message.length > 500 ? message.substring(0, 500) + '...' : message
  });
};

/**
 * Log bot errors
 * @param {Error} error - Error object
 * @param {Object} context - Additional context
 */
const logError = (error, context = {}) => {
  logger.error(error.message, {
    stack: error.stack,
    ...context
  });
};

/**
 * Log bot info
 * @param {String} message - Info message
 * @param {Object} meta - Additional metadata
 */
const logInfo = (message, meta = {}) => {
  logger.info(message, meta);
};

/**
 * Log bot warnings
 * @param {String} message - Warning message
 * @param {Object} meta - Additional metadata
 */
const logWarn = (message, meta = {}) => {
  logger.warn(message, meta);
};

/**
 * Log debug information (only in development)
 * @param {String} message - Debug message
 * @param {Object} meta - Additional metadata
 */
const logDebug = (message, meta = {}) => {
  logger.debug(message, meta);
};

// Create a stream for Morgan HTTP logging
const stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

module.exports = {
  logger,
  logAction,
  logUserMessage,
  logError,
  logInfo,
  logWarn,
  logDebug,
  stream
};