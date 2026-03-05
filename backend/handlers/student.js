const { Markup } = require('telegraf');
const User = require('../models/user');
const Request = require('../models/request');
const { isStudent, getOrCreateUser, getStudentMenuKeyboard, canTakeRequests, isGroupChat } = require('./common');
const { logAction, logWarn } = require('../logger');
const { t } = require('../utils/i18nHelper');

// Student state management (in-memory for simplicity)
const studentStates = new Map();

/**
 * Handle "Взять в работу" button
 */
const handleTakeRequest = async (ctx, bot) => {
  try {
    // Check if user is in student chat
    if (!canTakeRequests(ctx)) {
      await ctx.answerCbQuery('Эта функция доступна только в студенческом чате.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const requestId = ctx.callbackQuery.data.split(':')[1];

    // Get request
    const request = await Request.findById(requestId)
      .populate('categoryId');

    if (!request) {
      await ctx.answerCbQuery('Обращение не найдено.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    if (request.status !== 'approved') {
      await ctx.answerCbQuery('Это обращение уже взято в работу или находится в другом статусе.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    // *** AUTO-ASSIGN STUDENT ROLE IF NOT ALREADY SET ***
    if (user.role === 'user') {
      user.role = 'student';
      await user.save();
      logAction('user_auto_became_student', { userId: user._id });
    }

    // Check if user already has an active assignment
    if (user.currentAssignmentId) {
      await ctx.answerCbQuery(t(ctx, 'errors.already_has_assignment'));
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

// Update request with student
    request.status = 'assigned';
    request.studentId = user._id;
    request.assignedAt = new Date();
    await request.save();

    // Update user with active assignment
    user.currentAssignmentId = request._id;
    await user.save();

    // Update message in student chat (clear tracked message ID since we're editing it)
    request.studentChatMessageId = null;
    await request.save();

    const studentName = user.username ? `@${user.username}` : `${user.firstName || 'Студент'} ${user.lastName || ''}`;
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + `\n\nПринято в работу: ${studentName}`,
      { reply_markup: { inline_keyboard: [] } }
    );

    // Send request details to student in private chat (in Russian)
    const detailMessage = `
📨 Обращение #${request._id}
📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}

📝 Текст обращения:
${request.text}

Введите ваш ответ на это обращение и отправьте его. После этого нажмите кнопку "Подтвердить отправку ответа".
`;

    await bot.telegram.sendMessage(
      user.telegramId,
      detailMessage,
      Markup.keyboard([
        ['Подтвердить отправку ответа'],
        ['Изменить ответ'],
        ['Отказаться от обращения']
      ]).resize()
    );

    // Set student state to writing answer
    studentStates.set(user.telegramId, {
      state: 'writing_answer',
      requestId: request._id
    });

    await ctx.answerCbQuery('Обращение взято в работу. Проверьте личные сообщения.');
    logAction('student_took_request', {
      studentId: user._id,
      requestId: request._id,
      autoPromoted: user.role === 'student'
    });
  } catch (error) {
    console.error('Error handling take request:', error);
    await ctx.answerCbQuery(t(ctx, 'errors.general'));
  }
};

/**
 * Handle "Мои ответы" / "Mening javoblarim" action for students
 */
const handleMyAnswers = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isStudent(user)) {
      await ctx.reply(t(ctx, 'errors.student_only'));
      return;
    }

    // Get all requests handled by this student
    const requests = await Request.find({ studentId: user._id })
      .sort({ updatedAt: -1 })
      .populate('categoryId')
      .populate('userId');

    if (requests.length === 0) {
      await ctx.reply('Вы пока не обработали ни одного обращения.');
      if (!isGroupChat(ctx)) {
        await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
      }
      return;
    }

    let message = '📋 Ваши ответы на обращения:\n\n';

    requests.forEach((request, index) => {
      const date = request.updatedAt.toLocaleDateString('ru-RU');
      const userInfo = request.userId.username
        ? `@${request.userId.username}`
        : `ID:${request.userId.telegramId}`;

      message += `${index + 1}. ${request.categoryId.name} - ${t(ctx, `statuses.${request.status}`)}\n`;
      message += `   Пользователь: ${userInfo}\n`;
      message += `   ${t(ctx, 'lists.request_date')} ${date}\n`;

      if (request.answerText) {
        const truncatedAnswer = request.answerText.length > 150
          ? request.answerText.substring(0, 147) + '...'
          : request.answerText;
        message += `   ${t(ctx, 'lists.answer_label')} ${truncatedAnswer}\n`;
      }

      if (request.adminComment) {
        message += `   💬 Комментарий администратора: ${request.adminComment}\n`;
      }

      message += '\n';
    });

    await ctx.reply(message);
    if (!isGroupChat(ctx)) {
      await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
    }

    await logAction('student_viewed_answers', { userId: user._id });
  } catch (error) {
    console.error('Error handling student answers:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    if (!isGroupChat(ctx)) {
      await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
    }
  }
};

/**
 * Handle "Текущее обращение" / "Joriy murojaat" action for students
 */
const handleCurrentAssignment = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isStudent(user)) {
      await ctx.reply(t(ctx, 'errors.student_only'));
      return;
    }

    if (!user.currentAssignmentId) {
      await ctx.reply(t(ctx, 'errors.no_active_assignment'));
      await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
      return;
    }

    const request = await Request.findById(user.currentAssignmentId)
      .populate('categoryId')
      .populate('userId');

    if (!request) {
      await ctx.reply('Текущее обращение не найдено.');
      // Clear invalid assignment
      user.currentAssignmentId = null;
      await user.save();
      await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
      return;
    }

    const userInfo = request.userId.username
      ? `@${request.userId.username}`
      : `ID:${request.userId.telegramId}`;

    let message = `📨 Текущее обращение #${request._id}\n`;
    message += `📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}\n`;
    message += `👤 Пользователь: ${userInfo}\n`;
    message += `📊 Статус: ${t(ctx, `statuses.${request.status}`)}\n`;
    message += `📅 Дата получения: ${request.createdAt.toLocaleDateString('ru-RU')}\n\n`;
    message += `📝 Текст обращения:\n${request.text}\n`;

    if (request.answerText) {
      message += `\n✏️ Ваш ответ:\n${request.answerText}`;
    }

    if (request.adminComment) {
      message += `\n💬 Комментарий администратора:\n${request.adminComment}`;
    }

    await ctx.reply(message);

    // Show appropriate keyboard based on status
    if (request.status === 'assigned') {
      await ctx.reply(t(ctx, 'lists.select_action'), Markup.keyboard([
        [t(ctx, 'buttons.reject_assignment')],
        [t(ctx, 'buttons.back')]
      ]).resize());
    } else {
      await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
    }

    await logAction('student_viewed_current_assignment', {
      userId: user._id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling current assignment:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
  }
};

/**
 * Handle "Статистика" / "Statistika" action for students
 */
const handleStudentStats = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!isStudent(user)) {
      await ctx.reply(t(ctx, 'errors.student_only'));
      return;
    }

    const totalAssigned = await Request.countDocuments({ studentId: user._id });
    const inProgress = await Request.countDocuments({
      studentId: user._id,
      status: 'assigned'
    });
    const awaitingReview = await Request.countDocuments({
      studentId: user._id,
      status: 'answered'
    });
    const completed = await Request.countDocuments({
      studentId: user._id,
      status: 'closed'
    });

    let message = `📊 Ваша статистика:\n\n`;
    message += `📨 Всего обращений: ${totalAssigned}\n`;
    message += `🔄 В работе: ${inProgress}\n`;
    message += `✅ На проверке: ${awaitingReview}\n`;
    message += `✅ Завершено: ${completed}\n`;

    if (totalAssigned > 0) {
      const completionRate = ((completed / totalAssigned) * 100).toFixed(1);
      message += `\n📈 Процент завершения: ${completionRate}%`;
    }

    await ctx.reply(message);
    await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));

    await logAction('student_viewed_stats', { userId: user._id });
  } catch (error) {
    console.error('Error handling student stats:', error);
    await ctx.reply(t(ctx, 'errors.general'));
    await ctx.reply(t(ctx, 'lists.select_action'), getStudentMenuKeyboard(ctx));
  }
};

