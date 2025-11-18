// src/routes/share.js
const express = require("express");
const { getPool } = require("../lib/db");
const { env } = require("../lib/env");

const router = express.Router();

// URL du site web (front SPA) : https://duumini.com
const WEB_BASE_URL = (env.WEB_BASE_URL || "https://duumini.com").replace(/\/+$/, "");

// URL publique des images (souvent ton API ou Cloudinary)
const API_BASE_URL = (env.API_BASE_URL || WEB_BASE_URL).replace(/\/+$/, "");

/* Helper pour construire une URL image absolue */
function imgUrl(u) {
  if (!u) return null;
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("/")) return `${API_BASE_URL}${u}`;
  return `${API_BASE_URL}/${u}`;
}

/* Helper description courte */
function shortText(s, max = 200) {
  if (!s) return "";
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/* GET /share/product/:idOrSlug
 * - bots (Facebook, etc.) voient les balises OG du produit
 * - utilisateurs humains sont redirigés vers la rubrique (african-food / african-market)
 */
router.get("/product/:idOrSlug", async (req, res) => {
  const { idOrSlug } = req.params;
  const pool = await getPool();

  try {
    // On essaye de matcher soit par slug, soit par id
    const [rows] = await pool.query(
      `
      SELECT id, slug, name, description, price, cover, images, sub_category
      FROM products
      WHERE slug = ? OR id = ?
      LIMIT 1
    `,
      [idOrSlug, Number(idOrSlug) || 0]
    );

    let product = rows && rows[0];

    if (!product) {
      // Produit non trouvé -> OG génériques + redirection vers home
      const homeUrl = `${WEB_BASE_URL}/`;
      const pageUrl = `${WEB_BASE_URL}${req.originalUrl}`;

      const html404 = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Produit introuvable - Duumini</title>

    <meta property="og:title" content="Produit introuvable - Duumini" />
    <meta property="og:description" content="Ce produit n'est plus disponible sur Duumini." />
    <meta property="og:image" content="${WEB_BASE_URL}/og-image-default.jpg" />
    <meta property="og:url" content="${pageUrl}" />
    <meta property="og:type" content="website" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Produit introuvable - Duumini" />
    <meta name="twitter:description" content="Ce produit n'est plus disponible sur Duumini." />
    <meta name="twitter:image" content="${WEB_BASE_URL}/og-image-default.jpg" />

    <meta http-equiv="refresh" content="0;url=${homeUrl}" />
    <script>
      window.location.href = ${JSON.stringify(homeUrl)};
    </script>
  </head>
  <body>
    <p>Redirection vers <a href="${homeUrl}">${homeUrl}</a>…</p>
  </body>
</html>`;

      res.status(404).send(html404);
      return;
    }

    // Normalisation images (si JSON string en DB)
    let images = [];
    if (product.images) {
      if (typeof product.images === "string") {
        try {
          images = JSON.parse(product.images);
        } catch {
          images = [];
        }
      } else if (Array.isArray(product.images)) {
        images = product.images;
      }
    }

    const cover = product.cover || (images[0] && images[0].url) || null;
    const imageUrl = imgUrl(cover) || `${WEB_BASE_URL}/og-image-default.jpg`;

    const idOrSlugFinal = product.slug || product.id;

    // Redirection finale vers ta SPA : comme tu le voulais -> rubrique (food/market)
    const sub = (product.sub_category || "").toString().toLowerCase();
    const categoryPath = sub === "food" ? "/african-food" : "/african-market";
    const redirectUrl = `${WEB_BASE_URL}${categoryPath}`;

    const pageUrl = `${WEB_BASE_URL}/share/product/${encodeURIComponent(
      idOrSlugFinal
    )}`;

    const title = `${product.name} - Duumini`;
    const description =
      shortText(product.description, 200) ||
      "Découvrez ce produit sur Duumini, la plateforme des saveurs et produits d'Afrique subsaharienne.";

    const price = Number(product.price || 0);

    const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>

    <!-- Open Graph Facebook / Instagram / WhatsApp -->
    <meta property="og:type" content="product" />
    <meta property="og:title" content="${title.replace(/"/g, "&quot;")}" />
    <meta property="og:description" content="${description.replace(
      /"/g,
      "&quot;"
    )}" />
    <meta property="og:image" content="${imageUrl}" />
    <meta property="og:url" content="${pageUrl}" />

    <!-- Prix (optionnel) -->
    <meta property="product:price:amount" content="${price.toFixed(2)}" />
    <meta property="product:price:currency" content="MAD" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title.replace(/"/g, "&quot;")}" />
    <meta name="twitter:description" content="${description.replace(
      /"/g,
      "&quot;"
    )}" />
    <meta name="twitter:image" content="${imageUrl}" />

    <!-- Redirection rapide vers la SPA -->
    <meta http-equiv="refresh" content="0;url=${redirectUrl}" />
    <script>
      window.location.href = ${JSON.stringify(redirectUrl)};
    </script>
  </head>
  <body>
    <p>Redirection vers <a href="${redirectUrl}">${redirectUrl}</a>…</p>
  </body>
</html>`;

    res.send(html);
  } catch (err) {
    console.error("[share] error", err);
    res.status(500).send("Erreur serveur");
  }
});

module.exports = router;
