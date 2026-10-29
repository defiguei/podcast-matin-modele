// Tests de bout en bout du bot (wrangler dev + faux services).
import { createHash, createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { MODELES_PODCAST } from "../src/connexions.js";
import { RUBRIQUES_A_CHERCHER, TONS, DESCRIPTIONS_TONS, RUBRIQUES, completerConfig } from "../src/config.js";

const BOT = "http://127.0.0.1:8799";
const FAUX = "http://127.0.0.1:8790";
// Secret partagé avec GitHub : dérivé du jeton GitHub du bot (« gh-test » en local).
const SECRET = createHash("sha256").update("podcast:gh-test").digest("hex").slice(0, 48);
const entetesApi = { "X-Podcast-Secret": SECRET };
let reussis = 0, rates = 0;
const echecs = [];

function verifier(condition, libelle, detail) {
  if (condition) { reussis++; return; }
  rates++;
  echecs.push(libelle);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Test raté::${libelle} — ${String(typeof detail === "string" ? detail : JSON.stringify(detail) ?? "").slice(0, 700).replace(/\n/g, "%0A")}`);
  console.log(`  ✗ ${libelle}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`);
}

const attente = (ms) => new Promise((ok) => setTimeout(ok, ms));
const obtenir = async (url, options) => { const r = await fetch(url, options); return { statut: r.status, texte: await r.text() }; };
const envoyerJson = (url, corps, entetes = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...entetes }, body: JSON.stringify(corps) });

async function appels() { return (await fetch(`${FAUX}/control/appels`)).json(); }
async function vider() { await fetch(`${FAUX}/control/vider`, { method: "POST" }); }
async function gemini(...reponses) { await envoyerJson(`${FAUX}/control/gemini`, reponses); }
async function etat() { return (await fetch(`${BOT}/test/etat`)).json(); }
async function horloge(iso, tic = false) { return (await fetch(`${BOT}/test/horloge?iso=${iso}${tic ? "&tic=1" : ""}`)).json(); }

async function attendre(predicat, delai = process.env.GITHUB_ACTIONS ? 20000 : 8000) {
  const fin = Date.now() + delai;
  let liste = [];
  while (Date.now() < fin) {
    liste = await appels();
    if (predicat(liste)) return liste;
    await attente(120);
  }
  return liste;
}

const lancements = (liste) => liste.filter((a) => a.service === "github" && a.methode === "lancer");
const appelsTavilySearch = (liste) => liste.filter((a) => a.service === "tavily" && a.methode !== "usage").length;
const deposer = (nom, octets, entetes = entetesApi) => fetch(`${BOT}/api/fichier?nom=${encodeURIComponent(nom)}`, { method: "PUT", body: octets, headers: entetes });
const evenement = (corps) => envoyerJson(`${BOT}/api/evenement`, corps, entetesApi);

// L'application : chaque appel porte le jeton de l'appareil de test (connecté par code ;
// reconnecté d'office si un scénario l'a retiré).
let JETON = "";
async function connecterTest(nom = "Appareil de test") {
  const code = await (await fetch(`${BOT}/api/code-connexion`, { headers: entetesApi })).json();
  const r = await envoyerJson(`${BOT}/app/connexion`, { code: code.code, nom }).then((x) => x.json());
  JETON = r.jeton || "";
  return r;
}
async function app(action, extra = {}, options = {}) {
  const envoi = () => envoyerJson(`${BOT}/app/api`, { action, ...extra }, options.sans ? {} : { "X-Appareil": options.jeton ?? JETON });
  let r = await envoi();
  if (r.status === 401 && !options.sans && options.jeton === undefined) { await connecterTest(); r = await envoi(); }
  return { statut: r.status, ...(await r.json().catch(() => ({}))) };
}
// Le message montré dans l'application après une demande libre, en une seule chaîne.
const compris = (r) => { const m = r.message_compris || {}; return [m.titre, ...(m.lignes || []), ...(m.erreurs || []), m.note].filter(Boolean).join("\n"); };
const wav = Buffer.from("RIFF0000WAVEfmt faux").toString("base64");

async function scenario(nom, fonction) {
  console.log(`▶ ${nom}`);
  await vider();
  try { await fonction(); } catch (erreur) { verifier(false, `${nom} : exception`, erreur.stack); }
}

// ──────────────────────────────────────────────────────────────────────────

await fetch(`${FAUX}/control/reset`, { method: "POST" });
await envoyerJson(`${BOT}/test/etat`, { effacer: true });
await horloge("2026-10-13T10:00");

await scenario("Porte d'entrée", async () => {
  const accueil = await obtenir(`${BOT}/`);
  verifier(accueil.statut === 200 && accueil.texte.includes("version"), "page d'accueil", accueil);
  verifier((await envoyerJson(`${BOT}/telegram`, { update_id: 1 })).status === 404, "plus de porte pour une messagerie");
  verifier((await obtenir(`${BOT}/api/config`)).statut === 403, "API sans secret refusée");
  verifier((await obtenir(`${BOT}/api/config`, { headers: { "X-Podcast-Secret": "" } })).statut === 403, "secret vide : refusé");
  verifier((await obtenir(`${BOT}/desinstaller`)).statut === 404, "plus de désinstallation");
  verifier((await obtenir(`${BOT}/favicon.ico`)).statut === 404, "favicon sans effet");
  const page = await obtenir(`${BOT}/app`);
  verifier(page.statut === 200 && page.texte.includes("Podcast Matin") && !/telegram/i.test(page.texte), "la page de l'application est servie, sans messagerie", page.statut);
  verifier((await app("etat", {}, { sans: true })).statut === 401, "sans jeton d'appareil : refusé");
  verifier((await app("etat", {}, { jeton: "f".repeat(64) })).statut === 401, "jeton inconnu : refusé");
  verifier((await fetch(`${BOT}/app/api`)).status === 405, "GET sur l'API refusé");
});

await scenario("Installation, import des réglages, première connexion", async () => {
  const r = await obtenir(`${BOT}/installer`);
  verifier(r.texte.includes("activé"), "réponse d'installation", r.texte);
  const liste = await appels();
  verifier(liste.some((a) => a.methode === "ecrire" && a.chemin === "preferences.json"), "sauvegarde initiale");
  const { config, etat: e } = await etat();
  verifier(config.format.duree_minutes === 5 && config.voix.vitesse === "rapide" && config.actus.ville === "Yverdon", "import depuis preferences.json", config.format);
  verifier(config.consignes[0]?.includes("Yverdon") && config.planning.jours.lun === "07:30", "consignes et horaire importés");
  verifier(Boolean((await etat()).reveil) && Boolean(e.version_installee), "réveil programmé et version notée dès l'installation");
  // Première ouverture : GitHub demande un code (fin du déploiement), l'appareil se connecte avec.
  let code = await (await fetch(`${BOT}/api/code-connexion?si=premiere`, { headers: entetesApi })).json();
  verifier(/^\d{6}$/.test(code.code || "") && code.adresse === `${BOT}/app` && /^\d{2}:\d{2}$/.test(code.jusqua || ""), "premier code de connexion pour GitHub", code);
  verifier((await obtenir(`${BOT}/api/code-connexion`)).statut === 403, "code jamais donné sans le secret");
  const connexion = await envoyerJson(`${BOT}/app/connexion`, { code: code.code, nom: "Appareil de test" }).then((x) => x.json());
  verifier(connexion.ok && /^[0-9a-f]{64}$/.test(connexion.jeton), "le code ouvre l'application", connexion);
  JETON = connexion.jeton;
  const ouvert = await app("etat");
  verifier(ouvert.ok && ouvert.donnees.appareils.length === 1, "l'application s'ouvre avec le jeton", ouvert.donnees?.appareils);
  verifier(ouvert.donnees.reglages.voix.noms.Aoede === "Léa" && ouvert.donnees.reglages.voix.noms.Puck === "Hugo" && ouvert.donnees.reglages.voix.animateurs.map((a) => a.voix).join() === "Aoede,Puck",
    "animateurs de reglages.toml : leurs prénoms passent à leurs voix", ouvert.donnees.reglages.voix);
  code = await (await fetch(`${BOT}/api/code-connexion?si=premiere`, { headers: entetesApi })).json();
  verifier(code.code === null && code.raison === "deja_connecte", "fin de déploiement suivante : pas de nouveau code (déjà connecté)", code);
  code = await (await fetch(`${BOT}/api/code-connexion`, { headers: entetesApi })).json();
  verifier(/^\d{6}$/.test(code.code || ""), "workflow « Code de connexion » : un code pour un nouvel appareil");
  const deuxieme = await obtenir(`${BOT}/installer`);
  verifier(deuxieme.texte.includes("activé"), "réinstallation sans souci");
});

await scenario("Compréhension libre : horaire et réglages", async () => {
  await gemini({ operations: [
    { action: "horaire", jours: ["semaine"], heure: "06:45" },
    { action: "horaire", jours: ["sam"], heure: "09:00" },
    { action: "horaire", jours: ["dim"], heure: "aucun" },
    { action: "regler", chemin: "voix.vitesse", valeur: "lente" },
    { action: "ajouter_liste", chemin: "actus.sujets_a_eviter", valeur: "sport" },
    { action: "regler", chemin: "format.duree_minutes", valeur: "99" },
  ], reponse: "C'est fait : 6 h 45 en semaine, 9 h le samedi, rien le dimanche." });
  const r = await app("parler", { texte: "6h45 en semaine, 9h le samedi, rien le dimanche, plus lentement, et pas de sport. 99 minutes." });
  const { config } = await etat();
  verifier(config.planning.jours.mar === "06:45" && config.planning.jours.sam === "09:00" && config.planning.jours.dim === null, "horaires par jour", config.planning.jours);
  verifier(config.voix.vitesse === "lente" && config.actus.sujets_a_eviter.includes("sport"), "vitesse et thème évité");
  const texte = compris(r);
  verifier(r.ok && texte.includes("6 h 45") && r.erreurs.length >= 1 && r.changements.length >= 1, "réponse avec ce qui a été fait et l'erreur", texte);
  const appelGemini = (await appels()).find((a) => a.service === "gemini")?.corps;
  verifier(appelGemini?.model === "gemini-3.5-flash-lite" && appelGemini.response_format?.schema && appelGemini.store === false, "appel Gemini structuré", appelGemini?.model);
  verifier(!JSON.stringify(appelGemini).includes("gh-test"), "aucun secret envoyé à Gemini");
});

// Gemini (modèle léger) ne range pas toujours les champs où il faut : le bot ne doit
// jamais en tirer un défaut destructeur, et ce qu'il annonce doit être ce qu'il a fait.
await scenario("Compréhension : réponses maladroites de Gemini, confirmation, transcription", async () => {
  const sauvegarde = (await etat()).config;
  const jours = async () => (await etat()).config.planning.jours;
  // L'heure rangée dans « valeur » au lieu de « heure » (le cas du 6 h 30 du 21 oct. 2026).
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"], valeur: "06:30" }], reponse: "" });
  let r = await app("parler", { texte: "change l'horaire tout le temps à 6h30" });
  let texte = compris(r);
  verifier(Object.values(await jours()).every((h) => h === "06:30"), "heure reprise de « valeur »", await jours());
  verifier(texte.includes("C'est fait") && texte.includes("6 h 30") && !texte.includes("pas d'épisode"), "confirmation tirée de ce qui a été fait", texte);
  // Heure oubliée : rien ne change, et la phrase de Gemini (fausse) n'est pas montrée.
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"] }], reponse: "C'est fait, ton podcast est programmé à 07:00." });
  r = await app("parler", { texte: "tous les jours à 7h" });
  texte = compris(r);
  verifier(Object.values(await jours()).every((h) => h === "06:30"), "heure oubliée : planning intact", await jours());
  verifier(texte.includes("rien changé") && texte.includes("l'heure") && !texte.includes("07:00") && !r.changements.length, "heure oubliée : erreur claire, sans la phrase de Gemini", texte);
  // Couper tout le planning : à confirmer. Non → rien ne change.
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"], heure: "aucun" }], reponse: "" });
  r = await app("parler", { texte: "plus aucun épisode" });
  verifier(r.message_compris?.confirmer && compris(r).includes("À confirmer") && (await jours()).lun === "06:30", "planning coupé : rien d'appliqué avant confirmation", compris(r));
  r = await app("parler_abandonner");
  verifier(r.ok && r.abandon && (await jours()).lun === "06:30" && !(await etat()).etat.a_confirmer, "« Non » : rien ne change", r);
  r = await app("parler_confirmer");
  verifier(r.ok === false && r.erreur.includes("plus en attente") && (await jours()).lun === "06:30", "confirmation déjà traitée : sans effet", r.erreur);
  // Oui → appliqué, et annulable.
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"], heure: "aucun" }], reponse: "" });
  await app("parler", { texte: "plus aucun épisode" });
  r = await app("parler_confirmer");
  verifier(Object.values(await jours()).every((h) => h === null) && compris(r).includes("C'est fait"), "« Oui » : appliqué", compris(r));
  r = await app("annuler");
  verifier(r.ok && (await jours()).lun === "06:30", "annulé : l'horaire revient");
  // Vocal : ce que Gemini a entendu est renvoyé.
  await gemini({ entendu: "mets le podcast à six heures et quart", operations: [{ action: "horaire", jours: ["semaine"], heure: "06:15" }], reponse: "" });
  r = await app("parler", { audio: wav });
  verifier(r.ok && r.vocal && r.entendu === "mets le podcast à six heures et quart" && compris(r).includes("6 h 15"), "transcription renvoyée avec le changement", r);
  const trace = (await etat()).etat.historique.at(-1);
  verifier(trace.vocal && trace.message.includes("six heures") && trace.operations.includes("06:15"), "historique : entendu et opérations gardés", trace);
  // Une liste « réglée » d'un bloc : on ajoute, on ne remplace pas.
  await gemini({ operations: [{ action: "regler", chemin: "actus.sujets_a_eviter", valeur: "people" }], reponse: "" });
  await app("parler", { texte: "pas de people" });
  const evites = (await etat()).config.actus.sujets_a_eviter;
  verifier(evites.includes("sport") && evites.includes("people"), "liste complétée, pas écrasée", evites);
  // Rubrique demandée à la voix : modèle du catalogue, comme le « + » de l'application.
  await gemini({ operations: [{ action: "nouvelle_regle", regle: { modele: "meteo" } }], reponse: "" });
  r = await app("parler", { texte: "ajoute la météo le matin" });
  let config = (await etat()).config;
  const meteo = config.regles.find((r) => r.titre === "Météo");
  const cles = config.deroule.map((x) => x.cle);
  verifier(meteo && meteo.recherche.sources.join() === "meteo" && meteo.rubrique?.longueur === "phrase"
    && cles.indexOf(meteo.id) === cles.indexOf("ouverture") + 1, "rubrique du catalogue : sources, longueur et place du modèle", { meteo, cles });
  verifier(r.ouvrir?.ecran === "fiche" && r.ouvrir.id === meteo?.id, "la rubrique créée s'ouvre", r.ouvrir);
  // Modifier sans rien de compris : erreur, pas de « modifiée ».
  await gemini({ operations: [{ action: "modifier_regle", id: meteo.id, regle: {} }], reponse: "C'est modifié." });
  r = await app("parler", { texte: "change la météo" });
  verifier(compris(r).includes("quoi changer") && !compris(r).includes("C'est modifié"), "modification vide signalée", compris(r));
  // La déplacer et la raccourcir par la voix.
  await gemini({ operations: [{ action: "modifier_regle", id: meteo.id, regle: { place: "agenda", consigne: "La météo du jour en une phrase." } }], reponse: "" });
  await app("parler", { texte: "mets la météo après l'agenda" });
  config = (await etat()).config;
  const cles2 = config.deroule.map((x) => x.cle);
  verifier(cles2.indexOf(meteo.id) === cles2.indexOf("agenda") + 1 && config.regles.find((r) => r.id === meteo.id).consigne.includes("une phrase"), "rubrique déplacée et modifiée", cles2);
  // Supprimer : à confirmer.
  await gemini({ operations: [{ action: "supprimer_regle", id: meteo.id }], reponse: "" });
  r = await app("parler", { texte: "supprime la météo" });
  verifier(compris(r).includes("À confirmer") && (await etat()).config.regles.some((r) => r.id === meteo.id), "suppression à confirmer", compris(r));
  await app("parler_confirmer");
  verifier(!(await etat()).config.regles.some((r) => r.titre === "Météo"), "rubrique supprimée après confirmation");
  await envoyerJson(`${BOT}/test/etat`, { config: sauvegarde });
});

await scenario("Règle : saint du jour entre l'agenda et les news", async () => {
  await gemini({ operations: [{ action: "nouvelle_regle", regle: {
    titre: "Saint du jour", consigne: "Dire le saint du jour", periode_type: "toujours",
    rubrique_titre: "Saint du jour", rubrique_apres: "agenda", rubrique_longueur: "phrase", sources: ["saints"] } }], reponse: "Règle créée." });
  const r = await app("parler", { texte: "J'aimerais que tu me dises la Saint du jour chaque jour entre mon agenda et les news" });
  const { config } = await etat();
  const regle = config.regles.find((x) => x.titre === "Saint du jour");
  verifier(regle?.id === "R1" && regle.recherche?.sources?.includes("saints"), "règle R1 créée avec source saints", regle);
  const cles = config.deroule.map((x) => x.cle);
  verifier(cles.indexOf("R1") === cles.indexOf("agenda") + 1, "rubrique placée après l'agenda", cles);
  verifier(r.ouvrir?.id === "R1", "sa fiche s'ouvre dans l'application", r.ouvrir);
});

await scenario("Podcast ponctuel sur un sujet : ni épisode du jour, ni durée changée", async () => {
  const dureeAvant = (await etat()).config.format.duree_minutes;
  const refaitsAvant = (await etat()).etat.refaits || null;
  // Ce que Gemini renvoyait : la recherche, mais aussi un nouvel épisode et la durée de l'épisode quotidien.
  await gemini({ operations: [
    { action: "regler", chemin: "format.duree_minutes", valeur: "3" },
    { action: "nouvelle_regle", regle: { titre: "Retards CFF", consigne: "Fais le point sur les retards des CFF en ce moment", periode_type: "ponctuelle", rendu: "point", minutes: 3, sources: ["actus", "web"] } },
    { action: "nouvel_episode" },
    { action: "resultats", ids: ["R9"], format: "ecrit" },
  ], reponse: "" });
  await app("parler", { texte: "fais-moi un podcast de 3 minutes sur les retards CFF en ce moment" });
  const liste = await attendre((l) => lancements(l).length >= 1);
  const { config } = await etat();
  const regle = config.regles.find((r) => r.titre === "Retards CFF");
  verifier(regle?.periode.type === "ponctuelle" && regle.recherche.rendu === "point" && regle.recherche.minutes === 3, "point créé, 3 minutes", regle?.recherche);
  verifier(config.format.duree_minutes === dureeAvant, "durée de l'épisode quotidien inchangée", config.format);
  const lances = lancements(liste);
  verifier(lances.length === 1 && lances[0].workflow === "recherche.yml" && lances[0].entrees.format === "point" && lances[0].entrees.regles === regle?.id && lances[0].ref === "main",
    "seul le podcast du point est lancé (pas d'épisode du jour)", lances);
  // Relancé en « résultats écrits », un point reste un point.
  await vider();
  await app("recherche", { id: regle.id, format: "ecrit" });
  const relance = lancements(await appels())[0];
  verifier(relance?.entrees.format === "point", "un point se relance en point", relance);
  // Un « nouvel épisode » demandé pour une recherche ponctuelle devient sa recherche.
  await vider();
  await gemini({ operations: [{ action: "nouvel_episode", ids: [regle.id] }], reponse: "" });
  await app("parler", { texte: "refais ce podcast" });
  const encore = lancements(await appels());
  verifier(encore.length === 1 && encore[0].workflow === "recherche.yml" && encore[0].entrees.format === "point", "nouvel épisode d'une recherche → son point", encore);
  // Les points comptent sur le quota de la voix, comme les épisodes : on le rend aux scénarios suivants.
  const apres = (await etat()).etat;
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...apres, refaits: refaitsAvant } });
});

await scenario("API pour GitHub", async () => {
  const r = await fetch(`${BOT}/api/config`, { headers: entetesApi });
  const donnees = await r.json();
  verifier(donnees.format === "bot-v2" && donnees.config.regles.length >= 2 && donnees.aujourdhui === "2026-10-13", "configuration exportée", Object.keys(donnees));
  verifier(donnees.heure_prevue_aujourdhui === "06:45" && donnees.flux_defaut.length === 3, "heure du jour", donnees.heure_prevue_aujourdhui);
  verifier(!("livraison" in donnees.config), "plus de réglage de livraison", donnees.config.livraison);
  const ev = await evenement({ type: "episode", date: "2026-10-13", titre: "Mardi 13", sujets: ["Budget vaudois", "Grève CFF", "Météo"], ref: 64500, transcription: "Léa : Bonjour\nHugo : Salut", regles: ["R1"], mode: "planifie", debut: "2026-10-13T06:40" });
  verifier((await ev.json()).ok === true, "événement épisode accepté");
  const { etat: e, config } = await etat();
  verifier(e.episodes.at(-1)?.ref === 64500 && e.declenchements["2026-10-13"]?.envoye === true, "épisode enregistré", e.declenchements);
  verifier(config.regles.find((x) => x.id === "R1").derniere_application === "2026-10-13", "application de R1 notée");
  const refus = await envoyerJson(`${BOT}/api/evenement`, { type: "episode" });
  verifier(refus.status === 403, "événement sans secret refusé");
  const ancien = createHash("sha256").update("podcast:123:TEST").digest("hex").slice(0, 48);
  verifier((await obtenir(`${BOT}/api/config`, { headers: { "X-Podcast-Secret": ancien } })).statut === 403, "un autre secret n'ouvre rien");
});

await scenario("Épisodes à la demande et limite du jour", async () => {
  for (let i = 0; i < 6; i++) {
    await vider();
    const r = await app("generer");
    verifier(r.ok && lancements(await appels())[0]?.entrees?.mode === "manuel", `épisode à la demande ${i + 1}`, r);
  }
  await vider();
  const r = await app("generer");
  verifier(r.ok === false && !lancements(await appels()).length && r.erreur.includes("maximum"), "7e refusé", r.erreur);
});

await scenario("Planning automatique : lancement, rattrapage, réveil", async () => {
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, declenchements: {}, refaits: {} } });
  // Mercredi 14 : 6 h 45, préparation 5 min avant.
  let h = await horloge("2026-10-14T06:30", true);
  let liste = await appels();
  verifier(!lancements(liste).length, "rien à 6 h 30");
  verifier(h.reveil && Math.abs(h.reveil - (Date.now() + 10 * 60000)) < 120000, "réveil programmé à 6 h 40", h);
  await vider();
  h = await horloge("2026-10-14T06:40", true);
  liste = await appels();
  verifier(lancements(liste)[0]?.entrees?.mode === "planifie", "lancement à 6 h 40", lancements(liste));
  await vider();
  await horloge("2026-10-14T06:50", true);
  verifier(!lancements(await appels()).length, "pas de double lancement");
  await horloge("2026-10-14T07:46", true);
  liste = await appels();
  verifier(lancements(liste)[0]?.entrees?.mode === "rattrapage", "rattrapage une heure après", lancements(liste));
  await vider();
  await horloge("2026-10-14T08:00", true);
  verifier(!lancements(await appels()).length, "un seul rattrapage");
  // Jeudi 15 : épisode envoyé à temps → pas de rattrapage.
  await horloge("2026-10-15T06:40", true);
  await evenement({ type: "episode", date: "2026-10-15", titre: "Jeudi", sujets: [], ref: 64000, mode: "planifie" });
  await vider();
  await horloge("2026-10-15T07:50", true);
  verifier(!lancements(await appels()).length, "pas de rattrapage si l'épisode est arrivé");
  // Dimanche 18 : pas d'épisode.
  await vider();
  await horloge("2026-10-18T09:00", true);
  verifier(!lancements(await appels()).length, "dimanche sans épisode");
  // Exception : vendredi 16 à 5 h 30.
  await gemini({ operations: [{ action: "exception", date: "2026-10-16", heure: "05:30" }], reponse: "Vendredi à 5 h 30." });
  await horloge("2026-10-15T20:00");
  await app("parler", { texte: "vendredi exceptionnellement à 5h30" });
  await vider();
  await horloge("2026-10-16T05:25", true);
  verifier(lancements(await appels())[0]?.entrees?.mode === "planifie", "exception respectée (5 h 25)");
  await horloge("2026-10-13T10:00");
});

await scenario("Sauvegarde quotidienne", async () => {
  const avant = (await etat()).etat;
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...avant, sauvegarde: "2026-10-01" } });
  await app("regler", { chemin: "agenda.deplacements", valeur: !(await etat()).config.agenda.deplacements });
  await vider();
  await horloge("2026-10-19T03:05", true);
  const liste = await appels();
  const ecriture = liste.find((a) => a.methode === "ecrire" && a.chemin === "preferences.json");
  verifier(ecriture?.message?.includes("Sauvegarde"), "sauvegarde à 3 h", ecriture);
  const fichiers = await (await fetch(`${FAUX}/control/fichiers`)).json();
  const sauvegarde = JSON.parse(fichiers["preferences.json"]);
  verifier(sauvegarde.format === "bot-v2" && sauvegarde.config.regles.length >= 2, "contenu de la sauvegarde");
  // Le bot perd ses réglages (supprimé, recréé) : il repart de sa sauvegarde, rubriques comprises.
  const avantPerte = (await etat()).config;
  await envoyerJson(`${BOT}/test/etat`, { oublier_config: true });
  verifier(!(await etat()).config, "réglages effacés pour le test");
  await obtenir(`${BOT}/api/config`, { headers: entetesApi });
  const restauree = (await etat()).config;
  verifier(restauree?.regles?.length === avantPerte.regles.length && JSON.stringify(restauree.deroule) === JSON.stringify(avantPerte.deroule)
    && restauree.format.duree_minutes === avantPerte.format.duree_minutes, "réglages restaurés depuis la sauvegarde",
    { avant: avantPerte.regles.length, apres: restauree?.regles?.length });
  await horloge("2026-10-13T10:00");
});

await scenario("Sources : un média de plus pour les Actualités globales, retrait", async () => {
  const lus = (config) => config.sources.flux.filter((f) => config.actus.flux_lus.includes(f.id));
  let r = await app("flux_ajouter", { valeur: `${FAUX}/site/page.html`, actualites: true });
  let { config } = await etat();
  verifier(r.ok && lus(config).length === 4 && lus(config).at(-1).url.endsWith("/rss/flux.xml") && !("flux" in config.actus), "flux trouvé depuis la page, lu par les Actualités globales", config.sources);
  verifier(lus(config).at(-1).nom === "La Région", "nom du flux", lus(config).at(-1));
  const monde = config.sources.flux.find((f) => f.nom === "Le Monde");
  r = await app("actus_flux", { id: monde.id, lu: false });
  ({ config } = await etat());
  verifier(r.ok && lus(config).length === 3 && !lus(config).some((f) => f.nom === "Le Monde") && config.sources.flux.some((f) => f.nom === "Le Monde"),
    "Le Monde décoché des Actualités globales (il reste dans les flux)", lus(config).map((f) => f.nom));
  await gemini({ operations: [{ action: "retirer_source", valeur: "RTS" }], reponse: "RTS retirée." });
  await app("parler", { texte: "enlève la RTS" });
  ({ config } = await etat());
  verifier(!lus(config).some((f) => f.nom.includes("RTS")) && !config.sources.flux.some((f) => f.nom.includes("RTS")), "retrait par la parole (plus lu par personne : quitte la liste)", config.sources.flux.map((f) => f.nom));
  for (const f of config.sources.flux.filter((x) => !config.actus.flux_lus.includes(x.id))) await app("actus_flux", { id: f.id, lu: true });
  ({ config } = await etat());
  const seul = config.actus.flux_lus.slice(0, -1);
  for (const id of seul) await app("actus_flux", { id, lu: false });
  r = await app("actus_flux", { id: (await etat()).config.actus.flux_lus[0], lu: false });
  verifier(r.ok === false && r.erreur.includes("au moins un flux"), "les Actualités globales gardent au moins un flux", r.erreur);
  for (const id of seul) await app("actus_flux", { id, lu: true });
});

await scenario("Modèles légers mis à jour par GitHub", async () => {
  await evenement({ type: "modeles", rapides: ["gemini-9.9-flash-lite", "pas-un-modele"] });
  await gemini({ operations: [], reponse: "Bonjour !" });
  await app("parler", { texte: "salut" });
  const liste = await appels();
  verifier(liste.find((a) => a.service === "gemini")?.corps?.model === "gemini-9.9-flash-lite", "le bot utilise la liste découverte", liste.find((a) => a.service === "gemini")?.corps?.model);
});

await scenario("Autre heure, derniers résultats exportés", async () => {
  const r = await app("jour", { jour: "mer", heure: "5h40" });
  verifier(r.ok && (await etat()).config.planning.jours.mer === "05:40", "autre heure pour le mercredi", (await etat()).config.planning.jours.mer);
  await evenement({ type: "recherche", regles: ["R1"], idees: ["Grottes"] });
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.derniers_resultats?.idees?.[0] === "Grottes", "derniers résultats exportés (pour « D'autres idées »)", exp.derniers_resultats);
});

await scenario("Rubriques : numérotation automatique, pas de transport par défaut", async () => {
  await horloge("2026-10-13T10:00");
  const avant = (await etat()).config.regles.length;
  for (const titre of ["Alpha", "Bravo", "Charlie"]) {
    await gemini({ operations: [{ action: "nouvelle_regle", regle: { titre, consigne: `Parler de ${titre}`, periode_type: "toujours", rubrique_titre: titre, rubrique_apres: "agenda" } }], reponse: "ok" });
    await app("parler", { texte: `ajoute une rubrique ${titre}` });
  }
  let { config } = await etat();
  verifier(config.regles.map((r) => r.id).join() === Array.from({ length: avant + 3 }, (_, i) => `R${i + 1}`).join(), "numéros consécutifs", config.regles.map((r) => `${r.id}:${r.titre}`));
  verifier(config.regles.find((r) => r.titre === "Charlie").recherche?.fiche?.transport === "aucun", "nouvelle rubrique : pas de transport par défaut");
  const bravo = config.regles.find((r) => r.titre === "Bravo");
  const numeroBravo = Number(bravo.id.slice(1));
  await app("supprimer", { id: `R${numeroBravo - 1}` });                       // la rubrique juste avant Bravo
  ({ config } = await etat());
  verifier(config.regles.map((r) => r.id).join() === Array.from({ length: avant + 2 }, (_, i) => `R${i + 1}`).join(), "après suppression : renumérotées", config.regles.map((r) => r.id));
  verifier(config.regles.find((r) => r.titre === "Bravo").id === `R${numeroBravo - 1}`, "Bravo a remonté d'un rang");
  const cles = config.deroule.map((r) => r.cle);
  verifier(cles.every((c) => !/^R\d+$/.test(c) || config.regles.some((r) => r.id === c)) && new Set(cles).size === cles.length, "déroulé cohérent après renumérotation", cles);
  verifier(config.regles.every((r) => !r.rubrique || /^(R\d+|[a-z_]+)$/.test(r.rubrique.apres) && (!/^R\d+$/.test(r.rubrique.apres) || config.regles.some((x) => x.id === r.rubrique.apres))), "références « après » cohérentes");
});

await scenario("Rattrapage : délai réglable et désactivation", async () => {
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, declenchements: {}, refaits: {} } });
  await app("regler", { chemin: "planning.rattrapage", valeur: true });
  await app("regler", { chemin: "planning.delai_rattrapage", valeur: 30 });
  const p = (await etat()).config.planning;
  verifier(p.rattrapage && p.delai_rattrapage === 30, "délai 30 min", p);
  // mercredi 21 octobre : épisode à 5 h 40 (réglé plus haut), préparation à 5 h 35.
  await horloge("2026-10-21T05:35", true);
  verifier(lancements(await appels())[0]?.entrees?.mode === "planifie", "lancement à 5 h 35");
  await vider();
  await horloge("2026-10-21T06:05", true);
  verifier(!lancements(await appels()).length, "pas de rattrapage avant 30 min");
  await horloge("2026-10-21T06:11", true);
  verifier(lancements(await appels())[0]?.entrees?.mode === "rattrapage", "rattrapage 30 min après l'heure prévue", lancements(await appels()));
  // Désactivé : plus de rattrapage.
  await app("regler", { chemin: "planning.rattrapage", valeur: false });
  verifier((await etat()).config.planning.rattrapage === false, "rattrapage désactivé");
  await horloge("2026-10-28T05:35", true);
  await vider();
  await horloge("2026-10-28T07:30", true);
  verifier(!lancements(await appels()).length, "aucun rattrapage quand il est désactivé");
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.episode_lance_aujourdhui !== undefined && exp.config.planning.delai_rattrapage === 30, "export pour le filet de GitHub", exp.config.planning);
  await app("regler", { chemin: "planning.rattrapage", valeur: true });
});

await scenario("Agendas : liste, choix, lecture", async () => {
  await evenement({ type: "agendas", liste: [{ id: "aaaa111111", nom: "Perso (Google)", nb: 12 }, { id: "bbbb222222", nom: "Travail (Outlook)", nb: 30 }, { id: "../mauvais", nom: "x", nb: 1 }] });
  let r = await app("etat");
  const noms = r.donnees.reglages.agendas.map((a) => a.nom).join();
  verifier(noms.includes("Perso (Google)") && noms.includes("Travail (Outlook)") && !noms.includes("x"), "agendas listés (identifiant invalide ignoré)", noms);
  r = await app("agenda", { id: "bbbb222222", lu: false });
  verifier(r.ok && (await etat()).config.agenda.exclus.join() === "bbbb222222", "agenda ignoré");
  r = await app("agenda", { id: "aaaa111111", lu: false });
  verifier(r.ok === false && (await etat()).config.agenda.exclus.join() === "bbbb222222", "au moins un agenda reste lu");
  await app("agenda", { id: "bbbb222222", lu: true });
  verifier((await etat()).config.agenda.exclus.length === 0, "agenda relu");
  await vider();
  await app("lire_agendas");
  verifier(lancements(await appels())[0]?.workflow === "agendas.yml", "lecture des agendas demandée");
});

await scenario("Consignes par rubrique, Actualités globales et Actu locale réglées pareil", async () => {
  // Les consignes de style qui parlent de l'agenda sont rangées une fois dans la rubrique Agenda.
  const migree = completerConfig({ consignes: ["Mentionne l'événement BG3 uniquement la veille", "Plus d'humour le vendredi", "Si le rendez-vous est à Berne, préviens-moi"],
                                   actus: { citer_sources: "oral" } });
  verifier(migree.consignes.join() === "Plus d'humour le vendredi" && migree.consignes_rubriques.agenda.length === 2
           && Object.keys(migree.consignes_rubriques).join() === Object.keys(RUBRIQUES).join() && !("citer_sources" in migree.actus),
    "consignes d'agenda rangées dans l'Agenda, plus de « Citer les sources »", migree);
  migree.consignes.push("Ne parle pas de mon agenda le dimanche");
  verifier(completerConfig(migree).consignes.length === 2, "rangées une seule fois (après, l'auditeur décide)");
  verifier(RUBRIQUES.actualites === "Actualités globales", "Actualités devient Actualités globales");

  let r = await app("liste", { chemin: "consignes_rubriques.agenda", valeurs: ["Ne parle de la piscine que la veille", "Signale les journées chargées."] });
  verifier(r.ok && r.donnees.reglages.consignes_rubriques.agenda.length === 2 && r.donnees.listes.consignes_pretes_rubriques.agenda.length > 0,
    "consignes de l'Agenda (et consignes toutes prêtes de la rubrique)", r.donnees.reglages.consignes_rubriques);
  verifier((await app("liste", { chemin: "consignes_rubriques.inconnue", valeurs: ["x"] })).ok === false, "rubrique inconnue refusée");
  for (const [chemin, valeur] of [["actus.locale_sujets", 3], ["actus.locale_articles", 7], ["actus.locale_fraicheur_heures", 72], ["actus.articles", 20], ["format.nombre_sujets", 4]]) {
    r = await app("regler", { chemin, valeur });
  }
  await app("liste", { chemin: "actus.locale_preferes", valeurs: ["travaux", "culture"] });
  r = await app("liste", { chemin: "actus.locale_a_eviter", valeurs: ["culture"] });
  let { config } = await etat();
  verifier(config.actus.locale_sujets === 3 && config.actus.locale_articles === 7 && config.actus.locale_fraicheur_heures === 72 && config.actus.articles === 20
           && config.actus.locale_preferes.join() === "travaux" && config.actus.locale_a_eviter.join() === "culture",
    "actu locale : sujets, articles lus, âge, thèmes (un thème évité n'est plus préféré)", config.actus);
  verifier((await app("regler", { chemin: "actus.citer_sources", valeur: "oral" })).ok === false && !("citer" in r.donnees.listes),
    "« Citer les sources » a disparu");
  verifier(r.donnees.deroule.find((x) => x.cle === "actualites")?.nom === "Actualités globales", "nom affiché dans l'épisode");

  // Une consigne de style qui parle d'un rendez-vous se range dans l'Agenda d'un geste.
  await app("liste", { chemin: "consignes", valeurs: ["Plus d'humour", "Mentionne l'événement piscine la veille"] });
  r = await app("consigne_ranger", { index: 1, rubrique: "agenda" });
  ({ config } = await etat());
  verifier(r.ok && config.consignes.join() === "Plus d'humour" && config.consignes_rubriques.agenda.at(-1) === "Mentionne l'événement piscine la veille"
           && r.message === "Consigne rangée dans Agenda", "consigne rangée dans l'Agenda", { c: config.consignes, a: config.consignes_rubriques.agenda, m: r.message });
  verifier((await app("consigne_ranger", { index: 0, rubrique: "nulle_part" })).ok === false, "rangement vers une rubrique inconnue refusé");

  // À la voix : une consigne propre à une rubrique va dans sa liste, entière.
  await gemini({ operations: [
    { action: "ajouter_liste", chemin: "consignes_rubriques.actualites", valeur: "Commence par l'économie, puis la Suisse, puis le reste" },
    { action: "regler", chemin: "actus.locale_preferes", valeur: "circulation" },
  ], reponse: "" });
  r = await app("parler", { texte: "dans les actualités globales commence par l'économie, puis la Suisse, puis le reste ; et dans l'actu locale, la circulation" });
  ({ config } = await etat());
  verifier(config.consignes_rubriques.actualites.join() === "Commence par l'économie, puis la Suisse, puis le reste"
           && config.actus.locale_preferes.includes("circulation") && config.actus.locale_preferes.includes("travaux"),
    "à la voix : consigne d'une rubrique (pas coupée aux virgules) et thème local ajouté", { a: config.consignes_rubriques.actualites, l: config.actus.locale_preferes });
  const appelGemini = (await appels()).filter((x) => x.service === "gemini").at(-1)?.corps;
  verifier(JSON.stringify(appelGemini).includes("consignes_rubriques.agenda"), "Gemini connaît les consignes par rubrique");
  await app("liste", { chemin: "consignes", valeurs: [] });
  for (const cle of Object.keys(RUBRIQUES)) await app("liste", { chemin: `consignes_rubriques.${cle}`, valeurs: [] });
});

await scenario("Réglages › Sources : services, flux, sites, agendas, données testés", async () => {
  let r = await app("etat");
  let s = r.donnees.reglages.sources;
  verifier(s.categories.filter((c) => c.type === "services").map((c) => c.cle).join() === "actus,web,meteo,transports,lieux,wikivoyage"
           && s.categories.filter((c) => c.type === "donnees").map((c) => c.cle).join() === "saints,fetes,feries",
    "services et données rangés à part", s.categories.map((c) => [c.cle, c.type]));
  verifier(/fête/.test(s.categories.find((c) => c.cle === "saints").aujourdhui) && s.categories.find((c) => c.cle === "feries").aujourdhui,
    "données : ce qu'elles donnent aujourd'hui", s.categories.filter((c) => c.type === "donnees").map((c) => c.aujourdhui));
  await app("regler", { chemin: "actus.ville", valeur: "Yverdon" });
  for (const cle of ["actus", "meteo", "transports", "lieux", "wikivoyage"]) {
    r = await app("outil_tester", { cle: `service:${cle}` });
    verifier(r.ok && r.donnees.reglages.sources.categories.find((c) => c.cle === cle).test?.ok, `service testé : ${cle}`, r.erreur || r.message);
  }
  r = await app("outil_tester", { cle: "service:meteo" });
  verifier(r.message.includes("°C") && r.message.includes("Yverdon"), "météo : la température chez toi", r.message);
  verifier((await app("outil_tester", { cle: "service:saints" })).ok === false, "une donnée intégrée ne se teste pas comme un service");
  // Flux : test (nombre d'articles, le plus récent), média proposé pour le pays.
  r = await app("rubrique", { formulaire: { titre: "Région", consigne: "Les nouvelles de la région", periode: { type: "toujours" }, sources: ["actus"] } });
  const region = r.id;
  r = await app("flux_ajouter", { valeur: `${FAUX}/rss/flux.xml` });
  const leFlux = r.donnees.reglages.sources.flux.find((f) => f.url.endsWith("/rss/flux.xml"));
  r = await app("outil_tester", { cle: `flux:${leFlux.id}` });
  verifier(r.ok && r.message.startsWith("1 article") && r.donnees.reglages.sources.flux.find((f) => f.id === leFlux.id).test?.ok, "flux testé", r.message || r.erreur);
  verifier(Array.isArray(s.proposes), "médias proposés pour le pays", s.proposes);
  // Sites de référence : ajout (vérifié), test, choisi par une rubrique, retrait.
  verifier((await app("site_ajouter", { valeur: "pas une adresse" })).ok === false, "site : il faut une adresse");
  r = await app("site_ajouter", { valeur: "mort.ch" });
  verifier(r.ok === false && r.erreur.includes("404"), "site qui ne répond pas : refusé", r.erreur);
  r = await app("site_ajouter", { valeur: "https://www.labo.ch/actualites" });
  const site = (await etat()).config.sources.sites[0];
  verifier(r.ok && site?.domaine === "labo.ch" && site.nom === "Le Labo" && r.donnees.reglages.sources.sites[0].test?.ok, "site ajouté : domaine, nom de la page, testé", site || r.erreur);
  verifier((await app("site_ajouter", { valeur: "labo.ch" })).ok === false, "même site pas deux fois");
  r = await app("outil_tester", { cle: `site:${site.id}` });
  verifier(r.ok && r.message.includes("Le Labo"), "site testé", r.message);
  r = await app("rubrique", { formulaire: { titre: "Labo", consigne: "Les nouvelles du labo", periode: { type: "toujours" }, sources: [`site:${site.id}`, "agenda:abcdef0123"] } });
  const labo = r.id;
  verifier(r.ok && (await etat()).config.regles.find((x) => x.id === labo).recherche.sources.join() === `site:${site.id},agenda:abcdef0123`
           && r.donnees.reglages.sources.sites[0].rubriques.some((x) => x.id === labo), "une rubrique coche un site et un seul agenda", r.erreur || r.donnees.reglages.sources.sites);
  r = await app("site_retirer", { id: site.id });
  verifier(r.ok && !(await etat()).config.sources.sites.length && (await etat()).config.regles.find((x) => x.id === labo).recherche.sources.join() === "agenda:abcdef0123",
    "site retiré : les rubriques ne le gardent pas");
  // Agendas : test d'un agenda ajouté dans l'application (nombre d'événements).
  r = await app("agenda_ajouter", { url: `${FAUX}/ics/perso.ics` });
  const ag = r.donnees.reglages.agendas.at(-1);
  r = await app("outil_tester", { cle: `agenda:${ag.id}` });
  verifier(r.ok && r.message.includes("2 événements") && r.donnees.reglages.sources.agendas[ag.id]?.test?.ok, "agenda testé", r.message || r.erreur);
  verifier((await app("outil_tester", { cle: "agenda:0000000000" })).ok === false, "agenda inconnu refusé");
  r = await app("agenda_retirer", { id: ag.id });
  verifier(r.ok, "agenda retiré");
  for (const id of [region, labo]) await app("supprimer", { id });
  await app("flux_retirer", { id: leFlux.id });
  verifier(s.flux.some((f) => f.nom === "Google Actualités – Suisse" && f.pays === "CH"), "flux du pays présents, marqués de leur pays", s.flux);
});

await scenario("Sources des rubriques : fournies, filtrées par modèle, test de Google depuis GitHub, agendas renommés", async () => {
  // Deux agendas lus par GitHub.
  await evenement({ type: "agendas", liste: [{ id: "aaaa000001", nom: "Perso", nb: 3 }, { id: "bbbb000002", nom: "Sport", nb: 5 }], evenements: [] });
  // Agenda et Mes déplacements : tous les agendas, ou certains seulement.
  let r = await app("sources_integree", { cle: "agenda", sources: ["agenda:bbbb000002"] });
  verifier(r.ok && r.donnees.reglages.sources_integrees.agenda.join() === "agenda:bbbb000002"
           && r.donnees.reglages.sources.agendas.bbbb000002.fournies.join() === "Agenda,Mes déplacements"
           && r.donnees.reglages.sources.agendas.aaaa000001.fournies.join() === "Mes déplacements", "Agenda : un seul agenda ; qui lit quoi", r.erreur || r.donnees.reglages.sources.agendas);
  verifier((await app("sources_integree", { cle: "deplacements", sources: [] })).ok === false, "Mes déplacements : au moins un agenda");
  r = await app("sources_integree", { cle: "deplacements", sources: ["agenda", "agenda:inconnu000"] });
  verifier(r.ok && r.donnees.reglages.sources_integrees.deplacements.join() === "agenda", "agenda inconnu écarté : tous les agendas");
  // Actu locale et À creuser : leurs flux.
  const unFlux = r.donnees.reglages.sources.flux[0];
  r = await app("sources_integree", { cle: "actu_locale", sources: [unFlux.cle, "flux:inconnu1"] });
  verifier(r.ok && r.donnees.reglages.sources_integrees.actu_locale.join() === unFlux.cle && r.donnees.reglages.sources.flux[0].fournies.includes("Actu locale"),
    "Actu locale : ses flux", r.donnees.reglages.sources_integrees);
  r = await app("sources_integree", { cle: "approfondissements", sources: [unFlux.cle] });
  verifier(r.ok && r.donnees.reglages.sources_integrees.approfondissements.length === 1, "À creuser : ses flux");
  verifier((await app("sources_integree", { cle: "ouverture", sources: [] })).ok === false, "une rubrique sans sources à choisir : refusé");
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.config.sources_integrees.agenda.join() === "agenda:bbbb000002", "GitHub reçoit ce que lisent les rubriques fournies", exp.config.sources_integrees);
  // Renommer un agenda (vide : le nom du fichier revient).
  r = await app("agenda_renommer", { id: "bbbb000002", nom: "Club de foot" });
  let ag = r.donnees.reglages.agendas.find((a) => a.id === "bbbb000002");
  verifier(r.ok && ag.nom === "Club de foot" && ag.nom_fichier === "Sport", "agenda renommé", ag);
  r = await app("agenda_renommer", { id: "bbbb000002", nom: "" });
  ag = r.donnees.reglages.agendas.find((a) => a.id === "bbbb000002");
  verifier(r.ok && ag.nom === "Sport" && !ag.nom_fichier && !Object.keys((await etat()).config.agenda.noms).length, "nom d'origine rendu");
  await app("sources_integree", { cle: "agenda", sources: ["agenda"] });
  await app("sources_integree", { cle: "actu_locale", sources: [] });
  await app("sources_integree", { cle: "approfondissements", sources: [] });
  // Le modèle d'une rubrique est gardé : il dit quelles sources elle peut choisir.
  r = await app("rubrique", { formulaire: { titre: "Mon train", consigne: "Retard du 7h12", periode: { type: "toujours" }, sources: ["transports"], modele: "train" } });
  const train = r.id;
  verifier(r.message === "Rubrique « Mon train » créée" && r.donnees.regles.find((x) => x.id === train).genre === "train"
           && r.donnees.modeles.find((m) => m.id === "train").titre === "Mes transports en commun" && r.donnees.modeles.find((m) => m.id === "libre").titre === "Rubrique sur mesure",
    "message sans numéro ; type et icône venus du modèle", { m: r.message });
  verifier(r.ok && r.donnees.regles.find((x) => x.id === train).modele === "train" && r.donnees.listes.sources_par_modele.train.join() === "transports,agendas",
    "rubrique d'un modèle : modèle gardé, sources proposées filtrées", r.erreur);
  r = await app("rubrique", { formulaire: { titre: "Point CFF", consigne: "Les retards", periode: { type: "ponctuelle" }, sources: ["actus"], modele: "train" } });
  verifier(r.ok && (await etat()).config.regles.find((x) => x.id === r.id).modele === "libre", "recherche ponctuelle : toutes les sources");
  for (const id of [train, r.id]) await app("supprimer", { id });
  // Google refuse le bot : le test part sur GitHub et son résultat revient.
  await app("regler", { chemin: "actus.ville", valeur: "Bloqueville" });
  await vider();
  r = await app("outil_tester", { cle: "service:actus" });
  const lance = lancements(await appels()).find((x) => x.workflow === "tester-cles.yml");
  verifier(r.ok && r.attendre_test && lance && JSON.parse(lance.entrees.outils)[0].cle === "service:actus" && lance.entrees.cles === ""
           && r.donnees.reglages.sources.categories.find((c) => c.cle === "actus").test?.en_cours, "Google refuse le bot : test parti sur GitHub", { r: r.message, lance });
  await evenement({ type: "outils", resultats: { "service:actus": { ok: true, message: "Google Actualités répond : 12 articles." }, "pas:bon": { ok: true } } });
  r = await app("etat");
  const t = r.donnees.reglages.sources.categories.find((c) => c.cle === "actus").test;
  verifier(t?.ok && t.message.includes("testé depuis GitHub") && !t.en_cours, "résultat de GitHub affiché", t);
  await app("regler", { chemin: "actus.ville", valeur: "Yverdon" });
});

await scenario("Données intégrées : mêmes résultats que fetes.py", async () => {
  const dates = ["2026-10-29", "2026-05-31", "2026-11-27", "2027-03-08", "2026-12-25", "2026-02-10"];
  const script = `import json, datetime as dt, fetes
r = {}
for d in ${JSON.stringify(dates)}:
    j = dt.date.fromisoformat(d)
    f = fetes.journees_du_jour(j, "CH")
    r[d] = {"prenoms": fetes.prenoms_du_jour(j)["principal"], **{k: sorted(e["nom"] for e in v) for k, v in f.items()}}
print(json.dumps(r, ensure_ascii=False))`;
  const python = JSON.parse(execFileSync("python3", ["-c", script], { cwd: new URL("../..", import.meta.url).pathname }).toString());
  const { journeesDuJour, prenomsDuJour } = await import("../src/donnees.js");
  for (const d of dates) {
    const f = journeesDuJour(d, "CH");
    const js = { prenoms: prenomsDuJour(d).principal, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.map((e) => e.nom).sort()])) };
    verifier(JSON.stringify(js) === JSON.stringify(python[d]), `données du ${d} identiques`, { js, python: python[d] });
  }
});

await scenario("Rubriques intégrées : actu locale, déplacements, à creuser", async () => {
  await app("regler", { chemin: "actus.locale_articles", valeur: 4 });
  await app("regler", { chemin: "agenda.max_deplacements", valeur: 3 });
  const ordre = (await etat()).config.deroule.map((x) => x.cle);
  await app("deroule", { ordre, actifs: { actu_locale: false } });
  let { config } = await etat();
  verifier(config.actus.locale_articles === 4 && config.agenda.max_deplacements === 3 && config.deroule.find((x) => x.cle === "actu_locale").actif === false,
    "réglages des rubriques intégrées", { a: config.actus.locale_articles, d: config.agenda.max_deplacements });
  await app("deroule", { ordre, actifs: { actu_locale: true } });
  let r = await app("creuser", { sujet: "la réforme des retraites" });
  verifier(r.ok && (await etat()).config.a_approfondir.some((x) => x.sujet === "la réforme des retraites"), "sujet à creuser ajouté");
  await app("retirer_creuser", { index: 0 });
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.config.deroule.some((x) => x.cle === "actu_locale") && exp.agendas.length === 2, "export : actu_locale et agendas", exp.agendas);
});

await scenario("Rubrique : titre et consigne rédigés par l'IA, jamais la phrase de l'auditeur", async () => {
  const avant = (await etat()).config.regles.length;
  // Gemini ne donne que le titre : la rédaction écrit la consigne à partir de la demande.
  await gemini({ operations: [{ action: "nouvelle_regle", regle: { titre: "Tech Optique", transport: "peu_importe" } }], reponse: "" },
               { titre: "Optique et innovations", consigne: "Présentez une avancée récente des technologies optiques, en expliquant simplement à quoi elle sert." });
  await app("parler", { texte: "crée une rubrique pour demain sur les nouvelles technologies dans l'optique" });
  let regles = (await etat()).config.regles;
  let r = regles.find((x) => x.titre === "Optique et innovations");
  verifier(regles.length === avant + 1 && r && r.consigne.startsWith("Présentez une avancée récente"), "consigne rédigée (Gemini n'en donnait pas)", r);
  verifier(["", "aucun", undefined].includes(r?.recherche?.fiche?.transport), "« peu importe » = aucun critère de transport", r?.recherche?.fiche);
  // Gemini recopie la phrase dite : elle est réécrite.
  const dit = "je voudrais une rubrique qui parle des sorties cinéma de la semaine avec un avis court sur chaque film";
  await gemini({ entendu: dit, operations: [{ action: "nouvelle_regle", regle: { titre: "Je voudrais une rubrique cinéma", consigne: dit } }], reponse: "" },
               { titre: "Sorties cinéma", consigne: "Présentez les films qui sortent cette semaine, avec un avis court sur chacun." });
  await app("parler", { audio: wav, mime: "audio/wav" });
  r = (await etat()).config.regles.find((x) => x.titre === "Sorties cinéma");
  verifier(r && r.consigne === "Présentez les films qui sortent cette semaine, avec un avis court sur chacun.", "consigne recopiée d'un vocal : réécrite", r);
  // Rédaction indisponible : le sujet sans les formules de demande, jamais la phrase telle quelle.
  await gemini({ operations: [{ action: "nouvelle_regle", regle: { titre: "", consigne: "Ajoute une rubrique sur la météo des neiges en Valais" } }], reponse: "" });
  await app("parler", { texte: "Ajoute une rubrique sur la météo des neiges en Valais" });
  regles = (await etat()).config.regles;
  r = regles.at(-1);
  verifier(r && !/ajoute/i.test(r.consigne) && r.consigne.includes("météo des neiges en Valais") && !/ajoute/i.test(r.titre), "sans rédaction : formules retirées", r);
  for (const x of (await etat()).config.regles.slice(avant)) await app("supprimer", { id: x.id });
});

// ─────────────────────────── application ─────────────────────────

await scenario("Application : données des écrans", async () => {
  const r = await app("etat");
  verifier(r.statut === 200 && r.ok && Array.isArray(r.donnees?.regles) && r.donnees.planning.semaine.length === 7 && r.donnees.deroule.length > 3, "données des écrans", r);
  // Calendrier d'un an (mois en cours + 12) : seuls les jours hors de l'habitude y sont.
  const pl = r.donnees.planning, auj = r.donnees.aujourdhui;
  const finAttendue = (() => { const x = new Date(`${auj.slice(0, 8)}01T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 13, 0); return x.toISOString().slice(0, 10); })();
  const nouvelAn = `${Number(auj.slice(0, 4)) + 1}-01-01`;
  verifier(pl.calendrier_jusqua === finAttendue && pl.calendrier[nouvelAn]?.ferie && Object.keys(pl.calendrier).length < 40
    && r.donnees.listes.sources.meteo, "calendrier d'un an (jours particuliers seulement) et listes fournis",
    { jusqua: pl.calendrier_jusqua, jours: Object.keys(pl.calendrier) });
});