/**
 * Handle student answer
 */
const handleStudentAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!user.currentAssignmentId) {
      return; // No active assignment
    }

    const studentState = studentStates.get(user.telegramId);
    if (!studentState || studentState.state !== 'writing_answer') {
      return;
    }

    const answerText = ctx.message.text;

    // Update student state
    studentStates.set(user.telegramId, {
      state: 'confirming_answer',
      requestId: studentState.requestId,
      answerText
    });

    await ctx.reply(
      t(ctx, 'prompts.check_answer') + '\n\n' + answerText,
      Markup.keyboard([
        [t(ctx, 'buttons.confirm_answer')],
        [t(ctx, 'buttons.edit_answer')],
        [t(ctx, 'buttons.reject_assignment')]
      ]).resize()
    );
  } catch (error) {
    console.error('Error handling student answer:', error);
    await ctx.reply(t(ctx, 'errors.general'));
  }
};

/**
 * Handle "Подтвердить отправку ответа" / "Javob yuborishni tasdiqlash" button
 */
const handleConfirmAnswer = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!user.currentAssignmentId) {
      await ctx.reply(t(ctx, 'errors.no_active_assignment'));
      return;
    }

    const studentState = studentStates.get(user.telegramId);
    if (!studentState || studentState.state !== 'confirming_answer') {
      await ctx.reply('Сначала напишите ответ на обращение.');
      return;
    }

    const request = await Request.findById(studentState.requestId)
      .populate('categoryId');

    if (!request) {
      await ctx.reply('Обращение не найдено.');
      return;
    }

    // Update request with answer
    request.status = 'answered';
    request.answerText = studentState.answerText;
    await request.save();

    // Send answer to admin chat for approval
    const adminChatId = process.env.ADMIN_CHAT_ID;
    const adminMessage = `
📨 Ответ на обращение #${request._id}
📂 Категория: ${request.categoryId.name} ${request.categoryId.hashtag}
👨‍💼 Исполнитель: ${user.username ? `@${user.username}` : user.telegramId}

📝 Текст обращения:
${request.text}

✏️ Ответ:
${request.answerText}
`;

    await bot.telegram.sendMessage(adminChatId, adminMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Подтвердить', callback_data: `approve_answer:${request._id}` },
            { text: '❌ Отклонить', callback_data: `decline_answer:${request._id}` }
          ]
        ]
      }
    });

    await ctx.reply('Ваш ответ отправлен на проверку администратору. Вы получите уведомление, когда ответ будет проверен.');
    studentStates.delete(user.telegramId);

    logAction('student_submitted_answer', {
      studentId: user._id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling confirm answer:', error);
    await ctx.reply(t(ctx, 'errors.general'));
  }
};

