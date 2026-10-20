// Compréhension des messages : Gemini traduit ce que dit l'auditeur en
// opérations précises, que le code valide puis applique à la configuration.

import {
  JOURS, NOMS_JOURS, REGLAGES, RUBRIQUES, SOURCES, TRANSPORTS, LONGUEURS, VOIX, VITESSES, TONS, CITER,
  regler, nouvelleRegle, modifierRegle, supprimerRegle, heureValide, dateOuNull, placerRubriqueApres,
  nettoyerListe, LONGUEUR_CONSIGNE, normaliserTexte, etatRegle, decrirePeriode, nomRubrique, ajouterJours, jourDeSemaine,
  heureParlee, dateCourte, nettoyerPlanning, fluxActus, profilPays, PAYS,
} from "./config.js";
import { GRATUIT } from "./assistant.js";

export const ACTIONS = [
  "regler", "ajouter_liste", "retirer_liste", "horaire", "exception", "retirer_exception", "pause", "retirer_pause",
  "approfondir", "nouvelle_regle", "modifier_regle", "supprimer_regle", "pause_regle", "reactiver_regle",
  "deplacer_rubrique", "activer_rubrique", "desactiver_rubrique", "ajouter_source", "retirer_source",
  "nouvel_episode", "resultats", "assistant", "afficher", "annuler", "aucune",
];

const LISTES = ["actus.sujets_preferes", "actus.sujets_a_eviter", "consignes"];
const MENUS = ["reglages", "planning", "format", "voix", "deroule", "agenda", "actus", "consignes", "regles", "aide", "tableau"];

export function schemaOperations() {
  const texte = { type: "string" };
  const listeTextes = { type: "array", items: texte };
  return {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ACTIONS },
            chemin: { type: "string", enum: Object.keys(REGLAGES) },
            valeur: texte,
            jours: listeTextes, heure: texte, date: texte, du: texte, au: texte,
            id: texte, ids: listeTextes, format: { type: "string", enum: ["ecrit", "audio"] },
            rubrique: texte, apres: texte,
            regle: {
              type: "object",
              properties: {
                titre: texte, consigne: texte,
                periode_type: { type: "string", enum: ["toujours", "dates", "jours", "une_fois", "ponctuelle"] },
                debut: texte, fin: texte, jours: listeTextes,
                condition_texte: texte, condition_moment: { type: "string", enum: ["jour_meme", "veille", "jours_avant"] },
                condition_n: { type: "number" },
                rubrique_titre: texte, rubrique_apres: texte,
                rubrique_longueur: { type: "string", enum: Object.keys(LONGUEURS) },
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
      reponse: texte,
    },
    required: ["operations", "reponse"],
  };
}

