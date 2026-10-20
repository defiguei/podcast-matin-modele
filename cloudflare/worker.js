// Bot instantané du « Podcast du matin » (Cloudflare Worker, offre gratuite).
//
// Telegram transmet chaque message à ce Worker à l'instant où tu l'envoies
// (webhook). Le Worker demande à Gemini de comprendre ta demande (texte ou
// vocal), range tes réglages dans preferences.json sur GitHub et te répond en
// quelques secondes. GitHub ne sert plus qu'à fabriquer les épisodes.
//
// Variables à définir dans Cloudflare (Settings → Variables and Secrets) :
//   TELEGRAM_BOT_TOKEN  (secret) jeton du bot donné par BotFather
//   TELEGRAM_CHAT_ID    (secret) ton identifiant de conversation
//   GITHUB_TOKEN        (secret) jeton GitHub limité au dépôt :
//                                « Actions » et « Contents » en Read and write
//   GEMINI_API_KEY      (secret) ta clé Gemini
//   DEPOT               (texte)  ex. TON-COMPTE/podcast-matin
//
// Mise en route : ouvre une fois https://<ton-worker>.workers.dev/installer
// Pour revenir à l'ancien fonctionnement : https://<ton-worker>.workers.dev/desinstaller

const FICHIER_PREFERENCES = "preferences.json";
const WORKFLOW_EPISODE = "podcast-du-matin.yml";
const MODELES = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const VITESSES = ["très lente", "lente", "normale", "rapide", "très rapide"];
const MAX_EPISODES_REFAITS = 3;
const FUSEAU = "Europe/Zurich";

const AIDE = `🎙️ Je suis le bot de ton podcast du matin. Écris-moi, ou envoie-moi un vocal, pour l'ajuster. Par exemple :
• « parle un peu plus lentement »
• « le sport ne m'intéresse pas »
• « creuse la réforme des retraites demain »
• « fais des épisodes de 4 minutes »
• « refais le podcast en creusant l'actu locale »

Je réponds en quelques secondes ; c'est pris en compte dès l'épisode suivant.

/podcast : un nouvel épisode tout de suite
/reglages : voir tes réglages actuels
/reinitialiser : revenir aux réglages de base`;

export default {
  async fetch(requete, env, ctx) {
    const url = new URL(requete.url);
    const manque = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_TOKEN", "GEMINI_API_KEY", "DEPOT"]
      .filter((nom) => !env[nom]);
    if (url.pathname === "/telegram" && requete.method === "POST") {
      if (requete.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await secretWebhook(env))) {
        return new Response("refusé", { status: 403 });
      }
      const miseAJour = await requete.json().catch(() => null);
      // On répond tout de suite à Telegram, le traitement continue en arrière-plan.
      if (miseAJour) ctx.waitUntil(traiter(miseAJour, env).catch((e) => console.log("Erreur :", e.stack || e)));
      return new Response("ok");
    }
    if (manque.length) return texte(`Variables manquantes dans Cloudflare : ${manque.join(", ")}`);
    if (url.pathname === "/installer") {
      const r = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: await secretWebhook(env),
        allowed_updates: ["message"],
      });
      return texte(r.ok ? "✅ Bot instantané activé. Écris à ton bot : il répond en quelques secondes."
                        : `Telegram refuse : ${r.description}`);
    }
    if (url.pathname === "/desinstaller") {
      const r = await telegram(env, "deleteWebhook", {});
      return texte(r.ok ? "Bot instantané désactivé : retour à la lecture par GitHub." : `Telegram refuse : ${r.description}`);
    }
    const info = await telegram(env, "getWebhookInfo", {});
    const actif = info.ok && info.result.url.endsWith("/telegram");
    return texte(actif
      ? `✅ Bot instantané actif.${info.result.last_error_message ? ` Dernière erreur Telegram : ${info.result.last_error_message}` : ""}`
      : "Bot instantané pas encore activé : ouvre /installer à la fin de cette adresse.");
  },
  async scheduled() {
    // Plus rien à faire chaque minute : Telegram prévient le Worker directement.
  },
};

// ─────────────────────────────── traitement ─────────────────────────────────

