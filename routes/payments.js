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

// @route   GET api/payments/banks
// @desc    Get list of banks
// @access  Public
router.get("/banks", async (req, res) => {
  try {
    // Get banks from Paystack API
    const response = await paystackRequest("/bank")

    if (!response.status) {
      return res.status(400).json({ success: false, message: "Failed to fetch banks" })
    }

    // Return the list of banks
    res.json({
      success: true,
      data: response.data.map((bank) => ({
        id: bank.id.toString(),
        code: bank.code,
        name: bank.name,
        country: bank.country,
        currency: bank.currency,
      })),
    })
  } catch (err) {
    console.error("Get banks error:", err.message)
    res.status(500).json({ success: false, message: "Server error fetching banks" })
  }
})

// @route   POST api/payments/verify-account
// @desc    Verify bank account
// @access  Private
router.post("/verify-account", auth, async (req, res) => {
  try {
    const { account_number, bank_code } = req.body

    if (!account_number || !bank_code) {
      return res.status(400).json({
        success: false,
        message: "Account number and bank code are required",
      })
    }

    // Verify account with Paystack API
    const response = await paystackRequest(`/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`)

    if (!response.status) {
      return res.status(400).json({
        success: false,
        message: "Failed to verify account",
      })
    }

    // Return the account details
    res.json({
      success: true,
      data: {
        account_number: response.data.account_number,
        account_name: response.data.account_name,
      },
    })
  } catch (err) {
    console.error("Verify account error:", err.message)
    res.status(500).json({ success: false, message: "Server error verifying account" })
  }
})

// @route   POST api/payments/withdraw
// @desc    Process withdrawal
// @access  Private
router.post("/withdraw", auth, async (req, res) => {
  try {
    const { amount, bank_code, account_number, account_name, narration } = req.body

    if (!amount || !bank_code || !account_number || !account_name) {
      return res.status(400).json({
        success: false,
        message: "Amount, bank code, account number, and account name are required",
      })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Check if user has enough balance
    if (user.balance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
      })
    }

    // Create a transfer recipient
    const recipientData = {
      type: "nuban",
      name: account_name,
      account_number: account_number,
      bank_code: bank_code,
      currency: "NGN",
    }

    const recipientResponse = await paystackRequest("/transferrecipient", "POST", recipientData)

    if (!recipientResponse.status) {
      return res.status(400).json({
        success: false,
        message: "Failed to create transfer recipient",
      })
    }

    // Create a transfer
    const transferData = {
      source: "balance",
      amount: amount * 100, // Convert to kobo
      recipient: recipientResponse.data.recipient_code,
      reason: narration || "Withdrawal",
    }

    const transferResponse = await paystackRequest("/transfer", "POST", transferData)

    if (!transferResponse.status) {
      return res.status(400).json({
        success: false,
        message: "Failed to initiate transfer",
      })
    }

    // Update user's balance
    user.balance -= amount
    await user.save()

    // Create transaction record
    const transaction = new Transaction({
      userId: user._id,
      transactionType: "withdrawal",
      amount: amount,
      fee: 0,
      status: "pending",
      purpose: narration || "Withdrawal",
      reference: transferResponse.data.transfer_code,
      recipientName: account_name,
      recipientDetails: {
        bankName: bank_code,
        accountNumber: account_number,
        accountName: account_name,
      },
    })

    await transaction.save()

    res.json({
      success: true,
      message: "Withdrawal initiated successfully",
      reference: transferResponse.data.transfer_code,
      transaction: {
        id: transaction._id,
        amount,
        status: "pending",
      },
    })
  } catch (err) {
    console.error("Withdrawal error:", err.message)
    res.status(500).json({ success: false, message: "Server error processing withdrawal" })
  }
})

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

