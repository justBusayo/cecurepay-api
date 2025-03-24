const mongoose = require("mongoose")

const TransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  transactionType: {
    type: String,
    enum: ["send", "receive", "deposit", "withdraw", "wishlist"],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  fee: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ["pending", "successful", "failed", "declined"],
    default: "pending",
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  recipientName: {
    type: String,
  },
  recipientCecureTag: {
    type: String,
  },
  recipientBank: {
    type: String,
  },
  recipientAccount: {
    type: String,
  },
  purpose: {
    type: String,
  },
  reference: {
    type: String,
    required: true,
    unique: true,
  },
  stripePaymentIntentId: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

module.exports = mongoose.model("Transaction", TransactionSchema)

