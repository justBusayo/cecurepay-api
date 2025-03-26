const express = require("express")
const router = express.Router()
const axios = require("axios")
const crypto = require("crypto")
const auth = require("../middleware/auth")
const User = require("../models/User")
const Card = require("../models/Card")
const Transaction = require("../models/Transaction")

// Paystack API base URL
const PAYSTACK_BASE_URL = "https://api.paystack.co"

// Helper function to make Paystack API requests
const paystackRequest = async (endpoint, method = "GET", data = null) => {
  try {
    const config = {
      method,
      url: `${PAYSTACK_BASE_URL}${endpoint}`,
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    }

    if (data && (method === "POST" || method === "PUT")) {
      config.data = data
    }

    const response = await axios(config)
    return response.data
  } catch (error) {
    console.error("Paystack API error:", error.response ? error.response.data : error.message)
    throw new Error(error.response ? error.response.data.message : error.message)
  }
}

// @route   POST api/payments/initialize
// @desc    Initialize a Paystack payment
// @access  Private
router.post("/initialize", auth, async (req, res) => {
  try {
    const { amount, email, metadata = {} } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Valid amount is required" })
    }

    if (!email) {
      return res.status(400).json({ message: "Email is required" })
    }

    // Add user ID to metadata
    const enhancedMetadata = {
      ...metadata,
      userId: req.user.id,
    }

    // Initialize transaction with Paystack
    const paymentData = {
      amount,
      email,
      metadata: enhancedMetadata,
      callback_url: `${process.env.API_BASE_URL}/api/payments/callback`, // Use our API endpoint
    }

    const response = await paystackRequest("/transaction/initialize", "POST", paymentData)

    res.json(response)
  } catch (err) {
    console.error("Payment initialization error:", err.message)
    res.status(500).json({ message: "Server error" })
  }
})

