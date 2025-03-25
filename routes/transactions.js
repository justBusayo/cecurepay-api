const express = require("express")
const router = express.Router()
const { check, validationResult } = require("express-validator")
const mongoose = require("mongoose")
const User = require("../models/User")
const Transaction = require("../models/Transaction")
const TransactionPin = require("../models/TransactionPin")
const Beneficiary = require("../models/Beneficiary")
const auth = require("../middleware/auth")
const { v4: uuidv4 } = require("uuid")

// @route   GET api/transactions
// @desc    Get user's transactions
// @access  Private
router.get("/", auth, async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit) || 10
    const transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(limit)

    res.json(transactions)
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   GET api/transactions/search
// @desc    Search user's transactions
// @access  Private
router.get("/search", auth, async (req, res) => {
  try {
    const { query, type, dateRange, amountRange } = req.query

    const filter = { userId: req.user.id }

    // Apply search query if provided
    if (query) {
      filter.$or = [
        { purpose: { $regex: query, $options: "i" } },
        { recipientName: { $regex: query, $options: "i" } },
        { recipientCecureTag: { $regex: query, $options: "i" } },
        { reference: { $regex: query, $options: "i" } },
      ]
    }

    // Apply transaction type filter
    if (type && type !== "all") {
      filter.transactionType = type
    }

    // Apply date range filter
    if (dateRange && dateRange !== "all") {
      const now = new Date()
      let startDate

      if (dateRange === "today") {
        startDate = new Date(now.setHours(0, 0, 0, 0))
      } else if (dateRange === "week") {
        startDate = new Date(now.setDate(now.getDate() - 7))
      } else if (dateRange === "month") {
        startDate = new Date(now.setMonth(now.getMonth() - 1))
      }

      if (startDate) {
        filter.createdAt = { $gte: startDate }
      }
    }

    // Apply amount range filter
    if (amountRange && amountRange !== "all") {
      if (amountRange === "small") {
        filter.amount = { $lt: 1000 }
      } else if (amountRange === "medium") {
        filter.amount = { $gte: 1000, $lt: 5000 }
      } else if (amountRange === "large") {
        filter.amount = { $gte: 5000 }
      }
    }

    const transactions = await Transaction.find(filter).sort({ createdAt: -1 })

    res.json(transactions)
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   POST api/transactions/transfer
// @desc    Transfer money to another user
// @access  Private
router.post(
  "/transfer",
  [
    auth,
    check("recipientId", "Recipient ID is required").not().isEmpty(),
    check("amount", "Amount is required").isNumeric(),
    check("pin", "Transaction PIN is required").not().isEmpty(),
    check("purpose", "Purpose is required").not().isEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      const { recipientId, amount, purpose, pin } = req.body
      const fee = 25 // Fixed fee for transfers

      // Verify transaction PIN
      const transactionPin = await TransactionPin.findOne({ userId: req.user.id })
      if (!transactionPin) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Transaction PIN not set" })
      }

      const isPinValid = await transactionPin.comparePin(pin)
      if (!isPinValid) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Invalid transaction PIN" })
      }

      // Get sender's profile
      const sender = await User.findById(req.user.id)
      if (!sender) {
        await session.abortTransaction()
        session.endSession()
        return res.status(404).json({ message: "Sender not found" })
      }

      // Check if sender has enough balance
      if (sender.balance < Number.parseFloat(amount) + fee) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Insufficient balance" })
      }

      // Get recipient's profile
      const recipient = await User.findById(recipientId)
      if (!recipient) {
        await session.abortTransaction()
        session.endSession()
        return res.status(404).json({ message: "Recipient not found" })
      }

      // Create a unique reference
      const reference = `TRX-${uuidv4().substring(0, 8)}`

      // Update sender's balance
      sender.balance -= Number.parseFloat(amount) + fee
      await sender.save({ session })

      // Update recipient's balance
      recipient.balance += Number.parseFloat(amount)
      await recipient.save({ session })

      // Create transaction record for sender
      const senderTransaction = new Transaction({
        userId: sender._id,
        transactionType: "send",
        amount: Number.parseFloat(amount),
        fee,
        status: "successful",
        recipientId: recipient._id,
        recipientName: `${recipient.firstName} ${recipient.lastName}`,
        recipientCecureTag: recipient.cecureTag,
        purpose,
        reference,
      })

      await senderTransaction.save({ session })

      // Create transaction record for recipient
      const recipientTransaction = new Transaction({
        userId: recipient._id,
        transactionType: "receive",
        amount: Number.parseFloat(amount),
        fee: 0,
        status: "successful",
        recipientId: sender._id,
        recipientName: `${sender.firstName} ${sender.lastName}`,
        purpose,
        reference: `${reference}-RCV`,
      })

      await recipientTransaction.save({ session })

      await session.commitTransaction()
      session.endSession()

      res.json({ success: true, reference })
    } catch (err) {
      await session.abortTransaction()
      session.endSession()
      console.error(err.message)
      res.status(500).send("Server error")
    }
  },
)

