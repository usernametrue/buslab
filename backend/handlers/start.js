const { getOrCreateUser, getMainMenuKeyboard, getStudentMenuKeyboard, isStudent, isGroupChat, safeReply } = require('./common');
const { logAction } = require('../logger');
const { t } = require('../utils/i18nHelper');

/**
 * Send trilingual welcome message with language selection buttons
 */
const sendOnboardingWelcome = async (ctx) => {
  const welcomeText =
    '🇷🇺 Добро пожаловать в бот юридической клиники! Выберите язык.\n\n' +
    '🇺🇿 Huquqiy klinika botiga xush kelibsiz! Tilni tanlang.\n\n' +
    '🇺🇸 Welcome to the Legal Clinic Bot! Choose your language.';

  const keyboard = [
    [{ text: '🇷🇺 Русский', callback_data: 'onboard_lang:ru' }],
    [{ text: '🇺🇿 O\'zbek', callback_data: 'onboard_lang:uz' }],
    [{ text: '🇺🇸 English', callback_data: 'onboard_lang:en' }]
  ];

  await ctx.reply(welcomeText, {
    reply_markup: { inline_keyboard: keyboard }
  });
};

/**
 * Send offer message in user's chosen language
 */
const sendOfferMessage = async (ctx) => {
  const offerText = t(ctx, 'onboarding.offer_text');

  const keyboard = [
    [
      { text: t(ctx, 'onboarding.accept'), callback_data: 'offer:accept' },
      { text: t(ctx, 'onboarding.decline'), callback_data: 'offer:decline' }
    ]
  ];

  await ctx.reply(offerText, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
    disable_web_page_preview: true
  });
};

/**
 * Handle /start command
 */
const handleStart = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    // Use safeReply for group chat handling
    if (isGroupChat(ctx)) {
      let welcomeMessage;
      if (isStudent(user)) {
        welcomeMessage = "Добро пожаловать, студент! Используйте команды для взаимодействия с ботом.";
      } else {
        welcomeMessage = "Добро пожаловать! Используйте команды для взаимодействия с ботом.";
      }
      await safeReply(ctx, welcomeMessage);
      await logAction('user_start_command', { userId: user._id, role: user.role, chatType: 'group' });
      return;
    }

    // Private chat - check if onboarding needed
    if (!user.offerAccepted) {
      await sendOnboardingWelcome(ctx);
      await logAction('user_start_command', { userId: user._id, role: user.role, chatType: 'private', onboarding: true });
      return;
    }

    // Private chat - offer accepted, show full menu
    let welcomeMessage;
    let keyboard;

    if (isStudent(user)) {
      welcomeMessage = t(ctx, 'commands.start.welcome_student');
      keyboard = getStudentMenuKeyboard(ctx);
    } else {
      welcomeMessage = t(ctx, 'commands.start.welcome_user');
      keyboard = getMainMenuKeyboard(ctx);
    }

    await safeReply(ctx, welcomeMessage, keyboard);
    await logAction('user_start_command', { userId: user._id, role: user.role, chatType: 'private' });
  } catch (error) {
    console.error('Error in start handler:', error);
    await safeReply(ctx, t(ctx, 'errors.general'));
  }
};

module.exports = handleStart;
module.exports.sendOfferMessage = sendOfferMessage;