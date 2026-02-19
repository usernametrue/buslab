require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const mongoose = require('mongoose');

// Import handlers
const startHandler = require('./handlers/start');
const userHandlers = require('./handlers/user');
const adminHandlers = require('./handlers/admin');
const studentHandlers = require('./handlers/student');
const categoryHandlers = require('./handlers/category');
// const faqHandlers = require('./handlers/faq');
const requestHandlers = require('./handlers/request');
const helpHandlers = require('./handlers/help');

// Import logger
const { logAction, logUserMessage, logError, logInfo, logWarn } = require('./logger');

// Import the translation helper
const { t } = require('./utils/i18nHelper');

// Check required environment variables
const requiredEnvVars = ['BOT_TOKEN', 'MONGO_URI', 'ADMIN_CHAT_ID', 'STUDENT_CHAT_ID'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  logError(new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`));
  process.exit(1);
}

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    logInfo('Connected to MongoDB', { database: process.env.MONGO_URI.split('/').pop() });
  })
  .catch(err => {
    logError(err, { context: 'MongoDB connection failed' });
    process.exit(1);
  });

// Setup middleware
bot.use(session());

const { detectUserLanguage } = require('./i18n/middleware');
bot.use(detectUserLanguage);

// Keyboard removal middleware for group chats
bot.use(async (ctx, next) => {
  try {
    // Check if this is admin or student chat
    const isAdminChat = ctx.chat && ctx.chat.id.toString() === process.env.ADMIN_CHAT_ID;
    const isStudentChat = ctx.chat && ctx.chat.id.toString() === process.env.STUDENT_CHAT_ID;

    // If it's a group chat and there's a message with keyboard buttons (not commands or callbacks)
    const adminState = ctx.from ? adminHandlers.adminStates.get(ctx.from.id) : null;
    if ((isAdminChat || isStudentChat) && ctx.message && ctx.message.text && !ctx.message.text.startsWith('/') && !adminState?.state) {
      // Add context flag to force keyboard removal
      ctx.shouldRemoveKeyboard = true;
      
      // Override the reply function to always remove keyboards in group chats
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = (text, extra = {}) => {
        // Always remove keyboard in group chats
        const newExtra = {
          ...extra,
          reply_markup: { remove_keyboard: true }
        };
        return originalReply(text, newExtra);
      };
    }

    return next();
  } catch (error) {
    logError(error, { context: 'Keyboard removal middleware error' });
    return next();
  }
});

// Enhanced logging middleware
bot.use(async (ctx, next) => {
  try {
    if (ctx.message && ctx.message.text) {
      logUserMessage(ctx.from, ctx.message.text);
    }

    // Log callback queries
    if (ctx.callbackQuery) {
      logAction('callback_query', {
        userId: ctx.from.id,
        username: ctx.from.username,
        data: ctx.callbackQuery.data
      });
    }

    return next();
  } catch (error) {
    logError(error, { context: 'Logging middleware error' });
    return next();
  }
});

// Command handlers
bot.start(startHandler);

// Help commands - context-aware (KEEP THIS)
bot.command('help', (ctx) => {
  // Determine context and call appropriate help handler
  if (ctx.chat.id.toString() === process.env.ADMIN_CHAT_ID) {
    helpHandlers.handleAdminHelp(ctx);
  } else if (ctx.chat.id.toString() === process.env.STUDENT_CHAT_ID) {
    helpHandlers.handleStudentHelp(ctx);
  } else if (ctx.chat.type === 'private') {
    helpHandlers.handleUserHelp(ctx);
  }
  // If none of the conditions match, the command is ignored
});

const languageHandlers = require('./handlers/language');

bot.command('language', languageHandlers.handleLanguageSelection);
bot.action(/lang:(.+)/, languageHandlers.handleLanguageChange);

bot.on('message', async (ctx, next) => {
  try {
    // Skip if no text
    if (!ctx.message.text) return next();

    const messageText = ctx.message.text;

    // Skip command messages
    if (messageText.startsWith('/')) {
      return next();
    }

    // === DISABLE MENU BUTTONS IN ADMIN/STUDENT CHATS ===

    // Check if this is admin or student chat
    const isAdminChat = ctx.chat && ctx.chat.id.toString() === process.env.ADMIN_CHAT_ID;
    const isStudentChat = ctx.chat && ctx.chat.id.toString() === process.env.STUDENT_CHAT_ID;

    // If it's a group chat (admin/student), skip all menu button processing
    if (isAdminChat || isStudentChat) {
      // Only allow admin/student state management in group chats

      // Admin state management (only in admin chat)
      if (isAdminChat) {
        const adminState = adminHandlers.adminStates.get(ctx.from.id);
        if (adminState) {
          switch (adminState.state) {
            case 'entering_decline_reason':
              return adminHandlers.handleDeclineReason(ctx, bot);
            case 'entering_answer_decline_reason':
              return adminHandlers.handleAnswerDeclineReason(ctx, bot);
            case 'entering_category_name':
              return adminHandlers.handleCategoryName(ctx);
            case 'entering_category_hashtag':
              return adminHandlers.handleCategoryHashtag(ctx);
            case 'entering_new_category_name':
              return adminHandlers.handleNewCategoryName(ctx);
            case 'entering_new_category_hashtag':
              return adminHandlers.handleNewCategoryHashtag(ctx);
            case 'entering_faq_question':
              return adminHandlers.handleFAQQuestion(ctx);
            case 'entering_faq_answer':
              return adminHandlers.handleFAQAnswer(ctx);
            case 'entering_new_faq_question':
              return adminHandlers.handleNewFAQQuestion(ctx);
            case 'entering_new_faq_answer':
              return adminHandlers.handleNewFAQAnswer(ctx);
          }
        }
      }

      // Student chat doesn't process text messages (only callbacks)
      // All student interactions happen via inline buttons and private messages

      return next(); // Skip all other processing for group chats
    }

    // === PRIVATE CHAT ONLY - FULL MENU FUNCTIONALITY ===

    // === PRIORITY 1: NAVIGATION BUTTONS (Always work in private chat) ===

    // Language button - always works
    if (messageText === '🌐 Language') {
      return languageHandlers.handleLanguageSelection(ctx);
    }

    // Back button - always works and handles states
    if (messageText === t(ctx, 'buttons.back')) {
      return userHandlers.handleBack(ctx);
    }

    // Help button - always works
    if (messageText === t(ctx, 'buttons.help')) {
      return userHandlers.handleHelp(ctx);
    }

    // === PRIORITY 2: STATE-BASED HANDLERS (Check states first) ===

    // User state management - check before button matching
    const userState = userHandlers.userStates.get(ctx.from.id);
    if (userState) {
      switch (userState.state) {
        case 'selecting_category':
          return userHandlers.handleCategorySelection(ctx);
        case 'entering_request':
          return userHandlers.handleRequestText(ctx);
        case 'confirming_request':
          // Only handle confirm/edit if user is in this state
          if (messageText === t(ctx, 'buttons.confirm')) {
            return userHandlers.handleRequestConfirmation(ctx, bot);
          }
          if (messageText === t(ctx, 'buttons.edit')) {
            return userHandlers.handleEditRequest(ctx);
          }
          break;
        case 'selecting_faq_category':
          return userHandlers.handleFAQCategorySelection(ctx);
        case 'selecting_faq':
          return userHandlers.handleFAQSelection(ctx);
      }
    }

    // Student state management (private chat interactions)
    const studentState = studentHandlers.studentStates.get(ctx.from.id);
    if (studentState) {
      switch (studentState.state) {
        case 'writing_answer':
          return studentHandlers.handleStudentAnswer(ctx);
        case 'confirming_answer':
          // Handle Russian student buttons (hardcoded for consistency)
          if (messageText === 'Подтвердить отправку ответа') {
            return studentHandlers.handleConfirmAnswer(ctx, bot);
          }
          if (messageText === 'Изменить ответ') {
            return studentHandlers.handleEditAnswer(ctx);
          }
          if (messageText === 'Отказаться от обращения') {
            return studentHandlers.handleRejectAssignment(ctx, bot);
          }
          break;
      }
    }

    // === PRIORITY 3: MAIN MENU BUTTONS (Only if no active state) ===

    // Only process main menu buttons if user has no active state
    if (!userState && !studentState) {

      // Main user buttons
      if (messageText === t(ctx, 'buttons.ask_question')) {
        return userHandlers.handleAskQuestion(ctx);
      }

      // if (messageText === t(ctx, 'buttons.faq')) {
      //   return userHandlers.handleFAQ(ctx);
      // }

      if (messageText === t(ctx, 'buttons.my_requests')) {
        return userHandlers.handleMyRequests(ctx);
      }

      // Student menu buttons
      if (messageText === t(ctx, 'buttons.my_answers')) {
        return studentHandlers.handleMyAnswers(ctx);
      }

      if (messageText === t(ctx, 'buttons.current_assignment')) {
        return studentHandlers.handleCurrentAssignment(ctx);
      }

      if (messageText === t(ctx, 'buttons.statistics')) {
        return studentHandlers.handleStudentStats(ctx);
      }

      // Student assignment buttons (when no state but has assignment)
      if (messageText === t(ctx, 'buttons.confirm_answer')) {
        return studentHandlers.handleConfirmAnswer(ctx, bot);
      }

      if (messageText === t(ctx, 'buttons.edit_answer')) {
        return studentHandlers.handleEditAnswer(ctx);
      }

      if (messageText === t(ctx, 'buttons.reject_assignment')) {
        return studentHandlers.handleRejectAssignment(ctx, bot);
      }
    }

    // === PRIORITY 4: FALLBACK ===

    // If no handlers matched, continue to next middleware
    return next();

  } catch (error) {
    logError(error, { context: 'Combined message handler error', userId: ctx.from.id });
    return next();
  }
});

// Admin commands (only work for admins)
bot.command('getadmin', adminHandlers.handleGetAdmin);
bot.command('add_category', adminHandlers.handleAddCategory);
bot.command('edit_category', adminHandlers.handleEditCategory);
bot.command('delete_category', adminHandlers.handleDeleteCategory);
bot.command('add_faq', adminHandlers.handleAddFAQ);
bot.command('edit_faq', adminHandlers.handleEditFAQ);
bot.command('delete_faq', adminHandlers.handleDeleteFAQ);
bot.command('categories', categoryHandlers.handleListCategories);
// bot.command('faqs', faqHandlers.handleListFAQs);
bot.command('requests', requestHandlers.handleListRequests);
bot.command('stats', requestHandlers.handleStats);

// Admin callback handlers
bot.action(/approve_request:(.+)/, (ctx) => adminHandlers.handleApproveRequest(ctx, bot));
bot.action(/decline_request:(.+)/, adminHandlers.handleDeclineRequest);
bot.action(/approve_answer:(.+)/, (ctx) => adminHandlers.handleApproveAnswer(ctx, bot));
bot.action(/decline_answer:(.+)/, adminHandlers.handleDeclineAnswer);
bot.action(/^edit_category:(.+)$/, adminHandlers.handleEditCategorySelection);
bot.action(/edit_category_name:(.+)/, adminHandlers.handleEditCategoryName);
bot.action(/edit_category_hashtag:(.+)/, adminHandlers.handleEditCategoryHashtag);
bot.action(/^delete_category:(.+)$/, adminHandlers.handleDeleteCategorySelection);
bot.action(/confirm_delete_category:(.+)/, adminHandlers.handleDeleteCategoryConfirmation);
bot.action(/select_faq_category:(.+)/, adminHandlers.handleFAQCategorySelectionAdmin);
bot.action(/edit_faq_select_category:(.+)/, adminHandlers.handleEditFAQCategorySelection);
bot.action(/^edit_faq:(.+)$/, adminHandlers.handleEditFAQSelection);
bot.action(/edit_faq_question:(.+)/, adminHandlers.handleEditFAQQuestion);
bot.action(/edit_faq_answer:(.+)/, adminHandlers.handleEditFAQAnswer);
bot.action(/edit_faq_category:(.+)/, adminHandlers.handleEditFAQCategory);
bot.action(/set_faq_category:(.+)/, adminHandlers.handleSetFAQCategory);
bot.action(/delete_faq_select_category:(.+)/, adminHandlers.handleDeleteFAQSelection);
bot.action(/confirm_delete_faq:(.+)/, adminHandlers.handleConfirmDeleteFAQ);
bot.action(/^delete_faq:(.+)$/, adminHandlers.handleDeleteFAQFromCategory);
bot.action('cancel_edit_category', adminHandlers.handleCancel);
bot.action('cancel_delete_category', adminHandlers.handleCancel);
bot.action('cancel_edit_faq', adminHandlers.handleCancel);
bot.action('cancel_delete_faq', adminHandlers.handleCancel);

// Student callback handlers
bot.action(/take_request:(.+)/, (ctx) => studentHandlers.handleTakeRequest(ctx, bot));
bot.action(/edit_answer:(.+)/, studentHandlers.handleEditAnswerCallback);
bot.action(/reject_assignment:(.+)/, (ctx) => studentHandlers.handleRejectAssignment(ctx, bot));

// Enhanced error handling
bot.catch((err, ctx) => {
  const errorContext = {
    updateType: ctx.updateType,
    userId: ctx.from ? ctx.from.id : null,
    username: ctx.from ? ctx.from.username : null,
    chatId: ctx.chat ? ctx.chat.id : null,
    messageId: ctx.message ? ctx.message.message_id : null
  };

  logError(err, errorContext);

  // Try to respond to user when error occurs
  try {
    // Use translated error message
    ctx.reply(t(ctx, 'errors.general'));
  } catch (replyErr) {
    logError(replyErr, { context: 'Error sending error message to user' });
    // Fallback to hardcoded message if translation fails
    try {
      ctx.reply('Произошла ошибка при обработке вашего запроса. Пожалуйста, попробуйте еще раз позже.');
    } catch (finalErr) {
      logError(finalErr, { context: 'Final error fallback failed' });
    }
  }
});

// Graceful shutdown handlers
const gracefulShutdown = (signal) => {
  logInfo(`Bot shutting down due to ${signal}...`);

  bot.stop(signal)
    .then(() => {
      logInfo(`Bot stopped successfully (${signal})`);
      process.exit(0);
    })
    .catch((err) => {
      logError(err, { context: `Error stopping bot on ${signal}` });
      process.exit(1);
    });
};

// Launch bot
bot.launch()
  .then(() => {
    logInfo('Bot started successfully', {
      nodeEnv: process.env.NODE_ENV || 'production',
      pid: process.pid
    });
  })
  .catch(err => {
    logError(err, { context: 'Bot startup failed' });
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));