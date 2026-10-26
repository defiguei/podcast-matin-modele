// Faux services pour tester le bot en local : Gemini, GitHub, Tavily, SNCF,
// jours fériés, Web Push, et un petit site avec flux RSS. Tout est enregistré et pilotable
// par /control/*.
import http from "node:http";

const PORT = Number(process.env.PORT || 8790);
let appels = [];
let fileGemini = [];
let fichiers = {};
let geminiEnPanne = false;
let pushs = [];            // notifications reçues par le faux service (Web Push)
let statutsPush = {};      // abonnement → statut renvoyé (410 : disparu)

function reinitialiser() {
  appels = [];
  pushs = [];
  statutsPush = {};
  fileGemini = [];
  geminiEnPanne = false;
  fichiers = {
    "reglages.toml": `duree_minutes = 3\nnombre_sujets = 3\nvitesse_parole = "normale"\nville_habituelle = ""\n[[animateurs]]\nnom = "Léa"\nvoix = "Aoede"\n\n[[animateurs]]\nnom = "Hugo"\nvoix = "Puck"\n`,
    ".github/workflows/podcast-du-matin.yml": `env:\n  HEURE_LOCALE: "07:30"\n`,
    "preferences.json": JSON.stringify({ preferences: { vitesse_parole: "rapide", duree_minutes: 5, ville_habituelle: "Yverdon", sujets_preferes: [], sujets_a_eviter: [], consignes: ["toujours un bref point sur l'actualité locale d'Yverdon, le reste plus libre"] }, a_approfondir: [], episodes_refaits: {}, historique: [] }),
  };
}
reinitialiser();

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>La Région</title><item><title>Un article</title><link>http://exemple/1</link></item></channel></rss>`;

function lireCorps(req) {
  return new Promise((ok) => {
    const morceaux = [];
    req.on("data", (m) => morceaux.push(m));
    req.on("end", () => ok(Buffer.concat(morceaux).toString("utf8")));
  });
}

function json(res, statut, objet) {
  res.writeHead(statut, { "Content-Type": "application/json" });
  res.end(JSON.stringify(objet));
}

