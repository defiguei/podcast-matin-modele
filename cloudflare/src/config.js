// Modèle de configuration du podcast : valeurs par défaut, validation des
// réglages, règles (création, état, période), planning et jours fériés.
// Tout ce qui est modifiable depuis Telegram passe par ce fichier.

// Profils des pays (fuseau, actualités, devise, jours fériés) : même fichier que pour GitHub.
import PROFILS_PAYS from "../../donnees/pays.json" with { type: "json" };

export const PAYS = PROFILS_PAYS;
export const PAYS_DEFAUT = "CH";
export function profilPays(config) {
  return PAYS[config?.pays] || PAYS[PAYS_DEFAUT];
}
// Médias par défaut : ceux du pays choisi (tant que la liste n'a pas été modifiée).
export function fluxActus(config) {
  return config?.actus?.flux || profilPays(config).flux;
}

export const JOURS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];
export const NOMS_JOURS = { lun: "lundi", mar: "mardi", mer: "mercredi", jeu: "jeudi", ven: "vendredi", sam: "samedi", dim: "dimanche" };
export const COURTS_JOURS = { lun: "Lun", mar: "Mar", mer: "Mer", jeu: "Jeu", ven: "Ven", sam: "Sam", dim: "Dim" };
export const VITESSES = ["très lente", "lente", "normale", "rapide", "très rapide"];
export const TONS = { naturel: "Naturel", serieux: "Sérieux", detendu: "Détendu", humour: "Avec humour" };
export const CITER = { non: "Non", oral: "À l'oral", ecrit: "Dans le message", les_deux: "Les deux" };
export const LONGUEURS = { phrase: "une phrase", courte: "courte", developpee: "développée" };
export const SOURCES = {
  web: "Recherche web (Tavily)", actus: "Actualités", meteo: "Météo", transports: "Trains (CFF, SNCB, SNCF)",
  lieux: "Lieux (OpenStreetMap)", wikivoyage: "Wikivoyage", saints: "Saints du jour", fetes: "Fêtes du jour", feries: "Jours fériés",
};
export const TRANSPORTS = { voiture: "🚗 Voiture", train: "🚆 Train", velo: "🚲 Vélo", pied: "🚶 À pied", peu_importe: "Peu importe", aucun: "Pas de transport" };
export const DEVISES = ["CHF", "EUR", "USD", "GBP"];
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
export const MODES_VOIX = { fixe: "Toujours les mêmes", jours: "Selon le jour", aleatoire: "Au hasard" };

// Rubriques intégrées du déroulé. Les rubriques créées par l'auditeur (« R1 », « R2 »…)
// s'ajoutent à celles-ci. « approfondissements » garde sa clé pour les anciennes sauvegardes.
export const RUBRIQUES = {
  ouverture: "Ouverture", agenda: "Agenda", deplacements: "Mes déplacements",
  actu_locale: "Actu locale", approfondissements: "À creuser", actualites: "Actualités", cloture: "Clôture",
};
// Écran de réglage de chaque rubrique intégrée (null : pas d'écran propre).
export const ECRAN_INTEGREE = {
  agenda: "agenda", deplacements: "deplacements", actu_locale: "actulocale", approfondissements: "acreuser", actualites: "actus",
};
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

export const FLUX_DEFAUT = PAYS[PAYS_DEFAUT].flux;

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
    voix: {
      vitesse: "normale", tutoiement: true, prenom: "",
      animateurs: [{ nom: "Léa", voix: "Aoede" }, { nom: "Hugo", voix: "Puck" }],
      solo: false,        // une seule voix (le premier animateur du jour)
      mode: "fixe",       // fixe | jours (animateurs par jour) | aleatoire (tirage dans une sélection)
      equipe: [],         // autres animateurs possibles : [{ nom, voix }]
      jours: {},          // { lun: ["Léa", "Sam"], … } en mode « jours »
      tirage: [],         // noms retenus pour le tirage au sort
    },
    deroule: Object.keys(RUBRIQUES).map((cle) => ({ cle, actif: true })),
    agenda: { jours: 7, horizon: 90, notes: true, deplacements: true, jours_deplacements: 14,
              max_deplacements: 2, exclus: [] },
    actus: { ville: "", sujets_preferes: [], sujets_a_eviter: [], flux: null, fraicheur_heures: 36, citer_sources: "ecrit",
             locale_articles: 3 },
    consignes: [],
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
const voixValide = (v) => {
  const trouve = VOIX.find(([nom]) => normaliserTexte(nom) === normaliserTexte(v));
  if (!trouve) throw new Error("voix inconnue");
  return trouve[0];
};

