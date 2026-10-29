// Cerveau du bot (Durable Object) : un seul exemplaire, état cohérent.
// Il reçoit les demandes de l'application, le « tic » (planning) et les appels
// de GitHub (configuration, événements).

import { DurableObject } from "cloudflare:workers";
import {
  configParDefaut, completerConfig, cloner, regler, VITESSES, JOURS, heurePrevue,
  nettoyerPlanning, prochainEpisode, modifierRegle, supprimerRegle,
  ajouterJours, dateCourte, heureParlee, nettoyerListe, VOIX_CONSEILLEES,
  NOMS_JOURS, heureValide,
  VOIX, animateursDuJour, renommerVoix, activerVoix, choisirVoixJour, LONGUEUR_CONSIGNE, PAYS, profilPays, fluxActus, FERIES_CALCULES,
  SOURCES, MAX_FLUX, MAX_SITES, RANGEMENT_SOURCES, RUBRIQUES_A_CHERCHER, nomRubrique, idCourt, normaliserTexte,
} from "./config.js";
import { consigneComprehension, contexteComprehension, schemaOperations, appliquerOperations, messageCompris,
  rubriquesARediger, CONSIGNE_REDACTION, schemaRedaction, contenuRedaction, appliquerRedaction } from "./comprendre.js";
import { GitHub, demanderGemini, maintenantLocal, instantLocal, secretPartage, definirFuseau, empreinte } from "./services.js";
import { CLES, testerCle, lireAgenda, identifiantAgenda, resumeConnexions, testerFlux, testerSite, testerService, domaineDe } from "./connexions.js";
import { fluxRss, chapitresJson, episodeDeCle, jetonValide, nouveauJeton } from "./flux.js";
import { nomValide, objetDuNom, objetAudio } from "./audio.js";
import { nouvellesClesVapid, abonnementValide, envoyerNotification } from "./notifications.js";
import { donneesApp, episodeApp, enregistrerRubrique, nouvelOrdre, REGLAGES_APP, LISTES_APP, lienAudio, cleEpisode, nettoyerResultats, nettoyerSources, telechargerFeries } from "./miniapp.js";

export const VERSION = "2026-10-29.2";
const MAX_REFAITS = 6;
const MAX_RECHERCHES = 15;
const MAX_EPISODES = 60;      // épisodes récents, dans l'état ; les plus anciens vont dans l'archive de leur mois
const MAX_ARCHIVE_MOIS = 400; // épisodes gardés par mois d'archive (bien plus que nécessaire)
const CONSERVATION_MOIS = 12; // audio, textes et archives : le mois en cours et les douze précédents

// Nouveautés de cette version : annoncées par notification après la mise à jour.
const NOUVEAUTES = [
  "Réglages › Sources range tous tes outils en cinq onglets (services, flux, sites, agendas, données) : chacun se teste et dit quelles rubriques s'en servent.",
  "Tes médias et tes flux spécialisés ne font plus qu'une liste ; les Actualités globales cochent leurs flux dans leur fiche.",
  "Sites de référence : une rubrique peut limiter sa recherche web à un site précis.",
  "Une rubrique peut ne lire qu'un seul de tes agendas.",
  "Les clés Tavily et SNCF sont rangées avec leur service ; Gemini a son propre écran (Réglages › Gemini).",
  "Données intégrées : prénoms, journées et fériés montrent ce qu'ils donnent aujourd'hui.",
];

