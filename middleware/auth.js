const jwt = require("jsonwebtoken")

module.exports = (req, res, next) => {
  // Get token from header
  const token = req.header("x-auth-token")

  // Check if no token
  if (!token) {
    return res.status(401).json({ success: false, message: "No authentication token, authorization denied" })
  }

  // Verify token
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = decoded.user
    next()
  } catch (err) {
    console.error("Token verification error:", err.message)
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Token has expired, please login again" })
    }
    res.status(401).json({ success: false, message: "Token is not valid" })
  }
}
