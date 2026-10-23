#!/usr/bin/env python3
"""Podcast du matin.

Chaque matin, ce script :
  1. lit tes messages Telegram pour ajuster le podcast (vitesse, sujets…) ;
  2. lit ton agenda (lien iCal secret) et des flux d'actualités (RSS) ;
  3. repère tes déplacements à venir et cherche les actus de ces lieux ;
  4. fait écrire par Gemini un dialogue à deux voix, façon NotebookLM ;
  5. le met en voix avec Gemini TTS et t'envoie le MP3 sur Telegram.

Modes :
  python podcast.py                          → épisode du jour
  python podcast.py --mode rattrapage        → seulement si l'épisode du jour n'est pas parti
  python podcast.py --regles R3,R5           → épisode qui traite aussi ces règles
  python podcast.py --recherche R5 --format ecrit|audio
                                             → résultats d'une recherche (photos, lieux, sondage)
                                               ou mini-podcast sur ces règles
  python podcast.py --echantillons Aoede,Kore → extraits audio de voix
  python podcast.py --retours                → (ancien) lit tes messages Telegram et y répond
  python podcast.py --sans-envoi             → épisode écrit dans sortie/, rien n'est envoyé

Réglages : tenus par le bot (Cloudflare), lus au début de chaque épisode ; à
défaut, sa sauvegarde quotidienne (preferences.json), puis reglages.toml.
Technique (modèles, MP3…) : reglages.toml — Mémoire (débit, dernier épisode) : memoire.json
Clés : secrets GitHub (voir README.md).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import functools
import hashlib
import html
import json
import os
import re
import struct
import sys
import time
import tomllib
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus, urlparse
from zoneinfo import ZoneInfo

import feedparser
import icalendar
import lameenc
import recurring_ical_events
import requests
import x_wr_timezone

import pays as pays_auditeur
import regles as moteur
from liaison import Bot, appliquer_cles, config_de_secours, secrets_presents
from pochette import creer_pochette
from sources import Sources

RACINE = Path(__file__).resolve().parent
FICHIER_MEMOIRE = "memoire.json"
FICHIER_PREFERENCES = "preferences.json"   # tenu par le bot instantané (Cloudflare)
URL_GEMINI = "https://generativelanguage.googleapis.com/v1beta/interactions"
URL_TELEGRAM = "https://api.telegram.org/bot{jeton}/{methode}"
URL_FICHIER_TELEGRAM = "https://api.telegram.org/file/bot{jeton}/{chemin}"
URL_RECHERCHE = "https://news.google.com/rss/search?q={requete}&hl={langue}&gl={pays}&ceid={pays}:{langue}"
NAVIGATEUR = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
TAUX_PAR_DEFAUT = 24_000          # Gemini TTS : 24 kHz, mono, 16 bits
SEUIL_SCRIPT_COURT = 0.9         # sous 90 % des mots visés, on demande plus long
REMPLISSAGE_MIN = 0.5            # un script ne fait jamais moins de la moitié de ce qu'on lui demande (garde-fou)
CARACTERES_PAR_SECONDE = 18       # débit moyen d'une voix française (mesuré : 15 à 21)

JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
        "août", "septembre", "octobre", "novembre", "décembre"]

# Vitesse de parole : consigne de style pour Gemini TTS (champ « style » de chaque
# réplique, documenté avec « speaking slowly » / « speaking rapidly »), et mots par
# minute visés pour que la durée de l'épisode reste juste.
VITESSES: dict[str, tuple[str, int]] = {
    "très lente": ("speaking slowly and calmly", 140),
    "lente": ("speaking a little slowly", 160),
    "normale": ("", 180),
    "rapide": ("speaking a little rapidly", 205),   # mesuré : 206 mots/min
    "très rapide": ("speaking rapidly", 225),
}

# Indices qu'un événement est un déplacement ou une sortie (en plus d'un lieu renseigné).
INDICES_DEPLACEMENT = re.compile(
    r"\b(voyage|vol|avion|train|tgv|h[oô]tel|s[ée]jour|vacances|congr[eè]s|conf[ée]rence|"
    r"salon|week-?end|visite|d[ée]placement|excursion|a[ée]roport|gare|flight|trip|airbnb|"
    r"rencontre|concert|spectacle|th[ée][âa]tre|op[ée]ra|mus[ée]e|expo(sition)?|festival|"
    r"match|restaurant|resto)\b",
    re.IGNORECASE)
INDICE_VILLE = re.compile(r"\b(à|au|aux|en)\s+[A-ZÉÈÀÂÎÔ][\w'-]+")

# Sons non verbaux compris par Gemini TTS ; toute autre balise <...> est retirée.
BALISES_AUTORISEES = {
    "laugh", "laughter", "chuckle", "chuckles", "giggle", "sigh", "sighs",
    "breath", "short pause", "long pause", "gasp", "exhales", "phew", "tsk",
    "snicker", "throat-clearing",
}
MAX_BALISES = 6
MAX_REACTIONS = 4

# Ton de l'épisode (réglé depuis le bot).
TONS = {
    "naturel": "",
    "serieux": "Ton sérieux et posé : peu de plaisanteries, des transitions sobres.",
    "detendu": "Ton détendu et complice, comme entre amis.",
    "humour": "Beaucoup d'humour et de légèreté, sans jamais tourner en dérision un sujet grave.",
}
CITER_SOURCES = ("non", "oral", "ecrit", "les_deux")
INSTRUCTIONS_RUBRIQUES = {
    "ouverture": "Ouverture (2 ou 3 répliques) : salutation, jour et date, ce qui attend l'auditeur aujourd'hui.",
    "agenda": ("L'agenda : d'abord les rendez-vous d'aujourd'hui (heure, lieu, ce qu'il faut préparer ou ne pas "
               "oublier), puis un aperçu des jours suivants en mettant en avant ce qui demande d'anticiper. Si rien "
               "n'est prévu dans les prochains jours mais qu'un prochain événement est indiqué, fais-en un petit "
               "sujet : quand c'est, et une idée utile pour s'y préparer."),
    "deplacements": ("Ses déplacements (voyages et sorties repérés dans son agenda), seulement si la section DÉPLACEMENTS est fournie : pour chacun, "
                     "rappelle quand c'est, propose deux ou trois idées d'activités, de visites ou de culture sur "
                     "place (ou autour du lieu de la sortie), puis les actus locales utiles. Pour les idées, "
                     "appuie-toi sur tes connaissances générales (lieux emblématiques, quartiers, musées, "
                     "spécialités), sans inventer d'événement daté, d'horaire ni de prix. Si la section indique "
                     "qu'un lieu a déjà été présenté, fais court : un rappel de la date et une seule idée "
                     "nouvelle, jamais une des idées déjà proposées. Note chaque idée proposée dans « idees »."),
    "actu_locale": ("L'actu locale, seulement si la section ACTU LOCALE est fournie : une ou deux informations de "
                    "{ville}, en quelques répliques : de quoi il s'agit et ce que ça change au quotidien. "
                    "Appuie-toi uniquement sur les articles fournis."),
    "approfondissements": ("À creuser, seulement si la section À APPROFONDIR est fournie : un segment "
                           "plus fouillé par sujet demandé (contexte, enjeux, ce qui va suivre), en t'appuyant "
                           "sur les articles fournis."),
    "actualites": ("Les actualités : choisis les {n} sujets les plus importants ou les plus intéressants pour "
                   "l'auditeur ({d_abord} d'abord s'il y en a, puis l'international). Pour chaque "
                   "sujet : de quoi il s'agit et pourquoi ça compte, en 2 à 5 répliques, avec des transitions naturelles."),
    "cloture": "Clôture (2 ou 3 répliques) : rappel du premier rendez-vous du jour s'il y en a un, puis le mot de la fin.",
}

REGLAGES_PAR_DEFAUT: dict[str, Any] = {
    "fuseau_horaire": "Europe/Zurich",
    "duree_minutes": 5,
    "nombre_sujets": 5,
    "vitesse_parole": "normale",
    "tutoiement": True,
    "prenom_auditeur": "",
    "ville_habituelle": "",
    "centres_interet": "",
    "jours_agenda": 7,
    "horizon_prochain_evenement_jours": 90,
    "jours_deplacements": 14,
    "max_deplacements": 2,
    "locale_articles": 3,
    "agendas_exclus": [],
    "inclure_notes_agenda": True,
    "articles_par_flux": 8,
    "fraicheur_heures": 36,
    "recherches_actus": True,
    "langue_actus": "fr",
    "pays_actus": "CH",
    "modeles_texte": ["gemini-3.8-flash", "gemini-3.6-flash"],
    "modeles_rapides": ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    "modeles_voix": ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"],
    "reflexion": "medium",
    "debit_mp3_kbps": 64,
    "caracteres_par_requete_voix": 4500,
    "animateurs": [
        {"nom": "Léa", "voix": "Aoede"},
        {"nom": "Hugo", "voix": "Puck"},
    ],
    "flux": [
        {"nom": "Google Actualités – Suisse",
         "url": "https://news.google.com/rss?hl=fr&gl=CH&ceid=CH:fr"},
        {"nom": "RTS Info", "url": "https://www.rts.ch/info/?format=rss/news"},
        {"nom": "Le Monde", "url": "https://www.lemonde.fr/rss/une.xml"},
    ],
}

AIDE = (
    "🎙️ Je suis le bot de ton podcast du matin. Écris-moi, ou envoie-moi un vocal, "
    "pour l'ajuster. Par exemple :\n"
    "• « parle un peu plus lentement »\n"
    "• « le sport ne m'intéresse pas »\n"
    "• « creuse la réforme des retraites demain »\n"
    "• « fais des épisodes de 7 minutes »\n"
    "• « j'habite à Lausanne »\n"
    "• « refais le podcast en creusant l'actu locale » (nouvel épisode tout de suite)\n\n"
    "Je te réponds en une à deux minutes, et c'est pris en compte dès l'épisode suivant.\n\n"
    "/podcast : un nouvel épisode tout de suite\n"
    "/reglages : voir tes réglages actuels\n"
    "/reinitialiser : revenir aux réglages de base"
)
COMMANDES_PODCAST = ("/podcast", "/episode", "/épisode", "/nouveau")
MAX_EPISODES_REFAITS = 3        # par jour : la voix gratuite est limitée à 10 requêtes/jour
COMMANDES_REINITIALISER = ("/reinitialiser", "/réinitialiser", "/reset")


# ─────────────────────────────── utilitaires ────────────────────────────────

class ErreurPodcast(Exception):
    """Erreur expliquée en clair, pour le journal et pour Telegram."""


class ModeleIndisponible(ErreurPodcast):
    """Le modèle n'existe pas, n'est pas ouvert à ce compte ou ne répond plus."""


class QuotaEpuise(ModeleIndisponible):
    """Quota gratuit du jour atteint pour ce modèle."""


class Surcharge(ModeleIndisponible):
    """Gêne passagère (pas de réponse, panne) : réessayer plus tard."""


class Refus(Surcharge):
    """Requête refusée (429). Chaque refus compte dans le quota du jour :
    on ne réessaie ce modèle que si Google indique quand revenir."""


class RequeteRefusee(ErreurPodcast):
    """Requête jugée invalide par l'API (HTTP 400)."""


class ReponseIllisible(ErreurPodcast):
    """Gemini a répondu, mais pas un JSON exploitable (réponse coupée, bouclée…)."""

    def __init__(self, detail: str, message: str = "") -> None:
        self.detail = detail
        super().__init__(message or f"La réponse de Gemini n'est pas un JSON valide ({detail}).")


def journal(message: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def masquer(url: str) -> str:
    """Ne garde que le domaine d'une adresse (les liens iCal sont secrets)."""
    try:
        return f"{urlparse(url).netloc or url[:20]}/…"
    except ValueError:
        return "(adresse masquée)"


def nettoyer_html(texte: str) -> str:
    texte = re.sub(r"(?is)<(script|style).*?</\1>", " ", texte or "")
    texte = re.sub(r"(?s)<[^>]+>", " ", texte)
    texte = html.unescape(texte)
    return re.sub(r"\s+", " ", texte).strip()


def echapper(texte: str) -> str:
    """Texte sûr pour le mode HTML de Telegram (apostrophes laissées telles quelles)."""
    return html.escape(texte, quote=False)


def tronquer(texte: str, longueur: int) -> str:
    texte = texte.strip()
    if len(texte) <= longueur:
        return texte
    coupe = texte[:longueur].rsplit(" ", 1)[0]
    return coupe.rstrip(" ,;:.") + "…"


def sans_accents(texte: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", texte)
                   if not unicodedata.combining(c))


def cle_titre(titre: str) -> str:
    """Clé de comparaison pour repérer un même sujet repris par deux flux."""
    mots = re.findall(r"[a-z0-9]+", sans_accents(titre.lower()))
    return " ".join(m for m in mots if len(m) > 2)[:70]


MOTS_VIDES = frozenset(
    "les des aux une pour par sur dans avec est son ses qui que pas plus apres avant entre the and for "
    "ont sont leur leurs cette ces tout tous mais comme fait etait etre deja encore sans sous chez vers "
    "selon contre face lors depuis".split())


@functools.lru_cache(maxsize=4096)
def mots_significatifs(cle: str) -> frozenset:
    return frozenset(m for m in cle.split() if m not in MOTS_VIDES)


def meme_sujet(a: str, b: str) -> bool:
    """Deux titres (clés) qui parlent de la même chose : au moins trois mots importants
    en commun, et l'essentiel du plus court (« Trafic ferroviaire entre Lausanne et Yverdon
    repris dimanche » et « Reprise du trafic ferroviaire entre Yverdon et Lausanne dimanche »)."""
    if a == b:
        return True
    ma, mb = mots_significatifs(a), mots_significatifs(b)
    communs = len(ma & mb)
    return communs >= 3 and communs >= 0.6 * min(len(ma), len(mb))


def deja_vu(cle: str, vus: set[str]) -> bool:
    return cle in vus or any(meme_sujet(cle, v) for v in vus)


def meme_lieu(a: str, b: str) -> bool:
    """« Saintes-Maries-de-la-Mer » et « Camarkas, Saintes Maries de la Mer », « Arles » et
    « Arles et Les Saintes-Maries-de-la-Mer » : le même déplacement."""
    ma, mb = mots_significatifs(cle_titre(a)), mots_significatifs(cle_titre(b))
    communs = len(ma & mb)
    return communs >= 1 and communs >= 0.6 * min(len(ma), len(mb))


LONGUEUR_CONSIGNE = 300   # une consigne peut être une vraie phrase ; les autres listes restent courtes


def nettoyer_liste(valeur: Any, maximum: int = 15, longueur: int = 80) -> list[str]:
    """Liste de courtes chaînes, sans doublons (utile pour les réglages appris)."""
    resultat: list[str] = []
    vus: set[str] = set()
    for element in valeur if isinstance(valeur, list) else []:
        texte = tronquer(re.sub(r"\s+", " ", str(element)).strip(" .;"), longueur)
        cle = sans_accents(texte.lower())
        if texte and cle not in vus:
            vus.add(cle)
            resultat.append(texte)
    return resultat[:maximum]


def date_longue(jour: dt.date, avec_annee: bool = True) -> str:
    premier = "er" if jour.day == 1 else ""
    texte = f"{JOURS[jour.weekday()]} {jour.day}{premier} {MOIS[jour.month - 1]}"
    return f"{texte} {jour.year}" if avec_annee else texte


def heure_parlee(moment: dt.datetime) -> str:
    if moment.hour == 12 and moment.minute == 0:
        return "midi"
    if moment.hour == 0 and moment.minute == 0:
        return "minuit"
    return f"{moment.hour} h {moment.minute:02d}" if moment.minute else f"{moment.hour} h"


def heure_actuelle(fuseau: ZoneInfo) -> dt.datetime:
    return dt.datetime.now(fuseau)


def debut_du_jour(moment: dt.datetime) -> dt.datetime:
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)


def telecharger(url: str, delai: int = 30, essais: int = 3) -> bytes:
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    derniere_erreur: Exception | None = None
    for essai in range(essais):
        try:
            reponse = requests.get(
                url, timeout=delai,
                headers={"User-Agent": NAVIGATEUR, "Accept": "*/*",
                         "Accept-Language": pays_auditeur.profil()["accept_language"]})
            reponse.raise_for_status()
            return reponse.content
        except requests.RequestException as erreur:
            derniere_erreur = erreur
            time.sleep(2 * (essai + 1))
    statut = getattr(getattr(derniere_erreur, "response", None), "status_code", None)
    detail = f"HTTP {statut}" if statut else type(derniere_erreur).__name__
    raise ErreurPodcast(f"téléchargement impossible ({masquer(url)}, {detail})")


# ──────────────────────────── réglages et mémoire ───────────────────────────

def charger_reglages(chemin: Path) -> dict[str, Any]:
    reglages = json.loads(json.dumps(REGLAGES_PAR_DEFAUT))  # copie profonde
    if chemin.exists():
        with chemin.open("rb") as fichier:
            try:
                reglages.update(tomllib.load(fichier))
            except tomllib.TOMLDecodeError as erreur:
                raise ErreurPodcast(f"reglages.toml est mal formé : {erreur}") from erreur

    animateurs = reglages.get("animateurs") or []
    if len(animateurs) != 2 or not all(a.get("nom") and a.get("voix") for a in animateurs):
        raise ErreurPodcast("reglages.toml doit décrire exactement deux animateurs "
                            "(chacun avec un nom et une voix).")
    for animateur in animateurs:
        animateur["nom"] = str(animateur["nom"]).strip()
        animateur["voix"] = str(animateur["voix"]).strip()
    if identifiant(animateurs[0]["nom"]) == identifiant(animateurs[1]["nom"]):
        raise ErreurPodcast("Les deux animateurs doivent avoir des noms différents.")

    reglages["duree_minutes"] = max(2.0, min(12.0, float(reglages["duree_minutes"])))
    reglages["nombre_sujets"] = max(1, min(10, int(reglages["nombre_sujets"])))
    reglages["jours_agenda"] = max(1, min(31, int(reglages["jours_agenda"])))
    reglages["horizon_prochain_evenement_jours"] = max(
        reglages["jours_agenda"], min(365, int(reglages["horizon_prochain_evenement_jours"])))
    reglages["jours_deplacements"] = max(0, min(60, int(reglages["jours_deplacements"])))
    if reglages.get("vitesse_parole") not in VITESSES:
        reglages["vitesse_parole"] = "normale"
    reglages["ville_habituelle"] = str(reglages.get("ville_habituelle") or "").strip()
    reglages["debit_mp3_kbps"] = int(reglages["debit_mp3_kbps"])
    if reglages["debit_mp3_kbps"] not in (32, 40, 48, 56, 64, 80, 96, 112, 128, 160):
        reglages["debit_mp3_kbps"] = 64
    if reglages.get("reflexion") not in ("minimal", "low", "medium", "high"):
        reglages["reflexion"] = "medium"
    for cle in ("modeles_texte", "modeles_rapides", "modeles_voix"):
        if isinstance(reglages[cle], str):
            reglages[cle] = [reglages[cle]]
    return reglages


