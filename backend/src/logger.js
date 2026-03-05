const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Extract caller information from stack trace
 * @param {number} skipFrames - Number of frames to skip (default: 3)
 * @returns {Object} - File name and line number
 */
const getCallerInfo = (skipFrames = 3) => {
    const originalFunc = Error.prepareStackTrace;
    let callerfile = 'unknown';
    let callerline = 0;

    try {
        const err = new Error();

        Error.prepareStackTrace = function (err, stack) {
            return stack;
        };

        const stack = err.stack;

        // Start from skipFrames to avoid our wrapper functions
        for (let i = skipFrames; i < stack.length; i++) {
            const caller = stack[i];
            const filename = caller.getFileName();

            if (!filename) continue;

            const relativePath = path.relative(process.cwd(), filename);

            // Skip files we don't want to show
            const shouldSkip =
                relativePath.includes('node_modules') ||           // Skip node_modules
                relativePath.includes('logger.js') ||              // Skip logger files
                filename.includes('winston') ||                    // Skip winston files
                filename.includes('daily-rotate-file') ||          // Skip winston transport files
                relativePath.startsWith('..') ||                   // Skip files outside project
                filename === __filename ||                         // Skip this file
                relativePath === '' ||                             // Skip empty paths
                relativePath === '.';                              // Skip current dir

            if (!shouldSkip && relativePath) {
                callerfile = filename;
                callerline = caller.getLineNumber();
                break;
            }
        }
    } catch (e) {
        // Fallback if stack trace fails
        callerfile = 'unknown';
        callerline = 0;
    }

    Error.prepareStackTrace = originalFunc;

    // Get relative path from project root
    const relativePath = callerfile !== 'unknown'
        ? path.relative(process.cwd(), callerfile)
        : 'unknown';

    return {
        file: relativePath,
        line: callerline || 0
    };
};

/**
 * Custom format that includes caller information
 */
const addCallerInfo = winston.format((info) => {
    // If caller info wasn't already added by our wrapper functions, try to get it
    if (!info.caller) {
        const caller = getCallerInfo(5); // Skip more frames since we're deeper in winston
        info.caller = `${caller.file}:${caller.line}`;
    }
    return info;
});

