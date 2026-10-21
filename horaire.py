#!/usr/bin/env python3
"""Décide si ce lancement du workflow doit préparer un épisode.

Depuis la version 3, c'est le bot (Cloudflare) qui lance l'épisode à l'heure
choisie, jour par jour (lancement « planifie », puis « rattrapage » une heure
plus tard si besoin). Les déclenchements programmés de GitHub ne servent plus
que de filet de sécurité :
  - bot joignable : on ne fait rien, sauf si l'épisode prévu aujourd'hui n'est
    toujours pas parti 75 minutes après l'heure (mode « filet »), ou, si le bot l'a
    lancé, une fois son rattrapage réglable dépassé de 30 minutes ;
  - bot injoignable : on suit sa sauvegarde quotidienne (preferences.json) ;
  - sans bot du tout : ancien fonctionnement, à l'heure HEURE_LOCALE (trois
    créneaux UTC, été comme hiver, et un rattrapage une heure plus tard).
Les lancements à la main (ou par le bot) passent toujours.
N'utilise que la bibliothèque standard : il tourne avant toute installation.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

import pays

JOURS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
MARGE_FILET = 75   # minutes après l'heure prévue avant que GitHub ne prenne le relais


def normaliser(heure: str) -> str:
    heures, _, minutes = heure.strip().replace("h", ":").partition(":")
    return f"{int(heures):02d}:{int(minutes or 0):02d}"


def une_heure_plus_tard(heure: str) -> str:
    heures, minutes = normaliser(heure).split(":")
    return f"{(int(heures) + 1) % 24:02d}:{minutes}"


def decider(evenement: str, programmation: str, heure_locale: str, fuseau: str,
            maintenant: dt.datetime | None = None,
            heure_rattrapage: str = "") -> tuple[str, str]:
    """Renvoie (mode, explication) ; mode vaut "manuel", "normal", "rattrapage" ou ""."""
    if evenement != "schedule":
        return "manuel", f"Lancement « {evenement} » : on y va."
    try:
        minute, heure = (int(x) for x in programmation.split()[:2])
    except ValueError:
        return "manuel", f"Programmation « {programmation} » non reconnue : on y va par prudence."
    maintenant = maintenant or dt.datetime.now(dt.timezone.utc)
    prevu = maintenant.replace(hour=heure, minute=minute, second=0, microsecond=0)
    if prevu > maintenant + dt.timedelta(minutes=10):   # lancé après minuit UTC
        prevu -= dt.timedelta(days=1)
    locale = prevu.astimezone(ZoneInfo(fuseau)).strftime("%H:%M")
    voulue = normaliser(heure_locale)
    rattrapage = normaliser(heure_rattrapage) if heure_rattrapage else une_heure_plus_tard(voulue)
    if locale == voulue:
        return "normal", f"Déclenchement prévu à {locale} ({fuseau}) : c'est l'heure de l'épisode."
    if locale == rattrapage:
        return "rattrapage", (f"Déclenchement prévu à {locale} ({fuseau}) : rattrapage, "
                              "seulement si l'épisode du matin n'est pas parti.")
    return "", f"Déclenchement prévu à {locale} ({fuseau}), heure voulue {voulue} : pas celui-ci."


def doit_tourner(evenement: str, programmation: str, heure_locale: str, fuseau: str,
                 maintenant: dt.datetime | None = None) -> tuple[bool, str]:
    mode, explication = decider(evenement, programmation, heure_locale, fuseau, maintenant)
    return mode in ("manuel", "normal"), explication


# ─────────────────────── planning du bot (copie de config.js) ───────────────────────

def feries_vaud(annee: int) -> set[dt.date]:
    return {d for d, _ in pays.feries_calcules(annee, "CH-VD")}


def heure_prevue(planning: dict, jour: dt.date) -> str | None:
    """Heure de l'épisode ce jour-là selon le planning du bot, ou None."""
    iso = jour.isoformat()
    for exception in planning.get("exceptions") or []:
        if exception.get("date") == iso:
            return exception.get("heure")
    for pause in planning.get("pauses") or []:
        if str(pause.get("du", "")) <= iso <= str(pause.get("au", "")):
            return None
    jours = planning.get("jours") or {}
    # Vaud et la France sont calculés ; pour les autres, le bot fournit la liste téléchargée.
    region = planning.get("feries_region") or "CH-VD"
    calcules = pays.feries_calcules(jour.year, region)
    liste = calcules or [(dt.date.fromisoformat(d), nom) for d, nom in (planning.get("feries_cache") or {}).get(str(jour.year)) or []]
    ferie = jour in {d for d, _ in liste}
    if planning.get("feries", "normal") != "normal" and ferie:
        return None if planning.get("feries") == "aucun" else jours.get("dim")
    return jours.get(JOURS[jour.weekday()])


def _minutes(heure: str) -> int:
    h, m = normaliser(heure).split(":")
    return int(h) * 60 + int(m)


def lire_bot(adresse: str, jeton: str) -> dict | None:
    if not adresse or not jeton:
        return None
    secret = hashlib.sha256(f"podcast:{jeton}".encode()).hexdigest()[:48]
    requete = urllib.request.Request(f"{adresse.rstrip('/')}/api/config", headers={
        "X-Podcast-Secret": secret, "User-Agent": "podcast-matin-github"})
    try:
        with urllib.request.urlopen(requete, timeout=15) as reponse:
            donnees = json.loads(reponse.read().decode("utf-8"))
        return donnees if isinstance(donnees, dict) and donnees.get("format") == "bot-v2" else None
    except Exception:
        return None


