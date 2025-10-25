const jwt = require("jsonwebtoken");
const { env } = require("../lib/env");

const signAccess = (payload) =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL });

const signRefresh = (payload) =>
  jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_TTL });

const verifyAccess = (t) => jwt.verify(t, env.JWT_ACCESS_SECRET);
const verifyRefresh = (t) => jwt.verify(t, env.JWT_REFRESH_SECRET);

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh };
