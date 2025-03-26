const mongoose = require("mongoose")

const CardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  last4: {
    type: String,
    required: true,
  },
  cardType: {
    type: String,
    required: true,
  },
  expiryMonth: {
    type: String,
    required: true,
  },
  expiryYear: {
    type: String,
    required: true,
  },
  bin: {
    type: String,
  },
  bank: {
    type: String,
  },
  cardHolder: {
    type: String,
    required: true,
  },
  paystackAuthCode: {
    type: String,
    required: true,
  },
  paystackCustomerCode: {
    type: String,
    required: true,
  },
  isPrimary: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

module.exports = mongoose.model("Card", CardSchema)
