// Tests de bout en bout du bot (wrangler dev + faux services).
import { createHash, createHmac, createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";

const BOT = "http://127.0.0.1:8799";
const FAUX = "http://127.0.0.1:8790";
const SECRET = createHash("sha256").update("podcast:123:TEST").digest("hex").slice(0, 48);
const CHAT = 42;
let updateId = 1;
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
// Attend que le bot ait fini les messages déjà envoyés avant de vider le journal :
// sinon la fin d'une action (toast, écran) tombe dans l'étape suivante et la
// fait conclure trop tôt (machines lentes, comme sur GitHub).
async function vider() {
  const fin = Date.now() + (process.env.GITHUB_ACTIONS ? 20000 : 8000);
  while (Date.now() < fin && (await etat()).fini < updateId - 1) await attente(50);
  await fetch(`${FAUX}/control/vider`, { method: "POST" });
}
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

async function envoyer(miseAJour) {
  const r = await envoyerJson(`${BOT}/telegram`, { update_id: updateId++, ...miseAJour }, { "X-Telegram-Bot-Api-Secret-Token": SECRET });
  return r.status;
}
const message = (texte, extra = {}) => envoyer({ message: { message_id: 500 + updateId, chat: { id: CHAT }, from: { id: CHAT, is_bot: false }, date: 0, text: texte, ...extra } });
const bouton = (donnees, messageId = 777) => envoyer({ callback_query: { id: `cb${updateId}`, from: { id: CHAT }, data: donnees, message: { message_id: messageId, chat: { id: CHAT } } } });

const tg = (liste, methode) => liste.filter((a) => a.service === "telegram" && a.methode === methode);
const dernierTexte = (liste) => tg(liste, "sendMessage").at(-1)?.corps?.text || "";
const toast = (liste) => tg(liste, "answerCallbackQuery").at(-1)?.corps?.text || "";
const boutons = (corps) => (corps?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data || b.text);
const lancements = (liste) => liste.filter((a) => a.service === "github" && a.methode === "lancer");

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
  verifier((await envoyerJson(`${BOT}/telegram`, { update_id: 1 })).status === 403, "Telegram sans secret refusé");
  verifier((await obtenir(`${BOT}/api/config`)).statut === 403, "API sans secret refusée");
  verifier((await obtenir(`${BOT}/desinstaller`)).statut === 403, "désinstallation protégée");
  verifier((await obtenir(`${BOT}/favicon.ico`)).statut === 404, "favicon sans effet");
});

await scenario("Installation et import des réglages", async () => {
  const r = await obtenir(`${BOT}/installer`);
  verifier(r.texte.includes("activé"), "réponse d'installation", r.texte);
  const liste = await appels();
  const webhook = tg(liste, "setWebhook")[0]?.corps;
  verifier(webhook?.url === `${BOT}/telegram` && webhook?.secret_token === SECRET, "webhook installé avec secret", webhook);
  verifier(webhook?.allowed_updates?.includes("poll_answer") && webhook?.allowed_updates?.includes("message_reaction"), "mises à jour demandées");
  verifier(tg(liste, "setMyCommands")[0]?.corps?.commands?.length >= 8, "commandes du menu");
  verifier(tg(liste, "sendMessage").some((a) => a.corps.text.includes("l'application") && a.corps.reply_markup?.keyboard), "message de bienvenue avec clavier fixe");
  verifier(tg(liste, "setChatMenuButton")[0]?.corps?.menu_button?.type === "commands", "sans https, le bouton de menu reste « commandes »", tg(liste, "setChatMenuButton")[0]?.corps);
  verifier(tg(liste, "pinChatMessage").length === 1, "tableau de bord épinglé");
  verifier(liste.some((a) => a.methode === "ecrire" && a.chemin === "preferences.json"), "sauvegarde initiale");
  const { config } = await etat();
  verifier(config.format.duree_minutes === 5 && config.voix.vitesse === "rapide" && config.actus.ville === "Yverdon", "import depuis preferences.json", config.format);
  verifier(config.consignes[0]?.includes("Yverdon") && config.planning.jours.lun === "07:30", "consignes et horaire importés");
  const voixImportees = (await app("etat")).donnees.reglages.voix;
  verifier(voixImportees.noms.Aoede === "Léa" && voixImportees.noms.Puck === "Hugo" && voixImportees.animateurs.map((a) => a.voix).join() === "Aoede,Puck",
    "animateurs de reglages.toml : leurs prénoms passent à leurs voix", voixImportees);
  verifier(Boolean((await etat()).reveil), "réveil programmé dès l'installation");
  const deuxieme = await obtenir(`${BOT}/installer`);
  const apres = await appels();
  verifier(deuxieme.texte.includes("activé") && tg(apres, "sendMessage").length === tg(liste, "sendMessage").length, "pas de second message de bienvenue");
});

await scenario("Menus et navigation", async () => {
  await message("/menu");
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  const accueil = tg(liste, "sendMessage")[0]?.corps;
  verifier(accueil?.text.includes("Réglages du podcast") && boutons(accueil).includes("m:planning"), "écran d'accueil", accueil?.text);
  await vider();
  await bouton("m:planning");
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  const planning = tg(liste, "editMessageText")[0]?.corps;
  verifier(planning?.message_id === 777 && planning.text.includes("Planning") && boutons(planning).includes("m:jour:sam"), "planning modifié sur place", planning?.text);
  verifier(tg(liste, "answerCallbackQuery").length === 1, "bouton acquitté");
  for (const ecranNom of ["format", "voix", "anim:0:1", "deroule", "agenda", "actus", "sources", "consignes", "regles:active:0", "jour:mer"]) {
    await vider();
    await bouton(`m:${ecranNom}`);
    liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
    const corps = tg(liste, "editMessageText")[0]?.corps;
    const tailles = boutons(corps).filter((d) => d && !/^[^:]+$/.test(d));
    verifier(corps?.text && tailles.every((d) => Buffer.byteLength(d) <= 64), `écran ${ecranNom}`, corps?.text?.slice(0, 80));
  }
  await vider();
  await bouton("m:accueil", 404);
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(tg(liste, "sendMessage").length === 1, "message introuvable → nouvel envoi");
});

await scenario("Boutons du planning et annulation", async () => {
  await bouton("a:ph:sam:0900");
  // Le tableau de bord est modifié avant le toast : attendre le toast lui-même.
  let liste = await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  let { config, etat: e } = await etat();
  verifier(config.planning.jours.sam === "09:00", "samedi à 9 h", config.planning.jours);
  verifier(toast(liste).includes("sam"), "toast de confirmation", toast(liste));
  verifier(e.annulations.length >= 1, "annulation possible");
  await vider();
  await bouton("a:pc:sam:weekend");
  await attendre((l) => tg(l, "editMessageText").length >= 1);
  ({ config } = await etat());
  verifier(config.planning.jours.dim === "09:00", "week-end aligné");
  await vider();
  await bouton("a:ph:dim:off");
  await attendre((l) => tg(l, "editMessageText").length >= 1);
  ({ config } = await etat());
  verifier(config.planning.jours.dim === null, "pas d'épisode le dimanche");
  await vider();
  await bouton("a:pd:lun:-15");
  await attendre((l) => tg(l, "editMessageText").length >= 1);
  ({ config } = await etat());
  verifier(config.planning.jours.lun === "07:15", "lundi décalé de 15 min");
  await vider();
  await bouton("a:pav");
  await attendre((l) => tg(l, "editMessageText").length >= 1);
  ({ config } = await etat());
  verifier(config.planning.avance_minutes === 10, "préparation 10 min avant", config.planning.avance_minutes);
  await vider();
  await message("/annuler");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  ({ config } = await etat());
  verifier(config.planning.avance_minutes === 5 && dernierTexte(liste).includes("Annulé"), "annulation du dernier changement", dernierTexte(liste));
  await vider();
  await bouton("a:undo");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  ({ config } = await etat());
  verifier(config.planning.jours.lun === "07:30", "deuxième annulation");
});

await scenario("Format, voix, agenda, actus par boutons", async () => {
  const actions = ["a:fd:-", "a:fs:+", "a:ft:humour", "a:vv:-", "a:va:0:Kore", "a:vt", "a:dd:agenda", "a:dt:actualites", "a:gj:+", "a:gn", "a:af:+", "a:ac:les_deux"];
  for (const a of actions) {
    await vider();
    await bouton(a);
    await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  }
  const { config } = await etat();
  verifier(config.format.duree_minutes === 4 && config.format.nombre_sujets === 4 && config.format.ton === "humour", "format", config.format);
  verifier(config.voix.vitesse === "normale" && config.voix.animateurs[0].voix === "Kore" && config.voix.tutoiement === false, "voix", config.voix);
  verifier(config.deroule[2].cle === "agenda" && config.deroule.find((r) => r.cle === "actualites").actif === false, "déroulé", config.deroule);
  verifier(config.agenda.jours === 8 && config.agenda.notes === false, "agenda", config.agenda);
  verifier(config.actus.fraicheur_heures === 48 && config.actus.citer_sources === "les_deux", "actus", config.actus);
  await vider();
  await bouton("a:fd:-"); await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  for (let i = 0; i < 4; i++) { await vider(); await bouton("a:fd:-"); await attendre((l) => tg(l, "answerCallbackQuery").length >= 1); }
  verifier((await etat()).config.format.duree_minutes === 2, "durée bornée à 2 min");
});

await scenario("Saisie guidée (ForceReply)", async () => {
  await bouton("a:ca");
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(tg(liste, "sendMessage")[0]?.corps?.reply_markup?.force_reply === true, "question avec réponse forcée");
  await vider();
  await message("plus d'humour le vendredi");
  // L'écran est modifié puis la confirmation envoyée : attendre les deux (machines lentes).
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1 && dernierTexte(l).includes("✅"));
  const { config } = await etat();
  verifier(config.consignes.includes("plus d'humour le vendredi"), "consigne ajoutée", config.consignes);
  verifier(dernierTexte(liste).includes("✅"), "confirmation");
  verifier(!liste.some((a) => a.service === "gemini"), "aucun appel à Gemini pour une saisie simple");
  await vider();
  await bouton("a:vp");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  await message("Daniel");
  await attendre((l) => tg(l, "sendMessage").length >= 2);
  verifier((await etat()).config.voix.prenom === "Daniel", "prénom de l'auditeur");
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
  await message("6h45 en semaine, 9h le samedi, rien le dimanche, plus lentement, et pas de sport. 99 minutes.");
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  const { config } = await etat();
  verifier(config.planning.jours.mar === "06:45" && config.planning.jours.sam === "09:00" && config.planning.jours.dim === null, "horaires par jour", config.planning.jours);
  verifier(config.voix.vitesse === "lente" && config.actus.sujets_a_eviter.includes("sport"), "vitesse et thème évité");
  const texte = dernierTexte(liste);
  verifier(texte.includes("6 h 45") && texte.includes("⚠️") && boutons(tg(liste, "sendMessage")[0].corps).includes("a:undo"), "réponse avec erreurs et bouton annuler", texte);
  const appelGemini = liste.find((a) => a.service === "gemini")?.corps;
  verifier(appelGemini?.model === "gemini-3.5-flash-lite" && appelGemini.response_format?.schema && appelGemini.store === false, "appel Gemini structuré", appelGemini?.model);
  verifier(!JSON.stringify(appelGemini).includes("123:TEST") && !JSON.stringify(appelGemini).includes("gh-test"), "aucun secret envoyé à Gemini");
  verifier(tg(liste, "sendChatAction").length >= 1, "indicateur « écrit… »");
});