def identifiant(nom: str) -> str:
    """Nom de locuteur technique (ASCII) transmis à Gemini TTS."""
    return re.sub(r"[^A-Za-z0-9]", "", sans_accents(nom)) or "Animateur"


def memoire_vide() -> dict[str, Any]:
    return {
        "telegram_dernier_update": 0,
        "preferences": {
            "vitesse_parole": None, "duree_minutes": None, "ville_habituelle": None,
            "sujets_preferes": [], "sujets_a_eviter": [], "consignes": [],
        },
        "a_approfondir": [],
        "dernier_episode": {},
        "historique_retours": [],
        "retours_echec_signale": 0,
        "episodes_refaits": {},        # {"date": ..., "nombre": ...}
        "dernier_programme": "",       # date du dernier épisode programmé (hors épisodes à la demande)
        "debit_mots_minute": {},     # débit réellement mesuré, par vitesse
        "remplissage": None,         # mots écrits / mots demandés (moyenne glissante) : Gemini écrit court, on demande plus
        "articles_vus": {},          # titre normalisé → date : actus déjà racontées (pas deux fois en une semaine)
        "lieux_presentes": [],       # déplacements déjà présentés : lieu, dates, idées proposées
    }


def charger_memoire(chemin: Path) -> dict[str, Any]:
    memoire = memoire_vide()
    if not chemin.exists():
        return memoire
    try:
        lue = json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError) as erreur:
        journal(f"memoire.json illisible, on repart de zéro ({erreur}).")
        return memoire
    if isinstance(lue, dict):
        for cle, valeur in lue.items():
            if cle == "preferences" and isinstance(valeur, dict):
                memoire["preferences"].update(valeur)
            elif cle in memoire:
                memoire[cle] = valeur
    return memoire


def charger_preferences(chemin: Path, memoire: dict) -> None:
    """Réglages tenus par le bot instantané (Cloudflare) : ils l'emportent sur memoire.json.
    Un sujet à approfondir ne compte que s'il a été demandé après le dernier épisode."""
    if not chemin.exists():
        return
    try:
        donnees = json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError) as erreur:
        journal(f"preferences.json illisible, ignoré ({erreur}).")
        return
    if isinstance(donnees.get("preferences"), dict):
        memoire["preferences"] = {**memoire_vide()["preferences"], **donnees["preferences"]}
    envoye = str((memoire.get("dernier_episode") or {}).get("envoye_le", ""))
    memoire["a_approfondir"] = [a for a in donnees.get("a_approfondir") or []
                                if isinstance(a, dict) and a.get("sujet")
                                and str(a.get("demande_le", "")) > envoye]


