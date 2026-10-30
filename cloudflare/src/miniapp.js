// Application : liens audio signés, données des écrans et traduction des
// formulaires en modifications de la configuration. L'accès est vérifié par le
// Worker (jeton de l'appareil, donné contre un code à 6 chiffres).

import {
  JOURS, NOMS_JOURS, COURTS_JOURS, LONGUEURS, SOURCES, RUBRIQUES, etatRegle, prochainPassage, decrirePeriode,
  heurePrevue, prochainEpisode, ajouterJours, dateCourte, nomRubrique, dateOuNull, nettoyerListe,
  VOIX, VOIX_CONSEILLEES, VITESSES, TONS, DESCRIPTIONS_TONS, CONSIGNES_PRETES, CONSIGNES_PRETES_RUBRIQUES, CHEMINS_CONSIGNES, TRANSPORTS, fluxActus, profilPays, PAYS, DELAIS_RATTRAPAGE,
  DEVISES, CANTONS, MODES_VOIX, sourcesAuto, estFerie, nomFerie, animateursDuJour, placesDuJour, normaliserTexte,
  jourDeSemaine, MODELES_RUBRIQUES, CATEGORIES_RUBRIQUES, catalogueRubriques, nouvelleRegle, modifierRegle,
  INFOS_SOURCES, sourceConnue, rubriqueExistante, idRubriqueSource, sourcesUtilisables, RENDUS, minutesPoint, recherchesWeb, RANGEMENT_SOURCES, fluxProposes, MAX_SOURCES_RUBRIQUE,
  SOURCES_PAR_MODELE, SOURCES_INTEGREES, nommerAgendas,
} from "./config.js";
import { apercuDonnees } from "./donnees.js";

const DUREE_VALIDITE = 24 * 3600;      // un lien audio reste valable 24 h
const MOIS_CALENDRIER = 12;            // le planning se feuillette jusqu'à un an à l'avance
export const PERIODES = ["toujours", "dates", "jours", "une_fois", "ponctuelle"];
const MOMENTS = ["jour_meme", "veille", "jours_avant"];
const CHAMPS_FICHE = ["quoi", "avec_qui", "ages", "ou", "quand", "attendu"];
// Listes modifiables d'un bloc depuis l'application.
export const LISTES_APP = ["consignes", ...CHEMINS_CONSIGNES, "actus.sujets_preferes", "actus.sujets_a_eviter",
  "actus.locale_preferes", "actus.locale_a_eviter"];
// Réglages simples modifiables depuis l'application (validés par config.js).
export const REGLAGES_APP = [
  "format.duree_minutes", "format.nombre_sujets", "format.ton", "voix.vitesse", "voix.tutoiement", "voix.prenom",
  "voix.animateurs.0.nom", "voix.animateurs.0.voix", "voix.animateurs.1.nom", "voix.animateurs.1.voix",
  "agenda.jours", "agenda.horizon", "agenda.notes", "agenda.deplacements", "agenda.jours_deplacements", "agenda.max_deplacements",
  "actus.ville", "actus.fraicheur_heures", "actus.articles",
  "actus.locale_sujets", "actus.locale_articles", "actus.locale_fraicheur_heures",
  "planning.rattrapage", "planning.delai_rattrapage", "planning.feries", "planning.avance_minutes",
  "planning.feries_region", "voix.solo", "voix.mode", "pays",
];

// ───────────────────────────── liens audio ──────────────────────────────────
// Le lecteur audio de la page ne peut pas envoyer d'en-tête : chaque fichier a
// une adresse signée, valable 24 h.

export async function signerAudio(secret, cle, expiration) {
  return hex(await hmac(secret, `audio|${cle}|${expiration}`)).slice(0, 40);
}

export async function lienAudio(secret, cle, maintenant = Date.now()) {
  const expiration = Math.floor(maintenant / 1000) + DUREE_VALIDITE;
  return `/app/audio?c=${encodeURIComponent(cle)}&e=${expiration}&s=${await signerAudio(secret, cle, expiration)}`;
}

export async function verifierAudio(secret, params, maintenant = Date.now()) {
  const cle = params.get("c") || "", expiration = Number(params.get("e")), signature = params.get("s") || "";
  if (!/^((img:)?ep:\d{4}-\d{2}-\d{2}(:\d+)?|voix:[A-Za-z]+|idees:dernier|(resume|recherche):[A-Za-z0-9_]{1,24})$/.test(cle) || !expiration || expiration < maintenant / 1000) return null;
  return egal(await signerAudio(secret, cle, expiration), signature) ? cle : null;
}

// ───────────────────────────── signatures ───────────────────────────────────

