// Interface Telegram : chaque écran renvoie { texte, clavier }. Les boutons
// portent des données courtes (≤ 64 octets) : « m:… » pour naviguer, « a:… »
// pour agir, « e:… » pour les boutons sous l'épisode, « s:… » pour l'assistant.

import {
  JOURS, NOMS_JOURS, COURTS_JOURS, VITESSES, TONS, CITER, RUBRIQUES, VOIX, VOIX_CONSEILLEES, SOURCES, TRANSPORTS,
  LONGUEURS, LIBELLES_ETATS, etatRegle, prochainPassage, decrirePeriode, nomRubrique, heureParlee, dateCourte, prochainEpisode,
  heurePrevue, fluxActus, profilPays, PAYS, ECRAN_INTEGREE, DELAIS_RATTRAPAGE,
} from "./config.js";
import { echapper as e } from "./services.js";

const b = (texte, donnees) => ({ text: texte, callback_data: donnees });
const retour = (vers = "m:accueil", texte = "◀ Retour") => [b(texte, vers)];
const coche = (vrai) => (vrai ? "✅" : "▫️");
const h = (heure) => (heure ? heureParlee(heure) : "—");
const chf = (n, devise = "CHF") => `${String(n).replace(".", ",")} ${devise}`;
// Une rubrique qui cherche des activités ou des lieux (budget, résultats, sondage…).
export const regleDeRecherche = (r) => Boolean(r.recherche && (r.recherche.fiche?.quoi || r.recherche.fiche?.ou
  || r.recherche.sources.some((s) => ["web", "lieux", "wikivoyage", "transports"].includes(s))));

export const CLAVIER_FIXE = {
  keyboard: [[{ text: "🎙️ Podcast" }, { text: "⚙️ Réglages" }], [{ text: "📌 Rubriques" }, { text: "🔎 Recherche" }]],
  resize_keyboard: true, is_persistent: true, input_field_placeholder: "Écris ou dicte une demande…",
};

export const COMMANDES = [
  { command: "menu", description: "Tous les réglages" },
  { command: "podcast", description: "Un nouvel épisode tout de suite" },
  { command: "rubriques", description: "Mes rubriques" },
  { command: "recherche", description: "Organiser une activité, une sortie" },
  { command: "planning", description: "Horaires des épisodes" },
  { command: "reglages", description: "Résumé de mes réglages" },
  { command: "annuler", description: "Annuler le dernier changement" },
  { command: "aide", description: "Ce que je sais faire" },
];

// ───────────────────────────────── écrans ───────────────────────────────────

export function ecran(nom, config, etat, ctx) {
  const [cle, ...args] = nom.split(":");
  const fonction = ECRANS[cle];
  return fonction ? fonction(config, etat, ctx, ...args) : ECRANS.accueil(config, etat, ctx);
}

