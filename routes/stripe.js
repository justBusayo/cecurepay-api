const express = require("express")
const router = express.Router()
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)
const User = require("../models/User")
const Transaction = require("../models/Transaction")
const auth = require("../middleware/auth")
const { v4: uuidv4 } = require("uuid")

// @route   POST api/stripe/create-customer
// @desc    Create a Stripe customer
// @access  Private
router.post("/create-customer", auth, async (req, res) => {
  try {
    // Check if user already has a Stripe customer ID
    const user = await User.findById(req.user.id)
    if (user.stripeCustomerId) {
      return res.json({ customerId: user.stripeCustomerId })
    }

    // Create a new Stripe customer
    const customer = await stripe.customers.create({
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
      phone: user.phoneNumber,
      metadata: {
        userId: user._id.toString(),
      },
    })

    // Update user with Stripe customer ID
    user.stripeCustomerId = customer.id
    await user.save()

    res.json({ customerId: customer.id })
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   POST api/stripe/create-payment-intent
// @desc    Create a payment intent for deposit
// @access  Private
router.post("/create-payment-intent", auth, async (req, res) => {
  try {
    const { amount, currency = "usd" } = req.body

    if (!amount || Number.parseFloat(amount) <= 0) {
      return res.status(400).json({ message: "Valid amount is required" })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Ensure user has a Stripe customer ID
    let customerId = user.stripeCustomerId
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        phone: user.phoneNumber,
        metadata: {
          userId: user._id.toString(),
        },
      })
      customerId = customer.id
      user.stripeCustomerId = customerId
      await user.save()
    }

    // Create a payment intent
    const amountInCents = Math.round(Number.parseFloat(amount) * 100)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency,
      customer: customerId,
      metadata: {
        userId: user._id.toString(),
        type: "deposit",
      },
    })

    // Create an ephemeral key for the customer
    const ephemeralKey = await stripe.ephemeralKeys.create({ customer: customerId }, { apiVersion: "2023-08-16" })

    res.json({
      clientSecret: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customerId,
      paymentIntentId: paymentIntent.id,
    })
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   POST api/stripe/confirm-payment
// @desc    Confirm a payment and update user balance
// @access  Private
router.post("/confirm-payment", auth, async (req, res) => {
  try {
    const { paymentIntentId, amount } = req.body

    if (!paymentIntentId) {
      return res.status(400).json({ message: "Payment intent ID is required" })
    }

    // Retrieve the payment intent to verify its status
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ message: "Payment has not been completed" })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Create a unique reference
    const reference = `DEP-${uuidv4().substring(0, 8)}`

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
      purpose: "Deposit via card",
      reference,
      stripePaymentIntentId: paymentIntentId,
    })

    await transaction.save()

    res.json({ success: true, reference })
  } catch (err) {
    console.error(err.message)
    res.status(500).send("Server error")
  }
})

// @route   POST api/stripe/webhook
// @desc    Handle Stripe webhook events
// @access  Public
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"]

  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Handle the event
  switch (event.type) {
    case "payment_intent.succeeded":
      const paymentIntent = event.data.object
      console.log("PaymentIntent was successful!", paymentIntent.id)
      // Handle successful payment
      break
    case "payment_intent.payment_failed":
      const failedPayment = event.data.object
      console.log("Payment failed:", failedPayment.id)
      // Handle failed payment
      break
    default:
      console.log(`Unhandled event type ${event.type}`)
  }

  // Return a 200 response to acknowledge receipt of the event
  res.send()
})

module.exports = router

