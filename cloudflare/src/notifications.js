// Notifications de l'application (norme Web Push) : « ton épisode est prêt »
// sur le téléphone, sans service payant. Le navigateur fournit
// une adresse d'abonnement (chez Google, Apple ou Mozilla) ; le bot y envoie un
// message chiffré pour ce seul appareil (RFC 8291), signé avec sa propre clé
// (VAPID, RFC 8292), créée au premier besoin et gardée dans son stockage.

const encodeur = new TextEncoder();

export function base64url(octets) {
  let texte = "";
  for (const o of new Uint8Array(octets)) texte += String.fromCharCode(o);
  return btoa(texte).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function depuisBase64url(texte) {
  const brut = atob(String(texte).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(texte).length / 4) * 4, "="));
  return Uint8Array.from(brut, (c) => c.charCodeAt(0));
}

const coller = (...morceaux) => {
  const total = new Uint8Array(morceaux.reduce((n, m) => n + m.length, 0));
  let i = 0;
  for (const m of morceaux) { total.set(m, i); i += m.length; }
  return total;
};

// Clé du bot pour signer ses envois : { publique (base64url, 65 octets), privee (JWK) }.
export async function nouvellesClesVapid() {
  const paire = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publique: base64url(await crypto.subtle.exportKey("raw", paire.publicKey)),
    privee: await crypto.subtle.exportKey("jwk", paire.privateKey),
  };
}

// Un abonnement tel que le navigateur le donne (PushSubscription.toJSON()), vérifié.
export function abonnementValide(abonnement, modeTest = false) {
  const endpoint = String(abonnement?.endpoint || "");
  const p256dh = String(abonnement?.keys?.p256dh || ""), auth = String(abonnement?.keys?.auth || "");
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  const local = modeTest && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !local) || endpoint.length > 1000) return null;
  try {
    if (depuisBase64url(p256dh).length !== 65 || depuisBase64url(auth).length !== 16) return null;
  } catch { return null; }
  return { endpoint, keys: { p256dh, auth } };
}

// Signature VAPID : un jeton JWT (ES256) pour le service de l'abonnement.
async function jetonVapid(endpoint, cles, sujet) {
  const entete = base64url(encodeur.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const charge = base64url(encodeur.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sujet,
  })));
  const privee = await crypto.subtle.importKey("jwk", cles.privee, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privee, encodeur.encode(`${entete}.${charge}`));
  return `${entete}.${charge}.${base64url(signature)}`;
}

async function hkdf(sel, secret, info, octets) {
  const cle = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sel, info }, cle, octets * 8));
}

// Chiffrement « aes128gcm » (RFC 8188 et 8291) : seul l'appareil abonné peut lire.
export async function chiffrer(abonnement, texte) {
  const publiqueAppareil = depuisBase64url(abonnement.keys.p256dh);
  const secretAuth = depuisBase64url(abonnement.keys.auth);
  const ephemere = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publiqueServeur = new Uint8Array(await crypto.subtle.exportKey("raw", ephemere.publicKey));
  const cleAppareil = await crypto.subtle.importKey("raw", publiqueAppareil, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const partage = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: cleAppareil }, ephemere.privateKey, 256));
  const ikm = await hkdf(secretAuth, partage, coller(encodeur.encode("WebPush: info\0"), publiqueAppareil, publiqueServeur), 32);
  const sel = crypto.getRandomValues(new Uint8Array(16));
  const cleContenu = await hkdf(sel, ikm, encodeur.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(sel, ikm, encodeur.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cleContenu, "AES-GCM", false, ["encrypt"]);
  // Un seul enregistrement : le texte suivi du délimiteur 0x02 (dernier enregistrement).
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, coller(encodeur.encode(texte), new Uint8Array([2]))));
  const entete = new Uint8Array(16 + 4 + 1 + 65);
  entete.set(sel, 0);
  new DataView(entete.buffer).setUint32(16, 4096);
  entete[20] = 65;
  entete.set(publiqueServeur, 21);
  return coller(entete, chiffre);
}

// Envoie { titre, corps, url, tag } à un abonnement. Renvoie le statut HTTP
// (201 : remis au service ; 404 ou 410 : abonnement disparu, à oublier).
export async function envoyerNotification(abonnement, message, cles, sujet, delai = 8000) {
  const corps = await chiffrer(abonnement, JSON.stringify(message));
  const r = await fetch(abonnement.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      TTL: String(message.ttl || 12 * 3600), Urgency: "normal",
      Authorization: `vapid t=${await jetonVapid(abonnement.endpoint, cles, sujet)}, k=${cles.publique}`,
    },
    body: corps,
    signal: AbortSignal.timeout(delai),
  });
  return r.status;
}