async function traiter(miseAJour, env) {
  const message = miseAJour.message;
  if (!message || String(message.chat?.id) !== String(env.TELEGRAM_CHAT_ID) || message.from?.is_bot) return;
  const chat = env.TELEGRAM_CHAT_ID;
  const ecrit = String(message.text || message.caption || "").trim();

  if (ecrit.startsWith("/")) {
    const commande = ecrit.split(/\s+/)[0].split("@")[0].toLowerCase();
    if (["/reglages", "/preferences", "/préférences"].includes(commande)) {
      const { prefs } = await lirePreferences(env);
      return envoyer(env, chat, resumeReglages(await reglagesDeBase(env), prefs));
    }
    if (["/reinitialiser", "/réinitialiser", "/reset"].includes(commande)) {
      await modifierPreferences(env, "Bot : réglages remis à zéro", (prefs) => {
        prefs.preferences = preferencesVides();
        prefs.a_approfondir = [];
      });
      return envoyer(env, chat, "🔄 C'est remis à zéro : le podcast reprend ses réglages de base (ceux de reglages.toml).");
    }
    if (["/podcast", "/episode", "/épisode", "/nouveau"].includes(commande)) {
      return envoyer(env, chat, await nouvelEpisode(env));
    }
    return envoyer(env, chat, AIDE);
  }

  await telegram(env, "sendChatAction", { chat_id: chat, action: "typing" });
  const contenus = [];
  if (ecrit) contenus.push({ type: "text", text: `Message (écrit) : ${ecrit.slice(0, 1500)}` });
  const vocal = message.voice || message.audio;
  if (vocal?.file_id) {
    if ((vocal.duration || 0) > 300) {
      contenus.push({ type: "text", text: "Message vocal de plus de 5 minutes, non écouté." });
    } else {
      const audio = await fichierTelegram(env, vocal.file_id);
      if (audio) {
        contenus.push({ type: "text", text: "Message (vocal) :" });
        contenus.push({ type: "audio", data: base64(audio), mime_type: "audio/ogg" });
      } else {
        contenus.push({ type: "text", text: "Message vocal impossible à récupérer." });
      }
    }
  }
  if (!contenus.length) return;

  const base = await reglagesDeBase(env);
  const { prefs } = await lirePreferences(env);
  const episode = await dernierEpisode(env);
  let resultat;
  try {
    resultat = await demanderGemini(env, consigne(base), [
      { type: "text", text: contexte(base, prefs, episode) }, ...contenus], schema());
  } catch (erreur) {
    console.log("Gemini :", erreur.message);
    return envoyer(env, chat, "⏳ Gemini ne répond pas pour le moment. Réessaie dans une minute.");
  }

  const maintenant = heureLocale();
  await modifierPreferences(env, "Bot : réglages mis à jour", (frais) => {
    appliquer(frais, base, resultat, maintenant, episode);
    frais.historique = [...(frais.historique || []), {
      date: maintenant, message: ecrit || "(vocal)", reponse: String(resultat.reponse || "").slice(0, 400),
    }].slice(-20);
  });
  await envoyer(env, chat, `✅ ${String(resultat.reponse || "C'est noté.").slice(0, 800)}`);
  if (resultat.nouvel_episode === true) await envoyer(env, chat, await nouvelEpisode(env));
}

async function nouvelEpisode(env) {
  const aujourdHui = heureLocale().slice(0, 10);
  let refus = "";
  await modifierPreferences(env, "Bot : nouvel épisode demandé", (prefs) => {
    const compte = prefs.episodes_refaits || {};
    const nombre = compte.date === aujourdHui ? compte.nombre || 0 : 0;
    if (nombre >= MAX_EPISODES_REFAITS) {
      refus = `🚫 Déjà ${nombre} épisodes refaits aujourd'hui : c'est le maximum, pour ne pas épuiser le quota gratuit de la voix (10 par jour). Ça repart demain.`;
      return false;
    }
    prefs.episodes_refaits = { date: aujourdHui, nombre: nombre + 1 };
  });
  if (refus) return refus;
  const r = await github(env, `/actions/workflows/${WORKFLOW_EPISODE}/dispatches`, {
    method: "POST", body: JSON.stringify({ ref: "main" }),
  });
  return r.ok ? "🎙️ Je prépare un nouvel épisode : il arrive dans trois ou quatre minutes."
              : `GitHub refuse de lancer l'épisode (HTTP ${r.status}).`;
}

// ───────────────────────────── réglages ─────────────────────────────────────

function preferencesVides() {
  return { vitesse_parole: null, duree_minutes: null, ville_habituelle: null,
           sujets_preferes: [], sujets_a_eviter: [], consignes: [] };
}

