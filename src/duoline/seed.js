require("dotenv").config();
const bcrypt = require("bcryptjs");
const { env } = require("./config/env");
const { initDb, User } = require("./models");

async function seed() {
  await initDb();

  for (const u of [env.seed.user1, env.seed.user2]) {
    if (!u.email || !u.password) {
      console.warn(`⚠️  Compte ignoré (email/mot de passe manquant): ${u.name}`);
      continue;
    }
    const passwordHash = await bcrypt.hash(u.password, 10);
    const [user, created] = await User.findOrCreate({
      where: { email: u.email },
      defaults: { name: u.name, passwordHash },
    });
    if (!created) {
      user.name = u.name;
      user.passwordHash = passwordHash;
      await user.save();
    }
    console.log(`✅ Compte prêt: ${u.name} <${u.email}>`);
  }

  process.exit(0);
}

seed().catch((err) => {
  console.error("Erreur seed duoline:", err);
  process.exit(1);
});
