function pick(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}
function required(nameArr) {
  const val = Array.isArray(nameArr) ? pick(...nameArr) : process.env[nameArr];
  if (!val)
    throw new Error(
      `Missing env: ${Array.isArray(nameArr) ? nameArr.join("/") : nameArr}`
    );
  return val;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || process.env.APP_PORT || 4000),
  CORS_ORIGINS: pick("CORS_ORIGINS", "CORS_ORIGIN") || "*",

  DB_HOST: required(["DB_HOST", "MYSQL_HOST"]),
  DB_PORT: Number(pick("DB_PORT", "MYSQL_PORT") || 3306),
  DB_USER: required(["DB_USER", "MYSQL_USER"]),
  DB_PASSWORD: required(["DB_PASSWORD", "DB_PASS", "MYSQL_PASSWORD"]),
  DB_NAME: required(["DB_NAME", "MYSQL_DB"]),
  MYSQL_SSL: String(pick("MYSQL_SSL") || "false").toLowerCase() === "true",

  JWT_ACCESS_SECRET: required([
    "JWT_ACCESS_SECRET",
    "JWT_SECRET",
    "JWT_SECRET_KEY",
    "SECRET_KEY",
  ]),
  JWT_REFRESH_SECRET: required([
    "JWT_REFRESH_SECRET",
    "JWT_SECRET_KEY",
    "JWT_SECRET",
    "SECRET_KEY",
  ]),
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL || "15m",
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL || "30d",

  CLOUDINARY_CLOUD_NAME: pick("CLOUDINARY_CLOUD_NAME"),
  CLOUDINARY_API_KEY: pick("CLOUDINARY_API_KEY"),
  CLOUDINARY_API_SECRET: pick("CLOUDINARY_API_SECRET"),

  TWILIO_ACCOUNT_SID: pick("TWILIO_ACCOUNT_SID"),
  TWILIO_AUTH_TOKEN: pick("TWILIO_AUTH_TOKEN"),
  TWILIO_API_KEY_SID: pick("TWILIO_API_KEY_SID"),
  TWILIO_API_KEY_SECRET: pick("TWILIO_API_KEY_SECRET"),
  TWILIO_VERIFY_SID: pick("TWILIO_VERIFY_SID"),

  PUSHY_API_KEY: pick("PUSHY_API_KEY") || "",

  APP_PUBLIC_URL: process.env.APP_PUBLIC_URL || "http://localhost:4000",

  LISTENERS_ENABLED:
    String(process.env.LISTENERS_ENABLED || "true").toLowerCase() === "true",
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || 10000),
};

module.exports = { env };