async function hmac(cle, texte) {
  const k = await crypto.subtle.importKey("raw", typeof cle === "string" ? new TextEncoder().encode(cle) : cle,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(texte)));
}

const hex = (octets) => [...octets].map((o) => o.toString(16).padStart(2, "0")).join("");

function egal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─────────────────────────────── données ────────────────────────────────────

function familleRegle(r) {
  const sources = r.recherche?.sources || [];
  if (r.condition) return "agenda";
  if (sources.some((s) => ["transports", "lieux", "wikivoyage"].includes(s)) || r.recherche?.fiche?.quoi) return "sortie";
  if (sources.length && sources.every((s) => ["meteo", "saints", "fetes", "feries"].includes(s))) return "jour";
  return "info";
}

// Genre de la rubrique (son icône et sa couleur dans l'application) : celui de son modèle, comme
// le nom en haut de sa fiche ; une rubrique sur mesure a le sien. Une recherche ponctuelle, sans
// modèle, le tire de ce qu'elle cherche.
const GENRE_DU_MODELE = { prenom: "prenom", journee: "journee", meteo: "meteo", rappel: "rappel", train: "train",
  actu_pays: "actu", actu_theme: "actu", sortie: "sortie", libre: "libre" };
export function genreRegle(r) {
  if (r.periode?.type !== "ponctuelle" && GENRE_DU_MODELE[r.modele]) return GENRE_DU_MODELE[r.modele];
  const sources = r.recherche?.sources || [];
  const fiche = r.recherche?.fiche || {};
  const titre = normaliserTexte(r.titre || "");
  const texte = normaliserTexte(`${r.titre || ""} ${r.consigne || ""}`);
  if (r.condition) return "rappel";
  if (/\btrains?\b|\bcff\b|sncf|sncb/.test(texte) && /retard|suppr|ponctu|\bcff\b|sncf|sncb|\bgare\b|voie/.test(texte)
      && !fiche.quoi) return "train";
  if (fiche.quoi || fiche.ou || sources.some((s) => ["lieux", "wikivoyage"].includes(s))) return "sortie";
  // Le titre d'abord (« Fête du prénom », « Météo »), puis les sources choisies.
  if (/prenom|\bsaints?\b/.test(titre)) return "prenom";
  if (/journee|fete (inter)?nationale/.test(titre)) return "journee";
  if (/meteo/.test(titre)) return "meteo";
  if (sources.includes("saints")) return "prenom";
  if (sources.includes("fetes")) return "journee";
  if (sources.includes("meteo")) return "meteo";
  if (sources.includes("transports")) return "train";
  if (sources.includes("feries")) return "feries";
  if (sources.includes("actus") || /\bactus?\b|actualite|nouvelles/.test(titre)) return "actu";
  return "libre";
}

function regleVisible(r, aujourdHui) {
  const fiche = r.recherche?.fiche || {};
  return {
    id: r.id, titre: r.titre, consigne: r.consigne, importance: r.importance, pause: r.etat === "pause", modele: r.modele || "libre",
    etat: etatRegle(r, aujourdHui), famille: familleRegle(r), genre: genreRegle(r),
    periode: r.periode, periode_texte: decrirePeriode(r.periode),
    prochain: (() => { const d = prochainPassage(r, aujourdHui); return d ? dateCourte(d) : null; })(),
    longueur: r.rubrique?.longueur || null,
    condition: r.condition,
    sources: r.recherche?.sources || [],
    fiche: Object.fromEntries(CHAMPS_FICHE.map((c) => [c, fiche[c] || ""])),
    transport: fiche.transport || "", budget: fiche.budget || { max: null, unite: "personne", transport_inclus: false },
    inclure: fiche.inclure || [], exclure: fiche.exclure || [], recherche: Boolean(r.recherche),
    rendu: r.recherche?.rendu || "idees", audio: Boolean(r.recherche?.audio), minutes: r.recherche?.minutes || 3,
    recherches: r.recherche?.recherches || 3,
    place: r.rubrique?.apres || null,
    derniere_application: r.derniere_application, servie: Boolean(r.servie), id_condition: Boolean(r.condition),
  };
}

// Un test d'outil tel que l'application le montre : un test parti sur GitHub (le service refuse
// les questions du bot) attend son résultat 5 minutes, puis est donné pour perdu.
function testVisible(maintenant, t) {
  if (!t) return null;
  if (!t.en_cours) return t;
  const enCours = maintenant - (t.lance_ms || 0) < 5 * 60 * 1000;
  return enCours ? { ...t, en_cours: true } : { ok: false, quand: t.quand || null, message: "GitHub n'a pas renvoyé de résultat : regarde l'exécution « Tester mes clés » dans l'onglet Actions." };
}