export function consigneComprehension(config, ctx) {
  const adresse = config.voix.tutoiement ? "en tutoyant l'auditeur" : "en vouvoyant l'auditeur";
  const voix = VOIX.map(([nom, style, genre]) => `${nom} (${style}, ${genre === "f" ? "féminine" : "masculine"})`).join(", ");
  return `Tu es l'assistant de réglage d'un podcast audio matinal personnel, en français. Tu traduis chaque message de l'auditeur (écrit ou vocal) en opérations précises sur ses réglages, puis tu rédiges une réponse courte.

Aujourd'hui : ${NOMS_JOURS[jourDeSemaine(ctx.aujourdHui)]} ${ctx.aujourdHui}. Codes des jours : lun, mar, mer, jeu, ven, sam, dim. Écris toujours les dates au format AAAA-MM-JJ (calcule « demain », « samedi prochain », « la semaine prochaine » d'après la date du jour) et les heures au format HH:MM.

OPÉRATIONS (champ « action ») :
- regler : change un réglage simple. chemin parmi la liste ci-dessous, valeur = nouvelle valeur (texte).
- ajouter_liste / retirer_liste : ajoute ou retire un élément d'une liste. chemin parmi ${LISTES.join(", ")} ; valeur = l'élément.
- horaire : heure d'envoi de l'épisode. jours = liste de codes (ou ["tous"], ["semaine"] pour lun-ven, ["weekend"]) ; heure = HH:MM, ou "aucun" pour aucun épisode ces jours-là.
- exception : un jour précis. date ; heure = HH:MM ou "aucun".
- retirer_exception : date.
- pause : aucun épisode du (du) au (au), dates incluses.
- retirer_pause : du (date de début de la pause à retirer).
- approfondir : valeur = sujet à développer dans le PROCHAIN épisode seulement.
- nouvelle_regle : crée une rubrique (objet « regle », voir plus bas). Dans l'interface, ce que le code appelle « règle » s'appelle « rubrique ».
- modifier_regle : id (ex. "R3") + les champs de « regle » à changer, et seulement eux (titre, consigne, quoi, ou, sources, budget, période…).
- supprimer_regle / pause_regle / reactiver_regle : id. Les rubriques sont toujours numérotées R1, R2… dans l'ordre (une suppression renumérote les suivantes).
- deplacer_rubrique : rubrique (clé ou id de rubrique) ; apres = clé ou id après lequel la placer ("debut" pour la mettre en premier).
- activer_rubrique / desactiver_rubrique : rubrique.
- ajouter_source : valeur = nom du média ou adresse de son flux RSS. retirer_source : valeur = nom de la source (sources par défaut : ${fluxActus({ ...config, actus: {} }).map((f) => f.nom).join(", ")}).
- nouvel_episode : l'auditeur veut un nouvel épisode tout de suite. ids = règles à traiter spécialement (facultatif).
- resultats : lancer tout de suite la recherche d'une ou plusieurs règles. ids, format = "ecrit" ou "audio".
- assistant : l'auditeur veut organiser une activité ou une sortie mais il manque des informations (qui, où, quand, transport, budget…). valeur = son message résumé. N'utilise PAS nouvelle_regle dans ce cas.
- afficher : l'auditeur veut voir quelque chose. valeur parmi ${MENUS.join(", ")}, ou "regle:R3".
- annuler : annuler le dernier changement.
- aucune : rien à changer (question, remerciement…).

RÉGLAGES SIMPLES (chemin → valeurs) :
${Object.entries(REGLAGES).map(([c, d]) => `- ${c} : ${d.nom}`).join("\n")}
Valeurs : vitesse parmi ${VITESSES.join(", ")} (« plus lentement » = un cran plus lent) ; ton parmi ${Object.keys(TONS).join(", ")} ; citer_sources parmi ${Object.keys(CITER).join(", ")} ; planning.feries parmi normal, dimanche (horaire du dimanche), aucun.
Voix disponibles : ${voix}.

RUBRIQUES : une rubrique est un passage de l'épisode avec ses propres paramètres. Champs de « regle » :
- titre (court), consigne (ce qu'il faut faire, en une ou deux phrases claires)
- periode_type : toujours | dates (debut/fin) | jours (jours = codes) | une_fois (prochain épisode) | ponctuelle (recherche hors podcast)
- condition_texte : si la règle dépend de l'agenda (« un match de foot ») ; condition_moment : jour_meme | veille | jours_avant (+ condition_n)
- rubrique_titre / rubrique_apres / rubrique_longueur : si la règle ajoute un passage à une place précise du déroulé (ex. le saint du jour après l'agenda)
- sources parmi ${Object.keys(SOURCES).join(", ")} (saints = calendrier des saints / fête du prénom, exact ; fetes = fêtes nationales et journées internationales du jour, exact ; meteo, transports, lieux = OpenStreetMap ; web = recherche web)
- requetes : recherches web utiles (courtes)
- pour une activité ou une sortie : quoi, avec_qui, ages, ou, quand, transport, budget_max (CHF), budget_unite (personne | total), budget_transport_inclus, inclure, exclure, attendu, jours_avant (combien de jours avant en parler)
- importance : normale | prioritaire
Une information exacte (saint du jour, jour férié, météo, horaire de train) doit venir d'une source, pas de tes connaissances.

RUBRIQUES INTÉGRÉES DU DÉROULÉ (clés) : ${Object.keys(RUBRIQUES).join(", ")}.

Si un message contient plusieurs demandes, renvoie plusieurs opérations. Ne change que ce qui est demandé. Si une demande est impossible (heure des voix hors liste, info indisponible), ne l'invente pas et explique-le dans la réponse.
reponse : une à trois phrases, ${adresse}, qui disent ce qui change concrètement.`;
}

