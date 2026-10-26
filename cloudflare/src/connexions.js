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
