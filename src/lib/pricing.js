// src/lib/pricing.js
//
// Calcul de marge partagé par toutes les commissions (Duumini, affiliés,
// commerciaux) — Phase 2 : les pourcentages sur les ventes se calculent
// sur la marge (prix de vente - coût fournisseur), jamais sur le prix.
//
// La marge par article est plafonnée à 0 : un article vendu à perte
// (promo agressive, ajustement admin) ne peut pas faire baisser la marge
// des autres articles de la même commande, et ne génère simplement aucune
// commission sur cet article.
function computeItemMargin({ unit_price, unit_cost, qty }) {
  const price = Number(unit_price || 0);
  const cost = Number(unit_cost || 0);
  const q = Number(qty || 0);
  const marginPerUnit = Math.max(0, price - cost);
  return +(marginPerUnit * q).toFixed(2);
}

function sumOrderMargin(items = []) {
  const total = items.reduce((acc, it) => acc + computeItemMargin(it), 0);
  return +total.toFixed(2);
}

module.exports = { computeItemMargin, sumOrderMargin };
