const { getOrCreateUser, isAdmin, canTakeRequests } = require('./common');
const { logAction } = require('../logger');
const { t } = require('../utils/i18nHelper');

/**
 * Handle /help command for admins (only in admin chat)
 */
const handleAdminHelp = async (ctx) => {
    try {
        // Check if the command is from the admin chat
        if (ctx.chat.id.toString() !== process.env.ADMIN_CHAT_ID) {
            return; // Don't respond outside admin chat
        }

        const user = await getOrCreateUser(ctx);

        // Check if user is admin
        if (!isAdmin(user)) {
            await ctx.reply(t(ctx, 'errors.admin_only'));
            return;
        }

        await ctx.reply(t(ctx, 'help.admin'), { parse_mode: 'Markdown' });
        await logAction('admin_viewed_help', { userId: user._id });
    } catch (error) {
        console.error('Error handling admin help:', error);
        await ctx.reply(t(ctx, 'errors.general'));
    }
};

/**
 * Handle /help command for students (only in student chat)
 */
const handleStudentHelp = async (ctx) => {
    try {
        // Check if user can take requests (is in student chat)
        if (!canTakeRequests(ctx)) {
            return; // Don't respond outside student chat
        }

        const user = await getOrCreateUser(ctx);

        await ctx.reply(t(ctx, 'help.student'), { parse_mode: 'Markdown' });
        await logAction('student_viewed_help', { userId: user._id });
    } catch (error) {
        console.error('Error handling student help:', error);
        await ctx.reply(t(ctx, 'errors.general'));
    }
};

/**
 * Handle /help command for regular users (only in private chat)
 */
const handleUserHelp = async (ctx) => {
    try {
        // Check if this is a private chat
        if (ctx.chat.type !== 'private') {
            return; // Don't respond in group chats
        }

        const user = await getOrCreateUser(ctx);

        await ctx.reply(t(ctx, 'help.user'), { parse_mode: 'Markdown' });
        await logAction('user_viewed_help', { userId: user._id });
    } catch (error) {
        console.error('Error handling user help:', error);
        await ctx.reply(t(ctx, 'errors.general'));
    }
};

module.exports = {
    handleAdminHelp,
    handleStudentHelp,
    handleUserHelp
};