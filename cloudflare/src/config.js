// Modèle de configuration du podcast : valeurs par défaut, validation des
// réglages, règles (création, état, période), planning et jours fériés.
// Tout ce qui est modifiable depuis l'application (ou une demande libre) passe par ce fichier.

// Profils des pays (fuseau, actualités, devise, jours fériés) : même fichier que pour GitHub.
import PROFILS_PAYS from "../../donnees/pays.json" with { type: "json" };

export const PAYS = PROFILS_PAYS;
export const PAYS_DEFAUT = "CH";
export const SANS_PAYS = "--"; // « Pas renseigné » : ni jours fériés, ni médias d'un pays
export function profilPays(config) {
  const profil = PAYS[config?.pays] || PAYS[PAYS_DEFAUT];
  // Sans pays, l'heure reste celle du pays choisi avant (config.fuseau), sinon celle de la Suisse.
  return config?.pays === SANS_PAYS ? { ...profil, fuseau: config.fuseau || PAYS[PAYS_DEFAUT].fuseau } : profil;
}
// Médias par défaut : ceux du pays choisi (tant que la liste n'a pas été modifiée).
export function fluxActus(config) {
  return config?.actus?.flux || profilPays(config).flux;
}

export const JOURS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];
export const NOMS_JOURS = { lun: "lundi", mar: "mardi", mer: "mercredi", jeu: "jeudi", ven: "vendredi", sam: "samedi", dim: "dimanche" };
export const COURTS_JOURS = { lun: "Lun", mar: "Mar", mer: "Mer", jeu: "Jeu", ven: "Ven", sam: "Sam", dim: "Dim" };
export const VITESSES = ["très lente", "lente", "normale", "rapide", "très rapide"];
// Tons de l'épisode : mêmes clés que TONS dans podcast.py (un test compare), qui donne la consigne à Gemini.
export const TONS = {
  naturel: "Naturel", serieux: "Sérieux", detendu: "Détendu", humour: "Avec humour", enthousiaste: "Enthousiaste",
  calme: "Calme et doux", radio: "Journal radio", pedagogue: "Pédagogue", direct: "Direct et concis",
  pince_sans_rire: "Pince-sans-rire", chaleureux: "Chaleureux", motivant: "Motivant", conteur: "Conteur",
};
export const DESCRIPTIONS_TONS = {
  naturel: "Comme deux amis bien informés, sans effet particulier.",
  serieux: "Posé, peu de plaisanteries, des transitions sobres.",
  detendu: "Complice et décontracté, comme entre amis.",
  humour: "Beaucoup de légèreté, sans se moquer des sujets graves.",
  enthousiaste: "Plein d'énergie, curieux, qui donne envie.",
  calme: "Voix posées, rythme tranquille, idéal au réveil.",
  radio: "Comme une matinale d'information : précis, rythmé, factuel.",
  pedagogue: "Prend le temps d'expliquer le contexte et les mots difficiles.",
  direct: "L'essentiel d'abord, phrases courtes, pas de bavardage.",
  pince_sans_rire: "Humour discret et ironie légère, l'air de rien.",
  chaleureux: "Bienveillant et attentionné, proche de l'auditeur.",
  motivant: "Encourageant, tourné vers ce qu'on peut faire de sa journée.",
  conteur: "Raconte les sujets comme de petites histoires.",
};
// Consignes de style toutes prêtes, pour tout l'épisode (Réglages › Durée et style).
export const CONSIGNES_PRETES = [
  "Plus d'humour le vendredi.",
  "Explique les termes techniques en quelques mots.",
  "Donne des chiffres concrets quand c'est utile.",
  "Fais des transitions courtes entre les rubriques.",
  "Parle-moi en me tutoyant.",
  "Le week-end, prends plus ton temps et sois plus léger.",
  "Donne la météo en une phrase, sans détails.",
];
// Consignes toutes prêtes d'une rubrique fournie (fiche de la rubrique, bloc « Consignes »).
const PRETES_ACTUS = [
  "Commence par la nouvelle la plus importante.",
  "Évite les faits divers.",
  "Évite les sujets anxiogènes au réveil.",
  "Pas de politique politicienne, seulement les décisions qui changent quelque chose.",
  "Donne des chiffres concrets quand c'est utile.",
];
export const CONSIGNES_PRETES_RUBRIQUES = {
  ouverture: ["Commence par une phrase d'accroche sur le jour qui commence.", "Annonce le programme en une seule phrase."],
  agenda: ["Pour chaque rendez-vous, dis ce qu'il faut préparer ou emporter.", "Ne parle pas des rendez-vous de routine (travail, cours habituels).",
           "Signale les journées chargées et les trous dans la journée."],
  deplacements: ["Propose une seule idée par lieu, la plus originale.", "Donne une idée qui convient à un temps de pluie."],
  actu_locale: [...PRETES_ACTUS, "Dis ce que ça change concrètement pour les habitants."],
  approfondissements: ["Termine chaque sujet par ce qui va se passer ensuite.", "Explique le contexte comme à quelqu'un qui découvre le sujet."],
  actualites: PRETES_ACTUS,
  cloture: ["Termine par une note positive ou une bonne nouvelle.", "Termine par une citation inspirante.",
            "Propose une petite idée ou un conseil pour la journée."],
};
export const LONGUEURS = { phrase: "une phrase", courte: "courte", developpee: "développée" };
// Où une rubrique va chercher son contenu. Chaque catégorie dit ce qu'elle apporte et où
// elle cherche (Réglages › Sources) ; une rubrique en coche au moins une. Les flux
// spécialisés de l'auditeur s'y ajoutent sous la forme « flux:<id> ».
export const SOURCES = {
  actus: "Google Actualités", web: "Recherche web", meteo: "Météo", transports: "Trains",
  lieux: "Lieux", wikivoyage: "Guides de voyage", saints: "Prénoms du jour", fetes: "Journées et fêtes",
  feries: "Jours fériés", agenda: "Agendas",
};
export const INFOS_SOURCES = {
  actus: { apporte: "Les articles récents sur le sujet de la rubrique, tous médias confondus.", ou: "Google Actualités (news.google.com)",
           aussi: "Actu locale, À creuser, Mes déplacements, thèmes préférés des Actualités globales" },
  web: { apporte: "Des pages web sur le sujet : adresses, horaires, prix, activités.", ou: "Tavily (recherche sur internet)", cle_api: "tavily" },
  meteo: { apporte: "La météo prévue le jour visé, chez toi ou au lieu de la rubrique.", ou: "Open-Meteo (open-meteo.com)" },
  transports: { apporte: "Horaires, retards et suppressions de trains.", ou: "CFF et search.ch (Suisse), iRail (Belgique), SNCF (France)", cle_api: "sncf" },
  lieux: { apporte: "Musées, parcs, points de vue… autour d'un lieu.", ou: "OpenStreetMap et Wikipédia" },
  wikivoyage: { apporte: "Ce qu'il faut savoir d'une ville ou d'une région à visiter.", ou: "Wikivoyage (fr.wikivoyage.org)" },
  saints: { apporte: "Le prénom fêté aujourd'hui, et les autres prénoms du jour.", ou: "Calendrier des prénoms intégré au podcast (sans connexion)" },
  fetes: { apporte: "Les journées mondiales, fêtes nationales et usages du jour (Suisse, France, Belgique).", ou: "Données intégrées au podcast : ONU, fêtes nationales, usages (sans connexion)" },
  feries: { apporte: "Les jours fériés des deux semaines à venir.", ou: "Calendrier de ta région (Planning › Jours fériés)", aussi: "Planning (horaire des jours fériés)" },
  agenda: { apporte: "Les événements de tes agendas : un rappel selon l'agenda s'en sert.", ou: "Tes liens iCal (fiche Agenda)", aussi: "Agenda, Mes déplacements" },
};
export const MAX_FLUX_SPECIALISES = 15;
const FLUX_ID = /^flux:[0-9a-z]{4,16}$/;

// Une source qu'une rubrique peut cocher : une catégorie, ou un flux spécialisé.
export function sourceConnue(s) {
  return Boolean(SOURCES[s]) || FLUX_ID.test(String(s));
}

// Les sources d'une rubrique réellement lues : sans les catégories coupées ni les flux retirés.
export function sourcesUtilisables(sources, config) {
  const coupees = new Set(config?.sources?.coupees || []);
  const flux = new Set((config?.sources?.flux || []).map((f) => `flux:${f.id}`));
  return (sources || []).filter((s) => SOURCES[s] ? !coupees.has(s) : flux.has(s));
}

