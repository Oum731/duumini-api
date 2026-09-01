// Config isolée pour le module DuoLine — variables préfixées DUOLINE_ pour
// ne jamais entrer en collision avec la config propre à duumini-api
// (DB_*, JWT_SECRET, etc. restent celles de duumini-api).
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const env = {
  jwtSecret: process.env.DUOLINE_JWT_SECRET || "dev_secret_a_changer",
  // Reste connecté indéfiniment (app privée à 2) — se reconnecter seulement
  // en cas de déconnexion explicite ou de changement d'appareil.
  jwtExpiresIn: process.env.DUOLINE_JWT_EXPIRES_IN || "3650d",

  db: {
    host: process.env.DUOLINE_DB_HOST || "127.0.0.1",
    port: num(process.env.DUOLINE_DB_PORT, 3306),
    name: process.env.DUOLINE_DB_NAME || "duoline",
    user: process.env.DUOLINE_DB_USER || "root",
    password: process.env.DUOLINE_DB_PASSWORD || "",
  },

  // Ces vars-là sont volontairement partagées avec duumini-api (même compte
  // Cloudinary, même service Metered/VAPID) — pas besoin de les préfixer.
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "mailto:contact@duoline.local",
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
  },

  ice: {
    mode: process.env.ICE_MODE || "stun",
    turnUrl: process.env.TURN_URL || "",
    turnUsername: process.env.TURN_USERNAME || "",
    turnCredential: process.env.TURN_CREDENTIAL || "",
    meteredEndpoint: process.env.METERED_TURN_ENDPOINT || "",
    meteredApiKey: process.env.METERED_API_KEY || "",
  },

  seed: {
    user1: {
      name: process.env.SEED_USER1_NAME || "Moi",
      email: process.env.SEED_USER1_EMAIL,
      password: process.env.SEED_USER1_PASSWORD,
    },
    user2: {
      name: process.env.SEED_USER2_NAME || "Ma femme",
      email: process.env.SEED_USER2_EMAIL,
      password: process.env.SEED_USER2_PASSWORD,
    },
  },
};

module.exports = { env };
