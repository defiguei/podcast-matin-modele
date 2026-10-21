// Compréhension des messages : Gemini traduit ce que dit l'auditeur en
// opérations précises, que le code valide puis applique à la configuration.
//
// Principes (depuis 2026-10-21.9) :
// - un champ absent n'a jamais de valeur par défaut destructrice (une heure oubliée ne
//   coupe pas l'épisode : c'est une erreur, affichée) ;
// - la confirmation montrée à l'auditeur vient de ce que le code a appliqué, pas de la
//   phrase de Gemini ; un changement lourd attend son ✅ (voir « lourd ») ;
// - une rubrique demandée à la voix passe par le même catalogue et le même formulaire
//   que la fiche de l'application (miniapp.js : formulaireNeuf, enregistrerRubrique).

import {
  JOURS, NOMS_JOURS, REGLAGES, RUBRIQUES, SOURCES, TRANSPORTS, LONGUEURS, VOIX, VITESSES, TONS, CITER,
  regler, supprimerRegle, heureValide, dateOuNull, placerRubriqueApres,
  nettoyerListe, LONGUEUR_CONSIGNE, normaliserTexte, etatRegle, decrirePeriode, nomRubrique, jourDeSemaine,
  heureParlee, dateCourte, nettoyerPlanning, fluxActus, profilPays, MODELES_RUBRIQUES,
  nomVoix, voixActive, trouverVoix, renommerVoix, activerVoix, choisirVoixJour,
  INFOS_SOURCES, sourcesAuto, sourcesUtilisables, nomSource,
} from "./config.js";
import { formulaireNeuf, formulaireDepuisRegle, enregistrerRubrique, PERIODES } from "./miniapp.js";
import { GRATUIT } from "./assistant.js";

export const ACTIONS = [
  "regler", "ajouter_liste", "retirer_liste", "horaire", "exception", "retirer_exception", "pause", "retirer_pause",
  "approfondir", "nouvelle_regle", "modifier_regle", "supprimer_regle", "pause_regle", "reactiver_regle",
  "deplacer_rubrique", "activer_rubrique", "desactiver_rubrique", "ajouter_source", "retirer_source",
  "nommer_voix", "activer_voix", "desactiver_voix", "voix_jour",
  "nouvel_episode", "resultats", "assistant", "afficher", "annuler", "aucune",
];

const LISTES = ["actus.sujets_preferes", "actus.sujets_a_eviter", "consignes"];
const MENUS = ["reglages", "planning", "format", "voix", "deroule", "agenda", "actus", "consignes", "regles", "aide", "tableau"];
const LONGUEURS_FORMULAIRE = ["aucune", ...Object.keys(LONGUEURS)];
// Couper au moins ce nombre de jours d'un coup demande une confirmation.
const JOURS_COUPES_LOURD = 3;

// Nom lisible d'une opération, pour les messages d'erreur.
const NOMS_ACTIONS = {
  regler: "Réglage", ajouter_liste: "Ajout", retirer_liste: "Retrait", horaire: "Horaire", exception: "Exception",
  retirer_exception: "Exception", pause: "Pause", retirer_pause: "Pause", approfondir: "À creuser",
  nouvelle_regle: "Nouvelle rubrique", modifier_regle: "Rubrique", supprimer_regle: "Suppression",
  pause_regle: "Rubrique", reactiver_regle: "Rubrique", deplacer_rubrique: "Déroulé", activer_rubrique: "Déroulé",
  desactiver_rubrique: "Déroulé", ajouter_source: "Source", retirer_source: "Source",
  nommer_voix: "Voix", activer_voix: "Voix", desactiver_voix: "Voix", voix_jour: "Animateurs du jour",
};