def lire_secours(chemin: Path) -> dict | None:
    try:
        donnees = json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(donnees, dict) and donnees.get("format") == "bot-v2":
        return donnees.get("config")
    return None


def date_dernier_episode(chemin: Path) -> str:
    try:
        memoire = json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str(memoire.get("dernier_programme") or (memoire.get("dernier_episode") or {}).get("date") or "")


def decider_filet(maintenant: dt.datetime, fuseau: str, export: dict | None, secours: dict | None,
                  dernier: str) -> tuple[str, str]:
    """Déclenchement programmé quand le bot existe (ou a existé) : filet de sécurité."""
    local = maintenant.astimezone(ZoneInfo(fuseau))
    aujourd_hui = local.date()
    if dernier == aujourd_hui.isoformat():
        return "", "L'épisode du jour est déjà parti."
    if export:
        if export.get("episode_envoye_aujourdhui"):
            return "", "Le bot indique que l'épisode du jour est parti."
        heure = export.get("heure_prevue_aujourdhui")
        if not heure:
            return "", "Pas d'épisode prévu aujourd'hui (planning du bot)."
        retard = local.hour * 60 + local.minute - _minutes(heure)
        marge = MARGE_FILET
        if export.get("episode_lance_aujourdhui"):
            # Le bot a déjà lancé l'épisode : c'est à lui de décider d'un rattrapage (délai réglable).
            planning = (export.get("config") or {}).get("planning") or {}
            if not planning.get("rattrapage", True):
                return "", "Rattrapage désactivé dans le bot : pas de relance."
            marge = max(MARGE_FILET, int(planning.get("delai_rattrapage") or 60) + 30)
        if retard < marge:
            return "", f"Épisode prévu à {heure} : le bot s'en charge."
        return "filet", f"Épisode prévu à {heure}, toujours pas parti : GitHub prend le relais."
    heure = heure_prevue((secours or {}).get("planning") or {}, aujourd_hui)
    if not heure:
        return "", "Bot injoignable ; pas d'épisode prévu aujourd'hui d'après sa sauvegarde."
    if local.hour * 60 + local.minute < _minutes(heure) - 5:
        return "", f"Bot injoignable ; épisode prévu à {heure} d'après sa sauvegarde : pas encore."
    return "filet", f"Bot injoignable : épisode de {heure} préparé par GitHub (sauvegarde du bot)."


def main() -> int:
    heure_locale = os.environ.get("HEURE_LOCALE", "05:45")
    heure_rattrapage = os.environ.get("HEURE_RATTRAPAGE", "") or une_heure_plus_tard(heure_locale)
    fuseau = os.environ.get("FUSEAU", "Europe/Zurich")
    evenement = os.environ.get("EVENEMENT", "")
    racine = Path(os.environ.get("RACINE", ".") or ".")
    mode_python = ""
    if evenement != "schedule":
        mode_python = (os.environ.get("MODE_DEMANDE", "") or "").strip().lower() or "manuel"
        mode, explication = "manuel", f"Lancement « {evenement} » (mode {mode_python}) : on y va."
    else:
        # Secret partagé : jeton Telegram, sinon jeton GitHub du bot (installation sans Telegram).
        jeton = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip() or os.environ.get("BOT_GITHUB_TOKEN", "").strip()
        export = lire_bot(os.environ.get("BOT_URL", ""), jeton)
        secours = None if export else lire_secours(racine / "preferences.json")
        config = (export or {}).get("config") or secours or {}
        if config.get("pays") in pays.PROFILS:      # le pays choisi dans l'application donne le fuseau
            fuseau = pays.profil(config["pays"])["fuseau"]
        if export or secours:
            mode, explication = decider_filet(dt.datetime.now(dt.timezone.utc), fuseau, export, secours,
                                              date_dernier_episode(racine / "memoire.json"))
            mode_python = mode
        elif not os.environ.get("TELEGRAM_BOT_TOKEN", "").strip():
            # Dépôt modèle, installation pas encore terminée, ou bot (sans Telegram) injoignable et
            # sans sauvegarde : personne à qui envoyer un épisode.
            mode, explication = "", "Bot injoignable et pas de Telegram : pas d'épisode programmé ici."
        else:      # ancien fonctionnement, sans bot
            mode, explication = decider(evenement, os.environ.get("PROGRAMMATION", ""), heure_locale, fuseau,
                                        heure_rattrapage=heure_rattrapage)
    print(explication)
    sortie = os.environ.get("GITHUB_OUTPUT")
    if sortie:
        with open(sortie, "a", encoding="utf-8") as fichier:
            fichier.write(f"go={'true' if mode else 'false'}\n")
            fichier.write(f"mode={mode_python}\n")
            fichier.write(f"rattrapage={'true' if mode == 'rattrapage' else 'false'}\n")
            # Après un envoi programmé raté, le message Telegram annonce le rattrapage.
            fichier.write(f"essai_suivant={normaliser(heure_rattrapage) if mode == 'normal' else ''}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
