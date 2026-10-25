// Cerveau du bot (Durable Object) : un seul exemplaire, état cohérent.
// Il reçoit les messages Telegram, les boutons, les réactions, le « tic » de
// chaque minute (planning) et les appels de GitHub (configuration, événements).

import { DurableObject } from "cloudflare:workers";
import {
  configParDefaut, completerConfig, cloner, regler, REGLAGES, VITESSES, JOURS, heurePrevue, decalerHeure,
  nettoyerPlanning, prochainEpisode, etatRegle, modifierRegle, supprimerRegle, nouvelleRegle, deplacerRubrique,
  nomRubrique, decrirePeriode, ajouterJours, dateCourte, heureParlee, normaliserTexte, nettoyerListe, TONS, CITER, VOIX_CONSEILLEES,
  placerRubrique, FLUX_DEFAUT, NOMS_JOURS, heureValide, modifierChamp, CHAMPS_RUBRIQUE, TRANSPORTS, analyserPeriode,
  VOIX, animateursDuJour, renommerVoix, activerVoix, choisirVoixJour, LONGUEUR_CONSIGNE, PAYS, profilPays, fluxActus, FERIES_CALCULES,
  SOURCES, MAX_FLUX_SPECIALISES, RUBRIQUES_A_CHERCHER,
} from "./config.js";
import { consigneComprehension, contexteComprehension, schemaOperations, appliquerOperations, resumerJours, messageCompris } from "./comprendre.js";
import { ecran, ficheRegle, clavierRegle, tableauDeBord, clavierTableau, clavierEpisode, clavierAvisNegatif, aide, CLAVIER_FIXE, COMMANDES } from "./ui.js";
import {
  nouvelleSession, prochaineEtape, ecranAssistant, ecranModifier, schemaFiche, consigneFiche, fusionnerFiche,
  regleDepuisFiche, schemaQuestions, consigneQuestions, detailFiche, LIBELLES,
} from "./assistant.js";
import { Telegram, GitHub, demanderGemini, maintenantLocal, instantLocal, echapper as e, base64, secretPartage, definirFuseau, empreinte, telegramActif } from "./services.js";
import { CLES, testerCle, lireAgenda, identifiantAgenda, resumeConnexions } from "./connexions.js";
import { fluxRss, chapitresJson, episodeDeCle, jetonValide, nouveauJeton } from "./flux.js";
import { nomValide, objetDuNom, objetAudio } from "./audio.js";
import { nouvellesClesVapid, abonnementValide, envoyerNotification } from "./notifications.js";
import { donneesApp, episodeApp, enregistrerRubrique, nouvelOrdre, ECRANS_BOT, REGLAGES_APP, LISTES_APP, lienAudio, cleEpisode, nettoyerResultats, nettoyerSources, sourcesDeLegende, telechargerFeries } from "./miniapp.js";

export const VERSION = "2026-10-25.1";
const MAX_REFAITS = 6;
const LONGUEURS_VALIDES = ["phrase", "courte", "developpee"];
const MAX_RECHERCHES = 15;
const MAX_EPISODES = 60;      // épisodes récents, dans l'état ; les plus anciens vont dans l'archive de leur mois
const MAX_ARCHIVE_MOIS = 400; // épisodes gardés par mois d'archive (bien plus que nécessaire)
const CONSERVATION_MOIS = 12; // audio, textes et archives : le mois en cours et les douze précédents

// Message envoyé après une mise à jour : les nouveautés de cette version…
const NOUVEAUTES = `✅ <b>Ton podcast est à jour</b> (version ${VERSION}).

• Réglages › Application : « Appareils connectés » montre maintenant tous tes appareils, ceux qui ouvrent le podcast dans Telegram comme ceux connectés par code, avec la mention « cet appareil ».
• Quand un autre appareil entre le code, la liste se met à jour toute seule : plus besoin de rouvrir l'application pour le voir.`;

// … ou, pour qui arrive d'avant l'application (installation neuve, ancienne version
// réglée par la conversation), sa présentation.
const VERSION_APPLICATION = "2026-10-21.1";
const PRESENTATION = `📱 <b>Nouvelle version de ton podcast : tout se règle dans l'application.</b>

• <b>Épisode</b> : toutes tes rubriques dans l'ordre, chacune avec sa fiche ; « + » ajoute une fête du prénom, la météo, un rappel selon l'agenda, une idée de sortie…
• <b>Idées</b> : tes recherches de sorties, à part.
• <b>Réglages</b> : ton pays, tes clés et tes agendas se gèrent maintenant ici.
• Écoute aussi ton podcast dans Apple Podcasts ou AntennaPod, ou ouvre l'application hors de Telegram (Réglages › Application).

Chaque matin, tu reçois ici ton épisode, avec un bouton pour l'ouvrir dans l'application.`;

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