// Réglages › Sources, rangé par type d'outil : services (avec leur clé), flux, sites, agendas,
// données intégrées. Pour chacun : ce qu'il apporte, qui l'utilise et son dernier test.
function sourcesVisibles(config, etat, aujourdHui, ms = Date.now()) {
  const coupees = config.sources?.coupees || [];
  const tests = etat.tests_outils || {};
  const qui = (s) => config.regles.filter((r) => (r.recherche?.sources || []).includes(s)).map((r) => ({ id: r.id, titre: r.titre }));
  const lus = new Set(config.actus.flux_lus || []);
  const apercu = apercuDonnees(config, aujourdHui);
  // Les rubriques fournies qui lisent un outil (leurs flux, leurs agendas).
  const integrees = config.sources_integrees || {};
  const fourniesPour = (cle) => Object.keys(SOURCES_INTEGREES).filter((r) => r === "actualites" ? cle.startsWith("flux:") && lus.has(cle.slice(5))
    : (integrees[r] || []).includes(cle) || (cle.startsWith("agenda:") && (integrees[r] || []).includes("agenda"))).map((r) => RUBRIQUES[r]);
  const categories = Object.entries(SOURCES).map(([cle, nom]) => ({ cle, nom, ...INFOS_SOURCES[cle], type: RANGEMENT_SOURCES[cle],
    coupee: coupees.includes(cle), rubriques: qui(cle), test: testVisible(ms, tests[`service:${cle}`]), aujourdhui: apercu[cle] || null }));
  const urls = new Set((config.sources?.flux || []).map((f) => f.url));
  return {
    categories,
    flux: (config.sources?.flux || []).map((f) => ({ ...f, cle: `flux:${f.id}`, actualites: lus.has(f.id), fournies: fourniesPour(`flux:${f.id}`),
      rubriques: qui(`flux:${f.id}`), test: testVisible(ms, tests[`flux:${f.id}`]) })),
    proposes: fluxProposes(config).filter((f) => !urls.has(f.url)),
    sites: (config.sources?.sites || []).map((x) => ({ ...x, cle: `site:${x.id}`, rubriques: qui(`site:${x.id}`), test: testVisible(ms, tests[`site:${x.id}`]) })),
    // Agendas : les rubriques qui n'en lisent qu'un, et le dernier test de chacun.
    agendas: Object.fromEntries((etat.agendas || []).map((a) => [a.id, { rubriques: qui(`agenda:${a.id}`), fournies: fourniesPour(`agenda:${a.id}`),
      test: testVisible(ms, tests[`agenda:${a.id}`]) }])),
    agenda_tous: qui("agenda"),
  };
}

export function cleEpisode(episode) {
  const numero = episode.message_id || episode.ref;   // numéro des anciens épisodes, sinon heure d'envoi (HHMMSS)
  return `ep:${episode.date}${numero ? `:${numero}` : ""}`;
}

// Un épisode tel que l'application l'affiche (liens audio signés dans « liens »).
export function episodeApp(ep, liens) {
  return {
    cle: cleEpisode(ep), date: ep.date, texte: dateCourte(ep.date), titre: ep.titre || "Épisode", duree: ep.duree || null,
    chapitres: (ep.chapitres || []).slice(0, 20), sujets: (ep.sujets || []).slice(0, 5),
    coches: ep.coches || [], audio: liens.episodes[cleEpisode(ep)] || null, texte_dispo: Boolean(ep.transcription || ep.texte),
    image: (liens.pochettes || {})[cleEpisode(ep)] || null,
    sources: ep.sources || [],
  };
}

