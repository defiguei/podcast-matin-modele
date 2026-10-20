"""Liaison avec le bot (Cloudflare) : lecture des réglages, envoi d'événements.

Le bot garde les réglages, les règles et le planning. GitHub les lit au début
de chaque épisode (/api/config) et lui signale ce qui a été envoyé
(/api/evenement), pour les boutons sous l'épisode et le tableau de bord.
Le secret partagé est dérivé du jeton du bot Telegram : rien de plus à régler.
"""

from __future__ import annotations

import hashlib
import json
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