// @route   POST api/transactions/bank-transfer
// @desc    Transfer money to a bank account
// @access  Private
router.post(
  "/bank-transfer",
  [
    auth,
    check("bankDetails", "Bank details are required").not().isEmpty(),
    check("amount", "Amount is required").isNumeric(),
    check("pin", "Transaction PIN is required").not().isEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      const { bankDetails, amount, pin } = req.body
      const fee = 25 // Fixed fee for bank transfers

      // Verify transaction PIN
      const transactionPin = await TransactionPin.findOne({ userId: req.user.id })
      if (!transactionPin) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Transaction PIN not set" })
      }

      const isPinValid = await transactionPin.comparePin(pin)
      if (!isPinValid) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Invalid transaction PIN" })
      }

      // Get user's profile
      const user = await User.findById(req.user.id)
      if (!user) {
        await session.abortTransaction()
        session.endSession()
        return res.status(404).json({ message: "User not found" })
      }

      // Check if user has enough balance
      if (user.balance < Number.parseFloat(amount) + fee) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Insufficient balance" })
      }

      // Create a unique reference
      const reference = `BNK-${uuidv4().substring(0, 8)}`

      // Update user's balance
      user.balance -= Number.parseFloat(amount) + fee
      await user.save({ session })

      // Create transaction record
      const transaction = new Transaction({
        userId: user._id,
        transactionType: "send",
        amount: Number.parseFloat(amount),
        fee,
        status: "successful",
        recipientName: bankDetails.accountName,
        recipientBank: bankDetails.bankName,
        recipientAccount: bankDetails.accountNumber,
        purpose: "Bank Transfer",
        reference,
      })

      await transaction.save({ session })

      // Save beneficiary if requested
      if (bankDetails.saveBeneficiary) {
        const beneficiary = new Beneficiary({
          userId: user._id,
          recipientName: bankDetails.accountName,
          bankName: bankDetails.bankName,
          accountNumber: bankDetails.accountNumber,
          transferType: "bank",
        })

        await beneficiary.save({ session })
      }

      await session.commitTransaction()
      session.endSession()

      res.json({ success: true, reference })
    } catch (err) {
      await session.abortTransaction()
      session.endSession()
      console.error(err.message)
      res.status(500).send("Server error")
    }
  },
)

