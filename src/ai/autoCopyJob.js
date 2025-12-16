const cron = require("node-cron");
const { getPool } = require("../lib/db");
const { env } = require("../lib/env");
const { runDuuminiAgent } = require("./duuminiAgent");

const AUTO_MODE = (env.DUUMINI_COPY_AUTO_MODE || "SAFE").toUpperCase(); // SAFE | FULL | LOG
const THRESHOLD = Number(env.DUUMINI_COPY_MIN_SCORE || 7);             // score cible
const MIN_GAIN = Number(env.DUUMINI_COPY_MIN_GAIN || 0.4);            // gain minimum

const PAGES = ["home", "about", "african-food", "african-market", "checkout"];

function json(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

async function getPageCopy(conn, slug, lang = "fr") {
  const [rows] = await conn.query(
    `SELECT id, slug, lang, data_json
       FROM page_copy
      WHERE slug=? AND lang=?
      LIMIT 1`,
    [slug, lang]
  );
  return rows[0] || null;
}

async function upsertAndVersion(conn, slug, lang, copy, meta) {
  const existing = await getPageCopy(conn, slug, lang);

  if (!existing) {
    const [ins] = await conn.query(
      `INSERT INTO page_copy (slug, lang, data_json, published_at)
       VALUES (?,?,?, NOW())`,
      [slug, lang, JSON.stringify(copy)]
    );
    const pageId = ins.insertId;

    await conn.query(
      `INSERT INTO page_copy_versions (page_copy_id, slug, lang, data_json, score_before, score_after, reason, created_by)
       VALUES (?,?,?,?,?,?,?, 'agent')`,
      [pageId, slug, lang, JSON.stringify(copy), meta.score_before, meta.score_after, meta.reason]
    );

    return { pageId, created: true };
  }

  const pageId = existing.id;

  // version
  await conn.query(
    `INSERT INTO page_copy_versions (page_copy_id, slug, lang, data_json, score_before, score_after, reason, created_by)
     VALUES (?,?,?,?,?,?,?, 'agent')`,
    [pageId, slug, lang, JSON.stringify(copy), meta.score_before, meta.score_after, meta.reason]
  );

  if (AUTO_MODE === "LOG") return { pageId, published: false };

  await conn.query(
    `UPDATE page_copy SET data_json=?, published_at=NOW() WHERE id=?`,
    [JSON.stringify(copy), pageId]
  );

  return { pageId, published: true };
}

async function runOnce() {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    for (const slug of PAGES) {
      const lang = "fr";

      const row = await getPageCopy(conn, slug, lang);
      const current = row ? json(row.data_json) : null;

      // 👉 seed minimal si pas encore en DB
      const seeded = current || seedCopyBySlug(slug);

      const result = await runDuuminiAgent("auto_site_copy", {
        slug,
        lang,
        current_copy: seeded,
        context: {
          cities: ["Casablanca", "Marrakech"],
          payment: "COD",
          brand: "Duumini",
        },
        constraints: perSlugConstraints(slug),
      });

      const scoreBefore = Number(result?.score_before ?? 0) || 0;
      const scoreAfter = Number(result?.score_after ?? 0) || 0;
      const improved = result?.copy && typeof result.copy === "object" ? result.copy : null;

      if (!improved) continue;

      const gain = scoreAfter - scoreBefore;

      const shouldPublish =
        AUTO_MODE === "FULL"
          ? (scoreAfter >= THRESHOLD || gain >= MIN_GAIN)
          : (scoreAfter >= THRESHOLD && gain >= MIN_GAIN);

      if (!shouldPublish) {
        // En mode SAFE/LOG, on peut juste enregistrer en version sans publier si tu veux.
        if (AUTO_MODE === "LOG") {
          await upsertAndVersion(conn, slug, lang, improved, {
            score_before: scoreBefore,
            score_after: scoreAfter,
            reason: `AUTO_LOG score=${scoreAfter} gain=${gain.toFixed(2)}`,
          });
        }
        continue;
      }

      await upsertAndVersion(conn, slug, lang, improved, {
        score_before: scoreBefore,
        score_after: scoreAfter,
        reason: `AUTO_${AUTO_MODE} score=${scoreAfter} gain=${gain.toFixed(2)}`,
      });
    }
  } finally {
    conn.release();
  }
}

/* ===== Seeds “copy page” (basé sur ton code actuel) ===== */
function seedCopyBySlug(slug) {
  if (slug === "home") {
    return {
      hero_title: "Duumini",
      hero_subtitle: "Produits d’Afrique subsaharienne au Maroc.",
      selection_title: "La sélection Duumini",
      selection_subtitle: "Les goûts de ton pays, partout où tu te trouves",
      cta_all: "Voir tout",
    };
  }
  if (slug === "about") {
    return {
      title: "À propos de Duumini",
      lead: "Duumini, le marché des produits africains au Maroc.",
      mission: "Faciliter l’accès aux produits authentiques de l’Afrique pour la diaspora et les curieux.",
      impact_title: "Impact & ambition",
      impact_text:
        "Booster l’activité économique de la diaspora africaine au Maroc avec plus de visibilité et des outils pro.",
      credo_title: "Notre credo",
      credo_text:
        "Professionnaliser la vente de produits africains au Maroc — du sourcing à la livraison.",
    };
  }
  if (slug === "african-food") {
    return {
      title: "Duumini Food",
      subtitle: "Plats & produits food — selon votre ville.",
      search_placeholder: "Rechercher un produit…",
      empty_state: "Aucun produit trouvé.",
    };
  }
  if (slug === "african-market") {
    return {
      title: "Duumini Market",
      subtitle: "Épicerie & produits — selon votre ville.",
      search_placeholder: "Rechercher un produit…",
      filter_label: "Filtrer par catégorie :",
      empty_state: "Aucun produit trouvé.",
    };
  }
  if (slug === "checkout") {
    return {
      title: "Confirmer la commande",
      guest_title: "Commander sans créer de compte",
      guest_hint: "Vous pouvez finaliser votre commande en tant qu’invité.",
      payment_title: "Paiement à la livraison",
      payment_hint: "Vous réglez à la réception — en espèces. Aucun acompte requis.",
      cta_confirm: "Confirmer la commande",
      cta_back: "Retour au panier",
    };
  }
  return {};
}

function perSlugConstraints(slug) {
  // limites simples pour éviter les pavés
  if (slug === "home") {
    return {
      hero_title: { max_chars: 26 },
      hero_subtitle: { max_chars: 70 },
      selection_title: { max_chars: 40 },
      selection_subtitle: { max_chars: 80 },
    };
  }
  return {
    title: { max_chars: 52 },
    subtitle: { max_chars: 90 },
    lead: { max_chars: 120 },
    empty_state: { max_chars: 70 },
  };
}

/**
 * Start cron:
 * - Tous les jours à 03:10 (heure serveur) → tu peux changer
 */
function startAutoCopyCron() {
  const cronExpr = env.DUUMINI_COPY_CRON || "10 3 * * *";
  cron.schedule(cronExpr, async () => {
    try {
      await runOnce();
      // console.log("[autoCopyJob] ok");
    } catch (e) {
      console.error("[autoCopyJob] failed", e);
    }
  });
}

module.exports = { startAutoCopyCron, runOnce };