await scenario("Application : créer, modifier, supprimer une rubrique", async () => {
  await horloge("2026-10-19T10:00");                       // lundi
  let r = await app("rubrique", { formulaire: { titre: "", consigne: "x" } });
  verifier(r.ok === false && r.erreur.includes("titre"), "titre obligatoire", r.erreur);
  r = await app("rubrique", { formulaire: { titre: "x", consigne: "y", periode: { type: "jours", jours: [] } } });
  verifier(r.ok === false && r.erreur.includes("jour"), "au moins un jour demandé", r.erreur);
  r = await app("rubrique", { formulaire: { titre: "Météo du matin", consigne: "La météo à Yverdon en deux phrases", longueur: "courte",
    periode: { type: "jours", jours: ["lun", "mar", "zzz"] }, sources: ["meteo", "inconnue"], prioritaire: true, active: true } });
  verifier(r.ok && /^R\d+$/.test(r.id), "rubrique créée", r);
  const id = r.id;
  let { config } = await etat();
  let regle = config.regles.find((x) => x.id === id);
  verifier(regle?.periode.type === "jours" && regle.periode.jours.join() === "lun,mar" && regle.importance === "prioritaire"
    && regle.recherche?.sources.join() === "meteo" && regle.rubrique?.longueur === "courte" && regle.origine === "application", "champs enregistrés et nettoyés", regle);
  const place = config.deroule.findIndex((x) => x.cle === id);
  verifier(place === config.deroule.findIndex((x) => x.cle === "actualites") + 1, "placée après les actualités", config.deroule);
  verifier(r.donnees.regles.find((x) => x.id === id)?.famille === "jour", "rangée dans la famille « Le jour »");
  r = await app("rubrique", { id, formulaire: { titre: "Météo", consigne: "La météo", longueur: "aucune", periode: { type: "toujours" }, sources: [], active: false } });
  verifier(r.ok === false && r.erreur.includes("au moins une source"), "sans source : refusée (où chercher doit être choisi)", r.erreur);
  r = await app("rubrique", { id, formulaire: { titre: "Météo", consigne: "La météo", longueur: "aucune", periode: { type: "toujours" }, sources: ["meteo", "flux:inconnu1"], active: false } });
  ({ config } = await etat());
  regle = config.regles.find((x) => x.id === id);
  verifier(r.ok && regle.titre === "Météo" && regle.rubrique === null && regle.recherche.sources.join() === "meteo,flux:inconnu1" && regle.etat === "pause" && !config.deroule.some((x) => x.cle === id), "modifiée : sans passage, en pause", regle);
  verifier((await etat()).etat.annulations.at(-1)?.libelle?.includes("modifiée"), "le changement peut être annulé avec /annuler", (await etat()).etat.annulations.at(-1)?.libelle);
  r = await app("rubrique", { id: "R99", formulaire: { titre: "a", consigne: "b" } });
  verifier(r.ok === false, "rubrique inconnue refusée");
  r = await app("supprimer", { id });
  verifier(r.ok && !(await etat()).config.regles.some((x) => x.titre === "Météo"), "rubrique supprimée", r.erreur);
});