// @route   POST api/payments/charge-card
// @desc    Charge a saved card
// @access  Private
router.post("/charge-card", auth, async (req, res) => {
  try {
    const { amount, email, cardId } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Valid amount is required" })
    }

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" })
    }

    if (!cardId) {
      return res.status(400).json({ success: false, message: "Card ID is required" })
    }

    // Find the card
    const card = await Card.findOne({ _id: cardId, userId: req.user.id, isActive: true })
    if (!card) {
      return res.status(404).json({ success: false, message: "Card not found" })
    }

    // Charge the card using Paystack
    const chargeData = {
      authorization_code: card.paystackAuthCode,
      email,
      amount: amount * 100, // Convert to kobo
      metadata: {
        userId: req.user.id,
        cardId: card._id.toString(),
      },
    }

    const chargeResponse = await paystackRequest("/transaction/charge_authorization", "POST", chargeData)

    if (chargeResponse.status !== true) {
      return res.status(400).json({ success: false, message: "Payment failed" })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Update user's balance
    user.balance += Number.parseFloat(amount)
    await user.save()

    // Create transaction record
    const transaction = new Transaction({
      userId: user._id,
      transactionType: "deposit",
      amount: Number.parseFloat(amount),
      fee: 0,
      status: "successful",
      purpose: "Deposit via saved card",
      reference: chargeResponse.data.reference,
    })

    await transaction.save()

    res.json({
      success: true,
      reference: chargeResponse.data.reference,
      status: chargeResponse.data.status,
    })
  } catch (err) {
    console.error("Charge card error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// @route   GET api/payments/callback
// @desc    Handle Paystack payment callback
// @access  Public
router.get("/callback", async (req, res) => {
  try {
    const { reference } = req.query

    if (!reference) {
      return res.status(400).json({ message: "Payment reference is required" })
    }

    // Verify the transaction with Paystack
    const paystackResponse = await paystackRequest(`/transaction/verify/${reference}`)

    if (paystackResponse.data.status === "success") {
      // Extract data from Paystack response
      const { amount, metadata } = paystackResponse.data
      const userId = metadata.userId
      const amountInNaira = amount / 100 // Convert from kobo to Naira

      // Find the user
      const user = await User.findById(userId)
      if (!user) {
        return res.status(404).json({ message: "User not found" })
      }

      // Check if transaction already exists
      const existingTransaction = await Transaction.findOne({ reference })
      if (!existingTransaction) {
        // Update user's balance
        user.balance += amountInNaira
        await user.save()

        // Create transaction record
        const transaction = new Transaction({
          userId,
          transactionType: "deposit",
          amount: amountInNaira,
          fee: 0,
          status: "successful",
          purpose: "Deposit via Paystack",
          reference,
        })

        await transaction.save()
      }

      // Redirect to success page in the app
      return res.redirect(`${process.env.APP_URL}/deposit-success?reference=${reference}&amount=${amountInNaira}`)
    } else {
      // Redirect to failure page in the app
      return res.redirect(`${process.env.APP_URL}/deposit-failed?reference=${reference}`)
    }
  } catch (err) {
    console.error("Payment callback error:", err.message)
    return res.redirect(`${process.env.APP_URL}/deposit-failed?error=server_error`)
  }
})

// @route   GET api/payments/verify/:reference
// @desc    Verify a Paystack payment
// @access  Private
router.get("/verify/:reference", auth, async (req, res) => {
  try {
    const { reference } = req.params

    if (!reference) {
      return res.status(400).json({ message: "Payment reference is required" })
    }

    // Verify transaction with Paystack
    const response = await paystackRequest(`/transaction/verify/${reference}`)

    res.json(response)
  } catch (err) {
    console.error("Payment verification error:", err.message)
    res.status(500).json({ message: "Server error" })
  }
})

// @route   POST api/payments/webhook
// @desc    Handle Paystack webhook events
// @access  Public
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // Verify webhook signature
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest("hex")

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(400).send("Invalid signature")
    }

    const event = req.body

    // Handle different event types
    switch (event.event) {
      case "charge.success":
        await handleSuccessfulPayment(event.data)
        break
      case "transfer.success":
        await handleSuccessfulTransfer(event.data)
        break
      default:
        console.log(`Unhandled event type: ${event.event}`)
    }

    res.status(200).send("Webhook received")
  } catch (err) {
    console.error("Webhook error:", err.message)
    res.status(500).send("Webhook error")
  }
})

// Helper function to handle successful payments
const handleSuccessfulPayment = async (data) => {
  try {
    const { reference, amount, metadata } = data

    if (!metadata || !metadata.userId) {
      console.error("No user ID in metadata")
      return
    }

    const userId = metadata.userId
    const amountInNaira = amount / 100 // Convert from kobo to Naira

    // Find the user
    const user = await User.findById(userId)
    if (!user) {
      console.error("User not found:", userId)
      return
    }

    // Check if transaction already exists
    const existingTransaction = await Transaction.findOne({ reference })
    if (existingTransaction) {
      console.log("Transaction already processed:", reference)
      return
    }

    // Update user's balance
    user.balance += amountInNaira
    await user.save()

    // Create transaction record
    const transaction = new Transaction({
      userId,
      transactionType: "deposit",
      amount: amountInNaira,
      fee: 0,
      status: "successful",
      purpose: "Deposit via Paystack",
      reference,
    })

    await transaction.save()
    console.log("Payment processed successfully:", reference)
  } catch (error) {
    console.error("Error handling successful payment:", error)
  }
}

// Helper function to handle successful transfers
const handleSuccessfulTransfer = async (data) => {
  try {
    const { reference, metadata } = data

    if (!metadata || !metadata.userId) {
      console.error("No user ID in metadata")
      return
    }

    // Update the withdrawal transaction status
    await Transaction.findOneAndUpdate({ reference: metadata.originalReference }, { status: "successful" })

    console.log("Transfer processed successfully:", reference)
  } catch (error) {
    console.error("Error handling successful transfer:", error)
  }
}

module.exports = router