// Appareils connus du bot : ceux connectés par code (jeton, 8 au plus) et ceux qui ouvrent
// l'application dans Telegram (juste notés, 8 au plus). On garde les plus récents de chaque sorte.
function limiterAppareils(liste) {
  const derniers = (telegram) => new Set(liste.filter((a) => !!a.telegram === telegram).slice(-8));
  const telegram = derniers(true), codes = derniers(false);
  return liste.filter((a) => (a.telegram ? telegram : codes).has(a));
}

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
      if (url.pathname === "/telegram") {
        const miseAJour = await requete.json();
        // Réponse immédiate ; le traitement continue (dans l'ordre d'arrivée).
        const travail = this.enFile(() => this.traiterMiseAJour(miseAJour))
          .catch((erreur) => console.log("Mise à jour :", erreur.stack || erreur))
          // Pour les tests : dernier message entièrement traité (voir /test/etat).
          .finally(() => { this.fini = Math.max(this.fini || 0, Number(miseAJour.update_id) || 0); });
        if (this.ctx.waitUntil) this.ctx.waitUntil(travail);
        return new Response("ok");
      }
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
        return Response.json({ config: await this.ctx.storage.get("config"), etat: await this.ctx.storage.get("etat"), reveil: await this.ctx.storage.getAlarm(), fini: this.fini || 0 });
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
      if (url.pathname === "/api/maj") return await this.enFile(() => this.jetonPourMaj());
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
      if (url.pathname === "/installer") return new Response(await this.enFile(() => this.installer(url.searchParams.get("adresse"), true)));
      if (url.pathname === "/etat") return new Response(await this.enFile(() => this.resumeEtat()));
      return new Response("introuvable", { status: 404 });
    } catch (erreur) {
      console.log("Erreur :", erreur.stack || erreur);
      return new Response(`erreur : ${erreur.message}`, { status: 500 });
    }
  }

  // ─────────────────────────────── stockage ─────────────────────────────────

  get tg() { return (this._tg ||= new Telegram(this.env)); }

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
    const etat = { annulations: [], selection: [], attente: null, assistant: null, episodes: [], declenchements: {},
                   refaits: {}, recherches: {}, echantillons: {}, historique: [], ...(await this.ctx.storage.get("etat") || {}) };
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
    await this.majTableau(config, etat).catch(() => {});
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

  // ─────────────────────────── mises à jour Telegram ─────────────────────────

  async traiterMiseAJour(maj) {
    const etat = await this.lireEtat();
    this.modelesLegers = etat.modeles_legers;
    if (maj.update_id && etat.dernier_update && maj.update_id <= etat.dernier_update) return; // déjà traité
    etat.dernier_update = maj.update_id || etat.dernier_update;
    await this.ecrireEtat(etat);
    const chat = String(this.env.TELEGRAM_CHAT_ID);
    if (maj.callback_query) {
      const q = maj.callback_query;
      if (String(q.message?.chat?.id) !== chat) return;
      return this.traiterBouton(q);
    }
    if (maj.message_reaction) {
      const r = maj.message_reaction;
      if (String(r.chat?.id) !== chat) return;
      return this.traiterReaction(r);
    }
    if (maj.poll_answer) {
      if (String(maj.poll_answer.user?.id) !== chat) return;
      return this.traiterSondage(maj.poll_answer);
    }
    const message = maj.message;
    if (!message || String(message.chat?.id) !== chat || message.from?.is_bot) return;
    try {
      return await this.traiterMessage(message);
    } catch (erreur) {
      console.log("Message :", erreur.stack || erreur);
      await this.tg.envoyer(`⚠️ Un souci de mon côté (${e(erreur.message)}). Réessaie, ou passe par /menu.`);
    }
  }

  async traiterMessage(message) {
    const texte = String(message.text || message.caption || "").trim();
    const etat = await this.lireEtat();

    if (message.location) return this.recevoirPosition(message.location);
    if (texte.startsWith("/")) return this.traiterCommande(texte.split(/\s+/)[0].split("@")[0].toLowerCase(), texte);

    const raccourcis = { "🎙️ podcast": "podcast_menu", "⚙️ réglages": "menu", "📌 règles": "regles", "📌 rubriques": "regles", "🔎 recherche": "recherche" };
    const raccourci = raccourcis[texte.toLowerCase()];
    if (raccourci) return this.traiterCommande(`/${raccourci}`, texte);

    // Saisie attendue après un bouton « ✏️ … » (moins de 15 minutes).
    if (etat.attente && Date.now() - etat.attente.depuis < 15 * 60 * 1000 && texte) {
      const attente = etat.attente;
      etat.attente = null;
      await this.ecrireEtat(etat);
      return this.recevoirSaisie(attente, texte);
    }
    // Assistant de recherche en cours : le texte complète la fiche.
    const assistant = etat.assistant;
    if (assistant && texte && Date.now() - assistant.cree < 6 * 3600 * 1000
        && (assistant.etape !== "resume" || Date.now() - (assistant.vu || assistant.cree) < 30 * 60 * 1000)) {
      return this.assistantTexte(texte);
    }
    return this.comprendre(message, texte);
  }

  async traiterCommande(commande, texte) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    switch (commande) {
      case "/start":
      case "/aide":
      case "/help":
        await this.tg.envoyer(aide(), { reply_markup: this.clavierAccueil(etat) });
        return;
      case "/menu":
      case "/parametres":
        return this.ouvrirEcran("accueil", config, etat, ctx);
      case "/planning":
        return this.ouvrirEcran("planning", config, etat, ctx);
      case "/regles":
      case "/rubriques":
        return this.ouvrirEcran("regles:active:0", config, etat, ctx);
      case "/recherche":
        return this.demarrerAssistant(texte.replace(/^\/recherche\s*/i, "").replace(/^🔎 recherche$/i, ""));
      case "/reglages":
      case "/tableau":
        return this.epinglerTableau(config, etat, true);
      case "/annuler":
        return this.annuler(null);
      case "/podcast":
        return this.lancerEpisode([], "audio");
      case "/podcast_menu": {
        const dernier = etat.episodes.at(-1);
        const prochain = prochainEpisode(config.planning, ctx.maintenant);
        const lignes = ["🎙️ <b>Podcast</b>",
          prochain ? `Prochain épisode : ${dateCourte(prochain.date)} à ${heureParlee(prochain.heure)}` : "Aucun épisode prévu.",
          dernier ? `Dernier : ${dateCourte(dernier.date)} — ${e(dernier.titre)}` : ""].filter(Boolean);
        const clavier = [[{ text: "🎙️ Nouvel épisode maintenant", callback_data: "a:podcast" }]];
        if (dernier) clavier.push([{ text: "📝 Texte du dernier épisode", callback_data: `e:${dernier.date}:txt` }]);
        clavier.push([{ text: "📅 Planning", callback_data: "m:planning" }, { text: "⚙️ Réglages", callback_data: "m:accueil" }]);
        await this.tg.envoyer(lignes.join("\n"), { reply_markup: { inline_keyboard: clavier } });
        return;
      }
      default:
        await this.tg.envoyer(aide(), { reply_markup: this.clavierAccueil(etat) });
    }
  }

  async ouvrirEcran(nom, config, etat, ctx, messageId = null) {
    const { texte, clavier } = ecran(nom, config, etat, ctx);
    if (messageId) {
      const r = await this.tg.modifier(messageId, texte, clavier);
      if (r.ok || /not modified/.test(r.description || "")) return;
    }
    await this.tg.envoyer(texte, { reply_markup: { inline_keyboard: clavier } });
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
      reponse = await this.gemini(consigneComprehension(config, ctx), contenus, schemaOperations());
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
      try { resultat.changements.push(await this.ajouterSource(config, action.valeur)); } catch (erreur) { resultat.erreurs.push(`Source : ${erreur.message}`); }
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

  async comprendre(message, texte, indice = "") {
    await this.tg.ecrit();
    let audio = null;
    const vocal = message?.voice || message?.audio;
    if (vocal?.file_id) {
      if ((vocal.duration || 0) > 300) texte = `${texte || ""} (message vocal de plus de 5 minutes, non écouté)`.trim();
      else {
        const octets = await this.tg.fichier(vocal.file_id);
        if (octets) audio = { type: "audio", data: base64(octets), mime_type: vocal.mime_type || "audio/ogg" };
      }
    }
    const coeur = await this.comprendreCoeur(texte, audio, indice);
    if (!coeur) {
      await this.tg.envoyer("⏳ Gemini ne répond pas pour le moment. Réessaie dans une minute, ou utilise l'application.");
      return;
    }
    if (coeur.vide) return;
    await this.afficherCompris(coeur);
  }

  // Le message de réponse dans la conversation, puis les actions demandées.
  async afficherCompris(coeur) {
    const ctx = this.contexte();
    const { config } = coeur;
    const m = messageCompris(coeur);
    const lignes = [];
    if (coeur.vocal) lignes.push(coeur.entendu ? `🎤 <i>« ${e(coeur.entendu)} »</i>` : "🎤 <i>(je n'ai pas pu transcrire ton message)</i>", "");
    if (m.titre) lignes.push(`${m.confirmer ? "⚠️ " : coeur.changements.length ? "✅ " : ""}<b>${e(m.titre)}</b>`);
    lignes.push(...m.lignes.map((c) => `• ${e(c)}`));
    if (m.erreurs.length) lignes.push("", ...m.erreurs.map((x) => `⚠️ ${e(x)}`));
    if (m.note) lignes.push("", e(m.note));
    const boutons = [];
    if (m.confirmer) boutons.push({ text: "✅ Oui, appliquer", callback_data: "a:conf" }, { text: "✕ Non", callback_data: "a:nconf" });
    else {
      if (coeur.changements.length) boutons.push({ text: "↩️ Annuler", callback_data: "a:undo" });
      boutons.push({ text: "⚙️ Réglages", callback_data: "m:accueil" });
    }
    await this.tg.envoyer(lignes.join("\n").replace(/^\n+/, ""), { reply_markup: { inline_keyboard: [boutons] } });
    for (const regle of coeur.reglesCreees) {
      const frais = config.regles.find((r) => r.id === regle.id);
      if (frais) await this.tg.envoyer(ficheRegle(frais, config, ctx), { reply_markup: { inline_keyboard: clavierRegle(frais, ctx) } });
    }
    for (const action of coeur.actions) {
      if (action.type === "nouvel_episode") await this.lancerEpisode(action.ids, "audio");
      if (action.type === "resultats") await this.lancerRecherche(action.ids, action.format);
      if (action.type === "assistant") await this.demarrerAssistant(action.valeur);
      if (action.type === "annuler") await this.annuler(null);
      if (action.type === "afficher") {
        const v = action.valeur;
        if (v === "aide") await this.tg.envoyer(aide(), { reply_markup: this.clavierAccueil(await this.lireEtat()) });
        else if (v === "tableau") await this.epinglerTableau(config, await this.lireEtat(), true);
        else if (v.startsWith("regle:")) await this.ouvrirEcran(`regle:${v.split(":")[1].toUpperCase()}`, config, await this.lireEtat(), ctx);
        else await this.ouvrirEcran(v === "reglages" ? "accueil" : v === "regles" ? "regles:active:0" : v, config, await this.lireEtat(), ctx);
      }
    }
  }

  async recevoirSaisie(attente, texte) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const ancienne = cloner(config);
    const [type, cible] = [attente.type, attente.cible];
    const simples = { av: "actus.ville", vp: "voix.prenom" };
    try {
      let changement = null;
      if (simples[type]) changement = regler(config, simples[type], texte);
      else if (type === "ap" || type === "ae") changement = regler(config, type === "ap" ? "actus.sujets_preferes" : "actus.sujets_a_eviter", texte);
      else if (type === "vn") changement = regler(config, `voix.animateurs.${cible}.nom`, texte);
      else if (type === "ph") {
        config.planning.jours[cible] = heureValide(texte);
        changement = `${NOMS_JOURS[cible]} : ${config.planning.jours[cible] ? heureParlee(config.planning.jours[cible]) : "pas d'épisode"}`;
      }
      else if (type === "ca") changement = regler(config, "consignes", [...config.consignes, texte]);
      else if (type === "ce") {
        const i = Number(cible);
        if (!(i >= 0 && i < config.consignes.length)) throw new Error("cette consigne n'existe plus");
        const copie = [...config.consignes];
        copie[i] = String(texte).trim();
        changement = regler(config, "consignes", copie).replace(/^Consignes/, `Consigne ${i + 1} modifiée`);
      }
      else if (type === "aca") {
        const sujet = String(texte).trim().slice(0, 80);
        if (!sujet) throw new Error("sujet vide");
        config.a_approfondir = [...config.a_approfondir.filter((x) => normaliserTexte(x.sujet) !== normaliserTexte(sujet)),
                                { sujet, demande_le: ctx.maintenantIso }].slice(-5);
        changement = `À creuser au prochain épisode : ${sujet}`;
      }
      else if (type === "rpf" && analyserPeriode(texte, ctx.aujourdHui)) {
        const p = analyserPeriode(texte, ctx.aujourdHui);
        const regle = config.regles.find((r) => r.id === cible);
        if (!regle) throw new Error("cette rubrique n'existe plus");
        if (p.debut && p.fin && p.fin < p.debut) throw new Error("la date de fin est avant celle de début");
        modifierRegle(config, cible, { periode: { type: regle.periode.type === "jours" ? "jours" : "dates", debut: p.debut, fin: p.fin }, servie: false }, ctx.aujourdHui);
        changement = `${cible} · ${decrirePeriode(config.regles.find((r) => r.id === cible).periode)}`;
      }
      else if (type === "prds") changement = regler(config, "planning.delai_rattrapage", texte) + " min";
      else if (type === "rf") {
        const [id, champ] = String(cible).split("|");
        changement = modifierChamp(config, id, champ, texte, ctx.aujourdHui);
      }
      else if (type === "asa") changement = await this.ajouterSource(config, texte);
      else if (type === "rbm") {
        const montant = Number(String(texte).replace(",", ".").replace(/[^\d.]/g, ""));
        if (!Number.isFinite(montant)) throw new Error("montant non reconnu");
        modifierRegle(config, cible, { recherche: { fiche: { budget: { max: montant } } } }, ctx.aujourdHui);
        changement = `Budget de ${cible} : ${montant} ${profilPays(config).devise}`;
      } else {
        const indices = { pexc: "exception ou changement de planning", ppause: "pause du podcast (dates)", rpf: `période de la rubrique ${cible}`,
                          dadd: "nouvelle rubrique à ajouter au déroulé (crée une règle avec rubrique)", rn: "nouvelle rubrique (crée une règle avec rubrique)", autre: "avis sur l'épisode du jour", sujets: "sujets qui l'intéressent moins (à éviter)" };
        await this.comprendre(null, texte, indices[type] || "");
        if (attente.message_id && attente.ecran) await this.ouvrirEcran(attente.ecran, await this.lireConfig(), await this.lireEtat(), ctx, attente.message_id);
        return;
      }
      await this.enregistrer(config, etat, ancienne, changement);
      await this.tg.envoyer(`✅ ${e(changement)}`, { reply_markup: { inline_keyboard: [[{ text: "↩️ Annuler", callback_data: "a:undo" }]] } });
      if (attente.message_id && attente.ecran) await this.ouvrirEcran(attente.ecran, config, etat, ctx, attente.message_id);
    } catch (erreur) {
      await this.tg.envoyer(`⚠️ ${e(erreur.message)}`);
    }
  }

  async demanderSaisie(etat, type, cible, question, exemple, ecranRetour, messageId) {
    etat.attente = { type, cible, ecran: ecranRetour, message_id: messageId, depuis: Date.now() };
    await this.ecrireEtat(etat);
    await this.tg.envoyer(`✏️ ${question}`, { reply_markup: { force_reply: true, input_field_placeholder: exemple.slice(0, 64) } });
  }

  // ──────────────────────────────── boutons ──────────────────────────────────

  async traiterBouton(q) {
    const donnees = q.data || "";
    const messageId = q.message?.message_id;
    const [type, ...args] = donnees.split(":");
    try {
      if (type === "m") {
        await this.tg.repondreBouton(q.id);
        const ctx = this.contexte();
        return await this.ouvrirEcran(args.join(":"), await this.lireConfig(), await this.lireEtat(), ctx, messageId);
      }
      if (type === "a") return await this.action(q, args, messageId);
      if (type === "e") return await this.boutonEpisode(q, args[0], args[1], messageId);
      if (type === "f") return await this.avisNegatif(q, args[0], args[1]);
      if (type === "s") return await this.assistantBouton(q, args, messageId);
      await this.tg.repondreBouton(q.id);
    } catch (erreur) {
      console.log("Bouton :", erreur.stack || erreur);
      await this.tg.repondreBouton(q.id, `⚠️ ${erreur.message}`, true);
    }
  }

  async action(q, args, messageId) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const ancienne = cloner(config);
    const [nom, a1, a2, a3] = args;
    let ecranSuivant = null, libelle = null, toast = "";
    const pas = (chemin, delta, min, max) => {
      const actuel = Number(config[chemin.split(".")[0]][chemin.split(".")[1]]);
      libelle = regler(config, chemin, Math.max(min, Math.min(max, actuel + delta)));
    };
    switch (nom) {
      case "noop": return this.tg.repondreBouton(q.id);
      case "close":
        await this.tg.repondreBouton(q.id);
        return this.tg.modifierBoutons(messageId, []);
      case "undo":
        await this.tg.repondreBouton(q.id);
        return this.annuler(messageId);
      // « À confirmer » : changement lourd compris dans un message.
      case "conf":
      case "nconf": {
        const resultat = await this.repondreConfirmation(nom === "conf");
        await this.tg.repondreBouton(q.id, resultat ? "" : "Plus rien en attente : redis ta demande si besoin.", !resultat);
        if (messageId) await this.tg.modifierBoutons(messageId, []);
        if (!resultat) return;
        if (resultat.abandon) return this.tg.envoyer("D'accord, je n'ai rien changé.");
        return this.afficherCompris({ ...resultat, vocal: false });
      }
      case "podcast":
        await this.tg.repondreBouton(q.id, "Je prépare un épisode…");
        return this.lancerEpisode([], "audio");
      // planning
      case "ph": config.planning.jours[a1] = a2 === "off" ? null : `${a2.slice(0, 2)}:${a2.slice(2)}`;
        libelle = `${a1} : ${config.planning.jours[a1] || "pas d'épisode"}`; ecranSuivant = `jour:${a1}`; break;
      case "pd": config.planning.jours[a1] = decalerHeure(config.planning.jours[a1], Number(a2));
        libelle = `${a1} : ${config.planning.jours[a1]}`; ecranSuivant = `jour:${a1}`; break;
      case "pc": {
        const groupe = { semaine: JOURS.slice(0, 5), weekend: ["sam", "dim"], tous: JOURS }[a2];
        for (const j of groupe) config.planning.jours[j] = config.planning.jours[a1];
        libelle = `Horaire ${resumerJours(groupe)} : ${config.planning.jours[a1] || "pas d'épisode"}`; ecranSuivant = "planning"; break;
      }
      case "prat": config.planning.rattrapage = !config.planning.rattrapage; libelle = `Rattrapage : ${config.planning.rattrapage ? "activé" : "désactivé"}`; ecranSuivant = "rattrapage"; break;
      case "prd": config.planning.rattrapage = true; libelle = regler(config, "planning.delai_rattrapage", a1) + " min"; ecranSuivant = "rattrapage"; break;
      case "prds":
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "prds", null, "Après combien de minutes relancer l'épisode s'il n'est pas arrivé ? (20 à 180)", "40", "rattrapage", messageId);
      case "pfer": config.planning.feries = { normal: "dimanche", dimanche: "aucun", aucun: "normal" }[config.planning.feries];
        libelle = `Jours fériés : ${config.planning.feries}`; ecranSuivant = "planning"; break;
      case "pxr": config.planning.exceptions = config.planning.exceptions.filter((x) => x.date !== a1); libelle = "Exception retirée"; ecranSuivant = "planning"; break;
      case "ppr": config.planning.pauses = config.planning.pauses.filter((x) => x.du !== a1); libelle = "Pause retirée"; ecranSuivant = "planning"; break;
      case "phs":
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "ph", a1, `À quelle heure le ${NOMS_JOURS[a1]} ?`, "5 h 40", `jour:${a1}`, messageId);
      case "re":
        await this.tg.repondreBouton(q.id, "Je prépare un épisode avec cette rubrique…");
        return this.lancerEpisode([a1], "audio");
      case "pexc":
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "pexc", null, "Quelle exception ? Par exemple « demain à 5 h 30 » ou « pas d'épisode le 24 octobre ».", "demain à 5 h 30", "planning", messageId);
      case "ppause":
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "ppause", null, "Pause de quand à quand ? Par exemple « du 20 au 27 octobre ».", "du 20 au 27 octobre", "planning", messageId);
      // format
      case "fd": pas("format.duree_minutes", a1 === "+" ? 1 : -1, 2, 12); ecranSuivant = "format"; break;
      case "fs": pas("format.nombre_sujets", a1 === "+" ? 1 : -1, 1, 8); ecranSuivant = "format"; break;
      case "ft": libelle = regler(config, "format.ton", a1); ecranSuivant = "format"; break;
      // voix
      case "vv": {
        const i = VITESSES.indexOf(config.voix.vitesse) + (a1 === "+" ? 1 : -1);
        libelle = regler(config, "voix.vitesse", VITESSES[Math.max(0, Math.min(VITESSES.length - 1, i))]); ecranSuivant = "voix"; break;
      }
      case "va": libelle = regler(config, `voix.animateurs.${a1}.voix`, a2); ecranSuivant = "voix"; break;
      case "vt": config.voix.tutoiement = a1 ? a1 === "tu" : !config.voix.tutoiement; libelle = config.voix.tutoiement ? "Tutoiement" : "Vouvoiement"; ecranSuivant = "voix"; break;
      case "vp":
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "vp", null, "Quel prénom les animateurs doivent-ils utiliser pour te saluer ?", "ton prénom", "voix", messageId);
      case "vn":
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "vn", a1, `Quel prénom pour l'animateur ${Number(a1) + 1} ?`, "un prénom", "voix", messageId);
      case "vx":
        await this.tg.repondreBouton(q.id);
        return this.envoyerEchantillons(etat);
      // déroulé
      case "du": case "dd": deplacerRubrique(config, a1, nom === "du" ? -1 : 1); libelle = `Déroulé : ${nomRubrique(config, a1)} déplacée`; ecranSuivant = "deroule"; break;
      case "dt": {
        const r = config.deroule.find((x) => x.cle === a1);
        if (r) r.actif = !r.actif;
        libelle = `${nomRubrique(config, a1)} ${r?.actif ? "activée" : "suspendue"}`; ecranSuivant = a2 || "deroule"; break;
      }
      case "dadd":
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "dadd", null, "Décris la rubrique et sa place. Par exemple « le saint du jour après l'agenda » ou « une citation pour finir ».", "le saint du jour après l'agenda", "deroule", messageId);
      // agenda
      case "gj": pas("agenda.jours", a1 === "+" ? 1 : -1, 1, 31); ecranSuivant = "agenda"; break;
      case "gh": pas("agenda.horizon", a1 === "+" ? 30 : -30, 7, 365); ecranSuivant = "agenda"; break;
      case "gn": config.agenda.notes = !config.agenda.notes; libelle = `Notes : ${config.agenda.notes ? "lues" : "ignorées"}`; ecranSuivant = "agenda"; break;
      case "gd": config.agenda.deplacements = !config.agenda.deplacements; libelle = `Déplacements : ${config.agenda.deplacements ? "oui" : "non"}`; ecranSuivant = a1 === "d" ? "deplacements" : "agenda"; break;
      case "gdj": pas("agenda.jours_deplacements", a1 === "+" ? 7 : -7, 1, 60); ecranSuivant = a2 === "d" ? "deplacements" : "agenda"; break;
      case "gmx": pas("agenda.max_deplacements", a1 === "+" ? 1 : -1, 1, 4); ecranSuivant = "deplacements"; break;
      case "gx": {
        const connus = new Set((etat.agendas || []).map((x) => x.id));
        if (!connus.has(a1)) return this.tg.repondreBouton(q.id, "Agenda inconnu : relis la liste.", true);
        const exclus = new Set(config.agenda.exclus);
        if (exclus.has(a1)) exclus.delete(a1); else exclus.add(a1);
        if (exclus.size >= connus.size) return this.tg.repondreBouton(q.id, "Garde au moins un agenda actif.", true);
        config.agenda.exclus = [...exclus];
        const nom = etat.agendas.find((x) => x.id === a1)?.nom || a1;
        libelle = `Agenda « ${nom} » ${exclus.has(a1) ? "ignoré" : "lu"}`; ecranSuivant = "agendas"; break;
      }
      case "gr":
        try {
          await this.gh.lancer("agendas.yml", {});
        } catch (erreur) {
          return this.tg.repondreBouton(q.id, `⚠️ ${erreur.message}`.slice(0, 190), true);
        }
        return this.tg.repondreBouton(q.id, "Je lis tes agendas… rouvre cet écran dans une minute.", true);
      // actus
      case "av": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "av", null, "Quelle ville pour l'actu locale ?", "Yverdon-les-Bains", a1 === "l" ? "actulocale" : "actus", messageId);
      case "ap": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "ap", null, "Tes thèmes préférés, séparés par des virgules (remplace la liste actuelle) :", "technologie, vélo, économie suisse", "actus", messageId);
      case "ae": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "ae", null, "Les thèmes à éviter, séparés par des virgules (remplace la liste actuelle) :", "sport, people", "actus", messageId);
      case "af": pas("actus.fraicheur_heures", a1 === "+" ? 12 : -12, 6, 168); ecranSuivant = a2 === "l" ? "actulocale" : "actus"; break;
      case "aln": pas("actus.locale_articles", a1 === "+" ? 1 : -1, 1, 8); ecranSuivant = "actulocale"; break;
      case "acx": {
        const [retire] = config.a_approfondir.splice(Number(a1), 1);
        libelle = `Retiré des sujets à creuser : ${retire?.sujet || "?"}`; ecranSuivant = "acreuser"; break;
      }
      case "aca": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "aca", null, "Quel sujet développer dans le prochain épisode ?", "la réforme des retraites", "acreuser", messageId);
      case "ac": libelle = regler(config, "actus.citer_sources", a1); ecranSuivant = "actus"; break;
      case "asr": {
        const flux = [...(fluxActus(config))];
        const [retire] = flux.splice(Number(a1), 1);
        config.actus.flux = flux;
        libelle = `Source retirée : ${retire?.nom}`; ecranSuivant = "sources"; break;
      }
      case "asd": config.actus.flux = null; libelle = "Sources par défaut"; ecranSuivant = "sources"; break;
      case "asa": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "asa", null, "Quel média ajouter ? Son nom (« 24 heures ») ou l'adresse de son flux RSS.", "24 heures", "sources", messageId);
      // consignes
      case "cr": { const [retiree] = config.consignes.splice(Number(a1), 1); libelle = `Consigne retirée : ${retiree}`; ecranSuivant = "consignes"; break; }
      case "ce": {
        const courante = config.consignes[Number(a1)];
        if (courante === undefined) return this.tg.repondreBouton(q.id, "Cette consigne n'existe plus.", true);
        await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "ce", a1, `Nouvelle version de la consigne ${Number(a1) + 1}. Texte actuel (touche-le pour le copier, modifie-le puis envoie-le) :\n<code>${e(courante)}</code>`, courante.slice(0, 60), "consignes", messageId);
      }
      case "ca": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "ca", null, "Quelle consigne pour chaque épisode ?", "plus d'humour", "consignes", messageId);
      // règles
      case "rp": {
        const r = config.regles.find((x) => x.id === a1);
        r.etat = r.etat === "pause" ? "active" : "pause"; r.modifie_le = ctx.aujourdHui;
        libelle = `${a1} ${r.etat === "pause" ? "en pause" : "réactivée"}`; ecranSuivant = `regle:${a1}`; break;
      }
      case "ri": {
        const r = config.regles.find((x) => x.id === a1);
        r.importance = r.importance === "prioritaire" ? "normale" : "prioritaire";
        libelle = `${a1} ${r.importance}`; ecranSuivant = `regle:${a1}`; break;
      }
      case "rsy": {
        const titre = config.regles.find((x) => x.id === a1)?.titre || a1;
        const table = supprimerRegle(config, a1);
        this.remapperEtat(etat, table, a1);
        libelle = `Rubrique « ${titre} » supprimée${Object.keys(table).length ? " (les suivantes sont renumérotées)" : ""}`; ecranSuivant = "regles:active:0"; break;
      }
      case "rf": {
        const regle = config.regles.find((x) => x.id === a1);
        if (!regle || !CHAMPS_RUBRIQUE[a2]) return this.tg.repondreBouton(q.id, "Cette rubrique n'existe plus.", true);
        await this.tg.repondreBouton(q.id);
        const actuel = a2 === "titre" ? regle.titre : a2 === "consigne" ? regle.consigne : a2 === "condition" ? regle.condition?.texte
          : a2 === "requetes" ? (regle.recherche?.requetes || []).join(" ; ") : (() => { const v = regle.recherche?.fiche?.[a2]; return Array.isArray(v) ? v.join(", ") : v; })();
        const retourEcran = ["titre", "consigne"].includes(a2) ? `regle:${a1}` : a2 === "condition" ? `rcond:${a1}` : `rrech:${a1}`;
        return this.demanderSaisie(etat, "rf", `${a1}|${a2}`, `${a1} · ${CHAMPS_RUBRIQUE[a2]}. ${actuel ? `Valeur actuelle (touche-la pour la copier, modifie-la puis envoie-la) :\n<code>${e(String(actuel))}</code>\n` : ""}Écris la nouvelle valeur (« - » pour vider) :`, String(actuel || "").slice(0, 60), retourEcran, messageId);
      }
      case "rtr": {
        const r = config.regles.find((x) => x.id === a1);
        const cles = ["", ...Object.keys(TRANSPORTS)];
        const suivant = cles[(cles.indexOf(r?.recherche?.fiche?.transport || "") + 1) % cles.length];
        modifierRegle(config, a1, { recherche: { fiche: { transport: suivant } } }, ctx.aujourdHui);
        libelle = `${a1} · Transport : ${suivant ? TRANSPORTS[suivant] : "non précisé"}`; ecranSuivant = `rrech:${a1}`; break;
      }
      case "rs": {
        const r = config.regles.find((x) => x.id === a1);
        const sources = new Set(r?.recherche?.sources || []);
        if (sources.has(a2)) sources.delete(a2); else sources.add(a2);
        if (!sources.size) return this.tg.repondreBouton(q.id, "Garde au moins une source.", true);
        modifierRegle(config, a1, { recherche: { sources: [...sources] } }, ctx.aujourdHui);
        libelle = `${a1} · sources : ${[...sources].join(", ")}`; ecranSuivant = `rsrc:${a1}`; break;
      }
      case "rcm": modifierRegle(config, a1, { condition: { moment: a2 } }, ctx.aujourdHui); libelle = `${a1} · condition modifiée`; ecranSuivant = `rcond:${a1}`; break;
      case "rcn": {
        const n = config.regles.find((x) => x.id === a1)?.condition?.n || 1;
        modifierRegle(config, a1, { condition: { n: Math.max(1, Math.min(30, n + (a2 === "+" ? 1 : -1))) } }, ctx.aujourdHui);
        libelle = `${a1} · condition modifiée`; ecranSuivant = `rcond:${a1}`; break;
      }
      case "rcx": modifierRegle(config, a1, { condition: null }, ctx.aujourdHui); libelle = `${a1} · condition retirée`; ecranSuivant = `rcond:${a1}`; break;
      case "rpl": {
        const r = config.regles.find((x) => x.id === a1);
        if (!r || a2 === a1) return this.tg.repondreBouton(q.id);
        modifierRegle(config, a1, { rubrique: { titre: r.rubrique?.titre || r.titre, apres: a2, longueur: r.rubrique?.longueur || "courte" } }, ctx.aujourdHui);
        libelle = `${a1} placée après ${nomRubrique(config, a2)}`; ecranSuivant = `rplace:${a1}`; break;
      }
      case "rlg": {
        const r = config.regles.find((x) => x.id === a1);
        if (!r || !LONGUEURS_VALIDES.includes(a2)) return this.tg.repondreBouton(q.id);
        modifierRegle(config, a1, { rubrique: { titre: r.rubrique?.titre || r.titre, apres: r.rubrique?.apres || "actualites", longueur: a2 } }, ctx.aujourdHui); libelle = `${a1} · longueur ${a2}`; ecranSuivant = `rplace:${a1}`; break;
      }
      case "rl":
        await this.tg.repondreBouton(q.id, a2 === "audio" ? "Je prépare le mini-podcast…" : "Je lance la recherche…");
        return this.lancerRecherche([a1], a2 === "audio" ? "audio" : "ecrit");
      case "rpt": {
        const regle = config.regles.find((x) => x.id === a1);
        const periodes = {
          toujours: { type: "toujours", debut: null, fin: null }, une_fois: { type: "une_fois" }, ponctuelle: { type: "ponctuelle" },
          semaine: { type: regle?.periode.type === "jours" ? "jours" : "dates", fin: ajouterJours(regle?.periode.fin && regle.periode.fin > ctx.aujourdHui ? regle.periode.fin : ctx.aujourdHui, 7) },
          mois: { type: regle?.periode.type === "jours" ? "jours" : "dates", fin: ajouterJours(regle?.periode.fin && regle.periode.fin > ctx.aujourdHui ? regle.periode.fin : ctx.aujourdHui, 30) },
        };
        modifierRegle(config, a1, { periode: periodes[a2], servie: false }, ctx.aujourdHui);
        libelle = `Période de ${a1} modifiée`; ecranSuivant = `rperiode:${a1}`; break;
      }
      case "rpj": {
        const regle = config.regles.find((x) => x.id === a1);
        const jours = new Set(regle.periode.type === "jours" ? regle.periode.jours : []);
        if (jours.has(a2)) jours.delete(a2); else jours.add(a2);
        modifierRegle(config, a1, { periode: jours.size ? { type: "jours", jours: JOURS.filter((j) => jours.has(j)) } : { type: "toujours", jours: [] } }, ctx.aujourdHui);
        libelle = `Jours de ${a1} modifiés`; ecranSuivant = `rperiode:${a1}`; break;
      }
      case "rpf": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "rpf", a1, `Quelle période pour ${a1} ? Par exemple « jusqu'au 15 novembre » ou « du 20 au 24 octobre ».`, "jusqu'au 15 novembre", `rperiode:${a1}`, messageId);
      case "rb": {
        const max = a2 === "aucun" ? null : Number(a2);
        modifierRegle(config, a1, { recherche: { fiche: { budget: { max } } } }, ctx.aujourdHui);
        libelle = `Budget de ${a1} : ${max === null ? "sans limite" : max === 0 ? "gratuit" : `${max} ${profilPays(config).devise}`}`; ecranSuivant = `rbudget:${a1}`; break;
      }
      case "rbu": case "rbt": {
        const actuel = config.regles.find((x) => x.id === a1)?.recherche?.fiche?.budget || {};
        const budget = nom === "rbu" ? { unite: a2 === "total" || a2 === "personne" ? a2 : actuel.unite === "total" ? "personne" : "total" } : { transport_inclus: !actuel.transport_inclus };
        modifierRegle(config, a1, { recherche: { fiche: { budget } } }, ctx.aujourdHui);
        libelle = `Budget de ${a1} modifié`; ecranSuivant = `rbudget:${a1}`; break;
      }
      case "rbm": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "rbm", a1, `Quel budget maximum pour ${a1}, en ${profilPays(config).devise} ?`, "35", `rbudget:${a1}`, messageId);
      case "rx": {
        const selection = new Set(etat.selection || []);
        if (selection.has(a1)) selection.delete(a1); else selection.add(a1);
        etat.selection = [...selection];
        await this.ecrireEtat(etat);
        await this.tg.repondreBouton(q.id);
        return this.ouvrirEcran(`regles:${a2 || "active"}:${a3 || 0}`, config, etat, ctx, messageId);
      }
      case "rxc": etat.selection = []; await this.ecrireEtat(etat); await this.tg.repondreBouton(q.id);
        return this.ouvrirEcran(`regles:${a1 || "active"}:0`, config, etat, ctx, messageId);
      case "rxl": {
        const ids = etat.selection || [];
        etat.selection = [];
        await this.ecrireEtat(etat);
        await this.tg.repondreBouton(q.id, "C'est lancé…");
        return this.lancerRecherche(ids, a1 === "audio" ? "audio" : "ecrit");
      }
      case "sdd": case "sdp": case "sdr": {
        const sondage = etat.sondages?.[a1];
        const option = sondage?.options?.[Number(a2)];
        if (!option) return this.tg.repondreBouton(q.id, "Ce sondage est trop ancien.", true);
        if (nom === "sdp") {
          config.a_approfondir = [...config.a_approfondir.filter((x) => x.sujet !== option), { sujet: option.slice(0, 80), demande_le: ctx.maintenantIso }].slice(-5);
          libelle = `Au prochain épisode : ${option}`;
          break;
        }
        const parente = config.regles.find((r) => r.id === sondage.regle);
        if (nom === "sdr") {
          if (!parente) return this.tg.repondreBouton(q.id, "La rubrique n'existe plus.", true);
          modifierRegle(config, parente.id, { recherche: { fiche: { inclure: [...(parente.recherche?.fiche?.inclure || []), `Idée retenue : ${option}`].slice(-8) } } }, ctx.aujourdHui);
          libelle = `${parente.id} : idée retenue « ${option} »`;
          break;
        }
        const fiche = parente?.recherche?.fiche || {};
        const regle = nouvelleRegle(config, {
          titre: `Détails : ${option}`, consigne: `Donner les détails pratiques de « ${option} » : horaires, prix, accès, réservation, conseils.`,
          periode: { type: "ponctuelle" },
          recherche: { fiche: { ...fiche, quoi: option, attendu: "détails pratiques : horaires, prix, accès, réservation" },
                       sources: parente?.recherche?.sources || ["web", "lieux"], requetes: [option] },
        }, ctx.aujourdHui, `sondage ${sondage.regle || ""}`);
        await this.enregistrer(config, etat, ancienne, `Rubrique ${regle.id} créée`);
        await this.tg.repondreBouton(q.id, "Je cherche…");
        return this.lancerRecherche([regle.id], "ecrit");
      }
      case "rn": await this.tg.repondreBouton(q.id);
        return this.demanderSaisie(etat, "rn", null, "Décris ta rubrique en une phrase. Par exemple « le vendredi, termine par une idée de sortie » ou « si j'ai un match, rappelle-moi mes affaires ».", "le vendredi, une idée de sortie", "regles:active:0", messageId);
      case "ra": await this.tg.repondreBouton(q.id);
        return this.demarrerAssistant(etat.position && Date.now() - etat.position.quand < 3600 * 1000 ? `autour de ${etat.position.lieu}` : "");
      case "pville":
        if (!etat.position?.lieu) return this.tg.repondreBouton(q.id, "Partage d'abord ta position (📎 → Position).", true);
        libelle = regler(config, "actus.ville", etat.position.lieu); break;
      case "pav": {
        const suite = { 0: 5, 5: 10, 10: 15 }[config.planning.avance_minutes] ?? 0;
        libelle = regler(config, "planning.avance_minutes", suite); ecranSuivant = "planning"; break;
      }
      default:
        return this.tg.repondreBouton(q.id);
    }
    if (libelle) {
      nettoyerPlanning(config.planning, ctx.aujourdHui);
      await this.enregistrer(config, etat, ancienne, libelle);
      toast = `✅ ${libelle}`;
    }
    await this.tg.repondreBouton(q.id, toast);
    if (ecranSuivant) await this.ouvrirEcran(ecranSuivant, config, etat, ctx, messageId);
  }

  // Revient à la configuration d'avant le dernier changement ; renvoie son libellé.
  async annulerCoeur() {
    const etat = await this.lireEtat();
    const derniere = etat.annulations?.pop();
    if (!derniere) return null;
    await this.ctx.storage.put("config", derniere.config);
    await this.ecrireEtat(etat);
    const config = completerConfig(derniere.config);
    await this.majTableau(config, etat).catch(() => {});
    await this.planifierReveil(config, etat).catch(() => {});
    return derniere.libelle;
  }

  async annuler(messageId) {
    const libelle = await this.annulerCoeur();
    if (!libelle) {
      await this.tg.envoyer("Rien à annuler.");
      return;
    }
    await this.tg.envoyer(`↩️ Annulé : ${e(libelle)}`);
    if (messageId) await this.ouvrirEcran("accueil", await this.lireConfig(), await this.lireEtat(), this.contexte(), messageId);
  }

  // ─────────────────────────── épisode : boutons et avis ─────────────────────

  async boutonEpisode(q, date, action, messageId, repondre = true) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const episode = etat.episodes.find((x) => messageId && x.message_id === messageId)
      || etat.episodes.findLast((x) => x.date === date) || { date, sujets: [], coches: [] };
    const ancienne = cloner(config);
    let libelle = null, toast = "";
    const vitesse = (sens) => {
      const i = VITESSES.indexOf(config.voix.vitesse) + sens;
      return regler(config, "voix.vitesse", VITESSES[Math.max(0, Math.min(VITESSES.length - 1, i))]);
    };
    if (action === "up" || action === "down") {
      episode.avis = action;
      toast = action === "up" ? "Merci ! 👍" : "Dis-moi ce qui n'allait pas 👇";
      if (action === "down") await this.tg.envoyer("👎 Qu'est-ce qui n'allait pas ?", { reply_markup: { inline_keyboard: clavierAvisNegatif(date) } });
    } else if (action === "court") libelle = regler(config, "format.duree_minutes", Math.max(2, config.format.duree_minutes - 1));
    else if (action === "long") libelle = regler(config, "format.duree_minutes", Math.min(12, config.format.duree_minutes + 1));
    else if (action === "lent") libelle = vitesse(-1);
    else if (action === "vite") libelle = vitesse(1);
    else if (action.startsWith("cr")) {
      const sujet = episode.sujets?.[Number(action.slice(2)) - 1];
      if (!sujet) return this.tg.repondreBouton(q.id, "Sujet inconnu (épisode trop ancien).", true);
      config.a_approfondir = [...config.a_approfondir.filter((a) => a.sujet !== sujet), { sujet, demande_le: ctx.maintenantIso }].slice(-5);
      libelle = `À creuser demain : ${sujet}`;
    } else if (action === "txt") {
      await this.tg.repondreBouton(q.id);
      return this.envoyerTexteEpisode(episode);
    } else if (action === "redo") {
      await this.tg.repondreBouton(q.id, "Je prépare un nouvel épisode…");
      return this.lancerEpisode([], "audio");
    }
    episode.coches = [...new Set([...(episode.coches || []), action])];
    if (!etat.episodes.includes(episode) && episode.titre) etat.episodes.push(episode);
    if (libelle) {
      await this.enregistrer(config, etat, ancienne, libelle);
      toast = `✅ ${libelle} (dès le prochain épisode)`;
    } else await this.ecrireEtat(etat);
    if (repondre) await this.tg.repondreBouton(q.id, toast);
    if (messageId) await this.tg.modifierBoutons(messageId, clavierEpisode(date, episode.nombre_sujets ?? episode.sujets?.length ?? 3, episode.coches, episode.details));
  }

  async avisNegatif(q, date, raison) {
    const etat = await this.lireEtat();
    const correspondances = { long: "court", court: "long", vite: "lent", lent: "vite" };
    if (correspondances[raison]) {
      await this.tg.repondreBouton(q.id);
      return this.boutonEpisode(q, date, correspondances[raison], null, false).then(() =>
        this.tg.envoyer("✅ C'est noté pour le prochain épisode.", { reply_markup: { inline_keyboard: [[{ text: "↩️ Annuler", callback_data: "a:undo" }]] } }));
    }
    await this.tg.repondreBouton(q.id);
    if (raison === "ton") return this.ouvrirEcran("format", await this.lireConfig(), etat, this.contexte());
    if (raison === "sujets") {
      const episode = etat.episodes.find((x) => x.date === date);
      return this.demanderSaisie(etat, "sujets", null, `Quels sujets t'intéressent moins ?${episode?.sujets?.length ? ` (ce matin : ${episode.sujets.join(" · ")})` : ""}`, "le sport, la politique française", null, null);
    }
    return this.demanderSaisie(etat, "autre", null, "Dis-moi ce qui n'allait pas, je m'adapte :", "trop de politique, pas assez d'humour", null, null);
  }

  async traiterReaction(reaction) {
    const etat = await this.lireEtat();
    const episode = etat.episodes.find((x) => x.message_id === reaction.message_id);
    if (!episode) return;
    const emoji = reaction.new_reaction?.[0]?.emoji;
    if (!emoji) return;
    const positif = ["👍", "❤", "❤️", "🔥", "👏", "🥰", "😍", "🤩", "💯"].includes(emoji);
    const negatif = ["👎", "💩", "😴", "🤮", "😢", "🤬", "🥱"].includes(emoji);
    if (!positif && !negatif) return;
    episode.avis = positif ? "up" : "down";
    await this.ecrireEtat(etat);
    if (negatif) await this.tg.envoyer("👎 Merci pour ta réaction. Qu'est-ce qui n'allait pas ?", { reply_markup: { inline_keyboard: clavierAvisNegatif(episode.date) } });
    await this.majTableau(await this.lireConfig(), etat).catch(() => {});
  }

  // Vote dans un sondage envoyé avec des résultats de recherche.
  async traiterSondage(reponse) {
    const etat = await this.lireEtat();
    const sondage = etat.sondages?.[reponse.poll_id];
    const choix = reponse.option_ids?.[0];
    if (!sondage || choix === undefined) return;
    const option = sondage.options[choix];
    if (!option) return;
    const id = reponse.poll_id;
    const clavier = [
      [{ text: "🔎 Plus de détails, par écrit", callback_data: `a:sdd:${id}:${choix}` }],
      [{ text: "🎙️ En parler au prochain épisode", callback_data: `a:sdp:${id}:${choix}` }],
    ];
    if (sondage.regle) clavier.push([{ text: `📌 Retenir dans ${sondage.regle}`, callback_data: `a:sdr:${id}:${choix}` }]);
    await this.tg.envoyer(`🗳️ Va pour <b>${e(option)}</b> ! Je fais quoi ?`, { reply_markup: { inline_keyboard: clavier } });
  }

  async envoyerTexteEpisode(episode) {
    const texte = episode ? await this.texteEpisode(episode) : "";
    if (!texte) {
      await this.tg.envoyer("Je n'ai pas le texte de cet épisode.");
      return;
    }
    const morceaux = [];
    let courant = "";
    for (const ligne of texte.split("\n")) {
      if ((courant + ligne).length > 3500) { morceaux.push(courant); courant = ""; }
      courant += `${ligne}\n`;
    }
    if (courant.trim()) morceaux.push(courant);
    for (const [i, m] of morceaux.entries()) {
      await this.tg.envoyer(`${i === 0 ? `📝 <b>${e(episode.titre || "Épisode")}</b> — ${dateCourte(episode.date)}\n` : ""}<blockquote expandable>${e(m.trim())}</blockquote>`);
    }
  }

  // ─────────────────────── épisodes, recherches, extraits ─────────────────────

  async lancerEpisode(ids, format, options = {}) {
    const ctx = this.contexte();
    const etat = await this.lireEtat();
    const compte = etat.refaits?.date === ctx.aujourdHui ? etat.refaits.nombre : 0;
    if (compte >= MAX_REFAITS) {
      if (!options.silencieux) await this.tg.envoyer(`🚫 Déjà ${compte} épisodes ou mini-podcasts à la demande aujourd'hui : c'est le maximum, pour garder assez de quota gratuit de voix pour l'épisode du matin. Ça repart demain.`);
      return { ok: false, erreur: `Déjà ${compte} épisodes à la demande aujourd'hui : c'est le maximum. Ça repart demain.` };
    }
    try {
      await this.gh.lancer("podcast-du-matin.yml", { mode: "manuel", regles: (ids || []).join(",") });
    } catch (erreur) {
      if (!options.silencieux) await this.tg.envoyer(`⚠️ ${e(erreur.message)}`);
      return { ok: false, erreur: erreur.message };
    }
    etat.refaits = { date: ctx.aujourdHui, nombre: compte + 1 };
    await this.ecrireEtat(etat);
    if (!options.silencieux) await this.tg.envoyer(`🎙️ Je prépare un nouvel épisode${ids?.length ? ` (rubriques ${ids.join(", ")})` : ""} : il arrive dans trois ou quatre minutes.`);
    return { ok: true };
  }

  async lancerRecherche(ids, format, options = {}) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const dire = (texte, extra) => (options.silencieux ? null : this.tg.envoyer(texte, extra));
    const valides = (ids || []).filter((id) => config.regles.some((r) => r.id === id) || RUBRIQUES_A_CHERCHER.includes(id));
    if (!valides.length) {
      await dire("Aucune rubrique à traiter.");
      return { ok: false, erreur: "Aucune rubrique à traiter." };
    }
    // Une recherche « point » se rend toujours en podcast d'état des lieux, quel que soit le bouton.
    const points = valides.filter((id) => config.regles.find((r) => r.id === id)?.recherche?.rendu === "point");
    if (points.length) { format = "point"; valides.splice(0, valides.length, ...points); }
    // Une rubrique essentielle (Agenda, Actualités…) : « Mini-podcast » = son point audio, sinon son point écrit.
    const essentielle = valides.find((id) => RUBRIQUES_A_CHERCHER.includes(id));
    if (essentielle) { format = format === "audio" || format === "point" ? "point" : "ecrit"; valides.splice(0, valides.length, essentielle); }
    if (format === "audio" || format === "point") {
      const compte = etat.refaits?.date === ctx.aujourdHui ? etat.refaits.nombre : 0;
      if (compte >= MAX_REFAITS) {
        await dire("🚫 Plus de mini-podcast aujourd'hui (quota gratuit de la voix). Je peux t'envoyer les résultats par écrit :",
          { reply_markup: { inline_keyboard: [[{ text: "📝 Résultats écrits", callback_data: `a:rl:${valides[0]}:ecrit` }]] } });
        return { ok: false, erreur: "Plus de mini-podcast aujourd'hui (quota gratuit de la voix) : choisis les résultats écrits." };
      }
      etat.refaits = { date: ctx.aujourdHui, nombre: compte + 1 };
    } else {
      const compte = etat.recherches?.date === ctx.aujourdHui ? etat.recherches.nombre : 0;
      if (compte >= MAX_RECHERCHES) {
        await dire("🚫 Assez de recherches pour aujourd'hui (quota gratuit de la recherche web). Ça repart demain.");
        return { ok: false, erreur: "Assez de recherches pour aujourd'hui (quota gratuit). Ça repart demain." };
      }
      etat.recherches = { date: ctx.aujourdHui, nombre: compte + 1 };
    }
    try {
      await this.gh.lancer("recherche.yml", { regles: valides.join(","), format });
    } catch (erreur) {
      await dire(`⚠️ ${e(erreur.message)}`);
      return { ok: false, erreur: erreur.message };
    }
    await this.ecrireEtat(etat);
    if (options.silencieux) return { ok: true };
    await this.tg.envoyer(format === "point"
      ? `🎧 Je fais le point (${valides.join(", ")}) : le podcast arrive dans trois ou quatre minutes.`
      : format === "audio"
      ? `🎧 Je prépare un mini-podcast sur ${valides.join(", ")} : il arrive dans trois ou quatre minutes.`
      : `🔎 Je cherche pour ${valides.join(", ")} : les résultats arrivent dans une à deux minutes.`);
    return { ok: true, format };
  }

  async envoyerEchantillons(etat) {
    const connus = VOIX_CONSEILLEES.filter((v) => etat.echantillons?.[v]);
    const envoyes = new Set();
    for (const voix of connus) {
      const fichier = etat.echantillons[voix];
      if (envoyes.has(fichier)) continue;
      envoyes.add(fichier);
      await this.tg.appeler("sendAudio", { chat_id: this.env.TELEGRAM_CHAT_ID, audio: fichier, parse_mode: "HTML",
        caption: etat.legendes_echantillons?.[fichier] || `🎤 ${voix}` });
    }
    const manquants = VOIX_CONSEILLEES.filter((v) => !etat.echantillons?.[v]);
    if (!manquants.length) return;
    const aujourdHui = this.contexte().aujourdHui;
    if (etat.echantillons_demandes === aujourdHui) {
      await this.tg.envoyer(`Les extraits de ${manquants.join(", ")} seront préparés demain (quota gratuit de la voix).`);
      return;
    }
    try {
      await this.gh.lancer("echantillons.yml", { voix: manquants.slice(0, 4).join(",") });
      etat.echantillons_demandes = aujourdHui;
      await this.ecrireEtat(etat);
      await this.tg.envoyer(`🎧 Je prépare les extraits de ${manquants.slice(0, 4).join(", ")} (une à deux minutes).${manquants.length > 4 ? " Les autres suivront demain." : ""}`);
    } catch (erreur) {
      await this.tg.envoyer(`⚠️ ${e(erreur.message)}`);
    }
  }

  // ───────────────────────────────── sources ─────────────────────────────────

  async ajouterSource(config, valeur) {
    const trouve = await this.trouverMedia(config, valeur);
    const liste = [...(fluxActus(config))];
    if (!liste.some((f) => f.url === trouve.url)) liste.push(trouve);
    config.actus.flux = liste;
    return `Source ajoutée : ${trouve.nom}`;
  }

  // Flux spécialisé (Réglages › Sources) : une rubrique peut le choisir dans « Où elle cherche ».
  async ajouterFluxSpecialise(config, valeur) {
    const liste = config.sources.flux;
    if (liste.length >= MAX_FLUX_SPECIALISES) throw new Error(`${MAX_FLUX_SPECIALISES} flux spécialisés au plus : retires-en un d'abord.`);
    const trouve = await this.trouverMedia(config, valeur);
    if (liste.some((f) => f.url === trouve.url)) throw new Error(`« ${trouve.nom} » est déjà dans tes flux spécialisés.`);
    const id = await empreinte(`flux:${trouve.url}`, 8);
    liste.push({ id, nom: trouve.nom.slice(0, 60), url: trouve.url });
    return `Flux spécialisé ajouté : ${trouve.nom}`;
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

  // ─────────────────────────── assistant de recherche ─────────────────────────

  async demarrerAssistant(texteInitial) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const session = nouvelleSession(texteInitial, profilPays(config).devise);
    if (texteInitial && texteInitial.trim().length > 3) {
      await this.tg.ecrit();
      try {
        fusionnerFiche(session.fiche, await this.gemini(consigneFiche(ctx.aujourdHui, profilPays(config)), texteInitial, schemaFiche()), texteInitial);
      } catch (erreur) { console.log("Fiche :", erreur.message); }
    }
    session.etape = prochaineEtape(session);
    etat.assistant = session;
    await this.ecrireEtat(etat);
    const { texte, clavier } = ecranAssistant(session, { ...ctx, ville: config.actus.ville });
    const r = await this.tg.envoyer(texte, { reply_markup: { inline_keyboard: clavier } });
    etat.assistant.message_id = r.result?.message_id;
    await this.ecrireEtat(etat);
  }

  async afficherAssistant(etat, ctx, config, messageId) {
    etat.assistant.vu = Date.now();
    await this.ecrireEtat(etat);
    const { texte, clavier } = ecranAssistant(etat.assistant, { ...ctx, ville: config.actus.ville });
    const id = messageId || etat.assistant.message_id;
    if (id) {
      const r = await this.tg.modifier(id, texte, clavier);
      if (r.ok || /not modified/.test(r.description || "")) return;
    }
    const r = await this.tg.envoyer(texte, { reply_markup: { inline_keyboard: clavier } });
    etat.assistant.message_id = r.result?.message_id;
    await this.ecrireEtat(etat);
  }

  async assistantTexte(texte) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const session = etat.assistant;
    const f = session.fiche;
    const etape = session.etape;
    if (etape === "budget" && /\d/.test(texte)) {
      f.budget.max = Number(texte.replace(",", ".").replace(/[^\d.]/g, ""));
      f.budget_vu = true;
    } else if (etape === "resume") {
      await this.tg.ecrit();
      try {
        fusionnerFiche(f, await this.gemini(consigneFiche(ctx.aujourdHui, profilPays(config)), `(Précision ajoutée à la recherche) ${texte}`, schemaFiche()), texte);
      } catch {
        f.inclure = nettoyerListe([...(f.inclure || []), texte], 8);
      }
    } else if (etape === "approfondir") {
      const q = session.questions[session.question || 0];
      f.inclure = nettoyerListe([...(f.inclure || []), `${q?.question || ""} ${texte}`.trim()], 8);
      session.question = (session.question || 0) + 1;
    } else {
      await this.tg.ecrit();
      try {
        const indice = { quoi: "type d'activité", avec_qui: "avec qui (et âges)", ou: "lieu", quand: "date", transport: "transport", envies: "envies, inclure/exclure" }[etape] || "";
        fusionnerFiche(f, await this.gemini(consigneFiche(ctx.aujourdHui, profilPays(config)), `${indice ? `(Réponse à la question : ${indice}) ` : ""}${texte}`, schemaFiche()), texte);
        if (etape === "envies") f.envies_vues = true;
        if (etape === "quand" && !f.date && !f.quand) f.quand = texte.slice(0, 80);
        if (etape === "ou" && !f.ou) f.ou = texte.slice(0, 120);
        if (etape === "quoi" && !f.quoi) f.quoi = texte.slice(0, 120);
        if (etape === "avec_qui" && !f.avec_qui) f.avec_qui = texte.slice(0, 80);
      } catch {
        if (etape === "envies") { f.inclure = nettoyerListe([...(f.inclure || []), texte], 8); f.envies_vues = true; }
        else if (["quoi", "ou", "avec_qui", "quand"].includes(etape)) f[etape] = texte.slice(0, 120);
      }
    }
    session.etape = etape === "approfondir" && session.question < session.questions.length ? "approfondir" : prochaineEtape(session);
    await this.ecrireEtat(etat);
    await this.afficherAssistant(etat, ctx, config, null);
  }

  async assistantBouton(q, args, messageId) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    const session = etat.assistant;
    if (!session) {
      await this.tg.repondreBouton(q.id, "Cette recherche est terminée. Lance-en une nouvelle avec 🔎 Recherche.", true);
      return;
    }
    const f = session.fiche;
    const [etape, valeur] = args;
    await this.tg.repondreBouton(q.id);
    switch (etape) {
      case "stop":
        etat.assistant = null;
        await this.ecrireEtat(etat);
        await this.tg.modifier(messageId, "🔎 Recherche abandonnée.", []);
        return;
      case "quoi": f.quoi = LIBELLES.QUOI[valeur]?.replace(/^\S+ /, "") || valeur; break;
      case "avec": f.avec_qui = LIBELLES.AVEC[valeur] || valeur; break;
      case "ou": if (valeur === "ville") { f.ou = config.actus.ville ? `autour de ${config.actus.ville}` : "autour de chez moi"; } break;
      case "quand": if (valeur === "libre") f.quand = "pas de date précise"; else { f.date = valeur; f.quand = ""; } break;
      case "tr": f.transport = valeur; break;
      case "bu": f.budget.max = valeur === "aucun" ? null : Number(valeur); f.budget_vu = true; break;
      case "buu": f.budget.unite = f.budget.unite === "total" ? "personne" : "total"; break;
      case "but": f.budget.transport_inclus = !f.budget.transport_inclus; break;
      case "env":
        if (valeur === "ok") f.envies_vues = true;
        else { const s = new Set(f.envies || []); if (s.has(valeur)) s.delete(valeur); else s.add(valeur); f.envies = [...s]; }
        break;
      case "rep": {
        const question = session.questions[session.question || 0];
        if (valeur !== "passer" && question) f.inclure = nettoyerListe([...(f.inclure || []), `${question.question} → ${question.options[Number(valeur)]}`], 8);
        session.question = (session.question || 0) + 1;
        session.etape = session.question < session.questions.length ? "approfondir" : "resume";
        await this.ecrireEtat(etat);
        return this.afficherAssistant(etat, ctx, config, messageId);
      }
      case "appro":
        await this.tg.ecrit();
        try {
          const r = await this.gemini(consigneQuestions(), `Fiche actuelle :\n${detailFiche(f).replace(/<[^>]+>/g, "")}`, schemaQuestions());
          session.questions = (r.questions || []).filter((x) => x.question && x.options?.length).slice(0, 3);
        } catch { session.questions = []; }
        session.question = 0;
        session.etape = session.questions.length ? "approfondir" : "resume";
        await this.ecrireEtat(etat);
        return this.afficherAssistant(etat, ctx, config, messageId);
      case "modif": {
        const { texte, clavier } = ecranModifier();
        return this.tg.modifier(messageId, texte, clavier);
      }
      case "redo":
        if (valeur === "budget") f.budget_vu = false;
        if (valeur === "envies") f.envies_vues = false;
        if (valeur === "quand") { f.date = null; f.quand = ""; }
        if (["quoi", "avec_qui", "ou", "transport"].includes(valeur)) f[valeur] = "";
        session.etape = valeur === "resume" ? "resume" : valeur;
        await this.ecrireEtat(etat);
        return this.afficherAssistant(etat, ctx, config, messageId);
      case "fin": {
        const ancienne = cloner(config);
        const regle = nouvelleRegle(config, regleDepuisFiche(f, valeur === "regle" ? "regle" : "ponctuelle", ctx.aujourdHui), ctx.aujourdHui, session.texte || "assistant de recherche");
        etat.assistant = null;
        await this.enregistrer(config, etat, ancienne, `Rubrique ${regle.id} créée`);
        await this.tg.modifier(messageId, `🔎 ${valeur === "regle" ? "Enregistré" : "C'est parti"} : rubrique ${regle.id}.`, []);
        await this.tg.envoyer(ficheRegle(regle, config, ctx), { reply_markup: { inline_keyboard: clavierRegle(regle, ctx) } });
        if (valeur === "ecrit" || valeur === "audio") await this.lancerRecherche([regle.id], valeur);
        return;
      }
    }
    session.etape = prochaineEtape(session);
    await this.ecrireEtat(etat);
    await this.afficherAssistant(etat, ctx, config, messageId);
  }

  async recevoirPosition(position) {
    const ctx = this.contexte();
    const config = await this.lireConfig();
    const etat = await this.lireEtat();
    let lieu = `${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`;
    try {
      const r = await fetch(`${this.env.NOMINATIM_API || "https://nominatim.openstreetmap.org"}/reverse?format=jsonv2&zoom=12&accept-language=fr&lat=${position.latitude}&lon=${position.longitude}`,
        { headers: { "User-Agent": "podcast-matin/1.0 (podcast personnel)" } });
      const d = await r.json();
      lieu = d.address?.town || d.address?.city || d.address?.village || d.name || lieu;
    } catch { /* coordonnées brutes */ }
    if (etat.assistant) {
      Object.assign(etat.assistant.fiche, { ou: `autour de ${lieu}`, lat: position.latitude, lon: position.longitude });
      etat.assistant.etape = prochaineEtape(etat.assistant);
      await this.ecrireEtat(etat);
      return this.afficherAssistant(etat, ctx, config, null);
    }
    await this.tg.envoyer(`📍 Tu es vers <b>${e(lieu)}</b>. Que veux-tu en faire ?`, { reply_markup: { inline_keyboard: [
      [{ text: `🏠 En faire ma ville`, callback_data: `a:pville` }],
      [{ text: "🔎 Chercher une activité autour", callback_data: "a:ra" }]] } });
    etat.position = { lieu, lat: position.latitude, lon: position.longitude, quand: Date.now() };
    await this.ecrireEtat(etat);
  }

  // ─────────────────────────── tableau de bord ───────────────────────────────

  async majTableau(config, etat) {
    if (!etat.tableau_id) return;
    const r = await this.tg.modifier(etat.tableau_id, tableauDeBord(config, etat, this.contexte()), clavierTableau(this.adresseApp(etat)));
    if (!r.ok && !/not modified/.test(r.description || "") && /not found|can't be edited/.test(r.description || "")) {
      etat.tableau_id = null;
      await this.ecrireEtat(etat);
    }
  }

  async epinglerTableau(config, etat, nouveau) {
    const ctx = this.contexte();
    if (!nouveau && etat.tableau_id) return this.majTableau(config, etat);
    const r = await this.tg.envoyer(tableauDeBord(config, etat, ctx), { reply_markup: { inline_keyboard: clavierTableau(this.adresseApp(etat)) } });
    if (r.ok) {
      if (etat.tableau_id) await this.tg.appeler("unpinChatMessage", { chat_id: this.env.TELEGRAM_CHAT_ID, message_id: etat.tableau_id });
      await this.tg.appeler("pinChatMessage", { chat_id: this.env.TELEGRAM_CHAT_ID, message_id: r.result.message_id, disable_notification: true });
      etat.tableau_id = r.result.message_id;
      await this.ecrireEtat(etat);
    }
  }

  // ─────────────────────────── tic de chaque minute ──────────────────────────

  async tic(adresse) {
    const ctx = this.contexte();
    let etat = await this.lireEtat();
    if (adresse) etat.adresse = adresse;
    if (etat.version_installee !== VERSION && (etat.adresse || this.env.ADRESSE)) {
      await this.installer(etat.adresse || this.env.ADRESSE, false);
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
    // Le tableau de bord change de jour à minuit (prochain épisode).
    if (etat.tableau_jour !== m.date) {
      etat.tableau_jour = m.date;
      await this.ecrireEtat(etat);
      await this.majTableau(config, etat).catch(() => {});
    }
    await this.planifierReveil(config, etat);
  }

  // Programme le prochain réveil : lancement d'un épisode, rattrapage,
  // sauvegarde de 3 h, changement de jour du tableau de bord.
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

  async installer(adresse, forcer) {
    if (!adresse) return "Adresse du bot inconnue.";
    if (!telegramActif(this.env)) return this.installerSansTelegram(adresse);
    const etat = await this.lireEtat();
    const secret = await secretPartage(this.env);
    const r = await this.tg.appeler("setWebhook", { url: `${adresse}/telegram`, secret_token: secret,
      allowed_updates: ["message", "callback_query", "message_reaction", "poll_answer"] });
    await this.tg.appeler("setMyCommands", { commands: COMMANDES });
    // Bouton à gauche du champ de saisie : ouvre l'application (Mini App).
    const app = this.adresseApp({ adresse });
    await this.tg.appeler("setChatMenuButton", { chat_id: this.env.TELEGRAM_CHAT_ID,
      menu_button: app ? { type: "web_app", text: "Application", web_app: { url: app } } : { type: "commands" } });
    const nouvelle = etat.version_installee !== VERSION;
    if (r.ok && etat.version_installee !== VERSION) {
      const avant = etat.version_installee;
      etat.version_installee = VERSION;
      etat.adresse = adresse;
      await this.ecrireEtat(etat);
      const config = await this.lireConfig();
      await this.sauvegarder(config).catch(() => {});
      if (avant && !plusRecente(VERSION_APPLICATION, avant)) {
        // Déjà sur l'application : juste les nouveautés.
        await this.tg.envoyer(NOUVEAUTES, { reply_markup: this.clavierAccueil({ adresse }) });
      } else if (app) {
        // Tout passe par l'application : plus de clavier fixe ni de tableau épinglé.
        await this.tg.envoyer(PRESENTATION, { reply_markup: { remove_keyboard: true } });
        await this.tg.envoyer("Touche ce bouton, ou <b>Application</b> à gauche du champ de saisie :", { reply_markup: this.clavierAccueil({ adresse }) });
        const frais = await this.lireEtat();
        if (frais.tableau_id) {
          await this.tg.appeler("unpinChatMessage", { chat_id: this.env.TELEGRAM_CHAT_ID, message_id: frais.tableau_id });
          await this.tg.appeler("deleteMessage", { chat_id: this.env.TELEGRAM_CHAT_ID, message_id: frais.tableau_id });
          frais.tableau_id = null;
          await this.ecrireEtat(frais);
        }
      } else {
        await this.tg.envoyer(PRESENTATION, { reply_markup: CLAVIER_FIXE });
        await this.epinglerTableau(config, await this.lireEtat(), true);
      }
    } else if (forcer) {
      etat.adresse = adresse;
      await this.ecrireEtat(etat);
    }
    await this.planifierReveil(await this.lireConfig(), await this.lireEtat()).catch((erreur) => console.log("Réveil :", erreur.message));
    // Envoi des épisodes coupé dans Telegram : la nouvelle version s'annonce aussi par notification.
    if (r.ok && nouvelle && (await this.lireConfig()).livraison?.telegram === false) await this.annoncerVersion(await this.lireEtat());
    return r.ok ? "✅ Bot instantané activé (nouvelle version)." : `Telegram refuse : ${r.description}`;
  }

  // Sans Telegram : rien à brancher, la version est notée et annoncée par notification.
  async installerSansTelegram(adresse) {
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
    return `✅ Bot activé (sans Telegram), version ${VERSION}.`;
  }

  async annoncerVersion(etat) {
    const premier = NOUVEAUTES.split("\n").find((l) => l.startsWith("•")) || "";
    await this.notifier(etat, { titre: "✅ Ton podcast est à jour", corps: `Version ${VERSION}. ${premier.replace(/^•\s*/, "").replace(/<[^>]+>/g, "")}`.slice(0, 200),
      url: "/app", tag: "version" });
  }

  // Code de connexion à l'application, demandé par GitHub (workflow « Code de connexion »,
  // ou fin du déploiement pour la toute première ouverture sans Telegram). Valable une heure.
  async codeConnexion(premiere) {
    const etat = await this.lireEtat();
    const adresse = `${String(etat.adresse || this.env.ADRESSE || "").replace(/\/$/, "")}/app`;
    if (premiere && (telegramActif(this.env) || (etat.appareils || []).some((a) => !a.telegram))) {
      return { ok: true, code: null, adresse, raison: telegramActif(this.env) ? "telegram" : "deja_connecte" };
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    const expire = Date.now() + 60 * 60 * 1000;
    etat.code_appareil = { code, expire, essais: 0 };
    await this.ecrireEtat(etat);
    return { ok: true, code, expire, jusqua: maintenantLocal(new Date(expire)).heure, adresse };
  }

  // ─────────────────────────── application (Mini App) ────────────────────────

  // Adresse de la page, seulement en https (Telegram refuse le reste).
  // Sous un message du bot : un bouton vers l'application, sinon l'ancien clavier fixe.
  clavierAccueil(etat) {
    const app = this.adresseApp(etat);
    return app ? { inline_keyboard: [[{ text: "📱 Ouvrir l'application", web_app: { url: app } }]] } : CLAVIER_FIXE;
  }

  adresseApp(etat) {
    const base = etat?.adresse || this.env.ADRESSE || "";
    return /^https:\/\//.test(base) ? `${base.replace(/\/$/, "")}/app` : null;
  }

  // Adresses audio signées : épisodes et extraits de voix (fichiers gardés par Telegram).
  async liensAudio(etat, episodes = etat.episodes || []) {
    const secret = await secretPartage(this.env);
    // Le lien est vérifié avec l'heure réelle (index.js) : jamais signé dans le passé,
    // même quand l'horloge des tests est simulée.
    const maintenant = () => Math.max(this.maintenant(), Date.now());
    const liens = { episodes: {}, voix: {} };
    liens.pochettes = {};
    for (const episode of episodes) {
      if (episode.audio || episode.file_id) liens.episodes[cleEpisode(episode)] = await lienAudio(secret, cleEpisode(episode), maintenant());
      if (episode.pochette || episode.pochette_id) liens.pochettes[cleEpisode(episode)] = await lienAudio(secret, `img:${cleEpisode(episode)}`, maintenant());
    }
    if (etat.derniers_resultats?.audio) liens.idees = await lienAudio(secret, "idees:dernier", maintenant());
    for (const voix of new Set([...Object.keys(etat.echantillons || {}), ...Object.keys(etat.echantillons_fichiers || {})])) {
      if (/^[A-Za-z]+$/.test(voix) && (etat.echantillons?.[voix] || etat.echantillons_fichiers?.[voix])) liens.voix[voix] = await lienAudio(secret, `voix:${voix}`, maintenant());
    }
    return liens;
  }

  // Épisodes envoyés avant l'application : Telegram ne donne pas un message par son
  // numéro, mais le transférer (sans notification, aussitôt retiré) renvoie son
  // fichier audio et sa légende, d'où l'on tire les sources.
  async completerEpisodes(etat) {
    const aCompleter = (etat.episodes || []).filter((ep) => ep.message_id && !ep.file_id && !ep.audio && !ep.complete_tente);
    if (!aCompleter.length) return false;
    for (const episode of aCompleter.slice(0, 7)) {
      episode.complete_tente = true;
      const r = await this.tg.appeler("forwardMessage", { chat_id: this.env.TELEGRAM_CHAT_ID, from_chat_id: this.env.TELEGRAM_CHAT_ID,
        message_id: episode.message_id, disable_notification: true });
      if (!r.ok || !r.result) continue;
      if (r.result.message_id) await this.tg.appeler("deleteMessage", { chat_id: this.env.TELEGRAM_CHAT_ID, message_id: r.result.message_id });
      if (r.result.audio?.file_id) episode.file_id = r.result.audio.file_id;
      if (r.result.audio?.thumbnail?.file_id) episode.pochette_id = r.result.audio.thumbnail.file_id;
      if (!episode.sources?.length) episode.sources = sourcesDeLegende(r.result.caption, r.result.caption_entities);
      if (!episode.duree && r.result.audio?.duration) episode.duree = r.result.audio.duration;
    }
    await this.ecrireEtat(etat);
    return true;
  }

  // Identifiant Telegram d'un fichier audio, pour le lecteur de l'application.
  // Où trouver un fichier : chez le bot (fichier) et/ou chez Telegram (file_id, épisodes d'avant).
  async fichierAudio(cle) {
    const etat = await this.lireEtat();
    if (cle === "idees:dernier") return { fichier: etat.derniers_resultats?.audio || null, file_id: null };
    if (cle.startsWith("resume:")) return { fichier: etat.resumes?.[cle.slice(7)]?.audio || null, file_id: null };
    if (cle.startsWith("voix:")) {
      const voix = cle.slice(5);
      return { fichier: etat.echantillons_fichiers?.[voix] || null, file_id: etat.echantillons?.[voix] || null };
    }
    const image = cle.startsWith("img:");
    const episode = await this.trouverEpisode(etat, image ? cle.slice(4) : cle);
    if (!episode) return { fichier: null, file_id: null };
    return image ? { fichier: episode.pochette || null, file_id: episode.pochette_id || null }
      : { fichier: episode.audio || null, file_id: episode.file_id || null };
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

  // Envoie une notification aux appareils abonnés (tous, ou « cibles »). Un abonnement
  // disparu (404, 410) est oublié ; une autre erreur est notée ; l'état est enregistré.
  async notifier(etat, message, cibles = etat.abonnements || []) {
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

  // Ce que l'application reçoit après une demande libre : le message (le même que dans
  // Telegram) et les actions faites tout de suite (épisode, recherche, annulation).
  async reponseParler(resultat, relire) {
    const suites = [];
    for (const action of resultat.actions) {
      if (action.type === "nouvel_episode") suites.push((await this.lancerEpisode(action.ids, "audio", { silencieux: true })).ok ? "Nouvel épisode lancé." : "Épisode non lancé (limite du jour).");
      if (action.type === "resultats") {
        const lance = await this.lancerRecherche(action.ids, action.format, { silencieux: true });
        suites.push(lance.ok ? (lance.format === "point" ? "Podcast lancé : il arrive dans « Idées » d'ici trois ou quatre minutes." : "Recherche lancée.")
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
      telegram: telegramActif(this.env),
      notifications: { cle: (await this.clesVapid()).publique,
        abonnements: (etat.abonnements || []).map((a) => ({ id: a.id, nom: a.nom, cree_le: a.cree_le, erreur: a.erreur || null, fin: a.endpoint.slice(-16) })) },
      // Premier lancement : rien de personnel encore réglé.
      bienvenue: !etat.bienvenue_faite && !config.voix.prenom && !config.actus.ville && !config.regles.length,
      flux: this.adresseFlux(etat),
      maj: etat.maj && plusRecente(etat.maj.version, VERSION) ? etat.maj : null,
      maj_etat: etat.maj_etat ? { etat: etat.maj_etat.etat, version: etat.maj_etat.version, message: etat.maj_etat.message || "" } : null,
      maj_modele: etat.maj_modele || null,
      adresse_app: `${etat.adresse || this.env.ADRESSE || ""}/app`,
      appareils: (etat.appareils || []).map((a) => ({ id: a.id, nom: a.nom, cree_le: a.cree_le, vu_le: a.vu_le, telegram: !!a.telegram })),
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
          // Ouverte dans Telegram (pas par un appareil à code), l'application se signale : elle apparaît dans la liste des appareils.
          if (!demande._appareil) await this.noterAppareilTelegram(etat, demande.appareil_local, ctx);
          if (await this.completerEpisodes(etat)) etat = await this.lireEtat();
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
        case "source": {
          const valeur = String(demande.valeur || "").trim().slice(0, 300);
          if (!valeur) return refus("Donne le nom du média ou l'adresse de son flux.");
          try { libelle = await this.ajouterSource(config, valeur); } catch (erreur) { return refus(`Désolé, ${erreur.message}`); }
          break;
        }
        case "retirer_source": {
          const flux = [...(fluxActus(config))];
          const [retire] = flux.splice(Number(demande.index), 1);
          if (!retire) return refus("Cette source n'est plus dans la liste.");
          if (!flux.length) return refus("Garde au moins une source.");
          config.actus.flux = flux;
          libelle = `Source retirée : ${retire.nom}`;
          break;
        }
        case "sources_defaut":
          config.actus.flux = null;
          libelle = "Sources par défaut";
          break;
        // ── Réglages › Sources : catégories et flux spécialisés ──
        case "source_coupee": {
          const cle = String(demande.cle || "");
          if (!SOURCES[cle]) return refus("Source inconnue.");
          const coupees = new Set(config.sources.coupees);
          if (demande.coupee) coupees.add(cle); else coupees.delete(cle);
          config.sources.coupees = [...coupees];
          libelle = `${SOURCES[cle]} : ${demande.coupee ? "retirée, aucune rubrique ne la lit" : "de nouveau utilisable"}`;
          break;
        }
        case "flux_ajouter": {
          const valeur = String(demande.valeur || "").trim().slice(0, 300);
          if (!valeur) return refus("Donne le nom du site ou l'adresse de son flux RSS.");
          try { libelle = await this.ajouterFluxSpecialise(config, valeur); } catch (erreur) { return refus(`Désolé, ${erreur.message}`); }
          break;
        }
        case "flux_retirer": {
          const flux = config.sources.flux.find((f) => f.id === demande.id);
          if (!flux) return refus("Ce flux n'est plus dans la liste.");
          config.sources.flux = config.sources.flux.filter((f) => f.id !== flux.id);
          // Les rubriques qui le lisaient ne le gardent pas.
          for (const r of config.regles) if (r.recherche) r.recherche.sources = r.recherche.sources.filter((x) => x !== `flux:${flux.id}`);
          libelle = `Flux spécialisé retiré : ${flux.nom}`;
          break;
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
          etat.tests_cles[nom] = { ok: true, message: test.message, quand: ctx.maintenantIso, ou: "app" };
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
            etat.tests_cles[nom] = { ok: test.ok, message: test.message, quand: ctx.maintenantIso, ou: "app" };
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
          // Un appareil Telegram n'a pas de jeton à révoquer : il revient dans la liste s'il rouvre l'application.
          return reponse({ message: cible.telegram ? "Appareil retiré de la liste." : "Appareil retiré : il devra entrer un nouveau code." });
        }
        // ── notifications ──
        case "notif_abonner": {
          const abonnement = abonnementValide(demande.abonnement, this.env.MODE_TEST === "1");
          if (!abonnement) return refus("Abonnement aux notifications illisible.");
          const nom = String(demande.nom || "Navigateur").slice(0, 40);
          const ancien = (etat.abonnements || []).find((a) => a.endpoint === abonnement.endpoint);
          const fiche = { id: ancien?.id || nouveauJeton().slice(0, 12), ...abonnement, nom, appareil: demande._appareil || ancien?.appareil || null,
                          cree_le: ancien?.cree_le || ctx.maintenantIso, erreur: null };
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
        case "notif_tester": {
          if (!(etat.abonnements || []).length) return refus("Aucun appareil ne reçoit les notifications : active-les d'abord sur ton téléphone.");
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
          const manquants = demandees.filter((v) => !(etat.echantillons?.[v] || etat.echantillons_fichiers?.[v]) || !etat.temps_echantillons?.[v]).slice(0, 8);
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
          const lance = await this.lancerEpisode(ids, "audio", { silencieux: true });
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
          if (geste === "up" || geste === "down") {
            episode.avis = episode.avis === geste ? null : geste;
            await this.ecrireEtat(etat);
            return reponse({ message: episode.avis === "up" ? "Merci !" : episode.avis === "down" ? "Noté. Qu'est-ce qui n'allait pas ?" : "Avis retiré" });
          }
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
          const lance = await this.lancerRecherche([demande.id], demande.format === "audio" ? "audio" : "ecrit", { silencieux: true });
          if (!lance.ok) return refus(lance.erreur);
          return reponse({ message: lance.format === "point" ? "Je fais le point : le podcast arrive ici d'ici trois ou quatre minutes."
            : demande.format === "audio"
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
        case "ouvrir": {
          if (!ECRANS_BOT.includes(demande.ecran)) return refus("Écran inconnu.");
          await this.ouvrirEcran(demande.ecran, config, etat, ctx);
          return reponse();
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

  // ─────────────────────── appareils hors de Telegram ─────────────────────────
  // Un code à 6 chiffres (10 minutes, 5 essais), affiché dans l'application ouverte
  // dans Telegram, donne à un autre appareil son propre jeton, révocable.

  // Un appareil qui ouvre l'application dans Telegram (signature vérifiée par le Worker) donne un
  // identifiant tiré au hasard et gardé chez lui (« t-… ») et son nom. Ce n'est pas un droit d'accès :
  // la liste de « Appareils connectés » montre simplement tout ce qui ouvre l'application, une fois par jour au plus.
  async noterAppareilTelegram(etat, local, ctx) {
    const id = String(local?.id || "");
    if (!/^t-[0-9a-f]{10}$/.test(id)) return false;
    const nom = String(local.nom || "Telegram").replace(/[<>]/g, "").slice(0, 40) || "Telegram";
    const liste = etat.appareils || [];
    const connu = liste.find((a) => a.id === id);
    if (connu) {
      if (!connu.telegram) return false;   // jamais l'identifiant d'un appareil à code
      if (connu.nom === nom && String(connu.vu_le || "").slice(0, 10) === ctx.aujourdHui) return false;
      connu.nom = nom;
      connu.vu_le = ctx.maintenantIso;
    } else {
      liste.push({ id, nom, telegram: true, cree_le: ctx.maintenantIso, vu_le: ctx.maintenantIso });
    }
    etat.appareils = limiterAppareils(liste);
    await this.ecrireEtat(etat);
    return true;
  }

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

  // Le jeton GitHub du bot, pour pousser aussi les fichiers d'automatisation :
  // seulement pendant une mise à jour demandée dans l'application (30 minutes).
  async jetonPourMaj() {
    const etat = await this.lireEtat();
    const enCours = etat.maj_etat?.etat === "en_cours" && Date.now() - etat.maj_etat.depuis < 30 * 60 * 1000;
    if (!enCours || !this.env.GITHUB_TOKEN) return new Response("interdit", { status: 403 });
    return Response.json({ jeton: this.env.GITHUB_TOKEN });
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
    return Response.json(quoi === "image" ? { fichier: episode.pochette || null, file_id: episode.pochette_id || null }
      : { fichier: episode.audio || null, file_id: episode.file_id || null });
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
        date: ev.date || ctx.aujourdHui, titre: ev.titre || "", sujets: ev.sujets || [], message_id: ev.message_id || null,
        texte: Boolean(ev.transcription), chapitres: ev.chapitres || [], regles: ev.regles || [],
        nombre_sujets: ev.nombre_sujets ?? (ev.sujets || []).length, coches: [], avis: null, mode: ev.mode || "",
        details: (ev.details || []).slice(0, 2), duree: ev.duree || null,
        file_id: typeof ev.file_id === "string" ? ev.file_id.slice(0, 200) : null,
        heure: /^\d{2}:\d{2}$/.test(ev.heure || "") ? ev.heure : null, taille: Number(ev.taille) || null,
        sources: nettoyerSources(ev.sources),
        pochette_id: typeof ev.pochette_id === "string" ? ev.pochette_id.slice(0, 200) : null,
        // Fichiers gardés par le bot (depuis la version 2026-10-21.4).
        audio: fichierRecu(ev.audio, ".mp3"), pochette: fichierRecu(ev.pochette, ".jpg"),
        // Sans Telegram, pas de numéro de message : l'heure d'envoi (HHMMSS) distingue les épisodes du jour.
        ref: Number.isInteger(Number(ev.ref)) && Number(ev.ref) > 0 && Number(ev.ref) < 240000 ? Number(ev.ref) : null,
      };
      if (ev.transcription) await this.ctx.storage.put(`texte:${cleEpisode(episode)}`, String(ev.transcription).slice(0, 20000));
      await this.retenirRubriques(episode, ev.rubriques);
      const meme = (x) => x.date === episode.date && (x.message_id || x.ref || null) === (episode.message_id || episode.ref || null);
      const tous = [...etat.episodes.filter((x) => !meme(x)), episode];
      etat.episodes = tous.slice(-MAX_EPISODES);
      await this.archiver(etat, tous.slice(0, -MAX_EPISODES));
      if (ev.mode !== "manuel") etat.declenchements[episode.date] = { ...(etat.declenchements[episode.date] || {}), envoye: true };
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
      await this.majTableau(config, etat).catch(() => {});
      await this.planifierReveil(config, etat).catch(() => {});
      const duree = episode.duree ? ` · ${Math.max(1, Math.round(episode.duree / 60))} min` : "";
      await this.notifier(etat, { titre: ev.mode === "manuel" ? "🎙️ Ton épisode est prêt" : "🎙️ Ton podcast du matin est prêt",
        corps: `${episode.titre || "Nouvel épisode"}${duree}`, url: `/app?ep=${encodeURIComponent(cleEpisode(episode))}`, tag: `ep-${episode.date}` });
      return { ok: true };
    }
    if (ev.type === "echec") {
      // L'épisode n'a pas pu être préparé (GitHub) : prévenir aussi hors de Telegram.
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
        etat.tests_cles[nom] = { ok: Boolean(r.ok), message: String(r.message || "").slice(0, 300), quand: ctx.maintenantIso, ou: "github" };
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
    if (ev.type === "echantillon" && /^[A-Za-z]{2,20}$/.test(ev.voix || "") && (ev.file_id || ev.fichier)) {
      if (ev.file_id) {
        etat.echantillons = { ...(etat.echantillons || {}), [ev.voix]: ev.file_id };
        etat.legendes_echantillons = { ...(etat.legendes_echantillons || {}), [ev.file_id]: String(ev.legende || "").slice(0, 300) };
      }
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
                                  // Mini-podcast gardé par le bot (écoute dans l'application, avec ou sans Telegram).
                                  audio: fichierRecu(ev.audio, ".mp3"), titre_audio: String(ev.titre_audio || "").slice(0, 120), duree_audio: Number(ev.duree) || null };
      if (ev.sondage?.poll_id && Array.isArray(ev.sondage.options)) {
        const sondages = { ...(etat.sondages || {}), [ev.sondage.poll_id]: { options: ev.sondage.options.slice(0, 10).map(String), regle: ev.sondage.regle || ev.regles?.[0] || null, quand: ctx.aujourdHui } };
        etat.sondages = Object.fromEntries(Object.entries(sondages).slice(-10));
      }
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
    etat.selection = (etat.selection || []).map(nouveau).filter(Boolean);
    for (const sondage of Object.values(etat.sondages || {})) sondage.regle = nouveau(sondage.regle);
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
    return [`✅ Bot actif — version ${VERSION}`, etat.version_installee === VERSION ? "Webhook installé." : "Installation en attente (ouvre /installer).",
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
