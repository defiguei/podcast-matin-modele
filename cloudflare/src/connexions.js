// Connexions saisies dans l'application : clés (Gemini, Tavily, SNCF) et liens
// d'agenda. Le bot les teste, les garde (stockage privé du Durable Object) et
// les donne à GitHub au début de chaque lancement (/api/config, protégé par le
// secret partagé). Les secrets GitHub restent la solution de secours.

export const CLES = {
  gemini: { nom: "Gemini", variable: "GEMINI_API_KEY", obligatoire: true, lien: "https://aistudio.google.com/apikey",
            role: "Écrit les épisodes et fait les voix." },
  tavily: { nom: "Tavily", variable: "TAVILY_API_KEY", lien: "https://app.tavily.com",
            role: "Recherche sur internet pour les sorties et les rubriques (1 000 recherches gratuites par mois)." },
  sncf: { nom: "SNCF", variable: "SNCF_API_KEY", lien: "https://numerique.sncf.com/startup/api/",
          role: "Retards des trains en France (la Suisse et la Belgique n'en ont pas besoin)." },
};

const delai = (ms) => AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;

// Modèles Gemini dont le podcast se sert (podcast.py : modeles_texte et modeles_voix ; un
// test vérifie qu'ils correspondent). Le test de la clé dit s'ils sont disponibles.
export const MODELES_PODCAST = {
  texte: ["gemini-3.8-flash", "gemini-3.6-flash"],
  voix: ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"],
};

const MOIS_LONGS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const nombre = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");