export function schemaOperations() {
  const texte = { type: "string" };
  const listeTextes = { type: "array", items: texte };
  const decrit = (schema, description) => ({ ...schema, description });
  return {
    type: "object",
    properties: {
      // En premier : écouter avant de décider.
      entendu: decrit(texte, "S'il a parlé : la transcription fidèle de son message vocal. S'il a écrit : vide."),
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ACTIONS },
            chemin: decrit({ type: "string", enum: Object.keys(REGLAGES) }, "Pour regler, ajouter_liste, retirer_liste."),
            valeur: decrit(texte, "Nouvelle valeur d'un réglage, élément d'une liste, sujet, source. Jamais une heure d'horaire ou d'exception."),
            jours: decrit(listeTextes, "Pour horaire et voix_jour : codes des jours, ou [\"tous\"], [\"semaine\"], [\"weekend\"]."),
            heure: decrit(texte, "Pour horaire et exception, OBLIGATOIRE : HH:MM, ou \"aucun\" seulement si l'auditeur ne veut pas d'épisode."),
            date: texte, du: texte, au: texte,
            id: decrit(texte, "Rubrique (R3) ; pour nommer_voix, activer_voix, desactiver_voix : la voix ou son prénom."),
            ids: decrit(listeTextes, "Rubriques ; pour voix_jour : une ou deux voix (ou prénoms), vide = animateurs habituels."),
            format: { type: "string", enum: ["ecrit", "audio"] },
            rubrique: texte, apres: texte,
            regle: {
              type: "object",
              properties: {
                modele: decrit({ type: "string", enum: MODELES_RUBRIQUES.map((m) => m.id) }, "Pour nouvelle_regle : le modèle du catalogue le plus proche."),
                titre: texte, consigne: texte,
                periode_type: { type: "string", enum: PERIODES },
                debut: texte, fin: texte, jours: listeTextes,
                condition_texte: texte, condition_moment: { type: "string", enum: ["jour_meme", "veille", "jours_avant"] },
                condition_n: { type: "number" },
                place: decrit(texte, "Clé de la rubrique (ou id R…) après laquelle elle passe."),
                longueur: { type: "string", enum: LONGUEURS_FORMULAIRE },
                sources: { type: "array", items: { type: "string", enum: Object.keys(SOURCES) } },
                requetes: listeTextes,
                quoi: texte, avec_qui: texte, ages: texte, ou: texte, quand: texte,
                transport: { type: "string", enum: Object.keys(TRANSPORTS) },
                budget_max: { type: "number" }, budget_unite: { type: "string", enum: ["personne", "total"] },
                budget_transport_inclus: { type: "boolean" },
                inclure: listeTextes, exclure: listeTextes, attendu: texte,
                jours_avant: { type: "number" },
                importance: { type: "string", enum: ["normale", "prioritaire"] },
              },
            },
          },
          required: ["action"],
        },
      },
      reponse: decrit(texte, "Seulement ce qui s'ajoute aux changements : réponse à une question, demande impossible et pourquoi. Vide sinon."),
    },
    required: ["entendu", "operations", "reponse"],
  };
}