// Nom lisible d'une source (catégorie ou flux spécialisé).
export function nomSource(s, config) {
  if (SOURCES[s]) return SOURCES[s];
  const flux = (config?.sources?.flux || []).find((f) => `flux:${f.id}` === s);
  return flux ? flux.nom : "flux retiré";
}
export const TRANSPORTS = { voiture: "🚗 Voiture", train: "🚆 Train", velo: "🚲 Vélo", pied: "🚶 À pied", peu_importe: "Peu importe", aucun: "Pas de transport" };
export const DEVISES = [...new Set(["CHF", "EUR", "USD", "GBP", ...Object.values(PROFILS_PAYS).map((p) => p.devise)])];
// Jours fériés : cantons suisses (code ISO de Nager.Date) et pays voisins ou fréquents.
export const REGIONS_FERIES = [
  ["CH-VD", "Suisse · Vaud"], ["CH-GE", "Suisse · Genève"], ["CH-NE", "Suisse · Neuchâtel"], ["CH-FR", "Suisse · Fribourg"],
  ["CH-VS", "Suisse · Valais"], ["CH-JU", "Suisse · Jura"], ["CH-BE", "Suisse · Berne"], ["CH-SO", "Suisse · Soleure"],
  ["CH-BS", "Suisse · Bâle-Ville"], ["CH-BL", "Suisse · Bâle-Campagne"], ["CH-AG", "Suisse · Argovie"], ["CH-LU", "Suisse · Lucerne"],
  ["CH-ZH", "Suisse · Zurich"], ["CH-ZG", "Suisse · Zoug"], ["CH-SZ", "Suisse · Schwytz"], ["CH-UR", "Suisse · Uri"],
  ["CH-OW", "Suisse · Obwald"], ["CH-NW", "Suisse · Nidwald"], ["CH-GL", "Suisse · Glaris"], ["CH-SH", "Suisse · Schaffhouse"],
  ["CH-AR", "Suisse · Appenzell Rh.-Ext."], ["CH-AI", "Suisse · Appenzell Rh.-Int."], ["CH-SG", "Suisse · Saint-Gall"],
  ["CH-GR", "Suisse · Grisons"], ["CH-TG", "Suisse · Thurgovie"], ["CH-TI", "Suisse · Tessin"],
  ["FR", "France"], ["BE", "Belgique"], ["LU", "Luxembourg"], ["DE", "Allemagne"], ["AT", "Autriche"], ["IT", "Italie"],
  ["ES", "Espagne"], ["PT", "Portugal"], ["NL", "Pays-Bas"], ["GB", "Royaume-Uni"], ["CA", "Canada"], ["US", "États-Unis"],
];
export const CANTONS = REGIONS_FERIES.filter(([c]) => c.startsWith("CH-"));
export const MODES_VOIX = { fixe: "Toujours les mêmes", jours: "Selon le jour", aleatoire: "Au hasard" };

// Rubriques intégrées du déroulé. Les rubriques créées par l'auditeur (« R1 », « R2 »…)
// s'ajoutent à celles-ci. « approfondissements » garde sa clé pour les anciennes sauvegardes.
export const RUBRIQUES = {
  ouverture: "Ouverture", agenda: "Agenda", deplacements: "Mes déplacements",
  actu_locale: "Actu locale", approfondissements: "À creuser", actualites: "Actualités globales", cloture: "Clôture",
};
// Celles qu'on peut chercher à la demande (menu « ··· » de leur fiche) : mêmes clés que ESSENTIELLES de recherche.py.
export const RUBRIQUES_A_CHERCHER = ["agenda", "deplacements", "actu_locale", "approfondissements", "actualites"];
// Écran de réglage de chaque rubrique intégrée (null : pas d'écran propre).
export const ECRAN_INTEGREE = {
  agenda: "agenda", deplacements: "deplacements", actu_locale: "actulocale", approfondissements: "acreuser", actualites: "actus",
};
// Catalogue des rubriques : les modèles proposés par « + » dans l'application ET ceux que
// Gemini choisit quand on demande une rubrique à la voix. Le formulaire de départ est celui
// de la fiche de l'application ; « pret » : titre et consigne utilisables tels quels.
export const MODELES_RUBRIQUES = [
  { id: "prenom", categorie: "journees", sources: ["saints"], famille: "jour", titre: "Fête du prénom", texte: "Le prénom fêté aujourd'hui (calendrier traditionnel), pour le souhaiter à tes amis", pret: true,
    formulaire: () => ({ place: "ouverture", titre: "Fête du prénom", consigne: "Dis-moi quels prénoms on fête aujourd'hui (un ou deux).", longueur: "phrase" }) },
  { id: "journee", categorie: "journees", sources: ["fetes"], famille: "jour", titre: "Journée mondiale", texte: "La journée mondiale ou la fête nationale célébrée aujourd'hui", pret: true,
    formulaire: () => ({ place: "ouverture", titre: "Journée mondiale", consigne: "Dis-moi quelle journée mondiale, internationale ou fête nationale on célèbre aujourd'hui.", longueur: "phrase" }) },
  { id: "meteo", categorie: "alertes", sources: ["meteo"], famille: "jour", titre: "Météo", texte: "Le temps du jour chez toi, et comment t'habiller", pret: true,
    formulaire: (ville) => ({ place: "ouverture", titre: "Météo", consigne: `La météo du jour${ville ? ` à ${ville}` : ""} : températures, risque de pluie, et un conseil pour s'habiller.`, longueur: "phrase" }) },
  { id: "rappel", categorie: "alertes", sources: ["agenda"], famille: "agenda", titre: "Rappel selon l'agenda", texte: "« La veille d'un match, rappelle-moi de préparer mon sac »",
    formulaire: () => ({ place: "agenda", titre: "Rappel", consigne: "Rappelle-moi de ", longueur: "phrase", condition: { texte: "", moment: "veille", n: 1 } }) },
  { id: "train", categorie: "alertes", sources: ["transports"], famille: "sortie", titre: "Mon train", texte: "Retard ou suppression de ton train habituel (Suisse, France, Belgique)",
    formulaire: (ville) => ({ place: "agenda", titre: "Mon train", consigne: `Retard du train de ${ville || "…"} vers … à …h…`, longueur: "phrase",
                              periode: { type: "jours", jours: ["lun", "mar", "mer", "jeu", "ven"] } }) },
  { id: "actu_pays", categorie: "actus", sources: ["actus"], famille: "info", titre: "Actu d'un pays", texte: "« L'actualité du Portugal », « ce qui se passe au Canada »",
    formulaire: () => ({ place: "actualites", titre: "Actu de ", consigne: "Les nouvelles importantes de ce pays : ", longueur: "courte" }) },
  { id: "actu_theme", categorie: "actus", sources: ["actus"], famille: "info", titre: "Actu d'un thème", texte: "« Les nouvelles du vélo », « l'actu de l'intelligence artificielle »",
    formulaire: () => ({ place: "actualites", titre: "Actu ", consigne: "Les nouvelles importantes sur le thème : ", longueur: "courte" }) },
  { id: "sortie", categorie: "guide", sources: ["web", "lieux", "meteo", "wikivoyage"], famille: "sortie", titre: "Idée de sortie", texte: "Une sortie proposée dans tes épisodes, selon tes critères (lieu, budget, transport)", recherche: true, pret: true,
    formulaire: () => ({ place: "deplacements", titre: "Sortie du week-end", consigne: "Propose une idée de sortie pour le week-end.", longueur: "courte",
                         periode: { type: "jours", jours: ["jeu", "ven"] } }) },
  { id: "libre", categorie: "libre", sources: [], famille: "info", titre: "Rubrique libre", texte: "Tu écris la consigne et tu choisis où elle cherche",
    formulaire: () => ({ place: "actualites", titre: "", consigne: "", longueur: "courte" }) },
];

