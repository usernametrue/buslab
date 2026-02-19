const { Markup } = require('telegraf');
const { getOrCreateUser, getMainMenuKeyboard, getStudentMenuKeyboard, getBackKeyboard } = require('./common');
const Category = require('../models/category');
const Request = require('../models/request');
const FAQ = require('../models/faq');
const { logAction } = require('../logger');
const { t } = require('../utils/i18nHelper');

// User state management (in-memory for simplicity)
const userStates = new Map();

/**
 * Handle "Задать вопрос" / "Savol berish" action
 */
const handleAskQuestion = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply(t(ctx, 'errors.no_categories'));
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    // Create keyboard with categories
    const keyboard = [];
    categories.forEach(category => {
      keyboard.push([category.name]);
    });
    keyboard.push([t(ctx, 'buttons.back')]);

    // Set user state to selecting category
    userStates.set(user.telegramId, {
      state: 'selecting_category'
    });

    await ctx.reply(t(ctx, 'prompts.select_category'), Markup.keyboard(keyboard).resize());
    await logAction('user_selecting_category', { userId: user._id });
  } catch (error) {
    console.error('Error handling ask question:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle category selection
 */
const handleCategorySelection = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categoryName = ctx.message.text;

    const category = await Category.findOne({ name: categoryName });
    if (!category) {
      await ctx.reply(t(ctx, 'errors.category_not_found'));
      return;
    }

    // Update user state with selected category
    userStates.set(user.telegramId, {
      state: 'entering_request',
      categoryId: category._id
    });

    await ctx.reply(t(ctx, 'prompts.enter_request'), getBackKeyboard(ctx));
    await logAction('user_selected_category', {
      userId: user._id,
      categoryId: category._id
    });
  } catch (error) {
    console.error('Error handling category selection:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle request text entry
 */
const handleRequestText = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const requestText = ctx.message.text;

    if (requestText.length < 150) {
      await ctx.reply(t(ctx, 'errors.invalid_length', { min: 150 }));
      return;
    }

    const userState = userStates.get(user.telegramId);

    // Update user state with request text
    userStates.set(user.telegramId, {
      ...userState,
      state: 'confirming_request',
      requestText
    });

    await ctx.reply(
      t(ctx, 'prompts.confirm_request') + '\n\n' + requestText,
      Markup.keyboard([
        [t(ctx, 'buttons.confirm')],
        [t(ctx, 'buttons.edit')],
        [t(ctx, 'buttons.back')]
      ]).resize()
    );

    await logAction('user_entered_request', {
      userId: user._id,
      categoryId: userState.categoryId,
      textLength: requestText.length
    });
  } catch (error) {
    console.error('Error handling request text:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle request confirmation
 */
const handleRequestConfirmation = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    const userState = userStates.get(user.telegramId);

    if (!userState || !userState.categoryId || !userState.requestText) {
      await ctx.reply(t(ctx, 'errors.general'));
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    const category = await Category.findById(userState.categoryId);

    // Create request in database
    const request = new Request({
      userId: user._id,
      categoryId: userState.categoryId,
      text: userState.requestText,
      status: 'pending'
    });

    await request.save();

    // Send request to admin chat
    const adminChatId = process.env.ADMIN_CHAT_ID;
    const adminMessage = `
📨 Новое обращение #${request._id}
📂 Категория: ${category.name} ${category.hashtag}

📝 Текст обращения:
${userState.requestText}
`;

    await bot.telegram.sendMessage(adminChatId, adminMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Одобрить', callback_data: `approve_request:${request._id}` },
            { text: '❌ Отклонить', callback_data: `decline_request:${request._id}` }
          ]
        ]
      }
    });

    // Reset user state
    userStates.delete(user.telegramId);

    await ctx.reply(t(ctx, 'success.request_sent'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));

    await logAction('user_submitted_request', {
      userId: user._id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling request confirmation:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle "Изменить" / "O'zgartirish" (Edit request) button
 */
const handleEditRequest = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const userState = userStates.get(user.telegramId);

    if (!userState || !userState.categoryId) {
      await ctx.reply(t(ctx, 'errors.general'));
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    // Update user state to allow re-entering request text
    userStates.set(user.telegramId, {
      state: 'entering_request',
      categoryId: userState.categoryId
    });

    await ctx.reply(t(ctx, 'prompts.enter_request'), getBackKeyboard(ctx));

    await logAction('user_editing_request', {
      userId: user._id,
      categoryId: userState.categoryId
    });
  } catch (error) {
    console.error('Error handling edit request:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle "Мои обращения" / "Mening murojaatlarim" action
 */
const handleMyRequests = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    const requests = await Request.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .populate('categoryId');

    if (requests.length === 0) {
      await ctx.reply(t(ctx, 'lists.no_requests'));
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    let message = t(ctx, 'lists.my_requests_title') + '\n\n';

    requests.forEach((request, index) => {
      const date = request.createdAt.toLocaleDateString('ru-RU');

      message += `${index + 1}. ${request.categoryId.name} - ${t(ctx, `statuses.${request.status}`)}\n`;
      message += `   ${t(ctx, 'lists.request_date')} ${date}\n`;

      if (request.status === 'closed' && request.answerText) {
        // Truncate long answers for better readability
        const truncatedAnswer = request.answerText.length > 200
          ? request.answerText.substring(0, 197) + '...'
          : request.answerText;
        message += `   ${t(ctx, 'lists.answer_label')} ${truncatedAnswer}\n`;
      }

      if (request.status === 'declined' && request.adminComment) {
        message += `   ${t(ctx, 'lists.comment_label')} ${request.adminComment}\n`;
      }

      message += '\n';
    });

    await ctx.reply(message);
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));

    await logAction('user_viewed_requests', { userId: user._id });
  } catch (error) {
    console.error('Error handling my requests:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle "FAQ" action
 */
const handleFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply(t(ctx, 'errors.no_categories'));
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    // Create keyboard with categories
    const keyboard = [];
    categories.forEach(category => {
      keyboard.push([category.name]);
    });
    keyboard.push([t(ctx, 'buttons.back')]);

    // Set user state to selecting FAQ category
    userStates.set(user.telegramId, {
      state: 'selecting_faq_category'
    });

    await ctx.reply(t(ctx, 'prompts.select_faq_category'), Markup.keyboard(keyboard).resize());
    await logAction('user_viewing_faq', { userId: user._id });
  } catch (error) {
    console.error('Error handling FAQ:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle FAQ category selection
 */
const handleFAQCategorySelection = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const categoryName = ctx.message.text;

    const category = await Category.findOne({ name: categoryName });
    if (!category) {
      await ctx.reply(t(ctx, 'errors.category_not_found'));
      return;
    }

    const faqs = await FAQ.find({ categoryId: category._id });

    if (faqs.length === 0) {
      await ctx.reply(t(ctx, 'errors.not_found'));
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    // Create keyboard with FAQs
    const keyboard = [];
    faqs.forEach(faq => {
      keyboard.push([faq.question]);
    });
    keyboard.push([t(ctx, 'buttons.back')]);

    // Update user state with selected category
    userStates.set(user.telegramId, {
      state: 'selecting_faq',
      categoryId: category._id,
      faqs: faqs.reduce((acc, faq) => {
        acc[faq.question] = faq;
        return acc;
      }, {})
    });

    await ctx.reply(t(ctx, 'prompts.select_faq_question'), Markup.keyboard(keyboard).resize());
    await logAction('user_selected_faq_category', {
      userId: user._id,
      categoryId: category._id
    });
  } catch (error) {
    console.error('Error handling FAQ category selection:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle FAQ question selection
 */
const handleFAQSelection = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const userState = userStates.get(user.telegramId);

    if (!userState || !userState.faqs) {
      await ctx.reply(t(ctx, 'errors.general'));
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    const question = ctx.message.text;
    const faq = userState.faqs[question];

    if (!faq) {
      await ctx.reply(t(ctx, 'errors.category_not_found'));
      return;
    }

    // Send FAQ answer
    await ctx.reply(`📌 Вопрос: ${faq.question}\n\n📝 Ответ: ${faq.answer}`);
    await ctx.reply(t(ctx, 'lists.select_action'), getBackKeyboard(ctx));

    await logAction('user_viewed_faq', {
      userId: user._id,
      faqId: faq._id
    });
  } catch (error) {
    console.error('Error handling FAQ selection:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle "Назад" / "Orqaga" (back) button
 */
const handleBack = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const userState = userStates.get(user.telegramId);

    if (!userState) {
      await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
      return;
    }

    // Depending on current state, go back to appropriate menu
    switch (userState.state) {
      case 'selecting_category':
      case 'selecting_faq_category':
        userStates.delete(user.telegramId);
        await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
        break;

      case 'entering_request':
        userStates.set(user.telegramId, { state: 'selecting_category' });
        const categories = await Category.find().sort({ name: 1 });
        const keyboard = categories.map(category => [category.name]);
        keyboard.push([t(ctx, 'buttons.back')]);
        await ctx.reply(t(ctx, 'prompts.select_category'), Markup.keyboard(keyboard).resize());
        break;

      case 'confirming_request':
        userStates.set(user.telegramId, {
          state: 'entering_request',
          categoryId: userState.categoryId
        });
        await ctx.reply(t(ctx, 'prompts.enter_request'), getBackKeyboard(ctx));
        break;

      case 'selecting_faq':
        userStates.set(user.telegramId, { state: 'selecting_faq_category' });
        const faqCategories = await Category.find().sort({ name: 1 });
        const faqKeyboard = faqCategories.map(category => [category.name]);
        faqKeyboard.push([t(ctx, 'buttons.back')]);
        await ctx.reply(t(ctx, 'prompts.select_faq_category'), Markup.keyboard(faqKeyboard).resize());
        break;

      default:
        userStates.delete(user.telegramId);
        if (isStudent(user)) {
          await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
        } else {
          await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
        }
    }

    await logAction('user_pressed_back', { userId: user._id });
  } catch (error) {
    console.error('Error handling back button:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

/**
 * Handle "❓ Помощь" / "❓ Yordam" / "❓ Help" action
 */
const handleHelp = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    // Use the updated help handler that supports multiple languages
    const helpHandlers = require('./help');
    await helpHandlers.handleUserHelp(ctx);

    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));

    await logAction('user_viewed_help', { userId: user._id });
  } catch (error) {
    console.error('Error handling help:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
  }
};

module.exports = {
  handleAskQuestion,
  handleCategorySelection,
  handleRequestText,
  handleRequestConfirmation,
  handleEditRequest,
  handleMyRequests,
  handleFAQ,
  handleFAQCategorySelection,
  handleFAQSelection,
  handleBack,
  handleHelp,
  userStates
};