// Le service worker de l'application (/app/sw.js) : il affiche les notifications
// et ouvre l'application sur l'épisode quand on les touche.
export const SERVICE_WORKER = `// Podcast du matin : notifications et fonctionnement hors ligne de l'application.
// Hors ligne : la page et ses icônes sont gardées (la page se rafraîchit à chaque ouverture avec du réseau),
// les épisodes écoutés sont servis depuis le cache audio rempli par la page (avec les plages Range).
// Les données (réglages, épisodes) sont gardées par la page elle-même.
const COQUE = "podcast-coque-1";
const POLICES = "podcast-polices";
const AUDIO = "podcast-audio";
const IMAGES = "podcast-images";
const PAGE = "/app";
const A_GARDER = ["/app/manifest.json", "/app/icone-192.png", "/app/icone-512.png", "/app/icone-masque.png", "/app/apple-touch-icon.png", "/app/badge.png"];
const MAX_IMAGES = 200;
const DELAI_RESEAU = 4000;   // au-delà, on ouvre la page gardée (réseau absent ou très mauvais)

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    try {
      const cache = await caches.open(COQUE);
      await Promise.all(A_GARDER.map((u) => cache.add(u).catch(() => {})));
      const page = await fetch(PAGE, { cache: "no-store" });
      if (page.ok) await cache.put(PAGE, page);
    } catch (e) { /* pas de réseau à l'installation : la page sera gardée à la prochaine ouverture */ }
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (ev) => ev.waitUntil((async () => {
  for (const nom of await caches.keys()) if (nom.indexOf("podcast-coque-") === 0 && nom !== COQUE) await caches.delete(nom);
  await self.clients.claim();
})()));

const delai = (ms) => new Promise((_, refus) => setTimeout(() => refus(new Error("delai")), ms));

// La page : le réseau d'abord (elle est toujours à jour), la copie gardée sans réseau.
async function page(ev) {
  const cache = await caches.open(COQUE);
  const reseau = fetch(PAGE, { cache: "no-store" }).then(async (r) => {
    if (r.ok) await cache.put(PAGE, r.clone());
    return r;
  });
  try {
    return await Promise.race([reseau, delai(DELAI_RESEAU)]);
  } catch (e) {
    const gardee = await cache.match(PAGE);
    if (!gardee) return reseau;
    ev.waitUntil(reseau.catch(() => {}));   // si le réseau finit par répondre, la copie est rafraîchie
    return gardee;
  }
}

// Icônes et polices : la copie gardée d'abord, rafraîchie en arrière-plan.
async function coque(ev, nomCache) {
  const cache = await caches.open(nomCache);
  const gardee = await cache.match(ev.request);
  const reseau = fetch(ev.request).then(async (r) => {
    if (r.ok || r.type === "opaque") await cache.put(ev.request, r.clone());
    return r;
  });
  if (gardee) { ev.waitUntil(reseau.catch(() => {})); return gardee; }
  return reseau;
}

// Une plage d'un fichier gardé (le lecteur lit par morceaux et saute dans l'épisode).
async function tranche(requete, gardee) {
  const blob = await gardee.blob();
  const total = blob.size;
  const type = gardee.headers.get("Content-Type") || "audio/mpeg";
  const base = { "Content-Type": type, "Accept-Ranges": "bytes" };
  const plage = /^bytes=([0-9]*)-([0-9]*)$/.exec(requete.headers.get("Range") || "");
  if (!plage || (plage[1] === "" && plage[2] === "")) {
    return new Response(blob, { status: 200, headers: Object.assign({ "Content-Length": String(total) }, base) });
  }
  const debut = plage[1] === "" ? Math.max(0, total - Number(plage[2])) : Number(plage[1]);
  const fin = plage[1] === "" || plage[2] === "" ? total - 1 : Math.min(Number(plage[2]), total - 1);
  if (debut > fin || debut >= total) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + total } });
  return new Response(blob.slice(debut, fin + 1, type), { status: 206,
    headers: Object.assign({ "Content-Length": String(fin - debut + 1), "Content-Range": "bytes " + debut + "-" + fin + "/" + total }, base) });
}

// Lecteur et pochettes : l'adresse est signée et expire, la copie gardée se retrouve par la clé (c=…).
async function fichier(ev) {
  const cle = new URL(ev.request.url).searchParams.get("c") || "";
  if (!cle) return fetch(ev.request);
  const clef = "/app/hors-ligne/" + encodeURIComponent(cle);
  if (cle.indexOf("img:") === 0) {
    const cache = await caches.open(IMAGES);
    const gardee = await cache.match(clef);
    if (gardee) return gardee;
    const r = await fetch(ev.request);
    if (r.ok) ev.waitUntil((async () => {
      await cache.put(clef, r.clone());
      const cles = await cache.keys();
      for (const k of cles.slice(0, Math.max(0, cles.length - MAX_IMAGES))) await cache.delete(k);
    })());
    return r;
  }
  const gardee = await (await caches.open(AUDIO)).match(clef);
  return gardee ? tranche(ev.request, gardee) : fetch(ev.request);
}

self.addEventListener("fetch", (ev) => {
  if (ev.request.method !== "GET") return;
  const url = new URL(ev.request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname === "/app" || url.pathname === "/app/") return ev.respondWith(page(ev));
    if (url.pathname === "/app/audio") return ev.respondWith(fichier(ev));
    if (A_GARDER.indexOf(url.pathname) >= 0) return ev.respondWith(coque(ev, COQUE));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    return ev.respondWith(coque(ev, POLICES));
  }
});

self.addEventListener("push", (ev) => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = { corps: ev.data ? ev.data.text() : "" }; }
  ev.waitUntil(self.registration.showNotification(d.titre || "Podcast du matin", {
    body: d.corps || "", icon: "/app/icone-192.png", badge: "/app/badge.png",
    tag: d.tag || "podcast", data: { url: d.url || "/app" },
  }));
});
self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  const cible = new URL((ev.notification.data && ev.notification.data.url) || "/app", self.location.origin).href;
  ev.waitUntil((async () => {
    const fenetres = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const f of fenetres) {
      if (new URL(f.url).pathname.startsWith("/app")) {
        await f.focus();
        if (f.navigate) await f.navigate(cible).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(cible);
  })());
});
`;