// Gemini (modèle léger) ne range pas toujours les champs où il faut : le bot ne doit
// jamais en tirer un défaut destructeur, et ce qu'il annonce doit être ce qu'il a fait.
await scenario("Compréhension : réponses maladroites de Gemini, confirmation, transcription", async () => {
  const sauvegarde = (await etat()).config;
  const jours = async () => (await etat()).config.planning.jours;
  // L'heure rangée dans « valeur » au lieu de « heure » (le cas du 6 h 30 du 21 oct. 2026).
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"], valeur: "06:30" }], reponse: "" });
  await message("change l'horaire tout le temps à 6h30");
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  let texte = dernierTexte(liste);
  verifier(Object.values(await jours()).every((h) => h === "06:30"), "heure reprise de « valeur »", await jours());
  verifier(texte.includes("C'est fait") && texte.includes("6 h 30") && !texte.includes("pas d'épisode"), "confirmation tirée de ce qui a été fait", texte);
  // Heure oubliée : rien ne change, et la phrase de Gemini (fausse) n'est pas montrée.
  await vider();
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"] }], reponse: "C'est fait, ton podcast est programmé à 07:00." });
  await message("tous les jours à 7h");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  texte = dernierTexte(liste);
  verifier(Object.values(await jours()).every((h) => h === "06:30"), "heure oubliée : planning intact", await jours());
  verifier(texte.includes("rien changé") && texte.includes("l'heure") && !texte.includes("07:00") && !boutons(tg(liste, "sendMessage")[0].corps).includes("a:undo"),
    "heure oubliée : erreur claire, sans la phrase de Gemini", texte);
  // Couper tout le planning : à confirmer. Non → rien ne change.
  await vider();
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"], heure: "aucun" }], reponse: "" });
  await message("plus aucun épisode");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  texte = dernierTexte(liste);
  const clavier = boutons(tg(liste, "sendMessage")[0].corps);
  verifier(texte.includes("À confirmer") && clavier.includes("a:conf") && clavier.includes("a:nconf") && (await jours()).lun === "06:30",
    "planning coupé : rien d'appliqué avant confirmation", { texte, clavier });
  await vider(); await bouton("a:nconf", 640);
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("rien changé") && (await jours()).lun === "06:30" && !(await etat()).etat.a_confirmer, "« Non » : rien ne change", dernierTexte(liste));
  verifier(tg(liste, "editMessageReplyMarkup").length >= 1, "boutons de confirmation retirés");
  await vider(); await bouton("a:conf", 640);
  liste = await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  verifier(toast(liste).includes("Plus rien en attente") && (await jours()).lun === "06:30", "confirmation déjà traitée : sans effet", toast(liste));
  // Oui → appliqué, et annulable.
  await vider();
  await gemini({ entendu: "", operations: [{ action: "horaire", jours: ["tous"], heure: "aucun" }], reponse: "" });
  await message("plus aucun épisode");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  await vider(); await bouton("a:conf", 641);
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(Object.values(await jours()).every((h) => h === null) && dernierTexte(liste).includes("C'est fait")
    && boutons(tg(liste, "sendMessage")[0].corps).includes("a:undo"), "« Oui » : appliqué, annulable", dernierTexte(liste));
  await vider(); await bouton("a:undo", 641);
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier((await jours()).lun === "06:30", "annulé : l'horaire revient");
  // Vocal : ce que Gemini a entendu est montré.
  await vider();
  await gemini({ entendu: "mets le podcast à six heures et quart", operations: [{ action: "horaire", jours: ["semaine"], heure: "06:15" }], reponse: "" });
  await message(undefined, { voice: { file_id: "vocal-6h15", duration: 3, mime_type: "audio/ogg" } });
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  texte = dernierTexte(liste);
  verifier(texte.includes("« mets le podcast à six heures et quart »") && texte.includes("6 h 15"), "transcription affichée avec le changement", texte);
  const trace = (await etat()).etat.historique.at(-1);
  verifier(trace.vocal && trace.message.includes("six heures") && trace.operations.includes("06:15"), "historique : entendu et opérations gardés", trace);
  // Une liste « réglée » d'un bloc : on ajoute, on ne remplace pas.
  await vider();
  await gemini({ operations: [{ action: "regler", chemin: "actus.sujets_a_eviter", valeur: "people" }], reponse: "" });
  await message("pas de people");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  const evites = (await etat()).config.actus.sujets_a_eviter;
  verifier(evites.includes("sport") && evites.includes("people"), "liste complétée, pas écrasée", evites);
  // Rubrique demandée à la voix : modèle du catalogue, comme le « + » de l'application.
  await vider();
  await gemini({ operations: [{ action: "nouvelle_regle", regle: { modele: "meteo" } }], reponse: "" });
  await message("ajoute la météo le matin");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 2);
  let config = (await etat()).config;
  const meteo = config.regles.find((r) => r.titre === "Météo");
  const cles = config.deroule.map((x) => x.cle);
  verifier(meteo && meteo.recherche.sources_auto && meteo.recherche.sources.includes("meteo") && meteo.rubrique?.longueur === "phrase"
    && cles.indexOf(meteo.id) === cles.indexOf("ouverture") + 1, "rubrique du catalogue : sources, longueur et place du modèle", { meteo, cles });
  verifier(dernierTexte(liste).includes("après Ouverture") || tg(liste, "sendMessage").some((a) => a.corps.text.includes("après Ouverture")), "place annoncée");
  // Modifier sans rien de compris : erreur, pas de « modifiée ».
  await vider();
  await gemini({ operations: [{ action: "modifier_regle", id: meteo.id, regle: {} }], reponse: "C'est modifié." });
  await message("change la météo");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("quoi changer") && !dernierTexte(liste).includes("C'est modifié"), "modification vide signalée", dernierTexte(liste));
  // La déplacer et la raccourcir par la voix.
  await vider();
  await gemini({ operations: [{ action: "modifier_regle", id: meteo.id, regle: { place: "agenda", consigne: "La météo du jour en une phrase." } }], reponse: "" });
  await message("mets la météo après l'agenda");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  config = (await etat()).config;
  const cles2 = config.deroule.map((x) => x.cle);
  verifier(cles2.indexOf(meteo.id) === cles2.indexOf("agenda") + 1 && config.regles.find((r) => r.id === meteo.id).consigne.includes("une phrase"), "rubrique déplacée et modifiée", cles2);
  // Supprimer : à confirmer.
  await vider();
  await gemini({ operations: [{ action: "supprimer_regle", id: meteo.id }], reponse: "" });
  await message("supprime la météo");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("À confirmer") && (await etat()).config.regles.some((r) => r.id === meteo.id), "suppression à confirmer", dernierTexte(liste));
  await vider(); await bouton("a:conf", 642);
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(!(await etat()).config.regles.some((r) => r.titre === "Météo"), "rubrique supprimée après confirmation");
  await envoyerJson(`${BOT}/test/etat`, { config: sauvegarde });
});

await scenario("Règle : saint du jour entre l'agenda et les news", async () => {
  await gemini({ operations: [{ action: "nouvelle_regle", regle: {
    titre: "Saint du jour", consigne: "Dire le saint du jour", periode_type: "toujours",
    rubrique_titre: "Saint du jour", rubrique_apres: "agenda", rubrique_longueur: "phrase", sources: ["saints"] } }], reponse: "Règle créée." });
  await message("J'aimerais que tu me dises la Saint du jour chaque jour entre mon agenda et les news");
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 2);
  const { config } = await etat();
  const regle = config.regles.find((r) => r.titre === "Saint du jour");
  verifier(regle?.id === "R1" && regle.recherche?.sources?.includes("saints"), "règle R1 créée avec source saints", regle);
  const cles = config.deroule.map((r) => r.cle);
  verifier(cles.indexOf("R1") === cles.indexOf("agenda") + 1, "rubrique placée après l'agenda", cles);
  const fiche = tg(liste, "sendMessage").find((a) => a.corps.text.includes("R1 — Saint du jour"));
  verifier(fiche && boutons(fiche.corps).includes("m:rperiode:R1"), "fiche de la règle avec boutons", fiche?.corps?.text);
});

await scenario("Règle : boutons période, budget, pause, importance", async () => {
  // Une rubrique neuve est sans transport (« aucun », qui interdit « transport compris ») : un clic sur
  // le transport le remet à « non précisé », ce qui permet de compter le transport dans le budget.
  for (const a of ["a:rpj:R1:ven", "a:rpj:R1:sam", "a:ri:R1", "a:rb:R1:20", "a:rbu:R1", "a:rtr:R1", "a:rbt:R1"]) {
    await vider(); await bouton(a); await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  }
  let regle = (await etat()).config.regles[0];
  verifier(regle.periode.type === "jours" && regle.periode.jours.join() === "ven,sam", "jours de la règle", regle.periode);
  verifier(regle.importance === "prioritaire", "prioritaire");
  verifier(regle.recherche.fiche.budget.max === 20 && regle.recherche.fiche.budget.unite === "total" && regle.recherche.fiche.budget.transport_inclus, "budget", regle.recherche.fiche.budget);
  await vider(); await bouton("a:rbm:R1"); await attendre((l) => tg(l, "sendMessage").length >= 1);
  await message("35,50 CHF");
  await attendre((l) => tg(l, "sendMessage").length >= 2);
  regle = (await etat()).config.regles[0];
  verifier(regle.recherche.fiche.budget.max === 35.5, "budget saisi", regle.recherche.fiche.budget);
  await vider(); await bouton("a:rp:R1"); await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  verifier((await etat()).config.regles[0].etat === "pause", "règle en pause");
  await vider(); await bouton("m:regles:pause:0");
  const liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(tg(liste, "editMessageText")[0]?.corps?.text.includes("1 rubrique en pause"), "onglet pause", tg(liste, "editMessageText")[0]?.corps?.text);
  await vider(); await bouton("a:rp:R1"); await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  await vider(); await bouton("a:rpt:R1:semaine"); await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  regle = (await etat()).config.regles[0];
  verifier(regle.periode.fin === "2026-10-20", "+1 semaine", regle.periode);
});

await scenario("Sélection de règles et recherche groupée", async () => {
  await gemini({ operations: [{ action: "nouvelle_regle", regle: { titre: "Rando Jura", consigne: "Idées de randonnée", periode_type: "ponctuelle", quoi: "randonnée", ou: "Jura vaudois", sources: ["web", "meteo", "lieux"] } }], reponse: "ok" });
  await message("cherche des randos dans le Jura vaudois");
  await attendre((l) => tg(l, "sendMessage").length >= 2);
  await vider();
  await bouton("a:rx:R1:active:0"); await attendre((l) => tg(l, "editMessageText").length >= 1);
  await vider();
  await bouton("a:rx:R2:active:0");
  let liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(boutons(tg(liste, "editMessageText")[0]?.corps).includes("a:rxl:ecrit"), "boutons de lancement groupé");
  await vider();
  await bouton("a:rxl:ecrit");
  liste = await attendre((l) => lancements(l).length >= 1 && tg(l, "sendMessage").length >= 1);
  const l1 = lancements(liste)[0];
  verifier(l1?.workflow === "recherche.yml" && l1.entrees.regles === "R1,R2" && l1.entrees.format === "ecrit" && l1.ref === "main", "recherche lancée sur R1 et R2", l1);
  verifier((await etat()).etat.selection.length === 0, "sélection vidée");
});

