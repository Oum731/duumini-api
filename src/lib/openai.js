const OpenAI = require("openai");
const { env } = require("./env");

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL || undefined,
});

module.exports = { openai };
