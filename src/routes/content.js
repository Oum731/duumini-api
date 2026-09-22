// src/routes/content.js
//
// Point d'accès PUBLIC pour le contenu généré/validé via l'outil
// Contenu IA (src/routes/adminContentAi.js, src/lib/contentStore.js) —
// jusqu'ici ce contenu pouvait être généré et publié par un admin, mais
// aucune route publique ne le servait jamais : il n'avait donc aucune
// destination sur le site. Consommé par le catch-all SeoContentPage côté
// frontend (duumini-web) pour les pages ville générées par l'IA
// (ex: /casablanca/produits-africains).
const { Router } = require("express");
const { getPublishedBySlug } = require("../lib/contentStore");

const router = Router();

router.get("/", async (req, res) => {
  const slug = String(req.query.slug || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const type = String(req.query.type || "city_page").trim();
  const lang = String(req.query.lang || "fr").trim();

  if (!slug) return res.status(400).json({ error: "slug requis" });

  try {
    const item = await getPublishedBySlug({ type, slug, lang });
    if (!item) return res.status(404).json({ error: "not_found" });
    return res.json(item);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