export function consigneComprehension(config, ctx) {
  const adresse = config.voix.tutoiement ? "en tutoyant l'auditeur" : "en vouvoyant l'auditeur";
  const voix = VOIX.map(([nom, style, genre]) => `${nom}${nomVoix(config.voix, nom) !== nom ? ` « ${nomVoix(config.voix, nom)} »` : ""} (${style}, ${genre === "f" ? "féminine" : "masculine"}${voixActive(config.voix, nom) ? "" : ", pas utilisée"})`).join(", ");
  return `Tu es l'assistant de réglage d'un podcast audio matinal personnel, en français. Tu traduis chaque message de l'auditeur (écrit ou vocal) en opérations précises sur ses réglages. C'est l'application qui applique les opérations et annonce elle-même ce qui a changé.

Aujourd'hui : ${NOMS_JOURS[jourDeSemaine(ctx.aujourdHui)]} ${ctx.aujourdHui}. Codes des jours : lun, mar, mer, jeu, ven, sam, dim. Écris toujours les dates au format AAAA-MM-JJ (calcule « demain », « samedi prochain », « la semaine prochaine » d'après la date du jour) et les heures au format HH:MM.

ENTENDU : si le message est vocal, écris d'abord dans « entendu » ce que l'auditeur a dit, mot pour mot. S'il a écrit, laisse « entendu » vide.

OPÉRATIONS (champ « action ») :
- regler : change un réglage simple. chemin parmi la liste ci-dessous, valeur = nouvelle valeur (texte). Pas pour les listes ni pour l'horaire.
- ajouter_liste / retirer_liste : ajoute ou retire UN élément d'une liste. chemin parmi ${LISTES.join(", ")} ; valeur = l'élément.
- horaire : heure d'envoi de l'épisode. jours = liste de codes (ou ["tous"], ["semaine"] pour lun-ven, ["weekend"]) ; heure = HH:MM. L'heure va TOUJOURS dans « heure », jamais dans « valeur ». heure = "aucun" seulement si l'auditeur demande de ne PAS avoir d'épisode ces jours-là.
- exception : un jour précis. date ; heure = HH:MM, ou "aucun" pour pas d'épisode ce jour-là.
- retirer_exception : date.
- pause : aucun épisode du (du) au (au), dates incluses.
- retirer_pause : du (date de début de la pause à retirer).
- approfondir : valeur = sujet à développer dans le PROCHAIN épisode seulement.
- nouvelle_regle : crée une rubrique (objet « regle », voir plus bas). Dans l'interface, ce que le code appelle « règle » s'appelle « rubrique ».
- modifier_regle : id (ex. "R3") + les champs de « regle » à changer, et seulement eux.
- supprimer_regle / pause_regle / reactiver_regle : id. Les rubriques sont numérotées R1, R2… (liste plus bas).
- deplacer_rubrique : rubrique (clé ou id) ; apres = clé ou id après lequel la placer ("debut" pour la mettre en premier).
- activer_rubrique / desactiver_rubrique : rubrique (clé ou id).
- nommer_voix : donne un prénom à une voix (chaque voix est un animateur possible, appelé par ce prénom). id = la voix ou son prénom actuel ; valeur = le nouveau prénom (vide : elle reprend son nom de voix).
- activer_voix / desactiver_voix : id = la voix ou son prénom. Une voix désactivée n'anime plus aucun épisode.
- voix_jour : qui présente certains jours de la semaine (mode « selon le jour », chemin voix.mode = jours). jours = codes ; ids = une ou deux voix ou prénoms (vide : les animateurs habituels).
- ajouter_source : valeur = nom du média ou adresse de son flux RSS. retirer_source : valeur = nom de la source (sources par défaut : ${fluxActus({ ...config, actus: {} }).map((f) => f.nom).join(", ")}).
- nouvel_episode : l'auditeur veut un nouvel épisode tout de suite. ids = rubriques à traiter spécialement (facultatif).
- resultats : lancer tout de suite la recherche d'une ou plusieurs rubriques. ids, format = "ecrit" ou "audio".
- assistant : l'auditeur veut organiser une activité ou une sortie mais il manque des informations (qui, où, quand, transport, budget…). valeur = son message résumé. N'utilise PAS nouvelle_regle dans ce cas.
- afficher : l'auditeur veut voir quelque chose. valeur parmi ${MENUS.join(", ")}, ou "regle:R3".
- annuler : annuler le dernier changement.
- aucune : rien à changer (question, remerciement…).

RÉGLAGES SIMPLES (chemin → valeurs) :
${Object.entries(REGLAGES).filter(([c]) => !LISTES.includes(c)).map(([c, d]) => `- ${c} : ${d.gemini || d.nom}`).join("\n")}
Valeurs : vitesse parmi ${VITESSES.join(", ")} (« plus lentement » = un cran plus lent) ; ton parmi ${Object.keys(TONS).join(", ")} ; citer_sources parmi ${Object.keys(CITER).join(", ")} ; planning.feries parmi normal, dimanche (horaire du dimanche), aucun.
Voix disponibles (nom de la voix, « prénom » donné par l'auditeur) : ${voix}. Les animateurs s'appellent par le prénom de leur voix ; « au hasard » (voix.mode = aleatoire) tire parmi les voix utilisées.

RUBRIQUES : une rubrique est un passage de l'épisode avec ses propres paramètres. Pour en créer une, choisis d'abord dans « modele » le modèle du catalogue le plus proche :
${MODELES_RUBRIQUES.map((m) => `- ${m.id} : ${m.titre} — ${m.texte}`).join("\n")}
Le modèle règle déjà la place, la longueur et les sources : ne remplis que ce que l'auditeur précise. Champs de « regle » :
- titre (court, 2 à 5 mots) et consigne (ce que les animateurs doivent dire ou faire, en une ou deux phrases claires) : toujours les DEUX, une rubrique sans consigne est refusée, sauf pour prenom, journee et meteo si l'auditeur ne précise rien.
- periode_type : toujours | dates (debut/fin) | jours (jours = codes) | une_fois (prochain épisode) | ponctuelle (recherche hors podcast, résultats à part)
- condition_texte : si la rubrique dépend de l'agenda (« un match de foot ») ; condition_moment : jour_meme | veille | jours_avant (+ condition_n)
- place : clé ou id après lequel elle passe (seulement si l'auditeur le dit) ; longueur : ${LONGUEURS_FORMULAIRE.join(" | ")} (aucune = glissée dans l'épisode, sans passage à elle)
- sources : où la rubrique cherche son contenu, au moins une, d'après le sujet (le modèle en a déjà par défaut : n'en donne que si l'auditeur en cite ou si le sujet en demande d'autres). Choix : ${Object.keys(SOURCES).filter((s) => !(config.sources?.coupees || []).includes(s)).map((s) => `${s} (${SOURCES[s]} : ${INFOS_SOURCES[s].apporte.replace(/\.$/, "")})`).join(" ; ")}
- requetes : recherches web utiles (courtes)
- pour une activité ou une sortie : quoi, avec_qui, ages, ou, quand, transport, budget_max, budget_unite (personne | total), budget_transport_inclus, inclure, exclure, attendu, jours_avant (combien de jours avant en parler)
- importance : normale | prioritaire
Une information exacte (saint du jour, jour férié, météo, horaire de train) doit venir d'une source, pas de tes connaissances.

RUBRIQUES INTÉGRÉES DU DÉROULÉ (clés) : ${Object.entries(RUBRIQUES).map(([c, n]) => `${c} (${n})`).join(", ")}.

Si un message contient plusieurs demandes, renvoie plusieurs opérations. Ne change que ce qui est demandé. Si une information indispensable manque (une heure, une date), ne devine pas : n'émets pas l'opération et demande-la dans « reponse ».
reponse : vide si tout est traduit en opérations (l'application annonce elle-même les changements, ne les récapitule pas). Sinon une ou deux phrases, ${adresse} : réponse à une question, ou ce qui est impossible et pourquoi.`;
}