async function reglagesDeBase(env) {
  const toml = await lireFichier(env, "reglages.toml");
  const valeur = (cle, defaut) => {
    const m = new RegExp(`^${cle}\\s*=\\s*(.+?)\\s*(#.*)?$`, "m").exec(toml?.texte || "");
    if (!m) return defaut;
    const brut = m[1].trim();
    if (brut.startsWith('"')) return brut.slice(1, brut.indexOf('"', 1));
    if (brut === "true" || brut === "false") return brut === "true";
    return Number(brut);
  };
  return {
    vitesse_parole: valeur("vitesse_parole", "normale"),
    duree_minutes: valeur("duree_minutes", 5),
    ville_habituelle: valeur("ville_habituelle", ""),
    tutoiement: valeur("tutoiement", true),
  };
}

async function lirePreferences(env) {
  const fichier = await lireFichier(env, FICHIER_PREFERENCES);
  if (fichier) return { prefs: normaliser(JSON.parse(fichier.texte)), sha: fichier.sha };
  // Première fois : on reprend les réglages déjà donnés au bot (memoire.json).
  const memoire = await lireFichier(env, "memoire.json");
  const ancien = memoire ? JSON.parse(memoire.texte) : {};
  return { prefs: normaliser({ preferences: ancien.preferences, a_approfondir: ancien.a_approfondir }), sha: null };
}

function normaliser(prefs) {
  return {
    preferences: { ...preferencesVides(), ...(prefs.preferences || {}) },
    a_approfondir: Array.isArray(prefs.a_approfondir) ? prefs.a_approfondir : [],
    episodes_refaits: prefs.episodes_refaits || {},
    historique: Array.isArray(prefs.historique) ? prefs.historique : [],
  };
}

// Lit, modifie et réécrit preferences.json ; recommence si le fichier a changé entre-temps.
async function modifierPreferences(env, messageCommit, modifier) {
  for (let essai = 0; essai < 3; essai++) {
    const { prefs, sha } = await lirePreferences(env);
    if (modifier(prefs) === false) return;
    const corps = { message: messageCommit, content: base64(new TextEncoder().encode(JSON.stringify(prefs, null, 2) + "\n")) };
    if (sha) corps.sha = sha;
    const r = await github(env, `/contents/${FICHIER_PREFERENCES}`, { method: "PUT", body: JSON.stringify(corps) });
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub refuse l'écriture (HTTP ${r.status}) : vérifie la permission Contents du jeton.`);
  }
  throw new Error("preferences.json : écriture impossible après trois essais.");
}

function effectifs(base, prefs) {
  const p = prefs.preferences;
  return {
    vitesse_parole: VITESSES.includes(p.vitesse_parole) ? p.vitesse_parole : base.vitesse_parole,
    duree_minutes: typeof p.duree_minutes === "number" ? p.duree_minutes : base.duree_minutes,
    ville_habituelle: p.ville_habituelle || base.ville_habituelle,
    sujets_preferes: p.sujets_preferes || [], sujets_a_eviter: p.sujets_a_eviter || [], consignes: p.consignes || [],
  };
}

function enAttente(prefs, episode) {
  const envoye = episode?.envoye_le || "";
  return (prefs.a_approfondir || []).filter((a) => a?.sujet && String(a.demande_le || "") > envoye);
}

function appliquer(prefs, base, r, maintenant, episode) {
  const p = prefs.preferences;
  if (VITESSES.includes(r.vitesse_parole)) p.vitesse_parole = r.vitesse_parole === base.vitesse_parole ? null : r.vitesse_parole;
  if (typeof r.duree_minutes === "number" && r.duree_minutes >= 2 && r.duree_minutes <= 12) {
    const duree = Math.round(r.duree_minutes * 10) / 10;
    p.duree_minutes = duree === Number(base.duree_minutes) ? null : duree;
  }
  let ville = String(r.ville_habituelle || "").trim();
  if (["inconnue", "(inconnue)", "aucune"].includes(ville.toLowerCase())) ville = "";
  p.ville_habituelle = ville && ville !== base.ville_habituelle ? ville : null;
  p.consignes = nettoyer(r.consignes);
  p.sujets_a_eviter = nettoyer(r.sujets_a_eviter);
  const exclus = new Set(p.sujets_a_eviter.map(cle));
  p.sujets_preferes = nettoyer(r.sujets_preferes).filter((s) => !exclus.has(cle(s)));
  const anciens = new Map(enAttente(prefs, episode).map((a) => [cle(a.sujet), a]));
  prefs.a_approfondir = nettoyer(r.a_approfondir, 5).map((s) => anciens.get(cle(s)) || { sujet: s, demande_le: maintenant });
}

