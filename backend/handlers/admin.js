const { Markup } = require('telegraf');
const User = require('../models/user');
const Request = require('../models/request');
const Category = require('../models/category');
const FAQ = require('../models/faq');
const { getOrCreateUser, isAdmin } = require('./common');
const { logAction } = require('../logger');
const { studentStates } = require('./student');

// Admin state management (in-memory for simplicity)
const adminStates = new Map();

/**
 * Delete old student chat message for a request
 */
const deleteStudentChatMessage = async (bot, request) => {
  if (!request.studentChatMessageId) return;
  try {
    await bot.telegram.deleteMessage(
      process.env.STUDENT_CHAT_ID,
      request.studentChatMessageId
    );
  } catch (err) {
    // Message may already be deleted or too old
    console.warn(`Failed to delete student chat message ${request.studentChatMessageId}:`, err.message);
  }
  request.studentChatMessageId = null;
};

/**
 * Send request to student chat and save message ID
 */
const sendToStudentChat = async (bot, request, label = '') => {
  const studentChatId = process.env.STUDENT_CHAT_ID;
  const labelText = label ? ` (${label})` : '';

  const studentMessage = `
📨 Обращение #${request._id}${labelText}
📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}

📝 Текст обращения:
${request.text}
`;

  const sent = await bot.telegram.sendMessage(studentChatId, studentMessage, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Взять в работу', callback_data: `take_request:${request._id}` }
        ]
      ]
    }
  });

  request.studentChatMessageId = sent.message_id;
  await request.save();

  return sent;
};

/**
 * Handle /getadmin command
 */