await scenario("Assistant de recherche guidé", async () => {
  await gemini({ quoi: "activité avec les enfants", avec_qui: "en famille", ages: "6 et 9 ans", ou: "autour d'Yverdon", quand_date: "2026-10-17", transport: "", budget_max: 0 });
  await message("/recherche sortie avec les enfants (6 et 9 ans) samedi autour d'Yverdon");
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  let ecranA = tg(liste, "sendMessage").at(-1)?.corps;
  verifier(ecranA?.text.includes("Comment te déplaces-tu") && boutons(ecranA).includes("s:tr:train"), "étape transport directement", ecranA?.text);
  const id = 1000 + 0; void id;
  await vider();
  await bouton("s:tr:train", 900);
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  ecranA = tg(liste, "editMessageText")[0]?.corps;
  verifier(ecranA?.text.includes("Budget") , "étape budget", ecranA?.text);
  await vider();
  await bouton("s:bu:20", 900);
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  ecranA = tg(liste, "editMessageText")[0]?.corps;
  verifier(ecranA?.text.includes("envies"), "étape envies", ecranA?.text);
  await vider(); await bouton("s:env:interieur", 900); await attendre((l) => tg(l, "editMessageText").length >= 1);
  await vider(); await bouton("s:env:ok", 900);
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  ecranA = tg(liste, "editMessageText")[0]?.corps;
  verifier(ecranA?.text.includes("Voici ce que je vais chercher") && ecranA.text.includes("20 CHF") && ecranA.text.includes("sam. 17 oct."), "résumé de la fiche", ecranA?.text);
  await gemini({ questions: [{ question: "Combien de temps ?", options: ["2 h", "demi-journée", "journée"] }] });
  await vider(); await bouton("s:appro", 900);
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  ecranA = tg(liste, "editMessageText")[0]?.corps;
  verifier(ecranA?.text.includes("Combien de temps") && boutons(ecranA).includes("s:rep:1"), "question d'approfondissement", ecranA?.text);
  await vider(); await bouton("s:rep:1", 900);
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  await gemini({ inclure: ["avec un pique-nique"] });
  await vider();
  await message("avec un pique-nique si possible");
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  ecranA = tg(liste, "editMessageText")[0]?.corps;
  verifier(ecranA?.text.includes("pique-nique") && ecranA.text.includes("demi-journée"), "précision ajoutée au résumé", ecranA?.text);
  await vider();
  await bouton("s:fin:ecrit", 900);
  liste = await attendre((l) => lancements(l).length >= 1);
  const { config, etat: e } = await etat();
  const regle = config.regles.at(-1);
  verifier(regle.periode.type === "ponctuelle" && regle.recherche.fiche.transport === "train" && regle.recherche.fiche.budget.max === 20, "règle ponctuelle créée", regle);
  verifier(regle.recherche.sources.includes("transports") && regle.recherche.sources.includes("meteo"), "sources adaptées", regle.recherche.sources);
  verifier(lancements(liste)[0]?.entrees?.regles === regle.id && lancements(liste)[0]?.entrees?.format === "ecrit", "recherche écrite lancée", lancements(liste)[0]);
  verifier(e.assistant === null, "assistant terminé");
});

await scenario("Assistant : enregistrer dans le podcast", async () => {
  await gemini({ quoi: "randonnée", avec_qui: "entre amis", ou: "Jura", quand: "", transport: "voiture", budget_max: 30 });
  await message("/recherche rando entre amis dans le Jura en voiture, 30 francs max");
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Quand"), "demande la date", dernierTexte(liste));
  await vider(); await bouton("s:quand:2026-10-24", 901); await attendre((l) => tg(l, "editMessageText").length >= 1);
  await vider(); await bouton("s:env:meteo", 901); await attendre((l) => tg(l, "editMessageText").length >= 1);
  await vider(); await bouton("s:env:ok", 901); await attendre((l) => tg(l, "editMessageText").length >= 1);
  await vider(); await bouton("s:fin:regle", 901);
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  const regle = (await etat()).config.regles.at(-1);
  verifier(regle.periode.type === "dates" && regle.periode.debut === "2026-10-21" && regle.periode.fin === "2026-10-24", "période 3 jours avant", regle.periode);
  verifier(regle.rubrique?.apres === "agenda" && !lancements(liste).length, "rubrique dans le podcast, pas de lancement");
});

await scenario("API pour GitHub", async () => {
  const entetes = { "X-Podcast-Secret": SECRET };
  const r = await fetch(`${BOT}/api/config`, { headers: entetes });
  const donnees = await r.json();
  verifier(donnees.format === "bot-v2" && donnees.config.regles.length >= 3 && donnees.aujourdhui === "2026-10-13", "configuration exportée", Object.keys(donnees));
  verifier(donnees.heure_prevue_aujourdhui === "06:45" && donnees.flux_defaut.length === 3, "heure du jour", donnees.heure_prevue_aujourdhui);
  const ev = await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-13", titre: "Mardi 13", sujets: ["Budget vaudois", "Grève CFF", "Météo"], message_id: 4242, transcription: "Léa : Bonjour\nHugo : Salut", regles: ["R1"], mode: "planifie", debut: "2026-10-13T06:40" }, entetes);
  verifier((await ev.json()).ok === true, "événement épisode accepté");
  const { etat: e, config } = await etat();
  verifier(e.episodes.at(-1)?.message_id === 4242 && e.declenchements["2026-10-13"]?.envoye === true, "épisode enregistré", e.declenchements);
  verifier(config.regles.find((x) => x.id === "R1").derniere_application === "2026-10-13", "application de R1 notée");
  const refus = await envoyerJson(`${BOT}/api/evenement`, { type: "episode" });
  verifier(refus.status === 403, "événement sans secret refusé");
});

await scenario("Boutons sous l'épisode et avis", async () => {
  await bouton("e:2026-10-13:long", 4242);
  let liste = await attendre((l) => tg(l, "editMessageReplyMarkup").length >= 1);
  verifier((await etat()).config.format.duree_minutes === 3, "plus long", (await etat()).config.format.duree_minutes);
  const clavier = boutons(tg(liste, "editMessageReplyMarkup")[0]?.corps);
  verifier(tg(liste, "editMessageReplyMarkup")[0]?.corps?.reply_markup?.inline_keyboard.flat().some((b) => b.text === "✓ Plus long"), "bouton coché", clavier);
  await vider();
  await bouton("e:2026-10-13:cr2", 4242);
  await attendre((l) => tg(l, "editMessageReplyMarkup").length >= 1);
  verifier((await etat()).config.a_approfondir.at(-1)?.sujet === "Grève CFF", "sujet 2 à creuser");
  await vider();
  await bouton("e:2026-10-13:down", 4242);
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(boutons(tg(liste, "sendMessage")[0]?.corps).includes("f:2026-10-13:vite"), "menu « qu'est-ce qui n'allait pas »");
  await vider();
  await bouton("f:2026-10-13:vite", 5000);
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier((await etat()).config.voix.vitesse === "très lente", "trop rapide → plus lent", (await etat()).config.voix.vitesse);
  await vider();
  await bouton("e:2026-10-13:txt", 4242);
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("blockquote expandable") && dernierTexte(liste).includes("Bonjour"), "texte de l'épisode", dernierTexte(liste));
  await vider();
  await envoyer({ message_reaction: { chat: { id: CHAT }, message_id: 4242, user: { id: CHAT }, date: 0, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } });
  await attente(800);
  verifier((await etat()).etat.episodes.at(-1).avis === "up", "réaction 👍 enregistrée");
});

await scenario("Épisodes à la demande et limite du jour", async () => {
  for (let i = 0; i < 6; i++) {
    await vider();
    await message("/podcast");
    const liste = await attendre((l) => lancements(l).length >= 1 && tg(l, "sendMessage").length >= 1);
    verifier(lancements(liste)[0]?.entrees?.mode === "manuel", `épisode à la demande ${i + 1}`, lancements(liste)[0]);
  }
  await vider();
  await message("/podcast");
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(!lancements(liste).length && dernierTexte(liste).includes("maximum"), "7e refusé", dernierTexte(liste));
});

await scenario("Planning automatique : lancement, rattrapage, réveil", async () => {
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...(await etat()).etat, declenchements: {}, refaits: {} } }) });
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
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-15", titre: "Jeudi", sujets: [], message_id: 5555, mode: "planifie" }, { "X-Podcast-Secret": SECRET });
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
  await vider();
  await message("vendredi exceptionnellement à 5h30");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  await vider();
  await horloge("2026-10-16T05:25", true);
  verifier(lancements(await appels())[0]?.entrees?.mode === "planifie", "exception respectée (5 h 25)");
  // Échec de GitHub : nouvel essai plus tard, sans boucle.
  await horloge("2026-10-13T10:00");
});

await scenario("Sauvegarde quotidienne", async () => {
  const avant = (await etat()).etat;
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...avant, sauvegarde: "2026-10-01" } }) });
  await bouton("a:gd");
  await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  await vider();
  await horloge("2026-10-19T03:05", true);
  const liste = await appels();
  const ecriture = liste.find((a) => a.methode === "ecrire" && a.chemin === "preferences.json");
  verifier(ecriture?.message?.includes("Sauvegarde"), "sauvegarde à 3 h", ecriture);
  const fichiers = await (await fetch(`${FAUX}/control/fichiers`)).json();
  const sauvegarde = JSON.parse(fichiers["preferences.json"]);
  verifier(sauvegarde.format === "bot-v2" && sauvegarde.config.regles.length >= 3, "contenu de la sauvegarde");
  // Le bot perd ses réglages (supprimé, recréé) : il repart de sa sauvegarde, rubriques comprises.
  const avantPerte = (await etat()).config;
  await envoyerJson(`${BOT}/test/etat`, { oublier_config: true });
  verifier(!(await etat()).config, "réglages effacés pour le test");
  await obtenir(`${BOT}/api/config`, { headers: { "X-Podcast-Secret": SECRET } });
  const restauree = (await etat()).config;
  verifier(restauree?.regles?.length === avantPerte.regles.length && JSON.stringify(restauree.deroule) === JSON.stringify(avantPerte.deroule)
    && restauree.format.duree_minutes === avantPerte.format.duree_minutes, "réglages restaurés depuis la sauvegarde",
    { avant: avantPerte.regles.length, apres: restauree?.regles?.length });
  await horloge("2026-10-13T10:00");
});

await scenario("Position partagée", async () => {
  await message(undefined, { location: { latitude: 46.7785, longitude: 6.6411 } });
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Yverdon-les-Bains") && boutons(tg(liste, "sendMessage")[0]?.corps).includes("a:pville"), "lieu reconnu", dernierTexte(liste));
  await vider();
  await bouton("a:pville");
  await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  verifier((await etat()).config.actus.ville === "Yverdon-les-Bains", "devient ma ville");
});

await scenario("Sources : ajout par adresse, retrait", async () => {
  await bouton("a:asa");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  await message(`${FAUX}/site/page.html`);
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 2);
  let { config } = await etat();
  verifier(config.actus.flux?.length === 4 && config.actus.flux.at(-1).url.endsWith("/rss/flux.xml"), "flux trouvé depuis la page", config.actus.flux);
  verifier(config.actus.flux.at(-1).nom === "La Région", "nom du flux", config.actus.flux.at(-1));
  await vider();
  await bouton("a:asr:2");
  await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  ({ config } = await etat());
  verifier(config.actus.flux.length === 3 && !config.actus.flux.some((f) => f.nom === "Le Monde"), "Le Monde retiré", config.actus.flux.map((f) => f.nom));
  await vider();
  await gemini({ operations: [{ action: "retirer_source", valeur: "RTS" }], reponse: "RTS retirée." });
  await message("enlève la RTS");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  ({ config } = await etat());
  verifier(!config.actus.flux.some((f) => f.nom.includes("RTS")), "retrait par la parole", config.actus.flux.map((f) => f.nom));
});

await scenario("Message vocal", async () => {
  await gemini({ operations: [{ action: "regler", chemin: "format.nombre_sujets", valeur: "5" }], reponse: "Cinq sujets." });
  await message(undefined, { voice: { file_id: "abc", duration: 4, mime_type: "audio/ogg" } });
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  const appel = liste.find((a) => a.service === "gemini")?.corps;
  verifier(appel?.input?.some((c) => c.type === "audio" && c.mime_type === "audio/ogg"), "audio transmis à Gemini");
  verifier((await etat()).config.format.nombre_sujets === 5, "réglage appliqué depuis le vocal");
});