function nettoyer(valeur, maximum = 15) {
  const vus = new Set();
  return (Array.isArray(valeur) ? valeur : [])
    .map((v) => String(v).replace(/\s+/g, " ").trim().replace(/^[ .;]+|[ .;]+$/g, "").slice(0, 80))
    .filter((v) => v && !vus.has(cle(v)) && vus.add(cle(v)))
    .slice(0, maximum);
}

function cle(texte) {
  return String(texte).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function resumeReglages(base, prefs) {
  const e = effectifs(base, prefs);
  const liste = (v, sep = ", ") => (v.length ? echapper(v.join(sep)) : "—");
  return ["🎛️ <b>Tes réglages actuels</b>",
    `• Vitesse de parole : ${echapper(e.vitesse_parole)}`,
    `• Durée : ${e.duree_minutes} min`,
    `• Ville habituelle : ${echapper(e.ville_habituelle) || "non précisée"}`,
    `• Sujets préférés : ${liste(e.sujets_preferes)}`,
    `• Sujets à éviter : ${liste(e.sujets_a_eviter)}`,
    `• Consignes : ${liste(e.consignes, " ; ")}`,
    `• À approfondir au prochain épisode : ${liste(enAttente(prefs, null).map((a) => a.sujet))}`,
  ].join("\n");
}

// ────────────────────────────── Gemini ──────────────────────────────────────

function consigne(base) {
  const adresse = base.tutoiement === false ? "en le vouvoyant" : "en le tutoyant";
  return `Tu gères les réglages d'un podcast matinal personnel, en français. L'auditeur t'écrit, ou t'envoie des messages vocaux, pour l'ajuster.
Mets à jour ses réglages d'après son message et prépare une réponse courte.

Champs :
- vitesse_parole : une valeur parmi ${VITESSES.join(", ")}. « Parle plus lentement » = un cran plus lent que la valeur actuelle.
- duree_minutes : durée souhaitée de l'épisode, en minutes (2 à 12).
- ville_habituelle : la ville où vit l'auditeur (vide si inconnue).
- sujets_preferes : thèmes à privilégier, en quelques mots chacun.
- sujets_a_eviter : thèmes qui ne l'intéressent pas. Quand il dit qu'un sujet ne l'intéresse pas, retiens le thème général. Un thème ne peut pas être à la fois préféré et à éviter.
- consignes : consignes durables sur le ton ou le contenu (ex. « plus d'humour », « pas de résultats sportifs »).
- a_approfondir : sujets à développer dans le PROCHAIN épisode seulement (ils seront ensuite oubliés).
- nouvel_episode : true seulement si l'auditeur demande explicitement un nouvel épisode maintenant (« refais le podcast », « envoie-moi un nouvel épisode », « régénère avec… »). Ses autres demandes du même message s'appliquent alors à cet épisode. Sinon false.

Recopie à l'identique tout ce que l'auditeur ne demande pas de changer.
Pour comprendre « ce sujet » ou « le deuxième sujet », appuie-toi sur la liste des sujets du dernier épisode.
Si le message ne demande aucun changement (remerciement, question…), ne change rien et réponds simplement.

Limites :
- Le podcast ne dispose que de l'agenda de l'auditeur, de flux d'actualités et de recherches Google Actualités. S'il demande une information que le podcast ne peut pas obtenir (météo, cours de bourse, e-mails…), dis-le simplement, sans l'ajouter aux consignes.
- L'heure d'envoi, les voix, les prénoms des animateurs et la liste des flux ne se changent pas ici : ne change rien et explique que ça se règle dans les fichiers du dépôt GitHub, ou en le demandant à Claude.

reponse : une à trois phrases en français, ${adresse}, qui disent précisément ce qui change à partir du prochain épisode. Si un message vocal est inaudible ou incompréhensible, dis-le.`;
}

function contexte(base, prefs, episode) {
  const e = effectifs(base, prefs);
  const liste = (v) => v.join("; ") || "(aucun)";
  const sujets = episode?.sujets || [];
  const dernier = episode?.date
    ? `${episode.date} — « ${episode.titre || ""} » — sujets : ${sujets.map((s, i) => `${i + 1}. ${s}`).join("; ") || "?"}`
    : "aucun pour l'instant";
  return `Date : ${heureLocale().slice(0, 10)}.

Réglages actuels :
- vitesse_parole : ${e.vitesse_parole}
- duree_minutes : ${e.duree_minutes}
- ville_habituelle : ${e.ville_habituelle || "(inconnue)"}
- sujets_preferes : ${liste(e.sujets_preferes)}
- sujets_a_eviter : ${liste(e.sujets_a_eviter)}
- consignes : ${liste(e.consignes)}
- a_approfondir : ${liste(enAttente(prefs, episode).map((a) => a.sujet))}

Dernier épisode : ${dernier}

Message de l'auditeur :`;
}

function schema() {
  const liste = { type: "array", items: { type: "string" }, maxItems: 15 };
  return {
    type: "object",
    properties: {
      vitesse_parole: { type: "string", enum: VITESSES },
      duree_minutes: { type: "number" },
      ville_habituelle: { type: "string" },
      sujets_preferes: liste, sujets_a_eviter: liste, consignes: liste,
      a_approfondir: { type: "array", items: { type: "string" }, maxItems: 5 },
      nouvel_episode: { type: "boolean" },
      reponse: { type: "string" },
    },
    required: ["vitesse_parole", "duree_minutes", "ville_habituelle", "sujets_preferes", "sujets_a_eviter",
               "consignes", "a_approfondir", "nouvel_episode", "reponse"],
  };
}

async function demanderGemini(env, systeme, contenus, schemaJson) {
  const variantes = [
    { response_format: { type: "text", mime_type: "application/json", schema: schemaJson }, input: contenus },
    { response_format: { type: "text", mime_type: "application/json" },
      input: [...contenus, { type: "text", text: `Réponds uniquement par un objet JSON conforme à ce schéma : ${JSON.stringify(schemaJson)}` }] },
  ];
  let derniere = "aucun modèle";
  for (const variante of variantes) {
    for (const modele of MODELES) {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modele, system_instruction: systeme, store: false, ...variante }),
      });
      if (r.ok) {
        const donnees = await r.json();
        const texteSortie = (donnees.steps || []).filter((s) => s.type === "model_output")
          .flatMap((s) => s.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
        const debut = texteSortie.indexOf("{"), fin = texteSortie.lastIndexOf("}");
        if (debut >= 0 && fin > debut) return JSON.parse(texteSortie.slice(debut, fin + 1));
        derniere = `${modele} : réponse sans JSON`;
        continue;
      }
      derniere = `${modele} : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      if (r.status === 400) break;          // requête refusée : variante suivante
    }
  }
  throw new Error(derniere);
}

// ───────────────────────────── services ─────────────────────────────────────

async function telegram(env, methode, corps) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${methode}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
  });
  return r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
}

function envoyer(env, chat, message) {
  return telegram(env, "sendMessage", { chat_id: chat, text: message, parse_mode: "HTML",
                                        disable_web_page_preview: true });
}

async function fichierTelegram(env, identifiant) {
  const infos = await telegram(env, "getFile", { file_id: identifiant });
  if (!infos.ok) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${infos.result.file_path}`);
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