// Les catégories du catalogue « + » dans l'ordre où l'application les montre (« basiques » : les
// rubriques fournies, qui s'activent par un interrupteur au lieu de s'ajouter ; « categorie » des modèles).
export const CATEGORIES_RUBRIQUES = [
  { id: "basiques", titre: "L'essentiel", texte: "Les rubriques de base du podcast : une seule de chaque, à activer ou à couper." },
  { id: "journees", titre: "Au calendrier", texte: "Les prénoms à souhaiter et les journées à connaître." },
  { id: "alertes", titre: "Pratique", texte: "Le temps qu'il fait, ton train, les rappels de ton agenda." },
  { id: "actus", titre: "À suivre", texte: "Les nouvelles d'un pays ou d'un thème qui t'intéresse." },
  { id: "guide", titre: "Sorties", texte: "Des idées de sorties qui répondent à tes critères." },
  { id: "libre", titre: "Sur mesure", texte: "Ta consigne, tes sources." },
];

// Le catalogue tel que l'application le reçoit (formulaire déjà rempli pour ta ville ;
// sources par défaut du modèle, sans les catégories coupées).
export function catalogueRubriques(config) {
  return MODELES_RUBRIQUES.map(({ formulaire, ...m }) => ({ ...m, sources: sourcesUtilisables(m.sources, config), f: formulaire(config?.actus?.ville || "") }));
}

export const DELAIS_RATTRAPAGE = [30, 45, 60, 90, 120];
export const LONGUEUR_CONSIGNE = 300;

export const VOIX = [
  ["Aoede", "aérienne", "f"], ["Kore", "ferme", "f"], ["Leda", "jeune", "f"], ["Zephyr", "lumineuse", "f"],
  ["Callirrhoe", "décontractée", "f"], ["Autonoe", "claire", "f"], ["Despina", "douce", "f"], ["Erinome", "nette", "f"],
  ["Laomedeia", "enjouée", "f"], ["Achernar", "feutrée", "f"], ["Gacrux", "mûre", "f"], ["Pulcherrima", "affirmée", "f"],
  ["Vindemiatrix", "délicate", "f"], ["Sulafat", "chaleureuse", "f"],
  ["Puck", "pétillante", "m"], ["Charon", "posée", "m"], ["Fenrir", "énergique", "m"], ["Orus", "ferme", "m"],
  ["Enceladus", "soufflée", "m"], ["Iapetus", "claire", "m"], ["Umbriel", "détendue", "m"], ["Algieba", "veloutée", "m"],
  ["Algenib", "rocailleuse", "m"], ["Rasalgethi", "informative", "m"], ["Alnilam", "solide", "m"], ["Schedar", "égale", "m"],
  ["Achird", "amicale", "m"], ["Zubenelgenubi", "familière", "m"], ["Sadachbia", "vive", "m"], ["Sadaltager", "savante", "m"],
];
export const VOIX_CONSEILLEES = ["Aoede", "Kore", "Leda", "Sulafat", "Puck", "Charon", "Fenrir", "Achird"];
export const MAX_PRENOM = 20;   // prénom donné à une voix


// Une liste de consignes par rubrique fournie (Agenda, Actualités globales…).
export function consignesRubriquesVides() {
  return Object.fromEntries(Object.keys(RUBRIQUES).map((cle) => [cle, []]));
}
export const CHEMINS_CONSIGNES = Object.keys(RUBRIQUES).map((cle) => `consignes_rubriques.${cle}`);
// Une liste de consignes (des phrases entières, 300 caractères) plutôt qu'une liste de mots.
export const estListeConsignes = (chemin) => chemin === "consignes" || CHEMINS_CONSIGNES.includes(chemin);

export function configParDefaut() {
  return {
    version: 1,
    pays: PAYS_DEFAUT,
    planning: {
      jours: Object.fromEntries(JOURS.map((j) => [j, "07:30"])),
      exceptions: [],   // [{ date: "2026-10-20", heure: "05:30" | null }]
      pauses: [],       // [{ du: "2026-10-20", au: "2026-10-27" }]
      feries: "normal", // normal | dimanche | aucun
      rattrapage: true,
      delai_rattrapage: 60, // minutes après l'heure prévue
      avance_minutes: 5, // préparation lancée un peu avant, pour que l'épisode arrive à l'heure
      feries_region: "CH-VD", // canton ou pays des jours fériés
      feries_cache: {},       // { "2027": [["2027-01-01", "Nouvel an"], …] } pour les autres que Vaud
    },
    format: { duree_minutes: 3, nombre_sujets: 3, ton: "naturel" },
    // Chaque voix est un animateur possible, sous son nom (celui de la voix, sauf si
    // l'auditeur lui donne un prénom) ; une voix désactivée n'est jamais choisie.
    voix: {
      vitesse: "normale", tutoiement: true, prenom: "",
      animateurs: [{ nom: "Léa", voix: "Aoede" }, { nom: "Hugo", voix: "Puck" }], // habituels (nom recopié de la voix)
      noms: { Aoede: "Léa", Puck: "Hugo" }, // prénoms donnés aux voix ; les autres gardent leur nom
      inactives: [],      // voix à ne pas utiliser
      solo: false,        // une seule voix (le premier animateur du jour)
      mode: "fixe",       // fixe | jours (voix choisies par jour) | aleatoire (tirage parmi les voix activées)
      jours: {},          // { lun: ["Kore", ""], … } en mode « jours » : deux places, "" = animateur habituel
    },
    deroule: Object.keys(RUBRIQUES).map((cle) => ({ cle, actif: true })),
    agenda: { jours: 7, horizon: 90, notes: true, deplacements: true, jours_deplacements: 14,
              max_deplacements: 2, exclus: [], retires: [] },
    // Actualités globales et Actu locale se règlent de la même façon : thèmes préférés et à
    // éviter, âge maximum des nouvelles, nombre de sujets racontés et d'articles lus.
    actus: { ville: "", sujets_preferes: [], sujets_a_eviter: [], flux: null, fraicheur_heures: 36, articles: 30,
             locale_sujets: 2, locale_articles: 3, locale_fraicheur_heures: 168, locale_preferes: [], locale_a_eviter: [] },
    // Réglages › Sources : catégories coupées (aucune rubrique ne les lit) et flux RSS
    // spécialisés qu'une rubrique peut choisir ([{ id, nom, url }]).
    sources: { coupees: [], flux: [] },
    consignes: [],                                // consignes de style, pour tout l'épisode
    consignes_rubriques: consignesRubriquesVides(), // consignes propres à chaque rubrique fournie
    a_approfondir: [],
    regles: [],
    prochain_numero: 1,
  };
}

// ───────────────────────────── réglages simples ─────────────────────────────