await scenario("Robustesse", async () => {
  const avant = updateId;
  await envoyerJson(`${BOT}/telegram`, { update_id: avant - 1, message: { message_id: 1, chat: { id: CHAT }, from: { id: CHAT }, text: "/menu" } }, { "X-Telegram-Bot-Api-Secret-Token": SECRET });
  await attente(600);
  verifier(!tg(await appels(), "sendMessage").length, "mise à jour déjà vue ignorée");
  await envoyer({ message: { message_id: 1, chat: { id: 999 }, from: { id: 999 }, text: "/menu" } });
  await attente(600);
  verifier(!tg(await appels(), "sendMessage").length, "autre conversation ignorée");
  await envoyerJson(`${FAUX}/control/gemini-panne`, { panne: true });
  await message("mets le podcast à 7h");
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Gemini ne répond pas"), "Gemini en panne → message clair", dernierTexte(liste));
  await envoyerJson(`${FAUX}/control/gemini-panne`, { panne: false });
  await vider();
  await bouton("s:quoi:culture");
  const l2 = await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  verifier(toast(l2).includes("terminée"), "bouton d'assistant périmé", toast(l2));
  await vider();
  await bouton("a:rsy:R99");
  const l3 = await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  verifier(toast(l3).includes("introuvable"), "règle inconnue signalée", toast(l3));
});

await scenario("Sondage sur des résultats", async () => {
  await envoyerJson(`${BOT}/api/evenement`, { type: "recherche", regles: ["R2"], idees: ["Grottes de Vallorbe", "Musée de la mode"], sondage: { poll_id: "5551234567890123456", options: ["Grottes de Vallorbe", "Musée de la mode"], regle: "R2" } }, { "X-Podcast-Secret": SECRET });
  await envoyer({ poll_answer: { poll_id: "5551234567890123456", user: { id: CHAT }, option_ids: [0] } });
  let liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Grottes de Vallorbe") && boutons(tg(liste, "sendMessage")[0].corps).includes("a:sdr:5551234567890123456:0"), "vote reçu", dernierTexte(liste));
  await vider();
  await bouton("a:sdr:5551234567890123456:0");
  await attendre((l) => tg(l, "answerCallbackQuery").length >= 1);
  verifier((await etat()).config.regles.find((r) => r.id === "R2").recherche.fiche.inclure.some((x) => x.includes("Vallorbe")), "idée retenue dans R2");
  await vider();
  await bouton("a:sdd:5551234567890123456:0");
  liste = await attendre((l) => lancements(l).length >= 1);
  verifier(lancements(liste)[0]?.workflow === "recherche.yml", "recherche de détails lancée", lancements(liste));
});

await scenario("Tableau de bord et commandes", async () => {
  await message("/reglages");
  let liste = await attendre((l) => tg(l, "pinChatMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Tableau de bord") && tg(liste, "unpinChatMessage").length === 1, "nouveau tableau épinglé");
  await vider();
  await message("🎙️ Podcast");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Prochain épisode"), "bouton fixe Podcast", dernierTexte(liste));
  await vider();
  await message("/aide");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Parle-moi simplement"), "aide");
  await vider();
  await bouton("a:ra");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(dernierTexte(liste).includes("Assistant de recherche"), "assistant depuis les règles");
});

await scenario("Modèles légers mis à jour par GitHub", async () => {
  await envoyerJson(`${BOT}/api/evenement`, { type: "modeles", rapides: ["gemini-9.9-flash-lite", "pas-un-modele"] }, { "X-Podcast-Secret": SECRET });
  await gemini({ operations: [], reponse: "Bonjour !" });
  await message("salut");
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(liste.find((a) => a.service === "gemini")?.corps?.model === "gemini-9.9-flash-lite", "le bot utilise la liste découverte", liste.find((a) => a.service === "gemini")?.corps?.model);
});

await scenario("Détails des idées, extraits de voix, autre heure", async () => {
  const entetes = { "X-Podcast-Secret": SECRET };
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-13", titre: "Avec idées", sujets: ["A", "B"], message_id: 6060, mode: "manuel", details: ["R2"] }, entetes);
  await bouton("e:2026-10-13:court", 6060);
  let liste = await attendre((l) => tg(l, "editMessageReplyMarkup").length >= 1);
  const clavier = boutons(tg(liste, "editMessageReplyMarkup")[0]?.corps);
  verifier(clavier.includes("a:rl:R2:ecrit") && clavier.includes("e:2026-10-13:cr2") && !clavier.includes("e:2026-10-13:cr3"), "bouton Détails conservé après un clic", clavier);
  await envoyerJson(`${BOT}/api/evenement`, { type: "echantillon", voix: "Aoede", file_id: "F1", legende: "🎤 Aoede puis Kore" }, entetes);
  await envoyerJson(`${BOT}/api/evenement`, { type: "echantillon", voix: "Kore", file_id: "F1", legende: "🎤 Aoede puis Kore" }, entetes);
  await vider();
  await bouton("a:vx");
  liste = await attendre((l) => tg(l, "sendAudio").length >= 1 && (lancements(l).length >= 1 || tg(l, "sendMessage").length >= 1));
  verifier(tg(liste, "sendAudio").length === 1 && tg(liste, "sendAudio")[0].corps.caption.includes("Aoede puis Kore"), "un seul envoi pour la paire, légende gardée", tg(liste, "sendAudio").map((a) => a.corps.caption));
  verifier(lancements(liste)[0]?.workflow === "echantillons.yml" && lancements(liste)[0].entrees.voix.split(",").length === 4 && !lancements(liste)[0].entrees.voix.includes("Aoede"),
    "extraits manquants demandés (4 au plus)", lancements(liste)[0]);
  await vider();
  await bouton("a:vx");
  liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  verifier(!lancements(liste).length && dernierTexte(liste).includes("demain"), "un seul lot d'extraits par jour", dernierTexte(liste));
  await vider();
  await bouton("a:phs:mer");
  await attendre((l) => tg(l, "sendMessage").length >= 1);
  await message("5h40");
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier((await etat()).config.planning.jours.mer === "05:40", "autre heure saisie pour le mercredi", (await etat()).config.planning.jours.mer);
  await envoyerJson(`${BOT}/api/evenement`, { type: "recherche", regles: ["R2"], idees: ["Grottes"], sondage: null }, entetes);
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetes })).json();
  verifier(exp.derniers_resultats?.idees?.[0] === "Grottes", "derniers résultats exportés (pour « D'autres idées »)", exp.derniers_resultats);
  await vider();
  await bouton("a:re:R1");
  liste = await attendre((l) => tg(l, "answerCallbackQuery").length >= 1 && tg(l, "sendMessage").length >= 1);
  verifier(lancements(liste)[0]?.entrees?.regles === "R1" || dernierTexte(liste).includes("maximum"), "essayer une règle dans un épisode", dernierTexte(liste));
});


// ───────────────────────────── version « rubriques » ─────────────────────────────

const saisir = async (donnees, texte) => {
  await vider();
  await bouton(donnees);
  await attendre((l) => tg(l, "sendMessage").some((a) => a.corps?.reply_markup?.force_reply));
  await vider();
  await message(texte);
  return attendre((l) => tg(l, "sendMessage").length >= 1 || tg(l, "editMessageText").length >= 1);
};
const cliquer = async (donnees) => { await vider(); await bouton(donnees); return attendre((l) => tg(l, "answerCallbackQuery").length >= 1); };
const entetesApi = { "X-Podcast-Secret": SECRET };

await scenario("Rubriques : numérotation automatique", async () => {
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...(await etat()).etat, assistant: null, attente: null } }) });
  await horloge("2026-10-13T10:00");
  const avant = (await etat()).config.regles.length;
  for (const titre of ["Alpha", "Bravo", "Charlie"]) {
    await gemini({ operations: [{ action: "nouvelle_regle", regle: { titre, consigne: `Parler de ${titre}`, periode_type: "toujours", rubrique_titre: titre, rubrique_apres: "agenda" } }], reponse: "ok" });
    await message(`ajoute une rubrique ${titre}`);
    await attendre((l) => tg(l, "sendMessage").length >= 2);
    await vider();
  }
  let { config } = await etat();
  verifier(config.regles.map((r) => r.id).join() === Array.from({ length: avant + 3 }, (_, i) => `R${i + 1}`).join(), "numéros consécutifs", config.regles.map((r) => `${r.id}:${r.titre}`));
  const bravo = config.regles.find((r) => r.titre === "Bravo");
  const numeroBravo = Number(bravo.id.slice(1));
  await cliquer(`a:rsy:R${numeroBravo - 1}`);                       // supprime la rubrique juste avant Bravo
  ({ config } = await etat());
  verifier(config.regles.map((r) => r.id).join() === Array.from({ length: avant + 2 }, (_, i) => `R${i + 1}`).join(), "après suppression : renumérotées", config.regles.map((r) => r.id));
  verifier(config.regles.find((r) => r.titre === "Bravo").id === `R${numeroBravo - 1}`, "Bravo a remonté d'un rang");
  const cles = config.deroule.map((r) => r.cle);
  verifier(cles.every((c) => !/^R\d+$/.test(c) || config.regles.some((r) => r.id === c)) && new Set(cles).size === cles.length, "déroulé cohérent après renumérotation", cles);
  verifier(config.regles.every((r) => !r.rubrique || /^(R\d+|[a-z_]+)$/.test(r.rubrique.apres) && (!/^R\d+$/.test(r.rubrique.apres) || config.regles.some((x) => x.id === r.rubrique.apres))), "références « après » cohérentes");
});

await scenario("Rubriques : édition de tous les paramètres", async () => {
  const id = (await etat()).config.regles.find((r) => r.titre === "Charlie").id;
  let liste = await saisir(`a:rf:${id}:titre`, "Charlie le retour");
  let r = (await etat()).config.regles.find((x) => x.id === id);
  verifier(r.titre === "Charlie le retour" && r.rubrique.titre === "Charlie le retour", "titre modifié (rubrique aussi)", r.titre);
  await saisir(`a:rf:${id}:consigne`, "Donne une idée de sortie.");
  await saisir(`a:rf:${id}:quoi`, "balade en forêt");
  await saisir(`a:rf:${id}:ou`, "Yverdon-les-Bains");
  await saisir(`a:rf:${id}:rayon_km`, "12 km");
  await saisir(`a:rf:${id}:avec_qui`, "deux enfants");
  await saisir(`a:rf:${id}:inclure`, "pique-nique, jeux");
  await saisir(`a:rf:${id}:requetes`, "balade enfants Yverdon ; sentier lac Neuchâtel");
  r = (await etat()).config.regles.find((x) => x.id === id);
  const f = r.recherche.fiche;
  verifier(r.consigne === "Donne une idée de sortie." && f.quoi === "balade en forêt" && f.ou === "Yverdon-les-Bains" && f.rayon_km === 12 && f.avec_qui === "deux enfants", "champs texte", f);
  verifier(f.inclure.join() === "pique-nique,jeux" && r.recherche.requetes.length === 2, "listes", r.recherche);
  verifier((await etat()).config.regles.find((x) => x.id === id).recherche.fiche.transport === "aucun", "nouvelle rubrique : pas de transport par défaut");
  await cliquer(`a:rtr:${id}`); await cliquer(`a:rtr:${id}`);   // « aucun » → non précisé → voiture
  verifier((await etat()).config.regles.find((x) => x.id === id).recherche.fiche.transport === "voiture", "transport suivant");
  await cliquer(`a:rs:${id}:meteo`); await cliquer(`a:rs:${id}:lieux`);
  verifier((await etat()).config.regles.find((x) => x.id === id).recherche.sources.includes("meteo"), "source ajoutée");
  await saisir(`a:rf:${id}:condition`, "un match de foot");
  await cliquer(`a:rcm:${id}:veille`);
  r = (await etat()).config.regles.find((x) => x.id === id);
  verifier(r.condition?.texte === "un match de foot" && r.condition.moment === "veille", "condition d'agenda", r.condition);
  await cliquer(`a:rcx:${id}`);
  verifier(!(await etat()).config.regles.find((x) => x.id === id).condition, "condition retirée");
  await cliquer(`a:rpl:${id}:actualites`); await cliquer(`a:rlg:${id}:developpee`);
  r = (await etat()).config.regles.find((x) => x.id === id);
  const cles = (await etat()).config.deroule.map((x) => x.cle);
  verifier(r.rubrique.apres === "actualites" && r.rubrique.longueur === "developpee" && cles.indexOf(id) === cles.indexOf("actualites") + 1, "place et longueur", { r: r.rubrique, cles });
  await saisir(`a:rf:${id}:quoi`, "-");
  verifier((await etat()).config.regles.find((x) => x.id === id).recherche.fiche.quoi === "", "champ vidé avec « - »");
  for (const ecran of [`regle:${id}`, `rrech:${id}`, `rsrc:${id}`, `rcond:${id}`, `rplace:${id}`, `rperiode:${id}`, `rbudget:${id}`]) {
    await vider(); await bouton(`m:${ecran}`);
    liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
    verifier(tg(liste, "editMessageText")[0]?.corps?.text.length > 20, `écran ${ecran}`, tg(liste, "editMessageText")[0]?.corps?.text);
    const donnees = boutons(tg(liste, "editMessageText")[0]?.corps).filter((x) => x.length <= 64);
    verifier(boutons(tg(liste, "editMessageText")[0]?.corps).every((x) => Buffer.byteLength(x) <= 64), `boutons ≤ 64 octets (${ecran})`, donnees);
  }
});