export function contexteComprehension(config, ctx) {
  const regles = config.regles.map((r) => `${r.id} « ${r.titre} » — ${decrirePeriode(r.periode)} — ${etatRegle(r, ctx.aujourdHui)}`
    + `${r.rubrique ? ` — après ${r.rubrique.apres}, ${r.rubrique.longueur}` : r.periode.type === "ponctuelle" ? "" : " — glissée"} — consigne : ${r.consigne.slice(0, 120)}`).join("\n") || "(aucune)";
  const planning = JOURS.map((j) => `${j} ${config.planning.jours[j] || "aucun"}`).join(", ");
  const sujets = ctx.dernierEpisode?.sujets?.map((s, i) => `${i + 1}. ${s}`).join("; ") || "(pas encore d'épisode)";
  return `RÉGLAGES ACTUELS (JSON) :
${JSON.stringify({ format: config.format, voix: config.voix, agenda: config.agenda, actus: { ...config.actus, flux: (config.actus.flux || []).map((f) => f.nom) }, consignes: config.consignes })}
Planning : ${planning}. Rattrapage : ${config.planning.rattrapage ? `${config.planning.delai_rattrapage} min après l'heure prévue` : "désactivé"}. Exceptions : ${JSON.stringify(config.planning.exceptions)}. Pauses : ${JSON.stringify(config.planning.pauses)}.
Déroulé : ${config.deroule.map((r) => `${r.cle}${r.actif ? "" : " (désactivé)"}`).join(" → ")}
Rubriques :
${regles}
Sujets du dernier épisode : ${sujets}

Message de l'auditeur :`;
}

// ─────────────────────────── rubriques : formulaire ─────────────────────────

const rempli = (v) => v !== undefined && v !== null && String(v).trim() !== "";

// Reporte sur le formulaire de la fiche ce que Gemini a compris (seulement ce qui est dit).
export function completerFormulaire(f, r = {}, texte = "") {
  if (rempli(r.titre)) f.titre = String(r.titre).trim();
  else if (rempli(r.rubrique_titre) && !rempli(f.titre)) f.titre = String(r.rubrique_titre).trim();
  if (rempli(r.consigne)) f.consigne = String(r.consigne).trim();
  // Période. Des dates illisibles ne remplacent pas la période existante.
  const joursDits = Array.isArray(r.jours) && r.jours.length ? joursDepuisTexte(r.jours) : [];
  if (rempli(r.periode_type) || rempli(r.debut) || rempli(r.fin) || joursDits.length) {
    const type = PERIODES.includes(r.periode_type) ? r.periode_type : rempli(r.debut) || rempli(r.fin) ? "dates" : joursDits.length ? "jours" : f.periode.type;
    const debut = dateOuNull(r.debut), fin = dateOuNull(r.fin);
    if (!(type === "dates" && !debut && !fin)) {
      f.periode = { type, debut: debut || "", fin: fin || "", jours: type === "jours" ? (joursDits.length ? joursDits : f.periode.jours || []) : [] };
    }
  }
  if (rempli(r.condition_texte)) {
    f.condition = { texte: String(r.condition_texte).trim(), moment: r.condition_moment || f.condition?.moment || "jour_meme",
                    n: Number(r.condition_n) || f.condition?.n || 1 };
  }
  // Place et longueur du passage (anciens noms acceptés : rubrique_apres, rubrique_longueur).
  const place = rempli(r.place) ? r.place : r.rubrique_apres;
  const longueur = rempli(r.longueur) ? r.longueur : r.rubrique_longueur;
  if (rempli(place)) {
    const p = String(place).trim();
    const cle = RUBRIQUES[p] ? p : /^r\d+$/i.test(p) ? p.toUpperCase() : Object.keys(RUBRIQUES).find((k) => normaliserTexte(RUBRIQUES[k]) === normaliserTexte(p));
    if (cle) f.place = cle;
  }
  if (LONGUEURS_FORMULAIRE.includes(longueur)) f.longueur = longueur;
  else if ((rempli(place) || rempli(r.rubrique_titre)) && f.longueur === "aucune") f.longueur = "courte";   // une place dite = un passage
  // Sources : celles que Gemini donne remplacent (modification) ; une nouvelle rubrique les
  // ajoute à celles de son modèle (nouvelleRubrique).
  const sources = (Array.isArray(r.sources) ? r.sources : []).filter((s) => SOURCES[s]);
  if (sources.length) f.sources = sources;
  // Détails d'une sortie ou d'une recherche.
  for (const cle of ["quoi", "avec_qui", "ages", "ou", "quand", "attendu"]) if (rempli(r[cle])) f.fiche[cle] = String(r[cle]).trim();
  if (TRANSPORTS[r.transport] && r.transport !== "peu_importe") f.transport = r.transport;        // « peu importe » = aucun critère
  // Gemini met parfois 0 à un nombre non précisé : « gratuit » doit avoir été dit.
  if (typeof r.budget_max === "number" && r.budget_max >= 0 && (r.budget_max > 0 || GRATUIT.test(texte))) f.budget.max = r.budget_max;
  if (r.budget_unite === "personne" || r.budget_unite === "total") f.budget.unite = r.budget_unite;
  if (typeof r.budget_transport_inclus === "boolean") f.budget.transport_inclus = r.budget_transport_inclus;
  for (const cle of ["inclure", "exclure"]) if (Array.isArray(r[cle]) && r[cle].length) f[cle] = nettoyerListe([...(f[cle] || []), ...r[cle]], 8);
  if (Array.isArray(r.requetes) && r.requetes.length) f.requetes = r.requetes;
  if (typeof r.jours_avant === "number" && (r.jours_avant > 0 || /m[êe]me jour|jour m[êe]me/i.test(texte))) f.jours_avant = r.jours_avant;
  if (r.importance === "prioritaire" || r.importance === "normale") f.prioritaire = r.importance === "prioritaire";
  return f;
}