await scenario("Application : déroulé et place des rubriques", async () => {
  let r = await app("rubrique", { formulaire: { titre: "Citation", consigne: "Une citation", longueur: "phrase", periode: { type: "toujours" }, sources: ["web"] } });
  const id = r.id;
  let ordre = r.donnees.deroule.map((x) => x.cle);
  const nouveau = [ordre[0], id, ...ordre.slice(1).filter((c) => c !== id)];
  r = await app("deroule", { ordre: nouveau, actifs: { agenda: false } });
  let { config } = await etat();
  verifier(r.ok && config.deroule.map((x) => x.cle).join() === nouveau.join(), "nouvel ordre enregistré", config.deroule);
  verifier(config.deroule.find((x) => x.cle === "agenda").actif === false, "passage mis en pause");
  verifier(config.regles.find((x) => x.id === id).rubrique.apres === nouveau[0], "la rubrique retient sa nouvelle place");
  r = await app("deroule", { ordre: nouveau.slice(1) });
  verifier(r.ok === false && r.erreur.includes("changé"), "ordre incomplet refusé", r);
  r = await app("rubrique", { id, formulaire: { titre: "Citation du jour", consigne: "Une citation", longueur: "courte", periode: { type: "toujours" }, sources: ["web"] } });
  ({ config } = await etat());
  verifier(config.deroule.findIndex((x) => x.cle === id) === 1, "modifier une rubrique ne la déplace pas", config.deroule.map((x) => x.cle));
  await app("deroule", { ordre: config.deroule.map((x) => x.cle), actifs: { agenda: true } });
  await app("supprimer", { id });
});