await scenario("Consignes : modifier une consigne", async () => {
  const avant = (await etat()).config.consignes.length;
  await saisir("a:ca", "plus d'humour");
  await saisir("a:ca", "un point sur Yverdon");
  await saisir(`a:ce:${avant + 1}`, "toujours un point sur Yverdon-les-Bains");
  const consignes = (await etat()).config.consignes;
  verifier(consignes.slice(avant).join("|") === "plus d'humour|toujours un point sur Yverdon-les-Bains" && consignes.length === avant + 2, "consigne modifiée en place", consignes);
  await vider(); await bouton("m:consignes");
  const liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(boutons(tg(liste, "editMessageText")[0].corps).includes(`a:ce:${avant}`), "bouton de modification", boutons(tg(liste, "editMessageText")[0].corps));
});

await scenario("Rattrapage : délai réglable et désactivation", async () => {
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...(await etat()).etat, declenchements: {}, refaits: {} } }) });
  await cliquer("a:prd:30");
  let p = (await etat()).config.planning;
  verifier(p.rattrapage && p.delai_rattrapage === 30, "délai 30 min", p);
  await saisir("a:prds", "40");
  verifier((await etat()).config.planning.delai_rattrapage === 40, "autre délai saisi");
  await cliquer("a:prd:30");
  // mercredi 21 octobre : épisode à 5 h 40 (réglé plus haut), préparation à 5 h 35.
  await horloge("2026-10-21T05:35", true);
  verifier(lancements(await appels())[0]?.entrees?.mode === "planifie", "lancement à 5 h 35");
  await vider();
  await horloge("2026-10-21T06:05", true);
  verifier(!lancements(await appels()).length, "pas de rattrapage avant 30 min");
  await horloge("2026-10-21T06:11", true);
  verifier(lancements(await appels())[0]?.entrees?.mode === "rattrapage", "rattrapage 30 min après l'heure prévue", lancements(await appels()));
  // Désactivé : plus de rattrapage.
  await cliquer("a:prat");
  verifier((await etat()).config.planning.rattrapage === false, "rattrapage désactivé");
  await horloge("2026-10-28T05:35", true);
  await vider();
  await horloge("2026-10-28T07:30", true);
  verifier(!lancements(await appels()).length, "aucun rattrapage quand il est désactivé");
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.episode_lance_aujourdhui !== undefined && exp.config.planning.delai_rattrapage === 30, "export pour le filet de GitHub", exp.config.planning);
  await cliquer("a:prat");
  await vider(); await bouton("m:rattrapage");
  const liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(tg(liste, "editMessageText")[0].corps.text.includes("30 min"), "écran du rattrapage", tg(liste, "editMessageText")[0].corps.text);
});

await scenario("Agendas : liste, cases à cocher, lecture", async () => {
  await envoyerJson(`${BOT}/api/evenement`, { type: "agendas", liste: [{ id: "aaaa111111", nom: "Perso (Google)", nb: 12 }, { id: "bbbb222222", nom: "Travail (Outlook)", nb: 30 }, { id: "../mauvais", nom: "x", nb: 1 }] }, entetesApi);
  await vider(); await bouton("m:agendas");
  let liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  const texte = tg(liste, "editMessageText")[0].corps.text;
  verifier(texte.includes("Perso (Google)") && texte.includes("Travail (Outlook)") && !texte.includes("mauvais"), "agendas listés (identifiant invalide ignoré)", texte);
  await cliquer("a:gx:bbbb222222");
  verifier((await etat()).config.agenda.exclus.join() === "bbbb222222", "agenda décoché");
  await cliquer("a:gx:aaaa111111");
  verifier((await etat()).config.agenda.exclus.join() === "bbbb222222", "au moins un agenda reste actif");
  await cliquer("a:gx:bbbb222222");
  verifier((await etat()).config.agenda.exclus.length === 0, "agenda recoché");
  await cliquer("a:gr");
  verifier(lancements(await appels())[0]?.workflow === "agendas.yml", "lecture des agendas demandée");
});

await scenario("Rubriques intégrées : déroulé, actu locale, déplacements, à creuser", async () => {
  await vider(); await bouton("m:deroule");
  let liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  const corps = tg(liste, "editMessageText")[0].corps;
  const b = boutons(corps);
  verifier(corps.text.includes("Actu locale") && corps.text.includes("Mes déplacements") && corps.text.includes("À creuser"), "déroulé : noms des rubriques", corps.text);
  verifier(b.includes("m:actulocale") && b.includes("m:deplacements") && b.includes("m:acreuser") && b.some((x) => /^m:regle:R\d+$/.test(x)), "chaque rubrique ouvre son écran", b);
  for (const ecran of ["actulocale", "deplacements", "acreuser", "agenda", "rattrapage"]) {
    await vider(); await bouton(`m:${ecran}`);
    liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
    verifier(tg(liste, "editMessageText")[0]?.corps?.text.length > 20, `écran ${ecran}`);
  }
  await cliquer("a:aln:+"); await cliquer("a:gmx:+"); await cliquer("a:dt:actu_locale:actulocale");
  let { config } = await etat();
  verifier(config.actus.locale_articles === 4 && config.agenda.max_deplacements === 3 && config.deroule.find((x) => x.cle === "actu_locale").actif === false, "réglages des rubriques intégrées", { a: config.actus.locale_articles, d: config.agenda.max_deplacements });
  await cliquer("a:dt:actu_locale:actulocale");
  await saisir("a:aca", "la réforme des retraites");
  verifier((await etat()).config.a_approfondir.some((x) => x.sujet === "la réforme des retraites"), "sujet à creuser ajouté");
  await cliquer("a:acx:0");
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.config.deroule.some((x) => x.cle === "actu_locale") && exp.agendas.length === 2, "export : actu_locale et agendas", exp.agendas);
});

await scenario("Rubrique : période saisie à la main", async () => {
  await horloge("2026-10-13T10:00");
  const id = (await etat()).config.regles[0].id;
  for (const [texte, debut, fin] of [["jusqu'au 15 novembre", null, "2026-11-15"], ["du 20 au 24 octobre", "2026-10-20", "2026-10-24"], ["à partir du 3/11", "2026-11-03", null]]) {
    await saisir(`a:rpf:${id}`, texte);
    const p = (await etat()).config.regles.find((r) => r.id === id).periode;
    verifier(["dates", "jours"].includes(p.type) && p.debut === debut && p.fin === fin, `période « ${texte} »`, p);
  }
  await vider(); await bouton(`m:rperiode:${id}`);
  const liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(tg(liste, "editMessageText")[0].corps.text.includes("à partir du"), "la période s'affiche", tg(liste, "editMessageText")[0].corps.text);
});

await scenario("Rubrique : jeudis seulement = à venir ; longueur sans place ; transport sans critère", async () => {
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...(await etat()).etat, assistant: null, attente: null } }) });
  await horloge("2026-10-14T10:00");                       // mercredi
  await gemini({ operations: [{ action: "nouvelle_regle", regle: { titre: "Jeudi seulement", consigne: "Un mot du jeudi", transport: "peu_importe" } }], reponse: "ok" });
  await message("ajoute une rubrique du jeudi");
  await attendre((l) => tg(l, "sendMessage").length >= 2);
  const id = (await etat()).config.regles.find((r) => r.titre === "Jeudi seulement").id;
  verifier(["", "aucun", undefined].includes((await etat()).config.regles.find((r) => r.id === id).recherche?.fiche?.transport), "« peu importe » = aucun critère de transport");
  await cliquer(`a:rpj:${id}:jeu`);
  await vider(); await bouton("m:regles:avenir:0");
  let liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(tg(liste, "editMessageText")[0].corps.text.includes("Jeudi seulement") === false && boutons(tg(liste, "editMessageText")[0].corps).includes(`m:regle:${id}`), "rubrique du jeudi dans « À venir » un mercredi", boutons(tg(liste, "editMessageText")[0].corps));
  await vider(); await bouton(`m:regle:${id}`);
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(tg(liste, "editMessageText")[0].corps.text.includes("Prochain passage : jeu. 15 oct."), "prochain passage affiché", tg(liste, "editMessageText")[0].corps.text);
  await horloge("2026-10-15T10:00");                       // jeudi
  await vider(); await bouton("m:regles:active:0");
  liste = await attendre((l) => tg(l, "editMessageText").length >= 1);
  verifier(boutons(tg(liste, "editMessageText")[0].corps).includes(`m:regle:${id}`), "active le jeudi");
  await cliquer(`a:rlg:${id}:developpee`);
  const r = (await etat()).config.regles.find((x) => x.id === id);
  verifier(r.rubrique?.longueur === "developpee" && (await etat()).config.deroule.some((x) => x.cle === id), "longueur réglable sans avoir choisi de place", r.rubrique);
});

// ─────────────────────────── application (Mini App) ─────────────────────────