// Titre court tiré de la consigne, quand Gemini n'en donne pas.
function titreDepuisConsigne(consigne) {
  const mots = String(consigne || "").replace(/[.!?;:].*$/, "").split(/\s+/).filter(Boolean);
  let titre = "";
  for (const mot of mots) { if ((`${titre} ${mot}`).trim().length > 40) break; titre = `${titre} ${mot}`.trim(); }
  return titre.charAt(0).toUpperCase() + titre.slice(1);
}

function nouvelleRubrique(config, r = {}, ctx) {
  const modele = MODELES_RUBRIQUES.find((m) => m.id === r.modele) || MODELES_RUBRIQUES.find((m) => m.id === "libre");
  const f = formulaireNeuf(config, modele.id, r.periode_type === "ponctuelle");
  if (!modele.pret) { f.titre = ""; f.consigne = ""; }     // titre et consigne du modèle à compléter : c'est à l'auditeur de les dire
  const parDefaut = [...f.sources];
  completerFormulaire(f, r, ctx.message);
  f.sources = [...new Set([...parDefaut, ...f.sources])];
  // Gemini oublie parfois la consigne (il ne donne que le titre) : on reprend alors les mots de l'auditeur
  // plutôt que de refuser la rubrique.
  if (!rempli(f.consigne) && rempli(ctx.message) && ctx.message !== "(vocal)") {
    f.consigne = rempli(f.titre) ? `Parle de : ${f.titre}. Demande de l'auditeur : ${ctx.message}` : String(ctx.message);
    f.consigne = f.consigne.replace(/\s+/g, " ").trim().slice(0, 400);
  }
  if (!rempli(f.consigne)) throw new Error("je n'ai pas compris ce que la rubrique doit dire");
  if (!rempli(f.titre)) f.titre = titreDepuisConsigne(f.consigne);
  // Où elle cherche : le modèle ou Gemini l'ont dit ; sinon d'après le sujet. Toujours affiché.
  if (!sourcesUtilisables(f.sources, config).length) {
    f.sources = sourcesAuto({ titre: f.titre, consigne: f.consigne, fiche: f.fiche, condition: f.condition && f.condition.texte ? f.condition : null }, config);
  }
  const regle = enregistrerRubrique(config, f, null, ctx.aujourdHui, ctx.message);
  return regle;
}

// « cherche dans : Google Actualités, Recherche web »
export function sourcesEnMots(config, regle) {
  const noms = sourcesUtilisables(regle.recherche?.sources || [], config).map((s) => nomSource(s, config));
  return noms.length ? `cherche dans : ${noms.join(", ")}` : "aucune source";
}

// Où passe une rubrique, en mots.
export function decrirePlace(config, regle) {
  if (regle.periode.type === "ponctuelle") return "recherche, hors podcast";
  if (!regle.rubrique) return "glissée dans l'épisode";
  return `après ${nomRubrique(config, regle.rubrique.apres)}`;
}

export function joursDepuisTexte(jours) {
  const resultat = new Set();
  for (const brut of jours) {
    const j = normaliserTexte(brut);
    if (["tous", "chaque jour", "tous les jours"].includes(j)) JOURS.forEach((x) => resultat.add(x));
    else if (["semaine", "en semaine", "lun-ven"].includes(j)) JOURS.slice(0, 5).forEach((x) => resultat.add(x));
    else if (["weekend", "week-end", "we"].includes(j)) ["sam", "dim"].forEach((x) => resultat.add(x));
    else {
      const code = JOURS.find((x) => j.startsWith(x) || j === NOMS_JOURS[x]);
      if (code) resultat.add(code);
    }
  }
  return JOURS.filter((j) => resultat.has(j));
}

// L'heure d'un horaire ou d'une exception. Absente, vide ou « null » : erreur (jamais
// « pas d'épisode » par défaut). Gemini la range parfois dans « valeur » : on l'y reprend.
export function heureDemandee(op) {
  for (const brut of [op.heure, op.valeur]) {
    if (brut === undefined || brut === null) continue;
    const t = normaliserTexte(brut);
    if (t === "" || t === "null" || t === "undefined") continue;
    return heureValide(brut);
  }
  throw new Error("je n'ai pas compris l'heure (dis par exemple « 6 h 30 », ou « aucun » pour ne pas avoir d'épisode)");
}