const ECRANS = {
  accueil(config, etat, ctx) {
    const prochain = prochainEpisode(config.planning, ctx.maintenant);
    const actives = config.regles.filter((r) => etatRegle(r, ctx.aujourdHui) === "active").length;
    const texte = [
      "⚙️ <b>Réglages du podcast</b>",
      prochain ? `Prochain épisode : ${dateCourte(prochain.date)} à ${heureParlee(prochain.heure)}` : "Aucun épisode prévu dans les 30 jours",
      `${config.format.duree_minutes} min · ${config.format.nombre_sujets} sujets · vitesse ${config.voix.vitesse} · ${actives} rubrique${actives > 1 ? "s" : ""} à toi active${actives > 1 ? "s" : ""}`,
      "",
      "Choisis une rubrique, ou écris-moi simplement ce que tu veux changer.",
    ].join("\n");
    const clavier = [
      [b("📅 Planning", "m:planning"), b("🎙️ Format", "m:format")],
      [b("🗣️ Voix", "m:voix"), b("🧩 Déroulé", "m:deroule")],
      [b("🗓️ Agenda", "m:agenda"), b("📰 Actus", "m:actus")],
      [b("✍️ Consignes", "m:consignes"), b("📌 Rubriques", "m:regles:active:0")],
    ];
    if (etat.annulations?.length) clavier.push([b(`↩️ Annuler : ${etat.annulations.at(-1).libelle}`.slice(0, 60), "a:undo")]);
    clavier.push([b("✖ Fermer", "a:close")]);
    return { texte, clavier };
  },

  planning(config, etat, ctx) {
    const p = config.planning;
    const lignes = JOURS.map((j) => `${COURTS_JOURS[j]} ${p.jours[j] ? heureParlee(p.jours[j]) : "— pas d'épisode"}`);
    const exceptions = p.exceptions.map((x) => `• ${dateCourte(x.date)} : ${x.heure ? heureParlee(x.heure) : "pas d'épisode"}`);
    const pauses = p.pauses.map((x) => `• pause du ${dateCourte(x.du)} au ${dateCourte(x.au)}`);
    const texte = [
      "📅 <b>Planning</b>", lignes.join(" · "), "",
      exceptions.length || pauses.length ? ["<b>Exceptions</b>", ...exceptions, ...pauses].join("\n") : "Aucune exception.",
      "", `Jours fériés : ${{ normal: "horaire habituel", dimanche: "horaire du dimanche", aucun: "pas d'épisode" }[p.feries]}`,
      `Rattrapage si l'envoi rate : ${p.rattrapage ? `oui, ${libelleDelai(p.delai_rattrapage)} après l'heure prévue` : "désactivé"}`,
      `Préparation : ${p.avance_minutes ? `lancée ${p.avance_minutes} min avant, pour que l'épisode arrive à l'heure` : "lancée à l'heure pile (l'épisode arrive 3 à 5 min après)"}`,
      "", "Appuie sur un jour pour changer son heure.",
    ].join("\n");
    const jours = JOURS.map((j) => b(`${COURTS_JOURS[j]} ${p.jours[j] ? h(p.jours[j]) : "—"}`, `m:jour:${j}`));
    const clavier = [jours.slice(0, 4), jours.slice(4)];
    clavier.push([b("➕ Exception", "a:pexc"), b("⏸ Pause", "a:ppause")]);
    for (const x of p.exceptions.slice(0, 4)) clavier.push([b(`✕ ${dateCourte(x.date)} ${x.heure ? h(x.heure) : "—"}`, `a:pxr:${x.date}`)]);
    for (const x of p.pauses.slice(0, 3)) clavier.push([b(`✕ pause ${dateCourte(x.du)} → ${dateCourte(x.au)}`, `a:ppr:${x.du}`)]);
    clavier.push([b(`Fériés : ${{ normal: "normal", dimanche: "comme dimanche", aucun: "pas d'épisode" }[p.feries]}`, "a:pfer"),
                  b(`🔁 Rattrapage : ${p.rattrapage ? libelleDelai(p.delai_rattrapage) : "non"}`, "m:rattrapage")]);
    clavier.push([b(`⏩ Préparé ${p.avance_minutes} min avant`, "a:pav")]);
    clavier.push(retour());
    return { texte, clavier };
  },

  jour(config, etat, ctx, jour) {
    const heure = config.planning.jours[jour];
    const texte = `📅 <b>${NOMS_JOURS[jour][0].toUpperCase()}${NOMS_JOURS[jour].slice(1)}</b> : ${heure ? heureParlee(heure) : "pas d'épisode"}\n\nChoisis une heure, ou décale de 15 minutes.`;
    const presets = ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30"]
      .map((x) => b(`${x === heure ? "• " : ""}${h(x)}`, `a:ph:${jour}:${x.replace(":", "")}`));
    const clavier = [
      [b("−15 min", `a:pd:${jour}:-15`), b(heure ? h(heure) : "—", "a:noop"), b("+15 min", `a:pd:${jour}:15`)],
      presets.slice(0, 4), presets.slice(4),
      [b("✏️ Autre heure", `a:phs:${jour}`), b("🚫 Pas d'épisode", `a:ph:${jour}:off`)],
      [b("Appliquer du lundi au vendredi", `a:pc:${jour}:semaine`)],
      [b("Appliquer au week-end", `a:pc:${jour}:weekend`), b("À tous les jours", `a:pc:${jour}:tous`)],
      retour("m:planning", "◀ Planning"),
    ];
    return { texte, clavier };
  },

  format(config) {
    const f = config.format;
    const texte = `🎙️ <b>Format</b>\nDurée : ${f.duree_minutes} min · Sujets d'actualité : ${f.nombre_sujets} · Ton : ${TONS[f.ton]}`;
    const clavier = [
      [b("−", "a:fd:-"), b(`⏱ ${f.duree_minutes} min`, "a:noop"), b("+", "a:fd:+")],
      [b("−", "a:fs:-"), b(`📰 ${f.nombre_sujets} sujets`, "a:noop"), b("+", "a:fs:+")],
      Object.entries(TONS).slice(0, 2).map(([k, v]) => b(`${f.ton === k ? "• " : ""}${v}`, `a:ft:${k}`)),
      Object.entries(TONS).slice(2).map(([k, v]) => b(`${f.ton === k ? "• " : ""}${v}`, `a:ft:${k}`)),
      retour(),
    ];
    return { texte, clavier };
  },

  voix(config) {
    const v = config.voix;
    const [a1, a2] = v.animateurs;
    const style = (nom) => VOIX.find(([n]) => n === nom)?.[1] || "";
    const texte = [
      "🗣️ <b>Voix et animateurs</b>",
      `Vitesse : ${v.vitesse}`,
      `Animateur 1 : ${e(a1.nom)} — voix ${a1.voix} (${style(a1.voix)})`,
      `Animateur 2 : ${e(a2.nom)} — voix ${a2.voix} (${style(a2.voix)})`,
      `${v.tutoiement ? "Tutoiement" : "Vouvoiement"} · Ton prénom : ${e(v.prenom) || "non précisé"}`,
    ].join("\n");
    const i = VITESSES.indexOf(v.vitesse);
    const clavier = [
      [b("◀ Plus lent", "a:vv:-"), b(v.vitesse, "a:noop"), b("Plus vite ▶", "a:vv:+")],
      [b(`🎤 ${a1.nom} : ${a1.voix}`, "m:anim:0"), b(`🎤 ${a2.nom} : ${a2.voix}`, "m:anim:1")],
      [b(`${v.tutoiement ? "• " : ""}Tutoiement`, "a:vt:tu"), b(`${v.tutoiement ? "" : "• "}Vouvoiement`, "a:vt:vous"), b("✏️ Ton prénom", "a:vp")],
      [b("🎧 Écouter les voix conseillées", "a:vx")],
      retour(),
    ];
    if (i < 0) clavier.shift();
    return { texte, clavier };
  },

  anim(config, etat, ctx, index, page = "0") {
    const i = Number(index), p = Number(page);
    const a = config.voix.animateurs[i];
    const parPage = 8;
    const voix = [...VOIX].sort((x, y) => (VOIX_CONSEILLEES.includes(y[0]) - VOIX_CONSEILLEES.includes(x[0])));
    const tranche = voix.slice(p * parPage, (p + 1) * parPage);
    const texte = `🎤 <b>Animateur ${i + 1} : ${e(a.nom)}</b>\nVoix actuelle : ${a.voix}\n\n⭐ = voix conseillées. ♀/♂ = timbre plutôt féminin ou masculin.`;
    const boutons = tranche.map(([nom, style, genre]) =>
      b(`${nom === a.voix ? "• " : ""}${VOIX_CONSEILLEES.includes(nom) ? "⭐ " : ""}${nom} ${genre === "f" ? "♀" : "♂"} ${style}`, `a:va:${i}:${nom}`));
    const clavier = [];
    for (let k = 0; k < boutons.length; k += 2) clavier.push(boutons.slice(k, k + 2));
    const nav = [];
    if (p > 0) nav.push(b("◀ Voix précédentes", `m:anim:${i}:${p - 1}`));
    if ((p + 1) * parPage < voix.length) nav.push(b("Voix suivantes ▶", `m:anim:${i}:${p + 1}`));
    if (nav.length) clavier.push(nav);
    clavier.push([b("✏️ Changer le prénom", `a:vn:${i}`)]);
    clavier.push(retour("m:voix", "◀ Voix"));
    return { texte, clavier };
  },

  deroule(config, etat, ctx) {
    const sommeil = (cle) => {
      const regle = config.regles.find((x) => x.id === cle);
      const etatR = regle ? etatRegle(regle, ctx.aujourdHui) : "active";
      return etatR === "active" ? "" : ` — ${LIBELLES_ETATS[etatR]}`;
    };
    const lignes = config.deroule.map((r, i) => `${i + 1}. ${r.actif ? "" : "⏸ "}${e(nomRubrique(config, r.cle))}${sommeil(r.cle)}`);
    const texte = `🧩 <b>Déroulé de l'épisode</b>\nDans l'ordre où elles sont dites :\n${lignes.join("\n")}\n\n` +
      "Touche le nom d'une rubrique pour régler ses paramètres, ⬆⬇ pour la déplacer, ⏸ pour la suspendre. " +
      "Tes rubriques ne passent que les jours où elles s'appliquent.";
    const clavier = config.deroule.map((r) => {
      const vers = ouvrirRubrique(config, r.cle);
      return [
        b(`${r.actif ? "" : "⏸ "}${nomRubrique(config, r.cle)}`.slice(0, 30), vers || "a:noop"),
        b("⬆", `a:du:${r.cle}`), b("⬇", `a:dd:${r.cle}`), b(r.actif ? "⏸" : "▶", `a:dt:${r.cle}`),
      ];
    });
    clavier.push([b("➕ Nouvelle rubrique", "a:rn"), b("📌 Toutes mes rubriques", "m:regles:active:0")]);
    clavier.push(retour());
    return { texte, clavier };
  },

  agenda(config, etat) {
    const a = config.agenda;
    const connus = etat.agendas || [];
    const actifs = connus.filter((x) => !a.exclus.includes(x.id)).length;
    const texte = [
      "🗓️ <b>Agenda</b>",
      connus.length ? `Agendas lus : ${actifs} sur ${connus.length}` : "Agendas : liste pas encore lue (bouton ci-dessous)",
      `Jours couverts : ${a.jours}`,
      `Agenda vide → prochain événement cherché jusqu'à ${a.horizon} jours`,
      `Notes des événements : ${a.notes ? "lues" : "ignorées"}`,
      `Déplacements et sorties : ${a.deplacements ? `repérés jusqu'à ${a.jours_deplacements} jours` : "désactivé"} (voir la rubrique « Déplacements »)`,
    ].join("\n");
    const clavier = [
      [b(`📚 Mes agendas${connus.length ? ` (${actifs}/${connus.length})` : ""}`, "m:agendas")],
      [b("−", "a:gj:-"), b(`📆 ${a.jours} jours`, "a:noop"), b("+", "a:gj:+")],
      [b("−", "a:gh:-"), b(`🔭 ${a.horizon} jours`, "a:noop"), b("+", "a:gh:+")],
      [b(`${coche(a.notes)} Notes`, "a:gn"), b("🧳 Déplacements et sorties", "m:deplacements")],
      retour(),
    ];
    return { texte, clavier };
  },

  agendas(config, etat) {
    const a = config.agenda;
    const connus = etat.agendas || [];
    const lignes = connus.map((x) => `${a.exclus.includes(x.id) ? "▫️" : "✅"} ${e(x.nom)} — ${x.nb} événement${x.nb > 1 ? "s" : ""}`);
    const texte = ["📚 <b>Mes agendas</b>",
      connus.length ? lignes.join("\n") : "Je ne connais pas encore tes agendas : touche « Lire mes agendas ».",
      "", "Seuls les agendas cochés sont lus pour l'épisode. Les adresses restent secrètes (dans GitHub), je ne vois que leur nom.",
      etat.agendas_vus ? `Lecture du ${dateCourte(String(etat.agendas_vus).slice(0, 10))}.` : ""].filter(Boolean).join("\n");
    const clavier = connus.map((x) => [b(`${a.exclus.includes(x.id) ? "▫️" : "✅"} ${x.nom}`.slice(0, 40), `a:gx:${x.id}`)]);
    clavier.push([b("🔄 Lire mes agendas", "a:gr")]);
    clavier.push(retour("m:agenda", "◀ Agenda"));
    return { texte, clavier };
  },

  deplacements(config) {
    const a = config.agenda;
    const texte = [
      "🧳 <b>Déplacements et sorties</b>",
      "Je repère dans ton agenda les voyages, rencontres et sorties dans un lieu précis, puis je présente pour chacun : quand, deux ou trois idées sur place, et les actus locales utiles.",
      "", `Repérage : ${a.deplacements ? "activé" : "désactivé"}`,
      `Horizon : ${a.jours_deplacements} jours · Lieux présentés au plus : ${a.max_deplacements}`,
      "Un lieu déjà présenté la veille est seulement rappelé.",
    ].join("\n");
    const clavier = [
      [b(`${coche(a.deplacements)} Repérage`, "a:gd:d"), b(estActive(config, "deplacements") ? "⏸ Suspendre" : "▶ Réactiver", "a:dt:deplacements:deplacements")],
      [b("−", "a:gdj:-:d"), b(`🧳 ${a.jours_deplacements} jours`, "a:noop"), b("+", "a:gdj:+:d")],
      [b("−", "a:gmx:-"), b(`📍 ${a.max_deplacements} lieu${a.max_deplacements > 1 ? "x" : ""} max.`, "a:noop"), b("+", "a:gmx:+")],
      [b("🧩 Place dans le déroulé", "m:deroule")],
      retour("m:regles:active:0", "◀ Rubriques"),
    ];
    return { texte, clavier };
  },

  actulocale(config) {
    const a = config.actus;
    const texte = [
      "🏠 <b>Actu locale</b>",
      "Un court passage sur ce qui se passe dans ta ville, à partir de la presse locale.",
      "", `Ville : ${e(a.ville) || "— (renseigne-la pour activer cette rubrique)"}`,
      `Articles lus : ${a.locale_articles} · Âge max. : ${a.fraicheur_heures} h`,
    ].join("\n");
    const clavier = [
      [b("✏️ Ville", "a:av:l"), b("📍 Ma position", "a:pville")],
      [b("−", "a:aln:-"), b(`📰 ${a.locale_articles} articles`, "a:noop"), b("+", "a:aln:+")],
      [b("−", "a:af:-:l"), b(`🕑 ${a.fraicheur_heures} h`, "a:noop"), b("+", "a:af:+:l")],
      [b(estActive(config, "actu_locale") ? "⏸ Suspendre" : "▶ Réactiver", "a:dt:actu_locale:actulocale"), b("🧩 Place", "m:deroule")],
      retour("m:regles:active:0", "◀ Rubriques"),
    ];
    return { texte, clavier };
  },

  acreuser(config) {
    const liste = config.a_approfondir || [];
    const texte = [
      "🔎 <b>À creuser</b>",
      "Les sujets que tu veux voir développés dans le prochain épisode (bouton « 🔎 Sujet n » sous un épisode, ou « creuse ça demain »). Ils sont oubliés une fois traités.",
      "", liste.length ? liste.map((x, i) => `${i + 1}. ${e(x.sujet)}`).join("\n") : "Rien à creuser pour l'instant.",
    ].join("\n");
    const clavier = liste.map((x, i) => [b(`✕ ${x.sujet}`.slice(0, 40), `a:acx:${i}`)]);
    clavier.push([b("➕ Ajouter un sujet", "a:aca"), b(estActive(config, "approfondissements") ? "⏸ Suspendre" : "▶ Réactiver", "a:dt:approfondissements:acreuser")]);
    clavier.push(retour("m:regles:active:0", "◀ Rubriques"));
    return { texte, clavier };
  },

  actus(config) {
    const a = config.actus;
    const flux = fluxActus(config);
    const texte = [
      "📰 <b>Actualités</b>",
      `Thèmes préférés : ${e(a.sujets_preferes.join(", ")) || "—"}`,
      `Thèmes à éviter : ${e(a.sujets_a_eviter.join(", ")) || "—"}`,
      `Sources : ${flux.length ? e(flux.map((f) => f.nom).join(", ")) : "aucune"}${a.flux ? "" : " (par défaut)"}`,
      `Âge max. des actus : ${a.fraicheur_heures} h · Citer les sources : ${CITER[a.citer_sources]}`,
      `Ville : ${e(a.ville) || "—"} (actu locale : voir la rubrique « Actu locale »)`,
    ].join("\n");
    const clavier = [
      [b("✏️ Préférés", "a:ap"), b("✏️ À éviter", "a:ae")],
      [b("📡 Sources", "m:sources"), b("🏠 Actu locale", "m:actulocale")],
      [b("−", "a:af:-"), b(`🕑 ${a.fraicheur_heures} h`, "a:noop"), b("+", "a:af:+")],
      Object.entries(CITER).map(([k, v]) => b(`${a.citer_sources === k ? "• " : ""}${v}`, `a:ac:${k}`)),
      retour(),
    ];
    return { texte, clavier };
  },

  sources(config) {
    const flux = fluxActus(config);
    const texte = `📡 <b>Sources d'actualités</b>${config.actus.flux ? "" : " (par défaut)"}\n${flux.map((f, i) => `${i + 1}. ${e(f.nom)}`).join("\n") || "Aucune source : seules les actus locales et tes thèmes seront cherchés."}\n\nAjoute un média par son nom (« 24 heures ») ou l'adresse de son flux RSS.`;
    const clavier = flux.map((f, i) => [b(`✕ ${f.nom}`.slice(0, 40), `a:asr:${i}`)]);
    clavier.push([b("➕ Ajouter une source", "a:asa")]);
    if (config.actus.flux) clavier.push([b("↺ Revenir aux sources par défaut", "a:asd")]);
    clavier.push(retour("m:actus", "◀ Actus"));
    return { texte, clavier };
  },

  consignes(config) {
    const c = config.consignes;
    const texte = `✍️ <b>Consignes permanentes</b>\n${c.length ? c.map((x, i) => `${i + 1}. ${e(x)}`).join("\n") : "Aucune consigne."}\n\n` +
      "Une consigne est une phrase transmise telle quelle à l'IA qui écrit chaque épisode (ex. « plus d'humour », « toujours un point sur Yverdon »). Elle s'applique à tout l'épisode, tous les jours. Pour un passage précis, crée plutôt une rubrique.";
    const clavier = c.map((x, i) => [b(`✏️ Modifier ${i + 1}`, `a:ce:${i}`), b(`✕ Supprimer ${i + 1}`, `a:cr:${i}`)]);
    clavier.push([b("➕ Ajouter une consigne", "a:ca")]);
    clavier.push(retour());
    return { texte, clavier };
  },

  rattrapage(config) {
    const p = config.planning;
    const texte = [
      "🔁 <b>Rattrapage</b>",
      p.rattrapage
        ? `Si l'épisode n'est pas arrivé ${libelleDelai(p.delai_rattrapage)} après l'heure prévue, je le relance une fois.`
        : "Désactivé : si l'envoi rate, je ne relance rien (tu es prévenu de l'échec).",
      "", "Choisis le délai (au moins 30 minutes conseillées : la préparation dure 3 à 5 minutes, parfois plus si Gemini est lent).",
    ].join("\n");
    const delais = DELAIS_RATTRAPAGE.map((d) => b(`${p.rattrapage && p.delai_rattrapage === d ? "• " : ""}${libelleDelai(d)}`, `a:prd:${d}`));
    const clavier = [delais.slice(0, 3), delais.slice(3),
      [b("✏️ Autre délai", "a:prds"), b(p.rattrapage ? "🚫 Désactiver" : "✅ Activer", "a:prat")],
      retour("m:planning", "◀ Planning")];
    return { texte, clavier };
  },

  regles(config, etat, ctx, filtre = "active", page = "0") {
    const p = Number(page);
    const groupes = { active: ["active"], avenir: ["a_venir"], pause: ["pause"], terminee: ["terminee", "ponctuelle"] };
    const choisies = config.regles.filter((r) => groupes[filtre]?.includes(etatRegle(r, ctx.aujourdHui)));
    const selection = new Set(etat.selection || []);
    const tranche = choisies.slice(p * 6, (p + 1) * 6);
    const compte = (f) => config.regles.filter((r) => groupes[f].includes(etatRegle(r, ctx.aujourdHui))).length;
    const n = choisies.length;
    const nom = { active: n > 1 ? "actives" : "active", avenir: "à venir", pause: "en pause", terminee: n > 1 ? "terminées ou ponctuelles" : "terminée ou ponctuelle" }[filtre];
    const texte = [
      "📌 <b>Rubriques</b>",
      n ? `${n} rubrique${n > 1 ? "s" : ""} ${nom}.`
                      : "Aucune rubrique dans cette catégorie.",
      selection.size ? `Sélection : ${[...selection].join(", ")}` : "",
      "", "Une rubrique est un passage de l'épisode avec ses propres paramètres (quoi chercher, où, avec quelles sources, quand…). Crée-en une en m'écrivant (« chaque jour, dis-moi le saint du jour après l'agenda ») ou avec les boutons.",
      "Les rubriques intégrées (actu locale, déplacements, à creuser) se règlent plus bas.",
    ].filter(Boolean).join("\n");
    const onglets = Object.keys(groupes).map((f) => b(`${filtre === f ? "• " : ""}${{ active: "Actives", avenir: "À venir", pause: "Pause", terminee: "Finies" }[f]} ${compte(f)}`, `m:regles:${f}:0`));
    const clavier = [onglets];
    for (const r of tranche) {
      clavier.push([b(`${r.importance === "prioritaire" ? "⭐ " : ""}${r.id} · ${r.titre}`.slice(0, 40), `m:regle:${r.id}`),
                    b(selection.has(r.id) ? "☑️" : "☐", `a:rx:${r.id}:${filtre}:${p}`)]);
    }
    const nav = [];
    if (p > 0) nav.push(b("◀", `m:regles:${filtre}:${p - 1}`));
    if ((p + 1) * 6 < choisies.length) nav.push(b("▶", `m:regles:${filtre}:${p + 1}`));
    if (nav.length) clavier.push(nav);
    if (selection.size) clavier.push([b(`📝 Résultats écrits (${selection.size})`, "a:rxl:ecrit"), b(`🎧 Mini-podcast (${selection.size})`, "a:rxl:audio"), b("✕", `a:rxc:${filtre}`)]);
    clavier.push([b("➕ Nouvelle rubrique", "a:rn"), b("🔎 Assistant de recherche", "a:ra")]);
    clavier.push([b("🏠 Actu locale", "m:actulocale"), b("🧳 Déplacements", "m:deplacements"), b("🔎 À creuser", "m:acreuser")]);
    clavier.push([b("🧩 Déroulé", "m:deroule"), ...retour()]);
    return { texte, clavier };
  },

  regle(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    if (!r) return { texte: `La rubrique ${id} n'existe plus.`, clavier: [retour("m:regles:active:0", "◀ Rubriques")] };
    return { texte: ficheRegle(r, config, ctx), clavier: clavierRegle(r, ctx) };
  },

  rperiode(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    if (!r) return ECRANS.regle(config, etat, ctx, id);
    const texte = `📅 <b>Période de ${r.id}</b>\nActuellement : ${decrirePeriode(r.periode)}\n\nPour une date précise, écris-la simplement (« jusqu'au 15 novembre », « du 20 au 24 octobre »).`;
    const jours = JOURS.map((j) => b(`${r.periode.type === "jours" && r.periode.jours.includes(j) ? "✅" : ""}${COURTS_JOURS[j]}`, `a:rpj:${id}:${j}`));
    const clavier = [
      [b("Toujours", `a:rpt:${id}:toujours`), b("Une seule fois", `a:rpt:${id}:une_fois`)],
      [b("+1 semaine", `a:rpt:${id}:semaine`), b("+1 mois", `a:rpt:${id}:mois`), b("✏️ Dates", `a:rpf:${id}`)],
      jours.slice(0, 4), jours.slice(4),
      [b("Recherche ponctuelle (hors podcast)", `a:rpt:${id}:ponctuelle`)],
      retour(`m:regle:${id}`, `◀ ${id}`),
    ];
    return { texte, clavier };
  },

  rcond(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    if (!r) return ECRANS.regle(config, etat, ctx, id);
    const c = r.condition;
    const moments = { jour_meme: "Le jour même", veille: "La veille", jours_avant: "N jours avant" };
    const texte = [`⏰ <b>Condition de ${r.id}</b>`,
      c ? `La rubrique ne passe que si ton agenda contient : « ${e(c.texte)} » (${{ jour_meme: "le jour même", veille: "la veille", jours_avant: `${c.n} jour${c.n > 1 ? "s" : ""} avant` }[c.moment]}).`
        : "Aucune condition : la rubrique passe selon sa période.",
      "", "Exemples : « un match de foot », « un rendez-vous chez le médecin », « un voyage »."].join("\n");
    const clavier = [[b(c ? "✏️ Changer la condition" : "➕ Ajouter une condition", `a:rf:${id}:condition`)]];
    if (c) {
      clavier.push(Object.entries(moments).map(([k, v]) => b(`${c.moment === k ? "• " : ""}${v}`, `a:rcm:${id}:${k}`)));
      if (c.moment === "jours_avant") clavier.push([b("−", `a:rcn:${id}:-`), b(`${c.n} jour${c.n > 1 ? "s" : ""}`, "a:noop"), b("+", `a:rcn:${id}:+`)]);
      clavier.push([b("🚫 Retirer la condition", `a:rcx:${id}`)]);
    }
    clavier.push(retour(`m:regle:${id}`, `◀ ${id}`));
    return { texte, clavier };
  },

  rplace(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    if (!r) return ECRANS.regle(config, etat, ctx, id);
    const apres = r.rubrique?.apres;
    const texte = [`🧩 <b>Place de ${r.id}</b>`,
      r.rubrique ? `Passage « ${e(r.rubrique.titre)} », dit après : ${e(nomRubrique(config, apres))}. Longueur : ${LONGUEURS[r.rubrique.longueur]}.`
        : "Pas de passage dédié : la consigne est glissée là où c'est le plus naturel. Choisir une longueur ou une place lui crée un passage dédié.",
      "", "Longueur, puis après quelle rubrique elle passe :"].join("\n");
    const autres = config.deroule.filter((x) => x.cle !== id);
    const boutons = autres.map((x) => b(`${apres === x.cle ? "• " : ""}${nomRubrique(config, x.cle)}`.slice(0, 28), `a:rpl:${id}:${x.cle}`));
    const clavier = [Object.entries(LONGUEURS).map(([k, v]) => b(`${r.rubrique?.longueur === k ? "• " : ""}${v}`, `a:rlg:${id}:${k}`))];
    for (let k = 0; k < boutons.length; k += 2) clavier.push(boutons.slice(k, k + 2));
    clavier.push(retour(`m:regle:${id}`, `◀ ${id}`));
    return { texte, clavier };
  },

  rrech(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    if (!r) return ECRANS.regle(config, etat, ctx, id);
    const f = r.recherche?.fiche || {};
    const v = (x) => (x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length) ? "—" : e(Array.isArray(x) ? x.join(", ") : String(x)));
    const budget = f.budget?.max === null || f.budget?.max === undefined ? "- (aucun critère)"
      : f.budget.max === 0 ? "gratuit" : `${chf(f.budget.max, f.budget.devise)} ${f.budget.unite === "total" ? "pour le groupe" : "par personne"}${f.budget.transport_inclus ? ", transport compris" : ""}`;
    const texte = [`🔎 <b>Recherche de ${r.id} — ${e(r.titre)}</b>`,
      `Quoi : ${v(f.quoi)}`, `Avec qui : ${v(f.avec_qui)} · Âges : ${v(f.ages)}`,
      `Où : ${v(f.ou)} · Rayon : ${f.rayon_km ? `${f.rayon_km} km` : "—"}`, `Quand : ${v(f.quand)}`,
      `Transport : ${f.transport ? TRANSPORTS[f.transport] : "- (aucun critère)"} · Budget : ${budget}`,
      `À inclure : ${v(f.inclure)}`, `À exclure : ${v(f.exclure)}`, `Résultat attendu : ${v(f.attendu)}`,
      `Recherches web : ${v(r.recherche?.requetes)}`,
      `Sources : ${r.recherche?.sources?.length ? r.recherche.sources.map((s) => SOURCES[s]).join(", ") : "—"}`,
      "", "Touche un champ pour le modifier (écris « - » pour le vider)."].join("\n");
    const champ = (nom, cle) => b(`✏️ ${nom}`, `a:rf:${id}:${cle}`);
    const clavier = [
      [champ("Quoi", "quoi"), champ("Avec qui", "avec_qui"), champ("Âges", "ages")],
      [champ("Où", "ou"), champ("Rayon", "rayon_km"), champ("Quand", "quand")],
      [b(`🚗 Transport : ${f.transport ? TRANSPORTS[f.transport].replace(/^\S+ /, "") : "-"}`, `a:rtr:${id}`), b("💰 Budget", `m:rbudget:${id}`)],
      [champ("Inclure", "inclure"), champ("Exclure", "exclure"), champ("Attendu", "attendu")],
      [champ("Recherches web", "requetes"), b("📡 Sources", `m:rsrc:${id}`)],
      retour(`m:regle:${id}`, `◀ ${id}`),
    ];
    return { texte, clavier };
  },

  rsrc(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    if (!r) return ECRANS.regle(config, etat, ctx, id);
    const actives = new Set(r.recherche?.sources || []);
    const aide = {
      web: "recherche sur internet (Tavily, avec quota)", actus: "articles de presse récents", meteo: "prévisions Open-Meteo",
      transports: "horaires et retards de trains (CFF, SNCB, SNCF)", lieux: "lieux et points d'intérêt autour d'un endroit", wikivoyage: "guides de voyage",
      saints: "calendrier des saints du jour (exact)", fetes: "fêtes nationales et journées internationales du jour (exact)", feries: "jours fériés de ta région",
    };
    const texte = [`📡 <b>Sources de ${r.id}</b>`, "Où je vais chercher pour cette rubrique :",
      ...Object.keys(SOURCES).map((s) => `${actives.has(s) ? "✅" : "▫️"} ${SOURCES[s]} — ${aide[s] || ""}`)].join("\n");
    const boutons = Object.keys(SOURCES).map((s) => b(`${actives.has(s) ? "✅" : "▫️"} ${SOURCES[s]}`.slice(0, 28), `a:rs:${id}:${s}`));
    const clavier = [];
    for (let k = 0; k < boutons.length; k += 2) clavier.push(boutons.slice(k, k + 2));
    clavier.push(retour(`m:rrech:${id}`, "◀ Recherche"));
    return { texte, clavier };
  },

  rbudget(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    if (!r) return ECRANS.regle(config, etat, ctx, id);
    const budget = r.recherche?.fiche?.budget || { max: null, unite: "personne", transport_inclus: false };
    const texte = `💰 <b>Budget de ${r.id}</b>\n${budget.max === null ? "- Aucun critère de budget" : budget.max === 0 ? "Gratuit uniquement" : `${chf(budget.max, budget.devise)} maximum`}` +
      `${budget.max ? ` ${budget.unite === "total" ? "pour le groupe" : "par personne"}, transport ${budget.transport_inclus ? "compris" : "non compris"}` : ""}`;
    const clavier = [
      [b("Gratuit", `a:rb:${id}:0`), b("≤ 20", `a:rb:${id}:20`), b("≤ 50", `a:rb:${id}:50`), b("≤ 100", `a:rb:${id}:100`)],
      [b("- Aucun critère", `a:rb:${id}:aucun`), b("✏️ Autre montant", `a:rbm:${id}`)],
      [b(`${budget.unite === "total" ? "" : "• "}Par personne`, `a:rbu:${id}:personne`), b(`${budget.unite === "total" ? "• " : ""}Pour le groupe`, `a:rbu:${id}:total`)],
      [b(`${coche(budget.transport_inclus)} Transport compris`, `a:rbt:${id}`)],
      retour(`m:rrech:${id}`, "◀ Recherche"),
    ];
    return { texte, clavier };
  },

  rsuppr(config, etat, ctx, id) {
    const r = config.regles.find((x) => x.id === id);
    return { texte: `Supprimer définitivement la rubrique ${id}${r ? ` « ${e(r.titre)} »` : ""} ? Les suivantes seront renumérotées.`,
             clavier: [[b("🗑 Oui, supprimer", `a:rsy:${id}`), b("Non", `m:regle:${id}`)]] };
  },
};