const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // Faux service de notifications : le corps chiffré est gardé tel quel (octets).
  const push = /^\/push\/([\w-]+)$/.exec(url.pathname);
  if (push && req.method === "POST") {
    const morceaux = [];
    for await (const m of req) morceaux.push(m);
    const statut = statutsPush[push[1]] || 201;
    pushs.push({ id: push[1], statut, autorisation: req.headers.authorization || "", encodage: req.headers["content-encoding"] || "",
                 ttl: req.headers.ttl || "", corps: Buffer.concat(morceaux).toString("base64") });
    res.writeHead(statut);
    return res.end();
  }
  const brut = await lireCorps(req);
  let corps = null;
  try { corps = brut ? JSON.parse(brut) : null; } catch { corps = brut; }
  const p = url.pathname;

  // ── pilotage ──
  if (p === "/control/reset") { reinitialiser(); return json(res, 200, { ok: true }); }
  if (p === "/control/appels") return json(res, 200, appels);
  if (p === "/control/vider") { appels = []; pushs = []; return json(res, 200, { ok: true }); }
  if (p === "/control/pushs") return json(res, 200, pushs);
  if (p === "/control/push-statut") { statutsPush[corps.id] = corps.statut; return json(res, 200, { ok: true }); }
  if (p === "/control/gemini") { fileGemini.push(...(Array.isArray(corps) ? corps : [corps])); return json(res, 200, { file: fileGemini.length }); }
  if (p === "/control/gemini-panne") { geminiEnPanne = Boolean(corps?.panne); return json(res, 200, { ok: true }); }
  if (p === "/control/fichiers") return json(res, 200, fichiers);
  if (p === "/control/fichier") { fichiers[corps.chemin] = corps.texte; return json(res, 200, { ok: true }); }

  // ── Nager.Date (jours fériés) ──
  let m = /^\/nager\/api\/v3\/PublicHolidays\/(\d{4})\/([A-Z]{2})$/.exec(p);
  if (m) {
    appels.push({ service: "nager", annee: m[1], pays: m[2] });
    return json(res, 200, [
      { date: `${m[1]}-11-11`, localName: "Armistice", name: "Armistice Day", global: true, counties: null },
      { date: `${m[1]}-03-01`, localName: "Fête cantonale", name: "Cantonal", global: false, counties: ["CH-NE"] },
    ]);
  }

  // ── tests des clés (écran Connexions) et agenda iCal ──
  if (p === "/gemini/v1beta/models") {
    appels.push({ service: "gemini", methode: "modeles" });
    return json(res, req.headers["x-goog-api-key"] === "bonne-cle" ? 200 : 400, { models: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite",
      "gemini-3.8-flash-tts", "text-embedding-005"].map((n) => ({ name: `models/${n}` })) });
  }
  if (p === "/tavily/usage") {
    appels.push({ service: "tavily", methode: "usage" });
    return json(res, req.headers.authorization === "Bearer tvly-bonne" ? 200 : 401,
      { key: { usage: 188, limit: null }, account: { current_plan: "Researcher", plan_usage: 188, plan_limit: 1000 } });
  }
  if (p === "/tavily/search") {
    appels.push({ service: "tavily" });
    return json(res, req.headers.authorization === "Bearer tvly-bonne" ? 200 : 401, { results: [] });
  }
  if (p === "/brut/auteur/modele/main/version.json") {
    appels.push({ service: "modele" });
    return json(res, 200, { version: "2099-01-01.1", titre: "Plus tard", nouveautes: ["Une nouveauté", "Une autre"] });
  }
  if (p === "/sncf/v1/coverage/sncf") return json(res, req.headers.authorization === "sncf-bonne" ? 200 : 401,
    { regions: [{ id: "sncf", status: "running", end_production_date: "20261215T000000" }] });
  if (p === "/ics/perso.ics") {
    res.writeHead(200, { "Content-Type": "text/calendar" });
    return res.end("BEGIN:VCALENDAR\r\nX-WR-CALNAME:Famille\r\nBEGIN:VEVENT\r\nSUMMARY:Piscine\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Match\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
  }
  if (p === "/ics/pas-un-agenda") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>connexion</html>"); }

  // ── Gemini ──
  if (p === "/gemini/v1beta/interactions") {
    appels.push({ service: "gemini", corps });
    if (geminiEnPanne || !fileGemini.length) return json(res, 503, { error: { message: "surcharge simulée" } });
    const reponse = fileGemini.shift();
    return json(res, 200, { steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(reponse) }] }] });
  }

  // ── GitHub ── (tout dépôt : chez chacun, la mise à jour remplace le nom du dépôt modèle)
  m = /^\/gh\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(p);
  if (m) {
    const chemin = decodeURIComponent(m[1]);
    if (req.method === "GET") {
      appels.push({ service: "github", methode: "lire", chemin });
      if (!(chemin in fichiers)) return json(res, 404, { message: "Not Found" });
      return json(res, 200, { content: Buffer.from(fichiers[chemin]).toString("base64"), sha: `sha-${fichiers[chemin].length}` });
    }
    if (req.method === "PUT") {
      appels.push({ service: "github", methode: "ecrire", chemin, message: corps.message });
      fichiers[chemin] = Buffer.from(corps.content, "base64").toString("utf8");
      return json(res, 200, { content: { sha: "nouveau" } });
    }
  }
  m = /^\/gh\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p);
  if (m) {
    appels.push({ service: "github", methode: "lancer", workflow: m[1], entrees: corps.inputs, ref: corps.ref });
    res.writeHead(204);
    return res.end();
  }

  // ── petit site avec flux RSS ──
  if (p === "/site/page.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<html><head><link rel="alternate" type="application/rss+xml" href="/rss/flux.xml"></head><body>Accueil</body></html>`);
  }
  if (p === "/rss/flux.xml") {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    return res.end(RSS);
  }
  json(res, 404, { erreur: `inconnu : ${req.method} ${p}` });
});

serveur.listen(PORT, "127.0.0.1", () => console.log(`Faux services sur ${PORT}`));