// @route   POST api/payments/initialize-card-tokenization
// @desc    Initialize a card tokenization process
// @access  Private
router.post("/initialize-card-tokenization", auth, async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Initialize a minimal charge to tokenize the card
    const paymentData = {
      amount: 50, // Minimum amount (50 kobo)
      email,
      metadata: {
        userId: req.user.id,
        purpose: "card_tokenization",
      },
      channels: ["card"],
    }

    const response = await paystackRequest("/transaction/initialize", "POST", paymentData)

    if (!response.status) {
      return res.status(400).json({ success: false, message: "Failed to initialize card tokenization" })
    }

    res.json({
      success: true,
      authorization_url: response.data.authorization_url,
      access_code: response.data.access_code,
      reference: response.data.reference,
    })
  } catch (err) {
    console.error("Card tokenization initialization error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// Update the verify-card-tokenization endpoint with better error handling

// @route   POST api/payments/verify-card-tokenization
// @desc    Verify and save a tokenized card
// @access  Private
router.post("/verify-card-tokenization", auth, async (req, res) => {
  try {
    const { reference, isPrimary = false } = req.body

    if (!reference) {
      return res.status(400).json({ success: false, message: "Reference is required" })
    }

    console.log(`Verifying card tokenization for reference: ${reference}`)

    // Verify the transaction with Paystack
    let verifyResponse
    try {
      verifyResponse = await paystackRequest(`/transaction/verify/${reference}`)
      console.log("Paystack verification response:", JSON.stringify(verifyResponse))
    } catch (paystackError) {
      console.error("Paystack verification error:", paystackError)
      return res.status(400).json({
        success: false,
        message: `Paystack verification failed: ${paystackError.message}`,
      })
    }

    if (!verifyResponse.status || verifyResponse.data.status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Card verification failed: Transaction not successful",
      })
    }

    // Get authorization data
    const authData = verifyResponse.data.authorization
    if (!authData || !authData.authorization_code) {
      return res.status(400).json({
        success: false,
        message: "No card authorization data found in Paystack response",
      })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Check if user already has a Paystack customer code
    let customerCode = user.paystackCustomerCode

    // If not, create a customer in Paystack
    if (!customerCode) {
      try {
        const customerData = {
          email: verifyResponse.data.customer.email,
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
      } catch (customerError) {
        console.error("Customer creation error:", customerError)
        return res.status(400).json({
          success: false,
          message: `Failed to create customer: ${customerError.message}`,
        })
      }
    }

    // If this card is set as primary, update all other cards
    if (isPrimary) {
      await Card.updateMany({ userId: req.user.id }, { $set: { isPrimary: false } })
    }

    // Check if card already exists
    const existingCard = await Card.findOne({
      userId: req.user.id,
      last4: authData.last4,
      bin: authData.bin,
      paystackAuthCode: authData.authorization_code,
    })

    if (existingCard) {
      return res.status(400).json({ success: false, message: "This card is already saved to your account" })
    }

    // Create new card
    try {
      const card = new Card({
        userId: req.user.id,
        last4: authData.last4,
        cardType: authData.card_type,
        expiryMonth: authData.exp_month,
        expiryYear: authData.exp_year,
        bin: authData.bin,
        bank: authData.bank,
        cardHolder: user.firstName + " " + user.lastName, // Use user's name as card holder
        paystackAuthCode: authData.authorization_code,
        paystackCustomerCode: customerCode,
        isPrimary: isPrimary || false,
      })

      await card.save()
      console.log("Card saved successfully:", card._id)

      // Refund the charge
      try {
        const refundData = {
          transaction: verifyResponse.data.id,
        }

        await paystackRequest("/refund", "POST", refundData)
      } catch (refundError) {
        console.error("Refund error:", refundError)
        // Continue even if refund fails
      }

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

      res.json({ success: true, card: formattedCard })
    } catch (cardError) {
      console.error("Card creation error:", cardError)
      return res.status(500).json({
        success: false,
        message: `Failed to save card: ${cardError.message}`,
      })
    }
  } catch (err) {
    console.error("Card verification error:", err)
    res.status(500).json({ success: false, message: `Server error: ${err.message}` })
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
      case "transfer.failed":
        await handleFailedTransfer(event.data)
        break
      case "transfer.reversed":
        await handleReversedTransfer(event.data)
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

// @route   POST api/payments/create-subaccount
// @desc    Create a Paystack subaccount for a user
// @access  Private
router.post("/create-subaccount", auth, async (req, res) => {
  try {
    const { businessName, settlementBank, accountNumber, percentageCharge = 0 } = req.body

    if (!businessName || !settlementBank || !accountNumber) {
      return res.status(400).json({
        success: false,
        message: "Business name, settlement bank, and account number are required",
      })
    }

    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Check if user already has a subaccount
    if (user.paystackSubaccountCode) {
      return res.status(400).json({
        success: false,
        message: "User already has a subaccount",
      })
    }

    // Create subaccount with Paystack
    const subaccountData = {
      business_name: businessName,
      settlement_bank: settlementBank,
      account_number: accountNumber,
      percentage_charge: percentageCharge,
      description: `Subaccount for ${user.firstName} ${user.lastName}`,
    }

    const response = await paystackRequest("/subaccount", "POST", subaccountData)

    if (!response.status) {
      return res.status(400).json({
        success: false,
        message: "Failed to create subaccount",
      })
    }

    // Save subaccount code to user
    user.paystackSubaccountCode = response.data.subaccount_code

    // Make sure we're also saving any other relevant data:
    if (response.data.business_name) {
      user.businessName = response.data.business_name
    }

    res.json({
      success: true,
      subaccount: {
        code: response.data.subaccount_code,
        businessName: response.data.business_name,
        settlementBank: response.data.settlement_bank,
        accountNumber: response.data.account_number,
      },
    })
  } catch (err) {
    console.error("Create subaccount error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// @route   POST api/payments/create-virtual-account
// @desc    Create a dedicated virtual account for a user
// @access  Private
router.post("/create-virtual-account", auth, async (req, res) => {
  try {
    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Check if user already has a virtual account
    if (user.paystackVirtualAccountNumber) {
      return res.status(400).json({
        success: false,
        message: "User already has a virtual account",
      })
    }

    // Create a customer if not exists
    let customerCode = user.paystackCustomerCode
    if (!customerCode) {
      const customerData = {
        email: user.email,
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

    // Create dedicated virtual account
    const virtualAccountData = {
      customer: customerCode,
      preferred_bank: "test-bank", // Replace with actual preferred bank
    }

    const response = await paystackRequest("/dedicated_account", "POST", virtualAccountData)

    if (!response.status) {
      return res.status(400).json({
        success: false,
        message: "Failed to create virtual account",
      })
    }

    // Save virtual account details to user
    user.paystackVirtualAccountNumber = response.data.account_number
    user.paystackVirtualBankName = response.data.bank.name

    // Make sure we're also saving the customer code (this should already be there, but let's verify):
    if (!user.paystackCustomerCode) {
      user.paystackCustomerCode = customerCode
    }

    await user.save()

    res.json({
      success: true,
      virtualAccount: {
        accountNumber: response.data.account_number,
        bankName: response.data.bank.name,
        accountName: response.data.account_name,
      },
    })
  } catch (err) {
    console.error("Create virtual account error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// @route   POST api/payments/transfer
// @desc    Transfer funds between users
// @access  Private
router.post("/transfer", auth, async (req, res) => {
  try {
    const { recipientId, amount, reason } = req.body

    if (!recipientId || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Recipient ID and valid amount are required",
      })
    }

    // Get sender
    const sender = await User.findById(req.user.id)
    if (!sender) {
      return res.status(404).json({ success: false, message: "Sender not found" })
    }

    // Check if sender has enough balance
    if (sender.balance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
      })
    }

    // Get recipient
    const recipient = await User.findById(recipientId)
    if (!recipient) {
      return res.status(404).json({ success: false, message: "Recipient not found" })
    }

    // Create a transfer recipient if not exists
    let recipientCode = recipient.paystackTransferRecipientCode
    if (!recipientCode) {
      const recipientData = {
        type: "nuban",
        name: `${recipient.firstName} ${recipient.lastName}`,
        account_number: recipient.paystackVirtualAccountNumber || "0000000000",
        bank_code: "044", // Access Bank code, replace with actual bank code
        currency: "NGN",
      }

      const recipientResponse = await paystackRequest("/transferrecipient", "POST", recipientData)
      recipientCode = recipientResponse.data.recipient_code

      // Save recipient code to user
      recipient.paystackTransferRecipientCode = recipientCode

      // Make sure we're properly saving it:
      if (!recipient.paystackTransferRecipientCode) {
        recipient.paystackTransferRecipientCode = recipientCode
      }
      await recipient.save()
    }

    // Create a transfer
    const transferData = {
      source: "balance",
      amount: amount * 100, // Convert to kobo
      recipient: recipientCode,
      reason: reason || "Transfer",
    }

    const transferResponse = await paystackRequest("/transfer", "POST", transferData)

    if (!transferResponse.status) {
      return res.status(400).json({
        success: false,
        message: "Failed to initiate transfer",
      })
    }

    // Update balances
    sender.balance -= amount
    recipient.balance += amount
    await sender.save()
    await recipient.save()

    // Create transaction records
    const reference = transferResponse.data.transfer_code

    const senderTransaction = new Transaction({
      userId: sender._id,
      transactionType: "send",
      amount: amount,
      fee: 0,
      status: "successful",
      recipientId: recipient._id,
      recipientName: `${recipient.firstName} ${recipient.lastName}`,
      purpose: reason || "Transfer",
      reference,
    })

    const recipientTransaction = new Transaction({
      userId: recipient._id,
      transactionType: "receive",
      amount: amount,
      fee: 0,
      status: "successful",
      recipientId: sender._id,
      recipientName: `${sender.firstName} ${sender.lastName}`,
      purpose: reason || "Transfer",
      reference: `${reference}-RCV`,
    })

    await senderTransaction.save()
    await recipientTransaction.save()

    res.json({
      success: true,
      reference,
      transferCode: transferResponse.data.transfer_code,
    })
  } catch (err) {
    console.error("Transfer error:", err.message)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

const handleFailedTransfer = async (data) => {
  try {
    const { reference, recipient, reason } = data

    // Find the transaction
    const transaction = await Transaction.findOne({ reference })
    if (!transaction) {
      console.error("Transaction not found for failed transfer:", reference)
      return
    }

    // Update transaction status
    transaction.status = "failed"
    transaction.notes = reason || "Transfer failed"
    await transaction.save()

    // Refund the sender
    const sender = await User.findById(transaction.userId)
    if (sender) {
      sender.balance += transaction.amount
      await sender.save()
    }

    console.log("Failed transfer handled:", reference)
  } catch (error) {
    console.error("Error handling failed transfer:", error)
  }
}

const handleReversedTransfer = async (data) => {
  try {
    const { reference, recipient } = data

    // Find the transaction
    const transaction = await Transaction.findOne({ reference })
    if (!transaction) {
      console.error("Transaction not found for reversed transfer:", reference)
      return
    }

    // Update transaction status
    transaction.status = "reversed"
    await transaction.save()

    // Refund the sender
    const sender = await User.findById(transaction.userId)
    if (sender) {
      sender.balance += transaction.amount
      await sender.save()
    }

    // Deduct from recipient
    if (transaction.recipientId) {
      const recipient = await User.findById(transaction.recipientId)
      if (recipient) {
        recipient.balance -= transaction.amount
        await recipient.save()
      }
    }

    console.log("Reversed transfer handled:", reference)
  } catch (error) {
    console.error("Error handling reversed transfer:", error)
  }
}

// @route   POST api/payments/setup-paystack-profile
// @desc    Set up all Paystack resources for a user
// @access  Private
router.post("/setup-paystack-profile", auth, async (req, res) => {
  try {
    // Get user
    const user = await User.findById(req.user.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    const results = {
      customer: false,
      virtualAccount: false,
      subaccount: false,
      transferRecipient: false,
    }

    // 1. Create a customer if not exists
    if (!user.paystackCustomerCode) {
      try {
        const customerData = {
          email: user.email,
          first_name: user.firstName,
          last_name: user.lastName,
          phone: user.phoneNumber,
          metadata: {
            userId: user._id.toString(),
          },
        }

        const customerResponse = await paystackRequest("/customer", "POST", customerData)
        user.paystackCustomerCode = customerResponse.data.customer_code
        await user.save()
        results.customer = true
      } catch (error) {
        console.error("Customer creation error:", error)
        results.customer = false
      }
    } else {
      results.customer = true
    }

    // 2. Create dedicated virtual account if not exists
    if (!user.paystackVirtualAccountNumber && user.paystackCustomerCode) {
      try {
        const virtualAccountData = {
          customer: user.paystackCustomerCode,
          preferred_bank: "test-bank", // Replace with actual preferred bank
        }

        const response = await paystackRequest("/dedicated_account", "POST", virtualAccountData)

        if (response.status) {
          user.paystackVirtualAccountNumber = response.data.account_number
          user.paystackVirtualBankName = response.data.bank.name
          await user.save()
          results.virtualAccount = true
        }
      } catch (error) {
        console.error("Virtual account creation error:", error)
        results.virtualAccount = false
      }
    } else if (user.paystackVirtualAccountNumber) {
      results.virtualAccount = true
    }

    // 3. Create a transfer recipient if not exists
    if (!user.paystackTransferRecipientCode && user.paystackVirtualAccountNumber) {
      try {
        const recipientData = {
          type: "nuban",
          name: `${user.firstName} ${user.lastName}`,
          account_number: user.paystackVirtualAccountNumber,
          bank_code: "044", // Access Bank code, replace with actual bank code
          currency: "NGN",
        }

        const recipientResponse = await paystackRequest("/transferrecipient", "POST", recipientData)
        user.paystackTransferRecipientCode = recipientResponse.data.recipient_code
        await user.save()
        results.transferRecipient = true
      } catch (error) {
        console.error("Transfer recipient creation error:", error)
        results.transferRecipient = false
      }
    } else if (user.paystackTransferRecipientCode) {
      results.transferRecipient = true
    }

    // 4. Create a subaccount if requested and not exists
    if (!user.paystackSubaccountCode && req.body.createSubaccount) {
      try {
        const { businessName, settlementBank, accountNumber } = req.body

        if (businessName && settlementBank && accountNumber) {
          const subaccountData = {
            business_name: businessName,
            settlement_bank: settlementBank,
            account_number: accountNumber,
            percentage_charge: 0,
            description: `Subaccount for ${user.firstName} ${user.lastName}`,
          }

          const response = await paystackRequest("/subaccount", "POST", subaccountData)

          if (response.status) {
            user.paystackSubaccountCode = response.data.subaccount_code
            await user.save()
            results.subaccount = true
          }
        }
      } catch (error) {
        console.error("Subaccount creation error:", error)
        results.subaccount = false
      }
    } else if (user.paystackSubaccountCode) {
      results.subaccount = true
    }

    // Return the updated user profile with Paystack details
    res.json({
      success: true,
      message: "Paystack profile setup completed",
      results,
      paystackProfile: {
        customerCode: user.paystackCustomerCode,
        virtualAccount: {
          accountNumber: user.paystackVirtualAccountNumber,
          bankName: user.paystackVirtualBankName,
        },
        transferRecipientCode: user.paystackTransferRecipientCode,
        subaccountCode: user.paystackSubaccountCode,
      },
    })
  } catch (err) {
    console.error("Paystack profile setup error:", err.message)
    res.status(500).json({ success: false, message: "Server error setting up Paystack profile" })
  }
})

module.exports = router