// Teste une clé et, autant que possible, dit quelque chose d'utile : modèles disponibles
// (Gemini), recherches restantes (Tavily, sans en consommer), données chargées (SNCF).
// Renvoie { ok, message }. Sert aussi à tester-cles.mjs (clés rangées dans GitHub).
export async function testerCle(env, nom, cle) {
  try {
    if (nom === "gemini") {
      const r = await fetch(`${env.GEMINI_API || "https://generativelanguage.googleapis.com"}/v1beta/models?pageSize=1000`,
        { headers: { "x-goog-api-key": cle }, signal: delai(15000) });
      if (!r.ok) {
        return { ok: false, message: r.status === 429 ? "Quota du jour épuisé : la clé est bonne, réessaie demain." : "Google refuse cette clé : recopie-la depuis AI Studio." };
      }
      const noms = ((await r.json().catch(() => ({}))).models || []).map((m) => String(m.name || "").replace(/^models\//, "")).filter(Boolean);
      const gemini = noms.filter((n) => n.startsWith("gemini-"));
      if (!gemini.length) return { ok: true, message: "Clé valide (Google ne détaille pas les modèles)." };
      const etat = (liste) => liste.map((m) => `${m} ${noms.includes(m) ? "✓" : "✗"}`).join(", ");
      const manque = [...MODELES_PODCAST.texte, ...MODELES_PODCAST.voix].some((m) => !noms.includes(m));
      return { ok: true, message: `Clé valide · ${gemini.length} modèles Gemini disponibles. Ceux du podcast : ${etat(MODELES_PODCAST.texte)} ; voix : ${etat(MODELES_PODCAST.voix)}.`
        + (manque ? " Un modèle manquant est remplacé par le suivant de la liste." : "") };
    }
    if (nom === "tavily") {
      const r = await fetch(`${env.TAVILY_API || "https://api.tavily.com"}/usage`, {
        headers: { Authorization: `Bearer ${cle}` }, signal: delai(15000) });
      if (r.status === 401 || r.status === 403) return { ok: false, message: "Tavily refuse cette clé : recopie-la depuis app.tavily.com." };
      if (!r.ok) return { ok: false, message: `Tavily ne répond pas comme prévu (erreur ${r.status}).` };
      const u = await r.json().catch(() => ({}));
      const compte = u.account || {}, cleU = u.key || {};
      const utilise = Number.isFinite(compte.plan_usage) ? compte.plan_usage : cleU.usage;
      const limite = Number.isFinite(compte.plan_limit) ? compte.plan_limit : cleU.limit;
      const plan = compte.current_plan ? ` (offre ${compte.current_plan})` : "";
      if (Number.isFinite(utilise) && Number.isFinite(limite) && limite > 0) {
        return { ok: true, message: `Clé valide · encore ${nombre(Math.max(0, limite - utilise))} crédits sur ${nombre(limite)} ce mois${plan}. Une recherche en coûte 1.` };
      }
      return { ok: true, message: `Clé valide${Number.isFinite(utilise) ? ` · ${nombre(utilise)} crédits utilisés ce mois` : ""}${plan}.` };
    }
    if (nom === "sncf") {
      const r = await fetch(`${env.SNCF_API || "https://api.sncf.com"}/v1/coverage/sncf`, { headers: { Authorization: cle }, signal: delai(15000) });
      if (r.status === 401 || r.status === 403) return { ok: false, message: "La SNCF refuse cette clé." };
      if (!r.ok) return { ok: false, message: `L'API SNCF ne répond pas comme prévu (erreur ${r.status}).` };
      const region = ((await r.json().catch(() => ({}))).regions || [])[0] || {};
      const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(region.end_production_date || ""));
      return { ok: true, message: `Clé valide${m ? ` · horaires SNCF disponibles jusqu'au ${Number(m[3])} ${MOIS_LONGS[Number(m[2]) - 1]} ${m[1]}` : ""}${region.status && region.status !== "running" ? ` (service : ${region.status})` : ""}.` };
    }
  } catch (erreur) {
    return { ok: false, message: `Test impossible pour l'instant (${erreur.message}). Réessaie dans un moment.` };
  }
  return { ok: false, message: "Clé inconnue." };
}

// Même identifiant que podcast.py (identifiant_agenda) : les cases à cocher suivent.
export async function identifiantAgenda(url) {
  const octets = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`agenda:${url.trim()}`));
  return [...new Uint8Array(octets)].map((o) => o.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

// Lit un lien d'agenda (iCal) : { ok, nom, nb, message }.
export async function lireAgenda(url) {
  const adresse = url.trim().replace(/^webcal:\/\//i, "https://");
  if (!/^https?:\/\/\S+$/i.test(adresse)) return { ok: false, message: "Ce n'est pas une adresse : colle le lien iCal ou ICS de ton agenda." };
  try {
    const r = await fetch(adresse, { headers: { Accept: "text/calendar, */*" }, signal: delai(20000), redirect: "follow" });
    if (!r.ok) return { ok: false, message: `L'agenda ne s'ouvre pas (erreur ${r.status}) : vérifie que c'est bien l'adresse secrète iCal.` };
    const texte = await r.text();
    if (!texte.includes("BEGIN:VCALENDAR")) return { ok: false, message: "Cette adresse n'est pas un agenda iCal : prends l'« adresse secrète au format iCal »." };
    const nom = (/^X-WR-CALNAME:(.+)$/m.exec(texte)?.[1] || "").replace(/\\,/g, ",").trim().slice(0, 60) || "Agenda";
    const nb = (texte.match(/BEGIN:VEVENT/g) || []).length;
    return { ok: true, nom, nb, message: `Agenda « ${nom} » lu : ${nb} événement${nb > 1 ? "s" : ""}.` };
  } catch (erreur) {
    return { ok: false, message: `L'agenda ne répond pas (${erreur.message}).` };
  }
}

// État des connexions pour l'application (jamais les valeurs, seulement leur fin).
export function resumeConnexions(cles = {}, etat = {}, maintenant = Date.now()) {
  const github = new Set(etat.secrets_github || []);
  const connu = Array.isArray(etat.secrets_github);
  const etatCle = (nom) => {
    const def = CLES[nom];
    if (cles[nom]) return { source: "app", fin: String(cles[nom]).slice(-4), teste: cles[`${nom}_teste`] || null };
    if (github.has(def.variable)) return { source: "github" };
    return { source: connu ? "absente" : "inconnue" };
  };
  // Dernier test : résultat, ou test en cours sur GitHub (oublié après 5 minutes sans réponse).
  const dernierTest = (nom) => {
    const t = (etat.tests_cles || {})[nom];
    if (!t) return null;
    // Un test réussi (encart vert) ne reste affiché qu'une journée ; un nouvel épisode l'efface aussi (etat.js).
    if (t.ok && !t.en_cours && !(maintenant - (t.quand_ms || 0) < 24 * 3600 * 1000)) return null;
    const enCours = Boolean(t.en_cours && maintenant - (t.lance_ms || 0) < 5 * 60 * 1000);
    const perdu = Boolean(t.en_cours && !enCours);
    return { ok: t.ok ?? null, message: perdu ? "GitHub n'a pas renvoyé de résultat : regarde l'exécution « Tester mes clés » dans l'onglet Actions." : t.message || "",
             quand: t.quand || null, ou: t.ou || null, en_cours: enCours, perdu };
  };
  return {
    cles: Object.fromEntries(Object.entries(CLES).map(([nom, def]) => [nom, { ...etatCle(nom), nom: def.nom, role: def.role, lien: def.lien, obligatoire: Boolean(def.obligatoire), test: dernierTest(nom) }])),
    agendas: (cles.agendas || []).map((a) => ({ id: a.id, nom: a.nom, nb: a.nb, ajoute_le: a.ajoute_le })),
    agendas_github: github.has("CALENDAR_ICS_URL"),
    secrets_vus: etat.secrets_vus || null,
  };
}

// ─────────────────────────── tests des outils ───────────────────────────────
// Réglages › Sources : chaque outil se teste (un service, un flux, un site). Le bot interroge
// lui-même le service, sans clé ni crédit ; les adresses se remplacent par l'environnement
// (faux services des tests).

const AGENT = { "User-Agent": "Mozilla/5.0 (podcast-matin)" };
const ilYa = (date, maintenant) => {
  const h = Math.max(0, Math.round((maintenant - date) / 3600000));
  return h < 1 ? "il y a moins d'une heure" : h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} jours`;
};

// Un flux RSS ou Atom : combien d'articles, et de quand date le plus récent.
export async function testerFlux(url, maintenant = Date.now()) {
  try {
    const r = await fetch(url, { headers: { ...AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, redirect: "follow", signal: delai(15000) });
    if (!r.ok) return { ok: false, message: `Le flux ne s'ouvre pas (erreur ${r.status}).` };
    const texte = (await r.text()).slice(0, 600000);
    if (!/<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(texte)) return { ok: false, message: "Cette adresse ne donne plus un flux RSS : le site a peut-être changé son adresse." };
    const nb = (texte.match(/<item[\s>]|<entry[\s>]/gi) || []).length;
    const dates = [...texte.matchAll(/<(?:pubDate|updated|published|dc:date)>([^<]+)</gi)].map((m) => Date.parse(m[1].trim())).filter(Number.isFinite);
    const recent = dates.length ? Math.max(...dates) : null;
    if (!nb) return { ok: false, message: "Le flux répond, mais il est vide." };
    const vieux = recent && maintenant - recent > 14 * 24 * 3600000;
    return { ok: !vieux, message: `${nb} article${nb > 1 ? "s" : ""}${recent ? `, le plus récent ${ilYa(recent, maintenant)}` : ""}.${vieux ? " Plus rien de neuf depuis deux semaines : le flux est peut-être abandonné." : ""}` };
  } catch (erreur) {
    return { ok: false, message: `Le flux ne répond pas (${erreur.message}).` };
  }
}

// Un site de référence : répond-il, et sous quel titre ?
export async function testerSite(domaine, base = "") {
  try {
    const r = await fetch(base ? `${base}/${domaine}/` : `https://${domaine}/`, { headers: { ...AGENT, Accept: "text/html" }, redirect: "follow", signal: delai(15000) });
    if (!r.ok) return { ok: false, message: `Le site ne s'ouvre pas (erreur ${r.status}).` };
    const titre = (/<title[^>]*>([^<]{1,120})</i.exec((await r.text()).slice(0, 200000))?.[1] || "").replace(/\s+/g, " ").trim();
    return { ok: true, message: `Le site répond${titre ? ` : « ${titre} »` : ""}.`, titre };
  } catch (erreur) {
    return { ok: false, message: `Le site ne répond pas (${erreur.message}).` };
  }
}

// Adresse d'un site (« labo.ch », « https://www.labo.ch/actus ») ramenée à son domaine.
export function domaineDe(valeur) {
  const t = String(valeur || "").trim().toLowerCase();
  try {
    return new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, "");
  } catch { return ""; }
}