export function contexteComprehension(config, ctx) {
  const regles = config.regles.map((r) => `${r.id} « ${r.titre} » — ${decrirePeriode(r.periode)} — ${etatRegle(r, ctx.aujourdHui)}`).join("\n") || "(aucune)";
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

// Convertit le format « à plat » renvoyé par Gemini en règle structurée.
export function regleDepuisGemini(r = {}, texte = "") {
  const champs = {};
  if (r.titre) champs.titre = r.titre;
  if (r.consigne) champs.consigne = r.consigne;
  if (r.periode_type || r.debut || r.fin || r.jours) {
    champs.periode = { type: r.periode_type || (r.debut || r.fin ? "dates" : r.jours?.length ? "jours" : "toujours"),
                       debut: dateOuNull(r.debut), fin: dateOuNull(r.fin), jours: joursDepuisTexte(r.jours || []) };
    // Dates illisibles : on ne remplace pas la période par « toujours ».
    if (champs.periode.type === "dates" && !champs.periode.debut && !champs.periode.fin) delete champs.periode;
  }
  if (r.condition_texte) champs.condition = { texte: r.condition_texte, moment: r.condition_moment, n: r.condition_n };
  if (r.rubrique_titre) champs.rubrique = { titre: r.rubrique_titre, apres: r.rubrique_apres, longueur: r.rubrique_longueur };
  const fiche = {};
  for (const cle of ["quoi", "avec_qui", "ages", "ou", "quand", "transport", "inclure", "exclure", "attendu"]) {
    if (cle === "transport" && r[cle] === "peu_importe") continue;     // « peu importe » = aucun critère
    if (r[cle] !== undefined && r[cle] !== "" && !(Array.isArray(r[cle]) && !r[cle].length)) fiche[cle] = r[cle];
  }
  // Gemini met parfois 0 à un nombre non précisé : « gratuit » doit avoir été dit.
  const budget = typeof r.budget_max === "number" && r.budget_max >= 0 && (r.budget_max > 0 || GRATUIT.test(texte)) ? r.budget_max : undefined;
  if (budget !== undefined || r.budget_unite || r.budget_transport_inclus) {
    fiche.budget = { max: budget ?? null, unite: r.budget_unite, transport_inclus: Boolean(r.budget_transport_inclus) };
  }
  if (Object.keys(fiche).length || r.sources?.length || r.requetes?.length) {
    champs.recherche = { fiche, sources: r.sources || [], requetes: r.requetes || [] };
  }
  if (typeof r.jours_avant === "number" && (r.jours_avant > 0 || /m[êe]me jour|jour m[êe]me/i.test(texte))) champs.presentation = { jours_avant: r.jours_avant };
  if (r.importance) champs.importance = r.importance;
  return champs;
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

// Applique les opérations ; renvoie les changements lisibles et les actions à mener.
export function appliquerOperations(config, operations, ctx) {
  const changements = [], actions = [], erreurs = [], reglesCreees = [];
  for (const op of operations || []) {
    try {
      const resultat = appliquerUne(config, op, ctx);
      if (resultat?.changement) changements.push(resultat.changement);
      if (resultat?.action) actions.push(resultat.action);
      if (resultat?.regle) reglesCreees.push(resultat.regle);
    } catch (erreur) {
      erreurs.push(`${op.action} : ${erreur.message}`);
    }
  }
  nettoyerPlanning(config.planning, ctx.aujourdHui);
  return { changements, actions, erreurs, reglesCreees };
}

function appliquerUne(config, op, ctx) {
  switch (op.action) {
    case "regler":
      return { changement: regler(config, op.chemin, op.valeur) };
    case "ajouter_liste":
    case "retirer_liste": {
      if (!LISTES.includes(op.chemin)) throw new Error("liste inconnue");
      const [section, cle] = op.chemin.includes(".") ? op.chemin.split(".") : [null, op.chemin];
      const conteneur = section ? config[section] : config;
      const actuelle = conteneur[cle];
      const valeur = String(op.valeur || "").trim();
      if (!valeur) throw new Error("élément vide");
      conteneur[cle] = op.action === "ajouter_liste"
        ? nettoyerListe([...actuelle, valeur], 20, op.chemin === "consignes" ? LONGUEUR_CONSIGNE : 80)
        : actuelle.filter((x) => normaliserTexte(x) !== normaliserTexte(valeur));
      if (op.chemin === "actus.sujets_a_eviter" && op.action === "ajouter_liste") {
        config.actus.sujets_preferes = config.actus.sujets_preferes.filter((x) => normaliserTexte(x) !== normaliserTexte(valeur));
      }
      return { changement: `${REGLAGES[op.chemin].nom} : ${op.action === "ajouter_liste" ? "+" : "−"} ${valeur}` };
    }
    case "horaire": {
      const jours = joursDepuisTexte(op.jours?.length ? op.jours : ["tous"]);
      if (!jours.length) throw new Error("jours non reconnus");
      const heure = heureValide(op.heure);
      for (const j of jours) config.planning.jours[j] = heure;
      return { changement: `Horaire ${resumerJours(jours)} : ${heure ? heureParlee(heure) : "pas d'épisode"}` };
    }
    case "exception": {
      const date = dateOuNull(op.date);
      if (!date || date < ctx.aujourdHui) throw new Error("date invalide");
      const heure = heureValide(op.heure);
      config.planning.exceptions = config.planning.exceptions.filter((e) => e.date !== date);
      config.planning.exceptions.push({ date, heure });
      return { changement: `${dateCourte(date)} : ${heure ? heureParlee(heure) : "pas d'épisode"}` };
    }
    case "retirer_exception": {
      const date = dateOuNull(op.date);
      config.planning.exceptions = config.planning.exceptions.filter((e) => e.date !== date);
      return { changement: `Exception du ${date ? dateCourte(date) : "?"} retirée` };
    }
    case "pause": {
      const du = dateOuNull(op.du), au = dateOuNull(op.au);
      if (!du || !au || au < du) throw new Error("dates de pause invalides");
      config.planning.pauses.push({ du, au });
      return { changement: `Pause du ${dateCourte(du)} au ${dateCourte(au)}` };
    }
    case "retirer_pause": {
      const du = dateOuNull(op.du);
      config.planning.pauses = du ? config.planning.pauses.filter((p) => p.du !== du) : [];
      return { changement: "Pause retirée" };
    }
    case "approfondir": {
      const sujet = String(op.valeur || "").trim().slice(0, 80);
      if (!sujet) throw new Error("sujet vide");
      config.a_approfondir = [...config.a_approfondir.filter((a) => normaliserTexte(a.sujet) !== normaliserTexte(sujet)),
                              { sujet, demande_le: ctx.maintenantIso }].slice(-5);
      return { changement: `À creuser au prochain épisode : ${sujet}` };
    }
    case "nouvelle_regle": {
      const regle = nouvelleRegle(config, regleDepuisGemini(op.regle, ctx.message), ctx.aujourdHui, ctx.message);
      return { changement: `Règle ${regle.id} créée : ${regle.titre}`, regle };
    }
    case "modifier_regle": {
      const regle = modifierRegle(config, identifiantRegle(op.id), regleDepuisGemini(op.regle, ctx.message), ctx.aujourdHui);
      return { changement: `Règle ${regle.id} modifiée`, regle };
    }
    case "supprimer_regle": {
      const id = identifiantRegle(op.id);
      supprimerRegle(config, id);
      return { changement: `Règle ${id} supprimée` };
    }
    case "pause_regle":
    case "reactiver_regle": {
      const id = identifiantRegle(op.id);
      const regle = config.regles.find((r) => r.id === id);
      if (!regle) throw new Error(`règle ${id} introuvable`);
      regle.etat = op.action === "pause_regle" ? "pause" : "active";
      regle.modifie_le = ctx.aujourdHui;
      return { changement: `Règle ${id} ${regle.etat === "pause" ? "en pause" : "réactivée"}` };
    }
    case "deplacer_rubrique": {
      const cle = cleRubrique(config, op.rubrique), apres = op.apres === "debut" ? "debut" : cleRubrique(config, op.apres);
      placerRubriqueApres(config, cle, apres);
      return { changement: `${nomRubrique(config, cle)} placée ${apres === "debut" ? "en premier" : `après ${nomRubrique(config, apres)}`}` };
    }
    case "activer_rubrique":
    case "desactiver_rubrique": {
      const cle = cleRubrique(config, op.rubrique);
      const element = config.deroule.find((r) => r.cle === cle);
      if (!element) throw new Error(`rubrique « ${op.rubrique} » absente du déroulé`);
      element.actif = op.action === "activer_rubrique";
      return { changement: `${nomRubrique(config, cle)} ${element.actif ? "activée" : "désactivée"}` };
    }
    case "ajouter_source":
      return { action: { type: "ajouter_source", valeur: String(op.valeur || "").trim() } };
    case "retirer_source": {
      const nom = normaliserTexte(op.valeur);
      const flux = fluxActus(config);
      const restants = flux.filter((f) => !normaliserTexte(f.nom).includes(nom) || !nom);
      if (restants.length === flux.length) throw new Error("source introuvable");
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
  if (!m) throw new Error("numéro de règle manquant");
  return `R${Number(m[1])}`;
}

function cleRubrique(config, valeur) {
  const v = normaliserTexte(valeur);
  if (/^r\d+$/.test(v)) return v.toUpperCase();
  const cle = Object.keys(RUBRIQUES).find((k) => k === v || normaliserTexte(RUBRIQUES[k]).startsWith(v));
  if (cle) return cle;
  const regle = config.regles.find((r) => r.rubrique && normaliserTexte(r.rubrique.titre).includes(v));
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