function ouverture({ utilisateur = CHAT, age = 0, falsifier = false } = {}) {
  const champs = { auth_date: String(Math.floor(Date.now() / 1000) - age), query_id: "AAHtest", user: JSON.stringify({ id: utilisateur, first_name: "Test" }) };
  const aVerifier = Object.keys(champs).sort().map((k) => `${k}=${champs[k]}`).join("\n");
  const cle = createHmac("sha256", "WebAppData").update("123:TEST").digest();
  let signature = createHmac("sha256", cle).update(aVerifier).digest("hex");
  if (falsifier) signature = `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
  return new URLSearchParams({ ...champs, hash: signature }).toString();
}
async function app(action, extra = {}, options = {}) {
  const r = await envoyerJson(`${BOT}/app/api`, { action, ...extra }, options.sans ? {} : { "X-Telegram-Init-Data": options.initData ?? ouverture() });
  return { statut: r.status, ...(await r.json().catch(() => ({}))) };
}

await scenario("Application : page et contrôle de l'ouverture", async () => {
  const page = await obtenir(`${BOT}/app`);
  verifier(page.statut === 200 && page.texte.includes("telegram-web-app.js") && page.texte.includes("Podcast Matin"), "la page de l'application est servie", page.statut);
  verifier((await app("etat", {}, { sans: true })).statut === 401, "sans signature : refusé");
  verifier((await app("etat", {}, { initData: ouverture({ falsifier: true }) })).statut === 401, "signature falsifiée : refusé");
  verifier((await app("etat", {}, { initData: ouverture({ utilisateur: 999 }) })).statut === 401, "autre utilisateur : refusé");
  verifier((await app("etat", {}, { initData: ouverture({ age: 2 * 86400 }) })).statut === 401, "ouverture trop ancienne : refusée");
  verifier((await fetch(`${BOT}/app/api`)).status === 405, "GET sur l'API refusé");
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
  ({ config } = await etat());
  regle = config.regles.find((x) => x.id === id);
  verifier(r.ok && regle.titre === "Météo" && regle.rubrique === null && regle.recherche === null && regle.etat === "pause" && !config.deroule.some((x) => x.cle === id), "modifiée : sans passage, sans source, en pause", regle);
  verifier((await etat()).etat.annulations.at(-1)?.libelle?.includes("modifiée"), "le changement peut être annulé avec /annuler", (await etat()).etat.annulations.at(-1)?.libelle);
  r = await app("rubrique", { id: "R99", formulaire: { titre: "a", consigne: "b" } });
  verifier(r.ok === false, "rubrique inconnue refusée");
  r = await app("supprimer", { id });
  verifier(r.ok && !(await etat()).config.regles.some((x) => x.titre === "Météo"), "rubrique supprimée", r.erreur);
});

await scenario("Application : déroulé et place des rubriques", async () => {
  let r = await app("rubrique", { formulaire: { titre: "Citation", consigne: "Une citation", longueur: "phrase", periode: { type: "toujours" } } });
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
  r = await app("rubrique", { id, formulaire: { titre: "Citation du jour", consigne: "Une citation", longueur: "courte", periode: { type: "toujours" } } });
  ({ config } = await etat());
  verifier(config.deroule.findIndex((x) => x.cle === id) === 1, "modifier une rubrique ne la déplace pas", config.deroule.map((x) => x.cle));
  await cliquer(`a:rlg:${id}:developpee`);
  ({ config } = await etat());
  verifier(config.deroule.findIndex((x) => x.cle === id) === 1, "dans le bot non plus", config.deroule.map((x) => x.cle));
  await app("deroule", { ordre: config.deroule.map((x) => x.cle), actifs: { agenda: true } });
  await app("supprimer", { id });
});

await scenario("Application : sauter un épisode, générer, ouvrir le planning", async () => {
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
  await vider();
  r = await app("ouvrir", { ecran: "planning" });
  verifier(r.ok && tg(await appels(), "sendMessage").length === 1, "écran du planning envoyé dans la conversation");
  verifier((await app("ouvrir", { ecran: "../x" })).ok === false, "écran inconnu refusé");
  verifier((await app("bidule")).ok === false, "action inconnue refusée");
});

await scenario("Application : bouton dans le tableau de bord (https)", async () => {
  const courant = (await etat()).etat;
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...courant, adresse: "https://podcast.exemple.workers.dev" } }) });
  await vider();
  await message("/reglages");
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  const clavier = tg(liste, "sendMessage").at(-1)?.corps?.reply_markup?.inline_keyboard?.flat() || [];
  verifier(clavier.some((b) => b.web_app?.url === "https://podcast.exemple.workers.dev/app"), "bouton « Ouvrir l'application »", clavier);
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...(await etat()).etat, adresse: courant.adresse } }) });
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
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-19", titre: "Lundi tranquille", message_id: 4242, file_id: "AUDIO123",
    sujets: ["Sujet A", "Sujet B"], chapitres: [[0, "Ouverture"], [30, "Actualités"]], transcription: "Léa : Bonjour !", mode: "planifie", duree: 15 }, entetesApi);
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
  verifier(r.ok && r.donnees.episodes[0].avis === "up", "avis positif");
  const avant = (await etat()).config.format.duree_minutes;
  r = await app("geste", { cle: ep.cle, geste: "court" });
  verifier(r.ok && (await etat()).config.format.duree_minutes === avant - 1 && r.donnees.episodes[0].coches.includes("court"), "plus court", r.erreur);
  r = await app("geste", { cle: ep.cle, geste: "cr2" });
  verifier(r.ok && r.donnees.reglages.a_approfondir.includes("Sujet B"), "sujet à creuser depuis l'épisode");
  r = await app("texte", { cle: ep.cle });
  verifier(r.ok && r.texte === "Léa : Bonjour !", "texte de l'épisode");
  verifier((await app("geste", { cle: "ep:2020-01-01", geste: "up" })).ok === false, "épisode inconnu refusé");
  await app("regler", { chemin: "format.duree_minutes", valeur: avant });
});

await scenario("Application : demande libre, recherche, résultats", async () => {
  await horloge("2026-10-19T10:00");
  await gemini({ operations: [{ action: "regler", chemin: "voix.vitesse", valeur: "lente" }], reponse: "Je parlerai plus lentement." });
  await vider();
  let r = await app("parler", { texte: "parle plus lentement" });
  verifier(r.ok && r.reponse.includes("lentement") && r.changements.length === 1 && (await etat()).config.voix.vitesse === "lente", "demande comprise et appliquée", r);
  verifier(tg(await appels(), "sendMessage").length === 0, "rien n'est écrit dans la conversation");
  await gemini({ operations: [{ action: "afficher", valeur: "planning" }], reponse: "Voici le planning." });
  r = await app("parler", { texte: "montre le planning" });
  verifier(r.ok && r.ouvrir?.ecran === "planning", "demande d'affichage traduite en écran", r.ouvrir);
  await envoyerJson(`${FAUX}/control/gemini-panne`, { panne: true });
  r = await app("parler", { texte: "bonjour" });
  verifier(r.ok === false && r.erreur.includes("Gemini"), "Gemini en panne : message clair");
  await envoyerJson(`${FAUX}/control/gemini-panne`, { panne: false });
  r = await app("rubrique", { formulaire: { titre: "Sortie samedi", consigne: "Une activité en famille", periode: { type: "ponctuelle" },
    fiche: { quoi: "activité en famille", ou: "Yverdon" }, transport: "train", budget: { max: "20", unite: "personne" }, inclure: "piscine, musée" } });
  const id = r.id;
  let regle = (await etat()).config.regles.find((x) => x.id === id);
  verifier(r.ok && regle.periode.type === "ponctuelle" && regle.recherche.fiche.transport === "train" && regle.recherche.fiche.budget.max === 20
    && regle.recherche.fiche.inclure.join() === "piscine,musée" && !(await etat()).config.deroule.some((x) => x.cle === id), "recherche ponctuelle créée avec budget et transport", regle);
  await vider();
  r = await app("recherche", { id, format: "ecrit" });
  const liste = await appels();
  verifier(r.ok && lancements(liste).some((a) => a.workflow === "recherche.yml") && tg(liste, "sendMessage").length === 0, "recherche lancée en silence", r);
  await envoyerJson(`${BOT}/api/evenement`, { type: "recherche", regles: [id], idees: ["Piscine"], resultats: [{ regle: id, titre: "Sortie samedi", intro: "Deux idées.",
    idees: [{ titre: "Piscine", resume: "Bassin couvert", lien: "javascript:alert(1)", prix: "8 CHF", dans_le_budget: true }, { titre: "" }] }] }, entetesApi);
  r = await app("etat");
  const det = r.donnees.resultats?.details?.[0];
  verifier(det?.idees.length === 1 && det.idees[0].titre === "Piscine" && det.idees[0].lien === "" && det.idees[0].dans_le_budget, "résultats gardés pour l'application (liens nettoyés)", det);
  await app("supprimer", { id });
  await app("regler", { chemin: "voix.vitesse", valeur: "normale" });
});

await scenario("Application : bouton d'accueil et export pour GitHub", async () => {
  const courant = (await etat()).etat;
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...courant, adresse: "https://podcast.exemple.workers.dev" } }) });
  await vider();
  await message("/aide");
  const liste = await attendre((l) => tg(l, "sendMessage").length >= 1);
  const corps = tg(liste, "sendMessage").at(-1)?.corps;
  verifier(corps?.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url === "https://podcast.exemple.workers.dev/app" && !corps.reply_markup.keyboard, "l'aide ouvre l'application, sans clavier fixe", corps?.reply_markup);
  const exp = await (await fetch(`${BOT}/api/config`, { headers: entetesApi })).json();
  verifier(exp.app === "https://podcast.exemple.workers.dev/app", "adresse de l'application transmise à GitHub", exp.app);
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...(await etat()).etat, adresse: courant.adresse } }) });
});

await scenario("Application : épisodes anciens, sources, extraits par voix", async () => {
  await horloge("2026-10-20T08:00");
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-20", titre: "Mardi", message_id: 5151, mode: "planifie",
    sources: [{ titre: "Article A", url: "https://exemple.ch/a" }, { titre: "Piège", url: "javascript:alert(1)" }] }, entetesApi);
  // Un épisode envoyé avant l'application (ni fichier ni sources connus).
  const courant = (await etat()).etat;
  courant.episodes.push({ date: "2026-10-20", titre: "Ancien format", message_id: 6161, sujets: [], coches: [], chapitres: [] });
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: courant }) });
  await vider();
  let r = await app("etat");
  const neuf = r.donnees.episodes.find((x) => x.titre === "Mardi");
  verifier(neuf?.sources.length === 1 && neuf.sources[0].url === "https://exemple.ch/a", "sources de l'épisode (adresses https seulement)", neuf?.sources);
  const ancien = r.donnees.episodes.find((x) => x.titre === "Ancien format");
  verifier(ancien?.audio && ancien.sources.length === 2 && ancien.sources[0].titre.startsWith("rts.ch · Grève") && ancien.duree === 300, "épisode ancien complété (audio et sources lus dans sa légende)", ancien);
  const liste = await appels();
  verifier(tg(liste, "forwardMessage").length >= 1 && tg(liste, "deleteMessage").some((a) => a.corps.message_id === 9999), "le message transféré est aussitôt retiré");
  await vider();
  await app("etat");
  verifier(tg(await appels(), "forwardMessage").length === 0, "pas de second transfert");
  await envoyerJson(`${BOT}/api/evenement`, { type: "echantillon", voix: "Kore", file_id: "PAIRE1", legende: "x", debut: 4.2, fin: 8.9 }, entetesApi);
  r = await app("etat");
  verifier(r.donnees.reglages.temps_echantillons.Kore?.join() === "4.2,8.9" && r.donnees.reglages.echantillons.Kore?.startsWith("/app/audio?"), "extrait : début et fin de la voix", r.donnees.reglages.temps_echantillons);
  const e = (await etat()).etat;
  await fetch(`${BOT}/test/etat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etat: { ...e, echantillons_demandes: null } }) });
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
  verifier(r.donnees.modeles?.length === 8 && meteo?.f?.place === "ouverture" && meteo.f.longueur === "phrase", "catalogue fourni par le bot", r.donnees.modeles?.map((m) => m.id));
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
  await gemini({ entendu: "", operations: [{ action: "nouvelle_regle", regle: { modele: "actu", titre: "Actu vélo", consigne: "Les nouvelles importantes du vélo." } }], reponse: "" });
  r = await app("parler", { texte: "les nouvelles du vélo" });
  const velo = r.donnees.regles.find((x) => x.titre === "Actu vélo");
  verifier(r.ok && velo && velo.sources_auto && velo.sources.includes("actus") && velo.place === "actualites" && r.ouvrir?.id === velo.id, "rubrique du catalogue créée et ouverte", velo);
  await envoyerJson(`${BOT}/test/etat`, { config: sauvegarde });
});