await scenario("Application : sauter un épisode, générer", async () => {
  await horloge("2026-10-19T10:00");
  let r = await app("etat");
  const date = r.donnees.prochain.date;
  r = await app("sauter", { date });
  let { config } = await etat();
  verifier(r.ok && config.planning.exceptions.some((x) => x.date === date && x.heure === null) && r.donnees.prochain.date !== date, "épisode sauté", config.planning.exceptions);
  verifier(r.donnees.sautes.some((x) => x.date === date), "listé comme sauté");
  r = await app("retablir", { date });
  ({ config } = await etat());
  verifier(r.ok && !config.planning.exceptions.some((x) => x.date === date), "épisode rétabli");
  verifier((await app("sauter", { date: "2020-01-01" })).ok === false, "date passée refusée");
  await vider();
  r = await app("generer");
  verifier(r.ok && lancements(await appels()).some((a) => a.entrees?.mode === "manuel"), "épisode lancé depuis l'application", r);
  verifier((await app("ouvrir", { ecran: "planning" })).ok === false, "plus d'écran à ouvrir ailleurs que dans l'application");
  verifier((await app("bidule")).ok === false, "action inconnue refusée");
});

await scenario("Application : réglages, planning, listes", async () => {
  await horloge("2026-10-19T10:00");
  let r = await app("regler", { chemin: "format.duree_minutes", valeur: 6.5 });
  let { config } = await etat();
  verifier(r.ok && config.format.duree_minutes === 6.5 && r.donnees.reglages.format.duree_minutes === 6.5, "durée réglée", r.erreur);
  verifier((await app("regler", { chemin: "format.duree_minutes", valeur: 40 })).ok === false, "valeur hors limites refusée");
  verifier((await app("regler", { chemin: "prochain_numero", valeur: 3 })).ok === false, "réglage non autorisé refusé");
  r = await app("regler", { chemin: "voix.animateurs.1.voix", valeur: "Charon" });
  verifier(r.ok && (await etat()).config.voix.animateurs[1].voix === "Charon" && r.donnees.reglages.voix.animateurs[1].nom === "Charon", "voix d'un animateur (son nom suit la voix)");
  r = await app("liste", { chemin: "actus.sujets_a_eviter", valeurs: ["sport", "people", "sport"] });
  ({ config } = await etat());
  verifier(r.ok && config.actus.sujets_a_eviter.join() === "sport,people", "thèmes à éviter (doublons retirés)", config.actus.sujets_a_eviter);
  r = await app("liste", { chemin: "consignes", valeurs: ["plus d'humour", "un point sur Yverdon"] });
  verifier(r.ok && (await etat()).config.consignes.length === 2, "consignes remplacées");
  const longue = "Rappelle-moi uniquement la veille et le jour de l'événement piscine de prendre mon maillot, ma serviette et mon cadenas, et dis-moi l'heure d'ouverture du bassin";
  r = await app("liste", { chemin: "consignes", valeurs: ["plus d'humour", longue] });
  verifier(r.ok && (await etat()).config.consignes[1] === longue, "une consigne longue n'est pas coupée", (await etat()).config.consignes[1]);
  r = await app("liste", { chemin: "consignes", valeurs: ["plus d'humour", "un point sur Yverdon"] });
  r = await app("jour", { jour: "dim", heure: null });
  verifier(r.ok && (await etat()).config.planning.jours.dim === null, "plus d'épisode le dimanche");
  r = await app("jour", { jour: "sam", heure: "9 h 15" });
  verifier(r.ok && (await etat()).config.planning.jours.sam === "09:15", "heure du samedi");
  verifier((await app("jour", { jour: "sam", heure: "25:00" })).ok === false, "heure invalide refusée");
  r = await app("exception", { date: "2026-10-22", heure: "05:30" });
  verifier(r.ok && (await etat()).config.planning.exceptions.some((x) => x.date === "2026-10-22" && x.heure === "05:30"), "exception ajoutée");
  r = await app("retirer_exception", { date: "2026-10-22" });
  verifier(r.ok && !(await etat()).config.planning.exceptions.some((x) => x.date === "2026-10-22"), "exception retirée");
  verifier((await app("pause", { du: "2026-10-30", au: "2026-10-25" })).ok === false, "pause à l'envers refusée");
  r = await app("pause", { du: "2026-10-26", au: "2026-10-30" });
  verifier(r.ok && r.donnees.planning.calendrier["2026-10-28"].pause === true, "pause ajoutée et visible au calendrier");
  r = await app("retirer_pause", { du: "2026-10-26" });
  verifier(r.ok && !(await etat()).config.planning.pauses.length, "pause retirée");
  r = await app("creuser", { sujet: "la réforme des retraites" });
  verifier(r.ok && r.donnees.reglages.a_approfondir.includes("la réforme des retraites"), "sujet à creuser");
  r = await app("retirer_creuser", { index: 0 });
  verifier(r.ok && !r.donnees.reglages.a_approfondir.includes("la réforme des retraites"), "sujet retiré");
  r = await app("annuler");
  verifier(r.ok && r.donnees.reglages.a_approfondir.includes("la réforme des retraites"), "annulation depuis l'application", r.erreur);
  await app("jour", { jour: "dim", heure: "07:30" });
  await app("jour", { jour: "sam", heure: "07:30" });
  await app("regler", { chemin: "format.duree_minutes", valeur: 5 });
});

await scenario("Application : épisodes, lecteur, gestes, texte", async () => {
  await horloge("2026-10-19T10:00");
  await deposer("2026-10/2026-10-19-071000.mp3", Buffer.from("OggS-faux-audio"));
  await evenement({ type: "episode", date: "2026-10-19", titre: "Lundi tranquille", ref: 71000, audio: "2026-10/2026-10-19-071000.mp3",
    sujets: ["Sujet A", "Sujet B"], chapitres: [[0, "Ouverture"], [30, "Actualités"]], transcription: "Léa : Bonjour !", mode: "planifie", duree: 15 });
  let r = await app("etat");
  const ep = r.donnees.episodes[0];
  verifier(ep?.titre === "Lundi tranquille" && ep.audio?.startsWith("/app/audio?") && ep.chapitres.length === 2 && ep.texte_dispo, "épisode avec lien audio signé", ep);
  let audio = await fetch(`${BOT}${ep.audio}`, { headers: { Range: "bytes=0-3" } });
  verifier(audio.status === 206 && (await audio.text()) === "OggS" && audio.headers.get("content-range") === "bytes 0-3/15", "lecture par morceaux (Range)", audio.status);
  audio = await fetch(`${BOT}${ep.audio}`);
  verifier(audio.status === 200 && (await audio.text()).length === 15, "lecture complète");
  verifier((await fetch(`${BOT}${ep.audio.replace(/s=[0-9a-f]+/, "s=deadbeef")}`)).status === 403, "lien audio falsifié refusé");
  verifier((await fetch(`${BOT}/app/audio?c=voix:Aoede&e=1&s=0`)).status === 403, "lien audio expiré refusé");
  r = await app("geste", { cle: ep.cle, geste: "up" });
  verifier(r.ok === false && !("avis" in (await app("etat")).donnees.episodes[0]), "plus d'avis j'aime / j'aime pas");
  const avant = (await etat()).config.format.duree_minutes;
  r = await app("geste", { cle: ep.cle, geste: "court" });
  verifier(r.ok && (await etat()).config.format.duree_minutes === avant - 1 && r.donnees.episodes[0].coches.includes("court"), "plus court", r.erreur);
  r = await app("geste", { cle: ep.cle, geste: "cr2" });
  verifier(r.ok && r.donnees.reglages.a_approfondir.includes("Sujet B"), "sujet à creuser depuis l'épisode");
  r = await app("texte", { cle: ep.cle });
  verifier(r.ok && r.texte === "Léa : Bonjour !", "texte de l'épisode");
  verifier((await app("geste", { cle: "ep:2020-01-01", geste: "court" })).ok === false, "épisode inconnu refusé");
  await app("regler", { chemin: "format.duree_minutes", valeur: avant });
});

await scenario("Application : demande libre, recherche, résultats", async () => {
  await horloge("2026-10-19T10:00");
  await gemini({ operations: [{ action: "regler", chemin: "voix.vitesse", valeur: "lente" }], reponse: "Je parlerai plus lentement." });
  await vider();
  let r = await app("parler", { texte: "parle plus lentement" });
  verifier(r.ok && r.reponse.includes("lentement") && r.changements.length === 1 && (await etat()).config.voix.vitesse === "lente", "demande comprise et appliquée", r);
  await gemini({ operations: [{ action: "afficher", valeur: "planning" }], reponse: "Voici le planning." });
  r = await app("parler", { texte: "montre le planning" });
  verifier(r.ok && r.ouvrir?.ecran === "planning", "demande d'affichage traduite en écran", r.ouvrir);
  await envoyerJson(`${FAUX}/control/gemini-panne`, { panne: true });
  r = await app("parler", { texte: "bonjour" });
  verifier(r.ok === false && r.erreur.includes("Gemini"), "Gemini en panne : message clair");
  await envoyerJson(`${FAUX}/control/gemini-panne`, { panne: false });
  r = await app("rubrique", { formulaire: { titre: "Sortie samedi", consigne: "Une activité en famille", periode: { type: "ponctuelle" }, sources: ["web", "lieux"],
    fiche: { quoi: "activité en famille", ou: "Yverdon" }, transport: "train", budget: { max: "20", unite: "personne" }, inclure: "piscine, musée" } });
  const id = r.id;
  let regle = (await etat()).config.regles.find((x) => x.id === id);
  verifier(r.ok && regle.periode.type === "ponctuelle" && regle.recherche.fiche.transport === "train" && regle.recherche.fiche.budget.max === 20
    && regle.recherche.fiche.inclure.join() === "piscine,musée" && !(await etat()).config.deroule.some((x) => x.cle === id), "recherche ponctuelle créée avec budget et transport", regle);
  await vider();
  r = await app("recherche", { id, format: "ecrit" });
  const liste = await appels();
  verifier(r.ok && lancements(liste).some((a) => a.workflow === "recherche.yml"), "recherche lancée", r);
  await envoyerJson(`${BOT}/api/evenement`, { type: "recherche", regles: [id], idees: ["Piscine"], resultats: [{ regle: id, titre: "Sortie samedi", intro: "Deux idées.",
    idees: [{ titre: "Piscine", resume: "Bassin couvert", lien: "javascript:alert(1)", prix: "8 CHF", dans_le_budget: true }, { titre: "" }] }] }, entetesApi);
  r = await app("etat");
  const det = r.donnees.resultats?.details?.[0];
  verifier(det?.idees.length === 1 && det.idees[0].titre === "Piscine" && det.idees[0].lien === "" && det.idees[0].dans_le_budget, "résultats gardés pour l'application (liens nettoyés)", det);
  await app("supprimer", { id });
  // Rubriques essentielles (menu « ··· » de leur fiche) : « Chercher maintenant » = point écrit, « Mini-podcast » = point audio.
  const quotaAvant = (await etat()).etat;
  await vider();
  r = await app("recherche", { id: "actualites", format: "ecrit" });
  let essentielles = lancements(await appels()).filter((a) => a.workflow === "recherche.yml");
  verifier(r.ok && essentielles.length === 1 && essentielles[0].entrees.regles === "actualites" && essentielles[0].entrees.format === "ecrit",
    "essentielle : chercher maintenant → point écrit", essentielles);
  await vider();
  r = await app("recherche", { id: "agenda", format: "audio" });
  essentielles = lancements(await appels()).filter((a) => a.workflow === "recherche.yml");
  verifier(r.ok && essentielles.length === 1 && essentielles[0].entrees.regles === "agenda" && essentielles[0].entrees.format === "point",
    "essentielle : mini-podcast → point audio", essentielles);
  verifier((await app("recherche", { id: "ouverture", format: "ecrit" })).ok === false, "ouverture : pas de recherche");
  const sourcePodcast = readFileSync(new URL("../../podcast.py", import.meta.url), "utf8");
  const clesPython = ((/RUBRIQUES_ESSENTIELLES = \(([^)]*)\)/.exec(sourcePodcast) || [, ""])[1]).split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
  verifier(JSON.stringify(clesPython) === JSON.stringify(RUBRIQUES_A_CHERCHER), "rubriques essentielles : mêmes clés que podcast.py", { clesPython, js: RUBRIQUES_A_CHERCHER });
  await envoyerJson(`${BOT}/api/evenement`, { type: "recherche", regles: ["approfondissements"], idees: [], format: "ecrit", resultats: [{ regle: "approfondissements", titre: "À creuser",
    intro: "x".repeat(900), conseil: "", idees: [], sources: [{ titre: "Le Temps", lien: "https://www.letemps.ch/a" }, { titre: "piège", lien: "javascript:alert(1)" }] }] }, entetesApi);
  r = await app("etat");
  const detEss = r.donnees.resultats?.details?.[0];
  verifier(detEss?.regle === "approfondissements" && detEss.intro.length === 900 && detEss.sources.length === 1 && r.donnees.resultats.format === "ecrit",
    "point écrit d'une essentielle gardé (nom long, texte long, liens nettoyés)", detEss);
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, refaits: quotaAvant.refaits, recherches: quotaAvant.recherches } });
  await app("regler", { chemin: "voix.vitesse", valeur: "normale" });
});

await scenario("Application : adresse transmise à GitHub", async () => {
  const courant = (await etat()).etat;
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...courant, adresse: "https://podcast.exemple.workers.dev" } }) });
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.app === "https://podcast.exemple.workers.dev/app", "adresse de l'application transmise à GitHub", exp.app);
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...(await etat()).etat, adresse: courant.adresse } }) });
});

await scenario("Application : épisodes d'avant, sources, extraits par voix", async () => {
  await horloge("2026-10-20T08:00");
  await evenement({ type: "episode", date: "2026-10-20", titre: "Mardi", ref: 51510, mode: "planifie",
    sources: [{ titre: "Article A", url: "https://exemple.ch/a" }, { titre: "Piège", url: "javascript:alert(1)" }] });
  // Un épisode d'avant que le bot garde les fichiers : listé, sans audio.
  const courant = (await etat()).etat;
  courant.episodes.push({ date: "2026-10-20", titre: "Ancien format", message_id: 6161, file_id: "VIEUX", sujets: [], coches: [], chapitres: [] });
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: courant }) });
  let r = await app("etat");
  const neuf = r.donnees.episodes.find((x) => x.titre === "Mardi");
  verifier(neuf?.sources.length === 1 && neuf.sources[0].url === "https://exemple.ch/a", "sources de l'épisode (adresses https seulement)", neuf?.sources);
  const ancien = r.donnees.episodes.find((x) => x.titre === "Ancien format");
  verifier(ancien && ancien.cle === "ep:2026-10-20:6161" && !ancien.audio, "épisode d'avant : listé (même clé), sans audio", ancien);
  await evenement({ type: "echantillon", voix: "Kore", fichier: "voix/Kore-Puck-2.mp3", debut: 4.2, fin: 8.9 });
  r = await app("etat");
  verifier(r.donnees.reglages.temps_echantillons.Kore?.join() === "4.2,8.9" && r.donnees.reglages.echantillons.Kore?.startsWith("/app/audio?"), "extrait : début et fin de la voix", r.donnees.reglages.temps_echantillons);
  await vider();
  r = await app("extraits");
  const lance = lancements(await appels()).find((a) => a.workflow === "echantillons.yml");
  verifier(r.ok && lance && !lance.entrees.voix.split(",").includes("Kore") && lance.entrees.voix.split(",").length === 7, "seules les voix sans extrait séparé sont préparées", lance?.entrees);
});

