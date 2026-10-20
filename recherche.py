"""Modes lancés par le bot en dehors de l'épisode du matin.

  - Résultats de recherche (« 📝 Résultats écrits ») : idées concrètes pour une
    ou plusieurs règles, avec photo, lieu sur la carte, liens, sondage.
  - Mini-podcast (« 🎧 ») : les mêmes idées, racontées par les deux voix.
  - Extraits de voix : pour choisir les voix des animateurs.
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
from typing import Any

import podcast as p
import regles as moteur
from sources import Sources, cle, lien_itineraire

VOIX = {
    "Aoede": "aérienne", "Kore": "ferme", "Leda": "jeune", "Zephyr": "lumineuse", "Callirrhoe": "décontractée",
    "Autonoe": "claire", "Despina": "douce", "Erinome": "nette", "Laomedeia": "enjouée", "Achernar": "feutrée",
    "Gacrux": "mûre", "Pulcherrima": "affirmée", "Vindemiatrix": "délicate", "Sulafat": "chaleureuse",
    "Puck": "pétillante", "Charon": "posée", "Fenrir": "énergique", "Orus": "ferme", "Enceladus": "soufflée",
    "Iapetus": "claire", "Umbriel": "détendue", "Algieba": "veloutée", "Algenib": "rocailleuse",
    "Rasalgethi": "informative", "Alnilam": "solide", "Schedar": "égale", "Achird": "amicale",
    "Zubenelgenubi": "familière", "Sadachbia": "vive", "Sadaltager": "savante",
}
e = p.echapper


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
    return f"""Tu organises des sorties et des activités pour un habitant de Suisse romande (ville : {ville or "inconnue"}). {adresse} l'auditeur.
