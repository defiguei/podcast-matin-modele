// Mini App Telegram : vérification de l'ouverture, données des écrans et
// traduction des formulaires en modifications de la configuration.
//
// La page (page.js) s'ouvre dans Telegram, qui lui confie « initData » : une
// liste de champs signée avec le jeton du bot. Le Worker vérifie cette
// signature et que c'est bien toi (TELEGRAM_CHAT_ID) avant tout accès.

import {
  JOURS, NOMS_JOURS, COURTS_JOURS, LONGUEURS, SOURCES, RUBRIQUES, etatRegle, prochainPassage, decrirePeriode,
  heurePrevue, prochainEpisode, ajouterJours, dateCourte, nomRubrique, dateOuNull, nettoyerListe,
  VOIX, VOIX_CONSEILLEES, VITESSES, TONS, CITER, TRANSPORTS, fluxActus, profilPays, PAYS, DELAIS_RATTRAPAGE,
  DEVISES, REGIONS_FERIES, MODES_VOIX, estFerie, nomFerie, animateursDuJour, equipeComplete, normaliserTexte,
} from "./config.js";

const DUREE_VALIDITE = 24 * 3600;      // une ouverture reste valable 24 h
const PERIODES = ["toujours", "dates", "jours", "une_fois", "ponctuelle"];
const MOMENTS = ["jour_meme", "veille", "jours_avant"];
const CHAMPS_FICHE = ["quoi", "avec_qui", "ages", "ou", "quand", "attendu"];
export const ECRANS_BOT = ["planning", "voix", "format", "agenda", "actus", "consignes", "accueil"];
// Listes modifiables d'un bloc depuis l'application.
export const LISTES_APP = ["consignes", "actus.sujets_preferes", "actus.sujets_a_eviter"];
// Réglages simples modifiables depuis l'application (validés par config.js).
export const REGLAGES_APP = [
  "format.duree_minutes", "format.nombre_sujets", "format.ton", "voix.vitesse", "voix.tutoiement", "voix.prenom",
  "voix.animateurs.0.nom", "voix.animateurs.0.voix", "voix.animateurs.1.nom", "voix.animateurs.1.voix",
  "agenda.jours", "agenda.horizon", "agenda.notes", "agenda.deplacements", "agenda.jours_deplacements", "agenda.max_deplacements",
  "actus.locale_articles", "actus.ville", "actus.fraicheur_heures", "actus.citer_sources",
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
  if (!/^((img:)?ep:\d{4}-\d{2}-\d{2}(:\d+)?|voix:[A-Za-z]+)$/.test(cle) || !expiration || expiration < maintenant / 1000) return null;
  return egal(await signerAudio(secret, cle, expiration), signature) ? cle : null;
}

// ───────────────────────────── vérification ─────────────────────────────────

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

// Renvoie { ok: true, utilisateur } si initData est authentique, récent et vient de toi.
export async function verifierOuverture(initData, env, maintenant = Date.now()) {
  if (!initData || typeof initData !== "string" || initData.length > 4096) return { ok: false, raison: "absente" };
  const champs = new URLSearchParams(initData);
  const signature = champs.get("hash");
  if (!signature) return { ok: false, raison: "non signée" };
  champs.delete("hash");
  const aVerifier = [...champs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cle, valeur]) => `${cle}=${valeur}`).join("\n");
  const cleSecrete = await hmac("WebAppData", env.TELEGRAM_BOT_TOKEN);
  if (!egal(hex(await hmac(cleSecrete, aVerifier)), signature.toLowerCase())) return { ok: false, raison: "signature invalide" };
  const date = Number(champs.get("auth_date"));
  if (!date || maintenant / 1000 - date > DUREE_VALIDITE) return { ok: false, raison: "expirée" };
  let utilisateur = null;
  try { utilisateur = JSON.parse(champs.get("user") || "null"); } catch { /* illisible */ }
  if (!utilisateur || String(utilisateur.id) !== String(env.TELEGRAM_CHAT_ID)) return { ok: false, raison: "utilisateur inconnu" };
  return { ok: true, utilisateur };
}

