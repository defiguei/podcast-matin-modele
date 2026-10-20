// Assistant de recherche : construit avec l'auditeur une « fiche » (quoi, avec
// qui, où, quand, transport, budget, envies), puis la transforme en règle.

import { TRANSPORTS, ajouterJours, jourDeSemaine, dateCourte, JOURS, NOMS_JOURS, dateOuNull, nettoyerListe } from "./config.js";
import { echapper as e } from "./services.js";

const b = (texte, donnees) => ({ text: texte, callback_data: donnees });

export const ETAPES = ["quoi", "avec_qui", "ou", "quand", "transport", "budget", "envies"];

const QUOI = { culture: "🎭 Culture", nature: "🥾 Nature, rando", enfants: "🧒 Avec des enfants", sport: "⚽ Sport", resto: "🍽️ Resto, gastronomie", visite: "🏰 Visite, patrimoine", detente: "🧖 Détente" };
const AVEC = { seul: "Seul", couple: "En couple", amis: "Entre amis", famille: "En famille", enfants: "Avec des enfants" };
const ENVIES = { meteo: "☀️ Tenir compte de la météo", culture: "🎭 Actu culturelle", gratuit: "🆓 Plutôt gratuit", interieur: "🏠 À l'intérieur", exterieur: "🌳 En plein air", accessible: "♿ Accessible" };

export function nouvelleSession(texteInitial = "", devise = "CHF") {
  return { fiche: { budget: { max: null, unite: "personne", transport_inclus: false, devise }, envies: [] }, etape: "quoi", texte: texteInitial, questions: [], cree: Date.now() };
}

export function schemaFiche() {
  const t = { type: "string" };
  return {
    type: "object",
    properties: {
      quoi: t, avec_qui: t, ages: t, ou: t, quand_date: t, quand: t,
      transport: { type: "string", enum: [...Object.keys(TRANSPORTS), ""] },
      budget_max: { type: "number" }, budget_unite: { type: "string", enum: ["personne", "total", ""] },
      inclure: { type: "array", items: t }, exclure: { type: "array", items: t }, attendu: t,
    },
  };
}

export function consigneFiche(aujourdHui, profil = { ou: "en Suisse romande", devise: "CHF" }) {
  return `Tu prépares une recherche d'activité ou de sortie pour l'auditeur d'un podcast, ${profil.ou}. Aujourd'hui : ${NOMS_JOURS[jourDeSemaine(aujourdHui)]} ${aujourdHui}.
Extrais de son message ce qu'il a dit, et laisse vide ce qu'il n'a pas dit (n'invente rien) :
quoi (type d'activité), avec_qui, ages (des enfants), ou (ville, région, « autour de X », « entre X et Y »), quand_date (AAAA-MM-JJ si un jour est donné), quand (en mots), transport (${Object.keys(TRANSPORTS).join(", ")}), budget_max (${profil.devise}), budget_unite (personne ou total), inclure, exclure, attendu (ce qu'il attend : 3 idées, un itinéraire…).`;
}