await scenario("Application : demande vocale comprise, confirmation, historique, catalogue partagé", async () => {
  const sauvegarde = (await etat()).config;
  const tous = Object.fromEntries(["lun", "mar", "mer", "jeu", "ven", "sam", "dim"].map((j) => [j, "07:30"]));
  await envoyerJson(`${BOT}/test/etat`, { config: { ...sauvegarde, planning: { ...sauvegarde.planning, jours: tous } } });
  let r = await app("etat");
  const meteo = r.donnees.modeles?.find((m) => m.id === "meteo");
  verifier(r.donnees.modeles?.length === 9 && meteo?.f?.place === "ouverture" && meteo.f.longueur === "phrase", "catalogue fourni par le bot", r.donnees.modeles?.map((m) => m.id));
  const categories = r.donnees.categories_rubriques?.map((c) => c.id);
  verifier(categories?.join() === "basiques,journees,alertes,actus,guide,libre" && r.donnees.modeles.every((m) => categories.includes(m.categorie)),
    "catalogue rangé par catégories, chaque modèle dans une catégorie", { categories, modeles: r.donnees.modeles.map((m) => [m.id, m.categorie]) });
  verifier(r.donnees.modeles.find((m) => m.id === "journee")?.titre === "Journée mondiale" && r.donnees.modeles.some((m) => m.id === "actu_pays") && r.donnees.modeles.some((m) => m.id === "actu_theme"),
    "journée mondiale ; actu d'un pays et d'un thème séparées");
  const wav = Buffer.from("RIFF0000WAVEfmt faux").toString("base64");
  await gemini({ entendu: "plus d'épisode du lundi au jeudi", operations: [{ action: "horaire", jours: ["lun", "mar", "mer", "jeu"], heure: "aucun" }], reponse: "C'est fait." });
  r = await app("parler", { audio: wav });
  verifier(r.ok && r.entendu === "plus d'épisode du lundi au jeudi" && r.vocal && r.a_confirmer.length === 1 && r.message_compris?.confirmer
    && r.donnees.planning.jours.lun !== null && !r.message_compris.note, "vocal : transcription, confirmation demandée, rien d'appliqué", r.message_compris);
  verifier(r.donnees.demandes?.[0]?.issue === "attente" && r.donnees.demandes[0].vocal && r.donnees.demandes[0].message.includes("lundi au jeudi"), "demande en attente dans l'historique", r.donnees.demandes?.[0]);
  r = await app("parler_confirmer");
  verifier(r.ok && ["lun", "mar", "mer", "jeu"].every((j) => r.donnees.planning.jours[j] === null) && r.message_compris?.titre.includes("C'est fait"), "confirmé : appliqué", r.message_compris);
  verifier(r.donnees.demandes[0].issue === "confirme" && r.donnees.demandes[0].changements.length === 1 && r.donnees.demandes[0].operations.includes("aucun"), "historique : une seule ligne, confirmée", r.donnees.demandes.slice(0, 2));
  r = await app("parler_abandonner");
  verifier(r.ok === false && r.erreur.includes("plus en attente"), "rien en attente : refus clair", r.erreur);
  // Non : rien ne change.
  const joursAvant = JSON.stringify((await etat()).config.planning.jours);
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"], heure: "aucun" }], reponse: "" });
  r = await app("parler", { texte: "aucun épisode" });
  verifier(r.ok && r.message_compris?.confirmer, "tout couper : à confirmer", r.message_compris);
  r = await app("parler_abandonner");
  verifier(r.ok && r.abandon && JSON.stringify(r.donnees.planning.jours) === joursAvant && r.donnees.demandes[0].issue === "abandonne", "« Non » : rien ne change", r.donnees.demandes[0]);
  // Une rubrique demandée par écrit passe par le même formulaire que la fiche.
  await gemini({ entendu: "", operations: [{ action: "nouvelle_regle", regle: { modele: "actu_theme", titre: "Actu vélo", consigne: "Les nouvelles importantes du vélo." } }], reponse: "" });
  r = await app("parler", { texte: "les nouvelles du vélo" });
  const velo = r.donnees.regles.find((x) => x.titre === "Actu vélo");
  verifier(r.ok && velo && velo.sources.join() === "actus" && velo.place === "actualites" && r.ouvrir?.id === velo.id, "rubrique du catalogue créée et ouverte", velo);
  await envoyerJson(`${BOT}/test/etat`, { config: sauvegarde });
});

await scenario("Application : miniatures, sources par section, historique, demande vocale", async () => {
  await horloge("2026-10-21T08:00");
  await deposer("2026-10/2026-10-21-071700.mp3", Buffer.from("ID3-faux-audio"));
  await deposer("2026-10/2026-10-21-071700.jpg", new Uint8Array([0xff, 0xd8, 0xff, 7]));
  await evenement({ type: "episode", date: "2026-10-21", titre: "Mercredi", ref: 71700, audio: "2026-10/2026-10-21-071700.mp3", pochette: "2026-10/2026-10-21-071700.jpg",
    transcription: "Hugo : Bonjour !", mode: "planifie",
    sources: [{ section: "Actualités", titre: "Article", url: "https://exemple.ch/1" }, { section: "Actu locale", titre: "Yverdon", url: "https://exemple.ch/2" }] });
  let r = await app("etat");
  const ep = r.donnees.episodes.find((x) => x.titre === "Mercredi");
  verifier(ep?.image?.startsWith("/app/audio?c=img%3A") && ep.sources.map((x) => x.section).join() === "Actualités,Actu locale", "miniature et sources rangées par section", ep);
  const image = await fetch(`${BOT}${ep.image}`);
  verifier(image.status === 200 && image.headers.get("content-type") === "image/jpeg", "la miniature est servie comme image", image.status);
  verifier(!JSON.stringify((await etat()).etat.episodes).includes("Hugo : Bonjour"), "le texte de l'épisode est rangé à part");
  r = await app("texte", { cle: ep.cle });
  verifier(r.ok && r.texte === "Hugo : Bonjour !", "texte toujours lisible");
  for (let i = 1; i <= 9; i++) {
    await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: `2026-09-${String(i).padStart(2, "0")}`, titre: `Septembre ${i}`, ref: 70000 + i, mode: "planifie" }, entetesApi);
  }
  r = await app("etat");
  verifier(r.donnees.episodes.length > 7 && r.donnees.episodes.some((x) => x.titre === "Septembre 1"), "historique de plus de 7 épisodes", r.donnees.episodes.length);
  await gemini({ operations: [{ action: "regler", chemin: "format.duree_minutes", valeur: 4 }], reponse: "Quatre minutes, noté." });
  await vider();
  const wav = Buffer.from("RIFF0000WAVEfmt faux").toString("base64");
  r = await app("parler", { audio: wav });
  const envoi = (await appels()).find((a) => a.service === "gemini");
  verifier(r.ok && r.reponse.includes("Quatre") && JSON.stringify(envoi?.corps || "").includes("audio/wav"), "demande vocale transmise à Gemini", envoi?.corps?.input?.map?.((c) => c.type));
  verifier((await app("parler", { audio: "pas du base64 !" })).ok === false, "audio invalide refusé");
  await app("regler", { chemin: "format.duree_minutes", valeur: 5 });
});

await scenario("Application : voix (prénoms, voix utilisées, jours, tirage, une voix), fériés, agenda", async () => {
  await horloge("2026-10-20T08:00");                       // mardi
  const apiConfig = async () => (await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json()).config;
  await app("regler", { chemin: "voix.animateurs.0.voix", valeur: "Aoede" });
  let r = await app("regler", { chemin: "voix.animateurs.1.voix", valeur: "hugo" });
  verifier(r.ok && r.donnees.reglages.voix.animateurs.map((a) => `${a.nom}/${a.voix}`).join() === "Léa/Aoede,Hugo/Puck", "habituels choisis par la voix ou par son prénom", r.donnees.reglages.voix.animateurs);
  r = await app("regler", { chemin: "voix.animateurs.0.voix", valeur: "Puck" });
  verifier(r.ok && r.donnees.reglages.voix.animateurs.map((a) => a.voix).join() === "Puck,Aoede", "choisir l'autre habituel les échange");
  await app("regler", { chemin: "voix.animateurs.0.voix", valeur: "Aoede" });
  // Chaque voix est un animateur possible, sous son nom tant qu'on ne la renomme pas.
  r = await app("etat");
  verifier(r.donnees.reglages.voix.inactives.length === 0 && r.donnees.listes.voix.length === 30 && !r.donnees.reglages.voix.noms.Kore, "toutes les voix utilisées, sous leur nom", r.donnees.reglages.voix);
  r = await app("nom_voix", { voix: "Charon", nom: "  Sam " });
  verifier(r.ok && r.donnees.reglages.voix.noms.Charon === "Sam" && r.message === "Charon s'appelle Sam", "prénom donné à une voix", r.erreur || r.message);
  await app("nom_voix", { voix: "Kore", nom: "Iris" });
  verifier((await app("nom_voix", { voix: "Leda", nom: "léa" })).ok === false, "prénom déjà pris refusé");
  verifier((await app("nom_voix", { voix: "Leda", nom: "Puck" })).erreur?.includes("autre voix"), "nom d'une autre voix refusé");
  verifier((await app("nom_voix", { voix: "Inconnue", nom: "Zoé" })).ok === false, "voix inconnue refusée");
  r = await app("nom_voix", { voix: "Aoede", nom: "Léonie" });
  verifier(r.ok && r.donnees.reglages.voix.animateurs[0].nom === "Léonie" && (await apiConfig()).voix.animateurs[0].nom === "Léonie", "renommer la voix d'un habituel renomme l'animateur");
  r = await app("nom_voix", { voix: "Aoede", nom: "" });
  verifier(r.ok && r.donnees.reglages.voix.animateurs[0].nom === "Aoede" && r.message === "Aoede reprend son nom", "prénom effacé : la voix reprend son nom");
  await app("nom_voix", { voix: "Aoede", nom: "Léa" });
  // Voix utilisées ou non.
  r = await app("voix_active", { voix: "Aoede", active: false });
  verifier(r.ok === false && r.erreur.includes("habituels"), "un animateur habituel reste utilisé", r.erreur);
  r = await app("voix_active", { voix: "Zephyr", active: false });
  verifier(r.ok && r.donnees.reglages.voix.inactives.join() === "Zephyr", "voix désactivée", r.donnees.reglages.voix.inactives);
  // Selon le jour : deux listes par jour, les habituels aux places vides.
  await app("regler", { chemin: "voix.mode", valeur: "jours" });
  r = await app("voix_jour", { jour: "mar", voix: ["Kore", "Charon"] });
  verifier(r.ok && (await apiConfig()).voix.animateurs.map((a) => a.nom).join() === "Iris,Sam", "mardi : Iris et Sam pour GitHub", r.erreur);
  verifier(r.donnees.reglages.voix.jours.mer.join() === "Aoede,Puck" && r.donnees.reglages.voix.jours.mar.join() === "Kore,Charon", "les autres jours : les habituels", r.donnees.reglages.voix.jours);
  r = await app("voix_jour", { jour: "mer", voix: ["", "Kore"] });
  verifier(r.ok && r.donnees.reglages.voix.jours.mer.join() === "Aoede,Kore", "une place vide : l'habituel", r.donnees.reglages.voix.jours.mer);
  r = await app("voix_active", { voix: "Charon", active: false });
  verifier(r.ok && (await apiConfig()).voix.animateurs.map((a) => a.nom).join() === "Iris,Léa", "voix désactivée : son jour revient à l'habituel", r.donnees.reglages.voix.jours.mar);
  await app("voix_active", { voix: "Charon", active: true });
  await app("voix_jour", { jour: "mar", voix: ["Kore", "Charon"] });
  await app("regler", { chemin: "voix.solo", valeur: true });
  let exp = await apiConfig();
  verifier(exp.voix.animateurs.length === 1 && exp.voix.animateurs[0].nom === "Iris", "une seule voix : un animateur envoyé", exp.voix.animateurs);
  await app("regler", { chemin: "voix.solo", valeur: false });
  // Au hasard : parmi les voix utilisées seulement, le même tirage toute la journée.
  await app("voix_active", { voix: "Zephyr", active: true });
  const autres = (await app("etat")).donnees.listes.voix.map((x) => x.nom).filter((x) => !["Aoede", "Puck", "Kore", "Charon"].includes(x));
  for (const voix of autres) await app("voix_active", { voix, active: false });
  await app("regler", { chemin: "voix.mode", valeur: "aleatoire" });
  const tirages = new Set();
  for (const jour of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]) {
    await horloge(`${jour}T08:00`);
    const noms = (await apiConfig()).voix.animateurs.map((a) => a.voix);
    noms.forEach((n) => tirages.add(n));
    verifier(noms.length === 2 && noms[0] !== noms[1] && noms.every((n) => ["Aoede", "Puck", "Kore", "Charon"].includes(n)), `tirage du ${jour} parmi les voix utilisées`, noms);
  }
  const encore = (await apiConfig()).voix.animateurs.map((a) => a.voix).join();
  verifier(encore === (await apiConfig()).voix.animateurs.map((a) => a.voix).join() && tirages.size > 2, "tirage stable pour la journée, varié d'un jour à l'autre", [...tirages]);
  await horloge("2026-10-20T08:00");
  verifier((await etat()).config.voix.animateurs.map((a) => a.nom).join() === "Léa,Hugo", "les animateurs habituels ne changent pas");
  // Par la conversation : même chemin que l'application.
  await gemini({ entendu: "", operations: [{ action: "nommer_voix", id: "Iris", valeur: "Inès" }, { action: "voix_jour", jours: ["ven"], ids: ["Inès", "Hugo"] },
    { action: "activer_voix", id: "Zephyr" }], reponse: "" });
  r = await app("parler", { texte: "Iris s'appelle Inès, et le vendredi c'est Inès et Hugo" });
  const v = r.donnees.reglages.voix;
  verifier(r.ok && v.noms.Kore === "Inès" && v.mode === "jours" && v.jours.ven.join() === "Kore,Puck" && !v.inactives.includes("Zephyr"), "demande libre : prénom, jour, voix réactivée", { v, erreurs: r.erreurs });
  await gemini({ entendu: "", operations: [{ action: "desactiver_voix", id: "Léa" }], reponse: "" });
  r = await app("parler", { texte: "je ne veux plus entendre Léa" });
  verifier(r.donnees.reglages.voix.inactives.includes("Aoede") === false && JSON.stringify(r).includes("habituels"), "demande libre : un habituel n'est pas désactivé", r.erreurs || r.message_compris);
  // Les anciens réglages (prénom + voix, équipe, tirage) passent aux voix.
  const avant = (await etat()).config;
  await envoyerJson(`${BOT}/test/etat`, { config: { ...avant, voix: { vitesse: "normale", tutoiement: true, prenom: "", solo: false, mode: "aleatoire",
    animateurs: [{ nom: "Léa", voix: "Aoede" }, { nom: "Hugo", voix: "Puck" }], equipe: [{ nom: "Sam", voix: "Charon" }, { nom: "Iris", voix: "Kore" }, { nom: "Kore", voix: "Leda" }],
    jours: { mar: ["Iris", "Sam"], mer: ["Personne"] }, tirage: ["Sam", "Iris"] } } });
  const migre = (await app("etat")).donnees.reglages.voix;
  verifier(migre.noms.Charon === "Sam" && migre.noms.Kore === "Iris" && !migre.noms.Leda && migre.noms.Aoede === "Léa", "anciens animateurs : prénoms passés aux voix", migre.noms);
  verifier(migre.jours.mar.join() === "Kore,Charon" && migre.jours.mer.join() === "Aoede,Puck", "anciens jours : par voix", migre.jours);
  verifier(migre.inactives.length === 26 && !migre.inactives.includes("Kore") && !migre.inactives.includes("Aoede"), "ancien tirage : ses voix (et les habituels) restent utilisées", migre.inactives);
  await envoyerJson(`${BOT}/test/etat`, { config: { ...avant, voix: { ...avant.voix, mode: "fixe", inactives: [], jours: {} } } });
  // Jours fériés de France (liste téléchargée), puis retour à Vaud.
  await vider();
  r = await app("feries", { region: "FR" });
  ({ config: exp } = await etat());
  verifier(r.ok && exp.planning.feries_region === "FR" && !Object.keys(exp.planning.feries_cache).length
    && r.donnees.planning.calendrier["2026-11-11"].ferie && r.donnees.planning.calendrier["2026-11-11"].ferie_nom === "Armistice 1918", "fériés français (calculés, sans téléchargement)", exp.planning);
  r = await app("feries", { region: "CH-NE" });
  ({ config: exp } = await etat());
  verifier(exp.planning.feries_cache["2027"]?.some(([d]) => d === "2027-03-01"), "fériés neuchâtelois (cantonal compris)", exp.planning.feries_cache);
  verifier((await app("feries", { region: "XX" })).ok === false, "région inconnue refusée");
  r = await app("feries", { region: "CH-VD" });
  verifier(r.ok && !Object.keys((await etat()).config.planning.feries_cache).length, "retour aux fériés vaudois");
  // Extraits : n'importe quelle voix, 16 par jour.
  const e = (await etat()).etat;
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...e, extraits_jour: null } }) });
  await vider();
  r = await app("extraits", { voix: ["Zephyr", "Orus", "Inconnue"] });
  const lance = lancements(await appels()).find((a) => a.workflow === "echantillons.yml");
  verifier(r.ok && lance?.entrees.voix === "Zephyr,Orus", "extraits de voix choisies", lance?.entrees);
  const e2 = (await etat()).etat;
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...e2, extraits_jour: { date: "2026-10-20", nombre: 15 } } }) });
  verifier((await app("extraits", { voix: ["Leda", "Puck"] })).ok === false, "limite de 16 extraits par jour");
  // Aperçu de l'agenda (agendas exclus masqués).
  await envoyerJson(`${BOT}/api/evenement`, { type: "agendas", liste: [{ id: "aaaa111111", nom: "Perso", nb: 2 }, { id: "bbbb222222", nom: "Travail", nb: 1 }],
    evenements: [{ agenda: "aaaa111111", titre: "Dentiste", debut: "2026-10-21T09:00+02:00", journee: false },
                 { agenda: "bbbb222222", titre: "Réunion", debut: "2026-10-21T14:00+02:00", journee: false }] }, entetesApi);
  await envoyerJson(`${BOT}/test/etat`, { config: { ...(await etat()).config, agenda: { ...(await etat()).config.agenda, exclus: ["bbbb222222"] } } });
  r = await app("etat");
  verifier(r.donnees.agenda_apercu.map((x) => x.titre).join() === "Dentiste" && r.donnees.agenda_lu, "aperçu de l'agenda (agenda ignoré masqué)", r.donnees.agenda_apercu);
  // Rubrique : pas de transport, budget en euros.
  r = await app("rubrique", { formulaire: { titre: "Soirée jeux", consigne: "Idées de jeux", periode: { type: "ponctuelle" }, sources: ["web"], fiche: { quoi: "jeux de société" },
    transport: "aucun", budget: { max: "30", devise: "EUR", transport_inclus: true }, inclure: ["coopératif", "rapide"] } });
  const regle = (await etat()).config.regles.find((x) => x.id === r.id);
  verifier(r.ok && regle.recherche.fiche.transport === "aucun" && regle.recherche.fiche.budget.devise === "EUR" && regle.recherche.fiche.budget.transport_inclus === false
    && regle.recherche.fiche.inclure.join() === "coopératif,rapide", "pas de transport, budget en euros, éléments à inclure", regle.recherche.fiche);
  await app("supprimer", { id: r.id });
});

await scenario("Rubriques : anciens formulaires « sources choisies par l'application », place, pause", async () => {
  let r = await app("rubrique", { formulaire: { titre: "Fête du prénom", consigne: "Dis-moi quels prénoms on fête aujourd'hui.", longueur: "phrase",
    periode: { type: "toujours" }, sources_auto: true, place: "ouverture" } });
  let regle = (await etat()).config.regles.find((x) => x.id === r.id);
  let { config } = await etat();
  verifier(r.ok && regle.recherche.sources.join() === "saints" && !("sources_auto" in regle.recherche), "fête du prénom : calendrier des saints choisi, rendu explicite", regle.recherche);
  verifier(config.deroule[config.deroule.findIndex((x) => x.cle === "ouverture") + 1]?.cle === r.id, "placée après l'ouverture", config.deroule.map((x) => x.cle));
  const prenom = r.id;
  r = await app("rubrique", { formulaire: { titre: "Rappel piscine", consigne: "Rappelle-moi de prendre mon maillot.", longueur: "phrase",
    periode: { type: "toujours" }, sources_auto: true, place: "agenda", condition: { texte: "piscine", moment: "veille" } } });
  regle = (await etat()).config.regles.find((x) => x.id === r.id);
  verifier(r.ok && regle.recherche.sources.join() === "agenda" && regle.condition.texte === "piscine", "rappel selon l'agenda : lit l'agenda", regle);
  r = await app("rubrique", { formulaire: { titre: "Météo", consigne: "La météo du jour : pluie, températures.", longueur: "phrase",
    periode: { type: "toujours" }, sources_auto: true } });
  regle = (await etat()).config.regles.find((x) => x.id === r.id);
  verifier(regle.recherche.sources.join() === "meteo", "météo : source météo", regle.recherche.sources);
  // Un seul interrupteur : la rubrique et son passage se mettent en pause ensemble.
  r = await app("etat_rubrique", { id: prenom, active: false });
  ({ config } = await etat());
  verifier(r.ok && config.regles.find((x) => x.id === prenom).etat === "pause" && config.deroule.find((x) => x.cle === prenom).actif === false, "pause d'une rubrique et de son passage");
  r = await app("etat_rubrique", { id: prenom, active: true });
  ({ config } = await etat());
  verifier(config.regles.find((x) => x.id === prenom).etat === "active" && config.deroule.find((x) => x.cle === prenom).actif === true, "reprise d'une rubrique");
  verifier((await app("etat_rubrique", { id: "R99", active: true })).ok === false, "rubrique inconnue refusée");
  for (const id of [...config.regles].reverse().slice(0, 3).map((x) => x.id)) await app("supprimer", { id });
});