const entier = (min, max) => (v) => {
  const n = Math.round(Number(String(v).replace(",", ".").replace(/[^\d.-]/g, "")));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`valeur attendue entre ${min} et ${max}`);
  return n;
};
const decimal = (min, max) => (v) => {
  const n = Math.round(Number(String(v).replace(",", ".").replace(/[^\d.-]/g, "")) * 2) / 2;
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`valeur attendue entre ${min} et ${max}`);
  return n;
};
const parmi = (valeurs) => (v) => {
  const cle = normaliserTexte(v);
  const trouve = valeurs.find((x) => normaliserTexte(x) === cle);
  if (!trouve) throw new Error(`choix possibles : ${valeurs.join(", ")}`);
  return trouve;
};
const booleen = (v) => {
  if (typeof v === "boolean") return v;
  const t = normaliserTexte(v);
  if (["oui", "true", "vrai", "1", "on", "active", "activer"].includes(t)) return true;
  if (["non", "false", "faux", "0", "off", "desactive", "desactiver"].includes(t)) return false;
  throw new Error("oui ou non attendu");
};
const texteCourt = (max = 60) => (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// Une consigne peut être une vraie phrase (300 caractères) ; les autres listes restent courtes (80).
const liste = (max = 15, longueur = 80) => (v) => nettoyerListe(Array.isArray(v) ? v : String(v ?? "").split(/[,;\n]/), max, longueur);

export const REGLAGES = {
  "pays": { nom: "Pays", valider: (v) => { const c = String(v || "").toUpperCase(); if (!PAYS[c]) throw new Error("pays non proposé"); return c; } },
  "format.duree_minutes": { nom: "Durée (min)", valider: decimal(2, 12) },
  "format.nombre_sujets": { nom: "Nombre de sujets (actualités globales)", valider: entier(1, 8) },
  "format.ton": { nom: "Ton", valider: parmi(Object.keys(TONS)) },
  "voix.vitesse": { nom: "Vitesse", valider: parmi(VITESSES) },
  "voix.tutoiement": { nom: "Tutoiement", valider: booleen },
  "voix.prenom": { nom: "Ton prénom", valider: texteCourt(40) },
  // Un animateur habituel est une voix : changer son prénom renomme la voix.
  "voix.animateurs.0.nom": { nom: "Prénom de l'animateur 1", gemini: "Prénom de l'animateur habituel 1 (renomme sa voix)", valider: texteCourt(MAX_PRENOM),
                             appliquer: (c, v) => renommerVoix(c.voix, c.voix.animateurs[0].voix, v) },
  "voix.animateurs.0.voix": { nom: "Animateur 1", gemini: "Animateur habituel 1 : une voix, ou le prénom donné à une voix", valider: texteCourt(40),
                              appliquer: (c, v) => choisirHabituel(c.voix, 0, v) },
  "voix.animateurs.1.nom": { nom: "Prénom de l'animateur 2", gemini: "Prénom de l'animateur habituel 2 (renomme sa voix)", valider: texteCourt(MAX_PRENOM),
                             appliquer: (c, v) => renommerVoix(c.voix, c.voix.animateurs[1].voix, v) },
  "voix.animateurs.1.voix": { nom: "Animateur 2", gemini: "Animateur habituel 2 : une voix, ou le prénom donné à une voix", valider: texteCourt(40),
                              appliquer: (c, v) => choisirHabituel(c.voix, 1, v) },
  "voix.solo": { nom: "Une seule voix", valider: booleen },
  "voix.mode": { nom: "Choix des animateurs", valider: parmi(Object.keys(MODES_VOIX)) },
  "agenda.jours": { nom: "Jours d'agenda couverts", valider: entier(1, 31) },
  "agenda.horizon": { nom: "Horizon du prochain événement (jours)", valider: entier(7, 365) },
  "agenda.notes": { nom: "Lire les notes des événements", valider: booleen },
  "agenda.deplacements": { nom: "Repérer les déplacements", valider: booleen },
  "agenda.jours_deplacements": { nom: "Déplacements repérés jusqu'à (jours)", valider: entier(1, 60) },
  "agenda.max_deplacements": { nom: "Nombre maximum de lieux présentés", valider: entier(1, 4) },
  "actus.ville": { nom: "Ville", valider: texteCourt(60) },
  // Actualités globales (nombre de sujets : format.nombre_sujets)
  "actus.sujets_preferes": { nom: "Thèmes préférés (actualités globales)", valider: liste() },
  "actus.sujets_a_eviter": { nom: "Thèmes à éviter (actualités globales)", valider: liste() },
  "actus.fraicheur_heures": { nom: "Âge max. des actualités globales (h)", valider: entier(6, 168) },
  "actus.articles": { nom: "Articles lus (actualités globales)", valider: entier(5, 60) },
  // Actu locale
  "actus.locale_sujets": { nom: "Nombre de sujets (actu locale)", valider: entier(1, 5) },
  "actus.locale_articles": { nom: "Articles lus (actu locale)", valider: entier(1, 10) },
  "actus.locale_fraicheur_heures": { nom: "Âge max. de l'actu locale (h)", valider: entier(6, 336) },
  "actus.locale_preferes": { nom: "Thèmes préférés (actu locale)", valider: liste() },
  "actus.locale_a_eviter": { nom: "Thèmes à éviter (actu locale)", valider: liste() },
  "consignes": { nom: "Consignes de style", gemini: "Consignes de style, pour tout l'épisode", valider: liste(20, LONGUEUR_CONSIGNE) },
  ...Object.fromEntries(Object.entries(RUBRIQUES).map(([cle, nom]) => [`consignes_rubriques.${cle}`,
    { nom: `Consignes · ${nom}`, gemini: `Consignes propres à la rubrique ${nom}`, valider: liste(20, LONGUEUR_CONSIGNE) }])),
  "planning.rattrapage": { nom: "Rattrapage si l'envoi rate", valider: booleen },
  "planning.delai_rattrapage": { nom: "Délai avant le rattrapage (min)", valider: entier(20, 180) },
  "planning.feries": { nom: "Jours fériés", valider: parmi(["normal", "dimanche", "aucun"]) },
  "planning.avance_minutes": { nom: "Préparation lancée en avance (min)", valider: entier(0, 20) },
  "planning.feries_region": { nom: "Jours fériés de", valider: (v) => { const r = REGIONS_FERIES.find(([c]) => c === v); if (!r) throw new Error("pays ou canton inconnu"); return r[0]; } },
};

export function lireChemin(objet, chemin) {
  return chemin.split(".").reduce((o, cle) => (o == null ? undefined : o[cle]), objet);
}

export function ecrireChemin(objet, chemin, valeur) {
  const parties = chemin.split(".");
  let o = objet;
  for (const cle of parties.slice(0, -1)) o = o[cle];
  o[parties.at(-1)] = valeur;
}

// Applique un réglage simple ; renvoie un libellé lisible du changement.
export function regler(config, chemin, valeurBrute) {
  const definition = REGLAGES[chemin];
  if (!definition) throw new Error(`réglage inconnu : ${chemin}`);
  const valeur = definition.valider(valeurBrute);
  if (definition.appliquer) return `${definition.nom} : ${definition.appliquer(config, valeur)}`;
  const ancienPays = config.pays;
  ecrireChemin(config, chemin, valeur);
  // Changer de pays : les jours fériés suivent, s'ils étaient ceux de l'ancien pays.
  if (chemin === "pays" && ancienPays !== valeur) {
    // Les jours fériés suivent le pays (en Suisse : le canton choisi, Vaud au départ). Sans pays : aucun.
    if (valeur === SANS_PAYS) config.fuseau = profilPays({ ...config, pays: ancienPays }).fuseau;
    else delete config.fuseau;
    const canton = String(config.planning.feries_region || "");
    config.planning.feries_region = valeur === "CH" ? (canton.startsWith("CH-") ? canton : "CH-VD") : profilPays(config).feries;
    config.planning.feries_cache = {};
  }
  // Un thème à éviter n'est plus un thème préféré (de la même rubrique).
  const preferes = { "actus.sujets_a_eviter": "sujets_preferes", "actus.locale_a_eviter": "locale_preferes" }[chemin];
  if (preferes) {
    const exclus = new Set(valeur.map(normaliserTexte));
    config.actus[preferes] = config.actus[preferes].filter((s) => !exclus.has(normaliserTexte(s)));
  }
  return `${definition.nom} : ${afficherValeur(chemin, valeur)}`;
}

export function afficherValeur(chemin, valeur) {
  if (typeof valeur === "boolean") return valeur ? "oui" : "non";
  if (Array.isArray(valeur)) return valeur.length ? valeur.join(", ") : "aucun";
  if (chemin === "format.ton") return TONS[valeur] || valeur;
  if (chemin === "voix.mode") return MODES_VOIX[valeur] || valeur;
  if (chemin === "planning.feries_region") return (REGIONS_FERIES.find(([c]) => c === valeur) || [, valeur])[1];
  if (chemin === "pays") return PAYS[valeur]?.nom || valeur;
  if (valeur === "" || valeur == null) return "—";
  return String(valeur);
}

// ───────────────────────────────── règles ───────────────────────────────────

export function nouvelleRegle(config, champs, aujourdHui, origine = "") {
  const id = `R${config.regles.length + 1}`;
  config.prochain_numero = config.regles.length + 2;
  const regle = normaliserRegle({ ...champs, id, cree_le: aujourdHui, modifie_le: aujourdHui, origine: String(origine).slice(0, 300) });
  config.regles.push(regle);
  if (regle.rubrique) placerRubrique(config, id, regle.rubrique.apres);
  return regle;
}

// Recherches ponctuelles : ce qu'elles rendent, et la durée d'un « point ».
export const RENDUS = ["point", "idees"];
export const MINUTES_POINT = [2, 3, 5, 8, 10];
export function minutesPoint(valeur) {
  const n = Math.round(Number(valeur));
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(10, n)) : 3;
}
// Le format de lancement (workflow Recherche) d'une rubrique ponctuelle.
export function formatRecherche(regle, format = "ecrit") {
  if (regle?.recherche?.rendu === "point") return "point";
  return format === "audio" || regle?.recherche?.audio ? "audio" : "ecrit";
}

