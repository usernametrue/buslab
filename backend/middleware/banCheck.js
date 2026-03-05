const User = require('../models/user');
const { logAction } = require('../logger');

/**
 * Middleware to check if user is banned.
 * Runs before all handlers. If user is banned, stops processing.
 * Skips group chats (admin/student chats) — ban only affects private bot usage.
 */
const banCheckMiddleware = async (ctx, next) => {
  try {
    // Skip group chats (admin chat, student chat)
    if (ctx.chat && ctx.chat.type !== 'private') {
      return next();
    }

    // Skip if no user info (system messages, etc.)
    if (!ctx.from) {
      return next();
    }

    const user = await User.findOne({ telegramId: ctx.from.id });

    // If user doesn't exist yet — let them through (getOrCreateUser will handle registration)
    if (!user) {
      return next();
    }

    // If user is banned — block with message and stop processing
    if (user.isBanned) {
      logAction('banned_user_attempted_access', {
        telegramId: ctx.from.id,
        username: ctx.from.username
      });

      await ctx.reply('⛔ Ваш доступ к боту заблокирован. Если вы считаете, что это ошибка, свяжитесь с администрацией.');
      return; // Do NOT call next() — stop processing
    }

    return next();
  } catch (error) {
    console.error('Error in ban check middleware:', error);
    // On error, let the request through to avoid blocking everyone
    return next();
  }
};

module.exports = { banCheckMiddleware };