export function donneesApp(config, etat, ctx, version, liens = { episodes: {}, voix: {} }) {
  const aujourdHui = ctx.aujourdHui;
  const prochain = prochainEpisode(config.planning, ctx.maintenant);
  const dernier = etat.episodes?.at(-1) || null;
  const semaine = Array.from({ length: 7 }, (_, i) => {
    const date = ajouterJours(aujourdHui, i);
    const jour = NOMS_JOURS[JOURS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]];
    return { date, initiale: jour[0].toUpperCase(), jour, heure: heurePrevue(config.planning, date) };
  });
  // Calendrier du mois en cours et des MOIS_CALENDRIER suivants. N'y figurent que les jours
  // qui sortent de l'habitude (férié, pause, heure changée) : les autres suivent planning.jours.
  const debutMois = `${aujourdHui.slice(0, 8)}01`;
  const fin = new Date(`${debutMois}T12:00:00Z`);
  fin.setUTCMonth(fin.getUTCMonth() + MOIS_CALENDRIER + 1, 0);
  const calendrierJusqua = fin.toISOString().slice(0, 10);
  const calendrier = {};
  for (let date = debutMois; date <= calendrierJusqua; date = ajouterJours(date, 1)) {
    const jour = {
      heure: heurePrevue(config.planning, date),
      ferie: estFerie(config.planning, date), ferie_nom: nomFerie(config.planning, date),
      pause: config.planning.pauses.some((p) => date >= p.du && date <= p.au),
      exception: config.planning.exceptions.some((e) => e.date === date),
    };
    const habituelle = config.planning.jours[jourDeSemaine(date)] ?? null;
    if (jour.heure !== habituelle || jour.ferie || jour.pause || jour.exception) calendrier[date] = jour;
  }
  return {
    version, aujourdhui: aujourdHui, heure: ctx.maintenant.heure,
    pays: config.pays, devise: profilPays(config).devise,
    prochain: prochain ? { ...prochain, texte: dateCourte(prochain.date) } : null,
    sautes: config.planning.exceptions.filter((e) => e.heure === null && e.date >= aujourdHui)
      .map((e) => ({ date: e.date, texte: dateCourte(e.date) })),
    format: { duree_minutes: config.format.duree_minutes, nombre_sujets: config.format.nombre_sujets },
    animateurs: animateursDuJour(config, prochain?.date || aujourdHui).map((a) => a.nom),
    agenda_apercu: (etat.agenda_apercu || []).filter((ev) => !config.agenda.exclus.includes(ev.agenda)),
    agenda_lu: etat.agendas_vus || null,
    dernier: dernier ? { date: dernier.date, texte: dateCourte(dernier.date), titre: dernier.titre,
                         chapitres: (dernier.chapitres || []).slice(0, 20), duree: dernier.duree || null } : null,
    episodes: [...(etat.episodes || [])].reverse().map((ep) => episodeApp(ep, liens)),
    // Mois plus anciens, gardés dans l'archive (un an) : chargés à la demande.
    mois_archives: etat.archives || [],
    stockage: Object.values(etat.stockage || {}).reduce((total, n) => total + (Number(n) || 0), 0),
    annulation: etat.annulations?.at(-1)?.libelle || null,
    resultats: etat.derniers_resultats ? {
      quand: etat.derniers_resultats.quand, regles: etat.derniers_resultats.regles || [], format: etat.derniers_resultats.format || "ecrit",
      idees: etat.derniers_resultats.idees || [], details: etat.derniers_resultats.details || [],
      // Le mini-podcast, comme un épisode pour le lecteur de l'application.
      episode: liens.idees ? { cle: "idees:dernier", titre: etat.derniers_resultats.titre_audio || (etat.derniers_resultats.format === "point" ? "Ton podcast" : "Mini-podcast d'idées"), audio: liens.idees,
        date: String(etat.derniers_resultats.quand || "").slice(0, 10), texte: "", duree: etat.derniers_resultats.duree_audio || null,
        chapitres: etat.derniers_resultats.chapitres || [], sujets: [], coches: [], sources: [], image: null } : null,
    } : null,
    // Chaque recherche ponctuelle a sa page de résultats : le dernier podcast, ou les résultats écrits.
    recherches_resultats: resultatsParRecherche(config, etat, liens, ctx.ms || Date.now()),
    reglages: {
      format: config.format,
      voix: { vitesse: config.voix.vitesse, tutoiement: config.voix.tutoiement, prenom: config.voix.prenom, animateurs: config.voix.animateurs,
              solo: Boolean(config.voix.solo), mode: config.voix.mode || "fixe",
              // Chaque voix est un animateur possible : ses prénoms et celles qu'on n'utilise pas.
              noms: config.voix.noms || {}, inactives: config.voix.inactives || [],
              // Mode « selon le jour » : les deux voix de chaque jour (habituels aux places vides).
              jours: Object.fromEntries(JOURS.map((j) => [j, placesDuJour(config.voix, j)])),
              du_prochain: animateursDuJour(config, prochain?.date || aujourdHui) },
      actus: { ...config.actus, flux: fluxActus(config) },
      agenda: config.agenda, agendas: nommerAgendas(config, (etat.agendas || []).filter((x) => !(config.agenda.retires || []).includes(x.id))),
      agendas_retires: nommerAgendas(config, (etat.agendas || []).filter((x) => (config.agenda.retires || []).includes(x.id))), agendas_vus: etat.agendas_vus || null,
      sources_integrees: config.sources_integrees,
      consignes: config.consignes, consignes_rubriques: config.consignes_rubriques, a_approfondir: config.a_approfondir.map((a) => a.sujet),
      sources: sourcesVisibles(config, etat, aujourdHui, ctx.ms || Date.now()),
      echantillons: liens.voix, temps_echantillons: etat.temps_echantillons || {},
    },
    regles: config.regles.map((r) => regleVisible(r, aujourdHui)),
    // Le catalogue « + » : le même que celui que Gemini utilise pour une rubrique demandée à la voix.
    modeles: catalogueRubriques(config),
    categories_rubriques: CATEGORIES_RUBRIQUES,
    // Les dernières demandes au bot (écrites ou vocales) : ce qui a été compris et fait.
    demandes: (etat.historique || []).slice(-10).reverse().map((d) => ({
      quand: d.quand, message: d.message, vocal: Boolean(d.vocal), changements: d.changements || [], erreurs: d.erreurs || [],
      a_confirmer: d.a_confirmer || [], issue: d.issue || null, operations: d.operations || "" })),
    deroule: config.deroule.map((el) => {
      const regle = config.regles.find((r) => r.id === el.cle);
      return { cle: el.cle, actif: el.actif !== false, nom: regle ? (regle.rubrique?.titre || regle.titre) : nomRubrique(config, el.cle),
               integree: Boolean(RUBRIQUES[el.cle]), longueur: regle?.rubrique?.longueur || null,
               pause: regle ? etatRegle(regle, aujourdHui) !== "active" : false };
    }),
    planning: { jours: config.planning.jours, feries: config.planning.feries, pauses: config.planning.pauses,
                exceptions: config.planning.exceptions, semaine, calendrier, calendrier_jusqua: calendrierJusqua,
                rattrapage: config.planning.rattrapage,
                feries_region: config.planning.feries_region || "CH-VD",
                delai_rattrapage: config.planning.delai_rattrapage, avance_minutes: config.planning.avance_minutes },
    listes: { sources: SOURCES, longueurs: LONGUEURS, jours: JOURS.map((j) => [j, COURTS_JOURS[j], NOMS_JOURS[j]]),
              voix: VOIX.map(([nom, description, genre]) => ({ nom, description, genre, conseillee: VOIX_CONSEILLEES.includes(nom) })),
              vitesses: VITESSES, tons: TONS, descriptions_tons: DESCRIPTIONS_TONS, consignes_pretes: CONSIGNES_PRETES,
              consignes_pretes_rubriques: CONSIGNES_PRETES_RUBRIQUES, sources_par_modele: SOURCES_PAR_MODELE, sources_integrees: SOURCES_INTEGREES, transports: Object.fromEntries(Object.entries(TRANSPORTS).filter(([k]) => k !== "peu_importe")),
              delais: DELAIS_RATTRAPAGE, devises: DEVISES, regions: CANTONS, modes_voix: MODES_VOIX,
              pays: Object.entries(PAYS).map(([code, p]) => [code, p.nom]) },
  };
}