export function normaliserRegle(r) {
  const periode = r.periode || {};
  const type = ["toujours", "dates", "jours", "une_fois", "ponctuelle"].includes(periode.type) ? periode.type : "toujours";
  const rubrique = r.rubrique && r.rubrique.titre ? {
    titre: texteCourt(40)(r.rubrique.titre),
    apres: Object.keys(RUBRIQUES).includes(r.rubrique.apres) || /^R\d+$/.test(r.rubrique.apres || "") ? r.rubrique.apres : "agenda",
    longueur: Object.keys(LONGUEURS).includes(r.rubrique.longueur) ? r.rubrique.longueur : "courte",
  } : null;
  const fiche = r.recherche?.fiche || {};
  const budget = fiche.budget || {};
  const recherche = r.recherche ? {
    fiche: {
      quoi: texteCourt(120)(fiche.quoi), avec_qui: texteCourt(80)(fiche.avec_qui), ages: texteCourt(40)(fiche.ages),
      ou: texteCourt(120)(fiche.ou), lat: nombreOuNull(fiche.lat), lon: nombreOuNull(fiche.lon),
      rayon_km: nombreOuNull(fiche.rayon_km), quand: texteCourt(80)(fiche.quand),
      transport: Object.keys(TRANSPORTS).includes(fiche.transport) ? fiche.transport : "",
      budget: { max: nombreOuNull(budget.max), unite: budget.unite === "total" ? "total" : "personne",
                transport_inclus: fiche.transport === "aucun" ? false : Boolean(budget.transport_inclus),
                devise: DEVISES.includes(budget.devise) ? budget.devise : "CHF" },
      inclure: nettoyerListe(fiche.inclure, 8), exclure: nettoyerListe(fiche.exclure, 8),
      attendu: texteCourt(120)(fiche.attendu),
    },
    sources: nettoyerListe(r.recherche.sources, 15).filter(sourceConnue),
    requetes: nettoyerListe(r.recherche.requetes, 6),
    // Ce qu'une recherche ponctuelle rend : « point » = un podcast qui fait l'état des lieux
    // d'un sujet (durée en minutes) ; « idees » = des idées concrètes (sorties, activités…).
    rendu: RENDUS.includes(r.recherche.rendu) ? r.recherche.rendu : "idees",
    // Des idées reçues en mini-podcast plutôt que par écrit (choisi en haut de la fiche).
    audio: Boolean(r.recherche.audio),
    minutes: minutesPoint(r.recherche.minutes),
  } : null;
  const condition = r.condition && r.condition.texte ? {
    texte: texteCourt(120)(r.condition.texte),
    moment: ["jour_meme", "veille", "jours_avant"].includes(r.condition.moment) ? r.condition.moment : "jour_meme",
    n: Math.max(1, Math.min(30, Number(r.condition.n) || 1)),
  } : null;
  return {
    id: r.id, titre: texteCourt(50)(r.titre || r.consigne || "Rubrique"),
    consigne: String(r.consigne || r.titre || "").replace(/\s+/g, " ").trim().slice(0, 400),
    periode: {
      type, debut: dateOuNull(periode.debut), fin: dateOuNull(periode.fin),
      jours: nettoyerListe(periode.jours, 7).filter((j) => JOURS.includes(j)),
    },
    condition, rubrique, recherche,
    presentation: { jours_avant: Math.max(0, Math.min(14, Number(r.presentation?.jours_avant ?? 3))) },
    importance: r.importance === "prioritaire" ? "prioritaire" : "normale",
    etat: r.etat === "pause" ? "pause" : "active",
    cree_le: r.cree_le || null, modifie_le: r.modifie_le || null, origine: r.origine || "",
    derniere_application: r.derniere_application || null, servie: Boolean(r.servie),
  };
}

// Sources proposées d'après le sujet d'une rubrique demandée à la voix sans source précise
// (elles sont ensuite cochées dans sa fiche, bien visibles). Un rappel lit l'agenda.
export function sourcesAuto({ titre = "", consigne = "", fiche = {}, condition = null } = {}, config = null) {
  const t = normaliserTexte(`${titre} ${consigne} ${fiche.quoi || ""} ${fiche.attendu || ""}`);
  const sources = new Set();
  if (/prenom|saint|fete du jour|fete des/.test(t)) sources.add("saints");
  if (/journee (mondiale|internationale|nationale|du)|fete (inter)?nationale|fete internationale|on celebre/.test(t)) sources.add("fetes");
  if (/meteo|temps qu.il|pluie|soleil|neige|temperature|parapluie|s.habiller/.test(t)) sources.add("meteo");
  if (/\btrains?\b|retard|\bcff\b|sncf|sncb|\bgare\b|correspondance/.test(t)) sources.add("transports");
  if (/\bactus?\b|actualite|nouvelles|\bnews\b|presse|\binfos?\b/.test(t)) sources.add("actus");
  if (/ferie/.test(t)) sources.add("feries");
  const sortie = fiche.quoi || fiche.ou || /sortie|activite|visite|rando|balade|musee|resto|restaurant|week-?end|spectacle|concert|exposition|que faire|idee/.test(t);
  if (sortie) ["web", "lieux", "meteo", "wikivoyage"].forEach((s) => sources.add(s));
  if (condition) sources.add("agenda");
  if (!sources.size) sources.add("web");
  return sourcesUtilisables([...sources], config);
}

// Met à jour une règle existante avec les champs fournis (fusion profonde légère).
export function modifierRegle(config, id, champs, aujourdHui) {
  const index = config.regles.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`rubrique ${id} introuvable`);
  const ancienne = config.regles[index];
  const fusion = { ...ancienne, ...champs, id, modifie_le: aujourdHui };
  for (const cle of ["periode", "rubrique", "condition", "presentation"]) {
    if (champs[cle] === null) fusion[cle] = null;
    else if (champs[cle]) fusion[cle] = { ...(ancienne[cle] || {}), ...champs[cle] };
  }
  if (champs.recherche) {
    fusion.recherche = {
      ...(ancienne.recherche || {}), ...champs.recherche,
      fiche: { ...(ancienne.recherche?.fiche || {}), ...(champs.recherche.fiche || {}),
               budget: { ...(ancienne.recherche?.fiche?.budget || {}), ...(champs.recherche.fiche?.budget || {}) } },
    };
  }
  const regle = normaliserRegle(fusion);
  config.regles[index] = regle;
  // Une rubrique déjà dans le déroulé garde sa place, sauf si on lui en donne une nouvelle.
  const dejaPlacee = config.deroule.some((el) => el.cle === id);
  const deplacee = champs.rubrique?.apres !== undefined && champs.rubrique.apres !== ancienne.rubrique?.apres;
  if (!regle.rubrique) retirerRubrique(config, id);
  else if (!dejaPlacee || deplacee) {
    retirerRubrique(config, id);
    placerRubrique(config, id, regle.rubrique.apres);
  }
  return regle;
}

export function supprimerRegle(config, id) {
  const avant = config.regles.length;
  config.regles = config.regles.filter((r) => r.id !== id);
  retirerRubrique(config, id);
  if (config.regles.length === avant) throw new Error(`rubrique ${id} introuvable`);
  return renumeroter(config);
}

// Les rubriques sont toujours numérotées R1, R2… dans l'ordre : quand on en supprime
// une, les suivantes remontent. Renvoie la table { ancien: nouveau } des changements.
export function renumeroter(config) {
  const table = {};
  const vus = new Set();
  config.deroule = (config.deroule || []).filter((el) => (RUBRIQUES[el.cle] || config.regles.some((r) => r.id === el.cle))
    && !vus.has(el.cle) && vus.add(el.cle));
  config.regles.forEach((r, i) => { const nouveau = `R${i + 1}`; if (r.id !== nouveau) table[r.id] = nouveau; });
  if (Object.keys(table).length) {
    const renommer = (cle) => table[cle] || cle;
    for (const r of config.regles) {
      r.id = renommer(r.id);
      if (r.rubrique && table[r.rubrique.apres]) r.rubrique.apres = table[r.rubrique.apres];
    }
    for (const element of config.deroule || []) element.cle = renommer(element.cle);
  }
  config.prochain_numero = config.regles.length + 1;
  return table;
}

export function etatRegle(regle, aujourdHui) {
  if (regle.etat === "pause") return "pause";
  const p = regle.periode;
  if (p.type === "ponctuelle") return "ponctuelle";
  if (p.type === "une_fois") return regle.servie ? "terminee" : "active";
  if (p.fin && aujourdHui > p.fin) return "terminee";
  if (p.debut && aujourdHui < p.debut) return "a_venir";
  // Rubrique de certains jours seulement : « à venir » les autres jours.
  if (p.type === "jours" && p.jours.length && !p.jours.includes(jourDeSemaine(aujourdHui))) return "a_venir";
  return "active";
}