// ─────────────────────────────── données ────────────────────────────────────

function familleRegle(r) {
  const sources = r.recherche?.sources || [];
  if (r.condition) return "agenda";
  if (sources.some((s) => ["transports", "lieux", "wikivoyage"].includes(s)) || r.recherche?.fiche?.quoi) return "sortie";
  if (sources.length && sources.every((s) => ["meteo", "saints", "fetes", "feries"].includes(s))) return "jour";
  return "info";
}

function regleVisible(r, aujourdHui) {
  const fiche = r.recherche?.fiche || {};
  return {
    id: r.id, titre: r.titre, consigne: r.consigne, importance: r.importance, pause: r.etat === "pause",
    etat: etatRegle(r, aujourdHui), famille: familleRegle(r),
    periode: r.periode, periode_texte: decrirePeriode(r.periode),
    prochain: (() => { const d = prochainPassage(r, aujourdHui); return d ? dateCourte(d) : null; })(),
    longueur: r.rubrique?.longueur || null,
    condition: r.condition,
    sources: r.recherche?.sources || [],
    fiche: Object.fromEntries(CHAMPS_FICHE.map((c) => [c, fiche[c] || ""])),
    transport: fiche.transport || "", budget: fiche.budget || { max: null, unite: "personne", transport_inclus: false },
    inclure: fiche.inclure || [], exclure: fiche.exclure || [], recherche: Boolean(r.recherche),
    derniere_application: r.derniere_application, servie: Boolean(r.servie), id_condition: Boolean(r.condition),
  };
}

export function cleEpisode(episode) {
  return `ep:${episode.date}${episode.message_id ? `:${episode.message_id}` : ""}`;
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
  // Deux mois de calendrier : celui en cours et le suivant.
  const debutMois = `${aujourdHui.slice(0, 8)}01`;
  const calendrier = {};
  for (let i = 0; i < 70; i++) {
    const date = ajouterJours(debutMois, i);
    calendrier[date] = {
      heure: heurePrevue(config.planning, date),
      ferie: estFerie(config.planning, date), ferie_nom: nomFerie(config.planning, date),
      pause: config.planning.pauses.some((p) => date >= p.du && date <= p.au),
      exception: config.planning.exceptions.some((e) => e.date === date),
    };
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
    episodes: [...(etat.episodes || [])].reverse().map((ep) => ({
      cle: cleEpisode(ep), date: ep.date, texte: dateCourte(ep.date), titre: ep.titre || "Épisode", duree: ep.duree || null,
      chapitres: (ep.chapitres || []).slice(0, 20), sujets: (ep.sujets || []).slice(0, 5), avis: ep.avis || null,
      coches: ep.coches || [], audio: liens.episodes[cleEpisode(ep)] || null, texte_dispo: Boolean(ep.transcription || ep.texte),
      image: (liens.pochettes || {})[cleEpisode(ep)] || null,
      sources: ep.sources || [],
    })),
    annulation: etat.annulations?.at(-1)?.libelle || null,
    resultats: etat.derniers_resultats ? {
      quand: etat.derniers_resultats.quand, regles: etat.derniers_resultats.regles || [],
      idees: etat.derniers_resultats.idees || [], details: etat.derniers_resultats.details || [],
    } : null,
    reglages: {
      format: config.format,
      voix: { vitesse: config.voix.vitesse, tutoiement: config.voix.tutoiement, prenom: config.voix.prenom, animateurs: config.voix.animateurs,
              solo: Boolean(config.voix.solo), mode: config.voix.mode || "fixe", equipe: config.voix.equipe || [],
              jours: config.voix.jours || {}, tirage: config.voix.tirage || [],
              du_prochain: animateursDuJour(config, prochain?.date || aujourdHui) },
      actus: { ville: config.actus.ville, sujets_preferes: config.actus.sujets_preferes, sujets_a_eviter: config.actus.sujets_a_eviter,
               fraicheur_heures: config.actus.fraicheur_heures, citer_sources: config.actus.citer_sources,
               locale_articles: config.actus.locale_articles, flux: fluxActus(config), flux_defaut: !config.actus.flux },
      agenda: config.agenda, agendas: etat.agendas || [], agendas_vus: etat.agendas_vus || null,
      consignes: config.consignes, a_approfondir: config.a_approfondir.map((a) => a.sujet),
      echantillons: liens.voix, temps_echantillons: etat.temps_echantillons || {},
    },
    regles: config.regles.map((r) => regleVisible(r, aujourdHui)),
    deroule: config.deroule.map((el) => {
      const regle = config.regles.find((r) => r.id === el.cle);
      return { cle: el.cle, actif: el.actif !== false, nom: regle ? (regle.rubrique?.titre || regle.titre) : nomRubrique(config, el.cle),
               integree: Boolean(RUBRIQUES[el.cle]), longueur: regle?.rubrique?.longueur || null,
               pause: regle ? etatRegle(regle, aujourdHui) !== "active" : false };
    }),
    planning: { jours: config.planning.jours, feries: config.planning.feries, pauses: config.planning.pauses,
                exceptions: config.planning.exceptions, semaine, calendrier, rattrapage: config.planning.rattrapage,
                feries_region: config.planning.feries_region || "CH-VD",
                delai_rattrapage: config.planning.delai_rattrapage, avance_minutes: config.planning.avance_minutes },
    listes: { sources: SOURCES, longueurs: LONGUEURS, jours: JOURS.map((j) => [j, COURTS_JOURS[j], NOMS_JOURS[j]]),
              voix: VOIX.map(([nom, description, genre]) => ({ nom, description, genre, conseillee: VOIX_CONSEILLEES.includes(nom) })),
              vitesses: VITESSES, tons: TONS, citer: CITER, transports: Object.fromEntries(Object.entries(TRANSPORTS).filter(([k]) => k !== "peu_importe")),
              delais: DELAIS_RATTRAPAGE, devises: DEVISES, regions: REGIONS_FERIES, modes_voix: MODES_VOIX,
              pays: Object.entries(PAYS).map(([code, p]) => [code, p.nom]) },
  };
}

