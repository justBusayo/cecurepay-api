const mongoose = require("mongoose")

const BeneficiarySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  recipientName: {
    type: String,
    required: true,
  },
  bankName: {
    type: String,
  },
  accountNumber: {
    type: String,
  },
  transferType: {
    type: String,
    enum: ["bank", "cecure"],
    required: true,
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  cecureTag: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

module.exports = mongoose.model("Beneficiary", BeneficiarySchema)