// Applique les opérations ; renvoie les changements lisibles, les actions à mener, et ce qui
// est lourd (à confirmer avant d'enregistrer). Les suppressions passent en dernier, de la plus
// grande à la plus petite, pour que les numéros cités par Gemini restent les bons.
export function appliquerOperations(config, operations, ctx) {
  const changements = [], actions = [], erreurs = [], reglesCreees = [], lourds = [], suppressions = [];
  const liste = Array.isArray(operations) ? operations.filter((op) => op && typeof op === "object") : [];
  const numero = (op) => Number(/(\d+)/.exec(String(op.id || ""))?.[1] || 0);
  const ordonnees = [...liste.filter((op) => op.action !== "supprimer_regle"),
                     ...liste.filter((op) => op.action === "supprimer_regle").sort((a, b) => numero(b) - numero(a))];
  for (const op of ordonnees) {
    try {
      const resultat = appliquerUne(config, op, ctx);
      if (resultat?.changement) changements.push(resultat.changement);
      if (resultat?.action) actions.push(resultat.action);
      if (resultat?.regle) reglesCreees.push(resultat.regle);
      if (resultat?.lourd) lourds.push(resultat.lourd);
      if (resultat?.suppression) suppressions.push(resultat.suppression);
    } catch (erreur) {
      erreurs.push(`${NOMS_ACTIONS[op.action] || op.action || "?"} : ${erreur.message}`);
    }
  }
  nettoyerPlanning(config.planning, ctx.aujourdHui);
  return { changements, actions, erreurs, reglesCreees, lourds, suppressions };
}