// Prochaine date (≥ aujourd'hui) où la rubrique passe, ou null.
export function prochainPassage(regle, aujourdHui) {
  const p = regle.periode;
  for (let i = 0; i < 400; i++) {
    const date = ajouterJours(aujourdHui, i);
    if (p.debut && date < p.debut) continue;
    if (p.fin && date > p.fin) return null;
    if (p.type === "jours" && p.jours.length && !p.jours.includes(jourDeSemaine(date))) continue;
    return date;
  }
  return null;
}

export const LIBELLES_ETATS = { active: "active", pause: "en pause", a_venir: "à venir", terminee: "terminée", ponctuelle: "ponctuelle" };

export function decrirePeriode(p) {
  const d = (x) => (x ? dateCourte(x) : "");
  switch (p.type) {
    case "une_fois": return "une seule fois (prochain épisode)";
    case "ponctuelle": return "recherche ponctuelle (pas dans le podcast)";
    case "jours": return `les ${p.jours.map((j) => `${NOMS_JOURS[j]}s`).join(", ") || "—"}` + (p.debut ? ` à partir du ${d(p.debut)}` : "") + (p.fin ? ` jusqu'au ${d(p.fin)}` : "");
    case "dates":
      if (p.debut && p.fin) return `du ${d(p.debut)} au ${d(p.fin)}`;
      if (p.debut) return `à partir du ${d(p.debut)}`;
      if (p.fin) return `jusqu'au ${d(p.fin)}`;
      return "toujours";
    default: return "toujours";
  }
}

// ───────────────────────────────── déroulé ──────────────────────────────────

export function placerRubrique(config, cle, apres) {
  if (config.deroule.some((r) => r.cle === cle)) return;
  let index = config.deroule.findIndex((r) => r.cle === apres);
  if (index < 0) index = config.deroule.findIndex((r) => r.cle === "agenda");
  config.deroule.splice(index + 1, 0, { cle, actif: true });
}

export function retirerRubrique(config, cle) {
  config.deroule = config.deroule.filter((r) => r.cle !== cle);
}

export function placerRubriqueApres(config, cle, apres) {
  const element = config.deroule.find((r) => r.cle === cle);
  if (!element) throw new Error(`rubrique ${cle} introuvable`);
  config.deroule = config.deroule.filter((r) => r.cle !== cle);
  const index = apres === "debut" ? -1 : config.deroule.findIndex((r) => r.cle === apres);
  config.deroule.splice(index + 1, 0, element);
}

export function nomRubrique(config, cle) {
  if (RUBRIQUES[cle]) return RUBRIQUES[cle];
  const regle = config.regles.find((r) => r.id === cle);
  return regle ? `${regle.rubrique?.titre || regle.titre} (${cle})` : cle;
}

// ───────────────────────────────── planning ─────────────────────────────────

export function jourDeSemaine(dateIso) {
  const [a, m, j] = dateIso.split("-").map(Number);
  return JOURS[(new Date(Date.UTC(a, m - 1, j)).getUTCDay() + 6) % 7];
}

// Heure prévue ce jour-là (« HH:MM ») ou null s'il n'y a pas d'épisode.
export function heurePrevue(planning, dateIso) {
  const exception = planning.exceptions.find((e) => e.date === dateIso);
  if (exception) return exception.heure;
  if (planning.pauses.some((p) => dateIso >= p.du && dateIso <= p.au)) return null;
  if (planning.feries !== "normal" && estFerie(planning, dateIso)) {
    return planning.feries === "aucun" ? null : planning.jours.dim;
  }
  return planning.jours[jourDeSemaine(dateIso)] ?? null;
}

export function prochainEpisode(planning, maintenant) {
  // maintenant = { date: "YYYY-MM-DD", heure: "HH:MM" }
  for (let i = 0; i < 30; i++) {
    const date = ajouterJours(maintenant.date, i);
    const heure = heurePrevue(planning, date);
    if (heure && (i > 0 || heure > maintenant.heure)) return { date, heure };
  }
  return null;
}

export function nettoyerPlanning(planning, aujourdHui) {
  planning.exceptions = planning.exceptions.filter((e) => e.date >= aujourdHui).sort((a, b) => a.date.localeCompare(b.date));
  planning.pauses = planning.pauses.filter((p) => p.au >= aujourdHui).sort((a, b) => a.du.localeCompare(b.du));
}

export function heureValide(texte) {
  if (texte == null) return null;
  const t = normaliserTexte(texte);
  if (["aucun", "aucune", "non", "pas", "pas d'episode", "rien", "off", "null", ""].includes(t)) return null;
  const m = /^(\d{1,2})\s*(?:h|:|\.)?\s*(\d{2})?$/.exec(t.replace(/\s+/g, ""));
  if (!m) throw new Error(`heure non reconnue : ${texte}`);
  const h = Number(m[1]), mn = Number(m[2] || 0);
  if (h > 23 || mn > 59) throw new Error(`heure non reconnue : ${texte}`);
  return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
}

// Jour férié selon le canton ou le pays choisi (Vaud : calculé ici ; autres : liste téléchargée).
export function estFerie(planning, dateIso) {
  return Boolean(nomFerie(planning, dateIso));
}

// Régions dont les fériés sont calculés ici ; les autres sont téléchargés (Nager.Date).
export const FERIES_CALCULES = ["CH-VD", "FR", "--"];

export function nomFerie(planning, dateIso) {
  const region = planning?.feries_region || "CH-VD";
  if (region === "CH-VD") return estFerieVaud(dateIso) ? "férié" : null;
  if (region === SANS_PAYS) return null;
  if (region === "FR") return feriesFrance(Number(dateIso.slice(0, 4))).get(dateIso) || null;
  const liste = planning.feries_cache?.[dateIso.slice(0, 4)] || [];
  return (liste.find(([d]) => d === dateIso) || [])[1] || null;
}

// ─────────────────────────── voix et animateurs ─────────────────────────────
// Chaque voix est un animateur possible, sous son nom de voix ou sous le prénom
// que l'auditeur lui a donné. Les deux animateurs habituels sont deux voix ;
// « selon le jour » range deux voix par jour (une place laissée vide revient à
// l'habituel) ; « au hasard » tire parmi les voix activées. Une voix désactivée
// n'est jamais choisie ; un animateur habituel ne peut pas l'être.

const NOMS_VOIX = VOIX.map(([nom]) => nom);

// Deux prénoms qui donnent le même locuteur pour podcast.py (lettres et chiffres
// sans accents) sont le même prénom.
const clePrenom = (t) => normaliserTexte(t).replace(/[^a-z0-9]/g, "");

export function nomVoix(v, voix) {
  return v?.noms?.[voix] || voix;
}

export function voixActive(v, voix) {
  return NOMS_VOIX.includes(voix) && !(v?.inactives || []).includes(voix);
}

// Les animateurs possibles : les voix activées, avec leur nom.
export function equipeComplete(v) {
  return NOMS_VOIX.filter((voix) => voixActive(v, voix)).map((voix) => ({ nom: nomVoix(v, voix), voix }));
}

// Une voix désignée par le prénom qu'on lui a donné ou par son nom de voix.
export function trouverVoix(v, texte) {
  const cle = clePrenom(texte);
  if (!cle) return null;
  return NOMS_VOIX.find((voix) => clePrenom(nomVoix(v, voix)) === cle) || NOMS_VOIX.find((voix) => clePrenom(voix) === cle) || null;
}

// « Léa (Aoede) », ou « Kore » pour une voix sans prénom.
export function decrireVoix(v, voix) {
  const nom = nomVoix(v, voix);
  return nom === voix ? voix : `${nom} (${voix})`;
}

// Prénoms valables : au moins une lettre ou un chiffre, uniques, et jamais le nom
// d'une autre voix (on saurait plus de laquelle on parle).
function nettoyerNoms(noms) {
  const pris = new Map(NOMS_VOIX.map((voix) => [clePrenom(voix), voix]));
  const resultat = {};
  for (const voix of NOMS_VOIX) {
    const nom = String(noms?.[voix] ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PRENOM);
    const cle = clePrenom(nom);
    if (!cle || nom === voix || (pris.has(cle) && pris.get(cle) !== voix)) continue;
    pris.set(cle, voix);
    resultat[voix] = nom;
  }
  return resultat;
}