// @route   POST api/transactions/withdraw
// @desc    Withdraw money to a bank account
// @access  Private
router.post(
  "/withdraw",
  [
    auth,
    check("bankDetails", "Bank details are required").not().isEmpty(),
    check("amount", "Amount is required").isNumeric(),
    check("pin", "Transaction PIN is required").not().isEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      const { bankDetails, amount, pin } = req.body
      const fee = 25 // Fixed fee for withdrawals

      // Verify transaction PIN
      const transactionPin = await TransactionPin.findOne({ userId: req.user.id })
      if (!transactionPin) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Transaction PIN not set" })
      }

      const isPinValid = await transactionPin.comparePin(pin)
      if (!isPinValid) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Invalid transaction PIN" })
      }

      // Get user's profile
      const user = await User.findById(req.user.id)
      if (!user) {
        await session.abortTransaction()
        session.endSession()
        return res.status(404).json({ message: "User not found" })
      }

      // Check if user has enough balance
      if (user.balance < Number.parseFloat(amount) + fee) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Insufficient balance" })
      }

      // Create a unique reference
      const reference = `WTH-${uuidv4().substring(0, 8)}`

      // Update user's balance
      user.balance -= Number.parseFloat(amount) + fee
      await user.save({ session })

      // Create transaction record
      const transaction = new Transaction({
        userId: user._id,
        transactionType: "withdraw",
        amount: Number.parseFloat(amount),
        fee,
        status: "successful",
        recipientName: bankDetails.accountName,
        recipientBank: bankDetails.bankName,
        recipientAccount: bankDetails.accountNumber,
        purpose: "Withdrawal",
        reference,
      })

      await transaction.save({ session })

      // Save beneficiary if requested
      if (bankDetails.saveBeneficiary) {
        const beneficiary = new Beneficiary({
          userId: user._id,
          recipientName: bankDetails.accountName,
          bankName: bankDetails.bankName,
          accountNumber: bankDetails.accountNumber,
          transferType: "bank",
        })

        await beneficiary.save({ session })
      }

      await session.commitTransaction()
      session.endSession()

      res.json({ success: true, reference })
    } catch (err) {
      await session.abortTransaction()
      session.endSession()
      console.error(err.message)
      res.status(500).send("Server error")
    }
  },
)

// @route   POST api/transactions/deposit
// @desc    Deposit money
// @access  Private
router.post(
  "/deposit",
  [
    auth,
    check("amount", "Amount is required").isNumeric(),
    check("method", "Payment method is required").not().isEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      const { amount, method } = req.body

      // Get user's profile
      const user = await User.findById(req.user.id)
      if (!user) {
        await session.abortTransaction()
        session.endSession()
        return res.status(404).json({ message: "User not found" })
      }

      // Create a unique reference
      const reference = `DEP-${uuidv4().substring(0, 8)}`

      // Update user's balance
      user.balance += Number.parseFloat(amount)
      await user.save({ session })

      // Create transaction record
      const transaction = new Transaction({
        userId: user._id,
        transactionType: "deposit",
        amount: Number.parseFloat(amount),
        fee: 0,
        status: "successful",
        purpose: `Deposit via ${method}`,
        reference,
      })

      await transaction.save({ session })

      await session.commitTransaction()
      session.endSession()

      res.json({ success: true, reference })
    } catch (err) {
      await session.abortTransaction()
      session.endSession()
      console.error(err.message)
      res.status(500).send("Server error")
    }
  },
)

// @route   POST api/transactions/confirm-deposit
// @desc    Confirm a deposit after Paystack payment
// @access  Private
router.post(
  "/confirm-deposit",
  [
    auth,
    check("reference", "Payment reference is required").not().isEmpty(),
    check("amount", "Amount is required").isNumeric(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      const { reference, amount } = req.body

      // Get user's profile
      const user = await User.findById(req.user.id)
      if (!user) {
        await session.abortTransaction()
        session.endSession()
        return res.status(404).json({ message: "User not found" })
      }

      // Check if transaction already exists
      const existingTransaction = await Transaction.findOne({ reference })
      if (existingTransaction) {
        await session.abortTransaction()
        session.endSession()
        return res.status(400).json({ message: "Transaction already processed" })
      }

      // Update user's balance
      user.balance += Number.parseFloat(amount)
      await user.save({ session })

      // Create transaction record
      const transaction = new Transaction({
        userId: user._id,
        transactionType: "deposit",
        amount: Number.parseFloat(amount),
        fee: 0,
        status: "successful",
        purpose: "Deposit via Paystack",
        reference,
      })

      await transaction.save({ session })

      await session.commitTransaction()
      session.endSession()

      res.json({ success: true, reference })
    } catch (err) {
      await session.abortTransaction()
      session.endSession()
      console.error(err.message)
      res.status(500).send("Server error")
    }
  },
)

module.exports = router