/**
 * Handle "Изменить ответ" / "Javobni o'zgartirish" button
 */
const handleEditAnswer = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!user.currentAssignmentId) {
      await ctx.reply(t(ctx, 'errors.no_active_assignment'));
      return;
    }

    const studentState = studentStates.get(user.telegramId);
    if (!studentState) {
      return;
    }

    // Update student state
    studentStates.set(user.telegramId, {
      state: 'writing_answer',
      requestId: studentState.requestId
    });

    await ctx.reply(
      'Введите ваш ответ заново:',
      Markup.keyboard([
        [t(ctx, 'buttons.reject_assignment')]
      ]).resize()
    );
  } catch (error) {
    console.error('Error handling edit answer:', error);
    await ctx.reply(t(ctx, 'errors.general'));
  }
};

/**
 * Handle edit answer callback
 */
const handleEditAnswerCallback = async (ctx) => {
  try {
    const requestId = ctx.callbackQuery.data.split(':')[1];

    const request = await Request.findById(requestId)
      .populate('categoryId');

    if (!request) {
      await ctx.answerCbQuery('Обращение не найдено.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    const user = await getOrCreateUser(ctx);

    if (request.studentId.toString() !== user._id.toString()) {
      await ctx.answerCbQuery('Это обращение назначено другому исполнителю.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // Update student state
    studentStates.set(user.telegramId, {
      state: 'writing_answer',
      requestId: request._id
    });

    await ctx.answerCbQuery();
    await ctx.reply(
      'Введите ваш ответ заново:',
      Markup.keyboard([
        [t(ctx, 'buttons.reject_assignment')]
      ]).resize()
    );
  } catch (error) {
    console.error('Error handling edit answer callback:', error);
    await ctx.answerCbQuery(t(ctx, 'errors.general'));
  }
};

/**
 * Handle "Отказаться от обращения" / "Murojaatdan voz kechish" button or callback
 */
const handleRejectAssignment = async (ctx, bot) => {
  try {
    const user = await getOrCreateUser(ctx);

    if (!user.currentAssignmentId) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(t(ctx, 'errors.no_active_assignment'));
        await ctx.editMessageText(
          ctx.callbackQuery.message.text,
          { reply_markup: { inline_keyboard: [] } }
        );
      } else {
        await ctx.reply(t(ctx, 'errors.no_active_assignment'));
      }
      return;
    }

    let requestId;

    // Handle both text button and callback
    if (ctx.callbackQuery) {
      requestId = ctx.callbackQuery.data.split(':')[1];
      await ctx.answerCbQuery();
    } else {
      requestId = user.currentAssignmentId;
    }

    const request = await Request.findById(requestId)
      .populate('categoryId');

    if (!request) {
      await ctx.reply('Обращение не найдено.');
      await ctx.editMessageText(
        ctx.callbackQuery.message.text,
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // Update request and user
    request.status = 'approved';
    request.studentId = null;
    request.assignedAt = null;
    await request.save();

    user.currentAssignmentId = null;
    await user.save();

    // Send back to student chat and track message ID
    const studentChatId = process.env.STUDENT_CHAT_ID;
    const studentMessage = `
📨 Обращение #${request._id} (возвращено в очередь)
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

    // Reset to main menu keyboard
    const { getMainMenuKeyboard } = require('./common');
    if (ctx.callbackQuery) {
      await ctx.reply('Вы отказались от обращения. Оно возвращено в общую очередь.');
    } else {
      await ctx.reply('Вы отказались от обращения. Оно возвращено в общую очередь.');
    }

    await ctx.reply(t(ctx, 'lists.select_action'), getMainMenuKeyboard(ctx));
    studentStates.delete(user.telegramId);

    logAction('student_rejected_assignment', {
      studentId: user._id,
      requestId: request._id
    });
  } catch (error) {
    console.error('Error handling reject assignment:', error);
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(t(ctx, 'errors.general'));
    } else {
      await ctx.reply(t(ctx, 'errors.general'));
    }
  }
};

module.exports = {
  handleTakeRequest,
  handleStudentAnswer,
  handleConfirmAnswer,
  handleEditAnswer,
  handleEditAnswerCallback,
  handleRejectAssignment,
  handleMyAnswers,
  handleCurrentAssignment,
  handleStudentStats,
  studentStates
};