// ─────────────────────────── formulaire → règle ─────────────────────────────

const texte = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Traduit le formulaire de la fiche en champs pour nouvelleRegle / modifierRegle.
export function champsDepuisFormulaire(f, ancienne, aujourdHui, devise = "CHF", config = null) {
  const titre = texte(f.titre, 50);
  const consigne = texte(f.consigne, 400);
  if (!titre) throw new Error("Donne un titre à la rubrique.");
  if (!consigne) throw new Error("Écris la consigne : ce que les animateurs doivent dire.");

  const p = f.periode || {};
  const type = PERIODES.includes(p.type) ? p.type : "toujours";
  const periode = { type, debut: null, fin: null, jours: [] };
  if (type === "dates" || type === "jours") {
    periode.debut = dateOuNull(p.debut);
    periode.fin = dateOuNull(p.fin);
    if (periode.debut && periode.fin && periode.fin < periode.debut) throw new Error("La date de fin est avant la date de début.");
  }
  if (type === "jours") {
    periode.jours = JOURS.filter((j) => (p.jours || []).includes(j));
    if (!periode.jours.length) throw new Error("Choisis au moins un jour de la semaine.");
  }
  if (type === "dates" && !periode.debut && !periode.fin) periode.type = "toujours";

  const longueur = Object.keys(LONGUEURS).includes(f.longueur) ? f.longueur : null;
  const rubrique = longueur && type !== "ponctuelle"
    ? { titre, apres: ancienne?.rubrique?.apres || (RUBRIQUES[f.place] || /^R\d+$/.test(f.place || "") ? f.place : "actualites"), longueur } : null;

  // Où elle cherche : toujours explicite. Les anciens formulaires « choisies par l'application »
  // (sources_auto) reçoivent les sources proposées d'après le sujet.
  const sources = f.sources_auto && !(f.sources || []).length
    ? sourcesAuto({ titre, consigne, fiche: f.fiche || {}, condition: f.condition && f.condition.texte ? f.condition : null }, config)
    : nettoyerListe(f.sources, MAX_SOURCES_RUBRIQUE).filter((x) => sourceConnue(x) && (idRubriqueSource(x) === null || rubriqueExistante(config, idRubriqueSource(x))));
  if (!sourcesUtilisables(sources, config).length) {
    throw new Error("Choisis au moins une source dans « Où elle cherche » : c'est là que la rubrique trouve son contenu.");
  }
  const fiche = Object.fromEntries(CHAMPS_FICHE.map((c) => [c, texte(f.fiche?.[c], c === "avec_qui" ? 80 : c === "ages" ? 40 : 120)]));
  fiche.transport = TRANSPORTS[f.transport] && f.transport !== "peu_importe" ? f.transport : "";
  const max = f.budget?.max === "" || f.budget?.max == null ? null : Number(String(f.budget.max).replace(",", "."));
  if (max !== null && (!Number.isFinite(max) || max < 0 || max > 100000)) throw new Error("Budget : écris un nombre.");
  fiche.budget = { max, unite: f.budget?.unite === "total" ? "total" : "personne", devise: DEVISES.includes(f.budget?.devise) ? f.budget.devise : devise,
                   transport_inclus: fiche.transport === "aucun" ? false : Boolean(f.budget?.transport_inclus) };
  fiche.inclure = nettoyerListe(Array.isArray(f.inclure) ? f.inclure : String(f.inclure || "").split(/[,;\n]/), 8);
  fiche.exclure = nettoyerListe(Array.isArray(f.exclure) ? f.exclure : String(f.exclure || "").split(/[,;\n]/), 8);
  const recherche = { sources, fiche };
  // Une recherche ponctuelle : un point en audio (état des lieux) ou des idées concrètes.
  if (RENDUS.includes(f.rendu)) recherche.rendu = f.rendu;
  if (f.audio !== undefined) recherche.audio = Boolean(f.audio) && f.rendu !== "point";
  if (f.minutes !== undefined && f.minutes !== null && f.minutes !== "") recherche.minutes = minutesPoint(f.minutes);
  if (f.recherches !== undefined && f.recherches !== null && f.recherches !== "") recherche.recherches = recherchesWeb(f.recherches);

  const c = f.condition;
  const condition = c && texte(c.texte, 120) ? {
    texte: texte(c.texte, 120), moment: MOMENTS.includes(c.moment) ? c.moment : "jour_meme",
    n: Math.max(1, Math.min(30, Number(c.n) || 1)),
  } : null;

  // Champs que seule la demande à la voix remplit (la fiche de l'application ne les envoie pas,
  // et une rubrique modifiée dans l'application garde donc les siens).
  if (recherche && Array.isArray(f.requetes)) recherche.requetes = nettoyerListe(f.requetes, 6, 120);

  const champs = {
    titre, consigne, periode, rubrique, recherche, condition,
    ...(f.modele ? { modele: String(f.modele) } : {}),
    importance: f.prioritaire ? "prioritaire" : "normale",
    etat: f.active === false ? "pause" : "active",
  };
  if (f.jours_avant !== undefined && f.jours_avant !== null && f.jours_avant !== "" && Number.isFinite(Number(f.jours_avant))) {
    champs.presentation = { jours_avant: Math.max(0, Math.min(14, Math.round(Number(f.jours_avant)))) };
  }
  if (ancienne && JSON.stringify({ ...ancienne.periode }) !== JSON.stringify(periode)) champs.servie = false;
  if (!ancienne) champs.cree_le = aujourdHui;
  return champs;
}

