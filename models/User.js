const mongoose = require("mongoose")
const bcrypt = require("bcryptjs")

const UserSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
  },
  cecureTag: {
    type: String,
    unique: true,
  },
  balance: {
    type: Number,
    default: 0, // Starting balance for testing
  },
  accountNumber: {
    type: String,
    unique: true,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  paystackCustomerCode: {
    type: String,
  },
  paystackSubaccountCode: {
    type: String,
  },
  paystackVirtualAccountNumber: {
    type: String,
  },
  paystackVirtualBankName: {
    type: String,
  },
  paystackTransferRecipientCode: {
    type: String,
  },
  businessName: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

// Hash password before saving
UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    return next()
  }

  try {
    const salt = await bcrypt.genSalt(10)
    this.password = await bcrypt.hash(this.password, salt)
    next()
  } catch (error) {
    next(error)
  }
})

// Generate cecureTag and accountNumber if not provided
UserSchema.pre("save", function (next) {
  if (!this.cecureTag) {
    this.cecureTag = `@${this.firstName.toLowerCase()}${this.lastName.toLowerCase()}${Math.floor(Math.random() * 1000)}`
  }

  if (!this.accountNumber) {
    this.accountNumber = Math.floor(10000000 + Math.random() * 90000000).toString()
  }

  next()
})

// Method to compare password
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password)
}

module.exports = mongoose.model("User", UserSchema)