// « 2026-10 » décalé de n mois.
function moisDecale(mois, n) {
  const [a, m] = mois.split("-").map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

// Nom d'un fichier déposé chez le bot par GitHub (voir audio.js), ou null.
function fichierRecu(nom, extension) {
  return typeof nom === "string" && nomValide(nom) && nom.endsWith(extension) ? nom : null;
}

// Place prise par les fichiers, par objet (« 2026-10 », « voix ») : affichée dans l'application.
function noterStockage(etat, nom, taille) {
  if (!nomValide(nom) || !(taille > 0)) return;
  const objet = objetDuNom(nom);
  etat.stockage = { ...(etat.stockage || {}), [objet]: (etat.stockage?.[objet] || 0) + Math.round(taille) };
}

// Appareils connectés par code (jeton) : on garde les 8 plus récents.
function limiterAppareils(liste) {
  return liste.slice(-8);
}

// Ce que gardait l'ancienne conversation (messages, boutons, tableau épinglé…) : plus rien ne s'en sert.
const ANCIENNES_CLES = ["attente", "assistant", "selection", "position", "tableau_id", "tableau_jour", "sondages",
                        "dernier_update", "echantillons", "legendes_echantillons", "echantillons_demandes"];

// « 2026-10-21.1 » est plus récente que « 2026-10-20.2 ».
export function plusRecente(a, b) {
  const x = String(a || "").split(/[-.]/).map(Number), y = String(b || "").split(/[-.]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

export class Etat extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.file = Promise.resolve();
    // L'heure locale dépend du pays choisi : connue avant toute demande.
    ctx.blockConcurrencyWhile(async () => {
      const config = await ctx.storage.get("config");
      definirFuseau(profilPays(config).fuseau);
      this.cles = (await ctx.storage.get("cles")) || {};
    });
  }

  // Une seule opération à la fois : deux messages rapprochés ne se marchent pas dessus.
  enFile(travail) {
    const suite = this.file.then(travail, travail);
    this.file = suite.catch(() => {});
    return suite;
  }

  async fetch(requete) {
    const url = new URL(requete.url);
    try {
      if (url.pathname === "/tick") {
        await this.enFile(() => this.tic(url.searchParams.get("adresse")));
        return new Response("ok");
      }
      if (url.pathname === "/test/horloge" && this.env.MODE_TEST === "1") {
        // Horloge simulée pour les tests : ?iso=2026-10-14T07:25 (heure suisse).
        const iso = url.searchParams.get("iso");
        this.decalage = iso ? instantLocal(iso.slice(0, 10), iso.slice(11, 16)) - Date.now() : 0;
        if (url.searchParams.get("tic")) await this.enFile(() => this.tic(null));
        return Response.json({ maintenant: this.contexte().maintenant, reveil: await this.ctx.storage.getAlarm() });
      }
      if (url.pathname === "/test/etat" && this.env.MODE_TEST === "1") {
        if (requete.method === "POST") {
          const corps = await requete.json();
          if (corps.config) await this.ctx.storage.put("config", corps.config);
          if (corps.etat) await this.ctx.storage.put("etat", corps.etat);
          if (corps.effacer) await this.ctx.storage.deleteAll();
          if (corps.oublier_config) await this.ctx.storage.delete("config");
        }
        return Response.json({ config: await this.ctx.storage.get("config"), etat: await this.ctx.storage.get("etat"), reveil: await this.ctx.storage.getAlarm() });
      }
      if (url.pathname === "/app/fichier") {
        return Response.json(await this.fichierAudio(url.searchParams.get("cle") || ""));
      }
      if (url.pathname === "/app" && requete.method === "POST") {
        // L'appareil est donné par le Worker (vérifié), jamais par la page.
        const demande = { ...(await requete.json()), _appareil: requete.headers.get("X-Appareil-Id") || "" };
        return Response.json(await this.enFile(() => this.actionApp(demande)));
      }
      if (url.pathname === "/api/config") return Response.json(await this.enFile(() => this.exporterConfig()));
      if (url.pathname === "/api/rubrique") return Response.json({ entrees: await this.historiqueRubrique(url.searchParams.get("id") || "") });
      if (url.pathname === "/flux") return await this.enFile(() => this.servirFlux(url.searchParams));
      if (url.pathname === "/api/code-connexion") return Response.json(await this.enFile(() => this.codeConnexion(url.searchParams.get("si") === "premiere")));
      if (url.pathname === "/appareil/connexion") { const corps = await requete.json().catch(() => ({})); return Response.json(await this.enFile(() => this.connecterAppareil(corps))); }
      if (url.pathname === "/appareil/verifier") return Response.json(await this.enFile(() => this.verifierAppareil(url.searchParams.get("e") || "")));
      if (url.pathname === "/fichier-depose") {
        await this.enFile(async () => {
          const etat = await this.lireEtat();
          noterStockage(etat, url.searchParams.get("nom") || "", Number(url.searchParams.get("taille")) || 0);
          await this.ecrireEtat(etat);
        });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/evenement") {
        const evenement = await requete.json();
        return Response.json(await this.enFile(() => this.recevoirEvenement(evenement)));
      }
      if (url.pathname === "/installer") return new Response(await this.enFile(() => this.installer(url.searchParams.get("adresse"))));
      if (url.pathname === "/etat") return new Response(await this.enFile(() => this.resumeEtat()));
      return new Response("introuvable", { status: 404 });
    } catch (erreur) {
      console.log("Erreur :", erreur.stack || erreur);
      return new Response(`erreur : ${erreur.message}`, { status: 500 });
    }
  }

  // ─────────────────────────────── stockage ─────────────────────────────────

  // Modèles légers : la liste découverte par GitHub (la plus récente), sinon celle par défaut.
  // La clé saisie dans l'application l'emporte sur le secret Cloudflare.
  get envGemini() {
    return this.cles?.gemini ? { ...this.env, GEMINI_API_KEY: this.cles.gemini } : this.env;
  }
  gemini(systeme, contenus, schema) {
    return demanderGemini(this.envGemini, systeme, contenus, schema, this.modelesLegers?.length ? this.modelesLegers : undefined);
  }

  async ecrireCles(cles) {
    this.cles = cles;
    await this.ctx.storage.put("cles", cles);
  }
  get gh() { return (this._gh ||= new GitHub(this.env)); }

  maintenant() {
    return Date.now() + (this.decalage || 0);
  }

  contexte() {
    const m = maintenantLocal(new Date(this.maintenant()));
    return { maintenant: m, aujourdHui: m.date, maintenantIso: m.iso };
  }

  // Le réveil programmé du Durable Object : épisodes, rattrapage, sauvegarde.
  async alarm() {
    await this.enFile(() => this.tic(null));
  }

  async lireConfig() {
    let config = await this.ctx.storage.get("config");
    if (!config) {
      config = await this.importerDepuisGitHub().catch((erreur) => {
        console.log("Import impossible :", erreur.message);
        return configParDefaut();
      });
      await this.ctx.storage.put("config", config);
    }
    if (!config.pays) {
      // Version d'avant le réglage « pays » : on le déduit une fois pour toutes.
      config = { ...config, ...(await this.devinerPays(config)) };
      await this.ctx.storage.put("config", config);
    }
    const complete = completerConfig(config);
    definirFuseau(profilPays(complete).fuseau);
    return complete;
  }

  // Pays d'une installation d'avant le réglage : d'après reglages.toml (la « version
  // France » y mettait Europe/Paris), sinon d'après les jours fériés choisis.
  async devinerPays(config) {
    let toml = "";
    try { toml = (await this.gh.lire("reglages.toml"))?.texte || ""; } catch { /* GitHub injoignable : on se contente des fériés */ }
    const fuseau = /^fuseau_horaire\s*=\s*"([^"]+)"/m.exec(toml)?.[1] || "";
    const parFuseau = Object.entries(PAYS).find(([, p]) => p.fuseau === fuseau)?.[0];
    const region = config.planning?.feries_region || "CH-VD";
    const pays = parFuseau || (PAYS[region] ? region : "CH");
    const planning = { ...(config.planning || {}) };
    // La « version France » calculait les fériés français sous le nom « Vaud ».
    if (pays !== "CH" && region === "CH-VD") { planning.feries_region = PAYS[pays].feries; planning.feries_cache = {}; }
    console.log(`Pays déduit : ${pays}`);
    return { pays, planning };
  }

  async lireEtat() {
    const etat = { annulations: [], episodes: [], declenchements: {},
                   refaits: {}, recherches: {}, historique: [], ...(await this.ctx.storage.get("etat") || {}) };
    // Une fois : on oublie l'ancienne conversation et ses appareils (sans jeton, ils ne s'ouvrent plus).
    if (ANCIENNES_CLES.some((cle) => cle in etat) || (etat.appareils || []).some((a) => !a.empreinte)) {
      for (const cle of ANCIENNES_CLES) delete etat[cle];
      etat.appareils = (etat.appareils || []).filter((a) => a.empreinte);
      await this.ctx.storage.put("etat", etat);
    }
    // Les textes des épisodes vivent à part (clé « texte:… ») : l'état reste léger.
    if (etat.episodes.some((ep) => ep.transcription)) {
      for (const ep of etat.episodes) {
        if (!ep.transcription) continue;
        await this.ctx.storage.put(`texte:${cleEpisode(ep)}`, ep.transcription);
        ep.texte = true;
        delete ep.transcription;
      }
      await this.ctx.storage.put("etat", etat);
    }
    return etat;
  }

  // Mémoire des rubriques : ce que chacune a dit dans les derniers épisodes (texte et liens), pour son résumé.
  async retenirRubriques(episode, rubriques) {
    if (!rubriques || typeof rubriques !== "object") return;
    for (const [id, r] of Object.entries(rubriques).slice(0, 40)) {
      if (!/^[A-Za-z0-9_]{1,24}$/.test(id) || !r || typeof r.texte !== "string") continue;
      const cle = `rub:${id}`;
      const gardees = ((await this.ctx.storage.get(cle)) || []).filter((x) => x.episode !== cleEpisode(episode));
      gardees.push({ date: episode.date, episode: cleEpisode(episode), titre: String(r.titre || "").slice(0, 80),
                     texte: r.texte.slice(0, 4000), sources: nettoyerSources((r.sources || []).map((s) => ({ section: r.titre, ...s }))).slice(0, 10) });
      await this.ctx.storage.put(cle, gardees.slice(-30));
    }
  }

  async historiqueRubrique(id) {
    if (!/^[A-Za-z0-9_]{1,24}$/.test(id)) return [];
    return (await this.ctx.storage.get(`rub:${id}`)) || [];
  }

  async texteEpisode(episode) {
    return episode?.transcription || (await this.ctx.storage.get(`texte:${cleEpisode(episode)}`)) || "";
  }

  async ecrireEtat(etat) {
    await this.ctx.storage.put("etat", etat);
  }

  // Enregistre une nouvelle configuration, avec possibilité d'annuler.
  async enregistrer(config, etat, ancienne, libelle) {
    if (ancienne && JSON.stringify(ancienne) !== JSON.stringify(config)) {
      etat.annulations = [...(etat.annulations || []), { libelle: libelle.slice(0, 60), config: ancienne, quand: Date.now() }].slice(-15);
    }
    await this.ctx.storage.put("config", config);
    definirFuseau(profilPays(config).fuseau);
    await this.ecrireEtat(etat);
    await this.planifierReveil(config, etat).catch((erreur) => console.log("Réveil :", erreur.message));
  }

  async importerDepuisGitHub() {
    // Le bot repart de zéro (supprimé, recréé…) : sa propre sauvegarde quotidienne
    // contient tout (rubriques, déroulé, planning, voix). Elle passe avant le reste.
    const sauvegarde = JSON.parse((await this.gh.lire("preferences.json"))?.texte || "{}");
    if (sauvegarde.format === "bot-v2" && sauvegarde.config && typeof sauvegarde.config === "object" && sauvegarde.config.planning) {
      console.log("Réglages restaurés depuis la sauvegarde preferences.json.");
      return sauvegarde.config;
    }
    const config = configParDefaut();
    const toml = (await this.gh.lire("reglages.toml"))?.texte || "";
    const valeur = (cle) => {
      const m = new RegExp(`^${cle}\\s*=\\s*(.+?)\\s*(#.*)?$`, "m").exec(toml);
      if (!m) return undefined;
      const brut = m[1].trim();
      if (brut.startsWith('"')) return brut.slice(1, brut.indexOf('"', 1));
      if (brut === "true" || brut === "false") return brut === "true";
      return Number(brut);
    };
    const affecter = (chemin, v) => { if (v !== undefined && v !== "") { try { regler(config, chemin, v); } catch { /* valeur hors limites */ } } };
    affecter("format.duree_minutes", valeur("duree_minutes"));
    affecter("format.nombre_sujets", valeur("nombre_sujets"));
    affecter("voix.vitesse", valeur("vitesse_parole"));
    affecter("voix.tutoiement", valeur("tutoiement"));
    affecter("voix.prenom", valeur("prenom_auditeur"));
    affecter("actus.ville", valeur("ville_habituelle"));
    affecter("agenda.jours", valeur("jours_agenda"));
    affecter("agenda.horizon", valeur("horizon_prochain_evenement_jours"));
    affecter("agenda.jours_deplacements", valeur("jours_deplacements"));
    affecter("agenda.notes", valeur("inclure_notes_agenda"));
    affecter("actus.fraicheur_heures", valeur("fraicheur_heures"));
    const animateurs = [...toml.matchAll(/\[\[animateurs\]\]\s*\nnom\s*=\s*"([^"]+)"\s*\nvoix\s*=\s*"([^"]+)"/g)];
    if (animateurs.length === 2) {
      // Ancien format (un prénom et une voix par animateur) : la lecture de la configuration
      // donne ces prénoms à leurs voix.
      config.voix.animateurs = animateurs.map((m) => ({ nom: m[1], voix: m[2] }));
      delete config.voix.noms;
    }
    const workflow = (await this.gh.lire(".github/workflows/podcast-du-matin.yml"))?.texte || "";
    const heure = /HEURE_LOCALE:\s*"(\d{2}:\d{2})"/.exec(workflow)?.[1];
    if (heure) for (const j of JOURS) config.planning.jours[j] = heure;
    const prefs = JSON.parse((await this.gh.lire("preferences.json"))?.texte || "{}");
    const p = prefs.preferences || {};
    affecter("voix.vitesse", p.vitesse_parole);
    affecter("format.duree_minutes", p.duree_minutes);
    affecter("actus.ville", p.ville_habituelle);
    if (p.sujets_preferes?.length) config.actus.sujets_preferes = nettoyerListe(p.sujets_preferes);
    if (p.sujets_a_eviter?.length) config.actus.sujets_a_eviter = nettoyerListe(p.sujets_a_eviter);
    if (p.consignes?.length) config.consignes = nettoyerListe(p.consignes, 20, LONGUEUR_CONSIGNE);
    if (Array.isArray(prefs.a_approfondir)) config.a_approfondir = prefs.a_approfondir.filter((a) => a?.sujet).slice(-5);
    return config;
  }

  // ───────────────────────── compréhension libre (Gemini) ─────────────────────

  // Comprend une demande libre (écrite ou vocale) et applique les réglages. Renvoie ce
  // qu'il faut dire et faire ensuite, ou null si Gemini ne répond pas.
  async comprendreCoeur(texte, audio = null, indice = "") {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const contenus = [{ type: "text", text: contexteComprehension(config, { ...ctx, dernierEpisode: etat.episodes.at(-1) }) }];
    if (indice) contenus.push({ type: "text", text: `(Contexte : ${indice})` });
    if (texte) contenus.push({ type: "text", text: texte.slice(0, 2000) });
    if (audio) contenus.push(audio);
    if (contenus.length === 1) return { vide: true };
    let reponse;
    try {
      reponse = await this.gemini(consigneComprehension(config, { ...ctx, agendas: etat.agendas || [] }), contenus, schemaOperations());
    } catch (erreur) {
      console.log("Gemini :", erreur.message);
      return null;
    }
    const compris = {
      texte: String(texte || "").slice(0, 2000), vocal: Boolean(audio),
      entendu: audio ? String(reponse?.entendu || "").trim().slice(0, 1000) : "",
      operations: Array.isArray(reponse?.operations) ? reponse.operations.slice(0, 20) : [],
      reponse: String(reponse?.reponse || "").trim().slice(0, 600),
    };
    // Une rubrique créée reçoit un titre et une consigne rédigés, jamais la phrase de l'auditeur.
    const message = compris.texte || compris.entendu;
    for (const op of rubriquesARediger(compris.operations, message).slice(0, 3)) {
      try {
        appliquerRedaction(op.regle, await this.gemini(CONSIGNE_REDACTION, contenuRedaction(message, op.regle), schemaRedaction()), message);
      } catch (erreur) {
        console.log("Rédaction de la rubrique :", erreur.message);
      }
    }
    return this.appliquerCompris(compris, false);
  }

  // Applique ce que Gemini a compris. Un changement lourd (plusieurs jours sans épisode,
  // une rubrique supprimée) n'est pas enregistré : il attend la confirmation de l'auditeur.
  async appliquerCompris(compris, confirme) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const ancienne = cloner(config);
    const message = compris.texte || compris.entendu || "(vocal)";
    const resultat = appliquerOperations(config, compris.operations, { ...ctx, message });
    const base = { reponse: compris.reponse || "", entendu: compris.entendu || "", vocal: Boolean(compris.vocal) };
    const trace = { quand: ctx.maintenantIso, message: message.slice(0, 300), vocal: Boolean(compris.vocal),
                    operations: JSON.stringify(compris.operations).slice(0, 1500), erreurs: resultat.erreurs };
    if (!confirme && resultat.lourds.length) {
      etat.a_confirmer = { compris, quand: Date.now() };
      etat.historique = [...(etat.historique || []), { ...trace, changements: [], a_confirmer: resultat.changements, issue: "attente" }].slice(-30);
      await this.ecrireEtat(etat);
      return { ...base, config: ancienne, changements: [], actions: [], erreurs: resultat.erreurs, reglesCreees: [], a_confirmer: resultat.changements };
    }
    delete etat.a_confirmer;
    for (const action of resultat.actions.filter((a) => a.type === "ajouter_source")) {
      try { resultat.changements.push(await this.ajouterFlux(config, action.valeur, true)); } catch (erreur) { resultat.erreurs.push(`Source : ${erreur.message}`); }
    }
    for (const { table, id } of resultat.suppressions) this.remapperEtat(etat, table, id);
    // Une demande confirmée complète sa ligne « en attente » de l'historique.
    const enAttente = confirme ? [...(etat.historique || [])].reverse().find((d) => d.issue === "attente") : null;
    if (enAttente) Object.assign(enAttente, { changements: resultat.changements, erreurs: resultat.erreurs, a_confirmer: [], issue: "confirme" });
    else etat.historique = [...(etat.historique || []), { ...trace, changements: resultat.changements, erreurs: resultat.erreurs, issue: null }].slice(-30);
    if (resultat.changements.length) await this.enregistrer(config, etat, ancienne, resultat.changements.length > 1 ? `${resultat.changements[0]} (+${resultat.changements.length - 1})` : resultat.changements[0]);
    else await this.ecrireEtat(etat);
    return { ...base, config, ...resultat, a_confirmer: [] };
  }

  // Réponse de l'auditeur à « À confirmer » : appliquer (oui) ou laisser tel quel (non).
  // null : plus rien en attente (déjà traité, ou trop ancien : 15 minutes).
  async repondreConfirmation(oui) {
    const etat = await this.lireEtat();
    const attente = etat.a_confirmer;
    if (!attente) return null;
    delete etat.a_confirmer;
    const expiree = Date.now() - attente.quand > 15 * 60_000;
    const ligne = [...(etat.historique || [])].reverse().find((d) => d.issue === "attente");
    if (ligne && (expiree || !oui)) ligne.issue = expiree ? "expire" : "abandonne";
    await this.ecrireEtat(etat);
    if (expiree) return null;
    if (!oui) return { abandon: true };
    return this.appliquerCompris(attente.compris, true);
  }

  // Revient à la configuration d'avant le dernier changement ; renvoie son libellé.
  async annulerCoeur() {
    const etat = await this.lireEtat();
    const derniere = etat.annulations?.pop();
    if (!derniere) return null;
    await this.ctx.storage.put("config", derniere.config);
    await this.ecrireEtat(etat);
    const config = completerConfig(derniere.config);
    await this.planifierReveil(config, etat).catch(() => {});
    return derniere.libelle;
  }

  // ─────────────────────── épisodes, recherches, extraits ─────────────────────

  async lancerEpisode(ids) {
    const ctx = this.contexte();
    const etat = await this.lireEtat();
    const compte = etat.refaits?.date === ctx.aujourdHui ? etat.refaits.nombre : 0;
    if (compte >= MAX_REFAITS) return { ok: false, erreur: `Déjà ${compte} épisodes à la demande aujourd'hui : c'est le maximum. Ça repart demain.` };
    try {
      await this.gh.lancer("podcast-du-matin.yml", { mode: "manuel", regles: (ids || []).join(",") });
    } catch (erreur) {
      return { ok: false, erreur: erreur.message };
    }
    etat.refaits = { date: ctx.aujourdHui, nombre: compte + 1 };
    await this.ecrireEtat(etat);
    return { ok: true };
  }

  async lancerRecherche(ids, format) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const valides = (ids || []).filter((id) => config.regles.some((r) => r.id === id) || RUBRIQUES_A_CHERCHER.includes(id));
    if (!valides.length) return { ok: false, erreur: "Aucune rubrique à traiter." };
    // Une recherche « point » se rend toujours en podcast d'état des lieux, quel que soit le bouton.
    const points = valides.filter((id) => config.regles.find((r) => r.id === id)?.recherche?.rendu === "point");
    if (points.length) { format = "point"; valides.splice(0, valides.length, ...points); }
    // Une rubrique essentielle (Agenda, Actualités…) : « Mini-podcast » = son point audio, sinon son point écrit.
    const essentielle = valides.find((id) => RUBRIQUES_A_CHERCHER.includes(id));
    if (essentielle) { format = format === "audio" || format === "point" ? "point" : "ecrit"; valides.splice(0, valides.length, essentielle); }
    if (format === "audio" || format === "point") {
      const compte = etat.refaits?.date === ctx.aujourdHui ? etat.refaits.nombre : 0;
      if (compte >= MAX_REFAITS) return { ok: false, erreur: "Plus de mini-podcast aujourd'hui (quota gratuit de la voix) : choisis les résultats écrits." };
      etat.refaits = { date: ctx.aujourdHui, nombre: compte + 1 };
    } else {
      const compte = etat.recherches?.date === ctx.aujourdHui ? etat.recherches.nombre : 0;
      if (compte >= MAX_RECHERCHES) return { ok: false, erreur: "Assez de recherches pour aujourd'hui (quota gratuit). Ça repart demain." };
      etat.recherches = { date: ctx.aujourdHui, nombre: compte + 1 };
    }
    try {
      await this.gh.lancer("recherche.yml", { regles: valides.join(","), format });
    } catch (erreur) {
      return { ok: false, erreur: erreur.message };
    }
    await this.ecrireEtat(etat);
    return { ok: true, format };
  }

  // ───────────────────────────────── sources ─────────────────────────────────

  // Un flux de plus (Réglages › Sources › Flux) : un média ou un site, d'après son nom ou son
  // adresse. « actualites » : lu aussi par les Actualités globales.
  async ajouterFlux(config, valeur, actualites = false, { nom = "", propose = false } = {}) {
    const liste = config.sources.flux;
    const trouve = await this.trouverMedia(config, valeur);
    if (nom) trouve.nom = nom;
    let flux = liste.find((f) => f.url === trouve.url);
    if (flux && (!actualites || config.actus.flux_lus.includes(flux.id))) throw new Error(`« ${flux.nom} » est déjà dans tes flux.`);
    if (!flux) {
      if (liste.length >= MAX_FLUX) throw new Error(`${MAX_FLUX} flux au plus : retires-en un d'abord.`);
      // Un média proposé pour le pays garde sa marque : il suivra un changement de pays.
      flux = { id: idCourt(`flux:${trouve.url}`), nom: trouve.nom.slice(0, 60), url: trouve.url, ...(propose ? { pays: config.pays } : {}) };
      liste.push(flux);
    }
    if (actualites) config.actus.flux_lus = [...new Set([...config.actus.flux_lus, flux.id])];
    return `Flux ajouté : ${flux.nom}${actualites ? " (lu par les Actualités globales)" : ""}`;
  }

  // Un flux retiré de la liste : les Actualités globales et les rubriques qui le lisaient ne le gardent pas.
  retirerFlux(config, id) {
    const flux = config.sources.flux.find((f) => f.id === id);
    if (!flux) throw new Error("Ce flux n'est plus dans la liste.");
    if (config.actus.flux_lus.length === 1 && config.actus.flux_lus[0] === id) {
      throw new Error("C'est le dernier flux de tes Actualités globales : coche d'abord un autre flux dans leur fiche.");
    }
    config.sources.flux = config.sources.flux.filter((f) => f.id !== id);
    config.actus.flux_lus = config.actus.flux_lus.filter((x) => x !== id);
    for (const r of config.regles) if (r.recherche) r.recherche.sources = r.recherche.sources.filter((x) => x !== `flux:${id}`);
    return `Flux retiré : ${flux.nom}`;
  }

  // Résultat du test d'un outil (service, flux, site, agenda), gardé pour l'application.
  noterTest(etat, cle, test, ctx) {
    const tests = { ...(etat.tests_outils || {}), [cle]: { ok: Boolean(test.ok), message: String(test.message || "").slice(0, 300), quand: ctx.maintenantIso } };
    etat.tests_outils = Object.fromEntries(Object.entries(tests).slice(-80));
  }

  // Le flux RSS d'un média ou d'un site, d'après son nom (Gemini propose des adresses) ou son adresse.
  async trouverMedia(config, valeur) {
    const candidats = [];
    if (/^https?:\/\//i.test(valeur)) candidats.push({ nom: "", url: valeur });
    else {
      try {
        const r = await this.gemini(`Donne les adresses de flux RSS les plus probables pour ce média (francophone, souvent ${{ CH: "suisse", FR: "français", BE: "belge" }[config.pays] || "suisse"}). Si tu ne sais pas, donne l'adresse de son site.`,
          `Média : ${valeur}`, { type: "object", properties: { nom: { type: "string" }, urls: { type: "array", items: { type: "string" }, maxItems: 4 } }, required: ["urls"] });
        for (const url of r.urls || []) candidats.push({ nom: r.nom || valeur, url });
      } catch { /* on tente quand même une recherche simple */ }
    }
    for (const candidat of candidats) {
      const flux = await trouverFlux(candidat.url);
      if (flux) return { nom: candidat.nom || flux.titre || valeur, url: flux.url };
    }
    throw new Error(`je n'ai pas trouvé de flux RSS pour « ${valeur} ». Envoie-moi l'adresse du flux si tu l'as.`);
  }

  // ─────────────────────────── tic de chaque minute ──────────────────────────

  async tic(adresse) {
    const ctx = this.contexte();
    let etat = await this.lireEtat();
    if (adresse) etat.adresse = adresse;
    if (etat.version_installee !== VERSION && (etat.adresse || this.env.ADRESSE)) {
      await this.installer(etat.adresse || this.env.ADRESSE);
      // L'installation a écrit l'état (version installée…) : repartir de celui-là, sinon
      // l'ancien l'écraserait et le bot se réinstallerait (et l'annoncerait) à chaque tic.
      etat = await this.lireEtat();
      if (adresse) etat.adresse = adresse;
    }
    const config = await this.lireConfig();
    const m = ctx.maintenant;
    const maintenant = this.maintenant();
    // Aujourd'hui et hier (un épisode prévu à 23 h 50 peut se rattraper après minuit).
    for (const date of [ajouterJours(m.date, -1), m.date]) {
      const heure = heurePrevue(config.planning, date);
      if (!heure) continue;
      const jour = etat.declenchements[date] || {};
      const prevu = instantLocal(date, heure);
      const lancement = prevu - (config.planning.avance_minutes || 0) * 60000;
      let change = false;
      if (!jour.lance && maintenant >= lancement && maintenant <= prevu + 45 * 60000
          && (!jour.reessai || maintenant >= jour.reessai)) {
        try {
          await this.gh.lancer("podcast-du-matin.yml", { mode: "planifie", regles: "" });
          jour.lance = ctx.maintenantIso;
          delete jour.reessai;
        } catch (erreur) {
          jour.erreur = erreur.message;
          jour.essais = (jour.essais || 0) + 1;
          jour.reessai = maintenant + Math.min(15, 2 * jour.essais) * 60000;
          console.log("Lancement impossible :", erreur.message);
        }
        change = true;
      }
      const delai = config.planning.delai_rattrapage || 60;
      if (jour.lance && !jour.envoye && !jour.rattrape && config.planning.rattrapage
          && maintenant >= prevu + delai * 60000 && maintenant <= prevu + (delai + 90) * 60000) {
        try {
          await this.gh.lancer("podcast-du-matin.yml", { mode: "rattrapage", regles: "" });
          jour.rattrape = ctx.maintenantIso;
        } catch (erreur) {
          console.log("Rattrapage impossible :", erreur.message);
          jour.rattrape = `échec ${ctx.maintenantIso}`;
        }
        change = true;
      }
      if (change) etat.declenchements[date] = jour;
    }
    for (const date of Object.keys(etat.declenchements)) if (date < ajouterJours(m.date, -7)) delete etat.declenchements[date];
    await this.ecrireEtat(etat);
    // Sauvegarde quotidienne des réglages dans le dépôt (sert aussi de secours à GitHub).
    if (m.heure >= "03:00" && etat.sauvegarde !== m.date) {
      etat.sauvegarde = m.date;
      await this.ecrireEtat(etat);
      await this.sauvegarder(config).catch((erreur) => console.log("Sauvegarde :", erreur.message));
    }
    // Une fois par jour : ménage des fichiers de plus d'un an, place prise recomptée.
    if (m.heure >= "03:00" && etat.menage !== m.date) {
      etat.menage = m.date;
      await this.menageFichiers(etat, m.date).catch((erreur) => console.log("Ménage :", erreur.message));
      await this.ecrireEtat(etat);
    }
    // Une fois par jour : une nouvelle version du modèle ?
    if (this.env.MODELE && etat.maj_verifie !== m.date && m.heure >= "04:00") {
      etat.maj_verifie = m.date;
      await this.verifierMaj(etat);
      await this.ecrireEtat(etat);
    }
    // Jours fériés téléchargés (hors Vaud et France) : on garde l'année en cours et la suivante.
    const region = config.planning.feries_region || "CH-VD";
    const annee = Number(m.date.slice(0, 4));
    if (!FERIES_CALCULES.includes(region) && (!config.planning.feries_cache?.[annee + 1]) && etat.feries_essai !== m.date) {
      etat.feries_essai = m.date;
      await this.ecrireEtat(etat);
      try {
        const frais = await this.lireConfig();
        frais.planning.feries_cache = { [annee]: frais.planning.feries_cache?.[annee] || await telechargerFeries(this.env, region, annee),
                                        [annee + 1]: await telechargerFeries(this.env, region, annee + 1) };
        await this.ctx.storage.put("config", frais);
      } catch (erreur) { console.log("Fériés :", erreur.message); }
    }
    await this.planifierReveil(config, etat);
  }

  // Programme le prochain réveil : lancement d'un épisode, rattrapage,
  // sauvegarde de 3 h, passage au jour suivant.
  async planifierReveil(config, etat) {
    const ctx = this.contexte();
    const maintenant = this.maintenant();
    const candidats = [];
    for (let i = -1; i <= 2; i++) {
      const date = ajouterJours(ctx.aujourdHui, i);
      const heure = heurePrevue(config.planning, date);
      if (!heure) continue;
      const jour = etat.declenchements[date] || {};
      const prevu = instantLocal(date, heure);
      if (!jour.lance) {
        const lancement = Math.max(prevu - (config.planning.avance_minutes || 0) * 60000, jour.reessai || 0);
        if (lancement <= prevu + 45 * 60000 && maintenant <= prevu + 45 * 60000) candidats.push(lancement);
      } else if (!jour.envoye && !jour.rattrape && config.planning.rattrapage
                 && maintenant <= prevu + ((config.planning.delai_rattrapage || 60) + 90) * 60000) {
        candidats.push(prevu + (config.planning.delai_rattrapage || 60) * 60000);
      }
    }
    const demain = ajouterJours(ctx.aujourdHui, 1);
    candidats.push(etat.sauvegarde === ctx.aujourdHui ? instantLocal(demain, "03:05") : instantLocal(ctx.aujourdHui, "03:05"));
    candidats.push(instantLocal(demain, "00:01"));
    const futurs = candidats.map((t) => Math.max(t, maintenant + 1000)).filter((t) => t <= maintenant + 26 * 3600000);
    const prochain = Math.min(...futurs);
    // Horloge simulée (tests) : le réveil réel est décalé d'autant.
    const reel = prochain - (this.decalage || 0);
    const actuel = await this.ctx.storage.getAlarm();
    if (actuel !== reel) await this.ctx.storage.setAlarm(reel);
    return prochain;
  }

  async sauvegarder(config) {
    return this.gh.ecrire("preferences.json", `${JSON.stringify({ format: "bot-v2", config }, null, 2)}\n`, "Sauvegarde quotidienne des réglages du bot");
  }

  // Nouvelle version (ou première installation) : notée, réglages sauvegardés, annoncée par notification.
  async installer(adresse) {
    if (!adresse) return "Adresse du bot inconnue.";
    const etat = await this.lireEtat();
    const avant = etat.version_installee;
    etat.adresse = adresse;
    if (avant !== VERSION) {
      etat.version_installee = VERSION;
      await this.ecrireEtat(etat);
      await this.sauvegarder(await this.lireConfig()).catch(() => {});
      if (avant) await this.annoncerVersion(etat);
    } else {
      await this.ecrireEtat(etat);
    }
    await this.planifierReveil(await this.lireConfig(), await this.lireEtat()).catch((erreur) => console.log("Réveil :", erreur.message));
    return `✅ Bot activé, version ${VERSION}.`;
  }

  async annoncerVersion(etat) {
    await this.notifier(etat, { titre: "✅ Ton podcast est à jour", corps: `Version ${VERSION}. ${NOUVEAUTES[0] || ""}`.slice(0, 200),
      url: "/app", tag: "version" });
  }

  // Code de connexion à l'application, demandé par GitHub (workflow « Code de connexion »,
  // ou fin du déploiement tant qu'aucun appareil n'est connecté). Valable une heure.
  async codeConnexion(premiere) {
    const etat = await this.lireEtat();
    const adresse = `${String(etat.adresse || this.env.ADRESSE || "").replace(/\/$/, "")}/app`;
    if (premiere && (etat.appareils || []).length) return { ok: true, code: null, adresse, raison: "deja_connecte" };
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    const expire = Date.now() + 60 * 60 * 1000;
    etat.code_appareil = { code, expire, essais: 0 };
    await this.ecrireEtat(etat);
    return { ok: true, code, expire, jusqua: maintenantLocal(new Date(expire)).heure, adresse };
  }

  // ─────────────────────────────── application ──────────────────────────────

  // Adresse de la page, seulement en https.
  adresseApp(etat) {
    const base = etat?.adresse || this.env.ADRESSE || "";
    return /^https:\/\//.test(base) ? `${base.replace(/\/$/, "")}/app` : null;
  }

  // Adresses audio signées : épisodes, pochettes, extraits de voix, mini-podcasts.
  async liensAudio(etat, episodes = etat.episodes || []) {
    const secret = await secretPartage(this.env);
    // Le lien est vérifié avec l'heure réelle (index.js) : jamais signé dans le passé,
    // même quand l'horloge des tests est simulée.
    const maintenant = () => Math.max(this.maintenant(), Date.now());
    const liens = { episodes: {}, voix: {} };
    liens.pochettes = {};
    for (const episode of episodes) {
      if (episode.audio) liens.episodes[cleEpisode(episode)] = await lienAudio(secret, cleEpisode(episode), maintenant());
      if (episode.pochette) liens.pochettes[cleEpisode(episode)] = await lienAudio(secret, `img:${cleEpisode(episode)}`, maintenant());
    }
    if (etat.derniers_resultats?.audio) liens.idees = await lienAudio(secret, "idees:dernier", maintenant());
    for (const voix of Object.keys(etat.echantillons_fichiers || {})) {
      if (/^[A-Za-z]+$/.test(voix) && etat.echantillons_fichiers?.[voix]) liens.voix[voix] = await lienAudio(secret, `voix:${voix}`, maintenant());
    }
    return liens;
  }

  // Où trouver un fichier gardé par le bot (null s'il n'existe plus).
  async fichierAudio(cle) {
    const etat = await this.lireEtat();
    if (cle === "idees:dernier") return { fichier: etat.derniers_resultats?.audio || null };
    if (cle.startsWith("resume:")) return { fichier: etat.resumes?.[cle.slice(7)]?.audio || null };
    if (cle.startsWith("voix:")) return { fichier: etat.echantillons_fichiers?.[cle.slice(5)] || null };
    const image = cle.startsWith("img:");
    const episode = await this.trouverEpisode(etat, image ? cle.slice(4) : cle);
    if (!episode) return { fichier: null };
    return { fichier: (image ? episode.pochette : episode.audio) || null };
  }

  // ───────────────────────── notifications ──────────────────────────────────

  async clesVapid() {
    let cles = await this.ctx.storage.get("vapid");
    if (!cles?.publique || !cles?.privee) {
      cles = await nouvellesClesVapid();
      await this.ctx.storage.put("vapid", cles);
    }
    return cles;
  }

  // Envoie une notification aux appareils abonnés (ceux dont l'interrupteur est mis, ou « cibles »). Un abonnement
  // disparu (404, 410) est oublié ; une autre erreur est notée ; l'état est enregistré.
  async notifier(etat, message, cibles = (etat.abonnements || []).filter((a) => !a.coupe)) {
    const bilan = { remis: 0, retires: 0 };
    if (!cibles.length) return bilan;
    const cles = await this.clesVapid();
    const adresse = etat.adresse || this.env.ADRESSE || "";
    const sujet = /^https:\/\//.test(adresse) ? adresse : "mailto:podcast-matin@example.com";
    const statuts = await Promise.all(cibles.map((a) => envoyerNotification(a, message, cles, sujet).catch((erreur) => `erreur ${erreur.name || ""}`.trim())));
    const oublies = new Set();
    cibles.forEach((a, i) => {
      const statut = statuts[i];
      if (statut === 404 || statut === 410) { oublies.add(a.endpoint); bilan.retires++; return; }
      const fiche = (etat.abonnements || []).find((x) => x.endpoint === a.endpoint) || a;
      if (typeof statut === "number" && statut >= 200 && statut < 300) { bilan.remis++; fiche.erreur = null; fiche.dernier_envoi = this.contexte().maintenantIso; }
      else fiche.erreur = typeof statut === "number" ? `refusé (HTTP ${statut})` : "service injoignable";
    });
    if (oublies.size) etat.abonnements = (etat.abonnements || []).filter((a) => !oublies.has(a.endpoint));
    await this.ecrireEtat(etat);
    return bilan;
  }

  // Au-delà des MAX_EPISODES récents, les épisodes passent dans l'archive de leur mois
  // (une valeur par mois) : l'application les retrouve, l'état reste léger.
  async archiver(etat, sortants) {
    const parMois = {};
    for (const ep of sortants) if (/^\d{4}-\d{2}-\d{2}$/.test(ep.date || "")) (parMois[ep.date.slice(0, 7)] ||= []).push(ep);
    for (const [mois, liste] of Object.entries(parMois)) {
      const avant = (await this.ctx.storage.get(`archive:${mois}`)) || [];
      const cles = new Set(liste.map(cleEpisode));
      const fusion = [...avant.filter((ep) => !cles.has(cleEpisode(ep))), ...liste]
        .sort((a, b) => `${a.date} ${a.heure || ""}`.localeCompare(`${b.date} ${b.heure || ""}`)).slice(-MAX_ARCHIVE_MOIS);
      await this.ctx.storage.put(`archive:${mois}`, fusion);
      etat.archives = [...new Set([...(etat.archives || []), mois])].sort();
    }
  }

  // Chaque nuit : on garde le mois en cours et les douze précédents. Plus ancien,
  // l'audio (tout l'objet du mois), les textes et l'archive du mois s'en vont.
  // La place prise est recomptée, et les extraits de voix remplacés sont retirés.
  async menageFichiers(etat, aujourdHui) {
    const limite = moisDecale(aujourdHui.slice(0, 7), -CONSERVATION_MOIS);
    for (const mois of (etat.archives || []).filter((m) => m < limite)) {
      const liste = (await this.ctx.storage.get(`archive:${mois}`)) || [];
      const cles = liste.map((ep) => `texte:${cleEpisode(ep)}`);
      for (let i = 0; i < cles.length; i += 128) await this.ctx.storage.delete(cles.slice(i, i + 128));
      await this.ctx.storage.delete(`archive:${mois}`);
    }
    etat.archives = (etat.archives || []).filter((m) => m >= limite);
    for (const ep of etat.episodes || []) {
      if ((ep.date || "").slice(0, 7) < limite && (ep.audio || ep.pochette)) { ep.audio = null; ep.pochette = null; }
    }
    const utiles = new Set(Object.values(etat.echantillons_fichiers || {}));
    for (const objet of Object.keys(etat.stockage || {})) {
      const audio = objetAudio(this.env, objet);
      if (/^\d{4}-\d{2}$/.test(objet) && objet < limite) {
        await audio.fetch(new Request("https://audio.interne/tout", { method: "DELETE" }));
        delete etat.stockage[objet];
        continue;
      }
      let fichiers = await (await audio.fetch(new Request("https://audio.interne/liste"))).json();
      if (objet === "voix") {
        for (const f of fichiers.filter((x) => !utiles.has(x.nom))) {
          await audio.fetch(new Request(`https://audio.interne/f/${encodeURIComponent(f.nom)}`, { method: "DELETE" }));
        }
        fichiers = fichiers.filter((x) => utiles.has(x.nom));
      }
      etat.stockage[objet] = fichiers.reduce((total, f) => total + (Number(f.taille) || 0), 0);
    }
  }

  // Un épisode par sa clé : parmi les récents, sinon dans l'archive de son mois.
  async trouverEpisode(etat, cle) {
    const recent = (etat.episodes || []).find((ep) => cleEpisode(ep) === cle);
    if (recent) return recent;
    const mois = /^ep:(\d{4}-\d{2})-\d{2}/.exec(String(cle || ""))?.[1];
    if (!mois) return null;
    return ((await this.ctx.storage.get(`archive:${mois}`)) || []).find((ep) => cleEpisode(ep) === cle) || null;
  }

  // Ce que l'application reçoit après une demande libre : le message et les actions
  // faites tout de suite (épisode, recherche, annulation).
  async reponseParler(resultat, relire) {
    const suites = [];
    for (const action of resultat.actions) {
      if (action.type === "nouvel_episode") suites.push((await this.lancerEpisode(action.ids)).ok ? "Nouvel épisode lancé." : "Épisode non lancé (limite du jour).");
      if (action.type === "resultats") {
        const lance = await this.lancerRecherche(action.ids, action.format);
        suites.push(lance.ok ? (lance.format === "point" ? "Podcast lancé : il arrive dans « Recherches » d'ici trois ou quatre minutes." : "Recherche lancée.")
          : `Recherche non lancée (${lance.erreur || "limite du jour"}).`);
      }
      if (action.type === "annuler") { const annule = await this.annulerCoeur(); suites.push(annule ? `Annulé : ${annule}` : "Rien à annuler."); }
    }
    const afficher = resultat.actions.find((a) => a.type === "afficher" || a.type === "assistant");
    await relire();
    return {
      reponse: resultat.reponse || "", entendu: resultat.entendu || "", vocal: Boolean(resultat.vocal),
      changements: resultat.changements, erreurs: resultat.erreurs, suites, a_confirmer: resultat.a_confirmer || [],
      message_compris: messageCompris({ ...resultat, suites }),
      ouvrir: resultat.reglesCreees[0] ? { ecran: "fiche", id: resultat.reglesCreees[0].id }
        : afficher ? { ecran: afficher.type === "assistant" ? "recherche" : afficher.valeur } : null,
    };
  }

  // Une demande de la page : lire l'état, enregistrer une rubrique, un réglage…
  // Répond toujours avec les données à jour, pour que la page se redessine.
  async actionApp(demande) {
    const ctx = this.contexte();
    let config = await this.lireConfig();
    let etat = await this.lireEtat();
    this.modelesLegers = etat.modeles_legers;
    const ancienne = cloner(config);
    const donnees = async () => ({ ...donneesApp(config, etat, ctx, VERSION, await this.liensAudio(etat)), connexions: resumeConnexions(this.cles, etat, this.maintenant()),
      notifications: { cle: (await this.clesVapid()).publique,
        abonnements: (etat.abonnements || []).map((a) => ({ id: a.id, nom: a.nom, cree_le: a.cree_le, erreur: a.erreur || null, fin: a.endpoint.slice(-16),
                                                           appareil: a.appareil || null, coupe: Boolean(a.coupe) })) },
      // Premier lancement : rien de personnel encore réglé.
      bienvenue: !etat.bienvenue_faite && !config.voix.prenom && !config.actus.ville && !config.regles.length,
      flux: this.adresseFlux(etat),
      maj: etat.maj && plusRecente(etat.maj.version, VERSION) ? etat.maj : null,
      maj_etat: etat.maj_etat ? { etat: etat.maj_etat.etat, version: etat.maj_etat.version, message: etat.maj_etat.message || "" } : null,
      maj_modele: etat.maj_modele || null,
      adresse_app: `${etat.adresse || this.env.ADRESSE || ""}/app`,
      appareils: (etat.appareils || []).map((a) => ({ id: a.id, nom: a.nom, cree_le: a.cree_le, vu_le: a.vu_le })),
      code_appareil: etat.code_appareil && etat.code_appareil.expire > Date.now() && etat.code_appareil.essais < 5
        ? { code: etat.code_appareil.code, expire: etat.code_appareil.expire } : null });
    const reponse = async (extra = {}) => ({ ok: true, ...extra, donnees: await donnees() });
    const refus = async (message) => ({ ok: false, erreur: message, donnees: await donnees() });
    const relire = async () => { config = await this.lireConfig(); etat = await this.lireEtat(); };
    let libelle = "";
    let id = null;
    try {
      switch (demande?.action) {
        case "etat":
          return reponse();

        // ── rubriques et déroulé ──
        case "rubrique": {
          const existante = demande.id ? config.regles.find((r) => r.id === demande.id) : null;
          if (demande.id && !existante) return refus("Cette rubrique n'existe plus.");
          // Même chemin que les rubriques demandées à la voix (comprendre.js).
          id = enregistrerRubrique(config, demande.formulaire || {}, existante, ctx.aujourdHui, "application").id;
          libelle = existante ? `${id} modifiée` : `Rubrique ${id} créée`;
          break;
        }
        case "supprimer": {
          const regle = config.regles.find((r) => r.id === demande.id);
          if (!regle) return refus("Cette rubrique n'existe plus.");
          const table = supprimerRegle(config, regle.id);
          this.remapperEtat(etat, table, regle.id);
          libelle = `Rubrique « ${regle.titre} » supprimée`;
          break;
        }
        case "etat_rubrique": {
          const regle = config.regles.find((r) => r.id === demande.id);
          if (!regle) return refus("Cette rubrique n'existe plus.");
          modifierRegle(config, regle.id, { etat: demande.active ? "active" : "pause" }, ctx.aujourdHui);
          // Un seul interrupteur dans « Ton épisode » : son passage suit.
          const passage = config.deroule.find((el) => el.cle === regle.id);
          if (passage) passage.actif = Boolean(demande.active);
          libelle = `${regle.titre} : ${demande.active ? "active" : "en pause"}`;
          break;
        }
        case "deroule": {
          const deroule = nouvelOrdre(config, demande.ordre, demande.actifs);
          if (!deroule) return refus("Le déroulé a changé entre-temps : je l'ai rechargé.");
          config.deroule = deroule;
          libelle = "Déroulé modifié";
          break;
        }

        // ── planning ──
        case "sauter": case "retablir": {
          const date = String(demande.date || "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < ctx.aujourdHui) return refus("Date invalide.");
          config.planning.exceptions = config.planning.exceptions.filter((x) => x.date !== date);
          if (demande.action === "sauter") {
            if (!heurePrevue(config.planning, date)) return refus("Pas d'épisode prévu ce jour-là.");
            config.planning.exceptions.push({ date, heure: null });
            libelle = `Pas d'épisode le ${dateCourte(date)}`;
          } else {
            libelle = `Épisode du ${dateCourte(date)} rétabli`;
          }
          break;
        }
        case "jour": {
          if (!JOURS.includes(demande.jour)) return refus("Jour inconnu.");
          config.planning.jours[demande.jour] = heureValide(demande.heure);
          libelle = `${NOMS_JOURS[demande.jour]} : ${config.planning.jours[demande.jour] ? heureParlee(config.planning.jours[demande.jour]) : "pas d'épisode"}`;
          break;
        }
        case "exception": {
          const date = String(demande.date || "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < ctx.aujourdHui) return refus("Choisis une date à venir.");
          const heure = heureValide(demande.heure);
          config.planning.exceptions = [...config.planning.exceptions.filter((x) => x.date !== date), { date, heure }];
          libelle = `${dateCourte(date)} : ${heure ? heureParlee(heure) : "pas d'épisode"}`;
          break;
        }
        case "retirer_exception":
          config.planning.exceptions = config.planning.exceptions.filter((x) => x.date !== demande.date);
          libelle = "Exception retirée";
          break;
        case "pause": {
          const du = String(demande.du || ""), au = String(demande.au || "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(du) || !/^\d{4}-\d{2}-\d{2}$/.test(au)) return refus("Choisis les deux dates de la pause.");
          if (au < du) return refus("La fin de la pause est avant son début.");
          if (au < ctx.aujourdHui) return refus("Cette pause est déjà passée.");
          config.planning.pauses = [...config.planning.pauses.filter((x) => x.du !== du), { du, au }];
          libelle = `Pause du ${dateCourte(du)} au ${dateCourte(au)}`;
          break;
        }
        case "retirer_pause":
          config.planning.pauses = config.planning.pauses.filter((x) => x.du !== demande.du);
          libelle = "Pause retirée";
          break;

        // ── réglages simples et listes ──
        case "regler":
          if (!REGLAGES_APP.includes(demande.chemin)) return refus("Réglage inconnu.");
          libelle = regler(config, demande.chemin, demande.valeur);
          break;
        // ── voix : chacune est un animateur possible ──
        case "nom_voix": {
          const voix = String(demande.voix || "");
          renommerVoix(config.voix, voix, demande.nom);
          libelle = config.voix.noms[voix] ? `${voix} s'appelle ${config.voix.noms[voix]}` : `${voix} reprend son nom`;
          break;
        }
        case "voix_active":
          libelle = activerVoix(config.voix, String(demande.voix || ""), Boolean(demande.active));
          break;
        case "voix_jour":
          if (!JOURS.includes(demande.jour)) return refus("Jour inconnu.");
          libelle = choisirVoixJour(config.voix, demande.jour, demande.voix);
          break;
        case "feries": {
          libelle = regler(config, "planning.feries_region", demande.region);
          if (!FERIES_CALCULES.includes(config.planning.feries_region)) {
            const annee = Number(ctx.aujourdHui.slice(0, 4));
            try {
              config.planning.feries_cache = {
                [annee]: await telechargerFeries(this.env, config.planning.feries_region, annee),
                [annee + 1]: await telechargerFeries(this.env, config.planning.feries_region, annee + 1),
              };
            } catch (erreur) { return refus(`Jours fériés : ${erreur.message}. Réessaie plus tard.`); }
          } else config.planning.feries_cache = {};
          break;
        }
        case "liste":
          if (!LISTES_APP.includes(demande.chemin) || !Array.isArray(demande.valeurs)) return refus("Liste inconnue.");
          libelle = regler(config, demande.chemin, demande.valeurs);
          break;
        // Une consigne de style rangée dans une rubrique fournie (« elle parle de ton agenda »).
        case "consigne_ranger": {
          const cle = String(demande.rubrique || "");
          const consigne = config.consignes[Number(demande.index)];
          if (!config.consignes_rubriques[cle]) return refus("Rubrique inconnue.");
          if (consigne === undefined) return refus("Cette consigne n'est plus dans la liste.");
          config.consignes.splice(Number(demande.index), 1);
          config.consignes_rubriques[cle] = nettoyerListe([...config.consignes_rubriques[cle], consigne], 20, LONGUEUR_CONSIGNE);
          libelle = `Consigne rangée dans ${nomRubrique(config, cle)}`;
          break;
        }
        case "creuser": {
          const sujet = String(demande.sujet || "").replace(/\s+/g, " ").trim().slice(0, 80);
          if (!sujet) return refus("Écris le sujet à creuser.");
          config.a_approfondir = [...config.a_approfondir.filter((a) => a.sujet !== sujet), { sujet, demande_le: ctx.maintenantIso }].slice(-5);
          libelle = `À creuser au prochain épisode : ${sujet}`;
          break;
        }
        case "retirer_creuser": {
          const [retire] = config.a_approfondir.splice(Number(demande.index), 1);
          if (!retire) return refus("Ce sujet n'est plus dans la liste.");
          libelle = `Retiré : ${retire.sujet}`;
          break;
        }
        // ── Réglages › Sources : services, flux, sites, agendas, données ──
        case "source_coupee": {
          const cle = String(demande.cle || "");
          if (!SOURCES[cle] || RANGEMENT_SOURCES[cle] === "agendas") return refus("Source inconnue.");
          const coupees = new Set(config.sources.coupees);
          if (demande.coupee) coupees.add(cle); else coupees.delete(cle);
          config.sources.coupees = [...coupees];
          libelle = `${SOURCES[cle]} : ${demande.coupee ? "retirée, aucune rubrique ne la lit" : "de nouveau utilisable"}`;
          break;
        }
        case "flux_ajouter": {
          const valeur = String(demande.valeur || demande.url || "").trim().slice(0, 300);
          if (!valeur) return refus("Donne le nom du média ou du site, ou l'adresse de son flux RSS.");
          try {
            libelle = await this.ajouterFlux(config, valeur, Boolean(demande.actualites), { nom: String(demande.nom || "").trim().slice(0, 60), propose: Boolean(demande.propose) });
          } catch (erreur) { return refus(`Désolé, ${erreur.message}`); }
          break;
        }
        case "flux_retirer":
          try { libelle = this.retirerFlux(config, String(demande.id || "")); } catch (erreur) { return refus(erreur.message); }
          break;
        // Les flux que lisent les Actualités globales (cochés dans leur fiche).
        case "actus_flux": {
          const flux = config.sources.flux.find((f) => f.id === demande.id);
          if (!flux) return refus("Ce flux n'est plus dans la liste.");
          const lus = new Set(config.actus.flux_lus);
          if (demande.lu) lus.add(flux.id); else lus.delete(flux.id);
          if (!lus.size) return refus("Garde au moins un flux pour tes Actualités globales.");
          config.actus.flux_lus = config.sources.flux.map((f) => f.id).filter((x) => lus.has(x));
          libelle = `Actualités globales : ${flux.nom} ${demande.lu ? "lu" : "plus lu"}`;
          break;
        }
        case "site_ajouter": {
          const domaine = domaineDe(demande.valeur);
          if (!domaine || !/\./.test(domaine)) return refus("Colle l'adresse du site (par exemple labo.ch ou https://www.labo.ch).");
          if (config.sources.sites.some((x) => x.domaine === domaine)) return refus(`${domaine} est déjà dans tes sites.`);
          if (config.sources.sites.length >= MAX_SITES) return refus(`${MAX_SITES} sites au plus : retires-en un d'abord.`);
          const test = await testerSite(domaine, this.env.SITES_API);
          if (!test.ok) return refus(test.message);
          const id = idCourt(`site:${domaine}`);
          const nom = String(demande.nom || "").trim() || (test.titre || domaine).split(/\s[|–—-]\s/)[0].trim() || domaine;
          config.sources.sites.push({ id, nom: nom.slice(0, 60), domaine });
          this.noterTest(etat, `site:${id}`, test, ctx);
          await this.ecrireEtat(etat);
          libelle = `Site ajouté : ${nom.slice(0, 60)}`;
          break;
        }
        case "site_retirer": {
          const site = config.sources.sites.find((x) => x.id === demande.id);
          if (!site) return refus("Ce site n'est plus dans la liste.");
          config.sources.sites = config.sources.sites.filter((x) => x.id !== site.id);
          for (const r of config.regles) if (r.recherche) r.recherche.sources = r.recherche.sources.filter((x) => x !== `site:${site.id}`);
          libelle = `Site retiré : ${site.nom}`;
          break;
        }
        // Tester un outil : le résultat reste affiché sous l'outil (etat.tests_outils).
        case "outil_tester": {
          const cle = String(demande.cle || "");
          const [type, id] = cle.split(":");
          let test;
          if (type === "service" && RANGEMENT_SOURCES[id] === "services") {
            test = await testerService(this.env, id, { ville: config.actus.ville, profil: profilPays(config), pays: config.pays });
          } else if (type === "flux") {
            const flux = config.sources.flux.find((f) => f.id === id);
            if (!flux) return refus("Ce flux n'est plus dans la liste.");
            test = await testerFlux(flux.url, this.maintenant());
          } else if (type === "site") {
            const site = config.sources.sites.find((x) => x.id === id);
            if (!site) return refus("Ce site n'est plus dans la liste.");
            test = await testerSite(site.domaine, this.env.SITES_API);
          } else if (type === "agenda") {
            const lien = (this.cles.agendas || []).find((a) => a.id === id);
            if (!lien) {
              if (!(etat.agendas || []).some((a) => a.id === id)) return refus("Agenda inconnu : relis la liste.");
              // Agenda du secret GitHub : le bot n'a pas son adresse, GitHub le relit.
              await this.gh.lancer("agendas.yml", {}).catch(() => {});
              return reponse({ message: "Cet agenda vient du secret GitHub : je le fais relire, la liste se met à jour d'ici une minute." });
            }
            test = await lireAgenda(lien.url);
            const prochain = (etat.agenda_apercu || []).find((ev) => ev.agenda === id && ev.debut >= ctx.maintenantIso.slice(0, 16));
            if (test.ok && prochain) test.message += ` Prochain : ${prochain.titre} (${dateCourte(prochain.debut.slice(0, 10))}${prochain.journee ? "" : ` à ${prochain.debut.slice(11, 16).replace(":", "h")}`}).`;
            if (test.ok) etat.agendas = (etat.agendas || []).map((a) => a.id === id ? { ...a, nom: test.nom || a.nom, nb: test.nb } : a);
          } else return refus("Outil inconnu.");
          this.noterTest(etat, cle, test, ctx);
          await this.ecrireEtat(etat);
          return test.ok ? reponse({ message: test.message }) : refus(test.message);
        }
        case "agenda": {
          const connus = new Set((etat.agendas || []).map((x) => x.id));
          if (!connus.has(demande.id)) return refus("Agenda inconnu : relis la liste.");
          const exclus = new Set(config.agenda.exclus);
          if (demande.lu) exclus.delete(demande.id); else exclus.add(demande.id);
          if (exclus.size >= connus.size) return refus("Garde au moins un agenda.");
          config.agenda.exclus = [...exclus];
          libelle = `Agenda « ${etat.agendas.find((x) => x.id === demande.id)?.nom || demande.id} » ${demande.lu ? "lu" : "ignoré"}`;
          break;
        }
        // ── connexions : clés et agendas ──
        case "cle": {
          const nom = String(demande.nom || "");
          if (!CLES[nom]) return refus("Clé inconnue.");
          const valeur = String(demande.valeur || "").trim();
          const cles = { ...this.cles };
          etat.tests_cles = { ...(etat.tests_cles || {}) };
          if (!valeur) {
            delete cles[nom]; delete cles[`${nom}_teste`];
            delete etat.tests_cles[nom];
            await this.ecrireCles(cles);
            await this.ecrireEtat(etat);
            return reponse({ message: `Clé ${CLES[nom].nom} retirée de l'application.` });
          }
          if (/\s/.test(valeur) || valeur.length > 300) return refus("Colle seulement la clé, sans espace ni retour à la ligne.");
          const test = await testerCle(this.env, nom, valeur);
          if (!test.ok) return refus(test.message);
          cles[nom] = valeur;
          cles[`${nom}_teste`] = ctx.maintenantIso;
          etat.tests_cles[nom] = { ok: true, message: test.message, quand: ctx.maintenantIso, quand_ms: this.maintenant(), ou: "app" };
          await this.ecrireCles(cles);
          await this.ecrireEtat(etat);
          return reponse({ message: `${test.message} Clé enregistrée.` });
        }
        // Tester une clé déjà enregistrée, sans la recoller. Dans l'application : le bot la
        // teste tout de suite. Dans GitHub : le bot ne la voit pas, une courte exécution
        // GitHub (tester-cles.yml) la teste et renvoie le résultat (événement « cles »).
        case "cle_tester": {
          const nom = String(demande.nom || "");
          if (!CLES[nom]) return refus("Clé inconnue.");
          etat.tests_cles = { ...(etat.tests_cles || {}) };
          if (this.cles[nom]) {
            const test = await testerCle(this.env, nom, this.cles[nom]);
            etat.tests_cles[nom] = { ok: test.ok, message: test.message, quand: ctx.maintenantIso, quand_ms: this.maintenant(), ou: "app" };
            if (test.ok) await this.ecrireCles({ ...this.cles, [`${nom}_teste`]: ctx.maintenantIso });
            await this.ecrireEtat(etat);
            return test.ok ? reponse({ message: test.message }) : refus(test.message);
          }
          if (Array.isArray(etat.secrets_github) && !etat.secrets_github.includes(CLES[nom].variable)) {
            return refus(`Aucune clé ${CLES[nom].nom} à tester : colle-la d'abord dans le champ.`);
          }
          try { await this.gh.lancer("tester-cles.yml", { cles: nom }); } catch (erreur) {
            return refus(`Le test ne peut pas partir sur GitHub (${erreur.message}). Lance « Mettre à jour » si la version de ton dépôt est ancienne.`);
          }
          etat.tests_cles[nom] = { ...(etat.tests_cles[nom] || {}), en_cours: true, lance_ms: this.maintenant() };
          await this.ecrireEtat(etat);
          return reponse({ message: `Ta clé ${CLES[nom].nom} est dans GitHub : test lancé là-bas, résultat dans une minute environ.`, attendre_test: true });
        }
        case "agenda_ajouter": {
          const url = String(demande.url || "").trim();
          const lu = await lireAgenda(url);
          if (!lu.ok) return refus(lu.message);
          const id = await identifiantAgenda(url);
          const agendas = (this.cles.agendas || []).filter((a) => a.id !== id);
          if (agendas.length >= 8) return refus("Huit agendas au plus.");
          await this.ecrireCles({ ...this.cles, agendas: [...agendas, { id, url, nom: lu.nom, nb: lu.nb, ajoute_le: ctx.maintenantIso }] });
          if (!(etat.agendas || []).some((a) => a.id === id)) {
            etat.agendas = [...(etat.agendas || []), { id, nom: lu.nom, nb: lu.nb }];
            await this.ecrireEtat(etat);
          }
          await this.gh.lancer("agendas.yml", {}).catch(() => {});
          return reponse({ message: `${lu.message} Il servira dès le prochain épisode.` });
        }
        case "appareil_code": {
          const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
          etat.code_appareil = { code, expire: Date.now() + 10 * 60 * 1000, essais: 0 };
          await this.ecrireEtat(etat);
          return reponse({ message: "Code valable 10 minutes." });
        }
        case "appareil_retirer": {
          const cible = (etat.appareils || []).find((a) => a.id === demande.id);
          if (!cible) return refus("Appareil inconnu.");
          etat.appareils = etat.appareils.filter((a) => a !== cible);
          etat.abonnements = (etat.abonnements || []).filter((a) => a.appareil !== demande.id);   // ses notifications aussi
          await this.ecrireEtat(etat);
          return reponse({ message: "Appareil retiré : il devra entrer un nouveau code." });
        }
        // ── notifications ──
        case "notif_abonner": {
          const abonnement = abonnementValide(demande.abonnement, this.env.MODE_TEST === "1");
          if (!abonnement) return refus("Abonnement aux notifications illisible.");
          const nom = String(demande.nom || "Navigateur").slice(0, 40);
          const ancien = (etat.abonnements || []).find((a) => a.endpoint === abonnement.endpoint);
          const fiche = { id: ancien?.id || nouveauJeton().slice(0, 12), ...abonnement, nom, appareil: demande._appareil || ancien?.appareil || null,
                          cree_le: ancien?.cree_le || ctx.maintenantIso, erreur: null, coupe: Boolean(ancien?.coupe) && !demande.activer };
          etat.abonnements = [...(etat.abonnements || []).filter((a) => a.endpoint !== abonnement.endpoint), fiche].slice(-10);
          if (!ancien) {
            const bilan = await this.notifier(etat, { titre: "🔔 Notifications activées", corps: "Tu seras prévenu ici à chaque nouvel épisode.", url: "/app", tag: "essai" }, [fiche]);
            await this.ecrireEtat(etat);
            if (!bilan.remis) return refus("Le service de notifications de ce navigateur refuse l'abonnement : réessaie plus tard.");
            return reponse({ message: "Notifications activées sur cet appareil." });
          }
          await this.ecrireEtat(etat);
          return reponse({ message: "Notifications déjà actives sur cet appareil." });
        }
        case "notif_retirer": {
          const avant = (etat.abonnements || []).length;
          etat.abonnements = (etat.abonnements || []).filter((a) => a.id !== demande.id && a.endpoint !== demande.endpoint);
          if (etat.abonnements.length === avant) return refus("Ces notifications étaient déjà coupées.");
          await this.ecrireEtat(etat);
          return reponse({ message: "Notifications coupées pour cet appareil." });
        }
        // Interrupteur d'un appareil : ses notifications coupées ou remises (l'abonnement du navigateur reste).
        case "notif_couper": {
          const fiche = (etat.abonnements || []).find((a) => a.id === demande.id);
          if (!fiche) return refus("Cet appareil ne reçoit plus de notifications : active-les depuis lui.");
          fiche.coupe = Boolean(demande.coupe);
          await this.ecrireEtat(etat);
          return reponse({ message: fiche.coupe ? `Notifications coupées sur ${fiche.nom}.` : `Notifications remises sur ${fiche.nom}.` });
        }
        case "notif_tester": {
          if (!(etat.abonnements || []).some((a) => !a.coupe)) return refus("Aucun appareil ne reçoit les notifications : active-les d'abord sur ton téléphone.");
          const bilan = await this.notifier(etat, { titre: "🔔 Essai", corps: "Les notifications du podcast arrivent bien ici.", url: "/app", tag: "essai" });
          await this.ecrireEtat(etat);
          return bilan.remis ? reponse({ message: `Essai envoyé à ${bilan.remis} appareil${bilan.remis > 1 ? "s" : ""}.` })
            : refus("L'essai n'est arrivé nulle part : réactive les notifications sur ton téléphone.");
        }
        case "verifier_maj":
          await this.verifierMaj(etat);
          etat.maj_verifie = ctx.aujourdHui;
          await this.ecrireEtat(etat);
          return reponse({ message: etat.maj_modele === "prive" ? "Le modèle n'est pas public : pas de mise à jour possible pour l'instant."
            : etat.maj_modele !== "ok" ? "Le modèle ne répond pas : réessaie plus tard."
            : etat.maj && plusRecente(etat.maj.version, VERSION) ? `Version ${etat.maj.version} disponible.` : "Tu as la dernière version." });
        case "mettre_a_jour": {
          if (!etat.maj || !plusRecente(etat.maj.version, VERSION)) return refus("Pas de nouvelle version pour l'instant.");
          if (etat.maj_etat?.etat === "en_cours" && Date.now() - etat.maj_etat.depuis < 15 * 60 * 1000) return refus("Une mise à jour est déjà en cours.");
          await this.sauvegarder(config).catch(() => {});   // réglages en lieu sûr d'abord
          try {
            await this.gh.lancer("mettre-a-jour.yml", { version: etat.maj.version, modele: this.env.MODELE, adresse: etat.adresse || this.env.ADRESSE || "" });
          } catch (erreur) {
            return refus("GitHub refuse de lancer « Mettre à jour » : ce dépôt n'a peut-être pas encore ce workflow (voir docs/MISE-A-JOUR.md).");
          }
          etat.maj_etat = { etat: "en_cours", depuis: Date.now(), version: etat.maj.version };
          await this.ecrireEtat(etat);
          return reponse({ message: "Mise à jour lancée : compte deux à trois minutes, puis rouvre l'application." });
        }
        case "flux": {
          if (!etat.flux_jeton || demande.renouveler) etat.flux_jeton = nouveauJeton();
          await this.ecrireEtat(etat);
          return reponse({ message: demande.renouveler ? "Nouvelle adresse : l'ancienne ne marche plus." : "Ton flux privé est prêt." });
        }
        case "bienvenue_fin":
          etat.bienvenue_faite = ctx.maintenantIso;
          await this.ecrireEtat(etat);
          return reponse();
        case "agenda_remettre": {
          if (!(config.agenda.retires || []).includes(demande.id)) return refus("Cet agenda n'est pas dans les retirés.");
          config.agenda.retires = config.agenda.retires.filter((x) => x !== demande.id);
          config.agenda.exclus = config.agenda.exclus.filter((x) => x !== demande.id);
          libelle = `Agenda « ${etat.agendas?.find((x) => x.id === demande.id)?.nom || demande.id} » remis`;
          break;
        }
        case "agenda_retirer": {
          const avant = this.cles.agendas || [];
          const agendas = avant.filter((a) => a.id !== demande.id);
          if (agendas.length === avant.length) {
            // Agenda du secret GitHub (CALENDAR_ICS_URL) : le bot ne peut pas modifier ce secret, il cesse de le lire
            // et le range dans les « retirés », d'où on peut le remettre.
            const connu = (etat.agendas || []).find((x) => x.id === demande.id);
            if (!connu) return refus("Agenda inconnu : relis la liste.");
            config.agenda.retires = [...new Set([...(config.agenda.retires || []), demande.id])];
            config.agenda.exclus = [...new Set([...config.agenda.exclus, demande.id])];
            libelle = `Agenda « ${connu.nom} » retiré (il reste dans le secret GitHub, mais n'est plus lu)`;
            break;
          }
          await this.ecrireCles({ ...this.cles, agendas });
          // Les rubriques qui ne lisaient que lui ne le gardent pas.
          for (const r of config.regles) if (r.recherche) r.recherche.sources = r.recherche.sources.filter((x) => x !== `agenda:${demande.id}`);
          if (JSON.stringify(config) !== JSON.stringify(ancienne)) await this.enregistrer(config, etat, ancienne, "Agenda retiré");
          etat.agendas = (etat.agendas || []).filter((a) => a.id !== demande.id);
          etat.agenda_apercu = (etat.agenda_apercu || []).filter((x) => x.agenda !== demande.id);
          await this.ecrireEtat(etat);
          return reponse({ message: "Agenda retiré." });
        }
        case "lire_agendas":
          await this.gh.lancer("agendas.yml", {});
          return reponse({ message: "Je relis tes agendas : la liste se met à jour d'ici une minute." });
        case "extraits": {
          // Une voix est prête quand son extrait existe et qu'on sait où elle commence et finit.
          const connues = new Set(VOIX.map(([nom]) => nom));
          const demandees = Array.isArray(demande.voix) && demande.voix.length ? demande.voix.filter((v) => connues.has(v)) : VOIX_CONSEILLEES;
          const manquants = demandees.filter((v) => !etat.echantillons_fichiers?.[v] || !etat.temps_echantillons?.[v]).slice(0, 8);
          if (!manquants.length) return reponse({ message: "Ces extraits sont déjà prêts." });
          // Quota gratuit de la voix : 16 extraits par jour au plus.
          const deja = etat.extraits_jour?.date === ctx.aujourdHui ? etat.extraits_jour.nombre : 0;
          if (deja + manquants.length > 16) return refus(`Déjà ${deja} extraits aujourd'hui : la limite est de 16 par jour (quota gratuit de la voix). Ça repart demain.`);
          await this.gh.lancer("echantillons.yml", { voix: manquants.join(",") });
          etat.extraits_jour = { date: ctx.aujourdHui, nombre: deja + manquants.length };
          await this.ecrireEtat(etat);
          return reponse({ message: `Je prépare ${manquants.length > 1 ? `${manquants.length} extraits` : `l'extrait de ${manquants[0]}`} : deux à trois minutes.` });
        }

        // ── épisodes ──
        case "generer": {
          const ids = demande.id && config.regles.some((r) => r.id === demande.id) ? [demande.id] : [];
          const lance = await this.lancerEpisode(ids);
          if (!lance.ok) return refus(lance.erreur);
          return reponse({ message: "C'est lancé : le nouvel épisode arrive d'ici trois ou quatre minutes." });
        }
        case "geste": {
          const episode = (etat.episodes || []).find((ep) => cleEpisode(ep) === demande.cle);
          if (!episode) return refus("Épisode introuvable.");
          const geste = String(demande.geste || "");
          const vitesse = (sens) => {
            const i = VITESSES.indexOf(config.voix.vitesse) + sens;
            return regler(config, "voix.vitesse", VITESSES[Math.max(0, Math.min(VITESSES.length - 1, i))]);
          };
          if (geste === "court") libelle = regler(config, "format.duree_minutes", Math.max(2, config.format.duree_minutes - 1));
          else if (geste === "long") libelle = regler(config, "format.duree_minutes", Math.min(12, config.format.duree_minutes + 1));
          else if (geste === "lent") libelle = vitesse(-1);
          else if (geste === "vite") libelle = vitesse(1);
          else if (/^cr[1-5]$/.test(geste)) {
            const sujet = episode.sujets?.[Number(geste.slice(2)) - 1];
            if (!sujet) return refus("Sujet inconnu.");
            config.a_approfondir = [...config.a_approfondir.filter((a) => a.sujet !== sujet), { sujet, demande_le: ctx.maintenantIso }].slice(-5);
            libelle = `À creuser au prochain épisode : ${sujet}`;
          } else return refus("Geste inconnu.");
          episode.coches = [...new Set([...(episode.coches || []), geste])];
          break;
        }
        case "episodes_mois": {
          // Un mois de l'archive (au-delà des épisodes récents), pour le calendrier des épisodes.
          const mois = String(demande.mois || "");
          if (!/^\d{4}-\d{2}$/.test(mois) || !(etat.archives || []).includes(mois)) return refus("Pas d'épisodes gardés pour ce mois.");
          const liste = (await this.ctx.storage.get(`archive:${mois}`)) || [];
          const liens = await this.liensAudio(etat, liste);
          return reponse({ mois_episodes: { mois, episodes: liste.slice().reverse().map((ep) => ({ ...episodeApp(ep, liens), archive: true })) } });
        }
        case "rubrique_resume": {
          const id = String(demande.id || "");
          const entrees = await this.historiqueRubrique(id);
          const secret = await secretPartage(this.env);
          const resume = etat.resumes?.[id];
          const lien = resume?.audio ? await lienAudio(secret, `resume:${id}`, Math.max(this.maintenant(), Date.now())) : null;
          return reponse({ rubrique: {
            id, entrees: entrees.slice().reverse().map((x) => ({ date: x.date, titre: x.titre, texte: x.texte, sources: x.sources || [] })),
            resume: lien ? { cle: `resume:${id}`, titre: resume.titre || "Synthèse de la rubrique", audio: lien, duree: resume.duree,
                             date: String(resume.quand || "").slice(0, 10), texte: "", chapitres: [], sujets: [], coches: [], sources: [], image: null } : null } });
        }
        case "resume_podcast": {
          const id = String(demande.id || "");
          if (!(await this.historiqueRubrique(id)).length) return refus("Cette rubrique n'a encore rien gardé : elle doit d'abord passer dans un épisode.");
          const compte = etat.refaits?.date === ctx.aujourdHui ? etat.refaits.nombre : 0;
          if (compte >= MAX_REFAITS) return refus("Plus de mini-podcast aujourd'hui (quota gratuit de la voix). Réessaie demain.");
          try { await this.gh.lancer("recherche.yml", { regles: id, format: "resume" }); } catch (erreur) { return refus(erreur.message); }
          etat.refaits = { date: ctx.aujourdHui, nombre: compte + 1 };
          await this.ecrireEtat(etat);
          return reponse({ message: "Je prépare la synthèse : elle arrive d'ici trois ou quatre minutes." });
        }
        case "texte": {
          const episode = await this.trouverEpisode(etat, String(demande.cle || ""));
          const texte = episode ? await this.texteEpisode(episode) : "";
          if (!texte) return refus("Pas de texte pour cet épisode.");
          return reponse({ texte });
        }

        // ── recherche, demande libre, annulation ──
        case "recherche": {
          if (!config.regles.some((r) => r.id === demande.id) && !RUBRIQUES_A_CHERCHER.includes(demande.id)) return refus("Cette rubrique n'existe plus.");
          // Sans format demandé, une recherche ponctuelle suit ce qu'elle a choisi (écrit ou mini-podcast).
          const enAudio = demande.format === "audio" || (!demande.format && Boolean(config.regles.find((r) => r.id === demande.id)?.recherche?.audio));
          const lance = await this.lancerRecherche([demande.id], enAudio ? "audio" : "ecrit");
          if (!lance.ok) return refus(lance.erreur);
          return reponse({ message: lance.format === "point" ? "Je fais le point : le podcast arrive ici d'ici trois ou quatre minutes."
            : enAudio
            ? "Je prépare le mini-podcast : il arrive d'ici trois ou quatre minutes."
            : "Je cherche : les résultats arrivent ici d'ici une à deux minutes." });
        }
        case "parler": {
          const texte = String(demande.texte || "").trim().slice(0, 2000);
          const audio = typeof demande.audio === "string" && /^[A-Za-z0-9+/=]+$/.test(demande.audio) && demande.audio.length < 4_000_000
            ? { type: "audio", data: demande.audio, mime_type: "audio/wav" } : null;
          if (!texte && !audio) return refus("Écris ou dis ta demande.");
          const resultat = await this.comprendreCoeur(texte, audio);
          if (!resultat) return refus("Gemini ne répond pas pour le moment. Réessaie dans une minute.");
          return reponse(await this.reponseParler(resultat, relire));
        }
        // Réponse à « À confirmer » (changement lourd demandé en parlant ou en écrivant).
        case "parler_confirmer":
        case "parler_abandonner": {
          const resultat = await this.repondreConfirmation(demande.action === "parler_confirmer");
          if (!resultat) { await relire(); return refus("Cette demande n'est plus en attente : redis-la si besoin."); }
          if (resultat.abandon) { await relire(); return reponse({ message: "D'accord, je n'ai rien changé.", abandon: true }); }
          return reponse(await this.reponseParler(resultat, relire));
        }
        case "annuler": {
          const annule = await this.annulerCoeur();
          if (!annule) return refus("Rien à annuler.");
          await relire();
          return reponse({ message: `Annulé : ${annule}` });
        }
        default:
          return refus("Demande inconnue.");
      }
    } catch (erreur) {
      return refus(erreur.message.charAt(0).toUpperCase() + erreur.message.slice(1));
    }
    nettoyerPlanning(config.planning, ctx.aujourdHui);
    await this.enregistrer(config, etat, ancienne, libelle);
    return reponse({ id, message: libelle });
  }

  // ─────────────────────────────── appareils ──────────────────────────────────
  // Un code à 6 chiffres (10 minutes, 5 essais), affiché dans l'application ouverte
  // sur un autre appareil (ou donné par GitHub), donne à l'appareil son propre jeton, révocable.

  async connecterAppareil(corps) {
    const etat = await this.lireEtat();
    const code = String(corps.code || "").replace(/\D/g, "");
    const attendu = etat.code_appareil;
    if (!attendu || attendu.expire < Date.now() || attendu.essais >= 5) {
      return { ok: false, erreur: "Pas de code valable : demandes-en un nouveau dans l'application déjà ouverte (Réglages › Application), ou sur GitHub (onglet Actions › Code de connexion)." };
    }
    if (code !== attendu.code) {
      attendu.essais = (attendu.essais || 0) + 1;
      await this.ecrireEtat(etat);
      return { ok: false, erreur: attendu.essais >= 5 ? "Trop d'essais : affiche un nouveau code." : "Code incorrect." };
    }
    const jeton = [...crypto.getRandomValues(new Uint8Array(32))].map((o) => o.toString(16).padStart(2, "0")).join("");
    const ctx = this.contexte();
    const appareil = { id: jeton.slice(0, 8), nom: String(corps.nom || "Appareil").replace(/[<>]/g, "").slice(0, 40),
                       empreinte: await empreinte(`appareil:${jeton}`, 64), cree_le: ctx.maintenantIso, vu_le: ctx.maintenantIso };
    etat.appareils = limiterAppareils([...(etat.appareils || []), appareil]);
    etat.code_appareil = null;
    await this.ecrireEtat(etat);
    return { ok: true, jeton };
  }

  async verifierAppareil(empreinteRecue) {
    const etat = await this.lireEtat();
    const appareil = empreinteRecue && (etat.appareils || []).find((a) => a.empreinte === empreinteRecue);
    if (!appareil) return { ok: false };
    const ctx = this.contexte();
    if (String(appareil.vu_le || "").slice(0, 10) !== ctx.aujourdHui) {
      appareil.vu_le = ctx.maintenantIso;
      await this.ecrireEtat(etat);
    }
    return { ok: true, id: appareil.id };
  }

  // ───────────────────────── mises à jour du code ─────────────────────────────
  // Le modèle (dépôt public MODELE) publie version.json ; le bouton « Mettre à jour »
  // lance le workflow qui recopie le code dans ton dépôt, sans tes fichiers à toi.

  async verifierMaj(etat) {
    const modele = this.env.MODELE;
    if (!modele) return;
    try {
      const r = await fetch(`${this.env.MODELE_BRUT || "https://raw.githubusercontent.com"}/${modele}/main/version.json`, { headers: { "Cache-Control": "no-cache" } });
      if (!r.ok) { etat.maj_modele = r.status === 404 ? "prive" : "injoignable"; return; }
      const v = await r.json();
      etat.maj_modele = "ok";
      etat.maj = plusRecente(v.version, VERSION) ? { version: String(v.version).slice(0, 20), titre: String(v.titre || "").slice(0, 120),
        nouveautes: (Array.isArray(v.nouveautes) ? v.nouveautes : []).slice(0, 8).map((x) => String(x).slice(0, 300)), date: String(v.date || "").slice(0, 10) } : null;
    } catch {
      etat.maj_modele = "injoignable";
    }
  }

  // ───────────────────────── flux privé du podcast ────────────────────────────

  adresseFlux(etat) {
    const adresse = etat.adresse || this.env.ADRESSE;
    return etat.flux_jeton && adresse ? `${adresse}/flux/${etat.flux_jeton}.xml` : null;
  }

  async servirFlux(parametres) {
    const etat = await this.lireEtat();
    const jeton = parametres.get("jeton") || "";
    let egal = Boolean(etat.flux_jeton) && jetonValide(jeton) && jeton.length === etat.flux_jeton.length;
    for (let i = 0; egal && i < jeton.length; i++) if (jeton[i] !== etat.flux_jeton[i]) egal = false;
    if (!egal) return new Response("introuvable", { status: 404 });
    const quoi = parametres.get("quoi");
    if (quoi === "xml") {
      const config = await this.lireConfig();
      const base = `${etat.adresse || this.env.ADRESSE}/flux/${jeton}`;
      const episodes = (etat.episodes || []).map((ep) => ({ ...ep, instant: instantLocal(ep.date, ep.heure || "07:00") }));
      const titre = config.voix.prenom ? `Le podcast du matin de ${config.voix.prenom}` : "Mon podcast du matin";
      const auteur = config.voix.animateurs.map((a) => a.nom).join(" & ") || "Podcast Matin";
      return new Response(fluxRss({ episodes, base, titre, auteur, langue: profilPays(config).actus_langue }),
        { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "private, max-age=300" } });
    }
    const episode = episodeDeCle(etat.episodes, parametres.get("cle"));
    if (!episode) return new Response("introuvable", { status: 404 });
    if (quoi === "chapitres") return Response.json(chapitresJson(episode), { headers: { "Content-Type": "application/json+chapters" } });
    return Response.json({ fichier: (quoi === "image" ? episode.pochette : episode.audio) || null });
  }

  // ─────────────────────────── API pour GitHub ───────────────────────────────

  async exporterConfig() {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    // GitHub reçoit les animateurs du jour (selon le jour, tirage, une seule voix).
    config.voix = { ...config.voix, animateurs: animateursDuJour(config, ctx.aujourdHui) };
    return {
      format: "bot-v2", version: VERSION, config, aujourdhui: ctx.aujourdHui,
      heure_prevue_aujourdhui: heurePrevue(config.planning, ctx.aujourdHui),
      prochain: prochainEpisode(config.planning, ctx.maintenant),
      flux_defaut: profilPays(config).flux,
      episode_envoye_aujourdhui: Boolean(etat.declenchements[ctx.aujourdHui]?.envoye),
      episode_lance_aujourdhui: Boolean(etat.declenchements[ctx.aujourdHui]?.lance),
      agendas: etat.agendas || [],
      // Clés et agendas saisis dans l'application (GitHub les masque dans son journal).
      cles: Object.fromEntries(Object.keys(CLES).filter((nom) => this.cles?.[nom]).map((nom) => [nom, this.cles[nom]])),
      agendas_urls: (this.cles?.agendas || []).map((a) => a.url),
      derniers_resultats: etat.derniers_resultats || null,
      app: this.adresseApp(etat),
    };
  }

  async recevoirEvenement(ev) {
    const ctx = this.contexte();
    const etat = await this.lireEtat();
    if (ev.type === "episode") {
      const episode = {
        date: ev.date || ctx.aujourdHui, titre: ev.titre || "", sujets: ev.sujets || [],
        texte: Boolean(ev.transcription), chapitres: ev.chapitres || [], regles: ev.regles || [],
        nombre_sujets: ev.nombre_sujets ?? (ev.sujets || []).length, coches: [], mode: ev.mode || "",
        details: (ev.details || []).slice(0, 2), duree: ev.duree || null,
        heure: /^\d{2}:\d{2}$/.test(ev.heure || "") ? ev.heure : null, taille: Number(ev.taille) || null,
        sources: nettoyerSources(ev.sources),
        // Fichiers gardés par le bot.
        audio: fichierRecu(ev.audio, ".mp3"), pochette: fichierRecu(ev.pochette, ".jpg"),
        // L'heure d'envoi (HHMMSS) distingue les épisodes d'un même jour.
        ref: Number.isInteger(Number(ev.ref)) && Number(ev.ref) > 0 && Number(ev.ref) < 240000 ? Number(ev.ref) : null,
      };
      if (ev.transcription) await this.ctx.storage.put(`texte:${cleEpisode(episode)}`, String(ev.transcription).slice(0, 20000));
      await this.retenirRubriques(episode, ev.rubriques);
      const meme = (x) => x.date === episode.date && (x.message_id || x.ref || null) === (episode.ref || null);
      const tous = [...etat.episodes.filter((x) => !meme(x)), episode];
      etat.episodes = tous.slice(-MAX_EPISODES);
      await this.archiver(etat, tous.slice(0, -MAX_EPISODES));
      if (ev.mode !== "manuel") etat.declenchements[episode.date] = { ...(etat.declenchements[episode.date] || {}), envoye: true };
      // Un nouvel épisode efface les tests de clés réussis (l'encart vert) : la clé a fait ses preuves.
      if (etat.tests_cles) etat.tests_cles = Object.fromEntries(Object.entries(etat.tests_cles).filter(([, t]) => !t?.ok || t.en_cours));
      const config = await this.lireConfig();
      for (const id of ev.regles || []) {
        const regle = config.regles.find((r) => r.id === id);
        if (regle) {
          regle.derniere_application = episode.date;
          if (regle.periode.type === "une_fois") regle.servie = true;
        }
      }
      config.a_approfondir = config.a_approfondir.filter((a) => String(a.demande_le || "") > String(ev.debut || ctx.maintenantIso));
      await this.ctx.storage.put("config", config);
      await this.ecrireEtat(etat);
      await this.planifierReveil(config, etat).catch(() => {});
      const duree = episode.duree ? ` · ${Math.max(1, Math.round(episode.duree / 60))} min` : "";
      await this.notifier(etat, { titre: ev.mode === "manuel" ? "🎙️ Ton épisode est prêt" : "🎙️ Ton podcast du matin est prêt",
        corps: `${episode.titre || "Nouvel épisode"}${duree}`, url: `/app?ep=${encodeURIComponent(cleEpisode(episode))}`, tag: `ep-${episode.date}` });
      return { ok: true };
    }
    if (ev.type === "echec") {
      // L'épisode n'a pas pu être préparé (GitHub) : prévenir par notification.
      await this.notifier(etat, { titre: String(ev.titre || "Podcast du matin").slice(0, 80),
        corps: String(ev.message || "").slice(0, 200), url: "/app", tag: "echec" });
      return { ok: true };
    }
    if (ev.type === "modeles") {
      const legers = (ev.rapides || []).filter((m) => typeof m === "string" && /^gemini-[\d.]+-flash-lite/.test(m)).slice(0, 3);
      if (legers.length) etat.modeles_legers = legers;
      await this.ecrireEtat(etat);
      return { ok: true };
    }
    if (ev.type === "maj") {
      etat.maj_etat = { etat: ev.ok ? "fait" : "erreur", depuis: Date.now(), version: String(ev.version || "").slice(0, 20),
                        message: String(ev.message || "").slice(0, 300) };
      await this.ecrireEtat(etat);
      return { ok: true };
    }
    if (ev.type === "cles") {
      // Résultat de tester-cles.yml : les clés rangées dans GitHub, testées là-bas (jamais leurs valeurs).
      etat.tests_cles = { ...(etat.tests_cles || {}) };
      for (const [nom, r] of Object.entries(ev.resultats || {})) {
        if (!CLES[nom] || !r || typeof r !== "object") continue;
        etat.tests_cles[nom] = { ok: Boolean(r.ok), message: String(r.message || "").slice(0, 300), quand: ctx.maintenantIso, quand_ms: this.maintenant(), ou: "github" };
      }
      await this.ecrireEtat(etat);
      return { ok: true };
    }
    if (ev.type === "secrets") {
      // Noms des secrets GitHub renseignés (jamais leurs valeurs) : pour l'écran Connexions.
      etat.secrets_github = (Array.isArray(ev.presents) ? ev.presents : []).filter((n) => /^[A-Z_]{3,40}$/.test(n)).slice(0, 10);
      etat.secrets_vus = ctx.maintenantIso;
      await this.ecrireEtat(etat);
      return { ok: true };
    }
    if (ev.type === "agendas") {
      const liste = (ev.liste || []).filter((x) => x && /^[0-9a-f]{6,16}$/.test(x.id)).slice(0, 12)
        .map((x) => ({ id: x.id, nom: String(x.nom || "Agenda").slice(0, 60), nb: Number(x.nb) || 0 }));
      etat.agendas = liste;
      etat.agendas_vus = ctx.maintenantIso;
      if (Array.isArray(ev.evenements)) {
        etat.agenda_apercu = ev.evenements.slice(0, 120).filter((x) => x && /^[0-9a-f]{6,16}$/.test(x.agenda) && /^\d{4}-\d{2}-\d{2}/.test(x.debut || ""))
          .map((x) => ({ agenda: x.agenda, titre: String(x.titre || "").slice(0, 80), debut: String(x.debut).slice(0, 25),
                         fin: x.fin ? String(x.fin).slice(0, 25) : null, journee: Boolean(x.journee), lieu: String(x.lieu || "").slice(0, 60) }));
      }
      await this.ecrireEtat(etat);
      return { ok: true };
    }
    if (ev.type === "echantillon" && /^[A-Za-z]{2,20}$/.test(ev.voix || "") && ev.fichier) {
      const fichier = fichierRecu(ev.fichier, ".mp3");
      if (fichier && objetDuNom(fichier) === "voix") {
        etat.echantillons_fichiers = { ...(etat.echantillons_fichiers || {}), [ev.voix]: fichier };
      }
      const debut = Number(ev.debut), fin = Number(ev.fin);
      if (Number.isFinite(debut) && Number.isFinite(fin) && fin > debut) {
        etat.temps_echantillons = { ...(etat.temps_echantillons || {}), [ev.voix]: [debut, fin] };
      }
      await this.ecrireEtat(etat);
      return { ok: true };
    }
    if (ev.type === "resume") {
      const id = String(ev.rubrique || "");
      if (!/^[A-Za-z0-9_]{1,24}$/.test(id)) return { ok: false, erreur: "rubrique inconnue" };
      etat.resumes = { ...(etat.resumes || {}), [id]: { audio: fichierRecu(ev.audio, ".mp3"), titre: String(ev.titre || "").slice(0, 120),
                                                         duree: Number(ev.duree) || null, quand: ctx.maintenantIso } };
      await this.ecrireEtat(etat);
      await this.notifier(etat, { titre: "🎧 Ta synthèse est prête", corps: String(ev.titre || "").slice(0, 200), url: `/app?rubrique=${encodeURIComponent(id)}`, tag: `resume-${id}` });
      return { ok: true };
    }
    if (ev.type === "recherche") {
      const config = await this.lireConfig();
      for (const id of ev.regles || []) {
        const regle = config.regles.find((r) => r.id === id);
        if (regle) regle.derniere_application = ctx.aujourdHui;
      }
      await this.ctx.storage.put("config", config);
      etat.derniers_resultats = { regles: ev.regles || [], idees: (ev.idees || []).slice(0, 10), quand: ctx.maintenantIso,
                                  format: ev.format === "point" ? "point" : ev.format === "audio" ? "audio" : "ecrit",
                                  details: nettoyerResultats(ev.resultats),
                                  // Mini-podcast gardé par le bot (écoute dans l'application).
                                  audio: fichierRecu(ev.audio, ".mp3"), titre_audio: String(ev.titre_audio || "").slice(0, 120), duree_audio: Number(ev.duree) || null };
      await this.ecrireEtat(etat);
      const nombre = etat.derniers_resultats.idees.length;
      if (ev.format === "point") {
        await this.notifier(etat, { titre: "🎧 Ton podcast est prêt", corps: String(ev.titre_audio || "").slice(0, 200), url: "/app?ecran=resultats", tag: "idees" });
      } else if (nombre) {
        await this.notifier(etat, { titre: ev.format === "audio" ? "🎧 Ton mini-podcast d'idées est prêt" : "💡 Tes idées sont prêtes",
          corps: etat.derniers_resultats.idees.slice(0, 3).join(" · ").slice(0, 200), url: "/app?ecran=resultats", tag: "idees" });
      }
      return { ok: true };
    }
    return { ok: false, erreur: "événement inconnu" };
  }

  // Après une suppression, les numéros R… changent : on met à jour les références gardées dans l'état.
  remapperEtat(etat, table, supprimee) {
    const nouveau = (id) => (id === supprimee ? null : table[id] || id);
    for (const episode of etat.episodes || []) {
      episode.regles = (episode.regles || []).map(nouveau).filter(Boolean);
      episode.details = (episode.details || []).map(nouveau).filter(Boolean);
    }
    if (etat.derniers_resultats) etat.derniers_resultats.regles = (etat.derniers_resultats.regles || []).map(nouveau).filter(Boolean);
  }

  async resumeEtat() {
    const etat = await this.lireEtat();
    const config = await this.lireConfig();
    const ctx = this.contexte();
    const prochain = prochainEpisode(config.planning, ctx.maintenant);
    return [`✅ Bot actif — version ${VERSION}`, etat.version_installee === VERSION ? "Version installée." : "Installation en attente (ouvre /installer).",
            prochain ? `Prochain épisode : ${prochain.date} à ${prochain.heure}` : "Aucun épisode prévu.",
            `Rubriques : ${config.regles.length}`].join("\n");
  }
}

// Vérifie qu'une adresse est un flux RSS/Atom, ou trouve le flux annoncé par une page.
export async function trouverFlux(url, profondeur = 0) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (podcast-matin)", Accept: "application/rss+xml, application/xml, text/html" }, redirect: "follow" });
    if (!r.ok) return null;
    const texte = (await r.text()).slice(0, 300000);
    if (/<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(texte) && /<item[\s>]|<entry[\s>]/i.test(texte)) {
      const titre = /<title[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/i.exec(texte)?.[1]?.trim();
      return { url: r.url || url, titre };
    }
    if (profondeur > 0) return null;
    const liens = [...texte.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)]
      .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1]).filter(Boolean);
    for (const lien of liens.slice(0, 3)) {
      const absolu = new URL(lien, r.url || url).toString();
      const flux = await trouverFlux(absolu, 1);
      if (flux) return flux;
    }
  } catch { /* adresse injoignable */ }
  return null;
}
