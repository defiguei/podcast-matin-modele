"""Modes lancés par le bot en dehors de l'épisode du matin.

  - Résultats de recherche (« Chercher maintenant ») : idées concrètes pour une
    ou plusieurs règles (prix, accès, liens), montrées dans l'application.
  - Mini-podcast (« 🎧 ») : les mêmes idées, racontées par les deux voix.
  - Point (recherche ponctuelle « point ») : un podcast de quelques minutes qui fait l'état
    des lieux d'un sujet à l'heure actuelle (« les retards CFF en ce moment »), hors épisode.
  - Rubriques essentielles (Agenda, Mes déplacements, Actu locale, À creuser, Actualités) : « Chercher
    maintenant » (un point écrit) et « Mini-podcast » (un point audio), depuis le menu de leur fiche.
  - Extraits de voix : pour choisir les voix des animateurs.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import time
from typing import Any

import pays
import podcast as p
import regles as moteur
from sources import Sources

VOIX = {
    "Aoede": "aérienne", "Kore": "ferme", "Leda": "jeune", "Zephyr": "lumineuse", "Callirrhoe": "décontractée",
    "Autonoe": "claire", "Despina": "douce", "Erinome": "nette", "Laomedeia": "enjouée", "Achernar": "feutrée",
    "Gacrux": "mûre", "Pulcherrima": "affirmée", "Vindemiatrix": "délicate", "Sulafat": "chaleureuse",
    "Puck": "pétillante", "Charon": "posée", "Fenrir": "énergique", "Orus": "ferme", "Enceladus": "soufflée",
    "Iapetus": "claire", "Umbriel": "détendue", "Algieba": "veloutée", "Algenib": "rocailleuse",
    "Rasalgethi": "informative", "Alnilam": "solide", "Schedar": "égale", "Achird": "amicale",
    "Zubenelgenubi": "familière", "Sadachbia": "vive", "Sadaltager": "savante",
}


# ──────────────────────────────── idées ─────────────────────────────────────

def schema_idees() -> dict:
    texte = {"type": "string"}
    return {"type": "object", "properties": {
        "intro": texte,
        "idees": {"type": "array", "maxItems": 5, "items": {"type": "object", "properties": {
            "titre": texte, "resume": texte, "pourquoi": texte, "prix": texte,
            "dans_le_budget": {"type": "boolean"}, "duree": texte, "horaires": texte,
            "lieu": texte, "adresse": texte, "lien": texte, "source": texte, "acces": texte,
        }, "required": ["titre", "resume", "lieu"]}},
        "conseil": texte, "resume_partage": texte,
    }, "required": ["intro", "idees", "resume_partage"]}


def consigne_idees(ville: str, exclues: list[str], tutoiement: bool) -> str:
    deja = f"\nNe repropose pas : {', '.join(exclues)}." if exclues else ""
    adresse = "Tutoie" if tutoiement else "Vouvoie"
    profil = pays.profil()
    return f"""Tu organises des sorties et des activités pour {profil['habitant']} (ville : {ville or "inconnue"}). {adresse} l'auditeur.