// Écran à ouvrir quand on touche une rubrique dans le déroulé.
function ouvrirRubrique(config, cle) {
  if (config.regles.some((r) => r.id === cle)) return `m:regle:${cle}`;
  return ECRAN_INTEGREE[cle] ? `m:${ECRAN_INTEGREE[cle]}` : null;
}

const estActive = (config, cle) => config.deroule.find((x) => x.cle === cle)?.actif !== false;
export const libelleDelai = (minutes) => {
  const m = Number(minutes) || 60;
  return m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m / 60} h`;
};

export function ficheRegle(r, config, ctx) {
  const etat = etatRegle(r, ctx.aujourdHui);
  const lignes = [`📌 <b>${r.id} — ${e(r.titre)}</b> ${r.importance === "prioritaire" ? "⭐" : ""}`,
                  `<i>${LIBELLES_ETATS[etat]}</i> · ${decrirePeriode(r.periode)}`, "", `Consigne : ${e(r.consigne)}`];
  if (etat === "a_venir") {
    const prochain = prochainPassage(r, ctx.aujourdHui);
    if (prochain) lignes.push(`Prochain passage : ${dateCourte(prochain)}`);
  }
  if (r.condition) lignes.push(`Condition : ${e(r.condition.texte)} (${{ jour_meme: "le jour même", veille: "la veille", jours_avant: `${r.condition.n} jours avant` }[r.condition.moment]})`);
  lignes.push(r.rubrique
    ? `Place : « ${e(r.rubrique.titre)} », après ${e(nomRubrique(config, r.rubrique.apres))}, ${LONGUEURS[r.rubrique.longueur]}`
    : "Place : pas de passage dédié (glissée là où c'est naturel)");
  if (r.recherche) {
    const f = r.recherche.fiche;
    const details = [f.quoi && `Quoi : ${f.quoi}`, f.avec_qui && `Avec : ${f.avec_qui}${f.ages ? ` (${f.ages})` : ""}`,
      f.ou && `Où : ${f.ou}${f.rayon_km ? ` (${f.rayon_km} km)` : ""}`, f.quand && `Quand : ${f.quand}`,
      f.transport && `Transport : ${TRANSPORTS[f.transport]}`,
      f.budget?.max !== null && f.budget?.max !== undefined && `Budget : ${f.budget.max === 0 ? "gratuit" : `${chf(f.budget.max, f.budget.devise)} ${f.budget.unite === "total" ? "pour le groupe" : "par personne"}`}${f.budget.transport_inclus ? ", transport compris" : ""}`,
      f.inclure?.length && `Inclure : ${f.inclure.join(", ")}`, f.exclure?.length && `Exclure : ${f.exclure.join(", ")}`,
      f.attendu && `Attendu : ${f.attendu}`].filter(Boolean);
    if (details.length) lignes.push("", ...details.map(e));
    lignes.push(`Sources : ${r.recherche.sources.map((s) => SOURCES[s]).join(", ")}`);
    if (r.recherche.requetes.length) lignes.push(`Recherches : ${e(r.recherche.requetes.join(" · "))}`);
    if (r.periode.type !== "ponctuelle" && f.quand) lignes.push(`Présentée ${r.presentation.jours_avant ? `à partir de ${r.presentation.jours_avant} jour${r.presentation.jours_avant > 1 ? "s" : ""} avant` : "le jour même"}`);
  }
  if (r.derniere_application) lignes.push("", `Dernière application : ${dateCourte(r.derniere_application)}`);
  return lignes.join("\n");
}

export function clavierRegle(r, ctx) {
  const etat = etatRegle(r, ctx.aujourdHui);
  const recherche = regleDeRecherche(r);
  const clavier = [
    [b("✏️ Titre", `a:rf:${r.id}:titre`), b("✏️ Consigne", `a:rf:${r.id}:consigne`)],
    [b("📅 Période", `m:rperiode:${r.id}`), b("⏰ Condition", `m:rcond:${r.id}`)],
    [b("🧩 Place et longueur", `m:rplace:${r.id}`), b(recherche ? "🔎 Recherche et sources" : "🔎 Ajouter une recherche", `m:rrech:${r.id}`)],
    [b(r.importance === "prioritaire" ? "⭐ Prioritaire" : "☆ Normale", `a:ri:${r.id}`),
     b(etat === "pause" ? "▶ Réactiver" : "⏸ Pause", `a:rp:${r.id}`), b("🗑 Supprimer", `m:rsuppr:${r.id}`)],
  ];
  if (recherche) clavier.push([b("📝 Résultats écrits", `a:rl:${r.id}:ecrit`), b("🎧 Mini-podcast", `a:rl:${r.id}:audio`)]);
  else clavier.push([b("🎧 Essayer dans un épisode maintenant", `a:re:${r.id}`)]);
  clavier.push([b("◀ Rubriques", "m:regles:active:0")]);
  return clavier;
}

// ─────────────────────── tableau de bord (épinglé) ──────────────────────────

export function tableauDeBord(config, etat, ctx) {
  const prochain = prochainEpisode(config.planning, ctx.maintenant);
  const actives = config.regles.filter((r) => etatRegle(r, ctx.aujourdHui) === "active");
  const dernier = etat.episodes?.at(-1);
  const semaine = JOURS.map((j) => `${COURTS_JOURS[j]} ${config.planning.jours[j] ? h(config.planning.jours[j]) : "—"}`).join(" · ");
  return [
    "📌 <b>Tableau de bord</b>",
    prochain ? `⏭ Prochain épisode : <b>${dateCourte(prochain.date)} à ${heureParlee(prochain.heure)}</b>` : "⏭ Aucun épisode prévu",
    `🗓 ${semaine}`,
    `🎙️ ${config.format.duree_minutes} min · ${config.format.nombre_sujets} sujets · ${TONS[config.format.ton].toLowerCase()} · vitesse ${config.voix.vitesse}`,
    `🗣️ ${e(config.voix.animateurs[0].nom)} (${config.voix.animateurs[0].voix}) & ${e(config.voix.animateurs[1].nom)} (${config.voix.animateurs[1].voix})`,
    `📍 ${e(config.actus.ville) || "ville non précisée"}`,
    `📌 Rubriques actives : ${actives.length ? e(actives.map((r) => `${r.id} ${r.titre}`).join(" · ")) : "aucune"}`,
    config.a_approfondir?.length ? `🔎 À creuser au prochain épisode : ${e(config.a_approfondir.map((a) => a.sujet).join(" · "))}` : "",
    dernier ? `🎧 Dernier épisode : ${dateCourte(dernier.date)} — ${e(dernier.titre)}${dernier.avis ? ` ${dernier.avis === "up" ? "👍" : "👎"}` : ""}` : "",
  ].filter(Boolean).join("\n");
}

export function clavierTableau(adresseApp = null) {
  const clavier = [[b("⚙️ Réglages", "m:accueil"), b("📌 Rubriques", "m:regles:active:0"), b("🎙️ Épisode maintenant", "a:podcast")]];
  if (adresseApp) clavier.unshift([{ text: "📱 Ouvrir l'application", web_app: { url: adresseApp } }]);
  return clavier;
}

// ───────────────────────── boutons sous l'épisode ───────────────────────────

export function clavierEpisode(date, nombreSujets, coches = [], details = []) {
  const c = new Set(coches);
  const m = (cle, texte) => b(`${c.has(cle) ? "✓ " : ""}${texte}`, `e:${date}:${cle}`);
  const sujets = Array.from({ length: Math.min(nombreSujets, 5) }, (_, i) => m(`cr${i + 1}`, `🔎 Sujet ${i + 1}`));
  const clavier = [
    [m("up", "👍"), m("down", "👎")],
    [m("court", "Plus court"), m("long", "Plus long"), m("lent", "Moins vite"), m("vite", "Plus vite")],
  ];
  if (sujets.length) clavier.push(sujets);
  clavier.push([m("txt", "📝 Texte"), m("redo", "🔁 Refaire")]);
  for (const id of (details || []).slice(0, 2)) clavier.push([b(`📍 Détails des idées (${id})`, `a:rl:${id}:ecrit`)]);
  return clavier;
}

export function clavierAvisNegatif(date) {
  return [
    [b("Trop long", `f:${date}:long`), b("Trop court", `f:${date}:court`)],
    [b("Trop rapide", `f:${date}:vite`), b("Trop lent", `f:${date}:lent`)],
    [b("Sujets sans intérêt", `f:${date}:sujets`), b("Ton à revoir", `f:${date}:ton`)],
    [b("Autre (je t'explique)", `f:${date}:autre`)],
  ];
}

export function aide() {
  return `🎙️ <b>Ton podcast du matin</b>

<b>Parle-moi simplement</b>, par écrit ou en vocal :
• « 6 h 45 en semaine, 9 h le samedi, rien le dimanche »
• « fais des épisodes de 4 minutes, un peu plus lentement »
• « chaque jour, ajoute une rubrique saint du jour entre l'agenda et les news »
• « samedi, je veux faire une sortie avec les enfants autour d'Yverdon, en train, moins de 20 CHF par personne »
• « le sport ne m'intéresse pas », « creuse ce sujet demain »

<b>Ou utilise les boutons</b> : ⚙️ Réglages, 📌 Rubriques, 🔎 Recherche, et ceux sous chaque épisode.

/menu tous les réglages · /podcast nouvel épisode · /rubriques · /recherche · /planning · /annuler`;
}