// ─────────────────────────── formulaire → règle ─────────────────────────────

const texte = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Traduit le formulaire de la fiche en champs pour nouvelleRegle / modifierRegle.
export function champsDepuisFormulaire(f, ancienne, aujourdHui, devise = "CHF") {
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
    ? { titre, apres: ancienne?.rubrique?.apres || "actualites", longueur } : null;

  const sources = nettoyerListe(f.sources, 9).filter((s) => SOURCES[s]);
  const fiche = Object.fromEntries(CHAMPS_FICHE.map((c) => [c, texte(f.fiche?.[c], c === "avec_qui" ? 80 : c === "ages" ? 40 : 120)]));
  fiche.transport = TRANSPORTS[f.transport] && f.transport !== "peu_importe" ? f.transport : "";
  const max = f.budget?.max === "" || f.budget?.max == null ? null : Number(String(f.budget.max).replace(",", "."));
  if (max !== null && (!Number.isFinite(max) || max < 0 || max > 100000)) throw new Error("Budget : écris un nombre.");
  fiche.budget = { max, unite: f.budget?.unite === "total" ? "total" : "personne", devise: DEVISES.includes(f.budget?.devise) ? f.budget.devise : devise,
                   transport_inclus: fiche.transport === "aucun" ? false : Boolean(f.budget?.transport_inclus) };
  fiche.inclure = nettoyerListe(Array.isArray(f.inclure) ? f.inclure : String(f.inclure || "").split(/[,;\n]/), 8);
  fiche.exclure = nettoyerListe(Array.isArray(f.exclure) ? f.exclure : String(f.exclure || "").split(/[,;\n]/), 8);
  const avecFiche = CHAMPS_FICHE.some((c) => fiche[c]) || fiche.transport || fiche.budget.max !== null || fiche.inclure.length || fiche.exclure.length;
  const recherche = sources.length || avecFiche || type === "ponctuelle"
    ? { sources: sources.length ? sources : ["web"], fiche } : null;

  const c = f.condition;
  const condition = c && texte(c.texte, 120) ? {
    texte: texte(c.texte, 120), moment: MOMENTS.includes(c.moment) ? c.moment : "jour_meme",
    n: Math.max(1, Math.min(30, Number(c.n) || 1)),
  } : null;

  const champs = {
    titre, consigne, periode, rubrique, recherche, condition,
    importance: f.prioritaire ? "prioritaire" : "normale",
    etat: f.active === false ? "pause" : "active",
  };
  if (ancienne && JSON.stringify({ ...ancienne.periode }) !== JSON.stringify(periode)) champs.servie = false;
  if (!ancienne) champs.cree_le = aujourdHui;
  return champs;
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
    regle: court(r?.regle, 8), titre: court(r?.titre, 60), intro: court(r?.intro, 400), conseil: court(r?.conseil, 300),
    idees: (Array.isArray(r?.idees) ? r.idees : []).slice(0, 5).map((i) => ({
      titre: court(i?.titre, 90), resume: court(i?.resume, 400), pourquoi: court(i?.pourquoi, 300), prix: court(i?.prix, 120),
      duree: court(i?.duree, 80), horaires: court(i?.horaires, 160), lieu: court(i?.lieu, 120), adresse: court(i?.adresse, 160),
      acces: court(i?.acces, 200), lien: /^https:\/\//.test(String(i?.lien || "")) ? String(i.lien).slice(0, 400) : "",
      dans_le_budget: Boolean(i?.dans_le_budget),
    })).filter((i) => i.titre),
  })).filter((r) => r.idees.length);
}