function github(env, chemin, options = {}) {
  return fetch(`https://api.github.com/repos/${env.DEPOT}${chemin}`, {
    ...options,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "podcast-matin-bot" },
  });
}

async function lireFichier(env, chemin) {
  const r = await github(env, `/contents/${chemin}?ref=main`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub refuse la lecture de ${chemin} (HTTP ${r.status})`);
  const donnees = await r.json();
  const octets = Uint8Array.from(atob(donnees.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return { texte: new TextDecoder().decode(octets), sha: donnees.sha };
}

async function dernierEpisode(env) {
  const memoire = await lireFichier(env, "memoire.json").catch(() => null);
  try { return memoire ? JSON.parse(memoire.texte).dernier_episode || {} : {}; } catch { return {}; }
}

async function secretWebhook(env) {
  const empreinte = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`podcast:${env.TELEGRAM_BOT_TOKEN}`));
  return [...new Uint8Array(empreinte)].map((o) => o.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

function base64(octets) {
  let binaire = "";
  for (let i = 0; i < octets.length; i += 0x8000) binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(binaire);
}

function heureLocale() {
  const parties = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parties.year}-${parties.month}-${parties.day}T${parties.hour}:${parties.minute}`;
}

function echapper(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function texte(contenu) {
  return new Response(contenu, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
