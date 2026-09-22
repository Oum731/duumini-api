// src/routes/content.js
//
// Point d'accès PUBLIC pour le contenu généré/validé via l'outil
// Contenu IA (src/routes/adminContentAi.js, src/lib/contentStore.js) —
// jusqu'ici ce contenu pouvait être généré et publié par un admin, mais
// aucune route publique ne le servait jamais : il n'avait donc aucune
// destination sur le site. Consommé par le catch-all SeoContentPage côté
// frontend (duumini-web) pour les pages ville générées par l'IA
// (ex: /casablanca/produits-africains) et par la page /blog pour les
// articles (type=blog_post).
const { Router } = require("express");
const { getPublishedBySlug, listPublished } = require("../lib/contentStore");
const { getPagination, buildPageInfo } = require("../utils/pagination");

const router = Router();

// GET /api/content?type=blog_post&list=1&page=&pageSize=
// -> liste paginée des contenus publiés d'un type (ex: index du blog)
// GET /api/content?slug=...&type=&lang=
// -> un contenu publié par slug (type optionnel : cherche tous types si absent)
router.get("/", async (req, res) => {
  const lang = String(req.query.lang || "fr").trim();

  if (String(req.query.list || "") === "1") {
    const type = String(req.query.type || "").trim();
    if (!type) return res.status(400).json({ error: "type requis pour la liste" });

    const { page, pageSize, offset } = getPagination(req, {
      page: 1,
      pageSize: 12,
      maxPageSize: 50,
    });

    try {
      const { items, total } = await listPublished({ type, lang, limit: pageSize, offset });
      return res.json({ items, pageInfo: buildPageInfo(total, page, pageSize) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const slug = String(req.query.slug || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const type = String(req.query.type || "").trim() || undefined;

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