function appliquerUne(config, op, ctx) {
  switch (op.action) {
    case "regler": {
      if (!rempli(op.valeur) && typeof op.valeur !== "boolean") throw new Error("valeur manquante");
      // Une liste ne se remplace pas d'un bloc depuis une phrase (on perdrait le reste) : on ajoute.
      if (LISTES.includes(op.chemin)) {
        const elements = op.chemin === "consignes" ? [op.valeur] : String(op.valeur).split(/[,;\n]/).filter((x) => x.trim());
        const faits = elements.map((valeur) => appliquerUne(config, { ...op, action: "ajouter_liste", valeur }, ctx).changement);
        return { changement: faits.join(" ; ") };
      }
      return { changement: regler(config, op.chemin, op.valeur) };
    }
    case "ajouter_liste":
    case "retirer_liste": {
      if (!LISTES.includes(op.chemin)) throw new Error("liste inconnue");
      const [section, cle] = op.chemin.includes(".") ? op.chemin.split(".") : [null, op.chemin];
      const conteneur = section ? config[section] : config;
      const actuelle = conteneur[cle];
      const valeur = String(op.valeur ?? "").trim();
      if (!valeur) throw new Error("élément vide");
      const nom = REGLAGES[op.chemin].nom;
      if (op.action === "retirer_liste") {
        // Le même élément, ou un élément qui le contient (« le sport » / « sport »).
        const v = normaliserTexte(valeur);
        let retires = actuelle.filter((x) => normaliserTexte(x) === v);
        if (!retires.length) retires = actuelle.filter((x) => normaliserTexte(x).includes(v) || v.includes(normaliserTexte(x)));
        if (!retires.length) throw new Error(`« ${valeur} » n'est pas dans la liste (${nom.toLowerCase()})`);
        conteneur[cle] = actuelle.filter((x) => !retires.includes(x));
        return { changement: `${nom} : − ${retires.join(", ")}` };
      }
      if (actuelle.length >= 20 && !actuelle.some((x) => normaliserTexte(x) === normaliserTexte(valeur))) {
        throw new Error("la liste est pleine (20 au plus) : retire d'abord un élément");
      }
      conteneur[cle] = nettoyerListe([...actuelle, valeur], 20, op.chemin === "consignes" ? LONGUEUR_CONSIGNE : 80);
      if (op.chemin === "actus.sujets_a_eviter") {
        config.actus.sujets_preferes = config.actus.sujets_preferes.filter((x) => normaliserTexte(x) !== normaliserTexte(valeur));
      }
      return { changement: `${nom} : + ${valeur}` };
    }
    case "horaire": {
      const jours = joursDepuisTexte(op.jours?.length ? op.jours : ["tous"]);
      if (!jours.length) throw new Error("jours non reconnus");
      const heure = heureDemandee(op);
      const coupes = heure ? [] : jours.filter((j) => config.planning.jours[j]);
      for (const j of jours) config.planning.jours[j] = heure;
      const changement = `Horaire ${resumerJours(jours)} : ${heure ? heureParlee(heure) : "pas d'épisode"}`;
      const plusAucun = JOURS.every((j) => !config.planning.jours[j]);
      return { changement, lourd: coupes.length >= JOURS_COUPES_LOURD || (coupes.length && plusAucun) ? changement : null };
    }
    case "exception": {
      const date = dateOuNull(op.date);
      if (!date || date < ctx.aujourdHui) throw new Error("date invalide");
      const heure = heureDemandee(op);
      config.planning.exceptions = config.planning.exceptions.filter((e) => e.date !== date);
      config.planning.exceptions.push({ date, heure });
      return { changement: `${dateCourte(date)} : ${heure ? heureParlee(heure) : "pas d'épisode"}` };
    }
    case "retirer_exception": {
      const date = dateOuNull(op.date);
      if (!date || !config.planning.exceptions.some((e) => e.date === date)) throw new Error("aucune exception ce jour-là");
      config.planning.exceptions = config.planning.exceptions.filter((e) => e.date !== date);
      return { changement: `Exception du ${dateCourte(date)} retirée` };
    }
    case "pause": {
      const du = dateOuNull(op.du), au = dateOuNull(op.au);
      if (!du || !au || au < du) throw new Error("dates de pause invalides");
      config.planning.pauses.push({ du, au });
      return { changement: `Pause du ${dateCourte(du)} au ${dateCourte(au)}` };
    }
    case "retirer_pause": {
      const du = dateOuNull(op.du);
      const pauses = config.planning.pauses.filter((p) => p.au >= ctx.aujourdHui);
      // Sans date : seulement s'il n'y a qu'une pause, sinon on ne devine pas laquelle.
      const visee = du ? pauses.find((p) => p.du === du) : pauses.length === 1 ? pauses[0] : null;
      if (!visee) throw new Error(pauses.length ? (du ? "aucune pause ne commence ce jour-là" : "précise laquelle (sa date de début)") : "aucune pause prévue");
      config.planning.pauses = config.planning.pauses.filter((p) => p !== visee);
      return { changement: `Pause du ${dateCourte(visee.du)} au ${dateCourte(visee.au)} retirée` };
    }
    case "approfondir": {
      const sujet = String(op.valeur ?? "").trim().slice(0, 80);
      if (!sujet) throw new Error("sujet vide");
      config.a_approfondir = [...config.a_approfondir.filter((a) => normaliserTexte(a.sujet) !== normaliserTexte(sujet)),
                              { sujet, demande_le: ctx.maintenantIso }].slice(-5);
      return { changement: `À creuser au prochain épisode : ${sujet}` };
    }
    case "nouvelle_regle": {
      const regle = nouvelleRubrique(config, op.regle || {}, ctx);
      return { changement: `Rubrique ${regle.id} créée : ${regle.titre} (${decrirePlace(config, regle)} ; ${sourcesEnMots(config, regle)})`, regle };
    }
    case "modifier_regle": {
      const id = identifiantRegle(op.id);
      const existante = config.regles.find((r) => r.id === id);
      if (!existante) throw new Error(`rubrique ${id} introuvable`);
      const f = formulaireDepuisRegle(existante, profilPays(config).devise);
      const avant = JSON.stringify(f);
      completerFormulaire(f, op.regle || {}, ctx.message);
      if (JSON.stringify(f) === avant) throw new Error(`je n'ai pas compris quoi changer dans ${id}`);
      // Une ancienne rubrique sans source : on lui en propose d'après son sujet (visibles dans sa fiche).
      if (!sourcesUtilisables(f.sources, config).length) {
        f.sources = sourcesAuto({ titre: f.titre, consigne: f.consigne, fiche: f.fiche, condition: f.condition && f.condition.texte ? f.condition : null }, config);
      }
      const nouvellePlace = existante.rubrique && f.place !== existante.rubrique.apres ? f.place : null;
      if (nouvellePlace && !config.deroule.some((el) => el.cle === nouvellePlace)) throw new Error(`place « ${nouvellePlace} » inconnue`);
      const regle = enregistrerRubrique(config, f, existante, ctx.aujourdHui);
      // La fiche garde la place d'une rubrique déjà placée : la déplacer, c'est la remettre ailleurs.
      if (nouvellePlace && regle.rubrique) {
        placerRubriqueApres(config, id, nouvellePlace);
        regle.rubrique.apres = nouvellePlace;
      }
      return { changement: `Rubrique ${regle.id} modifiée : ${regle.titre} (${decrirePlace(config, regle)})`, regle };
    }
    case "supprimer_regle": {
      const id = identifiantRegle(op.id);
      const regle = config.regles.find((r) => r.id === id);
      if (!regle) throw new Error(`rubrique ${id} introuvable`);
      const table = supprimerRegle(config, id);
      const changement = `Rubrique ${id} « ${regle.titre} » supprimée`;
      return { changement, lourd: changement, suppression: { table, id } };
    }
    case "pause_regle":
    case "reactiver_regle": {
      const id = identifiantRegle(op.id);
      const regle = config.regles.find((r) => r.id === id);
      if (!regle) throw new Error(`rubrique ${id} introuvable`);
      regle.etat = op.action === "pause_regle" ? "pause" : "active";
      regle.modifie_le = ctx.aujourdHui;
      // Comme dans l'application : un seul interrupteur, le passage suit.
      const passage = config.deroule.find((el) => el.cle === id);
      if (passage) passage.actif = regle.etat === "active";
      return { changement: `Rubrique ${id} ${regle.etat === "pause" ? "en pause" : "réactivée"}` };
    }
    case "deplacer_rubrique": {
      const cle = cleRubrique(config, op.rubrique), apres = op.apres === "debut" ? "debut" : cleRubrique(config, op.apres);
      placerRubriqueApres(config, cle, apres);
      // Comme dans l'application : chaque rubrique retient la place qu'on lui a donnée.
      config.deroule.forEach((el, i) => {
        const regle = config.regles.find((r) => r.id === el.cle);
        if (regle?.rubrique) regle.rubrique.apres = i > 0 ? config.deroule[i - 1].cle : "ouverture";
      });
      return { changement: `${nomRubrique(config, cle)} placée ${apres === "debut" ? "en premier" : `après ${nomRubrique(config, apres)}`}` };
    }
    case "activer_rubrique":
    case "desactiver_rubrique": {
      const cle = cleRubrique(config, op.rubrique);
      const element = config.deroule.find((r) => r.cle === cle);
      if (!element) throw new Error(`rubrique « ${op.rubrique} » absente du déroulé`);
      element.actif = op.action === "activer_rubrique";
      const regle = config.regles.find((r) => r.id === cle);
      if (regle) { regle.etat = element.actif ? "active" : "pause"; regle.modifie_le = ctx.aujourdHui; }
      return { changement: `${nomRubrique(config, cle)} ${element.actif ? "activée" : "désactivée"}` };
    }
    case "nommer_voix": {
      const voix = trouverVoix(config.voix, op.id);
      if (!voix) throw new Error(`voix inconnue : ${op.id || "?"}`);
      renommerVoix(config.voix, voix, op.valeur);
      return { changement: config.voix.noms[voix] ? `${voix} s'appelle ${config.voix.noms[voix]}` : `${voix} reprend son nom` };
    }
    case "activer_voix":
    case "desactiver_voix":
      return { changement: activerVoix(config.voix, String(op.id || ""), op.action === "activer_voix") };
    case "voix_jour": {
      const jours = joursDepuisTexte(op.jours || []);
      if (!jours.length) throw new Error("jours non reconnus");
      const changements = jours.map((j) => choisirVoixJour(config.voix, j, op.ids || []));
      if (config.voix.mode !== "jours") { config.voix.mode = "jours"; changements.unshift("Animateurs : selon le jour"); }
      return { changement: changements.join(" ; ") };
    }
    case "ajouter_source": {
      const valeur = String(op.valeur ?? "").trim();
      if (!valeur) throw new Error("quelle source ?");
      return { action: { type: "ajouter_source", valeur } };
    }
    case "retirer_source": {
      const nom = normaliserTexte(op.valeur);
      if (!nom) throw new Error("quelle source ?");
      const flux = fluxActus(config);
      const restants = flux.filter((f) => !normaliserTexte(f.nom).includes(nom));
      if (restants.length === flux.length) throw new Error("source introuvable");
      if (!restants.length) throw new Error("garde au moins une source");
      config.actus.flux = restants;
      return { changement: `Source retirée : ${op.valeur}` };
    }
    case "nouvel_episode":
      return { action: { type: "nouvel_episode", ids: (op.ids || []).map(identifiantRegle) } };
    case "resultats":
      return { action: { type: "resultats", ids: (op.ids || []).map(identifiantRegle), format: op.format === "audio" ? "audio" : "ecrit" } };
    case "assistant":
      return { action: { type: "assistant", valeur: op.valeur || ctx.message } };
    case "afficher":
      return { action: { type: "afficher", valeur: String(op.valeur || "reglages") } };
    case "annuler":
      return { action: { type: "annuler" } };
    default:
      return null;
  }
}