function rafraichirAnimateurs(v) {
  v.animateurs = v.animateurs.map((a) => ({ nom: nomVoix(v, a.voix), voix: a.voix }));
}

// Donne un prénom à une voix (vide : elle reprend son nom). Renvoie ce qui est affiché.
export function renommerVoix(v, voix, nomBrut) {
  if (!NOMS_VOIX.includes(voix)) throw new Error("voix inconnue");
  const nom = String(nomBrut ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PRENOM);
  const noms = { ...(v.noms || {}) };
  if (!nom || nom === voix) delete noms[voix];
  else {
    const cle = clePrenom(nom);
    if (!cle) throw new Error("le prénom doit contenir au moins une lettre");
    const autre = NOMS_VOIX.find((x) => x !== voix && (clePrenom(nomVoix(v, x)) === cle || clePrenom(x) === cle));
    if (autre) throw new Error(clePrenom(autre) === cle ? `« ${nom} » est le nom d'une autre voix` : `« ${nom} » est déjà le prénom de la voix ${autre}`);
    noms[voix] = nom;
  }
  v.noms = noms;
  rafraichirAnimateurs(v);
  return decrireVoix(v, voix);
}

// Une voix (ou son prénom) devient l'animateur habituel n° i. Choisir l'autre
// habituel les échange ; une voix désactivée redevient utilisée.
export function choisirHabituel(v, i, texte) {
  const voix = NOMS_VOIX.includes(texte) ? texte : trouverVoix(v, texte);
  if (!voix) throw new Error(`voix inconnue : ${texte}`);
  const animateurs = v.animateurs.map((a) => ({ ...a }));
  if (animateurs[1 - i].voix === voix) animateurs[1 - i] = animateurs[i];
  animateurs[i] = { voix };
  v.animateurs = animateurs;
  v.inactives = (v.inactives || []).filter((x) => x !== voix);
  rafraichirAnimateurs(v);
  return decrireVoix(v, voix);
}

// Utiliser ou non une voix. Les jours qui l'avaient choisie reviennent à l'habituel.
export function activerVoix(v, voixBrute, active) {
  const voix = NOMS_VOIX.includes(voixBrute) ? voixBrute : trouverVoix(v, voixBrute);
  if (!voix) throw new Error(`voix inconnue : ${voixBrute}`);
  if (!active && v.animateurs.some((a) => a.voix === voix)) {
    throw new Error(`${nomVoix(v, voix)} est un de tes animateurs habituels : choisis-en un autre avant de ne plus l'utiliser`);
  }
  const inactives = new Set(v.inactives || []);
  if (active) inactives.delete(voix); else inactives.add(voix);
  v.inactives = NOMS_VOIX.filter((x) => inactives.has(x));
  if (!active) v.jours = nettoyerJours(v);
  return `${decrireVoix(v, voix)} : ${active ? "utilisée" : "plus utilisée"}`;
}

// Voix d'un jour de la semaine (mode « selon le jour »), deux places au plus ;
// une place vide revient à l'habituel. Une voix désactivée redevient utilisée.
export function choisirVoixJour(v, jour, places) {
  if (!JOURS.includes(jour)) throw new Error("jour inconnu");
  const liste = (Array.isArray(places) ? places : []).slice(0, 2).map((x) => {
    if (!x) return "";
    const voix = NOMS_VOIX.includes(x) ? x : trouverVoix(v, x);
    if (!voix) throw new Error(`voix inconnue : ${x}`);
    return voix;
  });
  v.inactives = (v.inactives || []).filter((x) => !liste.includes(x));
  v.jours = nettoyerJours({ ...v, jours: { ...(v.jours || {}), [jour]: liste } });
  const voulus = v.solo ? 1 : 2;
  return `${NOMS_JOURS[jour][0].toUpperCase()}${NOMS_JOURS[jour].slice(1)} : ${placesDuJour(v, jour).slice(0, voulus).map((x) => nomVoix(v, x)).join(" & ")}`;
}

function nettoyerJours(v) {
  const jours = {};
  for (const j of JOURS) {
    const liste = (Array.isArray(v.jours?.[j]) ? v.jours[j] : []).slice(0, 2).map((x) => (voixActive(v, x) ? x : ""));
    if (liste[1] && liste[1] === liste[0]) liste[1] = "";
    if (liste.some(Boolean)) jours[j] = [liste[0] || "", liste[1] || ""];
  }
  return jours;
}

// Les deux voix d'un jour de la semaine en mode « selon le jour » : celles choisies,
// et les animateurs habituels aux places laissées vides.
export function placesDuJour(v, jour) {
  const choisies = [0, 1].map((i) => { const x = v.jours?.[jour]?.[i]; return voixActive(v, x) ? x : ""; });
  if (choisies[1] === choisies[0]) choisies[1] = "";
  const libres = v.animateurs.map((a) => a.voix).filter((x) => !choisies.includes(x));
  return choisies.map((x) => x || libres.shift());
}

// Animateurs de l'épisode d'un jour : habituels, selon le jour, ou tirés au sort
// (toujours le même tirage pour une date donnée), un seul en mode « une voix ».
export function animateursDuJour(config, dateIso) {
  const v = config.voix, voulus = v.solo ? 1 : 2;
  let voix = v.animateurs.map((a) => a.voix);
  if (v.mode === "jours") voix = placesDuJour(v, jourDeSemaine(dateIso));
  else if (v.mode === "aleatoire") {
    let graine = [...dateIso].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
    const hasard = () => { graine = Math.imul(graine ^ (graine >>> 15), 2246822507) >>> 0; graine ^= graine >>> 13; return (graine >>> 0) / 4294967296; };
    voix = equipeComplete(v).map((a) => a.voix);
    for (let i = voix.length - 1; i > 0; i--) { const j = Math.floor(hasard() * (i + 1)); [voix[i], voix[j]] = [voix[j], voix[i]]; }
  }
  return voix.slice(0, voulus).map((x) => ({ nom: nomVoix(v, x), voix: x }));
}

// Réglages des voix lus (anciennes versions comprises). Avant 2026-10-21.10, un
// animateur était un prénom ET une voix, avec une « équipe » d'autres animateurs
// et une sélection pour le tirage au sort : les prénoms passent à leur voix, les
// jours suivent, et le tirage garde ses voix (les autres sont désactivées).
function completerVoix(ancienne, base) {
  const v = { ...base, ...(ancienne || {}) };
  const anciens = Array.isArray(v.animateurs) && v.animateurs.length === 2 ? v.animateurs : base.animateurs;
  if (ancienne && (!ancienne.noms || typeof ancienne.noms !== "object")) {
    const equipe = [...anciens, ...(Array.isArray(v.equipe) ? v.equipe : [])]
      .filter((a) => NOMS_VOIX.includes(a?.voix) && String(a?.nom ?? "").trim());
    v.noms = {};
    for (const a of equipe) if (!v.noms[a.voix]) v.noms[a.voix] = String(a.nom).trim();
    const parNom = (nom) => equipe.find((a) => normaliserTexte(a.nom) === normaliserTexte(nom))?.voix || "";
    const jours = v.jours && typeof v.jours === "object" ? v.jours : {};
    v.jours = Object.fromEntries(Object.entries(jours).map(([j, noms]) => [j, (Array.isArray(noms) ? noms : []).slice(0, 2).map(parNom)]));
    if (v.mode === "aleatoire") {
      let tirage = (Array.isArray(v.tirage) ? v.tirage : []).map(parNom).filter(Boolean);
      if (new Set(tirage).size < (v.solo ? 1 : 2)) tirage = equipe.map((a) => a.voix);
      v.inactives = NOMS_VOIX.filter((x) => !tirage.includes(x));
    }
  }
  delete v.equipe;
  delete v.tirage;
  v.noms = nettoyerNoms(v.noms);
  const habituels = anciens.map((a, i) => (NOMS_VOIX.includes(a?.voix) ? a.voix : base.animateurs[i].voix));
  if (habituels[1] === habituels[0]) habituels[1] = [base.animateurs[1].voix, base.animateurs[0].voix].find((x) => x !== habituels[0]);
  v.inactives = NOMS_VOIX.filter((x) => (Array.isArray(v.inactives) ? v.inactives : []).includes(x) && !habituels.includes(x));
  v.animateurs = habituels.map((voix) => ({ nom: nomVoix(v, voix), voix }));
  v.jours = nettoyerJours(v);
  if (!MODES_VOIX[v.mode]) v.mode = "fixe";
  v.solo = Boolean(v.solo);
  return v;
}