await scenario("Application : miniatures, sources par section, historique, demande vocale", async () => {
  await horloge("2026-10-21T08:00");
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-21", titre: "Mercredi", message_id: 7171, file_id: "A7", pochette_id: "IMG7",
    transcription: "Hugo : Bonjour !", mode: "planifie",
    sources: [{ section: "Actualités", titre: "Article", url: "https://exemple.ch/1" }, { section: "Actu locale", titre: "Yverdon", url: "https://exemple.ch/2" }] }, entetesApi);
  let r = await app("etat");
  const ep = r.donnees.episodes.find((x) => x.titre === "Mercredi");
  verifier(ep?.image?.startsWith("/app/audio?c=img%3A") && ep.sources.map((x) => x.section).join() === "Actualités,Actu locale", "miniature et sources rangées par section", ep);
  const image = await fetch(`${BOT}${ep.image}`);
  verifier(image.status === 200 && image.headers.get("content-type") === "image/jpeg", "la miniature est servie comme image", image.status);
  verifier(!JSON.stringify((await etat()).etat.episodes).includes("Hugo : Bonjour"), "le texte de l'épisode est rangé à part");
  r = await app("texte", { cle: ep.cle });
  verifier(r.ok && r.texte === "Hugo : Bonjour !", "texte toujours lisible");
  const ancien = r.donnees.episodes.find((x) => x.titre === "Ancien format");
  verifier(ancien?.image, "épisode ancien : miniature récupérée", ancien);
  for (let i = 1; i <= 9; i++) {
    await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: `2026-09-${String(i).padStart(2, "0")}`, titre: `Septembre ${i}`, message_id: 8000 + i, mode: "planifie" }, entetesApi);
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
  r = await app("rubrique", { formulaire: { titre: "Soirée jeux", consigne: "Idées de jeux", periode: { type: "ponctuelle" }, fiche: { quoi: "jeux de société" },
    transport: "aucun", budget: { max: "30", devise: "EUR", transport_inclus: true }, inclure: ["coopératif", "rapide"] } });
  const regle = (await etat()).config.regles.find((x) => x.id === r.id);
  verifier(r.ok && regle.recherche.fiche.transport === "aucun" && regle.recherche.fiche.budget.devise === "EUR" && regle.recherche.fiche.budget.transport_inclus === false
    && regle.recherche.fiche.inclure.join() === "coopératif,rapide", "pas de transport, budget en euros, éléments à inclure", regle.recherche.fiche);
  await app("supprimer", { id: r.id });
});

await scenario("Rubriques : sources choisies par l'application, place, pause", async () => {
  let r = await app("rubrique", { formulaire: { titre: "Fête du prénom", consigne: "Dis-moi quels prénoms on fête aujourd'hui.", longueur: "phrase",
    periode: { type: "toujours" }, sources_auto: true, place: "ouverture" } });
  let regle = (await etat()).config.regles.find((x) => x.id === r.id);
  let { config } = await etat();
  verifier(r.ok && regle.recherche.sources.join() === "saints" && regle.recherche.sources_auto, "fête du prénom : calendrier des saints choisi", regle.recherche);
  verifier(config.deroule[config.deroule.findIndex((x) => x.cle === "ouverture") + 1]?.cle === r.id, "placée après l'ouverture", config.deroule.map((x) => x.cle));
  const prenom = r.id;
  r = await app("rubrique", { formulaire: { titre: "Rappel piscine", consigne: "Rappelle-moi de prendre mon maillot.", longueur: "phrase",
    periode: { type: "toujours" }, sources_auto: true, place: "agenda", condition: { texte: "piscine", moment: "veille" } } });
  regle = (await etat()).config.regles.find((x) => x.id === r.id);
  verifier(r.ok && !regle.recherche && regle.condition.texte === "piscine", "rappel selon l'agenda : aucune source", regle);
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
  r = await app("cle", { nom: "tavily", valeur: "tvly-bonne" });
  verifier(r.ok && r.message.includes("Tavily"), "clé Tavily", r.message);
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
  r = await app("cle", { nom: "gemini", valeur: "" });
  verifier(r.ok && r.donnees.connexions.cles.gemini.source === "github", "clé retirée : retour au secret GitHub");
  await app("cle", { nom: "tavily", valeur: "" });
  // Premier lancement : proposé tant que rien de personnel n'est réglé.
  const sauve = (await etat()).config;
  await envoyerJson(`${BOT}/test/etat`, { config: { pays: "CH" } });
  r = await app("etat");
  verifier(r.donnees.bienvenue === true, "premier lancement proposé à une installation neuve");
  r = await app("bienvenue_fin");
  verifier(r.ok && r.donnees.bienvenue === false, "premier lancement terminé");
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
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-20", titre: "Cap sur Mars", sujets: ["Mars", "Vélo"], message_id: 321,
    chapitres: [[0, "Ouverture"], [42, "Agenda"]], file_id: "AUDIO-FLUX", pochette_id: "POCHETTE-FLUX", duree: 300, taille: 2400000, heure: "07:10",
    sources: [{ section: "Actualités", titre: "RTS", url: "https://www.rts.ch/info/1" }] }, { "X-Podcast-Secret": SECRET });
  const page = await obtenir(`${BOT}/flux/${jeton}.xml`);
  verifier(page.statut === 200 && page.texte.includes("<title>Cap sur Mars</title>") && page.texte.includes(`/flux/${jeton}/2026-10-20-321.mp3`)
    && page.texte.includes('length="2400000"') && page.texte.includes("<itunes:duration>0:05:00</itunes:duration>") && page.texte.includes("podcast:chapters")
    && page.texte.includes("Tue, 20 Oct 2026 05:10:00 GMT"), "flux RSS : épisode, fichier, durée, chapitres, date", page.texte.slice(0, 1500));
  const chapitres = JSON.parse((await obtenir(`${BOT}/flux/${jeton}/2026-10-20-321.json`)).texte);
  verifier(chapitres.chapters[1].startTime === 42 && chapitres.chapters[1].title === "Agenda", "chapitres au format Podcasting 2.0", chapitres);
  await vider();
  const audio = await fetch(`${BOT}/flux/${jeton}/2026-10-20-321.mp3`, { headers: { Range: "bytes=0-3" } });
  const appelsFichier = tg(await appels(), "getFile");
  verifier(audio.status === 206 && appelsFichier.at(-1)?.corps?.file_id === "AUDIO-FLUX", "audio servi par morceaux depuis Telegram", audio.status);
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
  const deposer = (nom, octets, entetes = S) => fetch(`${BOT}/api/fichier?nom=${encodeURIComponent(nom)}`, { method: "PUT", body: octets, headers: entetes });
  verifier((await deposer("2026-10/essai.mp3", mp3, {})).status === 403, "dépôt refusé sans le secret");
  verifier((await deposer("../essai.mp3", mp3)).status === 400 && (await deposer("2026-10/essai.exe", mp3)).status === 400
    && (await deposer("2026-13/essai.mp3", mp3)).status === 400, "nom de fichier refusé");
  let r = await (await deposer("2026-10/2026-10-22-071500.mp3", mp3)).json();
  verifier(r.ok && r.taille === taille, "MP3 déposé", r);
  await deposer("2026-10/2026-10-22-071500.jpg", new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
  await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date: "2026-10-22", titre: "Gardé par le bot", message_id: 400, duree: 300, heure: "07:15",
    file_id: "AUDIO-TG", audio: "2026-10/2026-10-22-071500.mp3", pochette: "2026-10/2026-10-22-071500.jpg", taille, transcription: "Léa : Bonjour !" }, S);
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
  verifier(!tg(await appels(), "getFile").length, "lu chez le bot, pas chez Telegram");
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
    await envoyerJson(`${BOT}/api/evenement`, { type: "episode", date, titre: `Épisode ${i}`, message_id: 1000 + i, heure: "07:00" }, S);
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
  verifier(r.donnees.episodes.some((x) => x.cle === "ep:2026-10-23:71502"), "épisode sans Telegram : repéré par son heure d'envoi");
  // Un échec, des idées prêtes.
  await vider();
  await envoyerJson(`${BOT}/api/evenement`, { type: "echec", titre: "⏳ Podcast du matin : raté pour l'instant", message: "Nouvel essai automatique à 7 h 45. Gemini est surchargé." }, { "X-Podcast-Secret": SECRET });
  await envoyerJson(`${BOT}/api/evenement`, { type: "recherche", regles: [], idees: ["Grottes de Vallorbe", "Musée du Fer"], format: "ecrit", resultats: [] }, { "X-Podcast-Secret": SECRET });
  pushs = (await recues()).map((p) => dechiffrer(p, tel));
  verifier(pushs[0]?.titre.includes("raté") && pushs[0]?.corps.includes("7 h 45") && pushs[1]?.titre === "💡 Tes idées sont prêtes" && pushs[1]?.url === "/app?ecran=resultats",
    "échec et idées prêtes : notifiés aussi", pushs);
  r = await app("notif_tester");
  verifier(r.ok && r.message.includes("1 appareil"), "essai depuis l'application", r.message || r.erreur);

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

  // Recevoir l'épisode dans Telegram, ou plus.
  r = await app("regler", { chemin: "livraison.telegram", valeur: false });
  const exp = await (await fetch(`${BOT}/api/config`, { headers: { "X-Podcast-Secret": SECRET } })).json();
  verifier(r.ok && r.donnees.reglages.livraison.telegram === false && exp.config.livraison.telegram === false, "Telegram coupé : GitHub le sait", exp.config.livraison);
  await app("regler", { chemin: "livraison.telegram", valeur: true });
});

await scenario("Hors de Telegram : appareils, manifeste, icônes", async () => {
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
  r = await app("appareil_retirer", { id: r.donnees.appareils[0].id });
  const apres = await parAppareil(ok.jeton);
  verifier(r.ok && apres.statut === 401 && apres.appareil === "inconnu", "appareil retiré : refusé ensuite");
  // Cinq erreurs : le code ne vaut plus rien.
  r = await app("appareil_code");
  const code2 = r.donnees.code_appareil.code, faux2 = code2 === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await connexion(faux2);
  verifier((await connexion(code2)).ok === false, "cinq erreurs : code bloqué");
});

await scenario("Mises à jour depuis le modèle", async () => {
  let r = await app("verifier_maj");
  verifier(r.ok && r.donnees.maj?.version === "2099-01-01.1" && r.donnees.maj.nouveautes.length === 2 && r.donnees.maj_modele === "ok", "nouvelle version vue", r.donnees.maj);
  verifier((await obtenir(`${BOT}/api/maj`, { headers: { "X-Podcast-Secret": SECRET } })).statut === 403, "pas de jeton hors d'une mise à jour");
  await vider();
  r = await app("mettre_a_jour");
  const lance = lancements(await appels()).find((a) => a.workflow === "mettre-a-jour.yml");
  verifier(r.ok && lance?.entrees?.version === "2099-01-01.1" && lance.entrees.modele === "auteur/modele" && lance.entrees.adresse, "mise à jour lancée", lance);
  // Sauvegarde relue, et réécrite si elle avait changé (identique : rien à écrire).
  const sauvegarde = JSON.parse((await (await fetch(`${FAUX}/control/fichiers`)).json())["preferences.json"] || "{}");
  verifier((await appels()).some((a) => a.service === "github" && a.chemin === "preferences.json")
    && JSON.stringify(sauvegarde.config) === JSON.stringify((await etat()).config), "réglages sauvegardés avant la mise à jour");
  verifier((await app("mettre_a_jour")).ok === false, "pas deux mises à jour à la fois");
  const jeton = JSON.parse((await obtenir(`${BOT}/api/maj`, { headers: { "X-Podcast-Secret": SECRET } })).texte);
  verifier(jeton.jeton === "gh-test", "jeton donné au workflow pendant la mise à jour");
  verifier((await obtenir(`${BOT}/api/maj`)).statut === 403, "jamais sans le secret partagé");
  await envoyerJson(`${BOT}/api/evenement`, { type: "maj", ok: true, version: "2099-01-01.1", message: "12 fichier(s) mis à jour." }, { "X-Podcast-Secret": SECRET });
  r = await app("etat");
  verifier(r.donnees.maj_etat?.etat === "fait" && r.donnees.maj_etat.message.includes("12"), "fin de mise à jour signalée", r.donnees.maj_etat);
  verifier((await obtenir(`${BOT}/api/maj`, { headers: { "X-Podcast-Secret": SECRET } })).statut === 403, "jeton refusé une fois la mise à jour finie");
});

