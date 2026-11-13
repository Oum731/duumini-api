/* ===========================
   Duumini PWA + Pushy SW (FIX FB WebView)
   =========================== */

/* 1) Pushy (notifications en arrière-plan) */
try {
  importScripts("https://sdk.pushy.me/web/1.0.24/pushy-service-worker.js");
  console.log("[SW] Pushy service worker chargé");
} catch (err) {
  console.error("[SW] Impossible de charger le service worker Pushy :", err);
}

/* 2) App Shell + Offline Cache (robuste) */
const SW_VERSION = "duumini-sw-v2.8";

/**
 * ✅ IMPORTANT
 * - On NE précache PAS "/" (peut rediriger / varier)
 * - On précache seulement des URLs stables
 */
const CORE_ASSETS = [
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

/* helper : pré-cache sans casser l'install si une ressource échoue */
async function safeCacheAddAll(cache, urls) {
  for (const u of urls) {
    try {
      await cache.add(u);
    } catch (e) {
      console.warn("[SW] Pré-cache ignoré:", u, e);
    }
  }
}

/* Timeout réseau (évite les webviews qui pendent) */
function fetchWithTimeout(req, ms = 12000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(req)
      .then((r) => {
        clearTimeout(t);
        resolve(r);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

/* Install */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SW_VERSION);
      await safeCacheAddAll(cache, CORE_ASSETS);
      await self.skipWaiting();
    })()
  );
});

/* Activate */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SW_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/* Fetch */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // ❌ Ne JAMAIS intercepter SSE
  if (url.pathname.startsWith("/api/events/stream")) return;

  // ❌ Ne pas cacher l'API (évite stale et bugs)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req));
    return;
  }

  // ✅ Navigations → Network-first, fallback cache index.html
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetchWithTimeout(req, 12000);

          // si c'est du HTML, on met à jour le shell
          const ct = res.headers.get("content-type") || "";
          if (res.ok && ct.includes("text/html")) {
            const cache = await caches.open(SW_VERSION);
            await cache.put("/index.html", res.clone());
          }

          return res;
        } catch (e) {
          const cached = await caches.match("/index.html");
          return (
            cached ||
            new Response("<h1>Offline</h1>", {
              status: 503,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            })
          );
        }
      })()
    );
    return;
  }

  // ✅ Assets (js/css/img/font) → Stale-While-Revalidate (SANS 503 vide)
  const dest = req.destination;
  if (["style", "script", "image", "font"].includes(dest)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SW_VERSION);
        const cached = await cache.match(req);

        // 1) si cache: servir vite + revalidate en background
        if (cached) {
          event.waitUntil(
            fetchWithTimeout(req, 12000)
              .then((res) => {
                if (res && res.ok) return cache.put(req, res.clone());
              })
              .catch(() => {})
          );
          return cached;
        }

        // 2) sinon réseau
        try {
          const res = await fetchWithTimeout(req, 12000);
          if (res && res.ok) await cache.put(req, res.clone());
          return res;
        } catch (e) {
          // ✅ pas de fichier vide, on renvoie une vraie erreur
          return new Response("Asset unavailable", {
            status: 504,
            statusText: "Gateway Timeout",
          });
        }
      })()
    );
    return;
  }

  // Par défaut → Network, fallback cache si dispo
  event.respondWith(
    (async () => {
      try {
        return await fetchWithTimeout(req, 12000);
      } catch {
        const cached = await caches.match(req);
        return cached || new Response("", { status: 503, statusText: "Service Unavailable" });
      }
    })()
  );
});

/* Update */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
