const mongoose = require("mongoose")

const CardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  cardNumber: {
    type: String,
    required: true,
  },
  cardHolder: {
    type: String,
    required: true,
  },
  expiryDate: {
    type: String,
    required: true,
  },
  cardType: {
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

// Only store last 4 digits of card number for security
CardSchema.pre("save", function (next) {
  if (this.isModified("cardNumber")) {
    // Store only last 4 digits
    this.cardNumber = this.cardNumber.slice(-4).padStart(16, "*")
  }
  next()
})

module.exports = mongoose.model("Card", CardSchema)

