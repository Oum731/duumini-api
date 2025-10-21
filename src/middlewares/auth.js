// src/middlewares/auth.js
const jwt = require('jsonwebtoken');
require('dotenv').config();

function authRequired(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, phone, role }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

const isAdmin = (u) => u?.role === 'ADMIN';
const isVendor = (u) => u?.role === 'VENDEUR';

module.exports = { authRequired, requireRole, isAdmin, isVendor };