function identifiantRegle(id) {
  const m = /(\d+)/.exec(String(id || ""));
  if (!m) throw new Error("numéro de rubrique manquant");
  return `R${Number(m[1])}`;
}

function cleRubrique(config, valeur) {
  const v = normaliserTexte(valeur);
  if (!v) throw new Error("quelle rubrique ?");
  if (/^r\d+$/.test(v)) return v.toUpperCase();
  const cle = Object.keys(RUBRIQUES).find((k) => k === v || normaliserTexte(RUBRIQUES[k]).startsWith(v));
  if (cle) return cle;
  const regle = config.regles.find((r) => normaliserTexte(r.rubrique?.titre || r.titre).includes(v));
  if (regle) return regle.id;
  throw new Error(`rubrique « ${valeur} » introuvable`);
}

export function resumerJours(jours) {
  const cle = jours.join(",");
  if (cle === JOURS.join(",")) return "tous les jours";
  if (cle === JOURS.slice(0, 5).join(",")) return "du lundi au vendredi";
  if (cle === "sam,dim") return "le week-end";
  return jours.map((j) => NOMS_JOURS[j]).join(", ");
}

// ─────────────────────────── ce qu'on montre ───────────────────────────────

// Le message pour l'auditeur, le même dans Telegram et dans l'application. La phrase de
// Gemini n'est gardée que si elle ne risque pas de contredire ce qui a été fait : elle
// accompagne des changements réussis, ou répond quand il n'y a rien à changer.
export function messageCompris(resultat) {
  const { changements = [], erreurs = [], a_confirmer: aConfirmer = [], reponse = "", suites = [] } = resultat;
  const note = String(reponse || "").trim();
  if (aConfirmer.length) {
    return { titre: "À confirmer avant que je l'applique :", lignes: aConfirmer, erreurs, note: "", confirmer: true };
  }
  if (changements.length) return { titre: "C'est fait :", lignes: [...changements, ...suites], erreurs, note: erreurs.length ? "" : note };
  if (erreurs.length) return { titre: "Je n'ai rien changé.", lignes: suites, erreurs, note: "" };
  return { titre: "", lignes: suites, erreurs, note: note || (suites.length ? "" : "Je n'ai rien changé.") };
}