// Gemini remplit parfois 0 quand un nombre n'est pas dit : « gratuit » doit être explicite.
export const GRATUIT = /gratuit|gratis|sans frais|(?<!\d)0\s*(?:chf|fr|francs?|€|eur|euros?)(?![a-z])|rien d[ée]penser|pas d['’]argent/i;

export function fusionnerFiche(fiche, extrait, texte = "") {
  for (const cle of ["quoi", "avec_qui", "ages", "ou", "quand", "attendu"]) if (extrait[cle]) fiche[cle] = String(extrait[cle]).slice(0, 120);
  if (dateOuNull(extrait.quand_date)) fiche.date = extrait.quand_date;
  if (TRANSPORTS[extrait.transport]) fiche.transport = extrait.transport;
  if (typeof extrait.budget_max === "number" && extrait.budget_max >= 0 && (extrait.budget_max > 0 || GRATUIT.test(texte))) {
    fiche.budget.max = extrait.budget_max;
    fiche.budget_vu = true;
  }
  if (extrait.budget_unite === "total" || extrait.budget_unite === "personne") fiche.budget.unite = extrait.budget_unite;
  if (extrait.inclure?.length) fiche.inclure = nettoyerListe([...(fiche.inclure || []), ...extrait.inclure], 8);
  if (extrait.exclure?.length) fiche.exclure = nettoyerListe([...(fiche.exclure || []), ...extrait.exclure], 8);
  return fiche;
}

export function prochaineEtape(session) {
  const f = session.fiche;
  const manque = {
    quoi: !f.quoi, avec_qui: !f.avec_qui, ou: !f.ou && f.lat == null, quand: !f.quand && !f.date,
    transport: !f.transport, budget: f.budget.max === null && !f.budget_vu, envies: !f.envies_vues,
  };
  return ETAPES.find((x) => manque[x]) || "resume";
}

export function ecranAssistant(session, ctx) {
  const etape = session.etape;
  const entete = `🔎 <b>Assistant de recherche</b>\n${resumeCourt(session.fiche)}\n\n`;
  switch (etape) {
    case "quoi":
      return { texte: `${entete}<b>Qu'as-tu envie de faire ?</b> Choisis, ou écris-le.`, clavier: grille(QUOI, "s:quoi", 2) };
    case "avec_qui":
      return { texte: `${entete}<b>Avec qui ?</b> (pour des enfants, précise leur âge en l'écrivant)`, clavier: grille(AVEC, "s:avec", 2) };
    case "ou":
      return { texte: `${entete}<b>Où ?</b> Écris une ville, une région, « autour de Morges », « entre Yverdon et Neuchâtel »… ou partage ta position (📎 → Position).`,
               clavier: [[b(`📍 Autour de ${ctx.ville || "chez moi"}`, "s:ou:ville")], [b("✕ Abandonner", "s:stop")]] };
    case "quand": {
      const jours = [0, 1].map((n) => ajouterJours(ctx.aujourdHui, n));
      const prochain = (code) => { for (let n = 1; n <= 7; n++) { const d = ajouterJours(ctx.aujourdHui, n); if (jourDeSemaine(d) === code) return d; } return null; };
      const sam = prochain("sam"), dim = prochain("dim");
      return { texte: `${entete}<b>Quand ?</b> Choisis, ou écris une date.`, clavier: [
        [b("Aujourd'hui", `s:quand:${jours[0]}`), b("Demain", `s:quand:${jours[1]}`)],
        [b(`Samedi ${dateCourte(sam).split(" ")[1]}`, `s:quand:${sam}`), b(`Dimanche ${dateCourte(dim).split(" ")[1]}`, `s:quand:${dim}`)],
        [b("Pas de date précise", "s:quand:libre")], [b("✕ Abandonner", "s:stop")]] };
    }
    case "transport":
      return { texte: `${entete}<b>Comment te déplaces-tu ?</b>`, clavier: grille(TRANSPORTS, "s:tr", 3) };
    case "budget":
      return { texte: `${entete}<b>Budget maximum ?</b> (ou écris un montant)`, clavier: [
        [b("Gratuit", "s:bu:0"), ...[20, 50, 100].map((n) => b(`≤ ${n} ${session.fiche.budget.devise || "CHF"}`, `s:bu:${n}`))],
        [b("Peu importe", "s:bu:aucun")],
        [b(session.fiche.budget.unite === "total" ? "✅ Pour le groupe" : "✅ Par personne", "s:buu"),
         b(`${session.fiche.budget.transport_inclus ? "✅" : "▫️"} Transport compris`, "s:but")],
        [b("✕ Abandonner", "s:stop")]] };
    case "envies": {
      const choisies = new Set(session.fiche.envies || []);
      const boutons = Object.entries(ENVIES).map(([k, v]) => b(`${choisies.has(k) ? "✅" : "▫️"} ${v}`, `s:env:${k}`));
      const clavier = [];
      for (let i = 0; i < boutons.length; i += 2) clavier.push(boutons.slice(i, i + 2));
      clavier.push([b("Continuer ▶", "s:env:ok")], [b("✕ Abandonner", "s:stop")]);
      return { texte: `${entete}<b>Des envies ou des contraintes ?</b> Coche, ou écris-les (« pas de musée », « avec un pique-nique »).`, clavier };
    }
    case "approfondir": {
      const q = session.questions[session.question || 0];
      if (!q) return ecranAssistant({ ...session, etape: "resume" }, ctx);
      const clavier = (q.options || []).slice(0, 6).map((o, i) => [b(o, `s:rep:${i}`)]);
      clavier.push([b("Passer", "s:rep:passer")]);
      return { texte: `${entete}🔍 <b>${e(q.question)}</b>\nChoisis, ou réponds en écrivant.`, clavier };
    }
    default:
      return resume(session, ctx);
  }
}

function resume(session) {
  const f = session.fiche;
  const texte = [
    "🔎 <b>Voici ce que je vais chercher</b>", "", detailFiche(f),
    "", "Sources prévues : " + sourcesPour(f).map((s) => ({ web: "recherche web", meteo: "météo", transports: "trains", lieux: "lieux (OpenStreetMap)", wikivoyage: "Wikivoyage", actus: "actus locales" }[s])).join(", "),
  ].join("\n");
  const clavier = [
    [b("✅ Enregistrer (dans le podcast)", "s:fin:regle")],
    [b("📝 Résultats écrits maintenant", "s:fin:ecrit"), b("🎧 Mini-podcast", "s:fin:audio")],
    [b("🔍 Approfondir", "s:appro"), b("✏️ Modifier", "s:modif")],
    [b("✕ Abandonner", "s:stop")],
  ];
  return { texte, clavier };
}

export function ecranModifier() {
  return { texte: "✏️ Que veux-tu modifier ?", clavier: [
    [b("Quoi", "s:redo:quoi"), b("Avec qui", "s:redo:avec_qui"), b("Où", "s:redo:ou")],
    [b("Quand", "s:redo:quand"), b("Transport", "s:redo:transport"), b("Budget", "s:redo:budget")],
    [b("Envies", "s:redo:envies"), b("◀ Résumé", "s:redo:resume")],
  ] };
}

export function detailFiche(f) {
  const budget = f.budget?.max === null || f.budget?.max === undefined ? "sans limite"
    : f.budget.max === 0 ? "gratuit" : `${f.budget.max} ${f.budget.devise || "CHF"} max ${f.budget.unite === "total" ? "pour le groupe" : "par personne"}${f.budget.transport_inclus ? ", transport compris" : ""}`;
  return [
    `• Quoi : ${e(f.quoi || "—")}`,
    `• Avec : ${e(f.avec_qui || "—")}${f.ages ? ` (${e(f.ages)})` : ""}`,
    `• Où : ${e(f.ou || "—")}`,
    `• Quand : ${f.date ? dateCourte(f.date) : e(f.quand || "pas de date précise")}`,
    `• Transport : ${TRANSPORTS[f.transport] || "—"}`,
    `• Budget : ${budget}`,
    f.envies?.length ? `• Envies : ${f.envies.map((x) => ENVIES[x]?.replace(/^\S+ /, "") || x).join(", ")}` : "",
    f.inclure?.length ? `• Inclure : ${e(f.inclure.join(", "))}` : "",
    f.exclure?.length ? `• Exclure : ${e(f.exclure.join(", "))}` : "",
  ].filter(Boolean).join("\n");
}

function resumeCourt(f) {
  const morceaux = [f.quoi, f.avec_qui, f.ou, f.date ? dateCourte(f.date) : f.quand, TRANSPORTS[f.transport]?.replace(/^\S+ /, "")].filter(Boolean);
  return morceaux.length ? `<i>${e(morceaux.join(" · "))}</i>` : "<i>Nouvelle recherche</i>";
}

export function sourcesPour(f) {
  const s = ["web"];
  const envies = new Set(f.envies || []);
  if (envies.has("meteo") || f.date) s.push("meteo");
  if (f.transport === "train" || f.transport === "peu_importe") s.push("transports");
  s.push("lieux");
  if (/nature|rando|visite|patrimoine|tourisme|balade/i.test(f.quoi || "")) s.push("wikivoyage");
  if (envies.has("culture")) s.push("actus");
  return [...new Set(s)];
}

// Transforme la fiche en champs de règle.
export function regleDepuisFiche(f, mode, aujourdHui) {
  const envies = new Set(f.envies || []);
  const inclure = [...(f.inclure || []), ...[...envies].filter((x) => x !== "meteo").map((x) => ENVIES[x]?.replace(/^\S+ /, "")).filter(Boolean)];
  const exclure = [...(f.exclure || [])];
  if (!envies.has("meteo") && !f.date) exclure.push("météo");
  const titre = `${f.quoi || "Sortie"}${f.ou ? ` — ${f.ou}` : ""}`.slice(0, 50);
  const consigne = `Proposer des idées pour : ${f.quoi || "une activité"}${f.avec_qui ? `, ${f.avec_qui}` : ""}${f.ages ? ` (${f.ages})` : ""}` +
    `${f.ou ? `, ${f.ou}` : ""}${f.date ? `, le ${dateCourte(f.date)}` : f.quand ? `, ${f.quand}` : ""}${f.transport ? `, en ${TRANSPORTS[f.transport].replace(/^\S+ /, "").toLowerCase()}` : ""}` +
    `${f.budget.max !== null && f.budget.max !== undefined ? `, budget ${f.budget.max === 0 ? "gratuit" : `${f.budget.max} ${f.budget.devise || "CHF"} max ${f.budget.unite === "total" ? "pour le groupe" : "par personne"}`}` : ""}.`;
  const periode = mode === "regle"
    ? (f.date ? { type: "dates", debut: ajouterJours(f.date, -3) < aujourdHui ? aujourdHui : ajouterJours(f.date, -3), fin: f.date } : { type: "une_fois" })
    : { type: "ponctuelle" };
  return {
    titre, consigne, periode,
    rubrique: mode === "regle" ? { titre: f.date ? `Idées pour ${dateCourte(f.date).split(" ").slice(0, 2).join(" ")}` : "Idées de sortie", apres: "agenda", longueur: "developpee" } : null,
    recherche: {
      fiche: { quoi: f.quoi, avec_qui: f.avec_qui, ages: f.ages, ou: f.ou, lat: f.lat ?? null, lon: f.lon ?? null,
               quand: f.date ? `le ${dateCourte(f.date)}` : f.quand || "", transport: f.transport, budget: f.budget,
               inclure, exclure, attendu: f.attendu || "3 idées concrètes, avec prix estimé et accès" },
      sources: sourcesPour(f), requetes: [],
    },
    presentation: { jours_avant: 3 },
  };
}

export function schemaQuestions() {
  return { type: "object", properties: { questions: { type: "array", maxItems: 3, items: { type: "object", properties: {
    question: { type: "string" }, champ: { type: "string" }, options: { type: "array", items: { type: "string" }, maxItems: 5 } },
    required: ["question", "options"] } } }, required: ["questions"] };
}

export function consigneQuestions() {
  return "Tu aides à préciser une recherche de sortie ou d'activité. Propose au plus 3 questions courtes et utiles qui amélioreraient vraiment la recherche (durée souhaitée, niveau de marche, intérieur/extérieur, envie précise, endroits déjà connus…), chacune avec 2 à 5 réponses courtes possibles. Ne repose pas une question déjà réglée dans la fiche.";
}

function grille(choix, prefixe, colonnes) {
  const boutons = Object.entries(choix).map(([k, v]) => b(v, `${prefixe}:${k}`));
  const clavier = [];
  for (let i = 0; i < boutons.length; i += colonnes) clavier.push(boutons.slice(i, i + colonnes));
  clavier.push([b("✕ Abandonner", "s:stop")]);
  return clavier;
}

export const LIBELLES = { QUOI, AVEC, ENVIES };
export { JOURS };