await scenario("Connexions : clés et agendas saisis dans l'application", async () => {
  let r = await app("etat");
  verifier(r.donnees.connexions.cles.gemini.source === "inconnue" && r.donnees.connexions.cles.tavily.lien.includes("tavily"), "état initial des connexions", r.donnees.connexions.cles.gemini);
  // GitHub signale ses secrets (les noms seulement).
  await envoyerJson(`${BOT}/api/evenement`, { type: "secrets", presents: ["GEMINI_API_KEY", "CALENDAR_ICS_URL"] }, { "X-Podcast-Secret": SECRET });
  r = await app("etat");
  verifier(r.donnees.connexions.cles.gemini.source === "github" && r.donnees.connexions.cles.tavily.source === "absente" && r.donnees.connexions.agendas_github, "secrets GitHub reconnus", r.donnees.connexions);
  verifier((await app("cle", { nom: "gemini", valeur: "mauvaise" })).ok === false, "clé Gemini refusée : pas enregistrée");
  r = await app("cle", { nom: "gemini", valeur: "bonne-cle" });
  verifier(r.ok && r.donnees.connexions.cles.gemini.source === "app" && r.donnees.connexions.cles.gemini.fin === "-cle" && !JSON.stringify(r.donnees).includes("bonne-cle"),
    "clé Gemini testée, enregistrée, jamais renvoyée en entier", r.donnees.connexions.cles.gemini);
  await vider();
  r = await app("cle", { nom: "tavily", valeur: "tvly-bonne" });
  verifier(r.ok && r.message.includes("encore 812 crédits sur 1\u202f000") && !appelsTavilySearch(await appels()), "clé Tavily : crédits restants, sans consommer de recherche", r.message);
  verifier((await app("cle", { nom: "inconnue", valeur: "x" })).ok === false, "clé inconnue refusée");
  // Agendas : un lien iCal lu, nommé et identifié comme le fait GitHub.
  verifier((await app("agenda_ajouter", { url: `${FAUX}/ics/pas-un-agenda` })).ok === false, "une page qui n'est pas un agenda est refusée");
  await vider();
  r = await app("agenda_ajouter", { url: `${FAUX}/ics/perso.ics` });
  const ajoute = r.donnees?.connexions?.agendas?.[0];
  verifier(r.ok && ajoute?.nom === "Famille" && ajoute?.nb === 2 && /^[0-9a-f]{10}$/.test(ajoute.id), "agenda ajouté et nommé", r);
  verifier(lancements(await appels()).some((a) => a.workflow === "agendas.yml"), "relecture des agendas lancée");
  // GitHub reçoit les clés et les liens au début de chaque lancement (et l'app jamais).
  const exp = await (await fetch(`${BOT}/api/config`, { headers: { "X-Podcast-Secret": SECRET } })).json();
  verifier(exp.cles.gemini === "bonne-cle" && exp.cles.tavily === "tvly-bonne" && !exp.cles.sncf && exp.agendas_urls[0] === `${FAUX}/ics/perso.ics`, "clés et agendas pour GitHub", { cles: Object.keys(exp.cles), agendas: exp.agendas_urls });
  // Gemini du bot : la clé de l'application est utilisée.
  await vider();
  await gemini({ reponse: "D'accord.", operations: [] });
  await app("parler", { texte: "bonjour" });
  const appelGemini = (await appels()).find((a) => a.service === "gemini" && a.corps);
  verifier(Boolean(appelGemini), "le bot comprend toujours les demandes");
  // Retirer.
  r = await app("agenda_retirer", { id: ajoute.id });
  verifier(r.ok && !r.donnees.connexions.agendas.length, "agenda retiré");
  // Un agenda qui vient du secret GitHub se retire aussi (il n'est plus lu) et se remet.
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, agendas: [{ id: "abc123", nom: "Famille", nb: 4 }, { id: "def456", nom: "Travail", nb: 9 }] } });
  r = await app("agenda_retirer", { id: "abc123" });
  let cfg = (await etat()).config;
  verifier(r.ok && cfg.agenda.retires.includes("abc123") && cfg.agenda.exclus.includes("abc123")
    && !r.donnees.reglages.agendas.some((a) => a.id === "abc123") && r.donnees.reglages.agendas_retires.some((a) => a.id === "abc123"),
    "agenda du secret GitHub retiré : ignoré et rangé dans les retirés", cfg.agenda);
  r = await app("agenda_remettre", { id: "abc123" });
  cfg = (await etat()).config;
  verifier(r.ok && !cfg.agenda.retires.includes("abc123") && !cfg.agenda.exclus.includes("abc123") && r.donnees.reglages.agendas.some((a) => a.id === "abc123"),
    "agenda remis : relu", cfg.agenda);
  verifier((await app("agenda_retirer", { id: "inconnu" })).ok === false, "agenda inconnu refusé");
  r = await app("cle", { nom: "gemini", valeur: "" });
  verifier(r.ok && r.donnees.connexions.cles.gemini.source === "github", "clé retirée : retour au secret GitHub");
  await app("cle", { nom: "tavily", valeur: "" });
  // Premier lancement : proposé tant que rien de personnel n'est réglé.
  const sauve = (await etat()).config;
  await envoyerJson(`${BOT}/test/etat`, { config: { pays: "CH" } });
  r = await app("etat");
  verifier(r.donnees.bienvenue === true, "premier lancement proposé à une installation neuve");
  const basiques = ["agenda", "deplacements", "actu_locale", "approfondissements", "actualites"];
  verifier(basiques.every((cle) => r.donnees.deroule.find((x) => x.cle === cle)?.actif === true), "installation neuve : les rubriques de base sont actives", r.donnees.deroule);
  r = await app("bienvenue_fin");
  verifier(r.ok && r.donnees.bienvenue === false, "premier lancement terminé");
  await envoyerJson(`${BOT}/test/etat`, { config: sauve });
});

await scenario("Connexions : tester une clé déjà enregistrée (application ou GitHub)", async () => {
  // Les modèles annoncés par le test de la clé Gemini sont bien ceux du podcast.
  const podcast = readFileSync(new URL("../../podcast.py", import.meta.url), "utf8");
  const liste = (cle) => JSON.parse((new RegExp(`"${cle}": (\\[[^\\]]*\\])`).exec(podcast) || [, "[]"])[1]);
  const tonsPy = [...(/^TONS = \{([\s\S]*?)^\}/m.exec(podcast) || [, ""])[1].matchAll(/^    "([a-z_]+)":/gm)].map((m) => m[1]);
  verifier(JSON.stringify(tonsPy) === JSON.stringify(Object.keys(TONS)) && Object.keys(TONS).every((t) => DESCRIPTIONS_TONS[t]),
    "tons du bot = ceux de podcast.py, chacun décrit", { tonsPy, bot: Object.keys(TONS) });
  verifier(JSON.stringify(liste("modeles_texte")) === JSON.stringify(MODELES_PODCAST.texte) && JSON.stringify(liste("modeles_voix")) === JSON.stringify(MODELES_PODCAST.voix),
    "modèles du test Gemini = ceux de podcast.py", { texte: liste("modeles_texte"), voix: liste("modeles_voix") });
  // Gemini dans l'application : le bot la teste et liste les modèles.
  await app("cle", { nom: "gemini", valeur: "bonne-cle" });
  await app("cle", { nom: "tavily", valeur: "tvly-bonne" });
  let r = await app("cle_tester", { nom: "gemini" });
  verifier(r.ok && r.message.includes("4 modèles Gemini disponibles") && r.message.includes("gemini-3.8-flash ✓") && r.message.includes("gemini-3.8-flash-lite-tts ✗"),
    "Gemini : modèles du podcast vérifiés", r.message);
  verifier(r.donnees.connexions.cles.gemini.test?.ok && r.donnees.connexions.cles.gemini.test.ou === "app", "résultat gardé pour la carte", r.donnees.connexions.cles.gemini.test);
  // Tavily dans l'application : crédits restants, sans recherche consommée.
  await vider();
  r = await app("cle_tester", { nom: "tavily" });
  verifier(r.ok && r.message.includes("encore 812 crédits") && r.message.includes("Researcher") && !appelsTavilySearch(await appels()), "Tavily : crédits restants", r.message);
  // SNCF rangée dans GitHub : le bot ne la voit pas, il lance tester-cles.yml.
  await envoyerJson(`${BOT}/api/evenement`, { type: "secrets", presents: ["GEMINI_API_KEY", "SNCF_API_KEY"] }, { "X-Podcast-Secret": SECRET });
  await vider();
  r = await app("cle_tester", { nom: "sncf" });
  verifier(r.ok && r.attendre_test && r.donnees.connexions.cles.sncf.test?.en_cours, "SNCF dans GitHub : test lancé là-bas", r.donnees?.connexions?.cles?.sncf);
  verifier(lancements(await appels()).some((a) => a.workflow === "tester-cles.yml" && a.entrees?.cles === "sncf"), "tester-cles.yml lancé pour la SNCF", lancements(await appels()));
  // Le workflow teste (même code que le bot) et renvoie le résultat ; la clé n'est jamais écrite.
  const sortie = execFileSync("node", ["tester-cles.mjs"], { encoding: "utf8",
    env: { ...process.env, CLES: "sncf", SNCF_API_KEY: "sncf-bonne", SNCF_API: `${FAUX}/sncf`, BOT_URL: BOT, BOT_GITHUB_TOKEN: "gh-test", GITHUB_STEP_SUMMARY: "" } });
  verifier(!sortie.includes("sncf-bonne") && sortie.includes("15 décembre 2026"), "tester-cles.mjs : résultat sans la clé", sortie);
  r = await app("etat");
  const sncf = r.donnees.connexions.cles.sncf.test;
  verifier(sncf?.ok && sncf.message.includes("15 décembre 2026") && sncf.ou === "github" && !sncf.en_cours, "résultat GitHub affiché sur la carte", sncf);
  // Clé absente partout : rien à tester.
  await envoyerJson(`${BOT}/api/evenement`, { type: "secrets", presents: ["GEMINI_API_KEY"] }, { "X-Podcast-Secret": SECRET });
  r = await app("cle_tester", { nom: "sncf" });
  verifier(r.ok === false && r.erreur.includes("Aucune clé SNCF"), "clé absente : rien à tester", r.erreur);
  await app("cle", { nom: "gemini", valeur: "" });
  await app("cle", { nom: "tavily", valeur: "" });
});

await scenario("Connexions : l'encart vert d'un test réussi s'efface", async () => {
  await horloge("2026-10-20T10:00");
  await app("cle", { nom: "gemini", valeur: "bonne-cle" });
  let r = await app("cle_tester", { nom: "gemini" });
  verifier(r.donnees.connexions.cles.gemini.test?.ok, "test réussi : encart vert", r.donnees.connexions.cles.gemini.test);
  await horloge("2026-10-20T20:00");
  verifier((await app("etat")).donnees.connexions.cles.gemini.test?.ok, "toujours là le soir même");
  await horloge("2026-10-21T10:30");
  verifier((await app("etat")).donnees.connexions.cles.gemini.test === null, "le lendemain : effacé");
  await horloge("2026-10-21T11:00");
  r = await app("cle_tester", { nom: "gemini" });
  verifier(r.donnees.connexions.cles.gemini.test?.ok, "nouveau test : encart vert");
  await evenement({ type: "episode", date: "2026-10-21", titre: "Après le test", ref: 110000, mode: "manuel" });
  verifier((await app("etat")).donnees.connexions.cles.gemini.test === null, "un nouvel épisode l'efface");
  await app("cle", { nom: "gemini", valeur: "" });
  await horloge("2026-10-20T10:00");
});

await scenario("Réglages › Sources : catégories, flux spécialisés, choix explicite", async () => {
  let r = await app("etat");
  const s = r.donnees.reglages.sources;
  const meteo = s.categories.find((c) => c.cle === "meteo");
  verifier(meteo?.ou.includes("Open-Meteo") && meteo.apporte && meteo.type === "services" && s.categories.find((c) => c.cle === "web")?.cle_api === "tavily"
           && s.categories.find((c) => c.cle === "saints")?.type === "donnees" && s.flux.some((f) => f.actualites),
    "chaque catégorie dit où elle cherche et son onglet ; flux listés", s.categories.map((c) => [c.cle, c.ou, c.type]));
  verifier(r.donnees.modeles.find((m) => m.id === "meteo")?.sources.join() === "meteo" && r.donnees.modeles.find((m) => m.id === "libre")?.sources.length === 0
    && r.donnees.modeles.find((m) => m.id === "rappel")?.sources.join() === "agenda", "modèles : sources par défaut ; rubrique libre : à choisir", r.donnees.modeles.map((m) => [m.id, m.sources]));
  r = await app("rubrique", { formulaire: { titre: "Temps du jour", consigne: "La météo", longueur: "phrase", periode: { type: "toujours" }, sources: ["meteo"] } });
  const id = r.id;
  verifier(r.ok && r.donnees.reglages.sources.categories.find((c) => c.cle === "meteo").rubriques.some((x) => x.id === id), "« lue par » la rubrique", r.donnees.reglages.sources.categories.find((c) => c.cle === "meteo"));
  // Retirer une catégorie : plus proposée, plus lue, et une rubrique ne peut plus la choisir seule.
  r = await app("source_coupee", { cle: "meteo", coupee: true });
  verifier(r.ok && (await etat()).config.sources.coupees.includes("meteo") && r.donnees.modeles.find((m) => m.id === "meteo").sources.length === 0, "météo retirée", r.message);
  r = await app("rubrique", { formulaire: { titre: "Autre météo", consigne: "La météo", periode: { type: "toujours" }, sources: ["meteo"] } });
  verifier(r.ok === false && r.erreur.includes("au moins une source"), "source retirée : ne compte pas", r.erreur);
  const exp = await (await fetch(`${BOT}/api/config`, { headers: { "X-Podcast-Secret": SECRET } })).json();
  verifier(exp.config.sources.coupees.includes("meteo"), "GitHub sait qu'elle est retirée", exp.config.sources);
  r = await app("source_coupee", { cle: "meteo", coupee: false });
  verifier(r.ok && !(await etat()).config.sources.coupees.length, "météo de nouveau utilisable");
  verifier((await app("source_coupee", { cle: "inconnue", coupee: true })).ok === false, "catégorie inconnue refusée");
  // Un flux de plus (pas pour les Actualités globales) : trouvé d'après la page du site, choisi par une rubrique, retiré.
  const avant = (await etat()).config.sources.flux.length;
  r = await app("flux_ajouter", { valeur: `${FAUX}/site/page.html` });
  let flux = (await etat()).config.sources.flux.filter((f) => f.url.endsWith("/rss/flux.xml"));
  verifier(r.ok && flux.length === 1 && /^[0-9a-z]{8}$/.test(flux[0].id) && !(await etat()).config.actus.flux_lus.includes(flux[0].id), "flux ajouté (pas lu par les Actualités globales)", flux);
  verifier((await app("flux_ajouter", { valeur: `${FAUX}/rss/flux.xml` })).ok === false, "même flux pas deux fois");
  r = await app("rubrique", { formulaire: { titre: "Tech optique", consigne: "Les nouveautés de l'optique", periode: { type: "toujours" }, sources: [`flux:${flux[0].id}`] } });
  const optique = r.id;
  verifier(r.ok && r.donnees.reglages.sources.flux.find((f) => f.id === flux[0].id).rubriques.some((x) => x.id === optique), "rubrique qui lit le flux", r.erreur || r.donnees.reglages.sources.flux);
  r = await app("flux_retirer", { id: flux[0].id });
  const regle = (await etat()).config.regles.find((x) => x.id === optique);
  verifier(r.ok && (await etat()).config.sources.flux.length === avant && !regle.recherche.sources.length, "flux retiré : les rubriques ne le gardent pas", regle.recherche);
  await app("supprimer", { id: optique });
  await app("supprimer", { id });
  // À la voix : une rubrique libre reçoit des sources, et la réponse les dit.
  await vider();
  await gemini({ operations: [{ action: "nouvelle_regle", regle: { modele: "libre", titre: "Tech en Suisse", consigne: "Les actualités des nouvelles technologies en Suisse." } }], reponse: "" });
  r = await app("parler", { texte: "ajoute une rubrique sur les nouvelles technologies en Suisse" });
  const tech = (await etat()).config.regles.find((x) => x.titre === "Tech en Suisse");
  verifier(r.ok && tech?.recherche.sources.join() === "actus" && JSON.stringify(r).includes("cherche dans : Google Actualités"), "à la voix : sources choisies et annoncées", { sources: tech?.recherche, message: r.message });
  if (tech) await app("supprimer", { id: tech.id });
});

await scenario("Sources : reprise des anciennes rubriques (choisies par l'application)", async () => {
  const sauve = (await etat()).config;
  const ancienne = JSON.parse(JSON.stringify(sauve));
  delete ancienne.sources;
  ancienne.regles = [
    { id: "R1", titre: "Fête du prénom", consigne: "Les prénoms du jour", periode: { type: "toujours" }, recherche: { fiche: {}, sources: ["web"], sources_auto: true } },
    { id: "R2", titre: "Rappel", consigne: "Pense à ton sac", periode: { type: "toujours" }, condition: { texte: "piscine", moment: "veille", n: 1 } },
    { id: "R3", titre: "Mon train", consigne: "Retard du train de 7h31 vers Lausanne", periode: { type: "toujours" }, recherche: { fiche: {}, sources: ["web"] } },
  ];
  await envoyerJson(`${BOT}/test/etat`, { config: ancienne });
  const r = await app("etat");
  const sources = Object.fromEntries(r.donnees.regles.map((x) => [x.titre, x.sources.join()]));
  verifier(sources["Fête du prénom"] === "web,saints" && sources.Rappel === "agenda" && sources["Mon train"] === "web,transports",
    "ce qui était ajouté en douce est maintenant coché", sources);
  await envoyerJson(`${BOT}/test/etat`, { config: sauve });
});