await scenario("Pays : réglage et reprise des anciennes installations", async () => {
  // Choisir la France : fuseau, devise, médias par défaut et jours fériés suivent.
  const avant = (await etat()).config;
  await envoyerJson(`${BOT}/test/etat`, { config: { ...avant, actus: { ...avant.actus, flux: null } } });
  let r = await app("regler", { chemin: "pays", valeur: "FR" });
  let { config } = await etat();
  verifier(r.ok && config.pays === "FR" && config.planning.feries_region === "FR", "pays France : les fériés suivent", config.planning);
  verifier(r.donnees.devise === "EUR" && r.donnees.reglages.actus.flux.some((f) => f.nom === "franceinfo") && r.donnees.listes.pays.some(([c]) => c === "BE"),
    "devise, médias par défaut et liste des pays", { devise: r.donnees.devise, flux: r.donnees.reglages.actus.flux });
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
});

await scenario("Après le déploiement : nouveautés, ou présentation pour qui vient d'avant", async () => {
  // Le bot nouvellement déployé s'active (/installer) et écrit selon la version d'où il vient.
  const installer = async (versionAvant) => {
    await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, version_installee: versionAvant } });
    await vider();
    await obtenir(`${BOT}/installer`);
    return tg(await appels(), "sendMessage").map((a) => a.corps.text);
  };
  let textes = await installer("2026-10-21.1");
  verifier(textes.length === 1 && textes[0].includes("à jour") && !textes[0].includes("tout se règle"), "depuis l'application : juste les nouveautés", textes);
  verifier((await etat()).etat.version_installee !== "2026-10-21.1", "nouvelle version notée");
  textes = await installer("2026-10-13.2");
  verifier(textes.some((t) => t.includes("tout se règle dans l'application")), "depuis la version « conversation » : présentation de l'application", textes);
  textes = await installer((await etat()).etat.version_installee);
  verifier(textes.length === 0, "même version : aucun message", textes);
  // Sans /installer (activation du déploiement ratée) : le tic installe, une seule fois.
  await envoyerJson(`${BOT}/test/etat`, { etat: { ...(await etat()).etat, version_installee: "2026-10-21.1" } });
  await vider();
  await horloge("2026-10-20T12:00", true);
  await horloge("2026-10-20T12:05", true);
  const annonces = tg(await appels(), "sendMessage").filter((a) => a.corps.text.includes("Ton podcast est à jour"));
  verifier(annonces.length === 1 && (await etat()).etat.version_installee !== "2026-10-21.1", "activation par le tic : annoncée une seule fois", annonces.length);
});

await scenario("Déploiement : secrets transmis au bot", async () => {
  const { aTransmettre, nomsExistants } = await import("../secrets.mjs");
  verifier(JSON.stringify(nomsExistants('▲ avertissement\n[{"name":"TELEGRAM_BOT_TOKEN","type":"secret_text"},{"name":"GITHUB_TOKEN","type":"secret_text"}]'))
    === '["TELEGRAM_BOT_TOKEN","GITHUB_TOKEN"]', "liste des secrets lue malgré les avertissements");
  verifier(nomsExistants("erreur").length === 0, "liste illisible : vide");
  const env = { TELEGRAM_BOT_TOKEN: "1:A", TELEGRAM_CHAT_ID: " 42 ", GEMINI_API_KEY: "", BOT_GITHUB_TOKEN: "github_pat_x" };
  const envoi = aTransmettre(["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN"], env);
  verifier(!("TELEGRAM_BOT_TOKEN" in envoi) && envoi.TELEGRAM_CHAT_ID === "42" && !("GEMINI_API_KEY" in envoi),
    "seuls les secrets absents du bot sont transmis", envoi);
  verifier(envoi.GITHUB_TOKEN === "github_pat_x", "BOT_GITHUB_TOKEN devient le jeton GitHub du bot");
  verifier(Object.keys(aTransmettre(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_TOKEN"], { TELEGRAM_BOT_TOKEN: "1:A", TELEGRAM_CHAT_ID: "42" })).length === 0,
    "rien à transmettre quand le bot a déjà tout");
});

await scenario("Sans Telegram : installation, première connexion, épisodes, notifications", async () => {
  const BOT2 = "http://127.0.0.1:8798";
  const SECRET_GH = createHash("sha256").update("podcast:gh-test").digest("hex").slice(0, 48);
  const S2 = { "X-Podcast-Secret": SECRET_GH };
  const { avertissementManquants } = await import("../secrets.mjs");
  verifier(avertissementManquants(["GITHUB_TOKEN"]) === "" && avertissementManquants(["GITHUB_TOKEN", "TELEGRAM_CHAT_ID"]).includes("TELEGRAM_BOT_TOKEN")
    && avertissementManquants(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]).includes("BOT_GITHUB_TOKEN"), "déploiement : Telegram facultatif, jeton GitHub indispensable");
  await vider();
  verifier((await envoyerJson(`${BOT2}/telegram`, { update_id: 1 }, { "X-Telegram-Bot-Api-Secret-Token": SECRET })).status === 403, "pas de Telegram : sa porte est fermée");
  const activation = await obtenir(`${BOT2}/installer`);
  verifier(activation.texte.includes("activé") && activation.texte.includes("sans Telegram"), "installation sans Telegram : le bot s'active", activation.texte);
  verifier((await obtenir(`${BOT2}/api/config`, { headers: { "X-Podcast-Secret": SECRET } })).statut === 403, "secret dérivé de Telegram : refusé (il n'y a pas de Telegram)");
  const exportBot = await (await fetch(`${BOT2}/api/config`, { headers: S2 })).json();
  verifier(exportBot.format === "bot-v2" && exportBot.config?.planning, "secret dérivé du jeton GitHub : GitHub lit les réglages", exportBot.format);
  verifier((await obtenir(`${BOT2}/api/config`, { headers: { "X-Podcast-Secret": "" } })).statut === 403, "secret vide : refusé");

  // Première ouverture : GitHub demande un code (fin du déploiement), l'appareil se connecte avec.
  let code = await (await fetch(`${BOT2}/api/code-connexion?si=premiere`, { headers: S2 })).json();
  verifier(/^\d{6}$/.test(code.code || "") && code.adresse === `${BOT2}/app` && /^\d{2}:\d{2}$/.test(code.jusqua || ""), "premier code de connexion pour GitHub", code);
  verifier((await obtenir(`${BOT2}/api/code-connexion`)).statut === 403, "code jamais donné sans le secret");
  const ouvrirTelegram = await envoyerJson(`${BOT2}/app/api`, { action: "etat" }, { "X-Telegram-Init-Data": ouverture() });
  verifier(ouvrirTelegram.status === 401, "ouverture « Telegram » refusée : il n'y en a pas");
  const connexion = await envoyerJson(`${BOT2}/app/connexion`, { code: code.code, nom: "Android · Chrome" }).then((r) => r.json());
  verifier(connexion.ok && /^[0-9a-f]{64}$/.test(connexion.jeton), "le code ouvre l'application", connexion);
  const app2 = async (action, extra = {}) => { const r = await envoyerJson(`${BOT2}/app/api`, { action, ...extra }, { "X-Appareil": connexion.jeton }); return { statut: r.status, ...(await r.json()) }; };
  let r = await app2("etat");
  verifier(r.ok && r.donnees.telegram === false && r.donnees.appareils.length === 1, "l'application sait qu'il n'y a pas de Telegram", r.donnees?.telegram);
  code = await (await fetch(`${BOT2}/api/code-connexion?si=premiere`, { headers: S2 })).json();
  verifier(code.code === null && code.raison === "deja_connecte", "fin de déploiement suivante : pas de nouveau code (déjà connecté)", code);
  code = await (await fetch(`${BOT2}/api/code-connexion`, { headers: S2 })).json();
  verifier(/^\d{6}$/.test(code.code || ""), "workflow « Code de connexion » : un code pour un nouvel appareil");

  // Notifications et épisode, sans rien chez Telegram.
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  r = await app2("notif_abonner", { abonnement: { endpoint: `${FAUX}/push/sans-tg`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } }, nom: "Android · Chrome" });
  verifier(r.ok, "notifications activées sans Telegram", r.erreur);
  await fetch(`${BOT2}/api/fichier?nom=${encodeURIComponent("2026-10/2026-10-25-071500.mp3")}`, { method: "PUT", body: new Uint8Array(3000).fill(7), headers: S2 });
  await fetch(`${BOT2}/api/evenement`, { method: "POST", headers: { ...S2, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "episode", date: "2026-10-25", titre: "Sans Telegram", mode: "planifie", duree: 240, ref: 71500, audio: "2026-10/2026-10-25-071500.mp3" }) });
  r = await app2("etat");
  const ep = r.donnees.episodes.find((x) => x.titre === "Sans Telegram");
  const lu = ep?.audio ? await fetch(`${BOT2}${ep.audio}`, { headers: { Range: "bytes=0-9" } }) : null;
  verifier(ep?.cle === "ep:2026-10-25:71500" && lu?.status === 206, "épisode reçu et lu chez le bot", ep);
  // Un mini-podcast d'idées : gardé par le bot, il s'écoute dans « Idées trouvées ».
  await fetch(`${BOT2}/api/fichier?nom=${encodeURIComponent("2026-10/idees-2026-10-25-090000.mp3")}`, { method: "PUT", body: new Uint8Array(2000).fill(3), headers: S2 });
  await fetch(`${BOT2}/api/evenement`, { method: "POST", headers: { ...S2, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recherche", regles: [], idees: ["Grottes de Vallorbe"], format: "audio", resultats: [{ regle: "", titre: "Sortie", idees: [{ titre: "Grottes de Vallorbe" }] }],
      audio: "2026-10/idees-2026-10-25-090000.mp3", titre_audio: "Sous terre samedi", duree: 150 }) });
  r = await app2("etat");
  const mini = r.donnees.resultats?.episode;
  const luMini = mini?.audio ? await fetch(`${BOT2}${mini.audio}`) : null;
  verifier(mini?.titre === "Sous terre samedi" && luMini?.status === 200 && (await luMini.arrayBuffer()).byteLength === 2000, "mini-podcast d'idées écouté dans l'application", mini);
  const pushs = await (await fetch(`${FAUX}/control/pushs`)).json();
  verifier(pushs.filter((p) => p.id === "sans-tg").length >= 3, "notifications : activation, épisode, idées", pushs.map((p) => p.id));

  // Nouvelle version déployée : annoncée par notification ; rien n'a jamais été envoyé à Telegram.
  await envoyerJson(`${BOT2}/test/etat`, { etat: { ...(await (await fetch(`${BOT2}/test/etat`)).json()).etat, version_installee: "2026-10-21.4" } });
  const avant = (await (await fetch(`${FAUX}/control/pushs`)).json()).length;
  await obtenir(`${BOT2}/installer`);
  await fetch(`${BOT2}/test/horloge?iso=2026-10-20T12:00&tic=1`);
  await fetch(`${BOT2}/test/horloge?iso=2026-10-20T12:05&tic=1`);
  const apres = (await (await fetch(`${FAUX}/control/pushs`)).json()).slice(avant);
  verifier(apres.length === 1, "nouvelle version annoncée une fois, par notification", apres.length);
  verifier(!tg(await appels(), "sendMessage").length && !tg(await appels(), "setWebhook").length && !tg(await appels(), "sendAudio").length,
    "aucun appel à Telegram", tg(await appels(), "sendMessage").length);
});

console.log(`\n${reussis} vérifications réussies, ${rates} ratées.`);
if (rates) { console.log(echecs.map((x) => ` - ${x}`).join("\n")); process.exit(1); }