À partir UNIQUEMENT des informations fournies (recherche web, lieux OpenStreetMap, Wikivoyage, météo, horaires de train), propose 3 à 5 idées concrètes qui respectent la fiche : budget, âges, transport, envies, éléments à inclure ou à exclure.
Pour chaque idée :
- titre : court et précis (le nom du lieu ou de l'activité) ;
- resume : deux phrases concrètes ;
- pourquoi : pourquoi elle convient à cette demande ;
- prix : seulement si une source le donne (ex. « 12 CHF adulte, gratuit jusqu'à 6 ans »), sinon « prix à vérifier » ; dans_le_budget : true si c'est compatible avec le budget ;
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


def situer(idee: dict, collecte: moteur.Collecte, sources: Sources, ville: str) -> dict | None:
    """Coordonnées de l'idée : lieu OpenStreetMap correspondant, Wikipédia, puis Nominatim."""
    nom = cle(idee.get("lieu") or idee.get("titre") or "")
    if not nom:
        return None
    for lieu in collecte.lieux:
        nom_lieu = cle(lieu["nom"])
        if nom_lieu and (nom_lieu in nom or nom in nom_lieu):
            return {"lat": lieu["lat"], "lon": lieu["lon"], "adresse": lieu.get("adresse", "")}
    requete = ", ".join(x for x in (idee.get("adresse") or idee.get("lieu"), "" if idee.get("adresse") else ville) if x)
    trouve = sources.nominatim_chercher(requete)
    if trouve:
        return trouve
    article = sources.wikipedia(idee.get("lieu") or idee.get("titre"))
    if article and article.get("lat") is not None and cle(article["titre"])[:12] in nom:
        return {"lat": article["lat"], "lon": article["lon"], "adresse": ""}
    return None


def image_pour(idee: dict, collecte: moteur.Collecte, sources: Sources, utilisees: set[str]) -> str:
    nom = cle(idee.get("lieu") or idee.get("titre") or "")
    for lieu in collecte.lieux:      # photo Wikipédia du lieu lui-même, si on l'a déjà
        if lieu.get("image") and lieu["image"] not in utilisees and nom and (cle(lieu["nom"]) in nom or nom in cle(lieu["nom"])):
            return lieu["image"]
    article = sources.wikipedia(idee.get("lieu") or idee.get("titre"))
    if article and article.get("image") and cle(article["titre"])[:10] in cle(f"{idee.get('lieu', '')} {idee.get('titre', '')}"):
        if article["image"] not in utilisees:
            return article["image"]
    for image in collecte.images:
        if image not in utilisees and re.search(r"\.(jpe?g|png|webp)(\?|$)", image, re.I):
            return image
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


# ─────────────────────────────── envoi écrit ────────────────────────────────

def carte_idee(numero: int, idee: dict) -> str:
    lignes = [f"<b>{numero}. {e(idee['titre'])}</b>", e(idee["resume"])]
    if idee["pourquoi"]:
        lignes.append(f"💡 {e(idee['pourquoi'])}")
    infos = []
    if idee["prix"]:
        infos.append(f"💰 {e(idee['prix'])}{' ✅' if idee['dans_le_budget'] else ''}")
    if idee["duree"]:
        infos.append(f"⏱ {e(idee['duree'])}")
    if infos:
        lignes.append(" · ".join(infos))
    if idee["horaires"]:
        lignes.append(f"🕒 {e(idee['horaires'])}")
    if idee["acces"]:
        lignes.append(f"🚆 {e(idee['acces'])}")
    if idee["lien"]:
        lignes.append(f'🔗 <a href="{html.escape(idee["lien"], quote=True)}">{e(idee["source"] or "Source")}</a>')
    return "\n".join(lignes)[:1020]


def boutons_idee(idee: dict, ville: str, transport: str) -> list[list[dict]]:
    ligne = []
    if idee["lien"]:
        ligne.append({"text": "🌐 Site", "url": idee["lien"]})
    destination = ", ".join(x for x in (idee["lieu"] or idee["titre"], idee["adresse"]) if x)
    if ville and destination and transport != "aucun":
        ligne.append({"text": "🗺️ Itinéraire", "url": lien_itineraire(ville, destination, transport)})
    return [ligne] if ligne else []


def envoyer_ecrit(telegram: p.Telegram, conversation: str, regle: dict, collecte: moteur.Collecte,
                  resultat: dict, sources: Sources, effectifs: dict) -> dict:
    ville = effectifs["ville_habituelle"]
    fiche = (regle.get("recherche") or {}).get("fiche") or {}
    titre = (regle.get("rubrique") or {}).get("titre") or regle.get("titre", "Recherche")
    entete = [f"🔎 <b>{e(titre)}</b> · {regle['id']}"]
    if resultat["intro"]:
        entete.append(e(resultat["intro"]))
    if collecte.meteo:
        entete.append(f"🌦 {e(Sources.meteo_en_mots(collecte.meteo))}")
    if collecte.trajets:
        entete.append(f"🚆 {e(Sources.trajets_en_mots(collecte.trajets))}")
    budget = moteur.budget_en_mots(fiche)
    if budget:
        entete.append(f"💰 {e(budget)}")
    if not resultat["idees"]:
        entete.append("\nJe n'ai rien trouvé d'assez fiable cette fois. Essaie de préciser la recherche (lieu, type d'activité).")
    telegram.message(conversation, "\n".join(entete))
    utilisees: set[str] = set()
    for numero, idee in enumerate(resultat["idees"], 1):
        texte = carte_idee(numero, idee)
        clavier = boutons_idee(idee, ville, fiche.get("transport", ""))
        image = image_pour(idee, collecte, sources, utilisees)
        envoye = False
        if image:
            donnees = {"chat_id": conversation, "photo": image, "caption": texte, "parse_mode": "HTML"}
            if clavier:
                donnees["reply_markup"] = json.dumps({"inline_keyboard": clavier}, ensure_ascii=False)
            try:
                telegram.appeler("sendPhoto", donnees)
                utilisees.add(image)
                envoye = True
            except p.ErreurPodcast as erreur:
                p.journal(f"Photo refusée par Telegram ({erreur}) : texte seul.")
        if not envoye:
            telegram.message(conversation, texte, clavier)
        position = situer(idee, collecte, sources, ville)
        if position:
            try:
                telegram.appeler("sendVenue", {
                    "chat_id": conversation, "latitude": position["lat"], "longitude": position["lon"],
                    "title": idee["titre"][:64], "address": (idee["adresse"] or position.get("adresse") or idee["lieu"])[:120],
                    "disable_notification": "true"})
            except p.ErreurPodcast as erreur:
                p.journal(f"Lieu non envoyé ({erreur}).")
    return envoyer_suite(telegram, conversation, regle, resultat)


def envoyer_suite(telegram: p.Telegram, conversation: str, regle: dict, resultat: dict) -> dict:
    """Sondage « laquelle te tente ? » et boutons pour la suite."""
    sondage = None
    titres = [i["titre"][:100] for i in resultat["idees"]]
    if len(titres) >= 2:
        base = {"chat_id": conversation, "question": "Laquelle te tente ?", "is_anonymous": "false"}
        for options in (json.dumps([{"text": t} for t in titres], ensure_ascii=False), json.dumps(titres, ensure_ascii=False)):
            try:
                envoi = telegram.appeler("sendPoll", {**base, "options": options})
                sondage = {"poll_id": str((envoi.get("poll") or {}).get("id", "")), "options": titres, "regle": regle["id"]}
                break
            except p.ErreurPodcast as erreur:
                p.journal(f"Sondage refusé ({erreur}).")
    lignes = []
    if resultat["conseil"]:
        lignes.append(f"👉 {e(resultat['conseil'])}")
    lignes.append("Et maintenant ?")
    clavier = []
    if resultat["resume_partage"]:
        clavier.append([{"text": "📋 Copier pour mes amis", "copy_text": {"text": resultat["resume_partage"][:256]}}])
    clavier.append([{"text": "🔁 D'autres idées", "callback_data": f"a:rl:{regle['id']}:ecrit"},
                    {"text": "🎧 En mini-podcast", "callback_data": f"a:rl:{regle['id']}:audio"}])
    clavier.append([{"text": f"📌 Rubrique {regle['id']}", "callback_data": f"m:regle:{regle['id']}"}])
    try:
        telegram.message(conversation, "\n".join(lignes), clavier)
    except p.ErreurPodcast:
        clavier = [ligne for ligne in clavier if not any("copy_text" in b for b in ligne)]
        telegram.message(conversation, "\n".join(lignes), clavier)
    return sondage or {}


# ───────────────────────────── mini-podcast ─────────────────────────────────

def mini_podcast(regles_traitees: list[tuple[dict, moteur.Collecte, dict]], effectifs: dict, cle_gemini: str,
                 maintenant: dt.datetime) -> tuple[dict, bytes, int, list[float]]:
    a, b = (x["nom"] for x in effectifs["animateurs"])
    noms = [a, b]
    adresse = "Tutoie" if effectifs.get("tutoiement", True) else "Vouvoie"
    mots = round(2.5 * effectifs.get("mots_par_minute", 180))
    systeme = f"""Tu écris un mini-podcast audio de deux minutes et demie, animé par {a} et {b} à la manière de NotebookLM : une conversation vivante et claire. {adresse} l'auditeur.
Il présente les idées de sortie trouvées pour lui (fournies ci-dessous) : pour chacune, ce que c'est, pourquoi elle lui convient, le prix et l'accès si on les connaît. Termine en l'invitant à voter dans le sondage qui suit.
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


# ──────────────────────────────── principal ─────────────────────────────────

def lancer(identifiants: list[str], format_: str, effectifs: dict, cle_gemini: str, maintenant: dt.datetime,
           telegram: p.Telegram | None, conversation: str, bot: Any, export: dict, sans_envoi: bool = False) -> int:
    config = effectifs.get("config_bot") or {}
    regles = [r for r in config.get("regles") or [] if r.get("id") in identifiants]
    if not regles:
        raise p.ErreurPodcast(f"rubrique introuvable ({', '.join(identifiants) or 'aucune'}).")
    jour = maintenant.date()
    ville = effectifs["ville_habituelle"]
    agenda: list[str] = []
    if any(r.get("condition") for r in regles):
        urls = p.separer_urls(os.environ.get("CALENDAR_ICS_URL", ""))
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
    for regle in regles[:3]:
        plan = plans[regle["id"]]
        regle_large = {**regle, "recherche": {**(regle.get("recherche") or {"fiche": {}, "requetes": []}),
                                              "sources": sorted(set((regle.get("recherche") or {}).get("sources") or ["web"]) | {"web", "lieux"})}}
        collecte = moteur.collecter(regle_large, plan, sources, jour, ville, actus, profondeur=2)
        traitees.append((regle, collecte, trouver_idees(collecte, effectifs, cle_gemini, exclues)))
    if sources.credits_tavily:
        p.journal(f"Recherche web : {sources.credits_tavily} crédit(s) Tavily.")

    if sans_envoi or not telegram:
        for regle, _, resultat in traitees:
            print(json.dumps({"regle": regle["id"], **resultat}, ensure_ascii=False, indent=2))
        return 0

    sondages = []
    if format_ == "audio":
        script, pcm, taux, minutage = mini_podcast(traitees, effectifs, cle_gemini, maintenant)
        mp3 = p.encoder_mp3(pcm, taux, effectifs["debit_mp3_kbps"])
        duree = round(len(pcm) / (2 * taux))
        lignes = [f"🎧 <b>{e(script['titre'])}</b>", ""]
        for regle, _, resultat in traitees:
            for numero, idee in enumerate(resultat["idees"], 1):
                lien = f' — <a href="{html.escape(idee["lien"], quote=True)}">{e(idee["source"] or "site")}</a>' if idee["lien"] else ""
                lignes.append(f"{numero}. {e(idee['titre'])}{lien}")
        vignette = p.creer_pochette(jour, script["titre"], "IDÉES DE SORTIE")
        telegram.audio(conversation, mp3, f"idees-{jour.isoformat()}.mp3", p.tronquer(script["titre"], 64),
                       " & ".join(a["nom"] for a in effectifs["animateurs"]), "\n".join(lignes)[:1024], duree, vignette)
        for regle, _, resultat in traitees:
            sondages.append(envoyer_suite(telegram, conversation, regle, resultat))
    else:
        for regle, collecte, resultat in traitees:
            sondages.append(envoyer_ecrit(telegram, conversation, regle, collecte, resultat, sources, effectifs))

    sondage = next((s for s in sondages if s.get("poll_id")), None)
    bot.evenement({"type": "recherche", "regles": [r["id"] for r, _, _ in traitees],
                   "idees": [i["titre"] for _, _, res in traitees for i in res["idees"]][:10],
                   "sondage": sondage, "format": format_,
                   # Pour l'application : les idées complètes, rubrique par rubrique.
                   "resultats": [{"regle": r["id"], "titre": r.get("titre", ""), "intro": res.get("intro", ""),
                                  "conseil": res.get("conseil", ""), "idees": res["idees"]} for r, _, res in traitees]})
    p.journal("Résultats envoyés ✅")
    return 0


def echantillons(liste: str, effectifs: dict, cle_gemini: str, telegram: p.Telegram | None, conversation: str,
                 bot: Any, sans_envoi: bool = False, discret: bool = False) -> int:
    """Extraits de voix, deux par deux (une requête de voix pour deux voix).
    Le bot reçoit le début et la fin de chaque voix dans le fichier : l'application
    lit ainsi une seule voix à la fois. « discret » : le message est retiré de la
    conversation dès que Telegram a gardé le fichier (écoute dans l'application)."""
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
        if sans_envoi or not telegram:
            p.journal(f"Extrait {premiere}/{seconde} prêt ({len(mp3)} octets).")
            continue
        legende_audio = f"🎤 <b>{premiere}</b> ({VOIX[premiere]})" + (f" puis <b>{seconde}</b> ({VOIX[seconde]})" if seconde != premiere else "")
        envoi = telegram.audio(conversation, mp3, f"voix-{premiere}-{seconde}.mp3", f"Voix : {premiere} & {seconde}",
                               "Podcast du matin", legende_audio, round(len(pcm) / (2 * taux)))
        file_id = ((envoi or {}).get("audio") or {}).get("file_id")
        if file_id:
            for nom in set(paire):
                bot.evenement({"type": "echantillon", "voix": nom, "file_id": file_id, "legende": legende_audio,
                               "debut": temps[nom][0], "fin": temps[nom][1]})
            if discret and (envoi or {}).get("message_id"):
                telegram.appeler("deleteMessage", {"chat_id": conversation, "message_id": envoi["message_id"]})
    return 0