// Le formulaire d'une nouvelle rubrique, comme la fiche de l'application l'ouvre depuis le
// catalogue (« + ») : un seul point de départ pour l'application et pour la voix.
export function formulaireNeuf(config, idModele = "libre", ponctuelle = false, rendu = "idees") {
  const modele = MODELES_RUBRIQUES.find((m) => m.id === idModele) || MODELES_RUBRIQUES.find((m) => m.id === "libre");
  const base = modele.formulaire(config.actus?.ville || "");
  return {
    titre: base.titre || "", consigne: base.consigne || "",
    longueur: ponctuelle ? "aucune" : base.longueur || "courte",
    periode: ponctuelle ? { type: "ponctuelle", debut: "", fin: "", jours: [] }
      : { type: "toujours", debut: "", fin: "", jours: [], ...(base.periode || {}) },
    sources: sourcesUtilisables(ponctuelle ? (rendu === "point" ? ["web", "actus"] : ["web", "lieux"]) : modele.sources || [], config),
    modele: ponctuelle ? "libre" : modele.id,
    rendu: ponctuelle ? rendu : "idees", audio: false, minutes: 3, recherches: 3,
    fiche: Object.fromEntries(CHAMPS_FICHE.map((c) => [c, ""])),
    transport: "aucun", budget: { max: "", unite: "personne", devise: profilPays(config).devise, transport_inclus: false },
    inclure: [], exclure: [], condition: base.condition ? { ...base.condition } : null,
    place: base.place || "actualites", prioritaire: false, active: true,
  };
}

