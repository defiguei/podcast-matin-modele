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
export const SERVICE_WORKER = `// Podcast du matin : notifications de l'application.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (ev) => ev.waitUntil(self.clients.claim()));
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