await scenario("Flux privé du podcast", async () => {
  let r = await app("etat");
  verifier(r.donnees.flux === null, "pas de flux tant qu'on ne l'a pas créé");
  r = await app("flux");
  const adresse = r.donnees.flux || "";
  const jeton = (/\/flux\/([0-9a-f]{32})\.xml$/.exec(adresse) || [])[1];
  verifier(r.ok && jeton, "flux créé", adresse);
  // Un épisode avec son fichier, sa pochette et ses chapitres.
  await deposer("2026-10/2026-10-20-cap.mp3", Buffer.from("ID3-mars-audio"));
  await deposer("2026-10/2026-10-20-cap.jpg", new Uint8Array([0xff, 0xd8, 0xff, 9]));
  await evenement({ type: "episode", date: "2026-10-20", titre: "Cap sur Mars", sujets: ["Mars", "Vélo"], ref: 321,
    chapitres: [[0, "Ouverture"], [42, "Agenda"]], audio: "2026-10/2026-10-20-cap.mp3", pochette: "2026-10/2026-10-20-cap.jpg", duree: 300, taille: 2400000, heure: "07:10",
    sources: [{ section: "Actualités", titre: "RTS", url: "https://www.rts.ch/info/1" }] });
  const page = await obtenir(`${BOT}/flux/${jeton}.xml`);
  verifier(page.statut === 200 && page.texte.includes("<title>Cap sur Mars</title>") && page.texte.includes(`/flux/${jeton}/2026-10-20-321.mp3`)
    && page.texte.includes('length="2400000"') && page.texte.includes("<itunes:duration>0:05:00</itunes:duration>") && page.texte.includes("podcast:chapters")
    && page.texte.includes("Tue, 20 Oct 2026 05:10:00 GMT"), "flux RSS : épisode, fichier, durée, chapitres, date", page.texte.slice(0, 1500));
  const chapitres = JSON.parse((await obtenir(`${BOT}/flux/${jeton}/2026-10-20-321.json`)).texte);
  verifier(chapitres.chapters[1].startTime === 42 && chapitres.chapters[1].title === "Agenda", "chapitres au format Podcasting 2.0", chapitres);
  const audio = await fetch(`${BOT}/flux/${jeton}/2026-10-20-321.mp3`, { headers: { Range: "bytes=0-3" } });
  verifier(audio.status === 206 && (await audio.text()) === "ID3-", "audio servi par morceaux", audio.status);
  verifier((await obtenir(`${BOT}/flux/${"0".repeat(32)}.xml`)).statut === 404, "mauvais jeton : rien");
  verifier((await obtenir(`${BOT}/flux/${jeton}/2026-10-19-1.mp3`)).statut === 404, "épisode inconnu : rien");
  r = await app("flux", { renouveler: true });
  verifier(r.ok && r.donnees.flux !== adresse && (await obtenir(`${BOT}/flux/${jeton}.xml`)).statut === 404, "nouvelle adresse : l'ancienne ne marche plus");
});

await scenario("Fichiers gardés par le bot : dépôt, lecture par plages, archive, un an", async () => {
  const S = { "X-Podcast-Secret": SECRET };
  // Un MP3 de 2,5 Mo (trois morceaux d'1 Mio), dont chaque octet dépend de sa place.
  const taille = 2_500_000, bord = 1024 * 1024;
  const mp3 = new Uint8Array(taille);
  for (let i = 0; i < taille; i++) mp3[i] = (i * 7 + (i >> 8)) & 255;
  verifier((await deposer("2026-10/essai.mp3", mp3, {})).status === 403, "dépôt refusé sans le secret");
  verifier((await deposer("../essai.mp3", mp3)).status === 400 && (await deposer("2026-10/essai.exe", mp3)).status === 400
    && (await deposer("2026-13/essai.mp3", mp3)).status === 400, "nom de fichier refusé");
  let r = await (await deposer("2026-10/2026-10-22-071500.mp3", mp3)).json();
  verifier(r.ok && r.taille === taille, "MP3 déposé", r);
  await deposer("2026-10/2026-10-22-071500.jpg", new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-22", titre: "Gardé par le bot", ref: 400, duree: 300, heure: "07:15",
    audio: "2026-10/2026-10-22-071500.mp3", pochette: "2026-10/2026-10-22-071500.jpg", taille, transcription: "Léa : Bonjour !" }, S);
  r = await app("etat");
  const ep = r.donnees.episodes.find((x) => x.titre === "Gardé par le bot");
  verifier(ep?.audio && ep?.image && r.donnees.stockage >= taille, "lien audio, pochette et place prise", { audio: ep?.audio, stockage: r.donnees.stockage });
  await vider();
  const lire = async (adresse, plage, methode = "GET") => {
    const rep = await fetch(`${BOT}${adresse}`, { method: methode, headers: plage ? { Range: plage } : {} });
    return { statut: rep.status, entetes: rep.headers, octets: new Uint8Array(await rep.arrayBuffer()) };
  };
  const pareil = (octets, debut) => octets.every((o, i) => o === mp3[debut + i]);
  let l = await lire(ep.audio);
  verifier(l.statut === 200 && l.octets.length === taille && pareil(l.octets, 0) && l.entetes.get("content-type") === "audio/mpeg", "fichier entier : identique à l'original", l.statut);
  l = await lire(ep.audio, "bytes=0-1");
  verifier(l.statut === 206 && l.octets.length === 2 && l.entetes.get("content-range") === `bytes 0-1/${taille}`, "deux premiers octets (iPhone)", l.entetes.get("content-range"));
  l = await lire(ep.audio, `bytes=${bord - 10}-${bord + 9}`);
  verifier(l.statut === 206 && l.octets.length === 20 && pareil(l.octets, bord - 10), "plage à cheval sur deux morceaux", l.octets.length);
  l = await lire(ep.audio, `bytes=${2 * bord - 5}-`);
  verifier(l.statut === 206 && l.octets.length === taille - (2 * bord - 5) && pareil(l.octets, 2 * bord - 5), "de quelque part jusqu'à la fin");
  l = await lire(ep.audio, "bytes=-100");
  verifier(l.statut === 206 && l.octets.length === 100 && pareil(l.octets, taille - 100), "les 100 derniers octets");
  l = await lire(ep.audio, `bytes=${taille}-`);
  verifier(l.statut === 416 && l.entetes.get("content-range") === `bytes */${taille}`, "plage hors du fichier : 416", l.statut);
  l = await lire(ep.audio, null, "HEAD");
  verifier(l.statut === 200 && l.entetes.get("content-length") === String(taille) && !l.octets.length, "HEAD : la taille sans le contenu");
  l = await lire(ep.image);
  verifier(l.statut === 200 && l.entetes.get("content-type") === "image/jpeg" && l.octets.length === 6, "pochette gardée par le bot");
  // Le flux privé sert le même fichier.
  const base = new URL((await app("flux")).donnees.flux).pathname.replace(/\.xml$/, "");
  const rss = (await obtenir(`${BOT}${base}.xml`)).texte;
  verifier(rss.includes("<title>Gardé par le bot</title>") && rss.includes(`length="${taille}"`) && rss.includes(`${base}/2026-10-22-400.jpg`), "dans le flux, avec sa taille et sa pochette");
  l = await lire(`${base}/2026-10-22-400.mp3`, "bytes=1000-1999");
  verifier(l.statut === 206 && l.octets.length === 1000 && pareil(l.octets, 1000), "flux : plage lue chez le bot", l.statut);
  // Un extrait de voix gardé par le bot (un autre, remplacé, sera retiré au ménage).
  await deposer("voix/Kore-Puck-1.mp3", mp3.slice(0, 5000));
  await deposer("voix/Kore-Puck-0.mp3", mp3.slice(0, 7000));
  await envoyerJson(`${BOT}/api/evenement`, { type: "echantillon", voix: "Kore", fichier: "voix/Kore-Puck-1.mp3", debut: 0, fin: 2.5 }, S);
  r = await app("etat");
  l = await lire(r.donnees.reglages.echantillons.Kore);
  verifier(l.statut === 200 && l.octets.length === 5000, "extrait de voix lu chez le bot", l.statut);

  // Au-delà de 60 épisodes, les plus anciens passent dans l'archive de leur mois.
  for (let i = 1; i <= 60; i++) {
    const date = new Date(Date.UTC(2026, 9, 22 + i)).toISOString().slice(0, 10);
    await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date, titre: `Épisode ${i}`, ref: 1000 + i, heure: "07:00" }, S);
  }
  r = await app("etat");
  verifier(r.donnees.episodes.length === 60 && !r.donnees.episodes.some((x) => x.titre === "Gardé par le bot") && r.donnees.mois_archives.includes("2026-10"),
    "61e épisode : le plus ancien est archivé", { nb: r.donnees.episodes.length, archives: r.donnees.mois_archives });
  r = await app("episodes_mois", { mois: "2026-10" });
  const archive = r.mois_episodes?.episodes.find((x) => x.titre === "Gardé par le bot");
  verifier(r.ok && archive?.archive && archive.audio, "le mois archivé se charge, avec ses liens", r.mois_episodes?.episodes.map((x) => x.titre));
  l = await lire(archive.audio, "bytes=0-9");
  verifier(l.statut === 206 && pareil(l.octets, 0), "un épisode archivé s'écoute toujours");
  verifier((await app("texte", { cle: archive.cle })).texte?.includes("Bonjour"), "et son texte se lit");
  verifier((await app("episodes_mois", { mois: "2025-01" })).ok === false, "mois sans archive : refus");

  // Un an plus tard (le mois en cours et les douze précédents sont gardés) : le ménage de la nuit.
  await horloge("2027-12-02T03:30", true);
  const { etat: apres } = await etat();
  verifier(!apres.archives.includes("2026-10") && !apres.stockage["2026-10"] && apres.stockage.voix === 5000,
    "plus d'un an : archive et audio d'octobre 2026 effacés ; extrait remplacé retiré", { archives: apres.archives, stockage: apres.stockage });
  verifier((await app("episodes_mois", { mois: "2026-10" })).ok === false, "le mois effacé n'est plus proposé");
  l = await lire(archive.audio, "bytes=0-9");
  verifier(l.statut === 404, "son audio n'est plus servi", l.statut);
  verifier(!(await etat()).etat.episodes.some((x) => x.audio && x.date < "2026-12"), "plus de lien vers un fichier effacé");
  await horloge("2026-10-20T10:00");
});

await scenario("Notifications de l'application (Web Push)", async () => {
  const b64 = (o) => Buffer.from(o).toString("base64url");
  // Un « téléphone » : sa paire de clés et son secret, comme les donne le navigateur.
  const telephone = () => { const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); return { ecdh, auth: randomBytes(16) }; };
  const abonnement = (id, t) => ({ endpoint: `${FAUX}/push/${id}`, keys: { p256dh: b64(t.ecdh.getPublicKey()), auth: b64(t.auth) } });
  const recues = async () => (await fetch(`${FAUX}/control/pushs`)).json();
  // Déchiffrement côté téléphone (RFC 8291), pour vérifier ce que le bot envoie.
  const dechiffrer = (push, t) => {
    const corps = Buffer.from(push.corps, "base64");
    const sel = corps.subarray(0, 16), longueur = corps[20], cleServeur = corps.subarray(21, 21 + longueur), chiffre = corps.subarray(21 + longueur);
    const partage = t.ecdh.computeSecret(cleServeur);
    const ikm = Buffer.from(hkdfSync("sha256", partage, t.auth, Buffer.concat([Buffer.from("WebPush: info\0"), t.ecdh.getPublicKey(), cleServeur]), 32));
    const cle = Buffer.from(hkdfSync("sha256", ikm, sel, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, sel, Buffer.from("Content-Encoding: nonce\0"), 12));
    const d = createDecipheriv("aes-128-gcm", cle, nonce);
    d.setAuthTag(chiffre.subarray(-16));
    const clair = Buffer.concat([d.update(chiffre.subarray(0, -16)), d.final()]);
    let fin = clair.length - 1;
    while (fin > 0 && clair[fin] === 0) fin--;            // remplissage éventuel
    if (clair[fin] !== 2) throw new Error("délimiteur absent");
    return JSON.parse(clair.subarray(0, fin).toString("utf8"));
  };
  // Signature VAPID : jeton ES256 vérifiable avec la clé publique donnée à l'application.
  const vapidValide = (push, clePublique) => {
    const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(push.autorisation);
    if (!m || m[2] !== clePublique) return false;
    const [entete, charge, signature] = m[1].split(".");
    const brute = Buffer.from(clePublique, "base64url");
    const cle = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(brute.subarray(1, 33)), y: b64(brute.subarray(33)) }, format: "jwk" });
    const contenu = JSON.parse(Buffer.from(charge, "base64url").toString());
    return verify("sha256", Buffer.from(`${entete}.${charge}`), { key: cle, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))
      && contenu.aud === FAUX && contenu.exp > Date.now() / 1000 && /^(https:|mailto:)/.test(contenu.sub);
  };

  const sw = await fetch(`${BOT}/app/sw.js`);
  const codeSw = await sw.text();
  verifier(sw.status === 200 && sw.headers.get("service-worker-allowed") === "/app" && codeSw.includes("showNotification") && codeSw.includes("notificationclick"),
    "service worker servi, portée /app", sw.headers.get("service-worker-allowed"));
  let r = await app("etat");
  const clePublique = r.donnees.notifications?.cle || "";
  verifier(Buffer.from(clePublique, "base64url").length === 65 && r.donnees.notifications.abonnements.length === 0, "clé publique du bot pour s'abonner", clePublique);
  verifier((await app("etat")).donnees.notifications.cle === clePublique, "la clé du bot ne change pas");
  verifier((await app("notif_abonner", { abonnement: { endpoint: "ftp://x", keys: {} } })).ok === false, "abonnement illisible refusé");
  verifier((await app("notif_tester")).ok === false, "essai sans appareil : refus clair");

  const tel = telephone();
  await vider();
  r = await app("notif_abonner", { abonnement: abonnement("tel1", tel), nom: "iPhone · Safari (écran d'accueil)" });
  let pushs = await recues();
  verifier(r.ok && r.donnees.notifications.abonnements.length === 1 && r.donnees.notifications.abonnements[0].nom.startsWith("iPhone")
    && !JSON.stringify(r.donnees.notifications).includes(tel.auth.toString("base64url")), "abonnement enregistré (secret jamais renvoyé)", r.erreur);
  verifier(pushs.length === 1 && pushs[0].encodage === "aes128gcm" && Number(pushs[0].ttl) > 0 && vapidValide(pushs[0], clePublique),
    "confirmation envoyée : chiffrée, signée (VAPID)", pushs[0]?.autorisation?.slice(0, 40));
  verifier(dechiffrer(pushs[0], tel).titre === "🔔 Notifications activées", "le téléphone la déchiffre", dechiffrer(pushs[0], tel));
  r = await app("notif_abonner", { abonnement: abonnement("tel1", tel), nom: "iPhone · Safari" });
  verifier(r.ok && r.donnees.notifications.abonnements.length === 1, "même abonnement : pas de doublon");

  // Un épisode prêt : la notification ouvre l'application sur lui.
  await vider();
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-23", titre: "Pluie et grottes", mode: "planifie", duree: 320, heure: "07:15", ref: 71502 }, { "X-Podcast-Secret": SECRET });
  pushs = await recues();
  let message = pushs.length ? dechiffrer(pushs.at(-1), tel) : {};
  verifier(message.titre === "🎙️ Ton podcast du matin est prêt" && message.corps === "Pluie et grottes · 5 min" && message.url === `/app?ep=${encodeURIComponent("ep:2026-10-23:71502")}`,
    "épisode prêt : notification avec titre, durée et lien", message);
  r = await app("etat");
  verifier(r.donnees.episodes.some((x) => x.cle === "ep:2026-10-23:71502"), "épisode repéré par son heure d'envoi");
  // Un échec, des idées prêtes.
  await vider();
  await envoyerJson(`${BOT}/api/evenement`, { type: "echec", titre: "⏳ Podcast du matin : raté pour l'instant", message: "Nouvel essai automatique à 7 h 45. Gemini est surchargé." }, { "X-Podcast-Secret": SECRET });
  await envoyerJson(`${BOT}/api/evenement`, { type: "recherche", regles: [], idees: ["Grottes de Vallorbe", "Musée du Fer"], format: "ecrit", resultats: [] }, { "X-Podcast-Secret": SECRET });
  pushs = (await recues()).map((p) => dechiffrer(p, tel));
  verifier(pushs[0]?.titre.includes("raté") && pushs[0]?.corps.includes("7 h 45") && pushs[1]?.titre === "💡 Tes idées sont prêtes" && pushs[1]?.url === "/app?ecran=resultats",
    "échec et idées prêtes : notifiés aussi", pushs);
  r = await app("notif_tester");
  verifier(r.ok && r.message.includes("1 appareil"), "essai depuis l'application", r.message || r.erreur);
  // L'interrupteur d'un appareil : ses notifications coupées, puis remises (l'abonnement reste).
  const abo1 = r.donnees.notifications.abonnements[0];
  verifier(abo1?.appareil && r.donnees.appareils.some((a) => a.id === abo1.appareil) && abo1.coupe === false, "l'abonnement est rattaché à l'appareil qui l'a fait", abo1);
  r = await app("notif_couper", { id: abo1.id, coupe: true });
  verifier(r.ok && r.donnees.notifications.abonnements[0].coupe === true, "notifications coupées pour cet appareil", r.erreur || r.message);
  await vider();
  await evenement({ type: "episode", date: "2026-10-23", titre: "Coupé", mode: "manuel", ref: 80000 });
  verifier(!(await recues()).length && (await app("notif_tester")).ok === false, "appareil coupé : plus rien ne lui arrive");
  r = await app("notif_couper", { id: abo1.id, coupe: false });
  verifier(r.ok && !r.donnees.notifications.abonnements[0].coupe, "notifications remises");
  verifier((await app("notif_couper", { id: "inconnu", coupe: true })).ok === false, "abonnement inconnu refusé");
  r = await app("notif_couper", { id: abo1.id, coupe: true });
  r = await app("notif_abonner", { abonnement: abonnement("tel1", tel), nom: "iPhone · Safari", activer: true });
  verifier(r.ok && !r.donnees.notifications.abonnements[0].coupe, "réactiver depuis l'appareil remet ses notifications");

  // Un abonnement disparu (le navigateur l'a oublié) est retiré au premier envoi.
  const tel2 = telephone();
  await app("notif_abonner", { abonnement: abonnement("tel2", tel2), nom: "Android · Chrome" });
  await envoyerJson(`${FAUX}/control/push-statut`, { id: "tel2", statut: 410 });
  await vider();
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-24", titre: "Samedi", mode: "manuel", ref: 90000 }, { "X-Podcast-Secret": SECRET });
  r = await app("etat");
  verifier((await recues()).length === 2 && r.donnees.notifications.abonnements.map((a) => a.nom).join() === "iPhone · Safari", "abonnement disparu (410) : oublié", r.donnees.notifications.abonnements);
  // Service qui refuse autrement : noté, gardé.
  await envoyerJson(`${FAUX}/control/push-statut`, { id: "tel1", statut: 500 });
  await app("notif_tester");
  r = await app("etat");
  verifier(r.donnees.notifications.abonnements[0]?.erreur === "refusé (HTTP 500)", "refus passager : noté, abonnement gardé", r.donnees.notifications.abonnements);
  await envoyerJson(`${FAUX}/control/push-statut`, { id: "tel1", statut: 201 });

  // Abonné depuis un appareil connecté par code : retirer l'appareil coupe ses notifications.
  r = await app("appareil_code");
  const jeton = (await envoyerJson(`${BOT}/app/connexion`, { code: r.donnees.code_appareil.code, nom: "Mac · Safari" }).then((x) => x.json())).jeton;
  const tel3 = telephone();
  const parAppareil = await envoyerJson(`${BOT}/app/api`, { action: "notif_abonner", abonnement: abonnement("tel3", tel3), nom: "Mac · Safari", _appareil: "pirate" }, { "X-Appareil": jeton }).then((x) => x.json());
  const appareil = parAppareil.donnees.appareils.find((a) => a.nom === "Mac · Safari");
  verifier(parAppareil.ok && parAppareil.donnees.notifications.abonnements.length === 2, "abonnement depuis un appareil connecté");
  r = await app("appareil_retirer", { id: appareil.id });
  verifier(r.ok && r.donnees.notifications.abonnements.length === 1, "appareil retiré : ses notifications aussi", r.donnees.notifications.abonnements);
  r = await app("notif_retirer", { id: r.donnees.notifications.abonnements[0].id });
  verifier(r.ok && !r.donnees.notifications.abonnements.length, "couper les notifications");

  verifier((await app("regler", { chemin: "livraison.telegram", valeur: false })).ok === false, "plus de réglage de livraison");
});

