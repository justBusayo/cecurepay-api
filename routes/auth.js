const express = require("express")
const router = express.Router()
const { check, validationResult } = require("express-validator")
const jwt = require("jsonwebtoken")
const User = require("../models/User")
const auth = require("../middleware/auth")

// @route   POST api/auth/register
// @desc    Register user
// @access  Public
router.post(
  "/register",
  [
    check("firstName", "First name is required").not().isEmpty(),
    check("lastName", "Last name is required").not().isEmpty(),
    check("email", "Please include a valid email").isEmail(),
    check("password", "Password must be at least 6 characters").isLength({ min: 6 }),
    check("phoneNumber", "Phone number is required").not().isEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "Validation error", errors: errors.array() })
    }

    const { firstName, lastName, email, password, phoneNumber } = req.body

    try {
      // Check if user already exists
      let user = await User.findOne({ email })
      if (user) {
        return res.status(400).json({ success: false, message: "User already exists with this email" })
      }

      user = await User.findOne({ phoneNumber })
      if (user) {
        return res.status(400).json({ success: false, message: "User already exists with this phone number" })
      }

      // Create new user
      user = new User({
        firstName,
        lastName,
        email,
        password,
        phoneNumber,
        isVerified: true, // For simplicity, auto-verify users
      })

      await user.save()

      // Create JWT payload
      const payload = {
        user: {
          id: user.id,
        },
      }

      // Sign token
      jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" }, (err, token) => {
        if (err) {
          console.error("JWT Sign Error:", err)
          throw err
        }
        res.json({ success: true, token })
      })
    } catch (err) {
      console.error("Registration error:", err.message)
      res.status(500).json({ success: false, message: "Server error during registration", error: err.message })
    }
  },
)

// @route   POST api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post(
  "/login",
  [check("email", "Please include a valid email").isEmail(), check("password", "Password is required").exists()],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "Validation error", errors: errors.array() })
    }

    const { email, password } = req.body

    try {
      // Check if user exists
      const user = await User.findOne({ email })
      if (!user) {
        return res.status(400).json({ success: false, message: "Invalid credentials" })
      }

      // Check password
      const isMatch = await user.comparePassword(password)
      if (!isMatch) {
        return res.status(400).json({ success: false, message: "Invalid credentials" })
      }

      // Create JWT payload
      const payload = {
        user: {
          id: user.id,
        },
      }

      // Sign token
      jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" }, (err, token) => {
        if (err) {
          console.error("JWT Sign Error:", err)
          throw err
        }
        res.json({
          success: true,
          token,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
          },
        })
      })
    } catch (err) {
      console.error("Login error:", err.message)
      res.status(500).json({ success: false, message: "Server error during login", error: err.message })
    }
  },
)

// @route   POST api/auth/login-phone
// @desc    Login with phone number
// @access  Public
router.post(
  "/login-phone",
  [
    check("phoneNumber", "Phone number is required").not().isEmpty(),
    check("password", "Password is required").exists(),
  ],
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "Validation error", errors: errors.array() })
    }

    const { phoneNumber, password } = req.body

    try {
      // Check if user exists
      const user = await User.findOne({ phoneNumber })
      if (!user) {
        return res.status(400).json({ success: false, message: "User not found with this phone number" })
      }

      // Check password
      const isMatch = await user.comparePassword(password)
      if (!isMatch) {
        return res.status(400).json({ success: false, message: "Invalid credentials" })
      }

      // Create JWT payload
      const payload = {
        user: {
          id: user.id,
        },
      }

      // Sign token
      jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" }, (err, token) => {
        if (err) {
          console.error("JWT Sign Error:", err)
          throw err
        }
        res.json({
          success: true,
          token,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
          },
        })
      })
    } catch (err) {
      console.error("Login with phone error:", err.message)
      res.status(500).json({ success: false, message: "Server error during phone login", error: err.message })
    }
  },
)

// @route   GET api/auth/me
// @desc    Get current user
// @access  Private
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password")
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }
    res.json({ success: true, user })
  } catch (err) {
    console.error("Get current user error:", err.message)
    res.status(500).json({ success: false, message: "Server error getting user profile", error: err.message })
  }
})

module.exports = router
