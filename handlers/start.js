const { getOrCreateUser, getMainMenuKeyboard, getStudentMenuKeyboard, isStudent, isGroupChat, safeReply } = require('./common');
const { logAction } = require('../logger');
const { t } = require('../utils/i18nHelper');

module.exports = async (ctx) => {
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

    // Private chat - show full menu
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