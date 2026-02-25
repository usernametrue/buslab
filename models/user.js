const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: Number,
    required: true,
    unique: true
  },
  role: {
    type: String,
    enum: ['user', 'student', 'admin'],
    default: 'user'
  },
  firstName: {
    type: String
  },
  lastName: {
    type: String
  },
  username: {
    type: String
  },
  language: {
    type: String,
    enum: ['ru', 'uz', 'en', 'kk'],
    default: 'ru'
  },
  isBanned: {
    type: Boolean,
    default: false
  },
  offerAccepted: {
    type: Boolean,
    default: false
  },
  currentAssignmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Request',
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('User', userSchema);