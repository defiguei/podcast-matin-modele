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

// Teste une clé ; renvoie { ok, message }.
export async function testerCle(env, nom, cle) {
  try {
    if (nom === "gemini") {
      const r = await fetch(`${env.GEMINI_API || "https://generativelanguage.googleapis.com"}/v1beta/models?pageSize=1`,
        { headers: { "x-goog-api-key": cle }, signal: delai(15000) });
      if (r.ok) return { ok: true, message: "Google accepte la clé." };
      return { ok: false, message: r.status === 429 ? "Quota du jour épuisé : la clé est bonne, réessaie demain." : "Google refuse cette clé : recopie-la depuis AI Studio." };
    }
    if (nom === "tavily") {
      const r = await fetch(`${env.TAVILY_API || "https://api.tavily.com"}/search`, {
        method: "POST", headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "météo", max_results: 1 }), signal: delai(15000) });
      if (r.ok) return { ok: true, message: "Tavily accepte la clé (une recherche utilisée pour le test)." };
      return { ok: false, message: r.status === 401 || r.status === 403 ? "Tavily refuse cette clé : recopie-la depuis app.tavily.com." : `Tavily ne répond pas comme prévu (erreur ${r.status}).` };
    }
    if (nom === "sncf") {
      const r = await fetch(`${env.SNCF_API || "https://api.sncf.com"}/v1/coverage/sncf`, { headers: { Authorization: cle }, signal: delai(15000) });
      if (r.ok) return { ok: true, message: "La SNCF accepte la clé." };
      return { ok: false, message: r.status === 401 || r.status === 403 ? "La SNCF refuse cette clé." : `L'API SNCF ne répond pas comme prévu (erreur ${r.status}).` };
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
export function resumeConnexions(cles = {}, etat = {}) {
  const github = new Set(etat.secrets_github || []);
  const connu = Array.isArray(etat.secrets_github);
  const etatCle = (nom) => {
    const def = CLES[nom];
    if (cles[nom]) return { source: "app", fin: String(cles[nom]).slice(-4), teste: cles[`${nom}_teste`] || null };
    if (github.has(def.variable)) return { source: "github" };
    return { source: connu ? "absente" : "inconnue" };
  };
  return {
    cles: Object.fromEntries(Object.entries(CLES).map(([nom, def]) => [nom, { ...etatCle(nom), nom: def.nom, role: def.role, lien: def.lien, obligatoire: Boolean(def.obligatoire) }])),
    agendas: (cles.agendas || []).map((a) => ({ id: a.id, nom: a.nom, nb: a.nb, ajoute_le: a.ajoute_le })),
    agendas_github: github.has("CALENDAR_ICS_URL"),
    secrets_vus: etat.secrets_vus || null,
  };
}
