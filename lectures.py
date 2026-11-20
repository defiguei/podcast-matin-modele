"""Ce que chaque source a donné pendant une exécution (épisode ou recherche).

Chaque lecture d'un flux RSS, d'une recherche Google Actualités ou d'un service (météo, trains,
lieux, guides, recherche web) est notée ici : réussie ou non, et pourquoi. Le relevé part au bot
avec l'événement `episode` (ou `recherche`) ; l'application le montre sous chaque source de
Réglages › Sources (« Lu ce matin » ou « Échec ce matin »), sans attendre un test à la main.

Clés : `service:<catégorie>` (actus, web, meteo, transports, lieux, wikivoyage) et
`url:<adresse>` pour un flux (le bot retrouve le flux par son adresse).
"""
from __future__ import annotations

from typing import Any

MAX_SOURCES = 60

LECTURES: dict[str, dict[str, Any]] = {}


def noter(cle: str, ok: bool, detail: str = "") -> None:
    """Une lecture de plus pour cette source. `detail` : ce qu'elle a donné, ou l'erreur."""
    if not cle or (cle not in LECTURES and len(LECTURES) >= MAX_SOURCES):
        return
    lecture = LECTURES.setdefault(cle, {"reussies": 0, "echecs": 0, "detail": "", "erreur": ""})
    if ok:
        lecture["reussies"] += 1
        if detail:
            lecture["detail"] = str(detail)[:160]
    else:
        lecture["echecs"] += 1
        lecture["erreur"] = str(detail or "erreur inconnue")[:200]


def releve() -> dict[str, dict[str, Any]]:
    """Le relevé à envoyer au bot (copie)."""
    return {cle: dict(l) for cle, l in LECTURES.items()}


def oublier() -> None:
    LECTURES.clear()
