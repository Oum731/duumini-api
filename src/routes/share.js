// api/routes/share.js
const { Router } = require("express");
const { getPool } = require("../lib/db");
const { env } = require("../lib/env");

const router = Router();

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absUrl(req, maybeUrl, { apiBase, webBase } = {}) {
  if (!maybeUrl) return "";
  const u = String(maybeUrl).trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;

  const originFromReq = `${req.protocol}://${req.get("host")}`;
  const WEB = (webBase || env.FRONT_WEB_BASE_URL || process.env.FRONT_WEB_BASE_URL || originFromReq).replace(/\/+$/, "");
  const API = (apiBase || env.API_PUBLIC_ORIGIN || process.env.API_PUBLIC_ORIGIN || originFromReq).replace(/\/+$/, "");

  const base = u.startsWith("/uploads") || u.startsWith("/media") ? API : WEB;
  return u.startsWith("/") ? `${base}${u}` : `${base}/${u}`;
}

router.get("/product/:id", async (req, res, next) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(404).send("Not found");

  const pool = getPool();

  try {
    const webBase = (env.FRONT_WEB_BASE_URL || process.env.FRONT_WEB_BASE_URL || "https://www.duumini.com").replace(/\/+$/, "");
    const apiBase = (env.API_PUBLIC_ORIGIN || process.env.API_PUBLIC_ORIGIN || "https://duumini-api.onrender.com").replace(/\/+$/, "");

    const [rows] = await pool.query(
      `
      SELECT
        p.id, p.slug, p.name, p.description, p.price, p.currency, p.is_active,
        s.name AS shop_name,
        sc.slug AS sub_category_slug,
        (SELECT url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY pi.sort_order ASC, pi.id ASC
          LIMIT 1) AS cover_img,
        p.cover AS cover_col,
        s.cover AS shop_cover,
        s.logo  AS shop_logo
      FROM products p
      LEFT JOIN shops s ON s.id = p.shop_id
      LEFT JOIN sub_categories sc ON sc.id = p.sub_category_id
      WHERE p.id=? LIMIT 1
      `,
      [id]
    );

    const p = rows[0];
    if (!p || Number(p.is_active || 0) !== 1) return res.status(404).send("Not found");

    const title = escapeHtml(`${p.name || "Produit Duumini"}${p.shop_name ? ` — ${p.shop_name}` : ""}`);

    const descRaw = p.description || "Découvrez ce produit africain disponible sur Duumini.";
    const shortDesc = descRaw.length > 180 ? descRaw.slice(0, 177) + "..." : descRaw;
    const description = escapeHtml(shortDesc);

    const imgPick = p.cover_img || p.cover_col || p.shop_cover || p.shop_logo || null;
    let ogImage = absUrl(req, imgPick, { apiBase, webBase });
    if (!ogImage) ogImage = `${webBase}/images/share-default-product.jpg`;

    // ✅ page produit du FRONT (cible finale)
    const finalUrl = `${webBase}/products/${encodeURIComponent(p.id)}`;

    // ✅ l'URL de partage réelle (cette route API)
    // Si ton router est monté en /api/share => ce sera /api/share/product/:id
    const apiShareUrl = `${apiBase}${req.baseUrl}/product/${encodeURIComponent(p.id)}`;

    const priceAmount = Number(p.price || 0);
    const priceCurrency = escapeHtml(p.currency || "MAD");

    const sub = String(p.sub_category_slug || "").trim().toLowerCase();
    const categoryLabel = sub === "food" ? "African Food" : "African Market";

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: String(p.name || "Produit Duumini"),
      description: shortDesc,
      image: [ogImage],
      sku: String(p.id),
      brand: { "@type": "Brand", name: "Duumini" },
      category: categoryLabel,
      offers: {
        "@type": "Offer",
        priceCurrency: String(p.currency || "MAD"),
        price: priceAmount,
        availability: "https://schema.org/InStock",
        url: finalUrl,
      },
    };

    const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <meta name="robots" content="noindex, nofollow, noarchive" />
    <link rel="canonical" href="${finalUrl}" />

    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="Duumini" />
    <meta property="og:locale" content="fr_FR" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:url" content="${apiShareUrl}" />

    <meta property="product:price:amount" content="${priceAmount}" />
    <meta property="product:price:currency" content="${priceCurrency}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${ogImage}" />

    <script type="application/ld+json">
${JSON.stringify(jsonLd)}
    </script>

    <meta http-equiv="refresh" content="0;url=${finalUrl}" />
    <script>window.location.replace(${JSON.stringify(finalUrl)});</script>
  </head>
  <body>
    <p>Redirection vers <a href="${finalUrl}">${finalUrl}</a>…</p>
  </body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.status(200).send(html);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