// Sources d'un épisode : titres et adresses https seulement.
export function nettoyerSources(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 30)
    .map((x) => ({ section: String(x?.section ?? "").replace(/\s+/g, " ").trim().slice(0, 60), titre: String(x?.titre ?? "").replace(/\s+/g, " ").trim().slice(0, 120), url: String(x?.url ?? "").slice(0, 500) }))
    .filter((x) => /^https:\/\//.test(x.url));
}

// Sources lues dans la légende d'un épisode : « 1. <lien>site</lien> titre ».
export function sourcesDeLegende(legende, entites) {
  const texte = String(legende || "");
  const sources = [];
  for (const ent of Array.isArray(entites) ? entites : []) {
    if (ent?.type !== "text_link" || !/^https:\/\//.test(ent.url || "")) continue;
    const site = texte.slice(ent.offset, ent.offset + ent.length);
    const finLigne = texte.indexOf("\n", ent.offset + ent.length);
    const suite = texte.slice(ent.offset + ent.length, finLigne < 0 ? undefined : finLigne).trim();
    sources.push({ titre: suite ? `${site} · ${suite}` : site, url: ent.url });
  }
  return nettoyerSources(sources);
}

// Équipe d'animateurs proposée par la page : noms uniques, voix connues.
export function nettoyerEquipe(equipe, animateurs) {
  const voixConnues = new Set(VOIX.map(([nom]) => nom));
  const pris = new Set((animateurs || []).map((a) => normaliserTexte(a.nom)));
  const resultat = [];
  for (const a of Array.isArray(equipe) ? equipe.slice(0, 8) : []) {
    const nom = String(a?.nom ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
    if (!nom) throw new Error("Chaque animateur a besoin d'un prénom.");
    if (pris.has(normaliserTexte(nom))) throw new Error(`Le prénom « ${nom} » est déjà pris.`);
    if (!voixConnues.has(a?.voix)) throw new Error(`Voix inconnue pour ${nom}.`);
    pris.add(normaliserTexte(nom));
    resultat.push({ nom, voix: a.voix });
  }
  return resultat;
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
