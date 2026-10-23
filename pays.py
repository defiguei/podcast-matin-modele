"""Pays de l'auditeur : fuseau horaire, actualités, devise, jours fériés et
tournures des consignes à Gemini. Le profil de chaque pays est dans
donnees/pays.json (le bot Cloudflare lit le même fichier).

Le pays se choisit dans l'application ; une fois les réglages du bot lus,
podcast.py appelle definir_depuis_config() et tout le reste suit.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

RACINE = Path(__file__).resolve().parent
PROFILS: dict[str, dict[str, Any]] = json.loads((RACINE / "donnees" / "pays.json").read_text(encoding="utf-8"))
DEFAUT = "CH"

SANS_PAYS = "--"   # « Pas renseigné » : ni jours fériés, ni médias d'un pays
_actuel = {"code": DEFAUT, "feries": "", "fuseau": ""}


def definir(code: str | None, region_feries: str | None = None, fuseau: str | None = None) -> None:
    _actuel["code"] = code if code in PROFILS else DEFAUT
    _actuel["feries"] = str(region_feries or "")
    _actuel["fuseau"] = str(fuseau or "")


def definir_depuis_config(config: dict | None) -> None:
    config = config or {}
    definir(config.get("pays"), (config.get("planning") or {}).get("feries_region"), config.get("fuseau"))


def code() -> str:
    return _actuel["code"]


def profil(code_pays: str | None = None, fuseau: str | None = None) -> dict[str, Any]:
    """Profil d'un pays. Sans pays (« Pas renseigné »), l'heure reste celle du pays choisi avant."""
    profil_pays = PROFILS.get(code_pays or _actuel["code"]) or PROFILS[DEFAUT]
    if (code_pays or _actuel["code"]) == SANS_PAYS:
        return {**profil_pays, "fuseau": fuseau or _actuel["fuseau"] or profil_pays["fuseau"]}
    return profil_pays


def region_feries() -> str:
    return _actuel["feries"] or profil()["feries"]


def devise() -> str:
    return profil()["devise"]


# ───────────────────────────────── jours fériés ──────────────────────────────

def _paques(annee: int) -> dt.date:
    a, b, c = annee % 19, annee // 100, annee % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    return dt.date(annee, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)


def feries_calcules(annee: int, region: str) -> list[tuple[dt.date, str]]:
    """Fériés calculés sans réseau ni bibliothèque : canton de Vaud et France."""
    p = _paques(annee)
    jour = dt.timedelta(days=1)
    if region == "CH-VD":
        septembre = dt.date(annee, 9, 1)
        jeune = septembre + dt.timedelta(days=(6 - septembre.weekday()) % 7 + 15)
        return [(dt.date(annee, 1, 1), "Nouvel An"), (dt.date(annee, 1, 2), "Saint-Berchtold"),
                (p - 2 * jour, "Vendredi saint"), (p + jour, "Lundi de Pâques"), (p + 39 * jour, "Ascension"),
                (p + 50 * jour, "Lundi de Pentecôte"), (dt.date(annee, 8, 1), "Fête nationale"),
                (jeune, "Lundi du Jeûne fédéral"), (dt.date(annee, 12, 25), "Noël")]
    if region == "FR":
        return [(dt.date(annee, 1, 1), "Jour de l'an"), (p + jour, "Lundi de Pâques"), (dt.date(annee, 5, 1), "Fête du Travail"),
                (dt.date(annee, 5, 8), "Victoire 1945"), (p + 39 * jour, "Ascension"), (p + 50 * jour, "Lundi de Pentecôte"),
                (dt.date(annee, 7, 14), "Fête nationale"), (dt.date(annee, 8, 15), "Assomption"),
                (dt.date(annee, 11, 1), "Toussaint"), (dt.date(annee, 11, 11), "Armistice 1918"), (dt.date(annee, 12, 25), "Noël")]
    return []


def feries(debut: dt.date, jours: int = 7, region: str | None = None) -> list[tuple[dt.date, str]]:
    """Jours fériés de la région (« CH-VD », « FR », « BE »…) entre debut et debut + jours."""
    region = region or region_feries()
    if region == SANS_PAYS:
        return []
    fin = debut + dt.timedelta(days=jours)
    pays_code, _, subdivision = region.partition("-")
    try:
        import holidays  # bibliothèque « holidays »
        annees = {debut.year, fin.year}
        try:
            calendrier = holidays.country_holidays(pays_code, subdiv=subdivision or None, years=annees, language="fr")
        except (NotImplementedError, TypeError, ValueError):
            calendrier = holidays.country_holidays(pays_code, subdiv=subdivision or None, years=annees)
        trouves = [(d, str(nom)) for d, nom in calendrier.items() if debut <= d <= fin]
    except Exception:
        trouves = [(d, nom) for annee in {debut.year, fin.year} for d, nom in feries_calcules(annee, region)
                   if debut <= d <= fin]
    return sorted(set(trouves))