// Jours fériés du canton de Vaud.
export function estFerieVaud(dateIso) {
  const annee = Number(dateIso.slice(0, 4));
  return feriesVaud(annee).has(dateIso);
}

export function feriesVaud(annee) {
  const paques = datePaques(annee);
  const decale = (n) => ajouterJours(paques, n);
  // Lundi du Jeûne fédéral : lundi qui suit le 3e dimanche de septembre.
  const premier = new Date(Date.UTC(annee, 8, 1));
  const premierDimanche = 1 + ((7 - premier.getUTCDay()) % 7);
  const jeune = `${annee}-09-${String(premierDimanche + 14 + 1).padStart(2, "0")}`;
  return new Set([`${annee}-01-01`, `${annee}-01-02`, decale(-2), decale(1), decale(39), decale(50),
                  `${annee}-08-01`, jeune, `${annee}-12-25`]);
}

// Jours fériés de France (métropole).
export function feriesFrance(annee) {
  const paques = datePaques(annee);
  const decale = (n) => ajouterJours(paques, n);
  return new Map([[`${annee}-01-01`, "Jour de l'an"], [decale(1), "Lundi de Pâques"], [`${annee}-05-01`, "Fête du Travail"],
    [`${annee}-05-08`, "Victoire 1945"], [decale(39), "Ascension"], [decale(50), "Lundi de Pentecôte"], [`${annee}-07-14`, "Fête nationale"],
    [`${annee}-08-15`, "Assomption"], [`${annee}-11-01`, "Toussaint"], [`${annee}-11-11`, "Armistice 1918"], [`${annee}-12-25`, "Noël"]]);
}

function datePaques(annee) {
  const a = annee % 19, b = Math.floor(annee / 100), c = annee % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31), jour = ((h + l - 7 * m + 114) % 31) + 1;
  return `${annee}-${String(mois).padStart(2, "0")}-${String(jour).padStart(2, "0")}`;
}

// ──────────────────────────────── utilitaires ───────────────────────────────

export function ajouterJours(dateIso, n) {
  const [a, m, j] = dateIso.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1, j + n));
  return d.toISOString().slice(0, 10);
}

const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
export function dateCourte(dateIso) {
  const [, m, j] = dateIso.split("-").map(Number);
  return `${NOMS_JOURS[jourDeSemaine(dateIso)].slice(0, 3)}. ${j} ${MOIS[m - 1]}`;
}

export function heureParlee(heure) {
  if (!heure) return "—";
  const [h, m] = heure.split(":").map(Number);
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

export function dateOuNull(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function nombreOuNull(v) {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

export function normaliserTexte(t) {
  return String(t ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

export function nettoyerListe(valeur, maximum = 15, longueur = 80) {
  const vus = new Set();
  return (Array.isArray(valeur) ? valeur : [])
    .map((v) => String(v ?? "").replace(/\s+/g, " ").trim().replace(/^[ .;,]+|[ .;,]+$/g, "").slice(0, longueur))
    .filter((v) => v && !vus.has(normaliserTexte(v)) && vus.add(normaliserTexte(v)))
    .slice(0, maximum);
}

export function cloner(objet) {
  return JSON.parse(JSON.stringify(objet));
}

function completerSources(sources) {
  const vus = new Set();
  return {
    coupees: nettoyerListe(sources?.coupees, 20).filter((s) => SOURCES[s]),
    flux: (Array.isArray(sources?.flux) ? sources.flux : [])
      .filter((f) => f && /^[0-9a-z]{4,16}$/.test(f.id) && /^https?:\/\//i.test(f.url || "") && !vus.has(f.id) && vus.add(f.id))
      .slice(0, MAX_FLUX_SPECIALISES)
      .map((f) => ({ id: f.id, nom: String(f.nom || f.url).replace(/\s+/g, " ").trim().slice(0, 60), url: String(f.url).slice(0, 300) })),
  };
}

// Avant Réglages › Sources (2026-10-22) : des sources « choisies par l'application » et,
// à la fabrication, saints et fêtes ajoutés d'après le titre. On les rend explicites une
// fois, pour que la fiche montre exactement ce que la rubrique lit.
function migrerSources(regles, anciennes) {
  regles.forEach((r, i) => {
    if (r.periode.type === "ponctuelle") return;
    const sources = new Set(r.recherche?.sources || []);
    const sujet = normaliserTexte(`${r.titre} ${r.consigne}`);
    if (/prenom|saint|fete du jour|fete des prenoms/.test(sujet)) sources.add("saints");
    if (/fete (inter)?nationale|fete internationale|journee (mondiale|internationale|nationale)|fete du jour/.test(sujet)) sources.add("fetes");
    if (/\btrains?\b|retard|\bcff\b|sncf|sncb|\bgare\b/.test(sujet) || ["train", "peu_importe"].includes(r.recherche?.fiche?.transport)) sources.add("transports");
    if (r.condition) sources.add("agenda");
    if (!sources.size && !anciennes[i]?.recherche) return;    // rien à rendre visible
    r.recherche = r.recherche || { fiche: normaliserRegle({ recherche: {} }).recherche.fiche, sources: [], requetes: [] };
    r.recherche.sources = [...sources].slice(0, 15);
  });
}

// Complète une configuration lue (anciennes versions, champs manquants).
// Une consigne de style qui parle de l'agenda (« mentionne l'événement piscine la veille seulement »)
// est une consigne de la rubrique Agenda : rangée là une fois, quand les consignes par rubrique arrivent.
const MOTS_AGENDA = /\b(agenda|calendrier|evenements?|rendez-vous|rdv|reunions?)\b/;
export const parleDeLAgenda = (consigne) => MOTS_AGENDA.test(normaliserTexte(consigne));

function completerConsignes(resultat, config) {
  const anciennes = config?.consignes_rubriques;
  const consignes = consignesRubriquesVides();
  for (const cle of Object.keys(consignes)) {
    consignes[cle] = nettoyerListe(Array.isArray(anciennes?.[cle]) ? anciennes[cle] : [], 20, LONGUEUR_CONSIGNE);
  }
  resultat.consignes = nettoyerListe(Array.isArray(resultat.consignes) ? resultat.consignes : [], 20, LONGUEUR_CONSIGNE);
  if (!anciennes) {
    consignes.agenda = resultat.consignes.filter(parleDeLAgenda);
    resultat.consignes = resultat.consignes.filter((c) => !parleDeLAgenda(c));
  }
  resultat.consignes_rubriques = consignes;
}

export function completerConfig(config) {
  const base = configParDefaut();
  const resultat = { ...base, ...(config || {}) };
  delete resultat.livraison;   // ancien réglage (épisode aussi envoyé dans une conversation)
  if (!PAYS[resultat.pays]) resultat.pays = PAYS_DEFAUT;
  for (const cle of ["planning", "format", "agenda", "actus"]) resultat[cle] = { ...base[cle], ...(config?.[cle] || {}) };
  delete resultat.actus.citer_sources;   // ancien réglage : les sources sont toujours dans la fiche de l'épisode
  completerConsignes(resultat, config);
  resultat.voix = completerVoix(config?.voix, base.voix);
  resultat.planning.jours = { ...base.planning.jours, ...(config?.planning?.jours || {}) };
  if (!Array.isArray(resultat.deroule) || !resultat.deroule.length) resultat.deroule = base.deroule;
  for (const cle of Object.keys(RUBRIQUES)) {
    if (!resultat.deroule.some((r) => r.cle === cle)) placerRubrique(resultat, cle, cle === "actu_locale" ? "deplacements" : "agenda");
  }
  resultat.sources = completerSources(config?.sources);
  resultat.regles = (resultat.regles || []).map(normaliserRegle);
  if (!config?.sources) migrerSources(resultat.regles, config?.regles || []);
  renumeroter(resultat);
  resultat.deroule = resultat.deroule.filter((r) => RUBRIQUES[r.cle] || resultat.regles.some((x) => x.id === r.cle && x.rubrique));
  for (const r of resultat.regles) if (r.rubrique) placerRubrique(resultat, r.id, r.rubrique.apres);
  resultat.prochain_numero = resultat.regles.length + 1;
  return resultat;
}