// Define log format with timezone and caller info
const logFormat = winston.format.combine(
    addCallerInfo(),
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
    winston.format.printf(({ timestamp, level, message, caller, stack, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}] ${caller}: ${message}`;

        // Add metadata if present (exclude caller from meta)
        const cleanMeta = { ...meta };
        delete cleanMeta.caller;

        if (Object.keys(cleanMeta).length > 0) {
            log += ` | ${JSON.stringify(cleanMeta)}`;
        }

        // Add stack trace for errors
        if (stack) {
            log += `\n${stack}`;
        }

        return log;
    })
);

// Console format for development with timezone and caller info
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    addCallerInfo(),
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
    winston.format.printf(({ timestamp, level, message, caller, ...meta }) => {
        // Shorten file path for console display
        const shortCaller = caller ? caller.replace(/^app\//, '') : 'unknown';
        let log = `${timestamp} ${level} [${shortCaller}]: ${message}`;

        // Clean meta (exclude caller)
        const cleanMeta = { ...meta };
        delete cleanMeta.caller;

        if (Object.keys(cleanMeta).length > 0) {
            log += ` ${JSON.stringify(cleanMeta, null, 2)}`;
        }

        return log;
    })
);

// Create the logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { service: process.env.PROJECT_NAME },
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
        const caller = getCallerInfo(2); // Skip this function and the calling wrapper
        logger.log(level, action, {
            ...details,
            caller: `${caller.file}:${caller.line}`
        });
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
 * @param {Object} userState - Optional user state object
 */
const logUserMessage = (user, message, userState = null) => {
    const caller = getCallerInfo(2);
    const username = user.username ? `@${user.username}` : `ID:${user.id}`;
    const firstName = user.first_name || '';
    const lastName = user.last_name || '';
    const fullName = `${firstName} ${lastName}`.trim();

    const logData = {
        userId: user.id,
        username: user.username,
        fullName: fullName || null,
        message: message.length > 500 ? message.substring(0, 500) + '...' : message,
        caller: `${caller.file}:${caller.line}`
    };

    // Add user state if provided
    if (userState) {
        logData.userState = userState.current || userState;
        if (userState.data && Object.keys(userState.data).length > 0) {
            logData.stateData = userState.data;
        }
    }

    logger.info('user_message', logData);
};

/**
 * Log user actions with state context
 * @param {String} action - Action name
 * @param {Object} ctx - Telegraf context (contains user and userState)
 * @param {Object} details - Additional details
 */
const logUserAction = (action, ctx = {}, details = {}) => {
    const caller = getCallerInfo(2);

    const logData = {
        userId: ctx.from?.id,
        username: ctx.from?.username,
        ...details,
        ...ctx.userState,
        ...ctx.user,
        caller: `${caller.file}:${caller.line}`
    };

    logger.info(action, logData);
};

/**
 * Extract error location from error stack trace
 * @param {Error} error - Error object
 * @returns {Object} - File name and line number from error
 */
const getErrorLocation = (error) => {
    if (!error || !error.stack) {
        return { file: 'unknown', line: 0 };
    }

    try {
        const stackLines = error.stack.split('\n');

        // Look for the first line that contains a file path (not node_modules)
        for (const line of stackLines) {
            // Match patterns like:
            // "    at Object.<anonymous> (C:\path\to\file.js:136:81)"
            // "    at Function.Module._load (file.js:123:45)"
            // Or just: "C:\path\to\file.js:136"

            const match = line.match(/(?:at .+? \()?([^()]+\.js):(\d+)(?::\d+)?\)?/) ||
                line.match(/([^\\\/\s]+\.js):(\d+)/);

            if (match) {
                const fullPath = match[1];
                const lineNumber = parseInt(match[2]);

                // Skip node_modules and get relative path
                if (!fullPath.includes('node_modules')) {
                    let relativePath;

                    // If it's an absolute path, make it relative
                    if (path.isAbsolute(fullPath)) {
                        relativePath = path.relative(process.cwd(), fullPath);
                    } else {
                        relativePath = fullPath;
                    }

                    // Clean up the path
                    relativePath = relativePath.replace(/\\/g, '/'); // Convert backslashes to forward slashes

                    return {
                        file: relativePath,
                        line: lineNumber
                    };
                }
            }
        }
    } catch (e) {
        // Parsing failed, return unknown
    }

    return { file: 'unknown', line: 0 };
};

/**
 * Log bot errors with enhanced caller information
 * @param {Error|String} error - Error object or error message
 * @param {Object} context - Additional context
 */
const logError = (error, ctx = {}, meta = {}) => {
    let caller;

    if (error instanceof Error) {
        // For actual Error objects, try to get location from the error's stack first
        const errorLocation = getErrorLocation(error);

        if (errorLocation.file !== 'unknown') {
            // Use error's location if we found it
            caller = `${errorLocation.file}:${errorLocation.line}`;
        } else {
            // Fallback to caller detection
            const callerInfo = getCallerInfo(2);
            caller = `${callerInfo.file}:${callerInfo.line}`;
        }

        logger.error(error.message, {
            stack: error.stack,
            errorName: error.name,
            ...context,
            caller: caller,
            ...ctx.userState,
            ...ctx.user,
        });
    } else {
        // For string errors, use caller detection
        const callerInfo = getCallerInfo(2);
        logger.error(error.toString(), {
            ...ctx.userState,
            ...ctx.user,
            ...meta,
            caller: `${callerInfo.file}:${callerInfo.line}`
        });
    }
};

/**
 * Log bot info
 * @param {String} message - Info message
 * @param {Object} meta - Additional metadata
 */
const logInfo = (message, ctx = {}, meta = {}) => {
    const caller = getCallerInfo(2);
    logger.info(message, {
        ...ctx.userState,
        ...ctx.user,
        ...meta,
        caller: `${caller.file}:${caller.line}`
    });
};

/**
 * Log bot warnings
 * @param {String} message - Warning message
 * @param {Object} meta - Additional metadata
 */
const logWarn = (message, ctx = {}, meta = {}) => {
    const caller = getCallerInfo(2);
    logger.warn(message, {
        ...ctx.userState,
        ...ctx.user,
        ...meta,
        caller: `${caller.file}:${caller.line}`
    });
};

/**
 * Log debug information (only in development)
 * @param {String} message - Debug message
 * @param {Object} meta - Additional metadata
 */
const logDebug = (message, ctx = {}, meta = {}) => {
    const caller = getCallerInfo(2);
    logger.debug(message, {
        ...ctx.userState,
        ...ctx.user,
        ...meta,
        caller: `${caller.file}:${caller.line}`
    });
};

/**
 * Log with custom caller information (for special cases)
 * @param {String} level - Log level
 * @param {String} message - Log message
 * @param {String} customCaller - Custom caller info
 * @param {Object} meta - Additional metadata
 */
const logWithCaller = (level, message, customCaller, meta = {}) => {
    logger.log(level, message, {
        ...meta,
        caller: customCaller
    });
};

// Create a stream for Morgan HTTP logging
const stream = {
    write: (message) => {
        logger.info(message.trim(), { caller: 'http/morgan' });
    }
};

// Make logger functions available globally
global.logger = {
    logger,
    logAction,
    logUserAction,
    logUserMessage,
    logError,
    logInfo,
    logWarn,
    logDebug,
    logWithCaller,
    stream
};

// Keep module exports for backward compatibility
module.exports = {
    logger,
    logAction,
    logUserAction,
    logUserMessage,
    logError,
    logInfo,
    logWarn,
    logDebug,
    logWithCaller,
    stream
};