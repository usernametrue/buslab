const { getOrCreateUser, isAdmin } = require('./common');
const { logAction } = require('../logger');
const FAQ = require('../models/faq');
const Category = require('../models/category');

/**
 * Handle /faqs command - list all FAQs
 */
const handleListFAQs = async (ctx) => {
  try {
    const user = await getOrCreateUser(ctx);
    
    // Check if user is admin
    if (!isAdmin(user)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    
    const categories = await Category.find().sort({ name: 1 });
    
    if (categories.length === 0) {
      await ctx.reply('В базе данных нет категорий.');
      return;
    }
    
    let message = '📋 Список категорий FAQ:\n\n';
    
    for (const category of categories) {
      const faqs = await FAQ.find({ categoryId: category._id });
      
      message += `📁 ${category.name} (${category.hashtag}) - ${faqs.length} вопросов\n`;
      
      if (faqs.length > 0) {
        faqs.forEach((faq, index) => {
          // Truncate question if too long
          const question = faq.question.length > 50 
            ? faq.question.substring(0, 47) + '...' 
            : faq.question;
          
          message += `   ${index + 1}. ${question}\n`;
        });
        
        message += '\n';
      }
    }
    
    await ctx.reply(message);
    await logAction('admin_listed_faqs', { userId: user._id });
  } catch (error) {
    console.error('Error handling list FAQs:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте еще раз позже.');
  }
};

module.exports = {
  handleListFAQs
};