export const REGLAGES = {
  "pays": { nom: "Pays", valider: (v) => { const c = String(v || "").toUpperCase(); if (!PAYS[c]) throw new Error("pays non proposé"); return c; } },
  "format.duree_minutes": { nom: "Durée (min)", valider: decimal(2, 12) },
  "format.nombre_sujets": { nom: "Nombre de sujets", valider: entier(1, 8) },
  "format.ton": { nom: "Ton", valider: parmi(Object.keys(TONS)) },
  "voix.vitesse": { nom: "Vitesse", valider: parmi(VITESSES) },
  "voix.tutoiement": { nom: "Tutoiement", valider: booleen },
  "voix.prenom": { nom: "Ton prénom", valider: texteCourt(40) },
  "voix.animateurs.0.nom": { nom: "Prénom de l'animateur 1", valider: texteCourt(20) },
  "voix.animateurs.0.voix": { nom: "Voix de l'animateur 1", valider: voixValide },
  "voix.animateurs.1.nom": { nom: "Prénom de l'animateur 2", valider: texteCourt(20) },
  "voix.animateurs.1.voix": { nom: "Voix de l'animateur 2", valider: voixValide },
  "voix.solo": { nom: "Une seule voix", valider: booleen },
  "voix.mode": { nom: "Choix des animateurs", valider: parmi(Object.keys(MODES_VOIX)) },
  "agenda.jours": { nom: "Jours d'agenda couverts", valider: entier(1, 31) },
  "agenda.horizon": { nom: "Horizon du prochain événement (jours)", valider: entier(7, 365) },
  "agenda.notes": { nom: "Lire les notes des événements", valider: booleen },
  "agenda.deplacements": { nom: "Repérer les déplacements", valider: booleen },
  "agenda.jours_deplacements": { nom: "Déplacements repérés jusqu'à (jours)", valider: entier(1, 60) },
  "agenda.max_deplacements": { nom: "Nombre maximum de lieux présentés", valider: entier(1, 4) },
  "actus.locale_articles": { nom: "Articles d'actu locale lus", valider: entier(1, 8) },
  "actus.ville": { nom: "Ville", valider: texteCourt(60) },
  "actus.sujets_preferes": { nom: "Thèmes préférés", valider: liste() },
  "actus.sujets_a_eviter": { nom: "Thèmes à éviter", valider: liste() },
  "actus.fraicheur_heures": { nom: "Âge max. des actus (h)", valider: entier(6, 168) },
  "actus.citer_sources": { nom: "Citer les sources", valider: parmi(Object.keys(CITER)) },
  "consignes": { nom: "Consignes", valider: liste(20, LONGUEUR_CONSIGNE) },
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
  const ancienPays = config.pays;
  ecrireChemin(config, chemin, valeur);
  // Changer de pays : les jours fériés suivent, s'ils étaient ceux de l'ancien pays.
  if (chemin === "pays" && ancienPays !== valeur && (config.planning.feries_region || "CH-VD") === profilPays({ pays: ancienPays }).feries) {
    config.planning.feries_region = profilPays(config).feries;
    config.planning.feries_cache = {};
  }
  if (chemin === "actus.sujets_a_eviter") {
    const exclus = new Set(valeur.map(normaliserTexte));
    config.actus.sujets_preferes = config.actus.sujets_preferes.filter((s) => !exclus.has(normaliserTexte(s)));
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
  if (chemin === "actus.citer_sources") return CITER[valeur] || valeur;
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
    sources: nettoyerListe(r.recherche.sources, 9).filter((s) => SOURCES[s]),
    requetes: nettoyerListe(r.recherche.requetes, 6),
    sources_auto: Boolean(r.recherche.sources_auto),
  } : null;
  if (recherche && !recherche.sources.length) recherche.sources = ["web"];
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

// Sources choisies d'après le sujet de la rubrique (« Choisies par l'application »).
// Un simple rappel selon l'agenda n'a besoin d'aucune source.
export function sourcesAuto({ titre = "", consigne = "", fiche = {}, condition = null } = {}) {
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
  const rappel = condition && /rappelle|pense a|n.oublie|prepare|prendre|mentionne/.test(t);
  if (!sources.size && !rappel) sources.add("web");
  return [...sources];
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

// Modifie un champ d'une rubrique à partir d'un texte tapé (« - » pour vider).
export const CHAMPS_RUBRIQUE = {
  titre: "Titre", consigne: "Consigne", quoi: "Quoi", avec_qui: "Avec qui", ages: "Âges", ou: "Où", rayon_km: "Rayon (km)",
  quand: "Quand", attendu: "Résultat attendu", inclure: "À inclure", exclure: "À exclure", requetes: "Recherches web",
  condition: "Condition d'agenda",
};

export function modifierChamp(config, id, champ, texte, aujourdHui) {
  const regle = config.regles.find((r) => r.id === id);
  if (!regle) throw new Error(`rubrique ${id} introuvable`);
  if (!CHAMPS_RUBRIQUE[champ]) throw new Error(`champ inconnu : ${champ}`);
  const brut = String(texte ?? "").trim();
  const vide = /^(-|—|aucun|aucune|rien|vide)$/i.test(brut);
  let valeur = vide ? "" : brut;
  let champs;
  switch (champ) {
    case "titre":
      if (!valeur) throw new Error("le titre ne peut pas être vide");
      valeur = texteCourt(50)(valeur);
      champs = { titre: valeur, ...(regle.rubrique ? { rubrique: { titre: valeur } } : {}) };
      break;
    case "consigne":
      if (!valeur) throw new Error("la consigne ne peut pas être vide");
      champs = { consigne: valeur };
      break;
    case "ou":
      champs = { recherche: { fiche: { ou: valeur, lat: null, lon: null } } };
      break;
    case "rayon_km": {
      const n = vide ? null : Number(brut.replace(",", ".").replace(/[^\d.]/g, ""));
      if (n !== null && (!Number.isFinite(n) || n < 1 || n > 200)) throw new Error("rayon attendu entre 1 et 200 km");
      champs = { recherche: { fiche: { rayon_km: n } } };
      break;
    }
    case "inclure": case "exclure":
      champs = { recherche: { fiche: { [champ]: vide ? [] : nettoyerListe(brut.split(/[,;\n]/), 8) } } };
      break;
    case "requetes":
      champs = { recherche: { requetes: vide ? [] : nettoyerListe(brut.split(/[;\n]/), 6) } };
      break;
    case "condition":
      champs = { condition: vide ? null : { texte: valeur, moment: regle.condition?.moment || "jour_meme", n: regle.condition?.n || 1 } };
      break;
    default:
      champs = { recherche: { fiche: { [champ]: valeur } } };
  }
  const modifiee = modifierRegle(config, id, champs, aujourdHui);
  return `${id} · ${CHAMPS_RUBRIQUE[champ]} : ${vide ? "vidé" : valeur.slice(0, 60)}`;
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

// Comprend une période écrite à la main : « jusqu'au 15 novembre », « du 20 au 24 octobre »,
// « à partir du 3/11 ». Renvoie { debut, fin } (null si absent) ou null si rien n'est compris.
const NOMS_MOIS = ["janv", "fevr", "mars", "avr", "mai", "juin", "juil", "aout", "sept", "oct", "nov", "dec"];
export function analyserPeriode(texte, aujourdHui) {
  const t = normaliserTexte(texte).replace(/1er/g, "1");
  const annee = Number(aujourdHui.slice(0, 4));
  const date = (jour, mois, an) => {
    const j = Number(jour), m = Number(mois);
    if (!(j >= 1 && j <= 31 && m >= 1 && m <= 12)) return null;
    let a = an ? Number(an.length === 2 ? `20${an}` : an) : annee;
    let iso = `${a}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
    if (!an && iso < aujourdHui) iso = `${a + 1}-${iso.slice(5)}`;
    return iso;
  };
  const motif = "(\\d{4})-(\\d{2})-(\\d{2})|(\\d{1,2})\\s*[/.]\\s*(\\d{1,2})(?:\\s*[/.]\\s*(\\d{2,4}))?|(\\d{1,2})(?:\\s*([a-z]{3,9})\\.?)?(?:\\s+(\\d{4}))?";
  const trouvees = [];
  for (const m of t.matchAll(new RegExp(motif, "g"))) {
    let iso = null, jourSeul = null;
    if (m[1]) iso = `${m[1]}-${m[2]}-${m[3]}`;
    else if (m[4]) iso = date(m[4], m[5], m[6]);
    else if (m[7]) {
      const mois = m[8] ? NOMS_MOIS.findIndex((n) => m[8].startsWith(n)) + 1 : 0;
      if (mois) iso = date(m[7], mois, m[9]);
      else if (!m[8]) jourSeul = Number(m[7]);
      else continue;
    }
    if (iso || jourSeul) trouvees.push({ iso, jourSeul, index: m.index });
  }
  // « du 20 au 24 octobre » : le premier jour hérite du mois du second.
  for (let i = 0; i < trouvees.length; i++) {
    const d = trouvees[i];
    if (!d.iso && d.jourSeul && trouvees[i + 1]?.iso) {
      const suivant = trouvees[i + 1].iso;
      let iso = `${suivant.slice(0, 8)}${String(d.jourSeul).padStart(2, "0")}`;
      if (iso > suivant) iso = `${suivant.slice(0, 5)}${String(Number(suivant.slice(5, 7)) - 1).padStart(2, "0")}-${String(d.jourSeul).padStart(2, "0")}`;
      d.iso = iso;
    }
  }
  const dates = trouvees.filter((d) => d.iso).map((d) => d.iso);
  if (!dates.length) return null;
  if (dates.length >= 2 && /\bdu\b|entre|\bau\b|\ba\b/.test(t)) return { debut: dates[0], fin: dates[1] };
  if (/(partir|des le|depuis|a compter|apres le)/.test(t)) return { debut: dates[0], fin: null };
  return { debut: null, fin: dates[0] };   // « jusqu'au 15 novembre » ou une date seule
}

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

export function deplacerRubrique(config, cle, sens) {
  const i = config.deroule.findIndex((r) => r.cle === cle);
  const j = i + sens;
  if (i < 0 || j < 0 || j >= config.deroule.length) return false;
  [config.deroule[i], config.deroule[j]] = [config.deroule[j], config.deroule[i]];
  return true;
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

export function decalerHeure(heure, minutes) {
  const [h, m] = (heure || "07:30").split(":").map(Number);
  const total = Math.max(0, Math.min(23 * 60 + 45, h * 60 + m + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Jour férié selon le canton ou le pays choisi (Vaud : calculé ici ; autres : liste téléchargée).
export function estFerie(planning, dateIso) {
  return Boolean(nomFerie(planning, dateIso));
}

// Régions dont les fériés sont calculés ici ; les autres sont téléchargés (Nager.Date).
export const FERIES_CALCULES = ["CH-VD", "FR"];

export function nomFerie(planning, dateIso) {
  const region = planning?.feries_region || "CH-VD";
  if (region === "CH-VD") return estFerieVaud(dateIso) ? "férié" : null;
  if (region === "FR") return feriesFrance(Number(dateIso.slice(0, 4))).get(dateIso) || null;
  const liste = planning.feries_cache?.[dateIso.slice(0, 4)] || [];
  return (liste.find(([d]) => d === dateIso) || [])[1] || null;
}

// Animateurs de l'épisode d'un jour : habituels, selon le jour, ou tirés au sort
// (toujours le même tirage pour une date donnée), un seul en mode « une voix ».
export function equipeComplete(voix) {
  const vus = new Set();
  return [...(voix.animateurs || []), ...(voix.equipe || [])]
    .filter((a) => a?.nom && a?.voix && !vus.has(normaliserTexte(a.nom)) && vus.add(normaliserTexte(a.nom)));
}

export function animateursDuJour(config, dateIso) {
  const v = config.voix, equipe = equipeComplete(v);
  const trouver = (nom) => equipe.find((a) => normaliserTexte(a.nom) === normaliserTexte(nom));
  const voulus = v.solo ? 1 : 2;
  let choix = [...v.animateurs];
  if (v.mode === "jours") {
    const noms = (v.jours?.[jourDeSemaine(dateIso)] || []).map(trouver).filter(Boolean);
    if (noms.length) choix = noms;
  } else if (v.mode === "aleatoire") {
    let candidats = (v.tirage || []).map(trouver).filter(Boolean);
    if (candidats.length < voulus) candidats = equipe;
    let graine = [...dateIso].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
    const hasard = () => { graine = Math.imul(graine ^ (graine >>> 15), 2246822507) >>> 0; graine ^= graine >>> 13; return (graine >>> 0) / 4294967296; };
    choix = [...candidats];
    for (let i = choix.length - 1; i > 0; i--) { const j = Math.floor(hasard() * (i + 1)); [choix[i], choix[j]] = [choix[j], choix[i]]; }
  }
  for (const a of equipe) if (choix.length < voulus && !choix.some((x) => normaliserTexte(x.nom) === normaliserTexte(a.nom))) choix.push(a);
  return choix.slice(0, voulus).map((a) => ({ nom: a.nom, voix: a.voix }));
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

// Complète une configuration lue (anciennes versions, champs manquants).
export function completerConfig(config) {
  const base = configParDefaut();
  const resultat = { ...base, ...(config || {}) };
  if (!PAYS[resultat.pays]) resultat.pays = PAYS_DEFAUT;
  for (const cle of ["planning", "format", "voix", "agenda", "actus"]) resultat[cle] = { ...base[cle], ...(config?.[cle] || {}) };
  for (const cle of ["equipe", "tirage"]) if (!Array.isArray(resultat.voix[cle])) resultat.voix[cle] = [];
  if (!resultat.voix.jours || typeof resultat.voix.jours !== "object") resultat.voix.jours = {};
  resultat.planning.jours = { ...base.planning.jours, ...(config?.planning?.jours || {}) };
  if (!Array.isArray(resultat.voix.animateurs) || resultat.voix.animateurs.length !== 2) resultat.voix.animateurs = base.voix.animateurs;
  if (!Array.isArray(resultat.deroule) || !resultat.deroule.length) resultat.deroule = base.deroule;
  for (const cle of Object.keys(RUBRIQUES)) {
    if (!resultat.deroule.some((r) => r.cle === cle)) placerRubrique(resultat, cle, cle === "actu_locale" ? "deplacements" : "agenda");
  }
  resultat.regles = (resultat.regles || []).map(normaliserRegle);
  renumeroter(resultat);
  resultat.deroule = resultat.deroule.filter((r) => RUBRIQUES[r.cle] || resultat.regles.some((x) => x.id === r.cle && x.rubrique));
  for (const r of resultat.regles) if (r.rubrique) placerRubrique(resultat, r.id, r.rubrique.apres);
  resultat.prochain_numero = resultat.regles.length + 1;
  return resultat;
}
