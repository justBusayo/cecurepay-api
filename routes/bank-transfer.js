const express = require("express")
const router = express.Router()
const auth = require("../middleware/auth")
const User = require("../models/User")
const Transaction = require("../models/Transaction")

// @route   POST api/payments/bank-transfer/initiate
// @desc    Initiate a bank transfer deposit
// @access  Private
router.post("/bank-transfer/initiate", auth, async (req, res) => {
  try {
    const { amount, reference } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid amount is required",
      })
    }

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Reference is required",
      })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Create transaction record
    const transaction = new Transaction({
      userId: user._id,
      transactionType: "deposit",
      amount: Number.parseFloat(amount),
      fee: 0,
      status: "pending",
      purpose: "Bank Transfer Deposit",
      reference,
    })

    await transaction.save()

    res.json({
      success: true,
      message: "Bank transfer deposit initiated",
      reference,
      transaction: {
        id: transaction._id,
        amount,
        status: "pending",
      },
    })
  } catch (err) {
    console.error("Bank transfer initiate error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// @route   POST api/payments/bank-transfer/cancel
// @desc    Cancel a bank transfer deposit
// @access  Private
router.post("/bank-transfer/cancel", auth, async (req, res) => {
  try {
    const { reference } = req.body

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Reference is required",
      })
    }

    // Find the transaction
    const transaction = await Transaction.findOne({
      reference,
      userId: req.user.id,
      transactionType: "deposit",
      status: "pending",
    })

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      })
    }

    // Update transaction status
    transaction.status = "cancelled"
    await transaction.save()

    res.json({
      success: true,
      message: "Bank transfer deposit cancelled",
      transaction: {
        id: transaction._id,
        status: "cancelled",
      },
    })
  } catch (err) {
    console.error("Bank transfer cancel error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// @route   POST api/payments/bank-transfer/confirm
// @desc    Confirm a bank transfer deposit (admin only)
// @access  Private/Admin
router.post("/bank-transfer/confirm", auth, async (req, res) => {
  try {
    const { reference } = req.body

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Reference is required",
      })
    }

    // Find the transaction
    const transaction = await Transaction.findOne({
      reference,
      transactionType: "deposit",
      status: "pending",
    })

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      })
    }

    // Get user
    const user = await User.findById(transaction.userId)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Update transaction status
    transaction.status = "successful"
    await transaction.save()

    // Update user's balance
    user.balance += transaction.amount
    await user.save()

    res.json({
      success: true,
      message: "Bank transfer deposit confirmed",
      transaction: {
        id: transaction._id,
        status: "successful",
      },
    })
  } catch (err) {
    console.error("Bank transfer confirm error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

module.exports = router