async function json(url, entetes = {}) {
  const r = await fetch(url, { headers: { ...AGENT, Accept: "application/json", ...entetes }, signal: delai(15000) });
  if (!r.ok) throw new Error(`erreur ${r.status}`);
  return r.json();
}

// Un service sans clé (Google Actualités, météo, trains, lieux, guides) : une petite question,
// la réponse dit s'il marche, pour ta ville quand elle est connue.
export async function testerService(env, cle, { ville = "", profil = {}, pays = "CH" } = {}) {
  const lieu = ville || profil.exemple_ville || "Lausanne";
  try {
    if (cle === "actus") {
      const url = `${env.ACTUS_API || "https://news.google.com"}/rss/search?q=${encodeURIComponent(`${lieu} when:1d`)}&hl=${profil.actus_langue || "fr"}&gl=${profil.actus_pays || "CH"}&ceid=${profil.actus_pays || "CH"}:${profil.actus_langue || "fr"}`;
      const r = await fetch(url, { headers: AGENT, signal: delai(15000) });
      if (!r.ok) return { ok: false, message: `Google Actualités ne répond pas (erreur ${r.status}).` };
      const nb = ((await r.text()).match(/<item[\s>]/gi) || []).length;
      return { ok: true, message: `Google Actualités répond : ${nb} article${nb > 1 ? "s" : ""} de moins d'un jour sur « ${lieu} ».` };
    }
    if (cle === "meteo") {
      const g = await json(`${env.GEOCODAGE_API || "https://geocoding-api.open-meteo.com"}/v1/search?name=${encodeURIComponent(lieu)}&count=1&language=fr`);
      const endroit = (g.results || [])[0];
      if (!endroit) return { ok: false, message: `Open-Meteo répond, mais ne trouve pas « ${lieu} » : vérifie ta ville dans Réglages › Moi.` };
      const m = await json(`${env.METEO_API || "https://api.open-meteo.com"}/v1/forecast?latitude=${endroit.latitude}&longitude=${endroit.longitude}&current=temperature_2m`);
      const t = m.current?.temperature_2m;
      return { ok: true, message: `Open-Meteo répond${Number.isFinite(t) ? ` : ${String(Math.round(t * 10) / 10).replace(".", ",")} °C en ce moment` : ""} à ${endroit.name}.` };
    }
    if (cle === "transports") {
      if (pays === "BE") {
        const b = await json(`${env.IRAIL_API || "https://api.irail.be"}/stations/?format=json&lang=fr`);
        const nb = (b.station || []).length;
        return { ok: nb > 0, message: nb ? `iRail répond : ${nb} gares belges.` : "iRail répond, mais sans gares." };
      }
      if (pays === "FR") return { ok: true, message: "En France, les trains passent par l'API SNCF : teste sa clé ci-dessus." };
      const c = await json(`${env.TRANSPORT_API || "https://transport.opendata.ch"}/v1/locations?query=${encodeURIComponent(lieu)}&type=station`);
      const gare = (c.stations || []).find((s) => s.name)?.name;
      return { ok: Boolean(gare), message: gare ? `CFF (transport.opendata.ch) répond : gare « ${gare} » trouvée.` : `Le service répond, mais ne trouve pas de gare pour « ${lieu} ».` };
    }
    if (cle === "lieux") {
      const w = await json(`${env.WIKI_API || "https://fr.wikipedia.org"}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(lieu)}&srlimit=1&format=json`);
      const titre = w.query?.search?.[0]?.title;
      return { ok: true, message: titre ? `Wikipédia répond : « ${titre} ». OpenStreetMap n'est interrogé qu'au moment d'une recherche.` : "Wikipédia répond." };
    }
    if (cle === "wikivoyage") {
      const w = await json(`${env.WIKIVOYAGE_API || "https://fr.wikivoyage.org"}/w/api.php?action=query&titles=${encodeURIComponent(lieu)}&redirects=1&format=json`);
      const page = Object.values(w.query?.pages || {})[0];
      return { ok: true, message: page && !("missing" in page) ? `Wikivoyage répond : il a une page sur ${page.title}.` : `Wikivoyage répond, mais n'a pas de page sur ${lieu}.` };
    }
  } catch (erreur) {
    return { ok: false, message: `Le service ne répond pas (${erreur.message}). Réessaie dans un moment.` };
  }
  return { ok: false, message: "Ce service ne se teste pas ici." };
}