À partir UNIQUEMENT des informations fournies (recherche web, lieux OpenStreetMap, Wikivoyage, météo, horaires de train), propose 3 à 5 idées concrètes qui respectent la fiche : budget, âges, transport, envies, éléments à inclure ou à exclure.
Pour chaque idée :
- titre : court et précis (le nom du lieu ou de l'activité) ;
- resume : deux phrases concrètes ;
- pourquoi : pourquoi elle convient à cette demande ;
- prix : seulement si une source le donne (ex. « 12 {profil['devise']} adulte, gratuit jusqu'à 6 ans »), sinon « prix à vérifier » ; dans_le_budget : true si c'est compatible avec le budget ;
- duree : durée conseillée ; horaires : seulement si une source les donne ;
- lieu : le nom précis du lieu, pour le situer sur une carte ; adresse : si elle est connue ;
- lien : l'adresse web d'une source fournie qui parle de cette idée (jamais une adresse inventée), source : le nom du site ;
- acces : comment y aller depuis {ville or "chez l'auditeur"} avec le transport choisi (temps de train fourni, distance…).
intro : une phrase qui situe le contexte (météo prévue, saison…). conseil : un conseil pratique utile (réserver, prévoir…).
resume_partage : 250 caractères au plus, prêt à copier pour proposer la sortie à des amis.
Pour des lieux connus et permanents de la région (musées, châteaux, grottes, parcs, sentiers réputés), tu peux compléter avec tes connaissances générales : indique alors source = « connaissances générales » et laisse lien vide.
N'invente jamais un prix, un horaire ou un événement daté absent des sources : écris « à vérifier ». Si tu manques vraiment de matière, propose moins d'idées.{deja}"""


def liens_autorises(collecte: moteur.Collecte) -> set[str]:
    autorises = {url for _, url in collecte.liens if url}
    autorises |= {lieu["site"] for lieu in collecte.lieux if lieu.get("site")}
    return autorises


def valider_lien(lien: str, autorises: set[str]) -> str:
    lien = (lien or "").strip()
    if not lien.startswith("http"):
        return ""
    if lien in autorises:
        return lien
    domaine = re.sub(r"^https?://(www\.)?", "", lien).split("/")[0]
    for autorise in autorises:          # même site, page différente : on garde la page de la source
        if re.sub(r"^https?://(www\.)?", "", autorise).split("/")[0] == domaine:
            return autorise
    return ""


def trouver_idees(collecte: moteur.Collecte, effectifs: dict, cle_gemini: str, exclues: list[str]) -> dict:
    systeme = consigne_idees(effectifs["ville_habituelle"], exclues, effectifs.get("tutoiement", True))
    modeles = list(dict.fromkeys(effectifs["modeles_texte"] + effectifs["modeles_rapides"]))
    brut, modele = p.demander_json(systeme, collecte.texte, schema_idees(), modeles, cle_gemini, delai=150, tours=2)
    autorises = liens_autorises(collecte)
    idees = []
    for idee in brut.get("idees") or []:
        if not isinstance(idee, dict) or not str(idee.get("titre", "")).strip():
            continue
        propre = {k: re.sub(r"\s+", " ", str(idee.get(k) or "")).strip()[:400] for k in
                  ("titre", "resume", "pourquoi", "prix", "duree", "horaires", "lieu", "adresse", "source", "acces")}
        propre["titre"] = propre["titre"][:90]
        propre["lien"] = valider_lien(str(idee.get("lien") or ""), autorises)
        propre["dans_le_budget"] = bool(idee.get("dans_le_budget"))
        idees.append(propre)
    p.journal(f"Recherche {collecte.regle['id']} : {len(idees)} idée(s) par {modele}.")
    return {"intro": str(brut.get("intro") or "")[:400], "idees": idees[:5],
            "conseil": str(brut.get("conseil") or "")[:300],
            "resume_partage": str(brut.get("resume_partage") or "")[:250]}


# ───────────────────────────── mini-podcast ─────────────────────────────────

def mini_podcast(regles_traitees: list[tuple[dict, moteur.Collecte, dict]], effectifs: dict, cle_gemini: str,
                 maintenant: dt.datetime) -> tuple[dict, bytes, int, list[float]]:
    a, b = (x["nom"] for x in effectifs["animateurs"])
    noms = [a, b]
    adresse = "Tutoie" if effectifs.get("tutoiement", True) else "Vouvoie"
    mots = round(2.5 * effectifs.get("mots_par_minute", 180))
    systeme = f"""Tu écris un mini-podcast audio de deux minutes et demie, animé par {a} et {b} à la manière de NotebookLM : une conversation vivante et claire. {adresse} l'auditeur.
Il présente les idées de sortie trouvées pour lui (fournies ci-dessous) : pour chacune, ce que c'est, pourquoi elle lui convient, le prix et l'accès si on les connaît. Termine en lui rappelant que les détails et les liens l'attendent dans l'application.
N'invente rien qui ne soit pas fourni. Pas d'adresse web, pas de markdown, pas d'emoji ; heures et prix écrits comme on les dit.
Longueur : environ {mots} mots. Remplis « titre » (court), « sujets » (les idées, dans l'ordre) et « sources » (liste vide)."""
    matiere = []
    for regle, collecte, resultat in regles_traitees:
        matiere.append(f"Demande : {regle.get('consigne', '')}\nFiche : {moteur.fiche_en_mots((regle.get('recherche') or {}).get('fiche') or {})}")
        if collecte.meteo:
            matiere.append(f"Météo : {Sources.meteo_en_mots(collecte.meteo)}")
        matiere.append(json.dumps(resultat, ensure_ascii=False))
    modeles = list(dict.fromkeys(effectifs["modeles_texte"] + effectifs["modeles_rapides"]))
    brut, _ = p.demander_json(systeme, f"Nous sommes le {p.date_longue(maintenant.date())}.\n\n" + "\n\n".join(matiere),
                              p.schema_script(noms), modeles, cle_gemini, delai=150, tours=2)
    script = p.nettoyer_script(brut, noms)
    minutage: list[float] = []
    pcm, taux = p.synthetiser(script, effectifs, cle_gemini, minutage)
    return script, pcm, taux, minutage


# ───────────────────────────── point sur un sujet ───────────────────────────

def consigne_point(titre: str, minutes: int, a: str, b: str, mots: int, tutoiement: bool) -> str:
    adresse = "Tutoie" if tutoiement else "Vouvoie"
    return f"""Tu écris un podcast audio de {minutes} minute{"s" if minutes > 1 else ""}, animé par {a} et {b}, qui fait le point sur « {titre} » à l'heure actuelle. {adresse} l'auditeur.
C'est un état des lieux, pas une revue de presse : commence par la réponse (où en est-on aujourd'hui), puis les causes, les chiffres, ce qui change ou va changer, et ce que ça implique concrètement pour l'auditeur. Regroupe par idée, pas article par article ; ne lis pas de titres d'articles.
Appuie-toi UNIQUEMENT sur la matière fournie (recherche web, actualités, horaires). Date les faits (« depuis lundi », « en septembre ») ; si les sources se contredisent ou datent, dis-le ; si la matière est maigre, dis franchement ce qu'on ne sait pas plutôt que de remplir.
Pas d'adresse web, pas de markdown, pas d'emoji ; chiffres, heures et sigles écrits comme on les dit.
Longueur : environ {mots} mots. Remplis « titre » (court), « sujets » (les idées abordées, dans l'ordre) et « sources » (liste vide)."""


def point_podcast(regle: dict, collecte: moteur.Collecte, effectifs: dict, cle_gemini: str,
                  maintenant: dt.datetime) -> tuple[dict, bytes, int]:
    a, b = (x["nom"] for x in effectifs["animateurs"])
    noms = [a, b]
    minutes = int((regle.get("recherche") or {}).get("minutes") or 3)
    mots = round(minutes * effectifs.get("mots_par_minute", 180))
    titre = (regle.get("rubrique") or {}).get("titre") or regle.get("titre") or "le sujet"
    systeme = consigne_point(titre, minutes, a, b, mots, effectifs.get("tutoiement", True))
    entree = (f"Nous sommes le {p.date_longue(maintenant.date())}, il est {maintenant:%H:%M}.\n"
              f"Demande de l'auditeur : {regle.get('consigne', '')}\n\n{collecte.texte}")
    modeles = list(dict.fromkeys(effectifs["modeles_texte"] + effectifs["modeles_rapides"]))
    brut, _ = p.demander_json(systeme, entree, p.schema_script(noms), modeles, cle_gemini, delai=150, tours=2)
    script = p.nettoyer_script(brut, noms)
    pcm, taux = p.synthetiser(script, effectifs, cle_gemini, [])
    return script, pcm, taux


def lancer_point(regles: list[dict], collectes: list[moteur.Collecte], effectifs: dict, cle_gemini: str,
                 maintenant: dt.datetime, bot: Any) -> int:
    """Un podcast par recherche « point », déposé chez le bot (écoute dans l'application)."""
    for regle, collecte in zip(regles, collectes):
        script, pcm, taux = point_podcast(regle, collecte, effectifs, cle_gemini, maintenant)
        mp3 = p.encoder_mp3(pcm, taux, effectifs["debit_mp3_kbps"])
        duree = round(len(pcm) / (2 * taux))
        nom_bot = f"{maintenant:%Y-%m}/point-{regle['id']}-{maintenant:%Y-%m-%d-%H%M%S}.mp3"
        audio_bot = nom_bot if bot.deposer(nom_bot, mp3, "audio/mpeg") else None
        sources = [{"titre": t, "lien": u} for t, u in dict.fromkeys(collecte.liens) if u.startswith("https://")][:8]
        if not audio_bot:
            raise p.ErreurPodcast("Le bot n'a pas pu garder le podcast : rien n'est parti (bot injoignable ?).")
        bot.evenement({"type": "recherche", "regles": [regle["id"]], "idees": [], "format": "point",
                       "audio": audio_bot, "titre_audio": script["titre"], "duree": duree,
                       "resultats": [{"regle": regle["id"], "titre": regle.get("titre", ""),
                                      "intro": " · ".join(script.get("sujets") or [])[:400], "conseil": "", "idees": [],
                                      "sources": sources}]})
        p.journal(f"Point « {regle.get('titre', '')} » envoyé ({duree} s) ✅")
    return 0


# ─────────────────── rubriques essentielles, à la demande ───────────────────

# Menu « ··· » de la fiche d'une rubrique essentielle : elle n'est pas une règle, on en fabrique une
# pour la durée de la recherche (mêmes sources que dans l'épisode). « Chercher maintenant » rend un
# point écrit, « Mini-podcast » un point audio (format « point »).
ESSENTIELLES = {
    "agenda": ("Agenda", ["agenda"]),
    "deplacements": ("Mes déplacements", ["agenda", "web", "actus"]),
    "actu_locale": ("Actu locale", ["actus"]),
    "approfondissements": ("À creuser", ["web", "actus"]),
    "actualites": ("Actualités", ["medias"]),   # tes médias, lus directement (voir ajouter_medias)
}
assert set(ESSENTIELLES) == set(p.RUBRIQUES_ESSENTIELLES)


def regle_essentielle(rubrique: str, config: dict, ville: str) -> dict:
    titre, sources = ESSENTIELLES[rubrique]
    actus = config.get("actus") or {}
    requetes: list[str] = []
    if rubrique == "agenda":
        consigne = "Mes rendez-vous du jour (heure, lieu, ce qu'il faut préparer), puis un aperçu des jours suivants."
    elif rubrique == "deplacements":
        consigne = ("Si mon agenda annonce un voyage ou une sortie ailleurs : quand c'est, deux ou trois idées sur place "
                    "et les actualités du lieu. Sinon, dis simplement qu'aucun déplacement n'est prévu.")
    elif rubrique == "actu_locale":
        ville_locale = str(actus.get("ville") or ville or "").strip()
        if not ville_locale:
            raise p.ErreurPodcast("Ta ville n'est pas précisée : ajoute-la dans Réglages › Moi pour avoir l'actu locale.")
        requetes = [f"actualité {ville_locale}"]
        consigne = f"Une ou deux nouvelles de {ville_locale}, et ce qu'elles changent au quotidien."
    elif rubrique == "approfondissements":
        sujets = [str(a.get("sujet") or "").strip() for a in config.get("a_approfondir") or [] if isinstance(a, dict)]
        sujets = [x for x in sujets if x]
        if not sujets:
            raise p.ErreurPodcast("Rien à creuser pour l'instant : ajoute un sujet dans « À creuser ».")
        requetes = sujets[:3]
        consigne = "Fais le point sur les sujets que j'ai demandé de creuser : " + " ; ".join(sujets) + "."
    else:
        consigne = "Les sujets importants du jour : mon pays d'abord, puis l'international."
    return {"id": rubrique, "titre": titre, "consigne": consigne, "rubrique": {"titre": titre},
            "recherche": {"fiche": {}, "sources": list(sources), "requetes": requetes, "rendu": "point", "minutes": 3}}


def ajouter_medias(collecte: moteur.Collecte, effectifs: dict, maintenant: dt.datetime) -> None:
    """Actualités : les articles récents des médias de l'auditeur (ceux de ses épisodes)."""
    articles, _ = p.lire_actualites(effectifs, maintenant)
    if not articles:
        collecte.texte += "\n\nMédias de l'auditeur : aucun article récent n'a pu être lu."
        return
    lignes = ["Articles récents de ses médias :"]
    for article in articles[:15]:
        lignes.append(f"  - {article.source} — {article.titre}" + (f" : {article.resume}" if article.resume else ""))
        if article.lien.startswith("https://"):
            collecte.liens.append((article.titre, article.lien))
    collecte.texte += "\n\n" + "\n".join(lignes)


def schema_resume() -> dict:
    texte = {"type": "string"}
    return {"type": "object", "properties": {"titre": texte, "texte": texte}, "required": ["titre", "texte"]}


def resume_ecrit(regle: dict, collecte: moteur.Collecte, effectifs: dict, cle_gemini: str,
                 maintenant: dt.datetime) -> dict:
    """Le point écrit d'une rubrique essentielle (« Chercher maintenant »)."""
    titre = (regle.get("rubrique") or {}).get("titre") or regle.get("titre", "")
    adresse = "Tutoie" if effectifs.get("tutoiement", True) else "Vouvoie"
    systeme = f"""Tu rédiges, pour l'auditeur, le point écrit de sa rubrique « {titre} » à l'heure actuelle. {adresse} l'auditeur.
Trois à six phrases courtes (une centaine de mots), les faits d'abord (heures, lieux, chiffres, dates), pas de liste à puces, pas de markdown, pas d'emoji, pas d'adresse web.
Appuie-toi UNIQUEMENT sur la matière fournie ; si elle est maigre ou vide, dis franchement ce qu'on ne sait pas plutôt que de remplir.
Remplis « titre » (court) et « texte »."""
    modeles = list(dict.fromkeys(effectifs["modeles_rapides"] + effectifs["modeles_texte"]))
    brut, _ = p.demander_json(systeme, f"Nous sommes le {p.date_longue(maintenant.date())}, il est {maintenant:%H:%M}.\n"
                              f"Demande : {regle.get('consigne', '')}\n\n{collecte.texte}", schema_resume(), modeles, cle_gemini,
                              delai=90, tours=2)
    return {"titre": p.tronquer(str(brut.get("titre") or titre).strip(), 60) or titre,
            "texte": re.sub(r"\s+", " ", str(brut.get("texte") or "")).strip()}


def lancer_ecrit_essentielles(regles: list[dict], collectes: list[moteur.Collecte], effectifs: dict, cle_gemini: str,
                              maintenant: dt.datetime, bot: Any) -> int:
    """Un point écrit par rubrique essentielle, montré dans l'application."""
    for regle, collecte in zip(regles, collectes):
        resume = resume_ecrit(regle, collecte, effectifs, cle_gemini, maintenant)
        sources = [{"titre": t, "lien": u} for t, u in dict.fromkeys(collecte.liens) if u.startswith("https://")][:8]
        bot.evenement({"type": "recherche", "regles": [regle["id"]], "idees": [], "format": "ecrit",
                       "audio": None, "titre_audio": "", "duree": 0,
                       "resultats": [{"regle": regle["id"], "titre": regle.get("titre", ""), "intro": resume["texte"],
                                      "conseil": "", "idees": [], "sources": sources}]})
        p.journal(f"Point écrit « {regle.get('titre', '')} » envoyé ✅")
    return 0


# ───────────────────────── synthèse d'une rubrique ──────────────────────────

def resume_rubrique(identifiant: str, effectifs: dict, cle_gemini: str, maintenant: dt.datetime, bot: Any) -> int:
    """Mini-podcast qui résume ce que la rubrique a raconté ces derniers jours (texte et sources gardés par le bot)."""
    entrees = bot.rubrique(identifiant)
    if not entrees:
        raise p.ErreurPodcast("Le bot n'a encore rien gardé de cette rubrique : elle doit d'abord passer dans un épisode.")
    config = effectifs.get("config_bot") or {}
    regle = next((r for r in config.get("regles") or [] if r.get("id") == identifiant), {})
    titre_rubrique = regle.get("titre") or (entrees[-1].get("titre") if entrees else "") or identifiant
    a, b = (x["nom"] for x in effectifs["animateurs"])
    noms = [a, b]
    adresse = "Tutoie" if effectifs.get("tutoiement", True) else "Vouvoie"
    mots = round(3 * effectifs.get("mots_par_minute", 180))
    systeme = f"""Tu écris un mini-podcast audio de trois minutes, animé par {a} et {b}, qui fait le point sur la rubrique « {titre_rubrique} » à partir de ce qu'elle a déjà raconté ces derniers jours (fourni ci-dessous, du plus ancien au plus récent). {adresse} l'auditeur.
Regroupe par thème plutôt que jour par jour, relève ce qui revient ou évolue, dis ce qui est encore d'actualité et ce qui est dépassé. N'invente rien qui ne soit pas dans la matière ; pas d'adresse web, pas de markdown, pas d'emoji.
Longueur : environ {mots} mots. Remplis « titre » (court), « sujets » (les thèmes, dans l'ordre) et « sources » (liste vide)."""
    matiere = []
    for entree in entrees[-14:]:
        liens = "; ".join(s.get("titre", "") for s in entree.get("sources") or [])
        matiere.append(f"[{entree.get('date', '')}]\n{entree.get('texte', '')}" + (f"\nSources citées : {liens}" if liens else ""))
    modeles = list(dict.fromkeys(effectifs["modeles_texte"] + effectifs["modeles_rapides"]))
    brut, _ = p.demander_json(systeme, f"Nous sommes le {p.date_longue(maintenant.date())}.\n\n" + "\n\n".join(matiere),
                              p.schema_script(noms), modeles, cle_gemini, delai=150, tours=2)
    script = p.nettoyer_script(brut, noms)
    minutage: list[float] = []
    pcm, taux = p.synthetiser(script, effectifs, cle_gemini, minutage)
    mp3 = p.encoder_mp3(pcm, taux, effectifs["debit_mp3_kbps"])
    duree = round(len(pcm) / (2 * taux))
    nom_bot = f"{maintenant:%Y-%m}/resume-{identifiant}-{maintenant:%Y-%m-%d-%H%M%S}.mp3"
    audio_bot = nom_bot if bot.deposer(nom_bot, mp3, "audio/mpeg") else None
    if not audio_bot:
        raise p.ErreurPodcast("Le bot n'a pas pu garder la synthèse : rien n'est parti (bot injoignable ?).")
    bot.evenement({"type": "resume", "rubrique": identifiant, "audio": audio_bot, "titre": script["titre"], "duree": duree})
    p.journal(f"Synthèse de « {titre_rubrique} » envoyée ✅")
    return 0


# ──────────────────────────────── principal ─────────────────────────────────

def lancer(identifiants: list[str], format_: str, effectifs: dict, cle_gemini: str, maintenant: dt.datetime,
           bot: Any, export: dict, sans_envoi: bool = False) -> int:
    config = effectifs.get("config_bot") or {}
    jour = maintenant.date()
    ville = effectifs["ville_habituelle"]
    essentielles = [i for i in identifiants if i in ESSENTIELLES]
    if essentielles:        # menu « ··· » d'une rubrique essentielle : une seule à la fois
        regles = [regle_essentielle(essentielles[0], config, ville)]
    else:
        regles = [r for r in config.get("regles") or [] if r.get("id") in identifiants]
    if not regles:
        raise p.ErreurPodcast(f"rubrique introuvable ({', '.join(identifiants) or 'aucune'}).")
    agenda: list[str] = []
    if any(r.get("condition") or "agenda" in ((r.get("recherche") or {}).get("sources") or []) for r in regles):
        urls = p.separer_urls(os.environ.get("CALENDAR_ICS_URL", ""))
        if essentielles and not urls:
            raise p.ErreurPodcast("Aucun agenda n'est branché : ajoute-en un dans Réglages › Connexions.")
        if urls:
            evenements, _ = p.lire_agendas(urls, effectifs, maintenant, 31)
            agenda = moteur.agenda_pour_plan(evenements, p.quand_court)

    def demander(systeme: str, entree: str, schema: dict) -> dict:
        return p.demander_json(systeme, entree, schema, effectifs["modeles_rapides"], cle_gemini, delai=90, tours=1)[0]

    plans = moteur.planifier(regles, agenda, jour, ville, demander)
    sources = Sources(os.environ.get("TAVILY_API_KEY", ""))

    def actus(requete: str) -> list[str]:
        return [f"{a.source} — {a.titre}" for a in p.chercher_actus(requete, effectifs, maintenant, 4, 14)]

    precedents = export.get("derniers_resultats") or {}
    exclues = precedents.get("idees", []) if set(precedents.get("regles", [])) & set(identifiants) else []
    traitees = []
    point = format_ == "point"
    ecrit_essentielle = bool(essentielles) and not point
    collectes: list[moteur.Collecte] = []
    for regle in regles[:3]:
        plan = plans[regle["id"]]
        # Seules les sources cochées dans sa fiche (recherche web et lieux par défaut).
        regle_large = {**regle, "recherche": {**(regle.get("recherche") or {"fiche": {}, "requetes": []}),
                                              "sources": (regle.get("recherche") or {}).get("sources") or ["web", "lieux"]}}

        def flux_specialise(flux: dict) -> list[str]:
            return [a.titre + (f" : {a.resume}" if a.resume else "") for a in p.lire_flux_specialise(flux, maintenant, jours=14)]

        collecte = moteur.collecter(regle_large, plan, sources, jour, ville, actus, profondeur=2,
                                    config=config, lire_flux=flux_specialise, agenda=agenda)
        if essentielles and regle["id"] == "actualites":
            ajouter_medias(collecte, effectifs, maintenant)
        if point or ecrit_essentielle:      # un état des lieux : pas d'idées à trouver
            collectes.append(collecte)
            continue
        traitees.append((regle, collecte, trouver_idees(collecte, effectifs, cle_gemini, exclues)))
    if sources.credits_tavily:
        p.journal(f"Recherche web : {sources.credits_tavily} crédit(s) Tavily.")

    if ecrit_essentielle:
        if sans_envoi or not bot.secret:
            for regle, collecte in zip(regles, collectes):
                print(f"{regle['id']} :\n{collecte.texte}")
            return 0
        return lancer_ecrit_essentielles(regles[:1], collectes, effectifs, cle_gemini, maintenant, bot)

    if point:
        if sans_envoi or not bot.secret:
            for regle, collecte in zip(regles, collectes):
                print(f"{regle['id']} :\n{collecte.texte}")
            return 0
        return lancer_point(regles[:3], collectes, effectifs, cle_gemini, maintenant, bot)

    if sans_envoi or not bot.secret:
        for regle, _, resultat in traitees:
            print(json.dumps({"regle": regle["id"], **resultat}, ensure_ascii=False, indent=2))
        return 0

    audio_bot, titre_audio, duree = None, "", 0
    if format_ == "audio":
        script, pcm, taux, minutage = mini_podcast(traitees, effectifs, cle_gemini, maintenant)
        mp3 = p.encoder_mp3(pcm, taux, effectifs["debit_mp3_kbps"])
        duree = round(len(pcm) / (2 * taux))
        titre_audio = script["titre"]
        # Gardé par le bot : il s'écoute dans l'application (Idées trouvées).
        nom_bot = f"{maintenant:%Y-%m}/idees-{maintenant:%Y-%m-%d-%H%M%S}.mp3"
        audio_bot = nom_bot if bot.deposer(nom_bot, mp3, "audio/mpeg") else None
        if not audio_bot:
            raise p.ErreurPodcast("Le bot n'a pas pu garder le mini-podcast : rien n'est parti (bot injoignable ?).")
    bot.evenement({"type": "recherche", "regles": [r["id"] for r, _, _ in traitees],
                   "idees": [i["titre"] for _, _, res in traitees for i in res["idees"]][:10],
                   "format": format_, "audio": audio_bot, "titre_audio": titre_audio, "duree": duree,
                   # Pour l'application : les idées complètes, rubrique par rubrique.
                   "resultats": [{"regle": r["id"], "titre": r.get("titre", ""), "intro": res.get("intro", ""),
                                  "conseil": res.get("conseil", ""), "idees": res["idees"]} for r, _, res in traitees]})
    p.journal("Résultats envoyés ✅")
    return 0


def echantillons(liste: str, effectifs: dict, cle_gemini: str, bot: Any, sans_envoi: bool = False) -> int:
    """Extraits de voix, deux par deux (une requête de voix pour deux voix), gardés par le bot.
    Il reçoit le début et la fin de chaque voix dans le fichier : l'application
    lit ainsi une seule voix à la fois."""
    voix = [v for v in (x.strip().capitalize() for x in liste.split(",")) if v in VOIX][:8]
    if not voix:
        raise p.ErreurPodcast("aucune voix reconnue.")
    for i in range(0, len(voix), 2):
        paire = voix[i:i + 2]
        premiere, seconde = paire[0], paire[1] if len(paire) > 1 else paire[0]
        animateurs = [{"nom": premiere, "voix": premiere},
                      {"nom": seconde if seconde != premiere else f"{premiere} bis", "voix": seconde}]
        script = {"titre": f"Voix {premiere} et {seconde}", "sujets": [], "sources": [], "repliques": [
            {"animateur": animateurs[0]["nom"], "texte": f"Bonjour ! Moi, c'est la voix {premiere}, plutôt {VOIX[premiere]}. "
             "Voilà comment je t'annoncerais ta journée : à neuf heures, réunion d'équipe, et à midi, déjeuner au bord du lac."},
            {"animateur": animateurs[1]["nom"], "texte": (f"Et moi, la voix {seconde}, plutôt {VOIX[seconde]}. "
             "Côté actualité, je te raconterais l'essentiel en deux minutes, avec le sourire.") if seconde != premiere
             else "Et voici la même voix, quand elle relance la conversation : alors, on commence par quoi ce matin ?"},
        ]}
        eff = {**effectifs, "animateurs": animateurs, "vitesse_parole": "normale"}
        minutage: list[float] = []
        pcm, taux = p.synthetiser(script, eff, cle_gemini, minutage)
        mp3 = p.encoder_mp3(pcm, taux, effectifs["debit_mp3_kbps"])
        duree = round(len(pcm) / (2 * taux), 1)
        coupure = minutage[1] if len(minutage) == 2 else round(duree / 2, 1)
        temps = {premiere: [0.0, coupure], seconde: [coupure, duree]} if seconde != premiere else {premiere: [0.0, duree]}
        if sans_envoi or not bot.secret:
            p.journal(f"Extrait {premiere}/{seconde} prêt ({len(mp3)} octets).")
            continue
        nom_bot = f"voix/{premiere}-{seconde}-{int(time.time())}.mp3"
        if not bot.deposer(nom_bot, mp3, "audio/mpeg"):
            raise p.ErreurPodcast("Le bot n'a pas pu garder l'extrait (bot injoignable ?).")
        for nom in set(paire):
            bot.evenement({"type": "echantillon", "voix": nom, "fichier": nom_bot, "debut": temps[nom][0], "fin": temps[nom][1]})
    return 0