// Le formulaire d'une rubrique existante, comme la fiche de l'application l'affiche.
export function formulaireDepuisRegle(r, devise = "CHF") {
  const fiche = r.recherche?.fiche || {};
  const budget = fiche.budget || {};
  return {
    titre: r.titre, consigne: r.consigne,
    longueur: r.rubrique?.longueur || "aucune",
    periode: { type: r.periode.type, debut: r.periode.debut || "", fin: r.periode.fin || "", jours: [...(r.periode.jours || [])] },
    sources: [...(r.recherche?.sources || [])], modele: r.modele || "libre",
    rendu: r.recherche?.rendu || "idees", audio: Boolean(r.recherche?.audio), minutes: r.recherche?.minutes || 3,
    recherches: r.recherche?.recherches || 3,
    fiche: Object.fromEntries(CHAMPS_FICHE.map((c) => [c, fiche[c] || ""])),
    transport: fiche.transport || "",
    budget: { max: budget.max ?? "", unite: budget.unite || "personne", devise: budget.devise || devise, transport_inclus: Boolean(budget.transport_inclus) },
    inclure: [...(fiche.inclure || [])], exclure: [...(fiche.exclure || [])],
    condition: r.condition ? { ...r.condition } : null,
    place: r.rubrique?.apres || "actualites",
    prioritaire: r.importance === "prioritaire", active: r.etat !== "pause",
  };
}

// Crée ou modifie une rubrique à partir du formulaire : le chemin unique (fiche de
// l'application, demande écrite ou vocale).
export function enregistrerRubrique(config, formulaire, existante, aujourdHui, origine = "application") {
  const champs = champsDepuisFormulaire(formulaire, existante, aujourdHui, profilPays(config).devise, config);
  if (existante) return modifierRegle(config, existante.id, champs, aujourdHui);
  return nouvelleRegle(config, champs, aujourdHui, origine);
}

// Nouvel ordre du déroulé : doit contenir exactement les mêmes passages.
export function nouvelOrdre(config, ordre, actifs) {
  const actuels = config.deroule.map((el) => el.cle);
  if (!Array.isArray(ordre) || ordre.length !== actuels.length || new Set(ordre).size !== ordre.length
      || !ordre.every((cle) => actuels.includes(cle))) {
    return null;
  }
  const deroule = ordre.map((cle) => {
    const ancien = config.deroule.find((el) => el.cle === cle);
    const actif = actifs && typeof actifs[cle] === "boolean" ? actifs[cle] : ancien.actif !== false;
    return { cle, actif };
  });
  // Chaque rubrique retient la place qu'on lui a donnée (celle qui la précède).
  deroule.forEach((el, i) => {
    const regle = config.regles.find((r) => r.id === el.cle);
    if (regle?.rubrique) regle.rubrique.apres = i > 0 ? deroule[i - 1].cle : "ouverture";
  });
  return deroule;
}

export function libelleDate(dateIso) {
  return dateCourte(dateIso);
}

// Résultats de recherche envoyés par GitHub, gardés pour l'application.
export function nettoyerResultats(resultats) {
  const court = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return (Array.isArray(resultats) ? resultats : []).slice(0, 4).map((r) => ({
    regle: court(r?.regle, 20), titre: court(r?.titre, 60), intro: court(r?.intro, 1200), conseil: court(r?.conseil, 300),
    idees: (Array.isArray(r?.idees) ? r.idees : []).slice(0, 10).map((i) => ({
      titre: court(i?.titre, 90), resume: court(i?.resume, 400), pourquoi: court(i?.pourquoi, 300), prix: court(i?.prix, 120),
      duree: court(i?.duree, 80), horaires: court(i?.horaires, 160), lieu: court(i?.lieu, 120), adresse: court(i?.adresse, 160),
      acces: court(i?.acces, 200), lien: /^https:\/\//.test(String(i?.lien || "")) ? String(i.lien).slice(0, 400) : "",
      source: court(i?.source, 60), dans_le_budget: Boolean(i?.dans_le_budget),
    })).filter((i) => i.titre),
    // Un point (état des lieux) : ses sources, sans idées.
    sources: (Array.isArray(r?.sources) ? r.sources : []).slice(0, 8).map((x) => ({
      titre: court(x?.titre, 120), lien: /^https:\/\//.test(String(x?.lien || "")) ? String(x.lien).slice(0, 400) : "",
    })).filter((x) => x.titre && x.lien),
  })).filter((r) => r.idees.length || r.sources.length || r.intro);
}

