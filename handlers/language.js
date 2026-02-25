const { getOrCreateUser, isGroupChat } = require('./common');
const { t } = require('../utils/i18nHelper');
const { logAction } = require('../logger');

/**
 * Handle /language command - show language selection
 */
const handleLanguageSelection = async (ctx) => {
    try {
        // Don't allow language selection in group chats
        if (isGroupChat(ctx)) {
            await ctx.reply('Смена языка доступна только в личных сообщениях.');
            return;
        }

        const keyboard = [
            [{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }],
            [{ text: '🇺🇿 O\'zbek', callback_data: 'lang:uz' }],
            [{ text: '🇺🇸 English', callback_data: 'lang:en' }]
        ];

        await ctx.reply(
            t(ctx, 'language.select'),
            { reply_markup: { inline_keyboard: keyboard } }
        );
    } catch (error) {
        console.error('Error handling language selection:', error);
        await ctx.reply(t(ctx, 'errors.general'));
    }
};

/**
 * Handle language change callback (from /language command)
 */
const handleLanguageChange = async (ctx) => {
    try {
        const locale = ctx.callbackQuery.data.split(':')[1];
        const user = await getOrCreateUser(ctx);

        // Update user language
        user.language = locale;
        await user.save();

        // Update current context
        ctx.locale = locale;

        const { getMainMenuKeyboard, getStudentMenuKeyboard, isStudent } = require('./common');

        await ctx.answerCbQuery();
        await ctx.editMessageText(
            t(ctx, 'language.changed'),
            { reply_markup: { inline_keyboard: [] } }
        );

        // Send updated keyboard based on user role (only in private chat)
        if (!isGroupChat(ctx)) {
            if (isStudent(user)) {
                await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
            } else {
                await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
            }
        }

        logAction('user_changed_language', {
            userId: user._id,
            newLanguage: locale
        });
    } catch (error) {
        console.error('Error handling language change:', error);
        await ctx.answerCbQuery(t(ctx, 'errors.general'));
    }
};

/**
 * Handle onboarding language selection callback (from /start welcome)
 */
const handleOnboardingLanguage = async (ctx) => {
    try {
        const locale = ctx.callbackQuery.data.split(':')[1];
        const user = await getOrCreateUser(ctx);

        // Update user language
        user.language = locale;
        await user.save();

        // Update current context
        ctx.locale = locale;

        await ctx.answerCbQuery();
        await ctx.editMessageText(
            t(ctx, 'language.changed'),
            { reply_markup: { inline_keyboard: [] } }
        );

        // Send offer message
        const { sendOfferMessage } = require('./start');
        await sendOfferMessage(ctx);

        logAction('onboarding_language_selected', {
            userId: user._id,
            language: locale
        });
    } catch (error) {
        console.error('Error handling onboarding language:', error);
        await ctx.answerCbQuery(t(ctx, 'errors.general'));
    }
};

/**
 * Handle offer acceptance callback
 */
const handleOfferAccept = async (ctx) => {
    try {
        const user = await getOrCreateUser(ctx);

        // Save offer acceptance
        user.offerAccepted = true;
        await user.save();

        const { getMainMenuKeyboard, getStudentMenuKeyboard, isStudent } = require('./common');

        await ctx.answerCbQuery();
        await ctx.editMessageText(
            t(ctx, 'onboarding.offer_accepted'),
            { reply_markup: { inline_keyboard: [] } }
        );

        // Show main menu
        let welcomeMessage;
        let keyboard;

        if (isStudent(user)) {
            welcomeMessage = t(ctx, 'commands.start.welcome_student');
            keyboard = getStudentMenuKeyboard(ctx);
        } else {
            welcomeMessage = t(ctx, 'commands.start.welcome_user');
            keyboard = getMainMenuKeyboard(ctx);
        }

        await ctx.reply(welcomeMessage, keyboard);

        logAction('offer_accepted', { userId: user._id });
    } catch (error) {
        console.error('Error handling offer accept:', error);
        await ctx.answerCbQuery(t(ctx, 'errors.general'));
    }
};

/**
 * Handle offer decline callback
 */
const handleOfferDecline = async (ctx) => {
    try {
        await ctx.answerCbQuery();

        const declineText = t(ctx, 'onboarding.offer_declined');

        const keyboard = [
            [
                { text: t(ctx, 'onboarding.accept'), callback_data: 'offer:accept' },
                { text: t(ctx, 'onboarding.decline'), callback_data: 'offer:decline' }
            ]
        ];

        await ctx.editMessageText(declineText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard },
            disable_web_page_preview: true
        });

        logAction('offer_declined', { userId: ctx.from.id });
    } catch (error) {
        console.error('Error handling offer decline:', error);
        await ctx.answerCbQuery(t(ctx, 'errors.general'));
    }
};

module.exports = {
    handleLanguageSelection,
    handleLanguageChange,
    handleOnboardingLanguage,
    handleOfferAccept,
    handleOfferDecline
};