def sauver_memoire(chemin: Path, memoire: dict) -> None:
    chemin.write_text(json.dumps(memoire, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


URL_MODELES = "https://generativelanguage.googleapis.com/v1beta/models"


def version_modele(nom: str) -> tuple[int, int]:
    trouve = re.match(r"gemini-(\d+)(?:\.(\d+))?-", nom)
    return (int(trouve.group(1)), int(trouve.group(2) or 0)) if trouve else (0, 0)


def classer_modeles(noms: list[str]) -> dict[str, list[str]]:
    """Range les modèles disponibles : texte (Flash), rapides (Flash-Lite), voix (TTS),
    du plus récent au plus ancien ; les « preview » après les versions stables."""
    exclus = re.compile(r"image|live|native|audio|embedding|transcribe|translate|omni|latest|robotics|computer|veo|imagen")
    texte, rapides, voix = [], [], []
    for nom in noms:
        if not nom.startswith("gemini-") or version_modele(nom) == (0, 0):
            continue
        if "tts" in nom:
            # Les voix « preview » et « pro » refusent notre format (PCM, annotations de locuteur).
            if "preview" not in nom and "pro" not in nom:
                voix.append(nom)
        elif exclus.search(nom):
            continue
        elif re.fullmatch(r"gemini-[\d.]+-flash-lite(-preview)?", nom):
            rapides.append(nom)
        elif re.fullmatch(r"gemini-[\d.]+-flash(-preview)?", nom):
            texte.append(nom)
    def ordre(nom: str) -> tuple:
        majeure, mineure = version_modele(nom)
        return ("pro" in nom, "preview" in nom, "lite" in nom, -majeure, -mineure)
    return {"modeles_texte": sorted(texte, key=ordre)[:3], "modeles_rapides": sorted(rapides, key=ordre)[:3],
            "modeles_voix": sorted(voix, key=ordre)[:5]}


def decouvrir_modeles(reglages: dict, cle: str) -> dict[str, list[str]]:
    """Met à jour les listes de modèles d'après ceux réellement ouverts à la clé
    (une requête de liste, gratuite). En cas de souci : listes de reglages.toml."""
    if not reglages.get("decouverte_modeles", True) or not cle:
        return {}
    try:
        noms, page = [], ""
        for _ in range(5):
            reponse = requests.get(URL_MODELES, params={"pageSize": 1000, "pageToken": page},
                                   headers={"x-goog-api-key": cle}, timeout=20)
            reponse.raise_for_status()
            donnees = reponse.json()
            noms += [str(m.get("name", "")).removeprefix("models/") for m in donnees.get("models") or []
                     if "generateContent" in (m.get("supportedGenerationMethods") or [])]
            page = donnees.get("nextPageToken", "")
            if not page:
                break
    except Exception as erreur:   # liste indisponible : on garde reglages.toml
        journal(f"Liste des modèles indisponible ({type(erreur).__name__}) : modèles de reglages.toml.")
        return {}
    trouves = classer_modeles(noms)
    resultat = {}
    for cle_liste, decouverts in trouves.items():
        if decouverts:
            resultat[cle_liste] = decouverts
            if decouverts != list(reglages.get(cle_liste) or []):
                journal(f"Modèles ({cle_liste}) : {', '.join(decouverts)}")
    return resultat


def _remplissage(memoire: dict) -> float:
    """Part des mots demandés que Gemini écrit vraiment (1 = il tient la longueur). Mesurée à chaque épisode."""
    valeur = memoire.get("remplissage")
    return max(REMPLISSAGE_MIN, min(1.0, float(valeur))) if isinstance(valeur, (int, float)) else 1.0


def reglages_effectifs(reglages: dict, memoire: dict) -> dict[str, Any]:
    """Ce que l'auditeur a demandé au bot l'emporte sur reglages.toml."""
    effectifs = dict(reglages)
    preferences = memoire.get("preferences") or {}
    if preferences.get("vitesse_parole") in VITESSES:
        effectifs["vitesse_parole"] = preferences["vitesse_parole"]
    if isinstance(preferences.get("duree_minutes"), (int, float)):
        effectifs["duree_minutes"] = max(2.0, min(12.0, float(preferences["duree_minutes"])))
    if preferences.get("ville_habituelle"):
        effectifs["ville_habituelle"] = str(preferences["ville_habituelle"])
    effectifs["sujets_preferes"] = nettoyer_liste(preferences.get("sujets_preferes"))
    effectifs["sujets_a_eviter"] = nettoyer_liste(preferences.get("sujets_a_eviter"))
    effectifs["consignes"] = nettoyer_liste(preferences.get("consignes"), 15, LONGUEUR_CONSIGNE)
    mesure = (memoire.get("debit_mots_minute") or {}).get(effectifs["vitesse_parole"])
    effectifs["mots_par_minute"] = (int(mesure) if isinstance(mesure, (int, float)) and 100 <= mesure <= 300
                                    else VITESSES[effectifs["vitesse_parole"]][1])
    effectifs["remplissage"] = _remplissage(memoire)
    effectifs["a_approfondir"] = [a for a in memoire.get("a_approfondir") or []
                                  if isinstance(a, dict) and a.get("sujet")][:5]
    effectifs.setdefault("ton", "naturel")
    effectifs.setdefault("citer_sources", "ecrit")
    effectifs.setdefault("deroule", [{"cle": c, "actif": True} for c in moteur.RUBRIQUES])
    effectifs.setdefault("config_bot", None)
    return effectifs


def _borne(valeur: Any, minimum: float, maximum: float, defaut: float) -> float:
    try:
        return max(minimum, min(maximum, float(valeur)))
    except (TypeError, ValueError):
        return defaut


def effectifs_depuis_bot(reglages: dict, memoire: dict, config: dict) -> dict[str, Any]:
    """Réglages tenus par le bot (Cloudflare) : ils remplacent les préférences
    de reglages.toml ; reglages.toml garde la partie technique (modèles, MP3…)."""
    e = reglages_effectifs(reglages, {**memoire, "preferences": {}, "a_approfondir": []})
    f, v = config.get("format") or {}, config.get("voix") or {}
    ag, ac = config.get("agenda") or {}, config.get("actus") or {}
    e["duree_minutes"] = _borne(f.get("duree_minutes"), 2, 12, e["duree_minutes"])
    e["nombre_sujets"] = int(_borne(f.get("nombre_sujets"), 1, 10, e["nombre_sujets"]))
    e["ton"] = f.get("ton") if f.get("ton") in TONS else "naturel"
    if v.get("vitesse") in VITESSES:
        e["vitesse_parole"] = v["vitesse"]
    e["tutoiement"] = bool(v.get("tutoiement", e["tutoiement"]))
    e["prenom_auditeur"] = str(v.get("prenom") or e.get("prenom_auditeur") or "").strip()
    # Le bot envoie les animateurs du jour (selon le jour, au hasard…) : un ou deux.
    animateurs = v.get("animateurs")
    if (isinstance(animateurs, list) and len(animateurs) in (1, 2)
            and all(isinstance(a, dict) and str(a.get("nom", "")).strip() and str(a.get("voix", "")).strip() for a in animateurs)
            and len({identifiant(str(a["nom"])) for a in animateurs}) == len(animateurs)):
        e["animateurs"] = [{"nom": str(a["nom"]).strip(), "voix": str(a["voix"]).strip()} for a in animateurs]
    e["jours_agenda"] = int(_borne(ag.get("jours"), 1, 31, e["jours_agenda"]))
    e["horizon_prochain_evenement_jours"] = max(e["jours_agenda"], int(_borne(ag.get("horizon"), 7, 365, e["horizon_prochain_evenement_jours"])))
    e["inclure_notes_agenda"] = bool(ag.get("notes", e["inclure_notes_agenda"]))
    e["jours_deplacements"] = int(_borne(ag.get("jours_deplacements"), 1, 60, e["jours_deplacements"])) if ag.get("deplacements", True) else 0
    e["max_deplacements"] = int(_borne(ag.get("max_deplacements"), 1, 4, 2))
    e["agendas_exclus"] = [str(x) for x in ag.get("exclus") or []][:20]
    e["locale_articles"] = int(_borne(ac.get("locale_articles"), 1, 8, 3))
    e["ville_habituelle"] = str(ac.get("ville") or e.get("ville_habituelle") or "").strip()
    e["sujets_preferes"] = nettoyer_liste(ac.get("sujets_preferes"))
    e["sujets_a_eviter"] = nettoyer_liste(ac.get("sujets_a_eviter"))
    if isinstance(ac.get("flux"), list):
        e["flux"] = [x for x in ac["flux"] if isinstance(x, dict) and str(x.get("url", "")).startswith("http")]
    e["fraicheur_heures"] = _borne(ac.get("fraicheur_heures"), 6, 168, e["fraicheur_heures"])
    e["citer_sources"] = ac.get("citer_sources") if ac.get("citer_sources") in CITER_SOURCES else "ecrit"
    e["consignes"] = nettoyer_liste(config.get("consignes"), 20, LONGUEUR_CONSIGNE)
    envoye = str((memoire.get("dernier_episode") or {}).get("envoye_le", ""))
    e["a_approfondir"] = [a for a in config.get("a_approfondir") or []
                          if isinstance(a, dict) and a.get("sujet") and str(a.get("demande_le", "")) > envoye][:5]
    mesure = (memoire.get("debit_mots_minute") or {}).get(e["vitesse_parole"])
    e["mots_par_minute"] = (int(mesure) if isinstance(mesure, (int, float)) and 100 <= mesure <= 300
                            else VITESSES[e["vitesse_parole"]][1])
    e["remplissage"] = _remplissage(memoire)
    deroule = config.get("deroule")
    e["deroule"] = deroule if isinstance(deroule, list) and deroule else [{"cle": c, "actif": True} for c in moteur.RUBRIQUES]
    e["config_bot"] = config
    return e


def rubrique_active(effectifs: dict, cle_rubrique: str) -> bool:
    return any(r.get("cle") == cle_rubrique and r.get("actif", True) for r in effectifs.get("deroule") or [])


# ───────────────────────────────── agenda ───────────────────────────────────

@dataclass
class Evenement:
    titre: str
    debut: dt.datetime
    fin: dt.datetime | None
    journee_entiere: bool
    lieu: str = ""
    note: str = ""


def vers_local(valeur: dt.date | dt.datetime, fuseau: ZoneInfo) -> dt.datetime:
    if isinstance(valeur, dt.datetime):
        if valeur.tzinfo is None:          # heure « flottante » : heure locale
            return valeur.replace(tzinfo=fuseau)
        return valeur.astimezone(fuseau)
    return dt.datetime.combine(valeur, dt.time.min, tzinfo=fuseau)


def lire_evenements(contenu: bytes, fuseau: ZoneInfo, debut: dt.datetime,
                    fin: dt.datetime, avec_notes: bool = True) -> list[Evenement]:
    calendrier = icalendar.Calendar.from_ical(contenu)
    calendrier = x_wr_timezone.to_standard(calendrier)
    requete = recurring_ical_events.of(calendrier, skip_bad_series=True)
    evenements: list[Evenement] = []
    for composant in requete.between(debut, fin):
        if str(composant.get("STATUS", "")).upper() == "CANCELLED":
            continue
        propriete_debut = composant.get("DTSTART")
        if propriete_debut is None:
            continue
        brut_debut = propriete_debut.dt
        journee_entiere = not isinstance(brut_debut, dt.datetime)
        brut_fin = composant.get("DTEND").dt if composant.get("DTEND") is not None else None
        if brut_fin is None and composant.get("DURATION") is not None:
            brut_fin = brut_debut + composant.get("DURATION").dt
        note = ""
        if avec_notes:
            note = tronquer(nettoyer_html(str(composant.get("DESCRIPTION", "") or "")), 160)
            note = re.sub(r"https?://\S+", "(lien)", note)
        evenements.append(Evenement(
            titre=nettoyer_html(str(composant.get("SUMMARY", "") or "")) or "(sans titre)",
            debut=vers_local(brut_debut, fuseau),
            fin=vers_local(brut_fin, fuseau) if brut_fin is not None else None,
            journee_entiere=journee_entiere,
            lieu=tronquer(nettoyer_html(str(composant.get("LOCATION", "") or "")), 100),
            note=note,
        ))
    return evenements


AGENDAS_VUS: list[dict] = []     # agendas lus à ce lancement : {id, nom, nb} (envoyés au bot)
AGENDA_APERCU: list[dict] = []   # 14 prochains jours, tous agendas : aperçu dans l'application


def identifiant_agenda(url: str) -> str:
    """Identifiant stable d'un agenda, sans révéler son adresse secrète."""
    return hashlib.sha256(("agenda:" + url.strip()).encode()).hexdigest()[:10]


def nom_agenda(contenu: bytes, url: str, numero: int) -> str:
    """Nom d'un agenda : celui que donne le fichier (X-WR-CALNAME), sinon le service."""
    texte = contenu[:20000].decode("utf-8", "replace")
    trouve = re.search(r"^X-WR-CALNAME[^:\n]*:(.+?)\r?$", texte, re.M)
    nom = trouve.group(1).strip().replace("\\,", ",") if trouve else ""
    if not nom:
        hote = (re.search(r"//([^/]+)/", url.replace("webcal://", "https://")) or [None, ""])[1].lower()
        nom = ("Google Agenda" if "google" in hote else "Outlook" if ("outlook" in hote or "office" in hote or "live.com" in hote)
               else hote or f"Agenda {numero}")
    return nom[:60]


def lire_agendas(urls: list[str], reglages: dict, maintenant: dt.datetime,
                 horizon_jours: int) -> tuple[list[Evenement], list[str]]:
    fuseau = maintenant.tzinfo
    debut = debut_du_jour(maintenant)
    fin = debut + dt.timedelta(days=horizon_jours)
    evenements: list[Evenement] = []
    problemes: list[str] = []
    exclus = set(reglages.get("agendas_exclus") or [])
    AGENDAS_VUS.clear()
    AGENDA_APERCU.clear()
    fin_apercu = debut + dt.timedelta(days=14)
    for numero, url in enumerate(urls, 1):
        try:
            contenu = telecharger(url)
            trouves = lire_evenements(contenu, fuseau, debut, fin,
                                      reglages["inclure_notes_agenda"])
            identifiant_a = identifiant_agenda(url)
            AGENDAS_VUS.append({"id": identifiant_a, "nom": nom_agenda(contenu, url, numero), "nb": len(trouves)})
            for ev in trouves:
                if ev.debut < fin_apercu and len(AGENDA_APERCU) < 120:
                    AGENDA_APERCU.append({"agenda": identifiant_a, "titre": ev.titre[:80], "debut": ev.debut.isoformat(timespec="minutes"),
                                          "fin": ev.fin.isoformat(timespec="minutes") if ev.fin else None,
                                          "journee": ev.journee_entiere, "lieu": (ev.lieu or "")[:60]})
            if identifiant_a in exclus:
                journal(f"Agenda {numero} ({AGENDAS_VUS[-1]['nom']}) : ignoré (désactivé dans le bot).")
                continue
            journal(f"Agenda {numero} : {len(trouves)} événement(s) sur {horizon_jours} jour(s).")
            evenements.extend(trouves)
        except Exception as erreur:  # un agenda illisible ne bloque pas l'épisode
            journal(f"Agenda {numero} illisible : {erreur}")
            problemes.append(f"agenda {numero} inaccessible")
    # Doublons possibles si un même événement figure dans deux agendas.
    vus, uniques = set(), []
    for evenement in sorted(evenements, key=lambda e: (e.debut, not e.journee_entiere)):
        cle = (evenement.titre.lower(), evenement.debut)
        if cle not in vus:
            vus.add(cle)
            uniques.append(evenement)
    return uniques, problemes


def dernier_jour(evenement: Evenement) -> dt.date:
    if evenement.fin is None or evenement.fin <= evenement.debut:
        return evenement.debut.date()
    return max(evenement.debut.date(), (evenement.fin - dt.timedelta(seconds=1)).date())


def decrire_evenement(evenement: Evenement, jour: dt.date) -> str:
    if evenement.journee_entiere:
        fin = dernier_jour(evenement)
        if fin > evenement.debut.date() or evenement.debut.date() < jour:
            en_cours = " (déjà commencé)" if evenement.debut.date() < jour else ""
            quand = (f"du {date_longue(evenement.debut.date(), False)} au "
                     f"{date_longue(fin, False)}, journées entières{en_cours}")
        else:
            quand = "toute la journée"
    else:
        quand = f"à {heure_parlee(evenement.debut)}"
        if evenement.fin is not None and evenement.fin > evenement.debut:
            if evenement.fin.date() == evenement.debut.date():
                quand = f"de {heure_parlee(evenement.debut)} à {heure_parlee(evenement.fin)}"
            else:
                quand = (f"de {heure_parlee(evenement.debut)} jusqu'au "
                         f"{date_longue(evenement.fin.date(), False)} à {heure_parlee(evenement.fin)}")
    ligne = f"- {quand} : {evenement.titre}"
    if evenement.lieu:
        ligne += f" — lieu : {evenement.lieu}"
    if evenement.note:
        ligne += f" — note : {evenement.note}"
    return ligne


def quand_court(evenement: Evenement) -> str:
    jour = date_longue(evenement.debut.date(), False)
    fin = dernier_jour(evenement)
    if fin > evenement.debut.date():
        return f"du {jour} au {date_longue(fin, False)}"
    if evenement.journee_entiere:
        return f"le {jour}"
    return f"le {jour} à {heure_parlee(evenement.debut)}"


def resumer_agenda(evenements: list[Evenement], maintenant: dt.datetime,
                   prochain: Evenement | None = None, horizon: int = 0) -> str:
    aujourd_hui = maintenant.date()
    if not evenements:
        if prochain is None:
            return f"Aucun événement dans l'agenda pour les {horizon} prochains jours."
        ecart = (prochain.debut.date() - aujourd_hui).days
        dans = f"dans {ecart} jour{'s' if ecart > 1 else ''}"
        return ("Rien de prévu dans les prochains jours.\n\n"
                f"PROCHAIN ÉVÉNEMENT ({dans}, {date_longue(prochain.debut.date())}) :\n"
                + decrire_evenement(prochain, prochain.debut.date()))
    par_jour: dict[dt.date, list[Evenement]] = {}
    for evenement in evenements:
        jour = max(evenement.debut.date(), aujourd_hui)
        par_jour.setdefault(jour, []).append(evenement)
    lignes: list[str] = []
    if aujourd_hui not in par_jour:
        lignes += [f"AUJOURD'HUI ({date_longue(aujourd_hui)}) :", "- rien de prévu", ""]
    for jour in sorted(par_jour):
        ecart = (jour - aujourd_hui).days
        etiquette = {0: "AUJOURD'HUI", 1: "DEMAIN"}.get(ecart, "PLUS TARD")
        lignes.append(f"{etiquette} ({date_longue(jour)}) :")
        lignes += [decrire_evenement(e, jour) for e in par_jour[jour]]
        lignes.append("")
    return "\n".join(lignes).strip()


# ─────────────────────────────── actualités ─────────────────────────────────

@dataclass
class Article:
    titre: str
    resume: str
    lien: str
    source: str
    date: dt.datetime | None = None
    numero: int = 0
    etiquette: str = ""
    section: str = ""          # où l'article sert dans l'épisode (pour ranger les sources)


def lire_flux(contenu: bytes, nom_flux: str, maximum: int,
              seuil: dt.datetime | None) -> list[Article]:
    flux = feedparser.parse(contenu)
    if not flux.entries:
        raise ErreurPodcast("flux vide ou illisible")
    nom = nom_flux or nettoyer_html(flux.feed.get("title", "")) or "?"
    articles: list[Article] = []
    for entree in flux.entries:
        titre = nettoyer_html(entree.get("title", ""))
        if not titre:
            continue
        source = nom
        origine = entree.get("source")
        if isinstance(origine, dict) and origine.get("title"):
            source = nettoyer_html(origine["title"])
            titre = re.sub(rf"\s+[-–—]\s+{re.escape(source)}\s*$", "", titre)
        moment = entree.get("published_parsed") or entree.get("updated_parsed")
        date = dt.datetime(*moment[:6], tzinfo=dt.timezone.utc) if moment else None
        if seuil is not None and date is not None and date < seuil:
            continue
        resume = nettoyer_html(entree.get("summary", "") or entree.get("description", ""))
        if cle_titre(resume).startswith(cle_titre(titre)[:40]):
            resume = ""                      # résumé qui ne fait que répéter le titre
        articles.append(Article(titre=titre, resume=tronquer(resume, 350),
                                lien=entree.get("link", ""), source=source, date=date))
        if len(articles) >= maximum:
            break
    return articles


def lire_actualites(reglages: dict, maintenant: dt.datetime
                    ) -> tuple[list[Article], list[str]]:
    seuil = maintenant.astimezone(dt.timezone.utc) - dt.timedelta(
        hours=float(reglages["fraicheur_heures"]))
    articles: list[Article] = []
    problemes: list[str] = []
    for flux in reglages["flux"]:
        url = flux.get("url", "") if isinstance(flux, dict) else str(flux)
        nom = flux.get("nom", "") if isinstance(flux, dict) else ""
        if not url:
            continue
        try:
            trouves = lire_flux(telecharger(url, 20), nom,
                                int(reglages["articles_par_flux"]), seuil)
            journal(f"Flux « {nom or masquer(url)} » : {len(trouves)} article(s).")
            articles.extend(trouves)
        except Exception as erreur:
            journal(f"Flux « {nom or masquer(url)} » ignoré : {erreur}")
            problemes.append(nom or masquer(url))
    return articles, problemes


def lire_flux_specialise(flux: dict, maintenant: dt.datetime, vus: set[str] | None = None,
                         titres: list[str] | None = None, jours: int = 7, maximum: int = 6) -> list[Article]:
    """Articles récents (7 jours) d'un flux spécialisé, sans ceux déjà racontés."""
    url = str(flux.get("url") or "")
    nom = str(flux.get("nom") or "")
    if not url.startswith("http"):
        return []
    seuil = maintenant.astimezone(dt.timezone.utc) - dt.timedelta(days=jours)
    try:
        articles = lire_flux(telecharger(url, 20, essais=2), nom, maximum * 2, seuil)
    except Exception as erreur:
        journal(f"Flux spécialisé « {nom or masquer(url)} » ignoré : {erreur}")
        return []
    gardes = garder_nouveaux(articles, set() if vus is None else vus, maximum)
    if titres is not None:
        titres.extend(a.titre for a in gardes)
    journal(f"Flux spécialisé « {nom or masquer(url)} » : {len(gardes)} article(s).")
    return gardes


def chercher_actus(requete: str, reglages: dict, maintenant: dt.datetime,
                   maximum: int, jours: int) -> list[Article]:
    """Recherche Google Actualités (flux RSS public) sur un sujet ou un lieu."""
    if not reglages.get("recherches_actus") or not requete.strip():
        return []
    langue = str(reglages["langue_actus"])
    pays = str(reglages["pays_actus"])
    url = URL_RECHERCHE.format(requete=quote_plus(f"{requete} when:{jours}d"),
                               langue=langue, pays=pays)
    seuil = maintenant.astimezone(dt.timezone.utc) - dt.timedelta(days=jours)
    try:
        articles = lire_flux(telecharger(url, 20, essais=2), "Google Actualités", maximum, seuil)
    except Exception as erreur:
        journal(f"Recherche « {requete} » sans résultat : {erreur}")
        return []
    journal(f"Recherche « {requete} » : {len(articles)} article(s).")
    return articles


def garder_nouveaux(articles: list[Article], vus: set[str], maximum: int | None = None) -> list[Article]:
    """Retire les doublons (même sujet déjà retenu ailleurs, ou déjà raconté ces derniers
    jours), puis garde au plus « maximum » articles."""
    gardes = []
    for article in articles:
        if maximum is not None and len(gardes) >= maximum:
            break
        cle = cle_titre(article.titre)
        if cle and not deja_vu(cle, vus):
            vus.add(cle)
            gardes.append(article)
    return gardes


# Une recherche lit plus d'articles qu'il n'en faut : ceux déjà racontés sont écartés,
# il en reste assez de nouveaux.
def lus_pour(gardes: int) -> int:
    return max(12, 3 * gardes)


def ligne_article(article: Article, maintenant: dt.datetime) -> str:
    age = ""
    if article.date is not None:
        heures = (maintenant - article.date).total_seconds() / 3600
        if heures < 1:
            age = " (il y a moins d'une heure)"
        elif heures < 48:
            age = f" (il y a {round(heures)} h)"
        else:
            age = f" (il y a {round(heures / 24)} jours)"
    ligne = f"[{article.numero}] {article.source}{age} — {article.titre}"
    if article.etiquette:
        ligne += f" ({article.etiquette})"
    if article.resume:
        ligne += f" : {article.resume}"
    return ligne


def resumer_actualites(articles: list[Article], maintenant: dt.datetime) -> str:
    if not articles:
        return "Aucune actualité n'a pu être récupérée ce matin."
    return "\n".join(ligne_article(a, maintenant) for a in articles)


# ─────────────────────────────── API Gemini ─────────────────────────────────

def message_erreur(reponse: requests.Response) -> str:
    try:
        return str(reponse.json().get("error", {}).get("message") or reponse.text)[:600]
    except ValueError:
        return reponse.text[:600]


# Les serveurs gratuits de Gemini saturent parfois quelques minutes : au lieu
# d'insister sur un modèle muet, on passe au suivant, puis on refait un tour
# complet après une pause. L'exécution doit finir avant ECHEANCE (time.monotonic).
PAUSES_ENTRE_TOURS = (60, 180)
ECHEANCE: float | None = None


def temps_restant() -> float:
    return float("inf") if ECHEANCE is None else ECHEANCE - time.monotonic()


def attente_conseillee(reponse: requests.Response) -> float | None:
    """Délai conseillé par l'API après un refus (429), en secondes, s'il est indiqué."""
    trouve = (re.search(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"', reponse.text)
              or re.search(r"retry in (\d+(?:\.\d+)?)\s*s", reponse.text, re.IGNORECASE))
    if trouve:
        return float(trouve.group(1))
    entete = str(reponse.headers.get("Retry-After", ""))
    return float(entete) if entete.isdigit() else None


def appeler_gemini(corps: dict, cle: str, delai: int) -> dict:
    """Un appel à l'API Interactions. Une seule nouvelle tentative sur le même
    modèle, et seulement si elle a des chances d'aboutir vite."""
    for essai in range(2):
        try:
            reponse = requests.post(
                URL_GEMINI, json=corps, timeout=(20, delai),
                headers={"x-goog-api-key": cle, "Content-Type": "application/json"})
        except requests.ReadTimeout:
            raise Surcharge(f"pas de réponse au bout de {delai} s") from None
        except requests.RequestException as erreur:
            if essai == 1:
                raise Surcharge(f"API Gemini injoignable ({type(erreur).__name__})") from None
            time.sleep(10)
            continue

        if reponse.status_code == 200:
            donnees = reponse.json()
            if donnees.get("status") == "failed":
                raise Surcharge(f"Gemini a échoué : {str(donnees.get('errors'))[:200]}")
            return donnees

        message = message_erreur(reponse)
        brut = reponse.text
        if "API_KEY_INVALID" in brut or "API key not valid" in brut:
            raise ErreurPodcast("La clé Gemini est refusée : vérifie-la dans l'application (Réglages › Connexions) ou dans le secret GEMINI_API_KEY.")
        if reponse.status_code == 429:
            if "PerDay" in brut or "per day" in brut.lower() or "limit: 0" in brut:
                raise QuotaEpuise(f"quota gratuit du jour atteint ({message[:150]})")
            attente = attente_conseillee(reponse)
            if essai == 0 and attente is not None and attente <= 65:
                time.sleep(attente + 1)
                continue
            quotas = sorted(set(re.findall(r'"quota(?:Id|Metric)"\s*:\s*"([^"]+)"', brut)))
            detail = f" ; quota visé : {', '.join(quotas)}" if quotas else " ; Google ne précise pas quel quota"
            raise Refus(f"refusé ({message[:150]}{detail})")
        if reponse.status_code >= 500:
            if essai == 0:
                time.sleep(15)
                continue
            raise Surcharge(f"service Gemini indisponible (HTTP {reponse.status_code})")
        if reponse.status_code == 404 or (
                "model" in message.lower()
                and re.search(r"not found|not supported|unknown|not available|unavailable",
                              message.lower())):
            raise ModeleIndisponible(message)
        if reponse.status_code in (401, 403):
            raise ErreurPodcast(f"Accès refusé par Gemini (HTTP {reponse.status_code}) : {message}")
        raise RequeteRefusee(f"HTTP {reponse.status_code} : {message}")
    raise Surcharge("API Gemini : échec après deux tentatives")


def appeler_avec_repli(corps: dict, modeles: list[str], cle: str, delai: int,
                       tours: int = 3) -> tuple[dict, str]:
    """Essaie les modèles dans l'ordre. Quota du jour épuisé ou modèle inconnu :
    il est écarté pour la suite. Surcharge : tour suivant après une pause."""
    erreurs: dict[str, str] = {}
    for tour in range(tours):
        if tour:
            pause = PAUSES_ENTRE_TOURS[min(tour, len(PAUSES_ENTRE_TOURS)) - 1]
            if not modeles or temps_restant() < pause + 90:
                break
            journal(f"Gemini est surchargé : nouvel essai dans {pause} s.")
            time.sleep(pause)
        for modele in list(modeles):
            if temps_restant() < 60:
                break
            delai_effectif = int(min(delai, max(30, temps_restant() - 30)))
            try:
                return appeler_gemini({**corps, "model": modele}, cle, delai_effectif), modele
            except Refus as erreur:          # inutile d'user le quota en insistant
                journal(f"Modèle {modele} refuse : {erreur}")
                erreurs[modele] = str(erreur)
                modeles.remove(modele)
            except Surcharge as erreur:
                journal(f"Modèle {modele} surchargé : {erreur}")
                erreurs[modele] = str(erreur)
            except ModeleIndisponible as erreur:
                journal(f"Modèle {modele} indisponible : {erreur}")
                erreurs[modele] = str(erreur)
                modeles.remove(modele)       # inutile de le réessayer
    detail = " | ".join(f"{m} : {e}" for m, e in erreurs.items()) or "aucun modèle disponible"
    raise ErreurPodcast("Aucun modèle Gemini n'a répondu. " + detail)


def appeler_avec_variantes(variantes: list[dict], modeles: list[str], cle: str,
                           delai: int, etat: dict | None = None,
                           tours: int = 3) -> tuple[dict, str]:
    """Envoie la requête complète, puis des versions simplifiées si l'API refuse
    un paramètre (l'API évolue vite : on reste robuste)."""
    depart = etat.get("variante", 0) if etat is not None else 0
    derniere: Exception | None = None
    for index in range(depart, len(variantes)):
        try:
            resultat = appeler_avec_repli(variantes[index], modeles, cle, delai, tours)
            if etat is not None:
                etat["variante"] = index
            return resultat
        except RequeteRefusee as erreur:
            derniere = erreur
            journal(f"Requête refusée ({erreur}) : essai d'une version simplifiée.")
    raise ErreurPodcast(f"Gemini refuse la requête : {derniere}")


def contenus_produits(reponse: dict) -> list[dict]:
    blocs = []
    for etape in reponse.get("steps") or []:
        if etape.get("type") == "model_output":
            blocs += [c for c in etape.get("content") or [] if isinstance(c, dict)]
    return blocs


def extraire_texte(reponse: dict) -> str:
    textes = [c["text"] for c in contenus_produits(reponse)
              if c.get("type") == "text" and c.get("text")]
    if not textes and isinstance(reponse.get("output_text"), str):
        textes = [reponse["output_text"]]
    if not textes:
        raise ErreurPodcast("Gemini n'a renvoyé aucun texte.")
    return "".join(textes)


def analyser_json(texte: str) -> dict:
    """JSON renvoyé par Gemini. Tolère les retours à la ligne bruts dans les textes
    (strict=False), le texte autour de l'objet et les virgules finales."""
    candidats = [texte]
    debut, fin = texte.find("{"), texte.rfind("}")
    if debut >= 0 and fin > debut:
        candidats.append(texte[debut:fin + 1])
        candidats.append(re.sub(r",\s*([}\]])", r"\1", texte[debut:fin + 1]))
    derniere = None
    for candidat in candidats:
        try:
            resultat = json.loads(candidat, strict=False)
            if isinstance(resultat, dict):
                return resultat
        except json.JSONDecodeError as erreur:
            derniere = erreur
    if debut >= 0:          # deux objets à la suite : on garde le premier complet
        try:
            resultat, _ = json.JSONDecoder(strict=False).raw_decode(texte[debut:])
            if isinstance(resultat, dict):
                return resultat
        except json.JSONDecodeError:
            pass
    coupee = "" if texte.rstrip().endswith("}") else ", coupée avant la fin"
    detail = f"{len(texte)} caractères{coupee}" + (f", « {derniere.msg} » au caractère {derniere.pos}" if derniere else "")
    raise ReponseIllisible(detail)


def demander_json(systeme: str, entree: Any, schema: dict, modeles: list[str], cle: str,
                  reflexion: str | None = None, delai: int = 180,
                  tours: int = 3) -> tuple[dict, str]:
    """Demande une réponse JSON structurée, avec des versions de repli."""
    base: dict[str, Any] = {"system_instruction": systeme, "input": entree, "store": False}
    texte_seul = entree if isinstance(entree, str) else "\n".join(
        c.get("text", "") for c in entree if isinstance(c, dict) and c.get("type") == "text")
    rappel = ("\n\nRéponds uniquement par un objet JSON conforme à ce schéma : "
              + json.dumps(schema, ensure_ascii=False))
    complete: dict[str, Any] = {**base, "response_format": {
        "type": "text", "mime_type": "application/json", "schema": schema}}
    if reflexion:
        complete["generation_config"] = {"thinking_level": reflexion, "max_output_tokens": 32768}
    variantes = [complete]
    if not isinstance(entree, str):        # même contenu, sous forme d'étape
        variantes.append({**complete, "input": [{"type": "user_input", "content": entree}]})
    variantes += [
        {**base, "input": texte_seul + rappel,
         "response_format": {"type": "text", "mime_type": "application/json"}},
        {**base, "input": texte_seul + rappel},
    ]
    reponse, modele = appeler_avec_variantes(variantes, list(modeles), cle, delai, tours=tours)
    try:
        return analyser_json(extraire_texte(reponse)), modele
    except ReponseIllisible as erreur:
        # Réponse ratée (souvent coupée ou bouclée) : un autre modèle, en commençant
        # par ceux qui suivent dans la liste (le précédent a peut-être déjà refusé).
        i = modeles.index(modele) if modele in modeles else -1
        autres = [m for m in modeles[i + 1:] + modeles[:max(i, 0)] if m != modele]
        journal(f"Réponse de {modele} illisible ({erreur.detail}) : nouvel essai avec un autre modèle.")
        if not autres or temps_restant() < 150:
            raise ReponseIllisible(f"{modele}, {erreur.detail}") from None
        reponse, second = appeler_avec_variantes(variantes, autres, cle, delai, tours=1)
        try:
            return analyser_json(extraire_texte(reponse)), second
        except ReponseIllisible as encore:
            raise ReponseIllisible(encore.detail, f"Gemini a renvoyé deux réponses illisibles ({modele} : {erreur.detail} ; "
                                                  f"{second} : {encore.detail}).") from None


# ───────────────────────── retours de l'auditeur ────────────────────────────

def consigne_retours(reglages: dict) -> str:
    vitesses = ", ".join(VITESSES)
    adresse = "en le tutoyant" if reglages.get("tutoiement", True) else "en le vouvoyant"
    return f"""Tu gères les réglages d'un podcast matinal personnel, en français. L'auditeur t'écrit, ou t'envoie des messages vocaux, pour l'ajuster.
Mets à jour ses réglages d'après ses messages et prépare une réponse courte.

Champs :
- vitesse_parole : une valeur parmi {vitesses}. « Parle plus lentement » = un cran plus lent que la valeur actuelle.
- duree_minutes : durée souhaitée de l'épisode, en minutes (2 à 12).
- ville_habituelle : la ville où vit l'auditeur (vide si inconnue).
- sujets_preferes : thèmes à privilégier, en quelques mots chacun.
- sujets_a_eviter : thèmes qui ne l'intéressent pas. Quand il dit qu'un sujet ne l'intéresse pas, retiens le thème général. Un thème ne peut pas être à la fois préféré et à éviter.
- consignes : consignes durables sur le ton ou le contenu (ex. « plus d'humour », « pas de résultats sportifs »).
- a_approfondir : sujets à développer dans le PROCHAIN épisode seulement (ils seront ensuite oubliés).
- nouvel_episode : true seulement si l'auditeur demande explicitement un nouvel épisode maintenant (« refais le podcast », « envoie-moi un nouvel épisode », « régénère avec… »). Ses autres demandes du même message s'appliquent alors à cet épisode. Sinon false.

Recopie à l'identique tout ce que l'auditeur ne demande pas de changer.
Pour comprendre « ce sujet » ou « le deuxième sujet », appuie-toi sur la liste des sujets du dernier épisode.
Si les messages ne demandent aucun changement (remerciement, question…), ne change rien et réponds simplement.

Limites :
- Le podcast ne dispose que de l'agenda de l'auditeur, de flux d'actualités et de recherches Google Actualités. S'il demande une information que le podcast ne peut pas obtenir (météo, cours de bourse, e-mails…), dis-le simplement, sans l'ajouter aux consignes.
- L'heure d'envoi, les voix, les prénoms des animateurs et la liste des flux ne se changent pas ici : ne change rien et explique que ça se règle dans les fichiers du dépôt GitHub (reglages.toml ou le workflow), ou en le demandant à Claude.

reponse : une à trois phrases en français, {adresse}, qui disent précisément ce qui change à partir du prochain épisode. Si un message vocal est inaudible ou incompréhensible, dis-le."""


def contexte_retours(reglages: dict, memoire: dict, maintenant: dt.datetime) -> str:
    effectifs = reglages_effectifs(reglages, memoire)
    episode = memoire.get("dernier_episode") or {}
    sujets = episode.get("sujets") or []
    dernier = "aucun pour l'instant"
    if episode:
        dernier = (f"{episode.get('date', '?')} — « {episode.get('titre', '')} » — sujets : "
                   + ("; ".join(f"{i}. {s}" for i, s in enumerate(sujets, 1)) or "?"))

    def liste(valeurs: list[str]) -> str:
        return "; ".join(valeurs) or "(aucun)"
    return f"""Date : {date_longue(maintenant.date())}.

Réglages actuels :
- vitesse_parole : {effectifs['vitesse_parole']}
- duree_minutes : {effectifs['duree_minutes']:g}
- ville_habituelle : {effectifs['ville_habituelle'] or '(inconnue)'}
- sujets_preferes : {liste(effectifs['sujets_preferes'])}
- sujets_a_eviter : {liste(effectifs['sujets_a_eviter'])}
- consignes : {liste(effectifs['consignes'])}
- a_approfondir : {liste([a['sujet'] for a in effectifs['a_approfondir']])}

Dernier épisode : {dernier}

Messages de l'auditeur, du plus ancien au plus récent :"""


def schema_retours() -> dict:
    liste = {"type": "array", "items": {"type": "string"}, "maxItems": 15}
    return {
        "type": "object",
        "properties": {
            "vitesse_parole": {"type": "string", "enum": list(VITESSES)},
            "duree_minutes": {"type": "number"},
            "ville_habituelle": {"type": "string"},
            "sujets_preferes": liste,
            "sujets_a_eviter": liste,
            "consignes": liste,
            "a_approfondir": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
            "nouvel_episode": {"type": "boolean"},
            "reponse": {"type": "string"},
        },
        "required": ["vitesse_parole", "duree_minutes", "ville_habituelle", "sujets_preferes",
                     "sujets_a_eviter", "consignes", "a_approfondir", "nouvel_episode", "reponse"],
    }


def appliquer_retours(memoire: dict, resultat: dict, reglages: dict,
                      maintenant: dt.datetime) -> None:
    """Range les réglages compris dans la mémoire (seulement ce qui diffère de reglages.toml)."""
    preferences = memoire.setdefault("preferences", memoire_vide()["preferences"])
    vitesse = resultat.get("vitesse_parole")
    if vitesse in VITESSES:
        preferences["vitesse_parole"] = None if vitesse == reglages["vitesse_parole"] else vitesse
    duree = resultat.get("duree_minutes")
    if isinstance(duree, (int, float)) and 2 <= duree <= 12:
        duree = round(float(duree), 1)
        preferences["duree_minutes"] = None if duree == float(reglages["duree_minutes"]) else duree
    ville = str(resultat.get("ville_habituelle") or "").strip()
    if not ville or ville.lower() in ("inconnue", "(inconnue)", "aucune"):
        ville = ""
    preferences["ville_habituelle"] = (ville or None) if ville != reglages["ville_habituelle"] else None
    preferences["consignes"] = nettoyer_liste(resultat.get("consignes"), 15, LONGUEUR_CONSIGNE)
    a_eviter = nettoyer_liste(resultat.get("sujets_a_eviter"))
    exclus = {sans_accents(s.lower()) for s in a_eviter}
    preferences["sujets_a_eviter"] = a_eviter
    preferences["sujets_preferes"] = [s for s in nettoyer_liste(resultat.get("sujets_preferes"))
                                      if sans_accents(s.lower()) not in exclus]
    anciens = {sans_accents(a["sujet"].lower()): a for a in memoire.get("a_approfondir") or []
               if isinstance(a, dict) and a.get("sujet")}
    memoire["a_approfondir"] = [
        anciens.get(sans_accents(sujet.lower()),
                    {"sujet": sujet, "demande_le": maintenant.date().isoformat()})
        for sujet in nettoyer_liste(resultat.get("a_approfondir"), 5)]


def resume_preferences(reglages: dict, memoire: dict) -> str:
    effectifs = reglages_effectifs(reglages, memoire)
    e = echapper

    def liste(valeurs: list[str], separateur: str = ", ") -> str:
        return e(separateur.join(valeurs)) if valeurs else "—"
    return "\n".join([
        "🎛️ <b>Tes réglages actuels</b>",
        f"• Vitesse de parole : {e(effectifs['vitesse_parole'])}",
        f"• Durée : {effectifs['duree_minutes']:g} min",
        f"• Ville habituelle : {e(effectifs['ville_habituelle']) or 'non précisée'}",
        f"• Sujets préférés : {liste(effectifs['sujets_preferes'])}",
        f"• Sujets à éviter : {liste(effectifs['sujets_a_eviter'])}",
        f"• Consignes : {liste(effectifs['consignes'], ' ; ')}",
        "• À approfondir au prochain épisode : "
        + liste([a["sujet"] for a in effectifs["a_approfondir"]]),
    ])


def demander_nouvel_episode(memoire: dict, maintenant: dt.datetime) -> str:
    """Note la demande d'un nouvel épisode (au plus MAX_EPISODES_REFAITS par jour)."""
    if memoire.get("_nouvel_episode"):
        return "🎙️ Le nouvel épisode est déjà en préparation."
    compte = memoire.get("episodes_refaits") or {}
    nombre = compte.get("nombre", 0) if compte.get("date") == maintenant.date().isoformat() else 0
    if nombre >= MAX_EPISODES_REFAITS:
        return (f"🚫 Déjà {nombre} épisodes refaits aujourd'hui : c'est le maximum, pour ne pas "
                "épuiser le quota gratuit de la voix (10 par jour). Ça repart demain.")
    memoire["episodes_refaits"] = {"date": maintenant.date().isoformat(), "nombre": nombre + 1}
    memoire["_nouvel_episode"] = True
    return "🎙️ Je prépare un nouvel épisode : il arrive dans trois ou quatre minutes."


def traiter_retours(telegram: Telegram, conversation: str, cle: str, reglages: dict,
                    memoire: dict, maintenant: dt.datetime) -> bool:
    """Lit les nouveaux messages de l'auditeur, ajuste la mémoire et lui répond.
    Renvoie True si la mémoire doit être enregistrée."""
    depuis = int(memoire.get("telegram_dernier_update") or 0)
    mises_a_jour = telegram.mises_a_jour(depuis)
    if not mises_a_jour:
        return False
    messages: list[dict[str, str]] = []
    commandes: list[str] = []
    reinitialiser = False
    for mise_a_jour in mises_a_jour:
        message = mise_a_jour.get("message") or {}
        if str((message.get("chat") or {}).get("id")) != str(conversation):
            continue                       # quelqu'un d'autre a écrit au bot : ignoré
        if (message.get("from") or {}).get("is_bot"):
            continue
        texte = str(message.get("text") or message.get("caption") or "").strip()
        if texte.startswith("/"):
            commande = texte.split()[0].split("@")[0].lower()
            if commande in COMMANDES_REINITIALISER:
                reinitialiser = True
                messages.clear()           # les demandes précédentes sont annulées
            else:
                commandes.append(commande)
            continue
        if texte:
            messages.append({"texte": tronquer(texte, 1500)})
        vocal = message.get("voice") or message.get("audio")
        if isinstance(vocal, dict) and vocal.get("file_id"):
            if int(vocal.get("duration") or 0) <= 300:
                messages.append({"vocal": vocal["file_id"]})
            else:
                messages.append({"texte": "(message vocal de plus de 5 minutes, non écouté)"})
    nouveau_depart = max(int(m.get("update_id", 0)) for m in mises_a_jour)

    envois: list[str] = []             # réponses, envoyées une fois tout compris
    if reinitialiser:
        memoire["preferences"] = memoire_vide()["preferences"]
        memoire["a_approfondir"] = []
        envois.append("🔄 C'est remis à zéro : le podcast reprend ses réglages de base "
                      "(ceux de reglages.toml).")

    if messages:
        contenus: list[dict[str, Any]] = [
            {"type": "text", "text": contexte_retours(reglages, memoire, maintenant)}]
        for numero, element in enumerate(messages, 1):
            if "texte" in element:
                contenus.append({"type": "text", "text": f"Message {numero} (écrit) : {element['texte']}"})
                continue
            try:
                audio = telegram.fichier(element["vocal"])
            except ErreurPodcast as erreur:
                journal(f"Vocal {numero} illisible : {erreur}")
                contenus.append({"type": "text",
                                 "text": f"Message {numero} (vocal) : impossible à récupérer."})
                continue
            contenus.append({"type": "text", "text": f"Message {numero} (vocal) :"})
            contenus.append({"type": "audio", "data": base64.b64encode(audio).decode("ascii"),
                             "mime_type": "audio/ogg"})
        try:
            resultat, modele = demander_json(consigne_retours(reglages), contenus, schema_retours(),
                                             reglages["modeles_rapides"], cle, delai=120, tours=1)
        except ErreurPodcast as erreur:
            # Les messages seront relus à la prochaine exécution ; on ne prévient qu'une fois.
            journal(f"Messages Telegram non compris pour l'instant : {erreur}")
            if memoire.get("retours_echec_signale") == nouveau_depart:
                return False
            memoire["retours_echec_signale"] = nouveau_depart
            if "clé Gemini est refusée" in str(erreur):
                raison = "la clé Gemini est refusée : vérifie-la dans l'application (Réglages › Connexions)"
            elif "quota" in str(erreur).lower():
                raison = "le quota gratuit de Gemini est atteint pour le moment"
            else:
                raison = "Gemini ne répond pas pour le moment"
            telegram.message(conversation, (
                f"⏳ Je n'arrive pas à lire ton message tout de suite ({raison}). "
                "Je réessaie automatiquement au prochain passage."))
            return True
        appliquer_retours(memoire, resultat, reglages, maintenant)
        reponse = tronquer(str(resultat.get("reponse") or "C'est noté."), 800)
        historique = memoire.setdefault("historique_retours", [])
        historique.append({
            "date": maintenant.isoformat(timespec="minutes"),
            "messages": [m.get("texte", "(vocal)") for m in messages],
            "reponse": reponse,
        })
        del historique[:-20]
        journal(f"{len(messages)} message(s) de l'auditeur compris par {modele}.")
        envois.append("✅ " + echapper(reponse))
        if resultat.get("nouvel_episode") is True:
            envois.append(demander_nouvel_episode(memoire, maintenant))

    for commande in dict.fromkeys(commandes):
        if commande in ("/reglages", "/preferences", "/préférences"):
            envois.append(resume_preferences(reglages, memoire))
        elif commande in COMMANDES_PODCAST:
            envois.append(demander_nouvel_episode(memoire, maintenant))
        else:                              # /aide, /start ou commande inconnue
            envois.append(echapper(AIDE))
    for texte in dict.fromkeys(envois):
        telegram.message(conversation, texte)

    memoire["telegram_dernier_update"] = nouveau_depart
    telegram.confirmer(nouveau_depart)   # le relais Cloudflare voit ainsi qu'ils sont traités
    return True


# ─────────────────────────────── déplacements ───────────────────────────────

def schema_deplacements() -> dict:
    return {
        "type": "object",
        "properties": {
            "deplacements": {
                "type": "array",
                "maxItems": 4,
                "items": {
                    "type": "object",
                    "properties": {
                        "lieu": {"type": "string"},
                        "pays": {"type": "string"},
                        "quand": {"type": "string"},
                        "nature": {"type": "string", "enum": ["voyage", "rencontre", "sortie"]},
                        "evenement": {"type": "string"},
                        "recherche": {"type": "string"},
                    },
                    "required": ["lieu", "pays", "quand", "nature", "evenement", "recherche"],
                },
            },
        },
        "required": ["deplacements"],
    }


def evoque_un_lieu(evenement: Evenement) -> bool:
    return bool(evenement.lieu or INDICES_DEPLACEMENT.search(evenement.titre)
                or INDICE_VILLE.search(evenement.titre))


def reperer_deplacements(evenements: list[Evenement], effectifs: dict, cle: str,
                         maintenant: dt.datetime,
                         prochain: Evenement | None = None) -> list[dict[str, Any]]:
    """Demande à Gemini quels événements à venir sont des voyages, des rencontres
    ou des sorties qui méritent des idées d'activités et les actus du lieu."""
    if effectifs["jours_deplacements"] <= 0:
        return []
    limite = debut_du_jour(maintenant) + dt.timedelta(days=effectifs["jours_deplacements"])
    candidats = [e for e in evenements if e.debut < limite and evoque_un_lieu(e)]
    if prochain is not None and prochain not in candidats and evoque_un_lieu(prochain):
        candidats.append(prochain)         # agenda vide : le prochain événement, même lointain
    if not candidats:
        return []
    ville = effectifs.get("ville_habituelle") or "inconnue"
    systeme = f"""Tu repères dans l'agenda de l'auditeur les déplacements et les sorties à venir, pour que son podcast du matin lui propose des idées d'activités, de la culture et les actus du lieu.
Ville où il vit : {ville}.
Retiens au plus deux événements, les plus marquants :
- un voyage ou un séjour ;
- une rencontre ou une sortie dans une autre ville ou région que celle où il vit ;
- ou, dans sa ville, une sortie de loisir dans un lieu précis (concert, spectacle, musée, festival, match, restaurant…).
Ignore les réunions en ligne (Teams, Zoom, Meet…), les rendez-vous de routine (travail, médecin, cours ou sport habituels) et les lieux trop vagues. Si sa ville est inconnue, ne retiens que les voyages explicites (vol, train, hôtel, séjour, vacances, conférence dans une ville…) et les sorties de loisir.
Pour chacun : le lieu en clair (ville ou région ; pour une sortie dans sa ville, le nom du lieu et la ville), le pays, quand (en toutes lettres, ex. « du jeudi 22 au dimanche 25 octobre »), la nature (voyage, rencontre ou sortie), le titre de l'événement, et une requête de recherche d'actualités très simple (en général le nom de la ville ; pour une sortie dans sa ville, le nom du lieu ou de l'artiste).
S'il n'y a rien de tel, renvoie une liste vide."""
    lignes = [f"- {quand_court(e)} : {e.titre}" + (f" — lieu : {e.lieu}" if e.lieu else "")
              for e in candidats[:25]]
    entree = f"Aujourd'hui : {date_longue(maintenant.date())}.\nÉvénements à venir :\n" + "\n".join(lignes)
    try:
        resultat, _ = demander_json(systeme, entree, schema_deplacements(),
                                    effectifs["modeles_rapides"], cle, delai=120, tours=1)
    except ErreurPodcast as erreur:
        journal(f"Repérage des déplacements impossible : {erreur}")
        return []
    deplacements = []
    for element in resultat.get("deplacements") or []:
        if not isinstance(element, dict) or not str(element.get("lieu", "")).strip():
            continue
        deplacements.append({cle: str(element.get(cle, "")).strip()[:120] for cle in
                             ("lieu", "pays", "quand", "nature", "evenement", "recherche")})
    if deplacements:
        journal("Déplacements repérés : " + ", ".join(d["lieu"] for d in deplacements))
    return deplacements[:int(effectifs.get("max_deplacements") or 2)]


# ───────────────────────────── écriture du script ───────────────────────────

def minutes_visees(effectifs: dict, collectes: dict | None = None) -> float:
    """Durée visée : celle choisie, plus un peu pour les approfondissements et les
    rubriques développées des règles (sinon elles mangent les actualités)."""
    developpees = sum(1 for c in (collectes or {}).values()
                      if (c.regle.get("rubrique") or {}).get("longueur") == "developpee")
    return effectifs["duree_minutes"] + (1 if effectifs.get("a_approfondir") else 0) + min(2.0, 0.5 * developpees)


def consigne_systeme(effectifs: dict, rubriques: list[tuple[str, str]] | None = None,
                     collectes: dict | None = None) -> str:
    noms_animateurs = [x["nom"] for x in effectifs["animateurs"]]
    seul = len(noms_animateurs) == 1
    a, b = noms_animateurs[0], noms_animateurs[-1]
    collectes = collectes or {}
    minutes = minutes_visees(effectifs, collectes)
    # Gemini écrit souvent plus court que demandé : on demande en proportion de ce qu'il a réellement écrit.
    mots = round(minutes * effectifs.get("mots_par_minute", VITESSES[effectifs["vitesse_parole"]][1])
                 / effectifs.get("remplissage", 1.0))
    adresse = "Tutoie" if effectifs["tutoiement"] else "Vouvoie"
    prenom = effectifs.get("prenom_auditeur", "").strip()
    qui = f"{adresse} l'auditeur, qui s'appelle {prenom}." if prenom else f"{adresse} l'auditeur."
    interets = [s for s in [effectifs.get("centres_interet", "").strip()] if s]
    interets += effectifs.get("sujets_preferes") or []
    preferences = ""
    if interets:
        preferences += (f"\n- Thèmes préférés de l'auditeur : {', '.join(interets)}. "
                        "Donne-leur la priorité dans le choix des actualités.")
    if effectifs.get("sujets_a_eviter"):
        preferences += (f"\n- Thèmes qui ne l'intéressent pas : {', '.join(effectifs['sujets_a_eviter'])}. "
                        "Ne les traite pas, même s'ils figurent dans les actualités.")
    for consigne in effectifs.get("consignes") or []:
        preferences += f"\n- Consigne de l'auditeur, à respecter : {consigne}."
    ton = TONS.get(effectifs.get("ton", "naturel"), "")
    if ton:
        preferences += f"\n- {ton}"
    if effectifs.get("citer_sources") in ("oral", "les_deux"):
        preferences += "\n- Cite brièvement la source de chaque actualité à l'oral (« selon la RTS… », « d'après 24 heures… »)."

    if rubriques is None:
        rubriques = list(moteur.RUBRIQUES.items())
    lignes = []
    for numero, (cle_rubrique, titre) in enumerate(rubriques, 1):
        if cle_rubrique in INSTRUCTIONS_RUBRIQUES:
            texte = INSTRUCTIONS_RUBRIQUES[cle_rubrique].format(
                n=effectifs["nombre_sujets"], ville=effectifs.get("ville_habituelle") or "la ville de l'auditeur",
                d_abord=pays_auditeur.profil()["d_abord"])
        else:
            regle = collectes[cle_rubrique].regle
            longueur = moteur.LONGUEURS.get((regle.get("rubrique") or {}).get("longueur"), "courte (2 à 4 répliques)")
            texte = (f"« {titre} » (rubrique {cle_rubrique}) : {regle.get('consigne', '')} Longueur : {longueur}. "
                     f"Appuie-toi sur la section RUBRIQUE {cle_rubrique}.")
        lignes.append(f"{numero}. {texte}")
    deroule = "\n".join(lignes)
    sans_rubrique = [(k, c) for k, c in collectes.items() if not c.regle.get("rubrique")]
    if sans_rubrique:
        deroule += ("\n\nRubriques particulières du jour, à intégrer là où c'est le plus naturel (voir les sections RUBRIQUE) :\n"
                    + "\n".join(f"- {k} : {c.regle.get('consigne', '')}" for k, c in sans_rubrique))
    cles = [c for c, _ in rubriques]
    return f"""Tu écris le script d'un podcast audio quotidien, personnel et privé, écouté par une seule personne au réveil.
{f"Il est présenté par une seule voix, {a}, qui s'adresse directement à l'auditeur comme une chronique de radio matinale : vivante, chaleureuse, avec une pointe d'humour, mais toujours claire, précise et utile. Toutes les répliques sont dites par {a}." if seul else f"Il est animé par deux voix, {a} et {b}, qui discutent ensemble à la manière des « Audio Overviews » de NotebookLM : une vraie conversation, vivante et chaleureuse, avec des relances, des réactions spontanées et une pointe d'humour, mais toujours claire, précise et utile."}

Écris le script complet de l'épisode du jour, réplique par réplique, à partir UNIQUEMENT des informations fournies.

Déroulé (dans cet ordre) :
{deroule}

Style et règles :
- Français parlé naturel, ton de radio matinale, phrases courtes faciles à suivre à l'oral.
- {qui}
- {"L'animateur ne raconte pas d'anecdotes personnelles inventées." if seul else "Les deux animateurs apportent du contenu : pas de « oui », « exactement » ou « tout à fait » en boucle. Ils ne racontent pas d'anecdotes personnelles inventées."}
- Quelques hésitations ou interjections naturelles sont bienvenues (« bon », « alors », « ah oui »), sans excès.
- N'invente AUCUN fait, chiffre, citation, nom ou détail d'actualité absent des informations fournies. Si un titre est ambigu, reste général. Ne présente jamais une supposition comme un fait. Tu ne connais ni la météo du jour ni l'humeur de l'auditeur : n'en parle que si les informations fournies le permettent.
- Sur les sujets politiques ou de société, reste neutre et factuel, sans donner d'opinion.
- Si la section ÉPISODE PRÉCÉDENT est fournie, ne répète pas ce qui a déjà été dit : pour un sujet qui continue, dis ce qui est nouveau.
- Ne lis à voix haute ni adresse web, ni numéro de téléphone, ni code, ni numéro d'article entre crochets.
- Pas de markdown, pas d'emoji, pas de didascalies entre parenthèses ou crochets : chaque réplique est lue telle quelle.
- Écris les heures comme on les dit (« 9 h 30 », « midi », « 14 h ») et les nombres de façon naturelle.
- Avec parcimonie ({MAX_BALISES} fois au maximum sur tout l'épisode), tu peux insérer ces sons non verbaux, écrits en anglais entre chevrons : <laugh>, <chuckle>, <sigh>, <breath>, <short pause>.
- {"Pas de réaction entre barres verticales : il n'y a qu'une voix." if seul else f"{MAX_REACTIONS - 1} fois au maximum, tu peux glisser une très courte réaction de l'autre animateur entre barres verticales au milieu d'une réplique, par exemple : « Et le budget a été adopté hier soir |ah enfin| après trois jours de débat. »"}
- Longueur : entre {mots} et {round(mots * 1.1)} mots au total, pour durer {minutes:g} minutes à l'oral, en {round(minutes * 6)} à {round(minutes * 10)} répliques. C'est important : n'écris pas moins de {mots} mots ; développe plutôt les sujets.{preferences}

Remplis aussi « titre » (court, accrocheur, sans date), « sujets » (les sujets d'actualité traités, dans l'ordre, en quelques mots chacun), « sources » (les numéros des articles dont l'épisode parle) et, pour chaque réplique, « rubrique » : la clé de la rubrique du déroulé à laquelle elle appartient, parmi {", ".join(cles)}."""


def demande_du_jour(reglages: dict, maintenant: dt.datetime, agenda: str,
                    sections: list[tuple[str, str]], remarques: list[str]) -> str:
    blocs = [f"Nous sommes le {date_longue(maintenant.date())}, il est {heure_parlee(maintenant)} "
             f"(fuseau {reglages['fuseau_horaire']}).", f"=== AGENDA ===\n{agenda}"]
    blocs += [f"=== {titre} ===\n{contenu}" for titre, contenu in sections if contenu]
    if remarques:
        blocs.append("À signaler en une phrase pendant l'épisode : " + "; ".join(remarques) + ".")
    blocs.append("Écris le script de l'épisode d'aujourd'hui.")
    return "\n\n".join(blocs)


def schema_script(noms: list[str], rubriques: list[str] | None = None) -> dict:
    proprietes: dict[str, Any] = {
        "animateur": {"type": "string", "enum": noms},
        "texte": {"type": "string", "description": "Ce que dit l'animateur, lu tel quel."},
    }
    requis = ["animateur", "texte"]
    if rubriques:
        proprietes["rubrique"] = {"type": "string", "enum": rubriques,
                                  "description": "Rubrique du déroulé à laquelle appartient la réplique."}
        requis.append("rubrique")
    return {
        "type": "object",
        "properties": {
            "titre": {"type": "string", "description": "Titre court de l'épisode, sans date."},
            "repliques": {
                "type": "array",
                "minItems": 6,
                "items": {"type": "object", "properties": proprietes, "required": requis},
            },
            "sujets": {"type": "array", "items": {"type": "string"},
                       "description": "Sujets abordés, dans l'ordre, en quelques mots chacun."},
            "sources": {"type": "array", "items": {"type": "integer"},
                        "description": "Numéros des articles utilisés."},
            **({"idees": {"type": "array", "items": {"type": "string"},
                          "description": "Idées de visites ou d'activités proposées dans la rubrique déplacements, "
                                         "en quelques mots chacune (ex. « musée Réattu à Arles »)."}}
               if rubriques and "deplacements" in rubriques else {}),
        },
        "required": ["titre", "repliques", "sujets", "sources"]
                    + (["idees"] if rubriques and "deplacements" in rubriques else []),
    }


def nettoyer_replique(texte: str, compteurs: dict[str, int]) -> str:
    """Rend une réplique sûre pour la synthèse vocale (lue mot pour mot)."""
    texte = texte.replace("\x00", " ")
    texte = re.sub(r"\[[^\]]*\]", " ", texte)            # références [3], didascalies
    texte = re.sub(r"[*_#`~]+", "", texte)                 # restes de markdown
    texte = re.sub(r"https?://\S+", "", texte)
    gardes: list[str] = []

    def garder(fragment: str) -> str:
        gardes.append(fragment)
        return f" \x00{len(gardes) - 1}\x00 "

    def balise(correspondance: re.Match) -> str:
        nom = correspondance.group(1).strip().lower()
        if nom in BALISES_AUTORISEES and compteurs["balises"] < MAX_BALISES:
            compteurs["balises"] += 1
            return garder(f"<{nom}>")
        return " "

    def reaction(correspondance: re.Match) -> str:
        contenu = correspondance.group(1).strip()
        if len(contenu.split()) > 5:        # pas une réaction : on garde les mots
            return f" {contenu} "
        if contenu and compteurs["reactions"] < MAX_REACTIONS:
            compteurs["reactions"] += 1
            return garder(f"|{contenu}|")
        return " "

    texte = re.sub(r"<([^<>]{1,30})>", balise, texte)
    texte = re.sub(r"\|([^|\x00]*)\|", reaction, texte)
    texte = re.sub(r"[<>|]", " ", texte)                   # restes orphelins
    texte = "".join(c for c in texte if unicodedata.category(c) not in ("So", "Cs", "Co"))
    texte = re.sub(r"\x00(\d+)\x00", lambda m: gardes[int(m.group(1))], texte)
    texte = re.sub(r"\s+", " ", texte).strip()
    return re.sub(r"\s+([.,])", r"\1", texte)


def nettoyer_script(script: dict, noms: list[str], rubriques: list[str] | None = None) -> dict:
    compteurs = {"balises": 0, "reactions": 0}
    par_nom = {sans_accents(n).lower(): n for n in noms}
    repliques: list[dict] = []
    for brute in script.get("repliques") or []:
        if not isinstance(brute, dict):
            continue
        texte = nettoyer_replique(str(brute.get("texte", "")), compteurs)
        if not re.search(r"\w", texte.replace("|", "")):
            continue
        nom = par_nom.get(sans_accents(str(brute.get("animateur", ""))).lower().strip())
        if nom is None:   # nom inconnu : on alterne
            nom = noms[1] if len(noms) > 1 and repliques and repliques[-1]["animateur"] == noms[0] else noms[0]
        rubrique = str(brute.get("rubrique", ""))
        if rubriques is not None:
            if rubrique not in rubriques:
                rubrique = repliques[-1]["rubrique"] if repliques else rubriques[0] if rubriques else ""
        if repliques and repliques[-1]["animateur"] == nom and repliques[-1].get("rubrique", "") == rubrique:
            repliques[-1]["texte"] += " " + texte          # deux répliques d'affilée
        else:
            replique = {"animateur": nom, "texte": texte}
            if rubriques is not None:
                replique["rubrique"] = rubrique
            repliques.append(replique)
    if len(repliques) < 4:
        raise ErreurPodcast("Le script renvoyé par Gemini est trop court ou vide.")
    sources = sorted({int(s) for s in script.get("sources") or []
                      if isinstance(s, (int, float, str)) and str(s).strip().isdigit()})
    titre = nettoyer_replique(str(script.get("titre", "")), {"balises": 99, "reactions": 99})
    return {"titre": tronquer(titre.replace("|", ""), 60) or "Le point du matin",
            "repliques": repliques, "sources": sources,
            "sujets": nettoyer_liste(script.get("sujets"), 12),
            "idees": nettoyer_liste(script.get("idees"), 8)}


script_mots_vises = [0]   # mots visés pour l'épisode en cours (mesure du remplissage, après l'épisode)


def ecrire_script(effectifs: dict, cle: str, maintenant: dt.datetime, agenda: str,
                  sections: list[tuple[str, str]], remarques: list[str],
                  rubriques: list[tuple[str, str]] | None = None, collectes: dict | None = None) -> dict:
    noms = [a["nom"] for a in effectifs["animateurs"]]
    cles = [c for c, _ in rubriques] if rubriques else None
    # Les modèles légers (quotas bien plus larges) servent de dernier recours.
    modeles = list(dict.fromkeys(effectifs["modeles_texte"] + effectifs["modeles_rapides"]))
    systeme = consigne_systeme(effectifs, rubriques, collectes)
    brut, modele = demander_json(
        systeme, demande_du_jour(effectifs, maintenant, agenda, sections, remarques),
        schema_script(noms, cles), modeles, cle, reflexion=effectifs["reflexion"])
    script = nettoyer_script(brut, noms, cles)
    mots = sum(len(r["texte"].split()) for r in script["repliques"])
    minutes = minutes_visees(effectifs, collectes)
    vise = round(minutes * effectifs.get("mots_par_minute", 180))
    script_mots_vises[0] = vise
    if mots < SEUIL_SCRIPT_COURT * vise:     # script trop court (fréquent avec les modèles légers) : on le fait étoffer
        journal(f"Script trop court ({mots} mots pour {vise} visés) : demande d'une version plus longue.")
        try:
            plus_long, _ = demander_json(
                systeme,
                demande_du_jour(effectifs, maintenant, agenda, sections, remarques)
                + f"\n\nUne première version ne faisait que {mots} mots : c'est trop court. "
                  f"Écris une version complète d'au moins {vise} mots, en développant chaque sujet.",
                schema_script(noms, cles), [modele], cle, reflexion=effectifs["reflexion"], tours=1)
            candidat = nettoyer_script(plus_long, noms, cles)
            mots_candidat = sum(len(r["texte"].split()) for r in candidat["repliques"])
            if mots_candidat > mots:
                script, mots = candidat, mots_candidat
        except ErreurPodcast as erreur:
            journal(f"Version plus longue impossible ({erreur}) : on garde la première.")
    journal(f"Script écrit par {modele} : « {script['titre']} », "
            f"{len(script['repliques'])} répliques, {mots} mots.")
    return script


# ───────────────────────────────── voix ─────────────────────────────────────

def decouper(repliques: list[tuple[str, str]], maximum: int) -> list[list[tuple[str, str]]]:
    morceaux: list[list[tuple[str, str]]] = [[]]
    taille = 0
    for replique in repliques:
        if morceaux[-1] and taille + len(replique[1]) > maximum:
            morceaux.append([])
            taille = 0
        morceaux[-1].append(replique)
        taille += len(replique[1])
    return morceaux


def variantes_voix(morceau: list[tuple[str, str]], voix: dict[str, str],
                   style: str = "") -> list[dict]:
    """Requête Gemini TTS multi-locuteurs (format 3.8), puis versions simplifiées.
    Le style (vitesse de parole) est retiré en dernier recours si l'API le refuse."""
    locuteurs = [{"speaker": locuteur, "voice": nom_voix} for locuteur, nom_voix in voix.items()]

    def entree(avec_style: bool) -> list[dict]:
        def annotation(locuteur: str) -> dict[str, str]:
            meta = {"type": "speech_metadata", "speaker": locuteur}
            if avec_style and style:
                meta["style"] = style
            return meta
        return [{
            "type": "user_input",
            "content": [{"type": "text", "text": texte, "annotations": [annotation(locuteur)]}
                        for locuteur, texte in morceau],
        }]
    pcm = {"type": "audio", "mime_type": "audio/l16", "sample_rate": TAUX_PAR_DEFAUT}
    variantes = []
    for avec_style in ([True, False] if style else [False]):
        variantes += [
            {"input": entree(avec_style), "response_format": pcm, "store": False,
             "generation_config": {"speech_config": {"mode": "conversational",
                                                     "speakers": locuteurs}}},
            {"input": entree(avec_style), "response_format": pcm, "store": False,
             "generation_config": {"speech_config": {"speakers": locuteurs}}},
            {"input": entree(avec_style), "response_format": {"type": "audio"}, "store": False,
             "generation_config": {"speech_config": {"speakers": locuteurs}}},
        ]
    return variantes


def pcm_depuis_wav(donnees: bytes) -> tuple[bytes, int]:
    """Extrait le PCM 16 bits d'un fichier WAV (lecture manuelle, tolérante)."""
    position, taux, canaux, bits, pcm = 12, TAUX_PAR_DEFAUT, 1, 16, None
    while position + 8 <= len(donnees):
        identifiant_bloc = donnees[position:position + 4]
        taille = struct.unpack("<I", donnees[position + 4:position + 8])[0]
        debut = position + 8
        if identifiant_bloc == b"fmt ":
            _, canaux, taux = struct.unpack("<HHI", donnees[debut:debut + 8])
            bits = struct.unpack("<H", donnees[debut + 14:debut + 16])[0]
        elif identifiant_bloc == b"data":
            fin = len(donnees) if taille in (0, 0xFFFFFFFF) else min(len(donnees), debut + taille)
            pcm = donnees[debut:fin]
            break
        position = debut + taille + (taille % 2)
    if pcm is None or bits != 16:
        raise ErreurPodcast("Audio WAV inattendu renvoyé par Gemini.")
    if canaux == 2:                       # stéréo → mono (canal gauche)
        pcm = b"".join(pcm[i:i + 2] for i in range(0, len(pcm) - 3, 4))
    return pcm, taux


def extraire_audio(reponse: dict) -> tuple[bytes, int]:
    blocs = [c for c in contenus_produits(reponse) if c.get("type") == "audio" and c.get("data")]
    if not blocs:
        raise ErreurPodcast("Gemini n'a renvoyé aucun audio.")
    morceaux: list[bytes] = []
    taux = None
    for bloc in blocs:
        donnees = base64.b64decode(bloc["data"])
        if donnees[:4] == b"RIFF" or str(bloc.get("mime_type", "")).startswith("audio/wav"):
            pcm, taux_bloc = pcm_depuis_wav(donnees)
        else:
            pcm, taux_bloc = donnees, int(bloc.get("sample_rate") or TAUX_PAR_DEFAUT)
        taux = taux or taux_bloc
        morceaux.append(pcm)
    if len(morceaux) > 1:
        plus_long = max(morceaux, key=len)
        if len(plus_long) >= 0.9 * sum(len(m) for m in morceaux):
            morceaux = [plus_long]           # blocs cumulatifs : on garde le complet
    pcm = b"".join(morceaux)
    return pcm[: len(pcm) - (len(pcm) % 2)], taux or TAUX_PAR_DEFAUT


def silence(secondes: float, taux: int) -> bytes:
    return b"\x00\x00" * int(secondes * taux)


def synthetiser_morceau(morceau: list[tuple[str, str]], voix: dict[str, str], cle: str,
                        etat: dict, profondeur: int = 0) -> tuple[bytes, int]:
    reponse, modele = appeler_avec_variantes(
        variantes_voix(morceau, voix, etat.get("style", "")), etat["modeles"], cle, 300, etat)
    pcm, taux = extraire_audio(reponse)
    duree = len(pcm) / (2 * taux)
    attendue = sum(len(t) for _, t in morceau) / CARACTERES_PAR_SECONDE
    journal(f"Voix ({modele}) : {duree:.0f} s d'audio pour ~{attendue:.0f} s attendues.")
    tronque = reponse.get("status") == "incomplete" or duree < 0.45 * attendue
    if tronque and len(morceau) > 1 and profondeur < 3:
        journal("Audio incomplet : on recommence en deux moitiés.")
        moitie = len(morceau) // 2
        debut, taux_a = synthetiser_morceau(morceau[:moitie], voix, cle, etat, profondeur + 1)
        fin, _ = synthetiser_morceau(morceau[moitie:], voix, cle, etat, profondeur + 1)
        return debut + silence(0.3, taux_a) + fin, taux_a
    return pcm, taux


def synthetiser(script: dict, effectifs: dict, cle: str,
                minutage: list[float] | None = None) -> tuple[bytes, int]:
    """Met le script en voix. Si « minutage » est fourni, il reçoit l'instant de
    début (en secondes, dans le MP3 final) de chaque réplique : pour les chapitres."""
    ids = {a["nom"]: identifiant(a["nom"]) for a in effectifs["animateurs"]}
    voix = {ids[a["nom"]]: a["voix"] for a in effectifs["animateurs"]}
    if len(voix) == 1:
        # Une seule voix : la requête multi-locuteurs garde un second locuteur, muet, de même voix.
        voix["Second"] = next(iter(voix.values()))
    repliques = [(ids[r["animateur"]], r["texte"]) for r in script["repliques"]]
    morceaux = decouper(repliques, int(effectifs["caracteres_par_requete_voix"]))
    etat: dict[str, Any] = {"variante": 0, "modeles": list(effectifs["modeles_voix"]),
                            "style": VITESSES[effectifs["vitesse_parole"]][0]}
    sons: list[bytes] = []
    taux = None
    instant = 0.3                      # silence d'ouverture ajouté par encoder_mp3
    for numero, morceau in enumerate(morceaux, 1):
        journal(f"Mise en voix {numero}/{len(morceaux)} "
                f"({sum(len(t) for _, t in morceau)} caractères)…")
        pcm, taux_morceau = synthetiser_morceau(morceau, voix, cle, etat)
        if taux and taux_morceau != taux:
            raise ErreurPodcast("Fréquences audio incohérentes entre les morceaux.")
        taux = taux_morceau
        sons.append(pcm)
        if minutage is not None:
            if numero > 1:
                instant += 0.4
            duree = len(pcm) / (2 * taux)
            total = sum(len(t) for _, t in morceau) or 1
            for _, texte in morceau:
                minutage.append(round(instant, 1))
                instant += duree * len(texte) / total
    taux = taux or TAUX_PAR_DEFAUT
    return silence(0.4, taux).join(sons), taux


def calculer_chapitres(script: dict, minutage: list[float],
                       rubriques: list[tuple[str, str]] | None) -> list[tuple[float, str]]:
    """Début de chaque rubrique dans l'épisode : [(secondes, titre)]."""
    if not rubriques or len(minutage) != len(script["repliques"]):
        return []
    titres = dict(rubriques)
    chapitres: list[tuple[float, str]] = []
    precedente = None
    for replique, instant in zip(script["repliques"], minutage):
        rubrique = replique.get("rubrique")
        if rubrique and rubrique != precedente and rubrique in titres:
            chapitres.append((0.0 if not chapitres else instant, titres[rubrique]))
            precedente = rubrique
    return chapitres


def minute_seconde(secondes: float) -> str:
    secondes = int(round(secondes))
    return f"{secondes // 60}:{secondes % 60:02d}"


def clavier_application(adresse: str, date: str) -> list[list[dict]]:
    """Sous l'épisode : un bouton qui ouvre l'application (Mini App) sur cet épisode."""
    return [[{"text": "🎧 Ouvrir dans l'application", "web_app": {"url": f"{adresse}?episode={date}"}}]]


def clavier_episode(date: str, nombre_sujets: int, details: list[str] | None = None) -> list[list[dict]]:
    """Boutons sous l'épisode : mêmes données que le bot (cloudflare/src/ui.js)."""
    def bouton(cle_bouton: str, texte: str) -> dict:
        return {"text": texte, "callback_data": f"e:{date}:{cle_bouton}"}
    clavier = [[bouton("up", "👍"), bouton("down", "👎")],
               [bouton("court", "Plus court"), bouton("long", "Plus long"),
                bouton("lent", "Moins vite"), bouton("vite", "Plus vite")]]
    sujets = [bouton(f"cr{i + 1}", f"🔎 Sujet {i + 1}") for i in range(min(nombre_sujets, 5))]
    if sujets:
        clavier.append(sujets)
    clavier.append([bouton("txt", "📝 Texte"), bouton("redo", "🔁 Refaire")])
    for identifiant_regle in (details or [])[:2]:
        clavier.append([{"text": f"📍 Détails des idées ({identifiant_regle})",
                         "callback_data": f"a:rl:{identifiant_regle}:ecrit"}])
    return clavier


def encoder_mp3(pcm: bytes, taux: int, debit_kbps: int) -> bytes:
    pcm = silence(0.3, taux) + pcm + silence(0.8, taux)
    encodeur = lameenc.Encoder()
    encodeur.set_bit_rate(debit_kbps)
    encodeur.set_in_sample_rate(taux)
    encodeur.set_channels(1)
    encodeur.set_quality(2)
    return bytes(encodeur.encode(pcm) + encodeur.flush())


# ──────────────────────────────── Telegram ──────────────────────────────────

class Telegram:
    def __init__(self, jeton: str) -> None:
        self.jeton = jeton

    def appeler(self, methode: str, donnees: dict | None = None,
                fichiers: dict | None = None, delai: int = 60) -> Any:
        url = URL_TELEGRAM.format(jeton=self.jeton, methode=methode)
        for essai in range(3):
            try:
                reponse = requests.post(url, data=donnees, files=fichiers, timeout=delai)
                resultat = reponse.json()
            except (requests.RequestException, ValueError) as erreur:
                if essai == 2:
                    raise ErreurPodcast(f"Telegram injoignable ({type(erreur).__name__})")
                time.sleep(5 * (essai + 1))
                continue
            if resultat.get("ok"):
                return resultat.get("result")
            if reponse.status_code == 429 and essai < 2:
                time.sleep(int(resultat.get("parameters", {}).get("retry_after", 5)))
                continue
            description = resultat.get("description", f"HTTP {reponse.status_code}")
            if reponse.status_code in (401, 404):
                raise ErreurPodcast("Le jeton du bot Telegram est refusé : "
                                    "vérifie le secret TELEGRAM_BOT_TOKEN.")
            raise ErreurPodcast(f"Telegram : {description}")
        raise ErreurPodcast("Telegram : échec après plusieurs tentatives")

    def trouver_conversation(self) -> str:
        mises_a_jour = self.appeler("getUpdates", {"limit": 100, "timeout": 0}) or []
        for mise_a_jour in reversed(mises_a_jour):
            for cle in ("message", "edited_message", "my_chat_member"):
                chat = (mise_a_jour.get(cle) or {}).get("chat") or {}
                if chat.get("type") == "private" and chat.get("id"):
                    return str(chat["id"])
        try:                                   # nom du bot, pour être sûr d'écrire au bon
            nom = (self.appeler("getMe") or {}).get("username", "")
        except ErreurPodcast:
            nom = ""
        bot = f"@{nom}" if nom else "ton bot"
        raise ErreurPodcast(
            f"Je ne trouve pas ta conversation avec {bot}. Ouvre {bot} dans Telegram, appuie "
            "sur Démarrer (ou envoie-lui un message), puis relance le workflow dans les 24 h.")

    def mises_a_jour(self, depuis: int) -> list[dict]:
        """Messages reçus depuis la dernière lecture (Telegram les garde 24 h)."""
        donnees: dict[str, Any] = {"limit": 100, "timeout": 0,
                                   "allowed_updates": json.dumps(["message"])}
        if depuis:
            donnees["offset"] = depuis + 1
        try:
            return self.appeler("getUpdates", donnees) or []
        except ErreurPodcast as erreur:
            if "conflict" in str(erreur).lower():   # le bot instantané (webhook) s'en charge
                journal("Messages gérés par le bot instantané (Cloudflare).")
                return []
            raise

    def confirmer(self, dernier: int) -> None:
        """Marque les messages jusqu'à « dernier » comme lus côté Telegram."""
        try:
            self.appeler("getUpdates", {"offset": dernier + 1, "limit": 1, "timeout": 0,
                                        "allowed_updates": json.dumps(["message"])})
        except ErreurPodcast as erreur:
            journal(f"Confirmation Telegram impossible ({erreur}) : sans gravité.")

    def fichier(self, identifiant_fichier: str) -> bytes:
        infos = self.appeler("getFile", {"file_id": identifiant_fichier}) or {}
        chemin = infos.get("file_path")
        if not chemin:
            raise ErreurPodcast("Telegram : fichier introuvable.")
        try:
            reponse = requests.get(URL_FICHIER_TELEGRAM.format(jeton=self.jeton, chemin=chemin),
                                   timeout=60)
            reponse.raise_for_status()
        except requests.RequestException as erreur:
            raise ErreurPodcast(f"Telegram : téléchargement du vocal impossible "
                                f"({type(erreur).__name__})") from None
        return reponse.content

    def message(self, conversation: str, texte: str, clavier: list | None = None,
                apercu: bool = False) -> Any:
        donnees = {"chat_id": conversation, "text": texte, "parse_mode": "HTML",
                   "disable_web_page_preview": "false" if apercu else "true"}
        if clavier:
            donnees["reply_markup"] = json.dumps({"inline_keyboard": clavier}, ensure_ascii=False)
        return self.appeler("sendMessage", donnees)

    def audio(self, conversation: str, mp3: bytes, nom_fichier: str, titre: str,
              interpretes: str, legende_html: str, duree: int,
              vignette: bytes | None = None, clavier: list | None = None) -> Any:
        donnees = {"chat_id": conversation, "title": titre, "performer": interpretes,
                   "caption": legende_html, "parse_mode": "HTML", "duration": duree}
        fichiers = {"audio": (nom_fichier, mp3, "audio/mpeg")}
        if vignette:
            fichiers["thumbnail"] = ("pochette.jpg", vignette, "image/jpeg")
        if clavier:
            donnees["reply_markup"] = json.dumps({"inline_keyboard": clavier}, ensure_ascii=False)
        try:
            return self.appeler("sendAudio", donnees, fichiers, delai=180)
        except ErreurPodcast as erreur:
            if not vignette or "thumbnail" not in str(erreur).lower():
                raise
            fichiers.pop("thumbnail")          # vignette refusée : l'épisode passe sans
            return self.appeler("sendAudio", donnees, fichiers, delai=180)


def rubriques_pour_bot(script: dict, rubriques: list[tuple[str, str]] | None,
                       sources: list[tuple[str, str, str]]) -> dict[str, dict]:
    """Ce que chaque rubrique a dit dans l'épisode (texte) et les liens qu'elle a cités : le bot les garde
    pour le résumé de la rubrique dans l'application. {identifiant: {titre, texte, sources}}."""
    titres = dict(rubriques or [])
    morceaux: dict[str, list[str]] = {}
    for r in script["repliques"]:
        cle_rubrique = r.get("rubrique")
        if cle_rubrique in titres:
            morceaux.setdefault(cle_rubrique, []).append(f"{r['animateur']} : {r['texte']}")
    resultat = {}
    for cle_rubrique, lignes in morceaux.items():
        titre = titres[cle_rubrique]
        resultat[cle_rubrique] = {
            "titre": titre, "texte": "\n".join(lignes)[:4000],
            "sources": [{"titre": t, "url": u} for s, t, u in sources if s == titre][:10]}
    return resultat


def sources_episode(script: dict, articles: list[Article], collectes: dict | None) -> list[tuple[str, str, str]]:
    """Articles cités et liens des recherches, sans doublon : (section, titre, adresse)."""
    numeros = set(script["sources"])
    liens = [(a.section or "Actualités", a.titre, a.lien) for a in articles if a.numero in numeros and a.lien]
    for collecte in (collectes or {}).values():
        regle = collecte.regle or {}
        section = ((regle.get("rubrique") or {}).get("titre") or regle.get("titre") or "Rubrique")
        liens += [(section, titre, url) for titre, url in (collecte.liens or []) if url]
    vus: set[str] = set()
    return [(s, t, u) for s, t, u in liens if not (u in vus or vus.add(u))]


def legende(script: dict, maintenant: dt.datetime, evenements: list[Evenement],
            articles: list[Article], remarques: list[str], prochain: Evenement | None = None,
            deplacements: list[dict] | None = None, chapitres: list[tuple[float, str]] | None = None,
            collectes: dict | None = None, citer: bool = True) -> str:
    e = echapper
    aujourd_hui = maintenant.date()
    du_jour = [ev for ev in evenements if ev.debut.date() <= aujourd_hui]
    plus_tard = len(evenements) - len(du_jour)
    tete = [f"🎙️ <b>{e(script['titre'])}</b>", e(date_longue(aujourd_hui).capitalize()), ""]
    if du_jour:
        tete.append(f"📅 {len(du_jour)} événement{'s' if len(du_jour) > 1 else ''} aujourd'hui"
                    + (f", {plus_tard} les jours suivants" if plus_tard else ""))
    else:
        tete.append("📅 Rien à l'agenda aujourd'hui"
                    + (f", {plus_tard} événement(s) les jours suivants" if plus_tard else ""))
    if prochain is not None:
        tete.append(f"🔭 Prochain : {e(tronquer(prochain.titre, 60))}, {e(quand_court(prochain))}")
    for deplacement in deplacements or []:
        tete.append(f"🧳 {e(deplacement['lieu'])} : {e(deplacement['quand'])}")
    simples = []
    for identifiant_regle, collecte in (collectes or {}).items():
        regle = collecte.regle
        titre_regle = (regle.get("rubrique") or {}).get("titre") or regle.get("titre", "")
        details = []
        if collecte.meteo:
            details.append(e(Sources.meteo_en_mots(collecte.meteo).split(",")[0]
                             + (f", {round(collecte.meteo['max'])} °C" if collecte.meteo.get("max") is not None else "")))
        if collecte.itineraire:
            details.append(f'<a href="{html.escape(collecte.itineraire, quote=True)}">itinéraire</a>')
        if details:
            tete.append(f"📌 {e(titre_regle)} — {', '.join(details)}")
        else:
            simples.append(e(titre_regle))
    if simples:
        tete.append(f"📌 {' · '.join(simples)}")
    if chapitres and len(chapitres) > 1:
        # Un chapitre par ligne : Telegram ne rend cliquable que les horodatages en début de ligne.
        tete += ["", "⏱ <b>Chapitres</b>"] + [f"{minute_seconde(t)} {e(titre)}" for t, titre in chapitres]
    if remarques:
        tete.append("⚠️ " + e("; ".join(remarques)))
    liens = [(t, u) for _, t, u in sources_episode(script, articles, collectes)] if citer else []
    sources = []
    vus_liens: set[str] = set()
    for titre, url in liens:
        if url in vus_liens:
            continue
        vus_liens.add(url)
        site = re.sub(r"^www\.", "", urlparse(url).netloc) or "lien"
        sources.append(f'<a href="{html.escape(url, quote=True)}">{e(site)}</a> {e(tronquer(titre, 40))}')
    sources = ["", "🔗 <b>Sources</b>"] + [f"{i}. {x}" for i, x in enumerate(sources, 1)] if sources else []
    pied = ["", "💬 Écris-moi ou utilise les boutons pour ajuster le podcast."]
    while len("\n".join(tete + sources + pied)) > 1024 and len(sources) > 2:
        sources.pop()
    if len(sources) <= 2:
        sources = []
    return "\n".join(tete + sources + pied)[:1024]


# ───────────────────────────────── principal ────────────────────────────────

def separer_urls(valeur: str) -> list[str]:
    return [u for u in re.split(r"[\s,;]+", valeur or "") if u.startswith(("http", "webcal"))]


def lien_execution() -> str:
    serveur, depot, numero = (os.environ.get(v, "") for v in
                              ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"))
    return f"{serveur}/{depot}/actions/runs/{numero}" if serveur and depot and numero else ""


@dataclass
class Contenu:
    agenda: str
    sections: list[tuple[str, str]]
    proches: list[Evenement]            # événements des jours_agenda prochains jours
    prochain: Evenement | None          # prochain événement, si l'agenda proche est vide
    articles: list[Article]
    remarques: list[str]
    deplacements: list[dict]
    collectes: dict = None              # règles appliquées : identifiant → moteur.Collecte
    rubriques: list = None              # déroulé du jour : [(clé, titre)]
    titres_regles: list = None          # titres des actus données aux rubriques personnalisées (mémoire)


JOURS_MEMOIRE_ARTICLES = 7


def articles_deja_traites(memoire: dict, maintenant: dt.datetime) -> set[str]:
    """Titres (normalisés) des articles déjà racontés ces derniers jours, hors aujourd'hui."""
    limite = (maintenant.date() - dt.timedelta(days=JOURS_MEMOIRE_ARTICLES)).isoformat()
    aujourd_hui = maintenant.date().isoformat()
    return {k for k, jour in (memoire.get("articles_vus") or {}).items()
            if isinstance(jour, str) and limite <= jour < aujourd_hui}


def retenir_articles(memoire: dict, articles: list, citees: set[int], maintenant: dt.datetime,
                     autres: list[str] | None = None) -> None:
    """Note les articles cités (à défaut, les premiers de la liste), et les actus des
    rubriques personnalisées (« autres », titres), pour ne pas les répéter demain."""
    jour = maintenant.date().isoformat()
    limite = (maintenant.date() - dt.timedelta(days=JOURS_MEMOIRE_ARTICLES + 3)).isoformat()
    vus = {k: j for k, j in (memoire.get("articles_vus") or {}).items() if isinstance(j, str) and j >= limite}
    choisis = [a for a in articles if a.numero in citees]
    if len(choisis) < 6:
        choisis += [a for a in articles if a not in choisis][: 8 - len(choisis)]
    for k in [cle_titre(a.titre) for a in choisis] + [cle_titre(t) for t in autres or []]:
        if k:
            vus[k] = jour
    memoire["articles_vus"] = dict(sorted(vus.items(), key=lambda x: x[1])[-400:])


JOURS_MEMOIRE_LIEUX = 30


def lieu_deja_presente(memoire: dict, deplacement: dict, maintenant: dt.datetime) -> dict | None:
    """Ce qui a déjà été dit d'un lieu de déplacement ces dernières semaines (avant aujourd'hui)."""
    aujourd_hui = maintenant.date().isoformat()
    for entree in memoire.get("lieux_presentes") or []:
        if not isinstance(entree, dict):
            continue
        dates = [d for d in entree.get("dates") or [] if isinstance(d, str) and d < aujourd_hui]
        if dates and (meme_lieu(entree.get("lieu", ""), deplacement["lieu"])
                      or (entree.get("evenement") and cle_titre(entree["evenement"]) == cle_titre(deplacement.get("evenement", "")))):
            return {**entree, "dates": dates}
    return None


def retenir_lieux(memoire: dict, deplacements: list[dict], idees: list[str], maintenant: dt.datetime) -> None:
    """Note les lieux présentés aujourd'hui et les idées proposées, pour la suite du compte à rebours."""
    jour = maintenant.date()
    limite = (jour - dt.timedelta(days=JOURS_MEMOIRE_LIEUX)).isoformat()
    lieux = [e for e in memoire.get("lieux_presentes") or []
             if isinstance(e, dict) and max(e.get("dates") or [""]) >= limite]
    idees = nettoyer_liste(idees, 8, 80)
    for deplacement in deplacements:
        entree = next((e for e in lieux if meme_lieu(e.get("lieu", ""), deplacement["lieu"])
                       or (e.get("evenement") and cle_titre(e["evenement"]) == cle_titre(deplacement.get("evenement", "")))), None)
        if entree is None:
            entree = {"lieu": deplacement["lieu"], "evenement": deplacement.get("evenement", ""), "dates": [], "idees": []}
            lieux.append(entree)
        entree["dates"] = sorted(set(entree.get("dates") or []) | {jour.isoformat()})[-15:]
        entree["idees"] = nettoyer_liste((entree.get("idees") or []) + idees, 100, 80)[-20:]
    memoire["lieux_presentes"] = lieux[-10:]


def deja_presente_en_mots(deja: dict, maintenant: dt.datetime) -> str:
    derniere = dt.date.fromisoformat(max(deja["dates"]))
    ecart = (maintenant.date() - derniere).days
    quand = "hier" if ecart == 1 else f"il y a {ecart} jours"
    fois = len(deja["dates"])
    texte = f"  Déjà présenté dans {fois} épisode{'s' if fois > 1 else ''} (dernière fois {quand})."
    if deja.get("idees"):
        texte += " Idées déjà proposées : " + " ; ".join(deja["idees"]) + "."
    return texte + (" Fais court : un rappel de la date, puis une seule idée nouvelle (absente de cette liste) "
                    "et seulement les actus nouvelles ci-dessous.")


def resumer_episode_precedent(memoire: dict, maintenant: dt.datetime) -> str:
    episode = memoire.get("dernier_episode") or {}
    try:
        jour = dt.date.fromisoformat(str(episode.get("date", "")))
    except ValueError:
        return ""
    ecart = (maintenant.date() - jour).days
    if not 1 <= ecart <= 3:
        return ""
    quand = "hier" if ecart == 1 else f"il y a {ecart} jours"
    lignes = [f"Épisode d'{quand} : « {episode.get('titre', '')} »."]
    if episode.get("sujets"):
        lignes.append("Sujets abordés : " + "; ".join(map(str, episode["sujets"])) + ".")
    if episode.get("deplacements"):
        lignes.append("Lieux déjà présentés : " + ", ".join(map(str, episode["deplacements"])) + ".")
    return "\n".join(lignes)


def heure_lisible(heure: str) -> str:
    """« 06:45 » → « 6 h 45 »."""
    try:
        heures, minutes = (int(x) for x in heure.replace("h", ":").split(":")[:2])
    except ValueError:
        return heure
    return heure_parlee(dt.datetime(2000, 1, 1, heures % 24, minutes % 60))


def raison_lisible(message: str) -> str:
    """Version courte d'une erreur, pour un message sur le téléphone."""
    if "Aucun modèle Gemini" in message:
        parties = message.split(" | ")
        if all("quota gratuit du jour" in partie for partie in parties):
            return "Le quota gratuit du jour de Gemini est atteint."
        return "Les serveurs de Gemini ne répondent pas pour le moment."
    return tronquer(message, 300)


def preparer_regles(effectifs: dict, cle: str, maintenant: dt.datetime, evenements: list[Evenement],
                    forcees: list[str] | None = None, vus: set[str] | None = None,
                    titres_actus: list[str] | None = None) -> dict:
    """Rubriques du jour : sélection, vérification des conditions d'agenda et
    préparation des recherches (un appel au modèle léger), puis collecte.
    Les actus des rubriques évitent celles déjà racontées (« vus ») ; leurs titres
    sont ajoutés à « titres_actus » pour la mémoire."""
    vus = set() if vus is None else vus
    titres_actus = [] if titres_actus is None else titres_actus
    config = effectifs.get("config_bot")
    if not config:
        return {}
    jour = maintenant.date()
    programmees, conditionnelles = moteur.selectionner(config, jour, forcees)
    # Rubrique suspendue dans le déroulé : la règle se repose aussi (sauf demande expresse).
    suspendues = {r.get("cle") for r in effectifs.get("deroule") or [] if not r.get("actif", True)}
    candidates = [r for r in programmees + conditionnelles
                  if r.get("_forcee") or not (r.get("rubrique") and r["id"] in suspendues)]
    if not candidates:
        return {}
    limite = debut_du_jour(maintenant) + dt.timedelta(days=31)
    agenda = moteur.agenda_pour_plan([e for e in evenements if e.debut < limite], quand_court)

    def demander(systeme: str, entree: str, schema: dict) -> dict:
        return demander_json(systeme, entree, schema, effectifs["modeles_rapides"], cle, delai=90, tours=1)[0]

    plans = moteur.planifier(candidates, agenda, jour, effectifs["ville_habituelle"], demander)
    sources = Sources(os.environ.get("TAVILY_API_KEY", ""))

    def actus(requete: str) -> list[str]:
        trouves = garder_nouveaux(chercher_actus(requete, effectifs, maintenant, lus_pour(4), 7), vus, 4)
        titres_actus.extend(a.titre for a in trouves)
        return [f"{a.source} — {a.titre}" + (f" : {a.resume}" if a.resume else "") for a in trouves]

    def flux_specialise(flux: dict) -> list[str]:
        """Un flux spécialisé (Réglages › Sources) coché dans la fiche : ses articles récents."""
        return [f"{a.titre}" + (f" : {a.resume}" if a.resume else "") + (f" ({a.lien})" if a.lien else "")
                for a in lire_flux_specialise(flux, maintenant, vus, titres_actus)]

    collectes = {}
    for regle in candidates:
        plan = plans.get(regle["id"]) or {}
        if not plan.get("applique"):
            journal(f"Rubrique {regle['id']} : condition non remplie aujourd'hui.")
            continue
        try:
            collectes[regle["id"]] = moteur.collecter(regle, plan, sources, jour, effectifs["ville_habituelle"], actus,
                                                      config=config, lire_flux=flux_specialise, agenda=agenda)
            journal(f"Rubrique {regle['id']} appliquée ({regle.get('titre', '')}).")
        except Exception as erreur:          # une règle en panne ne bloque pas l'épisode
            journal(f"Rubrique {regle['id']} : collecte impossible ({type(erreur).__name__} : {erreur}).")
    if sources.credits_tavily:
        journal(f"Recherche web : {sources.credits_tavily} crédit(s) Tavily.")
    return collectes


def preparer_contenu(effectifs: dict, cle: str, maintenant: dt.datetime, urls: list[str],
                     memoire: dict, forcees: list[str] | None = None) -> Contenu:
    """Rassemble l'agenda, les actus, les déplacements, les sujets à creuser et les rubriques."""
    remarques: list[str] = []
    horizon = max(effectifs["jours_agenda"], effectifs["horizon_prochain_evenement_jours"],
                  effectifs["jours_deplacements"])
    tous: list[Evenement] = []
    if urls:
        tous, problemes = lire_agendas(urls, effectifs, maintenant, horizon)
        remarques += problemes
    else:
        journal("Aucun agenda configuré (ajoute-en un dans l'application, fiche Agenda).")
    fin_fenetre = debut_du_jour(maintenant) + dt.timedelta(days=effectifs["jours_agenda"])
    proches = [e for e in tous if e.debut < fin_fenetre]
    prochain = tous[0] if tous and not proches else None
    agenda = (resumer_agenda(proches, maintenant, prochain,
                             effectifs["horizon_prochain_evenement_jours"])
              if urls else "Agenda non configuré.")

    vus: set[str] = set()
    approfondissements = []
    if rubrique_active(effectifs, "approfondissements"):
        for demande in effectifs["a_approfondir"]:
            trouves = garder_nouveaux(chercher_actus(demande["sujet"], effectifs, maintenant, lus_pour(4), 14), vus, 4)
            approfondissements.append((demande, trouves))
    deja_racontes = articles_deja_traites(memoire, maintenant)
    journal(f"Mémoire : {len(deja_racontes)} actu(s) déjà racontée(s) ces {JOURS_MEMOIRE_ARTICLES} derniers jours, écartée(s).")
    vus |= deja_racontes                                  # pas deux fois la même actu sur plusieurs jours
    deplacements = (reperer_deplacements(tous, effectifs, cle, maintenant, prochain)
                    if tous and rubrique_active(effectifs, "deplacements") else [])
    for deplacement in deplacements:
        deplacement["articles"] = garder_nouveaux(
            chercher_actus(deplacement["recherche"] or deplacement["lieu"], effectifs,
                           maintenant, lus_pour(4), 7), vus, 4)
        deplacement["deja"] = lieu_deja_presente(memoire, deplacement, maintenant)
    titres_regles: list[str] = []
    collectes = preparer_regles(effectifs, cle, maintenant, tous, forcees, vus, titres_regles)
    locales: list[Article] = []
    locales_deja_dites = False
    if effectifs["ville_habituelle"] and rubrique_active(effectifs, "actu_locale"):
        voulues = int(effectifs.get("locale_articles", 3))
        lues = chercher_actus(effectifs["ville_habituelle"], effectifs, maintenant, lus_pour(voulues), 7)
        locales = garder_nouveaux(lues, vus, voulues)
        locales_deja_dites = bool(lues) and not locales
        for article in locales:
            article.etiquette = f"actu locale : {effectifs['ville_habituelle']}"
    avec_actus = rubrique_active(effectifs, "actualites")
    ciblees = []
    recherches = [(sujet, f"centre d'intérêt : {sujet}") for sujet in effectifs["sujets_preferes"][:3]]
    generales, flux_en_panne = [], []
    if avec_actus:
        for requete, etiquette in recherches:
            for article in chercher_actus(requete, effectifs, maintenant, 3, 2):
                article.etiquette = etiquette
                ciblees.append(article)
        generales, flux_en_panne = lire_actualites(effectifs, maintenant)
    actualites = garder_nouveaux(ciblees, vus) + garder_nouveaux(generales, vus)
    actualites = actualites[:40]
    if avec_actus and flux_en_panne and not generales:
        remarques.append("actualités inaccessibles ce matin")

    numero = 1
    tous_articles: list[Article] = []
    groupes = ([("À creuser", a) for _, a in approfondissements]
               + [(f"Déplacements · {d['lieu']}", d["articles"]) for d in deplacements]
               + [("Actu locale", locales), ("Actualités", actualites)])
    for section, groupe in groupes:
        for article in groupe:
            article.section = section
            article.numero = numero
            numero += 1
            tous_articles.append(article)

    sections: list[tuple[str, str]] = []
    if approfondissements:
        lignes = []
        for demande, trouves in approfondissements:
            lignes.append(f"- « {demande['sujet']} » (demandé le {demande.get('demande_le', '?')})")
            lignes += [f"  {ligne_article(a, maintenant)}" for a in trouves] or [
                "  (aucun article récent trouvé : contexte général seulement, sans inventer de faits récents)"]
        sections.append(("À APPROFONDIR (demandé par l'auditeur)", "\n".join(lignes)))
    if deplacements:
        lignes = []
        for d in deplacements:
            pays = f" ({d['pays']})" if d["pays"] else ""
            lignes.append(f"- {d['lieu']}{pays} — {d['nature']}, {d['quand']} "
                          f"(événement : « {d['evenement']} »)")
            if d.get("deja"):
                lignes.append(deja_presente_en_mots(d["deja"], maintenant))
            lignes += [f"  {ligne_article(a, maintenant)}" for a in d["articles"]] or [
                "  (pas d'actualité nouvelle sur ce lieu)"]
        sections.append(("DÉPLACEMENTS", "\n".join(lignes)))
    if locales:
        sections.append((f"ACTU LOCALE ({effectifs['ville_habituelle']})",
                         "\n".join(ligne_article(a, maintenant) for a in locales)))
    elif locales_deja_dites:
        sections.append((f"ACTU LOCALE ({effectifs['ville_habituelle']})",
                         "Rien de nouveau : les nouvelles trouvées ont déjà été racontées dans les épisodes précédents. "
                         "Dis-le en une phrase, sans les répéter."))
    for identifiant_regle, collecte in collectes.items():
        sections.append((f"RUBRIQUE {identifiant_regle}", collecte.texte))
    if avec_actus:
        sections.append(("ACTUALITÉS DE CE MATIN (titres et résumés des flux)",
                         resumer_actualites(actualites, maintenant)))
    sections.append(("ÉPISODE PRÉCÉDENT", resumer_episode_precedent(memoire, maintenant)))
    if not tous_articles and not tous and not urls and not collectes:
        raise ErreurPodcast("Ni agenda ni actualités : rien à raconter ce matin.")
    actifs = {"deplacements": bool(deplacements), "approfondissements": bool(approfondissements),
              "actu_locale": bool(locales) or locales_deja_dites, "actualites": avec_actus}
    rubriques = moteur.deroule_du_jour({"deroule": effectifs.get("deroule")}, collectes, actifs)
    return Contenu(agenda, sections, proches, prochain, tous_articles, remarques, deplacements,
                   collectes, rubriques, titres_regles)


def identifiants_regles(texte: str) -> list[str]:
    return [x.upper() for x in re.split(r"[,;\s]+", texte or "") if re.fullmatch(r"[Rr]\d{1,4}", x)]


# Rubriques essentielles qu'on peut chercher à la demande (menu « ··· » de leur fiche).
RUBRIQUES_ESSENTIELLES = ("agenda", "deplacements", "actu_locale", "approfondissements", "actualites")


def identifiants_recherche(texte: str) -> list[str]:
    """Les règles (R5) ou les rubriques essentielles (actualites) d'une recherche."""
    trouves = []
    for x in re.split(r"[,;\s]+", texte or ""):
        if re.fullmatch(r"[Rr]\d{1,4}", x):
            trouves.append(x.upper())
        elif x.lower() in RUBRIQUES_ESSENTIELLES:
            trouves.append(x.lower())
    return trouves


def heure_plus(heure: str, minutes: int) -> str:
    try:
        h, m = (int(x) for x in heure.split(":")[:2])
    except (ValueError, AttributeError):
        return ""
    total = (h * 60 + m + minutes) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def main(arguments: list[str] | None = None) -> int:
    analyseur = argparse.ArgumentParser(description="Génère et envoie le podcast du matin.")
    analyseur.add_argument("--sans-envoi", action="store_true",
                           help="n'envoie rien sur Telegram ; écrit le MP3 dans sortie/")
    analyseur.add_argument("--retours", action="store_true",
                           help="lit seulement tes messages Telegram et y répond (sans le bot instantané)")
    analyseur.add_argument("--mode", default=os.environ.get("MODE", ""),
                           help="planifie, rattrapage, manuel ou filet (lancement par le bot ou par GitHub)")
    analyseur.add_argument("--regles", default=os.environ.get("REGLES", ""),
                           help="règles à traiter aussi dans l'épisode, ex. R3,R5")
    analyseur.add_argument("--recherche", default=os.environ.get("RECHERCHE", ""),
                           help="résultats de recherche pour ces règles, ex. R5,R6")
    analyseur.add_argument("--format", default=os.environ.get("FORMAT", "") or "ecrit", choices=("ecrit", "audio", "resume", "point"),
                           help="résultats écrits (photos, lieux, sondage), mini-podcast d'idées, synthèse d'une rubrique, "
                                "ou point (podcast d'état des lieux d'un sujet)")
    analyseur.add_argument("--echantillons", default=os.environ.get("ECHANTILLONS", ""),
                           help="extraits audio de ces voix, ex. Aoede,Kore")
    analyseur.add_argument("--agendas", action="store_true",
                           help="lit seulement les noms de tes agendas et les envoie au bot (liste à cocher)")
    options = analyseur.parse_args(arguments)
    mode = options.mode.strip().lower()
    if not mode and os.environ.get("RATTRAPAGE", "").strip().lower() == "true":
        mode = "rattrapage"
    forcees = identifiants_regles(options.regles)

    # Fin au plus tard, avant le délai du workflow (25 min ; 10 pour les messages).
    global ECHEANCE
    ECHEANCE = time.monotonic() + (8 if options.retours else 22) * 60
    chemin_memoire = RACINE / FICHIER_MEMOIRE
    nouvel_episode = False
    telegram: Telegram | None = None
    conversation = ""
    config_bot: dict | None = None
    export: dict | None = None
    try:
        reglages = charger_reglages(RACINE / "reglages.toml")
        # Le bot d'abord : il peut fournir les clés et agendas saisis dans l'application.
        jeton = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        bot = Bot(os.environ.get("BOT_URL", ""), jeton)
        export = bot.config() if bot.secret else None
        presents = secrets_presents()
        appliquees = appliquer_cles(export)
        if appliquees:
            journal("Depuis l'application : " + ", ".join(appliquees) + ".")
        reglages.update(decouvrir_modeles(reglages, os.environ.get("GEMINI_API_KEY", "").strip()))
        memoire = charger_memoire(chemin_memoire)
        charger_preferences(RACINE / FICHIER_PREFERENCES, memoire)
        maintenant = heure_actuelle(ZoneInfo(reglages["fuseau_horaire"]))
        debut = maintenant.strftime("%Y-%m-%dT%H:%M")
        aujourd_hui = maintenant.date().isoformat()
        cle = os.environ.get("GEMINI_API_KEY", "").strip()
        if not cle:
            raise ErreurPodcast("La clé Gemini manque : ajoute-la dans l'application (Réglages › Connexions) "
                                "ou en secret GEMINI_API_KEY sur GitHub.")
        if (options.retours or not options.sans_envoi) and not jeton:
            # Sans Telegram (facultatif) : tout passe par le bot (application, flux, notifications).
            if options.retours:
                journal("Pas de Telegram : aucun message à lire.")
                return 0
            if not bot.secret:
                raise ErreurPodcast("Ni Telegram (secret TELEGRAM_BOT_TOKEN) ni jeton GitHub du bot (secret BOT_GITHUB_TOKEN) : "
                                    "personne à qui confier l'épisode.")
        elif options.retours or not options.sans_envoi:
            telegram = Telegram(jeton)
            conversation = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
            if not conversation:
                if options.retours:
                    journal("TELEGRAM_CHAT_ID n'est pas encore défini : rien à lire.")
                    return 0
                conversation = telegram.trouver_conversation()
                journal(f"Conversation Telegram trouvée : {conversation}")
                telegram.message(conversation, (
                    "👋 Ton bot est bien relié !\n\nTon identifiant de conversation est "
                    f"<code>{conversation}</code>.\nAjoute-le dans GitHub (Settings → Secrets "
                    "and variables → Actions) sous le nom <b>TELEGRAM_CHAT_ID</b> pour que "
                    "l'envoi fonctionne tous les jours. Le podcast arrive dans un instant…"))

        # Réglages tenus par le bot ; à défaut, sa sauvegarde quotidienne.
        if export:
            journal(f"Réglages lus auprès du bot (version {export.get('version', '?')}).")
            bot.evenement({"type": "secrets", "presents": presents})   # pour l'écran Connexions
        else:
            export = config_de_secours(RACINE / FICHIER_PREFERENCES)
            if export:
                journal("Bot injoignable : réglages de sa sauvegarde quotidienne (preferences.json).")
        config_bot = (export or {}).get("config")
        if config_bot and config_bot.get("pays") in pays_auditeur.PROFILS:
            # Le pays choisi dans l'application : fuseau, actualités, jours fériés, devise.
            # (Un bot d'avant ce réglage n'envoie pas de pays : reglages.toml garde la main.)
            pays_auditeur.definir_depuis_config(config_bot)
            profil = pays_auditeur.profil()
            reglages.update({"fuseau_horaire": profil["fuseau"], "pays_actus": profil["actus_pays"],
                             "langue_actus": profil["actus_langue"], "flux": profil["flux"]})
            maintenant = heure_actuelle(ZoneInfo(reglages["fuseau_horaire"]))
            aujourd_hui = maintenant.date().isoformat()
        if export and not export.get("secours") and reglages.get("modeles_rapides"):
            bot.evenement({"type": "modeles", "rapides": reglages["modeles_rapides"]})   # le bot suit la liste à jour

        if options.agendas:
            urls = separer_urls(os.environ.get("CALENDAR_ICS_URL", ""))
            lire_agendas(urls, {**reglages, "agendas_exclus": []}, maintenant, 30)
            journal("Agendas : " + (", ".join(f"{a['nom']} ({a['nb']})" for a in AGENDAS_VUS) or "aucun"))
            if AGENDAS_VUS and bot.secret:
                bot.evenement({"type": "agendas", "liste": AGENDAS_VUS, "evenements": AGENDA_APERCU})
            return 0
        if options.echantillons or options.recherche:
            import recherche          # modes du bot : extraits de voix, résultats de recherche
            effectifs = (effectifs_depuis_bot(reglages, memoire, config_bot) if config_bot
                         else reglages_effectifs(reglages, memoire))
            if options.echantillons:
                return recherche.echantillons(options.echantillons, effectifs, cle, telegram, conversation, bot,
                                              options.sans_envoi, discret=bool((export or {}).get("app")))
            if options.format == "resume":
                return recherche.resume_rubrique(options.recherche.strip(), effectifs, cle, maintenant, telegram,
                                                 conversation, bot)
            return recherche.lancer(identifiants_recherche(options.recherche), options.format, effectifs, cle,
                                    maintenant, telegram, conversation, bot, export or {}, options.sans_envoi)

        # 1. (Sans le bot instantané) tes messages au bot, pris en compte avant l'épisode.
        if telegram and conversation and (not export or export.get("secours")):
            try:
                if traiter_retours(telegram, conversation, cle, reglages, memoire, maintenant):
                    nouvel_episode = bool(memoire.pop("_nouvel_episode", False))
                    sauver_memoire(chemin_memoire, memoire)
            except Exception as erreur:   # ils seront relus à la prochaine exécution
                journal(f"Messages Telegram non traités pour l'instant : {erreur}")
            memoire.pop("_nouvel_episode", None)
        if options.retours:
            if not nouvel_episode:
                return 0
            journal("Nouvel épisode demandé par message : on le prépare.")
            ECHEANCE = time.monotonic() + 22 * 60
            mode = "manuel"

        # Épisode programmé déjà parti (rattrapage, filet, double lancement) : rien à faire.
        deja_parti = (memoire.get("dernier_programme") == aujourd_hui
                      or (mode in ("rattrapage", "filet")
                          and (memoire.get("dernier_episode") or {}).get("date") == aujourd_hui)
                      or bool((export or {}).get("episode_envoye_aujourdhui")))
        if mode in ("planifie", "rattrapage", "filet") and deja_parti:
            journal("L'épisode du jour est déjà parti : rien à faire.")
            return 0
        if mode in ("rattrapage", "filet"):
            journal("L'épisode de ce matin n'est pas parti : nouvel essai "
                    + ("(rattrapage)." if mode == "rattrapage" else "(filet de sécurité de GitHub)."))

        # 2. L'épisode.
        effectifs = (effectifs_depuis_bot(reglages, memoire, config_bot) if config_bot
                     else reglages_effectifs(reglages, memoire))
        urls = separer_urls(os.environ.get("CALENDAR_ICS_URL", ""))
        contenu = preparer_contenu(effectifs, cle, maintenant, urls, memoire, forcees)
        if AGENDAS_VUS and export and not export.get("secours") and not options.sans_envoi:
            bot.evenement({"type": "agendas", "liste": AGENDAS_VUS, "evenements": AGENDA_APERCU})  # liste à cocher, aperçu
        script = ecrire_script(effectifs, cle, maintenant, contenu.agenda, contenu.sections,
                               contenu.remarques, contenu.rubriques, contenu.collectes)
        minutage: list[float] = []
        pcm, taux = synthetiser(script, effectifs, cle, minutage)
        chapitres = calculer_chapitres(script, minutage, contenu.rubriques)
        mp3 = encoder_mp3(pcm, taux, effectifs["debit_mp3_kbps"])
        duree = round(len(pcm) / (2 * taux))
        journal(f"MP3 prêt : {duree // 60} min {duree % 60:02d} s, {len(mp3) / 1e6:.1f} Mo "
                f"(vitesse {effectifs['vitesse_parole']}).")

        nom_fichier = f"podcast-{aujourd_hui}.mp3"
        texte_script = "\n\n".join(f"{r['animateur']} : {r['texte']}" for r in script["repliques"])
        vignette = creer_pochette(maintenant.date(), script["titre"])
        if options.sans_envoi:
            dossier = RACINE / "sortie"
            dossier.mkdir(exist_ok=True)
            (dossier / nom_fichier).write_bytes(mp3)
            chapitres_texte = "\n".join(f"{minute_seconde(t)} {titre}" for t, titre in chapitres)
            (dossier / nom_fichier.replace(".mp3", ".txt")).write_text(
                f"{script['titre']}\n\n{chapitres_texte}\n\n{texte_script}\n", encoding="utf-8")
            if vignette:
                (dossier / nom_fichier.replace(".mp3", ".jpg")).write_bytes(vignette)
            journal(f"Écrit dans {dossier}/ (aucun envoi, mémoire inchangée).")
            return 0

        # Le bot garde le fichier (un an) : l'application et le flux privé le lisent chez lui.
        base_bot = f"{maintenant:%Y-%m}/{maintenant:%Y-%m-%d-%H%M%S}"
        audio_bot = f"{base_bot}.mp3" if bot.deposer(f"{base_bot}.mp3", mp3, "audio/mpeg") else None
        pochette_bot = f"{base_bot}.jpg" if audio_bot and vignette and bot.deposer(f"{base_bot}.jpg", vignette, "image/jpeg") else None
        if audio_bot:
            journal("Audio gardé par le bot ✅")
        elif export:
            journal("::warning::Le bot n'a pas pu garder l'audio : l'épisode n'est que chez Telegram.")

        details = [rid for rid, c in (contenu.collectes or {}).items() if moteur.est_recherche(c.regle)]
        avec_actus = any(c == "actualites" for c, _ in contenu.rubriques or [])
        nombre_sujets = min(len(script["sujets"]), int(effectifs["nombre_sujets"])) if avec_actus else 0
        noms = " & ".join(a["nom"] for a in effectifs["animateurs"])
        titre = f"{script['titre']} – {date_longue(maintenant.date(), False)}"
        # Telegram coupé dans l'application (Réglages › Application) : l'épisode n'arrive que chez
        # le bot (application, flux, notification). S'il n'a pas pu le garder, Telegram quand même.
        par_telegram = telegram is not None and (
            (((config_bot or {}).get("livraison") or {}).get("telegram", True) is not False) or not audio_bot)
        if not par_telegram and not audio_bot:
            raise ErreurPodcast("Le bot n'a pas pu garder l'épisode, et Telegram n'est pas configuré : rien n'est parti.")
        envoi = None if not par_telegram else telegram.audio(
            conversation, mp3, nom_fichier, tronquer(titre, 64), noms,
            legende(script, maintenant, contenu.proches, contenu.articles, contenu.remarques,
                    contenu.prochain, contenu.deplacements, chapitres, contenu.collectes,
                    citer=effectifs.get("citer_sources", "ecrit") in ("ecrit", "les_deux")),
            duree, vignette,
            # Boutons seulement avec le bot de la version 3 (l'ancien ne les comprendrait pas) ;
            # avec l'application, un seul bouton qui l'ouvre sur cet épisode.
            clavier_application(export.get("app"), aujourd_hui) if export and export.get("app")
            else clavier_episode(aujourd_hui, nombre_sujets, details) if export else None)
        journal("Envoyé sur Telegram ✅" if par_telegram else "Épisode gardé par le bot seulement (Telegram coupé ou absent).")
        evenement = {
            "type": "episode", "date": aujourd_hui, "titre": script["titre"],
            "sujets": script["sujets"][:nombre_sujets] if nombre_sujets else [],
            "message_id": (envoi or {}).get("message_id"), "transcription": texte_script[:20000],
            "chapitres": [[round(t), t_titre] for t, t_titre in chapitres],
            "regles": list(contenu.collectes or {}), "nombre_sujets": nombre_sujets,
            "mode": mode or "planifie", "debut": debut, "details": details, "duree": duree,
            "file_id": ((envoi or {}).get("audio") or {}).get("file_id"),
            "taille": ((envoi or {}).get("audio") or {}).get("file_size") or len(mp3),
            "heure": maintenant.strftime("%H:%M"),
            "sources": [{"section": s, "titre": t, "url": u}
                        for s, t, u in sources_episode(script, contenu.articles, contenu.collectes)][:30],
            "pochette_id": (((envoi or {}).get("audio") or {}).get("thumbnail") or {}).get("file_id"),
            "audio": audio_bot, "pochette": pochette_bot,
            "rubriques": rubriques_pour_bot(script, contenu.rubriques, sources_episode(
                script, contenu.articles, contenu.collectes)),
            "ref": int(maintenant.strftime("%H%M%S")),   # distingue les épisodes du jour, avec ou sans Telegram
        }
        if bot.evenement(evenement):
            journal("Bot prévenu : boutons et tableau de bord à jour.")

        # 3. Mémoire : sujets du jour (pour comprendre tes retours) ; demandes traitées.
        memoire["dernier_episode"] = {
            "date": aujourd_hui, "titre": script["titre"],
            "envoye_le": maintenant.strftime("%Y-%m-%dT%H:%M"),
            "sujets": script["sujets"],
            "deplacements": [d["lieu"] for d in contenu.deplacements],
            "regles": list(contenu.collectes or {}),
        }
        retenir_articles(memoire, contenu.articles, set(script["sources"]), maintenant, contenu.titres_regles)
        if contenu.deplacements:
            retenir_lieux(memoire, contenu.deplacements, script.get("idees") or [], maintenant)
        if mode != "manuel":
            memoire["dernier_programme"] = aujourd_hui
        memoire["a_approfondir"] = []
        # Débit réel de la voix, pour viser juste la prochaine fois (moyenne glissante).
        mots_dits = sum(len(re.sub(r"<[^>]*>|\|[^|]*\|", " ", r["texte"]).split())
                        for r in script["repliques"])
        if duree >= 30 and mots_dits >= 50:
            mesure = mots_dits / (duree / 60)
            debits = memoire.setdefault("debit_mots_minute", {})
            ancien = debits.get(effectifs["vitesse_parole"])
            nouveau = mesure if not isinstance(ancien, (int, float)) else (ancien + mesure) / 2
            debits[effectifs["vitesse_parole"]] = round(max(100, min(300, nouveau)))
            journal(f"Débit mesuré : {mesure:.0f} mots/min (vitesse {effectifs['vitesse_parole']}).")
        if script_mots_vises[0] >= 100 and mots_dits >= 50:
            # Régulation : on a demandé vise / remplissage mots et obtenu mots_dits ; si l'on est en deçà de
            # vise, le remplissage baisse (donc on demande plus la prochaine fois), au-delà il remonte vers 1.
            demandes = script_mots_vises[0]
            taux = max(REMPLISSAGE_MIN, min(1.0, effectifs.get("remplissage", 1.0) * mots_dits / demandes))
            ancien_taux = memoire.get("remplissage")
            memoire["remplissage"] = round(taux if not isinstance(ancien_taux, (int, float)) else (ancien_taux + taux) / 2, 3)
            journal(f"Remplissage : {mots_dits} mots écrits pour {demandes:.0f} visés (réglage {taux:.0%}).")
        sauver_memoire(chemin_memoire, memoire)
        return 0

    except Exception as erreur:
        message = str(erreur) if isinstance(erreur, ErreurPodcast) else \
            f"erreur inattendue ({type(erreur).__name__} : {erreur})"
        journal(f"ÉCHEC : {message}")
        # Envoi programmé raté alors qu'un rattrapage est prévu : on prévient sans alarmer.
        essai_suivant = os.environ.get("ESSAI_SUIVANT", "").strip() if not mode else ""
        if mode == "planifie" and config_bot and (config_bot.get("planning") or {}).get("rattrapage", True):
            delai = int(_borne((config_bot.get("planning") or {}).get("delai_rattrapage"), 20, 180, 60))
            essai_suivant = heure_plus(str((export or {}).get("heure_prevue_aujourdhui") or ""), delai)
        if options.retours or options.sans_envoi or options.recherche or options.echantillons or options.agendas:
            essai_suivant = ""
        # Le bot prévient aussi par notification (application), hors des modes annexes.
        if not (options.retours or options.sans_envoi or options.recherche or options.echantillons or options.agendas):
            try:
                Bot(os.environ.get("BOT_URL", "")).evenement({
                    "type": "echec",
                    "titre": "⏳ Podcast du matin : raté pour l'instant" if essai_suivant else
                             ("⚠️ Épisode pas préparé" if mode == "manuel" else "⚠️ Pas d'épisode aujourd'hui"),
                    "message": (f"Nouvel essai automatique à {heure_lisible(essai_suivant)}. " if essai_suivant else "")
                               + raison_lisible(message)[:150]})
            except Exception:
                pass
        if telegram and conversation and (not options.retours or nouvel_episode):
            lien = lien_execution()
            if options.recherche or options.echantillons:
                tete = "⚠️ <b>Recherche</b> : pas de résultats pour l'instant." if options.recherche else \
                    "⚠️ <b>Extraits de voix</b> : pas pour l'instant."
                message_court = raison_lisible(message)
            elif essai_suivant:
                tete = ("⏳ <b>Podcast du matin</b> : raté pour l'instant. Nouvel essai "
                        f"automatique à {echapper(heure_lisible(essai_suivant))}.")
                message_court = raison_lisible(message)
            else:
                tete = ("⚠️ <b>Podcast</b> : l'épisode demandé n'a pas pu être préparé." if mode == "manuel"
                        else "⚠️ <b>Podcast du matin</b> : pas d'épisode aujourd'hui.")
                message_court = message[:600]
            try:
                telegram.message(conversation, (
                    f"{tete}\n\n{echapper(message_court)}"
                    + (f'\n\n<a href="{html.escape(lien, quote=True)}">Voir les détails</a>'
                       if lien else "")))
            except ErreurPodcast:
                pass
        if not isinstance(erreur, ErreurPodcast):
            raise
        if essai_suivant:
            print(f"::warning::Épisode raté, rattrapage prévu à {essai_suivant} : {message[:300]}")
            return 0       # pas d'e-mail d'échec de GitHub : le rattrapage s'en charge
        return 1


if __name__ == "__main__":
    # Le module est importé sous son nom, pour que les modes annexes (recherche.py)
    # partagent ses variables (échéance, etc.).
    import podcast
    sys.exit(podcast.main())
