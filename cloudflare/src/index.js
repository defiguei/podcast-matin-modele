// Bot du « Podcast du matin » (Cloudflare Worker + Durable Object, offre gratuite).
//
// Le Worker n'est qu'une porte d'entrée : il vérifie qui frappe (Telegram,
// GitHub) puis confie tout au Durable Object « Etat », qui garde les réglages,
// les règles et le planning, et réveille GitHub à l'heure de chaque épisode.
//
// Secrets Cloudflare (déjà en place depuis la première version) :
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GITHUB_TOKEN, GEMINI_API_KEY
// Variables (wrangler.toml) : DEPOT, ADRESSE.

import { Etat, VERSION } from "./etat.js";
import { Audio, objetAudio, nomValide, objetDuNom, typeDuNom, TAILLE_MAX } from "./audio.js";
import { SERVICE_WORKER } from "./notifications.js";
import { secretPartage, secretValide, telegramActif, Telegram, empreinte } from "./services.js";
import { icone192, icone512, masque512, pomme180, badge96 } from "./icones.js";
import { verifierOuverture, verifierAudio } from "./miniapp.js";
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

    // Telegram : chaque message, bouton ou réaction arrive ici à l'instant.
    if (url.pathname === "/telegram") {
      if (requete.method !== "POST" || !telegramActif(env) || requete.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
        return new Response("interdit", { status: 403 });
      }
      const corps = await requete.text();
      // On répond tout de suite à Telegram ; le cerveau travaille ensuite.
      ctx.waitUntil(cerveau(env).fetch(new Request("https://etat.interne/telegram", { method: "POST", body: corps }))
        .catch((erreur) => console.log("Cerveau injoignable :", erreur.message)));
      return new Response("ok");
    }

    // Application (Mini App Telegram) : la page, puis ses demandes signées par Telegram.
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
    // Hors de Telegram : un appareil se connecte avec le code affiché dans l'application.
    if (url.pathname === "/app/connexion") {
      if (requete.method !== "POST") return new Response("interdit", { status: 405 });
      const corps = (await requete.text()).slice(0, 2000);
      return cerveau(env).fetch(new Request("https://etat.interne/appareil/connexion", { method: "POST", headers: { "Content-Type": "application/json" }, body: corps }));
    }

    // Lecteur audio de l'application : adresse signée ; fichier gardé par le bot (ou, avant, par Telegram).
    if (url.pathname === "/app/audio") {
      const cle = await verifierAudio(secret, url.searchParams);
      if (!cle) return new Response("lien expiré : rouvre l'application", { status: 403 });
      const ref = await (await cerveau(env).fetch(new Request(`https://etat.interne/app/fichier?cle=${encodeURIComponent(cle)}`))).json();
      return servirFichier(env, ref, requete, cle.startsWith("img:") ? "image/jpeg" : "audio/mpeg");
    }
    if (url.pathname === "/app/api") {
      if (requete.method !== "POST") return new Response("interdit", { status: 405 });
      let controle = await verifierOuverture(requete.headers.get("X-Telegram-Init-Data"), env);
      // Hors de Telegram : le jeton de l'appareil (seule son empreinte est gardée par le bot).
      const jetonAppareil = requete.headers.get("X-Appareil") || "";
      if (!controle.ok && /^[0-9a-f]{64}$/.test(jetonAppareil)) {
        const verifie = await (await cerveau(env).fetch(new Request(`https://etat.interne/appareil/verifier?e=${await empreinte(`appareil:${jetonAppareil}`, 64)}`))).json();
        if (verifie.ok) controle = { ok: true, appareil: verifie.id };
        else return Response.json({ ok: false, erreur: "Cet appareil n'est plus autorisé : reconnecte-le avec un nouveau code.", appareil: "inconnu" }, { status: 401 });
      }
      if (!controle.ok) return Response.json({ ok: false, erreur: "Ouverture non reconnue : ferme puis rouvre l'application depuis le bot.", raison: controle.raison }, { status: 401 });
      const corps = await requete.text();
      // Une demande vocale (WAV en base64, une minute au plus) dépasse largement les autres.
      if (corps.length > 4_200_000) return Response.json({ ok: false, erreur: "Message trop long : une minute au plus." }, { status: 413 });
      // L'appareil qui demande (vide dans Telegram) : ses notifications lui sont rattachées.
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
      return servirFichier(env, await r.json(), requete, quoi === "image" ? "image/jpeg" : "audio/mpeg");
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

    if (url.pathname === "/desinstaller") {
      if (!secret || url.searchParams.get("secret") !== secret) {
        return new Response("Pour désinstaller, ajoute ?secret=… (voir le README).", { status: 403 });
      }
      const r = await new Telegram(env).appeler("deleteWebhook", {});
      return new Response(r.ok ? "Bot instantané désactivé : les messages repartent vers GitHub." : `Telegram refuse : ${r.description}`);
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

// Un fichier d'épisode : gardé par le bot (ref.fichier) ou, pour les épisodes d'avant, par Telegram (ref.file_id).
async function servirFichier(env, ref, requete, type) {
  if (ref?.fichier && nomValide(ref.fichier)) {
    const plage = requete.headers.get("Range");
    const r = await objetAudio(env, objetDuNom(ref.fichier)).fetch(new Request(`https://audio.interne/f/${encodeURIComponent(ref.fichier)}`,
      { method: requete.method === "HEAD" ? "HEAD" : "GET", headers: plage ? { Range: plage } : {} }));
    if (r.status !== 404 || !ref.file_id) return r;    // perdu chez le bot : Telegram en secours
  }
  if (!ref?.file_id) return new Response("fichier introuvable", { status: 404 });
  return lireAudio(env, ref.file_id, requete.headers.get("Range"), type);
}

// Récupère un fichier chez Telegram et le renvoie au lecteur, morceau par morceau
// (les iPhone exigent les requêtes « Range » pour lire et avancer dans l'audio).
async function lireAudio(env, fichier, plage, type = "audio/mpeg") {
  const tg = new Telegram(env);
  const infos = await tg.appeler("getFile", { file_id: fichier });
  if (!infos.ok) return new Response("fichier indisponible", { status: 502 });
  const source = `${tg.fichiers}/${infos.result.file_path}`;
  const entetes = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  const r = await fetch(source, plage ? { headers: { Range: plage } } : {});
  if (r.status === 206) {
    return new Response(r.body, { status: 206, headers: { ...entetes, "Content-Range": r.headers.get("Content-Range"), "Content-Length": r.headers.get("Content-Length") } });
  }
  if (!r.ok) return new Response("fichier indisponible", { status: 502 });
  const m = plage && /^bytes=(\d*)-(\d*)$/.exec(plage);
  if (!m) return new Response(r.body, { status: 200, headers: { ...entetes, ...(r.headers.get("Content-Length") ? { "Content-Length": r.headers.get("Content-Length") } : {}) } });
  // Telegram a tout renvoyé : on découpe nous-mêmes le morceau demandé.
  const octets = new Uint8Array(await r.arrayBuffer());
  const taille = octets.length;
  let debut = m[1] === "" ? Math.max(0, taille - Number(m[2])) : Number(m[1]);
  let fin = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), taille - 1) : taille - 1;
  if (debut >= taille || debut > fin) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${taille}` } });
  return new Response(octets.slice(debut, fin + 1), { status: 206, headers: { ...entetes, "Content-Range": `bytes ${debut}-${fin}/${taille}`, "Content-Length": String(fin - debut + 1) } });
}