// Les chapitres d'un podcast de recherche : [[secondes, titre]], dans l'ordre, au plus 12.
export function nettoyerChapitres(chapitres) {
  return (Array.isArray(chapitres) ? chapitres : []).slice(0, 12)
    .map((c) => [Math.max(0, Math.round(Number(c?.[0]) || 0)), String(c?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 60)])
    .filter(([, titre]) => titre);
}

// Les résultats de chaque recherche ponctuelle (gardés par le bot, un lot par recherche) : le podcast
// comme un épisode pour le lecteur, ou les résultats écrits. « en_cours » : lancée il y a moins de
// 12 minutes et pas encore revenue.
export const ATTENTE_RECHERCHE_MS = 12 * 60 * 1000;
export function resultatsParRecherche(config, etat, liens = {}, ms = Date.now()) {
  const sortie = {};
  for (const r of config.regles.filter((x) => x.periode?.type === "ponctuelle")) {
    const res = etat.resultats_recherches?.[r.id] || null;
    const lance = etat.recherches_lancees?.[r.id] || null;
    const enCours = lance && ms - (lance.depuis_ms || 0) < ATTENTE_RECHERCHE_MS ? { format: lance.format, depuis: lance.depuis } : null;
    if (!res && !enCours) continue;
    const lien = liens.recherches?.[r.id] || null;
    sortie[r.id] = {
      en_cours: enCours,
      quand: res?.quand || null, format: res?.format || null, details: res?.details || [], nouveaux: res?.nouveaux || 0,
      episode: res && lien ? { cle: `recherche:${r.id}`, titre: res.titre_audio || r.titre, audio: lien, date: String(res.quand || "").slice(0, 10),
        texte: "", duree: res.duree_audio || null, chapitres: res.chapitres || [], sujets: [], coches: [], sources: [], image: null } : null,
    };
  }
  return sortie;
}

// Range un lot de résultats (événement « recherche ») dans la page de sa recherche. « plus » ajoute
// les nouveaux résultats écrits à la suite de ceux déjà trouvés (sans doublon) ; sinon, le lot remplace
// le précédent. Au plus 30 résultats par recherche.
export function rangerResultats(precedent, lot) {
  const nouveau = lot.details[0] || null;
  if (lot.format === "plus" && precedent?.details?.[0] && nouveau) {
    const base = precedent.details[0];
    const cle = (i) => `${String(i.titre).toLowerCase()}|${i.lien}`;
    const vus = new Set(base.idees.flatMap((i) => [String(i.titre).toLowerCase(), i.lien].filter(Boolean)));
    const ajouts = nouveau.idees.filter((i) => !vus.has(String(i.titre).toLowerCase()) && !(i.lien && vus.has(i.lien)));
    const idees = [...base.idees, ...ajouts].filter((i, k, t) => t.findIndex((x) => cle(x) === cle(i)) === k).slice(0, 30);
    const liens = new Set(base.sources.map((x) => x.lien));
    return { ...precedent, format: "ecrit", quand: lot.quand, nouveaux: Math.max(0, idees.length - base.idees.length),
             details: [{ ...base, idees, sources: [...base.sources, ...nouveau.sources.filter((x) => !liens.has(x.lien))].slice(0, 12),
                         conseil: base.conseil || nouveau.conseil }] };
  }
  return { format: lot.format === "plus" ? "ecrit" : lot.format, quand: lot.quand, nouveaux: 0, details: nouveau ? [nouveau] : [],
           audio: lot.audio || null, titre_audio: lot.titre_audio || "", duree_audio: lot.duree_audio || null, chapitres: lot.chapitres || [] };
}

// Sources d'un épisode : titres et adresses https seulement.
export function nettoyerSources(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 30)
    .map((x) => ({ section: String(x?.section ?? "").replace(/\s+/g, " ").trim().slice(0, 60), titre: String(x?.titre ?? "").replace(/\s+/g, " ").trim().slice(0, 120), url: String(x?.url ?? "").slice(0, 500) }))
    .filter((x) => /^https:\/\//.test(x.url));
}

// Jours fériés d'un pays (Nager.Date, gratuit) : [[date, nom]] pour une année.
export async function telechargerFeries(env, region, annee) {
  const pays = region.slice(0, 2);
  const r = await fetch(`${env.FERIES_API || "https://date.nager.at"}/api/v3/PublicHolidays/${annee}/${pays}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`liste des jours fériés indisponible (HTTP ${r.status})`);
  const liste = await r.json();
  return (Array.isArray(liste) ? liste : [])
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f?.date || "") && (f.global !== false || !region.includes("-") || (f.counties || []).includes(region)))
    .map((f) => [f.date, String(f.localName || f.name || "férié").slice(0, 60)]);
}
