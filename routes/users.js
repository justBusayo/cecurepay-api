const express = require("express")
const router = express.Router()
const { check, validationResult } = require("express-validator")
const User = require("../models/User")
const TransactionPin = require("../models/TransactionPin")
const Card = require("../models/Card")
const Beneficiary = require("../models/Beneficiary")
const auth = require("../middleware/auth")
const axios = require("axios")

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

// @route   GET api/users/search
// @desc    Search users by cecureTag or name
// @access  Private
router.get("/search", auth, async (req, res) => {
  try {
    const query = req.query.q
    if (!query) {
      return res.status(400).json({ message: "Search query is required" })
    }

    const users = await User.find({
      $or: [
        { cecureTag: { $regex: query, $options: "i" } },
        { firstName: { $regex: query, $options: "i" } },
        { lastName: { $regex: query, $options: "i" } },
      ],
    })
      .select("_id firstName lastName cecureTag")
      .limit(10)

    // Format the data for display
    const formattedData = users.map((user) => ({
      id: user._id,
      name: `${user.firstName} ${user.lastName}`,
      tag: user.cecureTag,
      avatar: `${user.firstName[0]}${user.lastName[0]}`,
    }))

    res.json(formattedData)
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   POST api/users/transaction-pin
// @desc    Set transaction PIN
// @access  Private
router.post(
  "/transaction-pin",
  [auth, check("pin", "PIN is required").isLength({ min: 4, max: 6 })],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    try {
      const { pin } = req.body

      // Check if PIN already exists
      let transactionPin = await TransactionPin.findOne({ userId: req.user.id })

      if (transactionPin) {
        // Update existing PIN
        transactionPin.pinHash = pin
        transactionPin.updatedAt = Date.now()
      } else {
        // Create new PIN
        transactionPin = new TransactionPin({
          userId: req.user.id,
          pinHash: pin,
        })
      }

      await transactionPin.save()
      res.json({ message: "Transaction PIN set successfully" })
    } catch (err) {
      console.error(err.message)
      res.status(500).send("Server error")
    }
  },
)

// @route   POST api/users/verify-pin
// @desc    Verify transaction PIN
// @access  Private
router.post("/verify-pin", [auth, check("pin", "PIN is required").isLength({ min: 4, max: 6 })], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { pin } = req.body

    // Find PIN
    const transactionPin = await TransactionPin.findOne({ userId: req.user.id })
    if (!transactionPin) {
      return res.status(404).json({ message: "Transaction PIN not set" })
    }

    // Verify PIN
    const isMatch = await transactionPin.comparePin(pin)
    res.json({ success: isMatch })
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   GET api/users/cards
// @desc    Get user's cards
// @access  Private
router.get("/cards", auth, async (req, res) => {
  try {
    const cards = await Card.find({ userId: req.user.id, isActive: true })

    // Format card data for frontend
    const formattedCards = cards.map((card) => ({
      id: card._id,
      card_number: `**** **** **** ${card.last4}`,
      card_holder: card.cardHolder,
      expiry_date: `${card.expiryMonth}/${card.expiryYear.slice(-2)}`,
      card_type: card.cardType,
      is_primary: card.isPrimary,
      bank: card.bank,
      auth_code: card.paystackAuthCode,
    }))

    res.json(formattedCards)
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   POST api/users/cards
// @desc    Add a card via Paystack tokenization
// @access  Private
router.post(
  "/cards",
  [auth, check("token", "Paystack token is required").not().isEmpty(), check("email", "Email is required").isEmail()],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    try {
      const { token, email, isPrimary } = req.body
      const user = await User.findById(req.user.id)

      if (!user) {
        return res.status(404).json({ message: "User not found" })
      }

      // Check if user already has a Paystack customer code
      let customerCode = user.paystackCustomerCode

      // If not, create a customer in Paystack
      if (!customerCode) {
        const customerData = {
          email: email,
          first_name: user.firstName,
          last_name: user.lastName,
          phone: user.phoneNumber,
          metadata: {
            userId: user._id.toString(),
          },
        }

        const customerResponse = await paystackRequest("/customer", "POST", customerData)
        customerCode = customerResponse.data.customer_code

        // Save customer code to user
        user.paystackCustomerCode = customerCode
        await user.save()
      }

      // Charge the card to tokenize it
      const chargeData = {
        email: email,
        amount: 50, // Charge a small amount (50 kobo) that will be refunded
        card: { token },
      }

      const chargeResponse = await paystackRequest("/transaction/charge_authorization", "POST", chargeData)

      if (chargeResponse.status !== true || chargeResponse.data.status !== "success") {
        return res.status(400).json({ message: "Card validation failed" })
      }

      // Extract card details from response
      const cardData = chargeResponse.data.authorization

      // If this card is set as primary, update all other cards
      if (isPrimary) {
        await Card.updateMany({ userId: req.user.id }, { $set: { isPrimary: false } })
      }

      // Check if card already exists
      const existingCard = await Card.findOne({
        userId: req.user.id,
        last4: cardData.last4,
        bin: cardData.bin,
        paystackAuthCode: cardData.authorization_code,
      })

      if (existingCard) {
        return res.status(400).json({ message: "This card is already saved to your account" })
      }

      // Create new card
      const card = new Card({
        userId: req.user.id,
        last4: cardData.last4,
        cardType: cardData.card_type,
        expiryMonth: cardData.exp_month,
        expiryYear: cardData.exp_year,
        bin: cardData.bin,
        bank: cardData.bank,
        cardHolder: user.firstName + " " + user.lastName, // Use user's name as card holder
        paystackAuthCode: cardData.authorization_code,
        paystackCustomerCode: customerCode,
        isPrimary: isPrimary || false,
      })

      await card.save()

      // Refund the charge
      const refundData = {
        transaction: chargeResponse.data.id,
      }

      await paystackRequest("/refund", "POST", refundData)

      // Format card for response
      const formattedCard = {
        id: card._id,
        card_number: `**** **** **** ${card.last4}`,
        card_holder: card.cardHolder,
        expiry_date: `${card.expiryMonth}/${card.expiryYear.slice(-2)}`,
        card_type: card.cardType,
        is_primary: card.isPrimary,
        bank: card.bank,
      }

      res.json(formattedCard)
    } catch (err) {
      console.error(err.message)
      res.status(500).send("Server error")
    }
  },
)

// @route   PUT api/users/cards/:id/deactivate
// @desc    Deactivate a card
// @access  Private
router.put("/cards/:id/deactivate", auth, async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user.id })

    if (!card) {
      return res.status(404).json({ message: "Card not found" })
    }

    card.isActive = false
    await card.save()

    res.json({ message: "Card deactivated successfully" })
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   GET api/users/beneficiaries
// @desc    Get user's beneficiaries
// @access  Private
router.get("/beneficiaries", auth, async (req, res) => {
  try {
    const beneficiaries = await Beneficiary.find({ userId: req.user.id })
    res.json(beneficiaries)
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

module.exports = router
