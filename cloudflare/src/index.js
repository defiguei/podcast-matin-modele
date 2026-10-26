// Bot du « Podcast du matin » (Cloudflare Worker + Durable Object, offre gratuite).
//
// Le Worker n'est qu'une porte d'entrée : il vérifie qui frappe (un appareil
// connecté, GitHub) puis confie tout au Durable Object « Etat », qui garde les
// réglages, les règles et le planning, et réveille GitHub à l'heure de chaque épisode.
//
// Secrets Cloudflare : GITHUB_TOKEN, GEMINI_API_KEY.
// Variables (wrangler.toml) : DEPOT, ADRESSE.

import { Etat, VERSION } from "./etat.js";
import { Audio, objetAudio, nomValide, objetDuNom, typeDuNom, TAILLE_MAX } from "./audio.js";
import { SERVICE_WORKER } from "./notifications.js";
import { secretPartage, secretValide, empreinte } from "./services.js";
import { icone192, icone512, masque512, pomme180, badge96 } from "./icones.js";
import { verifierAudio } from "./miniapp.js";
import PAGE_APP from "./app.html";

export { Etat, Audio };

function cerveau(env) {
  return env.ETAT.get(env.ETAT.idFromName("podcast"));
}

function versCerveau(env, chemin, requete) {
  const url = new URL(chemin, "https://etat.interne");
  return cerveau(env).fetch(new Request(url, {
    method: requete?.method === "POST" ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: requete?.method === "POST" ? requete.body : undefined,
  }));
}

