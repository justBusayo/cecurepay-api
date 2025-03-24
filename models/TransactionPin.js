const mongoose = require("mongoose")
const bcrypt = require("bcryptjs")

const TransactionPinSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  pinHash: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
})

// Hash PIN before saving
TransactionPinSchema.pre("save", async function (next) {
  if (!this.isModified("pinHash")) {
    return next()
  }

  try {
    const salt = await bcrypt.genSalt(10)
    this.pinHash = await bcrypt.hash(this.pinHash, salt)
    next()
  } catch (error) {
    next(error)
  }
})

// Method to compare PIN
TransactionPinSchema.methods.comparePin = async function (candidatePin) {
  return await bcrypt.compare(candidatePin, this.pinHash)
}

module.exports = mongoose.model("TransactionPin", TransactionPinSchema)

