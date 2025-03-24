const express = require("express")
const router = express.Router()
const { check, validationResult } = require("express-validator")
const User = require("../models/User")
const TransactionPin = require("../models/TransactionPin")
const Card = require("../models/Card")
const Beneficiary = require("../models/Beneficiary")
const auth = require("../middleware/auth")

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
    res.json(cards)
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   POST api/users/cards
// @desc    Add a card
// @access  Private
router.post(
  "/cards",
  [
    auth,
    check("cardNumber", "Card number is required").isLength({ min: 16, max: 16 }),
    check("cardHolder", "Card holder name is required").not().isEmpty(),
    check("expiryDate", "Expiry date is required").matches(/^(0[1-9]|1[0-2])\/\d{2}$/),
    check("cardType", "Card type is required").not().isEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    try {
      const { cardNumber, cardHolder, expiryDate, cardType, isPrimary } = req.body

      // If this card is set as primary, update all other cards
      if (isPrimary) {
        await Card.updateMany({ userId: req.user.id }, { $set: { isPrimary: false } })
      }

      // Create new card
      const card = new Card({
        userId: req.user.id,
        cardNumber,
        cardHolder,
        expiryDate,
        cardType,
        isPrimary: isPrimary || false,
      })

      await card.save()
      res.json(card)
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