export default {
  async fetch(requete, env, ctx) {
    const url = new URL(requete.url);
    const secret = await secretPartage(env);

    // Application : la page, puis ses demandes (chaque appareil a son jeton).
    if (url.pathname === "/app" || url.pathname === "/app/") {
      return new Response(PAGE_APP, { headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      } });
    }
    // Notifications de l'application : le service worker (portée /app).
    if (url.pathname === "/app/sw.js") {
      return new Response(SERVICE_WORKER, { headers: { "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/app", "Cache-Control": "no-cache" } });
    }
    // Application installable (écran d'accueil, navigateur) : manifeste et icônes.
    if (url.pathname === "/app/manifest.json") {
      return Response.json({
        name: "Podcast Matin", short_name: "Podcast", lang: "fr", start_url: "/app", scope: "/app", display: "standalone",
        background_color: "#12151C", theme_color: "#12151C",
        icons: [{ src: "/app/icone-192.png", sizes: "192x192", type: "image/png" }, { src: "/app/icone-512.png", sizes: "512x512", type: "image/png" },
                { src: "/app/icone-masque.png", sizes: "512x512", type: "image/png", purpose: "maskable" }],
      }, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" } });
    }
    const icones = { "/app/icone-192.png": icone192, "/app/icone-512.png": icone512, "/app/icone-masque.png": masque512, "/app/apple-touch-icon.png": pomme180,
                     "/app/badge.png": badge96 };   // petite icône des notifications (Android n'en garde que la forme)
    if (icones[url.pathname]) {
      return new Response(Uint8Array.from(atob(icones[url.pathname]), (c) => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
    }
    // Un appareil se connecte avec le code affiché dans l'application (ou donné par GitHub).
    if (url.pathname === "/app/connexion") {
      if (requete.method !== "POST") return new Response("interdit", { status: 405 });
      const corps = (await requete.text()).slice(0, 2000);
      return cerveau(env).fetch(new Request("https://etat.interne/appareil/connexion", { method: "POST", headers: { "Content-Type": "application/json" }, body: corps }));
    }

    // Lecteur audio de l'application : adresse signée ; fichier gardé par le bot.
    if (url.pathname === "/app/audio") {
      const cle = await verifierAudio(secret, url.searchParams);
      if (!cle) return new Response("lien expiré : rouvre l'application", { status: 403 });
      const ref = await (await cerveau(env).fetch(new Request(`https://etat.interne/app/fichier?cle=${encodeURIComponent(cle)}`))).json();
      return servirFichier(env, ref, requete);
    }
    if (url.pathname === "/app/api") {
      if (requete.method !== "POST") return new Response("interdit", { status: 405 });
      // Le jeton de l'appareil (seule son empreinte est gardée par le bot).
      const jetonAppareil = requete.headers.get("X-Appareil") || "";
      const verifie = /^[0-9a-f]{64}$/.test(jetonAppareil)
        ? await (await cerveau(env).fetch(new Request(`https://etat.interne/appareil/verifier?e=${await empreinte(`appareil:${jetonAppareil}`, 64)}`))).json()
        : { ok: false };
      if (!verifie.ok) return Response.json({ ok: false, erreur: "Cet appareil n'est pas (ou plus) autorisé : connecte-le avec un code.", appareil: "inconnu" }, { status: 401 });
      const controle = { ok: true, appareil: verifie.id };
      const corps = await requete.text();
      // Une demande vocale (WAV en base64, une minute au plus) dépasse largement les autres.
      if (corps.length > 4_200_000) return Response.json({ ok: false, erreur: "Message trop long : une minute au plus." }, { status: 413 });
      // L'appareil qui demande : ses notifications lui sont rattachées.
      return cerveau(env).fetch(new Request("https://etat.interne/app", { method: "POST", body: corps,
        headers: { "Content-Type": "application/json", "X-Appareil-Id": controle.appareil || "" } }));
    }

    // Flux privé du podcast (Apple Podcasts, AntennaPod…) : l'adresse contient un jeton secret.
    const flux = /^\/flux\/([0-9a-f]{32})(?:\.xml|\/(\d{4}-\d{2}-\d{2}-\d+)\.(mp3|jpg|json))$/.exec(url.pathname);
    if (flux) {
      const [, jeton, cle, extension] = flux;
      const quoi = !cle ? "xml" : extension === "json" ? "chapitres" : extension === "jpg" ? "image" : "audio";
      const r = await versCerveau(env, `/flux?jeton=${jeton}&quoi=${quoi}${cle ? `&cle=${cle}` : ""}`);
      if (quoi === "xml" || quoi === "chapitres" || !r.ok) return r;
      return servirFichier(env, await r.json(), requete);
    }

    // GitHub (fabrication des épisodes) : lecture des réglages, événements.
    if (url.pathname.startsWith("/api/")) {
      if (!(await secretValide(env, requete.headers.get("X-Podcast-Secret")))) return new Response("interdit", { status: 403 });
      // Dépôt d'un fichier (MP3, pochette, extrait de voix) : rangé directement dans l'objet de son mois.
      if (url.pathname === "/api/fichier") {
        const nom = url.searchParams.get("nom") || "";
        if (requete.method !== "PUT") return new Response("méthode refusée", { status: 405 });
        if (!nomValide(nom) || !typeDuNom(nom)) return Response.json({ ok: false, erreur: "nom de fichier refusé" }, { status: 400 });
        if (Number(requete.headers.get("Content-Length") || 0) > TAILLE_MAX) return Response.json({ ok: false, erreur: "fichier trop gros" }, { status: 413 });
        const r = await objetAudio(env, objetDuNom(nom)).fetch(new Request(`https://audio.interne/f/${encodeURIComponent(nom)}`,
          { method: "PUT", body: requete.body, headers: { "Content-Type": typeDuNom(nom) } }));
        const resultat = await r.json().catch(() => ({ ok: false, erreur: `stockage : erreur ${r.status}` }));
        // Le cerveau tient le compte de la place prise (affichée dans l'application, ménage d'un an).
        if (resultat.ok) await cerveau(env).fetch(new Request(`https://etat.interne/fichier-depose?nom=${encodeURIComponent(nom)}&taille=${resultat.taille}`));
        return Response.json(resultat, { status: r.status });
      }
      return versCerveau(env, url.pathname + url.search, requete);
    }

    // Outils de test local uniquement (horloge simulée, état complet).
    if (url.pathname.startsWith("/test/")) {
      if (env.MODE_TEST !== "1") return new Response("introuvable", { status: 404 });
      return versCerveau(env, url.pathname + url.search, requete);
    }

    if (url.pathname === "/installer") {
      return versCerveau(env, `/installer?adresse=${encodeURIComponent(url.origin)}`);
    }

    if (url.pathname === "/") {
      return new Response(`✅ Bot du podcast actif — version ${VERSION}`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("introuvable", { status: 404 });
  },

  // Filet de sécurité toutes les heures : installe une nouvelle version et
  // vérifie que le prochain réveil est bien programmé.
  async scheduled(evenement, env, ctx) {
    const adresse = env.ADRESSE || "";
    ctx.waitUntil(versCerveau(env, `/tick?adresse=${encodeURIComponent(adresse)}`)
      .catch((erreur) => console.log("Tic impossible :", erreur.message)));
  },
};

// Un fichier gardé par le bot (épisode, pochette, extrait…), lu par plages si demandé.
async function servirFichier(env, ref, requete) {
  if (!ref?.fichier || !nomValide(ref.fichier)) return new Response("fichier introuvable", { status: 404 });
  const plage = requete.headers.get("Range");
  return objetAudio(env, objetDuNom(ref.fichier)).fetch(new Request(`https://audio.interne/f/${encodeURIComponent(ref.fichier)}`,
    { method: requete.method === "HEAD" ? "HEAD" : "GET", headers: plage ? { Range: plage } : {} }));
}