const handleGetAdmin = async (ctx) => {
  try {
    // Check if the command is from the admin chat
    if (ctx.chat.id.toString() !== process.env.ADMIN_CHAT_ID) {
      await ctx.reply('Эта команда доступна только в администраторском чате.');
      return;
    }

    const user = await getOrCreateUser(ctx);

    // Update user role to admin
    user.role = 'admin';
    await user.save();

    await ctx.reply(`Пользователь @${user.username || user.telegramId} получил права администратора.`);
    logAction('user_became_admin', { userId: user._id });
  } catch (error) {
    console.error('Error handling get admin command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle request approval
 */
const handleApproveRequest = async (ctx, bot) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];

    const request = await Request.findById(requestId)
      .populate('userId')
      .populate('categoryId');

    if (!request) {
      await ctx.answerCbQuery('Обращение не найдено.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    if (request.status !== 'pending') {
      await ctx.answerCbQuery('Это обращение уже обработано.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // IMMEDIATELY UPDATE THE CALLBACK MESSAGE TO REMOVE INLINE KEYBOARD
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n✅ Одобрено',
      { reply_markup: { inline_keyboard: [] } }
    );

    // Update request status
    request.status = 'approved';
    await request.save();

    // Notify user
    try {
      await bot.telegram.sendMessage(
        request.userId.telegramId,
        `✅ Ваше обращение по категории "${request.categoryId.name}" принято к обработке.`
      );
    } catch (notifyError) {
      console.error('Error notifying user about approved request:', notifyError);
    }

    // Send to student chat
    try {
      await sendToStudentChat(bot, request, 'новое');
    } catch (notifyError) {
      console.error('Error sending request to student chat:', notifyError);
    }

    await ctx.answerCbQuery('Обращение одобрено и отправлено исполнителям.');
    logAction('admin_approved_request', {
      adminId: ctx.from.id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling approve request:', error);
    // Try to remove buttons even on error
    try {
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n❗ Произошла ошибка при обработке',
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (editError) {
      // editMessageText may fail if already edited
    }
    try {
      await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    } catch (cbError) {
      // answerCbQuery may fail if already answered
    }
  }
};

/**
 * Handle request decline - initial step
 */
const handleDeclineRequest = async (ctx) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];

    const request = await Request.findById(requestId);

    if (!request) {
      await ctx.answerCbQuery('Обращение не найдено.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    if (request.status !== 'pending') {
      await ctx.answerCbQuery('Это обращение уже обработано.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // IMMEDIATELY UPDATE THE CALLBACK MESSAGE TO REMOVE INLINE KEYBOARD
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n⏳ Отклонение обращения...',
      { reply_markup: { inline_keyboard: [] } }
    );

    // Set admin state to entering decline reason
    const user = await getOrCreateUser(ctx);
    adminStates.set(user.telegramId, {
      state: 'entering_decline_reason',
      requestId
    });

    await ctx.answerCbQuery();
    await ctx.reply(
      `Введите причину отклонения обращения #${requestId}:`,
      Markup.forceReply()
    );
  } catch (error) {
    console.error('Error handling decline request:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle decline reason entry
 */
const handleDeclineReason = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_decline_reason') {
      await ctx.reply('Что-то пошло не так. Пожалуйста, начните заново.');
      return;
    }

    const requestId = adminState.requestId;
    const declineReason = ctx.message.text;

    const request = await Request.findById(requestId)
      .populate('userId')
      .populate('categoryId');

    if (!request) {
      await ctx.reply('Обращение не найдено.');
      adminStates.delete(user.telegramId);
      return;
    }

    if (request.status !== 'pending') {
      await ctx.reply('Это обращение уже обработано.');
      adminStates.delete(user.telegramId);
      return;
    }

    // Update request
    request.status = 'declined';
    request.adminComment = declineReason;
    await request.save();

    // Notify user
    await bot.telegram.sendMessage(
      request.userId.telegramId,
      `❌ Ваше обращение по категории "${request.categoryId.name}" отклонено.\n\nПричина: ${declineReason}`
    );

    // Send status message to admin chat (separate message)
    await bot.telegram.sendMessage(
      process.env.ADMIN_CHAT_ID,
      `❌ Обращение #${request._id} отклонено.\nПричина: ${declineReason}`
    );

    await ctx.reply(`Обращение #${request._id} успешно отклонено.`);
    adminStates.delete(user.telegramId);

    logAction('admin_declined_request', {
      adminId: user._id,
      requestId: request._id,
      reason: declineReason
    });
  } catch (error) {
    console.error('Error handling decline reason:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle approve student answer
 */
const handleApproveAnswer = async (ctx, bot) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];

    const request = await Request.findById(requestId)
      .populate('userId')
      .populate('categoryId')
      .populate('studentId');

    if (!request) {
      await ctx.answerCbQuery('Обращение не найдено.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

if (request.status !== 'answered') {
      await ctx.answerCbQuery('Это обращение находится в неправильном статусе.');
      // Update callback message to remove inline keyboard
      const statusText = request.status === 'closed'
        ? ctx.callbackQuery.message.text + '\n\n⚠️ Статус обращения: завершено'
        : ctx.callbackQuery.message.text + `\n\n⚠️ Статус обращения: ${request.status}`;
      await ctx.editMessageText(
        statusText,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // IMMEDIATELY UPDATE THE CALLBACK MESSAGE TO REMOVE INLINE KEYBOARD
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n✅ Одобрено и отправлено пользователю',
      { reply_markup: { inline_keyboard: [] } }
    );

    // Update request status
    request.status = 'closed';
    await request.save();

    // Update user's active assignment
    const student = request.studentId;
    student.currentAssignmentId = null;
    await student.save();

    // Notify user
    try {
      await bot.telegram.sendMessage(
        request.userId.telegramId,
        `✅ Ваш запрос по категории "${request.categoryId.name}" был обработан.\n\n📝 Ответ:\n${request.answerText}`
      );
    } catch (notifyError) {
      console.error('Error notifying user about approved answer:', notifyError);
    }

    // Notify student with main menu keyboard reset
    try {
      const { getMainMenuKeyboard } = require('./common');
      await bot.telegram.sendMessage(
        student.telegramId,
        `✅ Ваш ответ на обращение #${request._id} был одобрен и отправлен пользователю.`,
        getMainMenuKeyboard()
      );
    } catch (notifyError) {
      console.error('Error notifying student about approved answer:', notifyError);
    }

    await ctx.answerCbQuery('Ответ одобрен и отправлен пользователю.');
    logAction('admin_approved_answer', {
      adminId: ctx.from.id,
      requestId: request._id,
      studentId: student._id
    });
  } catch (error) {
    console.error('Error handling approve answer:', error);
    // Try to remove buttons even on error
    try {
      await ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n❗ Произошла ошибка при обработке',
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (editError) {
      // editMessageText may fail if already edited
    }
    try {
      await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
    } catch (cbError) {
      // answerCbQuery may fail if already answered
    }
  }
};

/**
 * Handle decline student answer - initial step
 */
const handleDeclineAnswer = async (ctx) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];

    const request = await Request.findById(requestId);

    if (!request) {
      await ctx.answerCbQuery('Обращение не найдено.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    if (request.status !== 'answered') {
      await ctx.answerCbQuery('Это обращение находится в неправильном статусе.');
      // Update callback message to remove inline keyboard
      const statusText = request.status === 'closed'
        ? ctx.callbackQuery.message.text + '\n\n⚠️ Статус обращения: завершено'
        : ctx.callbackQuery.message.text + `\n\n⚠️ Статус обращения: ${request.status}`;
      await ctx.editMessageText(
        statusText,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // IMMEDIATELY UPDATE THE CALLBACK MESSAGE TO REMOVE INLINE KEYBOARD
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n⏳ Отклонение ответа...',
      { reply_markup: { inline_keyboard: [] } }
    );

    // Set admin state to entering decline reason
    const user = await getOrCreateUser(ctx);
    adminStates.set(user.telegramId, {
      state: 'entering_answer_decline_reason',
      requestId
    });

    await ctx.answerCbQuery();
    await ctx.reply(
      `Введите комментарий к ответу на обращение #${requestId}:`,
      Markup.forceReply()
    );
  } catch (error) {
    console.error('Error handling decline answer:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle decline answer reason entry
 */
const handleAnswerDeclineReason = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_answer_decline_reason') {
      await ctx.reply('Что-то пошло не так. Пожалуйста, начните заново.');
      return;
    }

    const requestId = adminState.requestId;
    const declineReason = ctx.message.text;

    const request = await Request.findById(requestId)
      .populate('studentId')
      .populate('categoryId');

    if (!request) {
      await ctx.reply('Обращение не найдено.');
      adminStates.delete(user.telegramId);
      return;
    }

    if (request.status !== 'answered') {
      await ctx.reply('Это обращение находится в неправильном статусе.');
      adminStates.delete(user.telegramId);
      return;
    }

    // Update request
    request.adminComment = declineReason;
    await request.save();

    // Notify student with options
    await bot.telegram.sendMessage(
      request.studentId.telegramId,
      `❌ Ваш ответ на обращение #${request._id} по категории "${request.categoryId.name}" был отклонен.\n\nКомментарий: ${declineReason}\n\nВыберите действие:`,
      Markup.inlineKeyboard([
        [
          { text: '✏️ Отправить новый ответ', callback_data: `edit_answer:${request._id}` },
          { text: '❌ Отказаться от обращения', callback_data: `reject_assignment:${request._id}` }
        ]
      ])
    );

    // Send status message to admin chat (separate message)
    await bot.telegram.sendMessage(
      process.env.ADMIN_CHAT_ID,
      `❌ Ответ на обращение #${request._id} отклонен.\nПричина: ${declineReason}`
    );

    await ctx.reply(`Ответ на обращение #${request._id} успешно отклонен.`);
    adminStates.delete(user.telegramId);

    logAction('admin_declined_answer', {
      adminId: user._id,
      requestId: request._id,
      studentId: request.studentId._id,
      reason: declineReason
    });
  } catch (error) {
    console.error('Error handling answer decline reason:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /add_category command
 */
const handleAddCategory = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    // Set admin state to entering category name
    adminStates.set(user.telegramId, {
      state: 'entering_category_name'
    });

    await ctx.reply('Введите название новой категории:');
    logAction('admin_adding_category', { userId: user._id });
  } catch (error) {
    console.error('Error handling add category command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle category name entry
 */
const handleCategoryName = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_category_name') {
      return;
    }

    const categoryName = ctx.message.text;

    // Check if category already exists
    const existingCategory = await Category.findOne({ name: categoryName });
    if (existingCategory) {
      await ctx.reply('Категория с таким названием уже существует. Пожалуйста, выберите другое название.');
      return;
    }

    // Update admin state
    adminStates.set(user.telegramId, {
      state: 'entering_category_hashtag',
      categoryName
    });

    await ctx.reply('Введите хештег для категории (например, #гражданское):');
  } catch (error) {
    console.error('Error handling category name entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle category hashtag entry
 */
const handleCategoryHashtag = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_category_hashtag') {
      return;
    }

    let hashtag = ctx.message.text;

    // Ensure hashtag starts with #
    if (!hashtag.startsWith('#')) {
      hashtag = '#' + hashtag;
    }

    // Check if hashtag already exists
    const existingCategory = await Category.findOne({ hashtag });
    if (existingCategory) {
      await ctx.reply('Категория с таким хештегом уже существует. Пожалуйста, выберите другой хештег.');
      return;
    }

    // Create new category
    const category = new Category({
      name: adminState.categoryName,
      hashtag
    });

    await category.save();

    await ctx.reply(`✅ Категория "${category.name}" с хештегом ${category.hashtag} успешно создана!`);
    adminStates.delete(user.telegramId);

    logAction('admin_created_category', {
      adminId: user._id,
      categoryId: category._id,
      categoryName: category.name
    });
  } catch (error) {
    console.error('Error handling category hashtag entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /edit_category command
 */
const handleEditCategory = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }

    const keyboard = categories.map(category => [
      { text: `${category.name} (${category.hashtag})`, callback_data: `edit_category:${category._id}` }
    ]);

    await ctx.reply(
      'Выберите категорию для редактирования:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit category command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit category selection
 */
const handleEditCategorySelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCbQuery('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    // Set admin state
    adminStates.set(user.telegramId, {
      state: 'editing_category',
      categoryId
    });

    const keyboard = [
      [{ text: 'Изменить название', callback_data: `edit_category_name:${categoryId}` }],
      [{ text: 'Изменить хештег', callback_data: `edit_category_hashtag:${categoryId}` }],
      [{ text: 'Отмена', callback_data: 'cancel_edit_category' }]
    ];

    await ctx.answerCbQuery();
    await ctx.reply(
      `Редактирование категории: ${category.name} (${category.hashtag})`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit category selection:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit category name
 */
const handleEditCategoryName = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCbQuery('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    // Update admin state
    adminStates.set(user.telegramId, {
      state: 'entering_new_category_name',
      categoryId
    });

    await ctx.answerCbQuery();
    await ctx.reply(`Текущее название: ${category.name}\n\nВведите новое название категории:`);
  } catch (error) {
    console.error('Error handling edit category name:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle new category name entry
 */
const handleNewCategoryName = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_new_category_name') {
      return;
    }

    const newName = ctx.message.text;

    // Check if name already exists
    const existingCategory = await Category.findOne({ name: newName });
    if (existingCategory && existingCategory._id.toString() !== adminState.categoryId) {
      await ctx.reply('Категория с таким названием уже существует. Пожалуйста, выберите другое название.');
      return;
    }

    // Update category
    const category = await Category.findById(adminState.categoryId);
    if (!category) {
      await ctx.reply('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      adminStates.delete(user.telegramId);
      return;
    }

    const oldName = category.name;
    category.name = newName;
    await category.save();

    await ctx.reply(`✅ Название категории изменено с "${oldName}" на "${newName}".`);
    adminStates.delete(user.telegramId);

    logAction('admin_updated_category_name', {
      adminId: user._id,
      categoryId: category._id,
      oldName,
      newName
    });
  } catch (error) {
    console.error('Error handling new category name entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle edit category hashtag
 */
const handleEditCategoryHashtag = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCbQuery('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    // Update admin state
    adminStates.set(user.telegramId, {
      state: 'entering_new_category_hashtag',
      categoryId
    });

    await ctx.answerCbQuery();
    await ctx.reply(`Текущий хештег: ${category.hashtag}\n\nВведите новый хештег категории:`);
  } catch (error) {
    console.error('Error handling edit category hashtag:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle new category hashtag entry
 */
const handleNewCategoryHashtag = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_new_category_hashtag') {
      return;
    }

    let newHashtag = ctx.message.text;

    // Ensure hashtag starts with #
    if (!newHashtag.startsWith('#')) {
      newHashtag = '#' + newHashtag;
    }

    // Check if hashtag already exists
    const existingCategory = await Category.findOne({ hashtag: newHashtag });
    if (existingCategory && existingCategory._id.toString() !== adminState.categoryId) {
      await ctx.reply('Категория с таким хештегом уже существует. Пожалуйста, выберите другой хештег.');
      return;
    }

    // Update category
    const category = await Category.findById(adminState.categoryId);
    if (!category) {
      await ctx.reply('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      adminStates.delete(user.telegramId);
      return;
    }

    const oldHashtag = category.hashtag;
    category.hashtag = newHashtag;
    await category.save();

    await ctx.reply(`✅ Хештег категории изменен с "${oldHashtag}" на "${newHashtag}".`);
    adminStates.delete(user.telegramId);

    logAction('admin_updated_category_hashtag', {
      adminId: user._id,
      categoryId: category._id,
      oldHashtag,
      newHashtag
    });
  } catch (error) {
    console.error('Error handling new category hashtag entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /delete_category command
 */
const handleDeleteCategory = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }

    const keyboard = categories.map(category => [
      { text: `${category.name} (${category.hashtag})`, callback_data: `delete_category:${category._id}` }
    ]);

    await ctx.reply(
      'Выберите категорию для удаления:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete category command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle delete category selection
 */
const handleDeleteCategorySelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCbQuery('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // Check for active/pending requests (requests that are still being processed)
    const activeRequestsCount = await Request.countDocuments({ 
      categoryId, 
      status: { $in: ['pending', 'approved', 'assigned', 'answered'] } 
    });

    // Check total requests and FAQs for informational purposes
    const totalRequestsCount = await Request.countDocuments({ categoryId });
    const faqsCount = await FAQ.countDocuments({ categoryId });

    await ctx.editMessageText(
      ctx.callbackQuery.message.text,
      { reply_markup: { inline_keyboard: [] } }
    );

    // Prevent deletion if there are active requests
    if (activeRequestsCount > 0) {
      await ctx.answerCbQuery();
      await ctx.reply(
        `❌ Категория "${category.name}" не может быть удалена, так как есть ${activeRequestsCount} активных обращений. Завершите или отклоните их сначала.\n\n` +
        `Всего обращений в категории: ${totalRequestsCount}\n` +
        `FAQ в категории: ${faqsCount}`
      );
      return;
    }

    // Show warning about what will be deleted
    let warningMessage = `Вы уверены, что хотите удалить категорию "${category.name}" (${category.hashtag})?`;
    
    if (faqsCount > 0) {
      warningMessage += `\n\n⚠️ ВНИМАНИЕ: Будет удалено ${faqsCount} вопросов FAQ из этой категории.`;
    }
    
    if (totalRequestsCount > 0) {
      const closedRequestsCount = totalRequestsCount - activeRequestsCount;
      warningMessage += `\n\n📄 В категории есть ${closedRequestsCount} завершенных обращений (они останутся в базе данных).`;
    }

    const keyboard = [
      [
        { text: 'Да, удалить', callback_data: `confirm_delete_category:${categoryId}` },
        { text: 'Отмена', callback_data: 'cancel_delete_category' }
      ]
    ];

    await ctx.answerCbQuery();
    await ctx.reply(warningMessage, { reply_markup: { inline_keyboard: keyboard } });

  } catch (error) {
    console.error('Error handling delete category selection:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle delete category confirmation with cleanup
 */
const handleDeleteCategoryConfirmation = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCbQuery('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const categoryName = category.name;

    // Get counts for logging
    const requestsCount = await Request.countDocuments({ categoryId });
    const faqsCount = await FAQ.countDocuments({ categoryId });

    // Delete all associated FAQs
    if (faqsCount > 0) {
      await FAQ.deleteMany({ categoryId });
    }

    // For requests, you have options:
    // Option 1: Prevent deletion if there are active requests
    if (requestsCount > 0) {
      const activeRequestsCount = await Request.countDocuments({
        categoryId,
        status: { $in: ['pending', 'approved', 'assigned', 'answered'] }
      });

      if (activeRequestsCount > 0) {
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `❌ Категория "${categoryName}" не может быть удалена, так как есть ${activeRequestsCount} активных обращений. Завершите или отклоните их сначала.`,
          { reply_markup: { inline_keyboard: [] } }
        );
        return;
      }
    }

    const categoryDeleted = await Category.findByIdAndDelete(categoryId);
    if (categoryDeleted) {
      const user = await getOrCreateUser(ctx);
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `✅ Категория "${categoryName}" успешно удалена.`,
        { reply_markup: { inline_keyboard: [] } }
      );
      logAction('admin_deleted_category', {
        adminId: user._id,
        categoryName,
        deletedFAQs: faqsCount,
        existingRequests: requestsCount
      });
      return;
    }
  } catch (error) {
    console.error('Error handling delete category confirmation:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /add_faq command
 */
const handleAddFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    // Set admin state to entering FAQ question
    adminStates.set(user.telegramId, {
      state: 'entering_faq_question'
    });

    await ctx.reply('Введите вопрос для FAQ:');
    logAction('admin_adding_faq', { userId: user._id });
  } catch (error) {
    console.error('Error handling add FAQ command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle FAQ question entry
 */
const handleFAQQuestion = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_faq_question') {
      return;
    }

    const question = ctx.message.text;

    // Update admin state
    adminStates.set(user.telegramId, {
      state: 'entering_faq_answer',
      question
    });

    await ctx.reply('Введите ответ на вопрос:');
  } catch (error) {
    console.error('Error handling FAQ question entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle FAQ answer entry
 */
const handleFAQAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_faq_answer') {
      return;
    }

    const answer = ctx.message.text;

    // Update admin state
    adminStates.set(user.telegramId, {
      state: 'selecting_faq_category',
      question: adminState.question,
      answer
    });

    // Get categories for selection
    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий. Сначала создайте категорию с помощью команды /add_category.');
      adminStates.delete(user.telegramId);
      return;
    }

    const keyboard = categories.map(category => [
      { text: category.name, callback_data: `select_faq_category:${category._id}` }
    ]);

    await ctx.reply(
      'Выберите категорию для вопроса:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling FAQ answer entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle FAQ category selection by admin
 */
const handleFAQCategorySelectionAdmin = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCbQuery('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'selecting_faq_category') {
      await ctx.answerCbQuery('Что-то пошло не так. Пожалуйста, начните заново.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // Create new FAQ
    const faq = new FAQ({
      question: adminState.question,
      answer: adminState.answer,
      categoryId
    });

    await faq.save();

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `✅ Вопрос успешно добавлен в категорию "${category.name}".`,
      { reply_markup: { inline_keyboard: [] } }
    );

    adminStates.delete(user.telegramId);

    logAction('admin_created_faq', {
      adminId: user._id,
      faqId: faq._id,
      categoryId
    });
  } catch (error) {
    console.error('Error handling FAQ category selection:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle cancel buttons
 */
const handleCancel = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    // Clear admin state
    adminStates.delete(user.telegramId);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      'Операция отменена.',
      { reply_markup: { inline_keyboard: [] } }
    );
  } catch (error) {
    console.error('Error handling cancel:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

// Additional FAQ editing functions (continuing the pattern)
const handleEditFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }

    const keyboard = categories.map(category => [
      { text: category.name, callback_data: `edit_faq_select_category:${category._id}` }
    ]);

    await ctx.reply(
      'Выберите категорию для редактирования FAQ:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleEditFAQCategorySelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const faqs = await FAQ.find({ categoryId }).sort({ question: 1 });

    if (faqs.length === 0) {
      await ctx.answerCbQuery('В этой категории нет вопросов.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const keyboard = faqs.map(faq => [
      { text: faq.question.substring(0, 50), callback_data: `edit_faq:${faq._id}` }
    ]);

    await ctx.answerCbQuery();
    await ctx.reply(
      'Выберите вопрос для редактирования:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ category selection:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleEditFAQSelection = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];

    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCbQuery('Вопрос не найден.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const keyboard = [
      [{ text: 'Изменить вопрос', callback_data: `edit_faq_question:${faqId}` }],
      [{ text: 'Изменить ответ', callback_data: `edit_faq_answer:${faqId}` }],
      [{ text: 'Изменить категорию', callback_data: `edit_faq_category:${faqId}` }],
      [{ text: 'Отмена', callback_data: 'cancel_edit_faq' }]
    ];

    await ctx.answerCbQuery();
    await ctx.reply(
      `Редактирование вопроса: ${faq.question}`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ selection:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleEditFAQQuestion = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];

    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCbQuery('Вопрос не найден.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    adminStates.set(user.telegramId, {
      state: 'entering_new_faq_question',
      faqId
    });

    await ctx.answerCbQuery();
    await ctx.reply(`Текущий вопрос: ${faq.question}\n\nВведите новый вопрос:`);
  } catch (error) {
    console.error('Error handling edit FAQ question:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleNewFAQQuestion = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_new_faq_question') {
      return;
    }

    const newQuestion = ctx.message.text;

    const faq = await FAQ.findById(adminState.faqId);
    if (!faq) {
      await ctx.reply('Вопрос не найден.');
      adminStates.delete(user.telegramId);
      return;
    }

    const oldQuestion = faq.question;
    faq.question = newQuestion;
    await faq.save();

    await ctx.reply(`✅ Вопрос успешно обновлен.`);
    adminStates.delete(user.telegramId);

    logAction('admin_updated_faq_question', {
      adminId: user._id,
      faqId: faq._id,
      oldQuestion,
      newQuestion
    });
  } catch (error) {
    console.error('Error handling new FAQ question entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleEditFAQAnswer = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];

    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCbQuery('Вопрос не найден.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    adminStates.set(user.telegramId, {
      state: 'entering_new_faq_answer',
      faqId
    });

    await ctx.answerCbQuery();
    await ctx.reply(`Текущий ответ: ${faq.answer}\n\nВведите новый ответ:`);
  } catch (error) {
    console.error('Error handling edit FAQ answer:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleNewFAQAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    const adminState = adminStates.get(user.telegramId);

    if (!adminState || adminState.state !== 'entering_new_faq_answer') {
      return;
    }

    const newAnswer = ctx.message.text;

    const faq = await FAQ.findById(adminState.faqId);
    if (!faq) {
      await ctx.reply('Вопрос не найден.');
      adminStates.delete(user.telegramId);
      return;
    }

    const oldAnswer = faq.answer;
    faq.answer = newAnswer;
    await faq.save();

    await ctx.reply(`✅ Ответ успешно обновлен.`);
    adminStates.delete(user.telegramId);

    logAction('admin_updated_faq_answer', {
      adminId: user._id,
      faqId: faq._id
    });
  } catch (error) {
    console.error('Error handling new FAQ answer entry:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleEditFAQCategory = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];

    const faq = await FAQ.findById(faqId)
      .populate('categoryId');

    if (!faq) {
      await ctx.answerCbQuery('Вопрос не найден.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    const categories = await Category.find().sort({ name: 1 });

    if (categories.length <= 1) {
      await ctx.answerCbQuery('Недостаточно категорий для изменения.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    adminStates.set(user.telegramId, {
      state: 'selecting_new_faq_category',
      faqId
    });

    const keyboard = categories
      .filter(category => category._id.toString() !== faq.categoryId._id.toString())
      .map(category => [
        { text: category.name, callback_data: `set_faq_category:${faq._id}:${category._id}` }
      ]);

    await ctx.answerCbQuery();
    await ctx.reply(
      `Текущая категория: ${faq.categoryId.name}\n\nВыберите новую категорию:`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling edit FAQ category:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleSetFAQCategory = async (ctx) => {
  try {
    const parts = ctx.callbackQuery.data.split(':');
    const faqId = parts[1];
    const categoryId = parts[2];

    const faq = await FAQ.findById(faqId)
      .populate('categoryId');

    if (!faq) {
      await ctx.answerCbQuery('Вопрос не найден.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      await ctx.answerCbQuery('Категория не найдена.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const oldCategory = faq.categoryId;

    faq.categoryId = categoryId;
    await faq.save();

    const user = await getOrCreateUser(ctx);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `✅ Категория вопроса изменена с "${oldCategory.name}" на "${category.name}".`,
      { reply_markup: { inline_keyboard: [] } }
    );

    adminStates.delete(user.telegramId);

    logAction('admin_updated_faq_category', {
      adminId: user._id,
      faqId: faq._id,
      oldCategoryId: oldCategory._id,
      newCategoryId: categoryId
    });
  } catch (error) {
    console.error('Error handling set FAQ category:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleDeleteFAQ = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const categories = await Category.find().sort({ name: 1 });

    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const keyboard = categories.map(category => [
      { text: category.name, callback_data: `delete_faq_select_category:${category._id}` }
    ]);

    await ctx.reply(
      'Выберите категорию для удаления FAQ:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete FAQ command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleDeleteFAQSelection = async (ctx) => {
  try {
    const categoryId = ctx.callbackQuery.data.split(':')[1];

    const faqs = await FAQ.find({ categoryId }).sort({ question: 1 });

    if (faqs.length === 0) {
      await ctx.answerCbQuery('В этой категории нет вопросов.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const keyboard = faqs.map(faq => [
      { text: faq.question.substring(0, 50), callback_data: `delete_faq:${faq._id}` }
    ]);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      ctx.callbackQuery.message.text,
      { reply_markup: { inline_keyboard: [] } }
    );
    await ctx.reply(
      'Выберите вопрос для удаления:',
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete FAQ selection:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleDeleteFAQFromCategory = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];

    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCbQuery('Вопрос не найден.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const keyboard = [
      [
        { text: 'Да, удалить', callback_data: `confirm_delete_faq:${faqId}` },
        { text: 'Отмена', callback_data: 'cancel_delete_faq' }
      ]
    ];

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      ctx.callbackQuery.message.text,
      { reply_markup: { inline_keyboard: [] } }
    );
    await ctx.reply(
      `Вы уверены, что хотите удалить вопрос "${faq.question.substring(0, 50)}"?`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (error) {
    console.error('Error handling delete FAQ:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

const handleConfirmDeleteFAQ = async (ctx) => {
  try {
    const faqId = ctx.callbackQuery.data.split(':')[1];

    const faq = await FAQ.findById(faqId);
    if (!faq) {
      await ctx.answerCbQuery('Вопрос не найден.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // Store question text before deletion for logging
    const questionText = faq.question;

    // Delete the FAQ
    const deleteResult = await FAQ.deleteOne({ _id: faqId });

    // Check if deletion was successful
    if (deleteResult.deletedCount === 0) {
      console.error('FAQ deletion failed - no documents were deleted', { faqId });
      await ctx.answerCbQuery('Ошибка при удалении вопроса.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    // Answer the callback query first
    await ctx.answerCbQuery('Вопрос успешно удален.');

    // Edit the message to show deletion confirmation
    try {
      await ctx.editMessageText(
        `✅ Вопрос успешно удален.`,
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (editError) {
      // If editing fails, send a new message instead
      console.warn('Failed to edit message, sending new one:', editError.message);
      await ctx.reply('✅ Вопрос успешно удален.');
    }

    logAction('admin_deleted_faq', {
      adminId: user._id,
      question: questionText,
      faqId: faqId,
      deletedCount: deleteResult.deletedCount
    });
  } catch (error) {
    console.error('Error handling confirm delete FAQ:', error);
    await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /reopen command - reopen any request and send it back to student chat
 */
const handleReopenRequest = async (ctx, bot) => {
  try {
    // Check if the command is from the admin chat
    if (ctx.chat.id.toString() !== process.env.ADMIN_CHAT_ID) {
      await ctx.reply('Эта команда доступна только в администраторском чате.');
      return;
    }

    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    // Get request ID from command arguments
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      await ctx.reply('Использование: /reopen <ID обращения>');
      return;
    }

    const requestId = args[1].trim();

    const request = await Request.findById(requestId)
      .populate('userId')
      .populate('categoryId')
      .populate('studentId');

    if (!request) {
      await ctx.reply('Обращение не найдено.');
      return;
    }

    // Don't reopen requests that are already pending or approved
    if (request.status === 'pending' || request.status === 'approved') {
      await ctx.reply(`Обращение #${request._id} уже в статусе "${request.status}". Нет необходимости возвращать его в работу.`);
      return;
    }

    // If request was assigned/answered — clear student assignment and notify
    if ((request.status === 'assigned' || request.status === 'answered') && request.studentId) {
      const student = await User.findById(request.studentId._id || request.studentId);
      if (student && student.currentAssignmentId && student.currentAssignmentId.toString() === request._id.toString()) {
        student.currentAssignmentId = null;
        await student.save();
      }
      // Clear student in-memory state (writing_answer / confirming_answer)
      if (student) {
        studentStates.delete(student.telegramId);
      }

      // Notify student
      const studentTelegramId = request.studentId.telegramId || (student ? student.telegramId : null);
      if (studentTelegramId) {
        try {
          await bot.telegram.sendMessage(
            studentTelegramId,
            `⚠️ Обращение #${request._id} по категории "${request.categoryId.name}" было возвращено в очередь администратором. Оно снято с вашего назначения.`
          );
        } catch (notifyErr) {
          console.error('Error notifying student about reopen:', notifyErr);
        }
      }
    }

    const previousStatus = request.status;

// Reset request
    request.status = 'approved';
    request.studentId = null;
    request.answerText = null;
    request.adminComment = null;
    request.assignedAt = null;
    await request.save();

    // Send to student chat
    const studentChatId = process.env.STUDENT_CHAT_ID;
    const studentMessage = `
📨 Обращение #${request._id} (возвращено в очередь администратором)
📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}

📝 Текст обращения:
${request.text}
`;

    await bot.telegram.sendMessage(studentChatId, studentMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Взять в работу', callback_data: `take_request:${request._id}` }
          ]
        ]
      }
    });

    await ctx.reply(`✅ Обращение #${request._id} (было: ${previousStatus}) возвращено в очередь студентов.`);

    logAction('admin_reopened_request', {
      adminId: user._id,
      requestId: request._id,
      previousStatus
    });
  } catch (error) {
    console.error('Error handling reopen request:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /resend command - resend approved requests to student chat
 * Usage: /resend all - resend all approved requests
 *        /resend <requestId> - resend specific approved request
 */
const handleResendToStudents = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const args = ctx.message.text.split(' ');
    const arg = args[1];

    if (!arg) {
      await ctx.reply('Использование:\n/resend all — переотправить все approved обращения\n/resend <id> — переотправить конкретное обращение');
      return;
    }

    if (arg === 'all') {
      const approvedRequests = await Request.find({ status: 'approved' })
        .populate('categoryId')
        .sort({ createdAt: 1 });

      if (approvedRequests.length === 0) {
        await ctx.reply('Нет обращений со статусом "approved" для переотправки.');
        return;
      }

      let sentCount = 0;
      let errorCount = 0;

      for (const request of approvedRequests) {
        try {
          await deleteStudentChatMessage(bot, request);
          await sendToStudentChat(bot, request, 'повторная отправка');
          sentCount++;
        } catch (sendError) {
          console.error(`Error resending request #${request._id}:`, sendError);
          errorCount++;
        }
      }

      let resultMessage = `✅ Переотправлено: ${sentCount} из ${approvedRequests.length}.`;
      if (errorCount > 0) {
        resultMessage += `\n❌ Ошибок: ${errorCount}.`;
      }

      await ctx.reply(resultMessage);
      logAction('admin_resent_all_approved', { adminId: user._id, sentCount, errorCount });
    } else {
      const request = await Request.findById(arg)
        .populate('categoryId');

      if (!request) {
        await ctx.reply(`Обращение #${arg} не найдено.`);
        return;
      }

      if (request.status !== 'approved') {
        await ctx.reply(`Обращение #${arg} имеет статус "${request.status}", а не "approved". Переотправка невозможна.`);
        return;
      }

      await deleteStudentChatMessage(bot, request);
      await sendToStudentChat(bot, request, 'повторная отправка');

      await ctx.reply(`✅ Обращение #${request._id} переотправлено в студенческий чат.`);
      logAction('admin_resent_request', { adminId: user._id, requestId: request._id });
    }
  } catch (error) {
    console.error('Error handling resend command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

/**
 * Handle /unassign command - take back requests from students and return to queue
 * Usage: /unassign all - unassign all assigned requests
 *        /unassign all answered - unassign all assigned + answered requests
 *        /unassign <requestId> - unassign specific request (assigned or answered)
 */
const handleUnassign = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const args = ctx.message.text.split(' ');
    const arg = args[1];

    if (!arg) {
      await ctx.reply('Использование:\n/unassign all — забрать все assigned обращения\n/unassign all answered — забрать все assigned + answered\n/unassign <id> — забрать конкретное обращение');
      return;
    }

    if (arg === 'all') {
      const includeAnswered = args[2] === 'answered';
      const statuses = includeAnswered ? ['assigned', 'answered'] : ['assigned'];

      const activeRequests = await Request.find({ status: { $in: statuses } })
        .populate('studentId')
        .populate('categoryId')
        .sort({ createdAt: 1 });

      if (activeRequests.length === 0) {
        await ctx.reply(`Нет обращений со статусом ${statuses.map(s => `"${s}"`).join(', ')} для возврата в очередь.`);
        return;
      }

      let processedCount = 0;
      let errorCount = 0;
      const studentsToNotify = new Map();

      for (const request of activeRequests) {
        try {
          const student = request.studentId;

          if (student && !studentsToNotify.has(student._id.toString())) {
            studentsToNotify.set(student._id.toString(), student);
          }

          await deleteStudentChatMessage(bot, request);

          request.status = 'approved';
          request.studentId = null;
          request.answerText = null;
          await request.save();

          await sendToStudentChat(bot, request, 'возвращено в очередь');

          processedCount++;
        } catch (reqError) {
          console.error(`Error unassigning request #${request._id}:`, reqError);
          errorCount++;
        }
      }

      for (const [, student] of studentsToNotify) {
        try {
          student.currentAssignmentId = null;
          await student.save();

          await bot.telegram.sendMessage(
            student.telegramId,
            '⚠️ Все ваши обращения были отозваны администратором и возвращены в общую очередь.'
          );
        } catch (notifyError) {
          console.error(`Error notifying student ${student.telegramId}:`, notifyError);
        }
      }

      let resultMessage = `✅ Возвращено в очередь: ${processedCount} из ${activeRequests.length}.`;
      resultMessage += `\n👥 Затронуто студентов: ${studentsToNotify.size}.`;
      if (errorCount > 0) {
        resultMessage += `\n❌ Ошибок: ${errorCount}.`;
      }

      await ctx.reply(resultMessage);
      logAction('admin_unassigned_all', { adminId: user._id, processedCount, errorCount, studentsAffected: studentsToNotify.size, includeAnswered });
    } else {
      const request = await Request.findById(arg)
        .populate('studentId')
        .populate('categoryId');

      if (!request) {
        await ctx.reply(`Обращение #${arg} не найдено.`);
        return;
      }

      if (request.status !== 'assigned' && request.status !== 'answered') {
        await ctx.reply(`Обращение #${arg} имеет статус "${request.status}". Забрать можно только "assigned" или "answered".`);
        return;
      }

      const student = request.studentId;
      const studentName = student ? (student.username ? `@${student.username}` : student.telegramId) : 'неизвестен';

      if (student) {
        student.currentAssignmentId = null;
        await student.save();

        try {
          await bot.telegram.sendMessage(
            student.telegramId,
            `⚠️ Обращение #${request._id} по категории "${request.categoryId.name}" было отозвано администратором и возвращено в общую очередь.`
          );
        } catch (notifyError) {
          console.error(`Error notifying student about unassign:`, notifyError);
        }
      }

      await deleteStudentChatMessage(bot, request);

      request.status = 'approved';
      request.studentId = null;
      request.answerText = null;
      await request.save();

      await sendToStudentChat(bot, request, 'возвращено в очередь');

      await ctx.reply(`✅ Обращение #${request._id} забрано у ${studentName} и возвращено в очередь.`);
      logAction('admin_unassigned_request', { adminId: user._id, requestId: request._id, studentId: student?._id });
    }
  } catch (error) {
    console.error('Error handling unassign command:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

module.exports = {
  handleGetAdmin,
  handleApproveRequest,
  handleDeclineRequest,
  handleDeclineReason,
  handleApproveAnswer,
  handleDeclineAnswer,
  handleAnswerDeclineReason,
  handleAddCategory,
  handleCategoryName,
  handleCategoryHashtag,
  handleEditCategory,
  handleEditCategorySelection,
  handleEditCategoryName,
  handleNewCategoryName,
  handleEditCategoryHashtag,
  handleNewCategoryHashtag,
  handleDeleteCategory,
  handleDeleteCategorySelection,
  handleDeleteCategoryConfirmation,
  handleAddFAQ,
  handleFAQQuestion,
  handleFAQAnswer,
  handleFAQCategorySelectionAdmin,
  handleEditFAQ,
  handleEditFAQCategorySelection,
  handleEditFAQSelection,
  handleEditFAQQuestion,
  handleNewFAQQuestion,
  handleEditFAQAnswer,
  handleNewFAQAnswer,
  handleEditFAQCategory,
  handleSetFAQCategory,
  handleDeleteFAQ,
  handleDeleteFAQSelection,
  handleDeleteFAQFromCategory,
  handleConfirmDeleteFAQ,
  handleCancel,
  handleReopenRequest,
  handleResendToStudents,
  handleUnassign,
  adminStates
};