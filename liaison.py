"""Liaison avec le bot (Cloudflare) : lecture des réglages, envoi d'événements.

Le bot garde les réglages, les règles et le planning. GitHub les lit au début
de chaque épisode (/api/config) et lui signale ce qui a été envoyé
(/api/evenement), pour les boutons sous l'épisode et le tableau de bord.
Le secret partagé est dérivé du jeton du bot Telegram : rien de plus à régler.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import requests

ADRESSE_PAR_DEFAUT = "https://podcast.TON-SOUS-DOMAINE.workers.dev"


def secret_partage(jeton_telegram: str) -> str:
    return hashlib.sha256(f"podcast:{jeton_telegram}".encode()).hexdigest()[:48]


class Bot:
    def __init__(self, adresse: str, jeton_telegram: str, delai: int = 20) -> None:
        self.adresse = (adresse or ADRESSE_PAR_DEFAUT).rstrip("/")
        self.secret = secret_partage(jeton_telegram) if jeton_telegram else ""
        self.delai = delai

    def config(self) -> dict | None:
        """Réglages complets (format « bot-v2 »), ou None si le bot ne répond pas."""
        if not self.secret:
            return None
        for _ in range(2):
            try:
                reponse = requests.get(f"{self.adresse}/api/config", timeout=self.delai,
                                       headers={"X-Podcast-Secret": self.secret})
                if reponse.status_code == 200:
                    donnees = reponse.json()
                    if isinstance(donnees, dict) and donnees.get("format") == "bot-v2":
                        return donnees
                    return None
                if reponse.status_code in (403, 404):
                    return None
            except (requests.RequestException, ValueError):
                continue
        return None

    def evenement(self, evenement: dict[str, Any]) -> bool:
        if not self.secret:
            return False
        try:
            reponse = requests.post(f"{self.adresse}/api/evenement", timeout=self.delai,
                                    headers={"X-Podcast-Secret": self.secret}, json=evenement)
            return reponse.status_code == 200 and bool(reponse.json().get("ok"))
        except (requests.RequestException, ValueError):
            return False


def config_de_secours(chemin: Path) -> dict | None:
    """Sauvegarde quotidienne du bot (preferences.json au format « bot-v2 »)."""
    try:
        donnees = json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(donnees, dict) and donnees.get("format") == "bot-v2" and isinstance(donnees.get("config"), dict):
        return {"format": "bot-v2", "config": donnees["config"], "secours": True}
    return None


# Clés et agendas saisis dans l'application : le bot les garde et les donne à
# GitHub au début de chaque lancement. Ils l'emportent sur les secrets GitHub,
# qui restent la solution de secours quand le bot ne répond pas.
CLES_APPLICATION = {"gemini": "GEMINI_API_KEY", "tavily": "TAVILY_API_KEY", "sncf": "SNCF_API_KEY"}
SECRETS_SUIVIS = [*CLES_APPLICATION.values(), "CALENDAR_ICS_URL"]


def secrets_presents() -> list[str]:
    """Secrets GitHub renseignés pour ce lancement (leurs noms seulement)."""
    return [nom for nom in SECRETS_SUIVIS if os.environ.get(nom, "").strip()]


def masquer(valeur: str) -> None:
    """Une valeur secrète venue du bot n'apparaît jamais dans le journal de GitHub."""
    if valeur and os.environ.get("GITHUB_ACTIONS"):
        print(f"::add-mask::{valeur}", flush=True)


def appliquer_cles(export: dict | None) -> list[str]:
    """Met les clés et agendas de l'application dans l'environnement ; renvoie ce qui a été appliqué."""
    cles = (export or {}).get("cles") or {}
    appliquees = []
    for nom_app, variable in CLES_APPLICATION.items():
        valeur = str(cles.get(nom_app) or "").strip()
        if valeur:
            masquer(valeur)
            os.environ[variable] = valeur
            appliquees.append(variable)
    urls = [str(u).strip() for u in (export or {}).get("agendas_urls") or [] if str(u).strip()]
    if urls:
        for url in urls:
            masquer(url)
        existantes = os.environ.get("CALENDAR_ICS_URL", "").split()
        os.environ["CALENDAR_ICS_URL"] = " ".join(existantes + [u for u in urls if u not in existantes])
        appliquees.append("CALENDAR_ICS_URL")
    return appliquees