await scenario("Appareils : connexion par code, manifeste, icônes", async () => {
  const manifeste = JSON.parse((await obtenir(`${BOT}/app/manifest.json`)).texte);
  verifier(manifeste.start_url === "/app" && manifeste.icons.length === 3, "manifeste de l'application", manifeste);
  const image = await fetch(`${BOT}/app/icone-512.png`);
  const octets = new Uint8Array(await image.arrayBuffer());
  verifier(image.headers.get("content-type") === "image/png" && octets[1] === 0x50 && octets[2] === 0x4e, "icône PNG servie");
  const connexion = (code) => envoyerJson(`${BOT}/app/connexion`, { code, nom: "iPhone · Safari" }).then((r) => r.json());
  verifier((await connexion("123456")).ok === false, "sans code affiché : refus");
  let r = await app("appareil_code");
  const code = r.donnees.code_appareil?.code;
  verifier(r.ok && /^\d{6}$/.test(code || ""), "code affiché dans l'application", r.donnees.code_appareil);
  const faux = code === "000000" ? "111111" : "000000";
  verifier((await connexion(faux)).ok === false, "mauvais code refusé");
  const ok = await connexion(code);
  verifier(ok.ok && /^[0-9a-f]{64}$/.test(ok.jeton), "bon code : jeton donné à l'appareil");
  verifier((await connexion(code)).ok === false, "un code ne sert qu'une fois");
  const parAppareil = async (jeton) => { const rep = await envoyerJson(`${BOT}/app/api`, { action: "etat" }, { "X-Appareil": jeton }); return { statut: rep.status, ...(await rep.json()) }; };
  r = await parAppareil(ok.jeton);
  verifier(r.statut === 200 && r.ok && r.donnees.appareils.some((a) => a.nom === "iPhone · Safari") && !JSON.stringify(r.donnees).includes(ok.jeton), "l'appareil ouvre l'application (jeton jamais renvoyé)");
  verifier((await parAppareil("f".repeat(64))).statut === 401, "jeton inconnu refusé");
  r = await app("appareil_retirer", { id: r.donnees.appareils.find((a) => a.nom === "iPhone · Safari").id });
  const apres = await parAppareil(ok.jeton);
  verifier(r.ok && apres.statut === 401 && apres.appareil === "inconnu", "appareil retiré : refusé ensuite");

  // Un appareil peut se retirer lui-même : son jeton ne vaut plus rien.
  r = await app("appareil_code");
  const jeton3 = (await connexion(r.donnees.code_appareil.code)).jeton;
  const moi = (await parAppareil(jeton3)).donnees.appareils.at(-1);
  const seul = await envoyerJson(`${BOT}/app/api`, { action: "appareil_retirer", id: moi.id }, { "X-Appareil": jeton3 }).then((x) => x.json());
  verifier(seul.ok && !seul.donnees.appareils.some((a) => a.id === moi.id) && (await parAppareil(jeton3)).statut === 401, "un appareil se retire lui-même", seul.erreur);
  // Huit appareils au plus : les plus anciens laissent la place.
  for (let i = 0; i < 9; i++) { r = await app("appareil_code"); await connexion(r.donnees.code_appareil.code); }
  r = await app("etat");
  verifier(r.donnees.appareils.length === 8, "huit appareils au plus", r.donnees.appareils.length);

  // Cinq erreurs : le code ne vaut plus rien.
  r = await app("appareil_code");
  const code2 = r.donnees.code_appareil.code, faux2 = code2 === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await connexion(faux2);
  verifier((await connexion(code2)).ok === false, "cinq erreurs : code bloqué");
});

await scenario("Mises à jour depuis le modèle", async () => {
  let r = await app("verifier_maj");
  verifier(r.ok && r.donnees.maj?.version === "2099-01-01.1" && r.donnees.maj.nouveautes.length === 2 && r.donnees.maj_modele === "ok", "nouvelle version vue", r.donnees.maj);
  await vider();
  r = await app("mettre_a_jour");
  const lance = lancements(await appels()).find((a) => a.workflow === "mettre-a-jour.yml");
  verifier(r.ok && lance?.entrees?.version === "2099-01-01.1" && lance.entrees.modele === "auteur/modele" && lance.entrees.adresse, "mise à jour lancée", lance);
  // Sauvegarde relue, et réécrite si elle avait changé (identique : rien à écrire).
  const sauvegarde = JSON.parse((await (await fetch(`${FAUX}/control/fichiers`)).json())["preferences.json"] || "{}");
  verifier((await appels()).some((a) => a.service === "github" && a.chemin === "preferences.json")
    && JSON.stringify(sauvegarde.config) === JSON.stringify((await etat()).config), "réglages sauvegardés avant la mise à jour");
  verifier((await app("mettre_a_jour")).ok === false, "pas deux mises à jour à la fois");
  verifier((await obtenir(`${BOT}/api/maj`, { headers: entetesApi })).statut === 404, "le bot ne donne jamais son jeton GitHub");
  await envoyerJson(`${BOT}/api/evenement`, { type: "maj", ok: true, version: "2099-01-01.1", message: "12 fichier(s) mis à jour." }, { "X-Podcast-Secret": SECRET });
  r = await app("etat");
  verifier(r.donnees.maj_etat?.etat === "fait" && r.donnees.maj_etat.message.includes("12"), "fin de mise à jour signalée", r.donnees.maj_etat);
});

await scenario("Pays : réglage et reprise des anciennes installations", async () => {
  // Choisir la France : fuseau, devise, médias par défaut et jours fériés suivent.
  const avant = (await etat()).config;
  // Une configuration d'avant la réunion des flux : médias du pays (liste non touchée), un flux spécialisé.
  const vieille = { ...avant, actus: { ...avant.actus, flux: null, flux_lus: undefined }, sources: { coupees: ["agenda"], flux: [{ id: "labo1234", nom: "Labo", url: "https://labo.ch/rss" }] } };
  const migree = completerConfig(vieille);
  verifier(migree.sources.flux.length === 4 && migree.actus.flux_lus.length === 3 && !migree.actus.flux_lus.includes("labo1234") && !migree.sources.coupees.length
           && migree.sources.flux.filter((f) => f.pays === "CH").length === 3, "médias et flux spécialisés réunis ; les médias restent lus par les Actualités globales", migree.sources);
  const choisie = completerConfig({ ...vieille, actus: { ...vieille.actus, flux: [{ nom: "24 heures", url: "https://www.24heures.ch/rss" }] } });
  verifier(choisie.sources.flux.map((f) => f.nom).join() === "Labo,24 heures" && choisie.actus.flux_lus.length === 1 && !choisie.sources.flux.some((f) => f.pays),
    "médias choisis à la main : repris tels quels", choisie.sources.flux);
  await envoyerJson(`${BOT}/test/etat`, { config: { ...avant, actus: { ...avant.actus, flux: null, flux_lus: undefined } } });
  let r = await app("regler", { chemin: "pays", valeur: "FR" });
  let { config } = await etat();
  verifier(r.ok && config.pays === "FR" && config.planning.feries_region === "FR", "pays France : les fériés suivent", config.planning);
  verifier(r.donnees.devise === "EUR" && r.donnees.reglages.actus.flux.some((f) => f.nom === "franceinfo") && r.donnees.listes.pays.some(([c]) => c === "BE"),
    "devise, médias par défaut et liste des pays", { devise: r.donnees.devise, flux: r.donnees.reglages.actus.flux });
  verifier(!r.donnees.reglages.sources.flux.some((f) => f.pays === "CH") && r.donnees.reglages.actus.flux.every((f) => f.pays === "FR"),
    "les médias proposés pour la Suisse laissent la place à ceux de la France", r.donnees.reglages.sources.flux);
  const exp = await (await fetch(`${BOT}/api/config`, { headers: { "X-Podcast-Secret": SECRET } })).json();
  verifier(exp.config.pays === "FR" && exp.flux_defaut.some((f) => f.nom === "franceinfo"), "GitHub reçoit le pays", exp.flux_defaut);
  verifier((await app("regler", { chemin: "pays", valeur: "XX" })).ok === false, "pays inconnu refusé");
  // Une installation « version France » d'avant le réglage : le pays est déduit de reglages.toml.
  await envoyerJson(`${FAUX}/control/fichier`, { chemin: "reglages.toml", texte: 'fuseau_horaire = "Europe/Paris"\npays_actus = "FR"\n' });
  const ancienne = { ...config, planning: { ...config.planning, feries_region: "CH-VD" } };
  delete ancienne.pays;
  await envoyerJson(`${BOT}/test/etat`, { config: ancienne });
  r = await app("etat");
  ({ config } = await etat());
  verifier(config.pays === "FR" && config.planning.feries_region === "FR" && r.donnees.devise === "EUR", "ancienne version France : pays et fériés repris", { pays: config.pays, region: config.planning.feries_region });
  // Sans indice : la Suisse, réglages inchangés.
  await envoyerJson(`${FAUX}/control/fichier`, { chemin: "reglages.toml", texte: 'fuseau_horaire = "Europe/Zurich"\n' });
  const suisse = { ...config, planning: { ...config.planning, feries_region: "CH-VD" } };
  delete suisse.pays;
  await envoyerJson(`${BOT}/test/etat`, { config: suisse });
  await app("etat");
  ({ config } = await etat());
  verifier(config.pays === "CH" && config.planning.feries_region === "CH-VD", "ancienne version suisse : rien ne change", config.pays);
  // Tous les pays proposés, plus « Pas renseigné » ; les fériés suivent le pays (en Suisse : le canton).
  r = await app("etat");
  const pays = r.donnees.listes.pays;
  verifier(pays.length > 150 && pays.some(([c, n]) => c === "JP" && n === "Japon") && pays.at(-1)[0] === "--" && pays.at(-1)[1] === "Pas renseigné",
    "liste complète des pays, « Pas renseigné » en dernier", pays.length);
  verifier(r.donnees.listes.regions.every(([c]) => c.startsWith("CH-")), "seuls les cantons restent à choisir");
  await app("regler", { chemin: "planning.feries_region", valeur: "CH-GE" });
  r = await app("regler", { chemin: "pays", valeur: "JP" });
  ({ config } = await etat());
  verifier(config.pays === "JP" && config.planning.feries_region === "JP" && r.donnees.devise === "JPY", "Japon : fériés et devise suivent", config.planning.feries_region);
  r = await app("regler", { chemin: "pays", valeur: "--" });
  ({ config } = await etat());
  verifier(config.pays === "--" && config.planning.feries_region === "--" && config.fuseau === "Asia/Tokyo" && r.donnees.reglages.planning?.feries_region !== "JP",
    "pas de pays : pas de fériés, l'heure reste celle du pays d'avant", { fuseau: config.fuseau, region: config.planning.feries_region });
  verifier(r.donnees.pays === "--" && r.donnees.planning.feries_region === "--", "l'application reçoit « pas de pays »");
  await app("regler", { chemin: "pays", valeur: "CH" });
  ({ config } = await etat());
  verifier(config.planning.feries_region === "CH-VD" && !config.fuseau, "retour en Suisse : canton de Vaud par défaut, plus de fuseau mémorisé", config.planning.feries_region);
});

await scenario("Rubrique : ce qu'elle a raconté, synthèse, textes et sources", async () => {
  const entetes = { "X-Podcast-Secret": SECRET };
  const episode = (date, id, texte) => envoyerJson(`${BOT}/api/evenement`, { type: "episode", date, titre: "Épisode", sujets: [], ref: Number(date.slice(-2)) + 7000, mode: "planifie",
    rubriques: { [id]: { titre: "Veille IA", texte, sources: [{ titre: "Un article", url: "https://exemple.ch/a" }] }, "<x>": { titre: "ignoré", texte: "x" } } }, entetes);
  await episode("2026-10-14", "R1", "Léa : Les modèles progressent.\nHugo : Oui, vite.");
  await episode("2026-10-15", "R1", "Léa : Nouveau modèle ouvert.");
  const h = await (await fetch(`${BOT}/api/rubrique?id=R1`, { headers: entetes })).json();
  verifier(h.entrees.length === 2 && h.entrees[1].texte.includes("Nouveau modèle") && h.entrees[0].sources[0].url === "https://exemple.ch/a", "le bot garde le texte et les sources de la rubrique", h);
  verifier((await fetch(`${BOT}/api/rubrique?id=R1`)).status === 403, "historique réservé à GitHub");
  verifier((await (await fetch(`${BOT}/api/rubrique?id=%3Cx%3E`, { headers: entetes })).json()).entrees.length === 0, "identifiant invalide ignoré");
  await episode("2026-10-15", "R1", "Léa : Nouveau modèle ouvert (version corrigée).");
  let r = await app("rubrique_resume", { id: "R1" });
  verifier(r.ok && r.rubrique.entrees.length === 2 && r.rubrique.entrees[0].date === "2026-10-15" && r.rubrique.entrees[0].texte.includes("corrigée") && r.rubrique.resume === null,
    "le même épisode ne compte qu'une fois, du plus récent au plus ancien", r.rubrique);
  await vider();
  r = await app("resume_podcast", { id: "R1" });
  const lance = lancements(await appels()).find((a) => a.workflow === "recherche.yml");
  verifier(r.ok && lance && lance.entrees.regles === "R1" && lance.entrees.format === "resume", "synthèse lancée sur GitHub", lance);
  verifier((await app("resume_podcast", { id: "R9" })).ok === false, "rubrique sans historique : refus");
  // La synthèse arrive : le lecteur de l'application peut la lire.
  await envoyerJson(`${BOT}/api/evenement`, { type: "resume", rubrique: "R1", audio: "2026-10/resume-R1-2026-10-15-070000.mp3", titre: "Où en est la veille IA", duree: 180 }, entetes);
  r = await app("rubrique_resume", { id: "R1" });
  verifier(r.rubrique.resume?.audio?.startsWith("/app/audio?c=resume%3AR1") && r.rubrique.resume.duree === 180, "synthèse disponible avec un lien audio signé", r.rubrique.resume);
});

await scenario("Après le déploiement : nouveautés annoncées par notification", async () => {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  await app("notif_abonner", { abonnement: { endpoint: `${FAUX}/push/deploiement`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } }, nom: "Téléphone" });
  const recus = async () => (await (await fetch(`${FAUX}/control/pushs`)).json()).filter((p) => p.id === "deploiement");
  // Le bot nouvellement déployé s'active (/installer) et prévient s'il vient d'une autre version.
  const installer = async (versionAvant) => {
    await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, version_installee: versionAvant } });
    await vider();
    await obtenir(`${BOT}/installer`);
    return recus();
  };
  let pushs = await installer("2026-10-21.1");
  verifier(pushs.length === 1, "nouvelle version : une notification", pushs.length);
  verifier((await etat()).etat.version_installee !== "2026-10-21.1", "nouvelle version notée");
  pushs = await installer((await etat()).etat.version_installee);
  verifier(pushs.length === 0, "même version : rien", pushs.length);
  pushs = await installer(null);
  verifier(pushs.length === 0, "première installation : rien à annoncer", pushs.length);
  // Sans /installer (activation du déploiement ratée) : le tic installe, une seule fois.
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, version_installee: "2026-10-21.1" } });
  await vider();
  await horloge("2026-10-20T12:00", true);
  await horloge("2026-10-20T12:05", true);
  verifier((await recus()).length === 1 && (await etat()).etat.version_installee !== "2026-10-21.1", "activation par le tic : annoncée une seule fois");
  const fiche = (await app("etat")).donnees.notifications.abonnements.find((a) => a.nom === "Téléphone");
  if (fiche) await app("notif_retirer", { id: fiche.id });
});

await scenario("Déploiement : secrets transmis au bot", async () => {
  const { aTransmettre, nomsExistants, avertissementManquants } = await import("../secrets.mjs");
  verifier(JSON.stringify(nomsExistants('▲ avertissement\n[{"name":"GEMINI_API_KEY","type":"secret_text"},{"name":"GITHUB_TOKEN","type":"secret_text"}]'))
    === '["GEMINI_API_KEY","GITHUB_TOKEN"]', "liste des secrets lue malgré les avertissements");
  verifier(nomsExistants("erreur").length === 0, "liste illisible : vide");
  const envoi = aTransmettre(["GITHUB_TOKEN"], { GEMINI_API_KEY: " gem ", BOT_GITHUB_TOKEN: "github_pat_x", TELEGRAM_BOT_TOKEN: "1:A", TELEGRAM_CHAT_ID: "42" });
  verifier(envoi.GEMINI_API_KEY === "gem" && envoi.GITHUB_TOKEN === "github_pat_x" && Object.keys(envoi).length === 2, "seuls la clé Gemini et le jeton GitHub sont transmis", envoi);
  verifier(!("GEMINI_API_KEY" in aTransmettre(["GEMINI_API_KEY"], { GEMINI_API_KEY: "x" })), "clé déjà chez le bot : pas remplacée");
  verifier(avertissementManquants(["GITHUB_TOKEN"]) === "" && avertissementManquants(["GEMINI_API_KEY"]).includes("BOT_GITHUB_TOKEN"), "le jeton GitHub est indispensable");
});

await scenario("Ancienne conversation oubliée, mini-podcast d'idées", async () => {
  // Un état d'avant : tableau épinglé, assistant, sondages, extraits chez la messagerie, appareils sans jeton…
  const e = (await etat()).etat;
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...e, tableau_id: 12, assistant: { etape: "quoi" }, sondages: { a: {} }, echantillons: { Kore: "F1" }, attente: null,
    appareils: [...(e.appareils || []), { id: "t-0a1b2c3d4e", nom: "Ancien appareil", telegram: true, cree_le: "2026-10-20T08:00", vu_le: "2026-10-20T08:00" }] } });
  let r = await app("etat");
  const apres = (await etat()).etat;
  verifier(r.ok && !["tableau_id", "assistant", "sondages", "echantillons", "attente"].some((cle) => cle in apres) && apres.appareils.every((a) => a.empreinte),
    "ce que gardait l'ancienne conversation est oublié", Object.keys(apres));
  const config = (await etat()).config;
  await envoyerJson(`${BOT}/test/etat`, { config: { ...config, livraison: { telegram: false } } });
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(!("livraison" in exp.config), "ancien réglage de livraison oublié", exp.config.livraison);
  // Un mini-podcast d'idées : gardé par le bot, il s'écoute dans « Idées trouvées ».
  await deposer("2026-10/idees-2026-10-25-090000.mp3", new Uint8Array(2000).fill(3));
  await evenement({ type: "recherche", regles: [], idees: ["Grottes de Vallorbe"], format: "audio", resultats: [{ regle: "", titre: "Sortie", idees: [{ titre: "Grottes de Vallorbe" }] }],
    audio: "2026-10/idees-2026-10-25-090000.mp3", titre_audio: "Sous terre samedi", duree: 150 });
  r = await app("etat");
  const mini = r.donnees.resultats?.episode;
  const luMini = mini?.audio ? await fetch(`${BOT}${mini.audio}`) : null;
  verifier(mini?.titre === "Sous terre samedi" && luMini?.status === 200 && (await luMini.arrayBuffer()).byteLength === 2000, "mini-podcast d'idées écouté dans l'application", mini);
});

console.log(`\n${reussis} vérifications réussies, ${rates} ratées.`);
if (rates) { console.log(echecs.map((x) => ` - ${x}`).join("\n")); process.exit(1); }
