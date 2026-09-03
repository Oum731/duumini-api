const { Router } = require("express");
const { Op } = require("sequelize");
const { User } = require("../models");
const { requireAuth } = require("../middleware/auth");

const partnerRouter = Router();

// App à 2 personnes : "le/la partenaire" est simplement l'autre compte.
async function findPartner(myId) {
  return User.findOne({ where: { id: { [Op.ne]: myId } } });
}

// Nom affiché pour le/la partenaire, tel que défini par le compte courant
// (surnom perso s'il existe, sinon le vrai nom du compte partenaire).
partnerRouter.get("/", requireAuth, async (req, res) => {
  const [me, partner] = await Promise.all([
    User.findByPk(req.user.id),
    findPartner(req.user.id),
  ]);
  if (!partner) return res.status(404).json({ error: "Partenaire introuvable" });

  res.json({
    id: partner.id,
    name: me.partnerNickname || partner.name,
    realName: partner.name,
    avatarUrl: partner.avatarUrl,
  });
});

// Change uniquement l'affichage CHEZ MOI — n'affecte jamais le compte de
// l'autre personne ni ce qu'elle voit de son côté.
partnerRouter.put("/nickname", requireAuth, async (req, res) => {
  const nickname = String(req.body?.nickname || "").trim().slice(0, 60);
  const me = await User.findByPk(req.user.id);
  me.partnerNickname = nickname || null;
  await me.save();
  res.json({ ok: true, nickname: me.partnerNickname });
});

module.exports = { partnerRouter };
