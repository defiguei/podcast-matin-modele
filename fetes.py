"""Prénoms fêtés, journées internationales, fêtes nationales et usages du jour — sans réseau.

Tout vient de deux fichiers de référence fabriqués une fois pour toutes par
outils/construire_fetes.py à partir des tables de outils/fetes/ :

  donnees/prenoms.json    un prénom principal par jour (calendrier traditionnel), recoupé avec
                          donnees/saints.json
  donnees/journees.json   journées ONU et agences, fêtes nationales (avec leur recoupement et leurs
                          réserves), usages de France, Suisse et Belgique, fêtes populaires

Pourquoi pas une API ou Wikipédia chaque matin : aucune source ne donne seule les deux, les listes
en ligne se contredisent d'un pays à l'autre, et un service indisponible ne doit pas priver l'épisode.
Les choix et les biais constatés sont expliqués dans docs/SOURCES-FETES.md.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

from pays import _paques

RACINE = Path(__file__).resolve().parent
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
        "septembre", "octobre", "novembre", "décembre"]
NOMS_PAYS = {"FR": "France", "CH": "Suisse", "BE": "Belgique"}
_cache: dict[str, Any] = {}


def _charger(nom: str, chemin: Path | None = None) -> dict:
    cle = f"{nom}:{chemin}"
    if cle not in _cache:
        try:
            _cache[cle] = json.loads((chemin or RACINE / "donnees" / nom).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _cache[cle] = {}
    return _cache[cle]


# ───────────────────────────── dates à règle (jours mobiles) ─────────────────────────────

def _nieme(annee: int, mois: int, n: int, jour_semaine: int) -> dt.date | None:
    """N-ième jour de la semaine du mois (n = -1 : le dernier ; jour_semaine 0 = lundi … 6 = dimanche)."""
    if n > 0:
        premier = dt.date(annee, mois, 1)
        jour = premier + dt.timedelta(days=(jour_semaine - premier.weekday()) % 7 + 7 * (n - 1))
    else:
        suivant = dt.date(annee + (mois == 12), mois % 12 + 1, 1)
        dernier = suivant - dt.timedelta(days=1)
        jour = dernier - dt.timedelta(days=(dernier.weekday() - jour_semaine) % 7)
    return jour if jour.month == mois else None


def date_regle(regle: str, annee: int) -> dt.date | None:
    """Date d'une règle pour une année : « nth:5:2:6 » (2e dimanche de mai), « nth:11:4:3+1 »
    (lendemain du 4e jeudi de novembre), « paques:+49 », « fete_meres_fr »."""
    try:
        if regle == "fete_meres_fr":
            dernier_dimanche = _nieme(annee, 5, -1, 6)
            return dernier_dimanche + dt.timedelta(days=7) if dernier_dimanche == _paques(annee) + dt.timedelta(days=49) \
                else dernier_dimanche
        if regle.startswith("paques:"):
            return _paques(annee) + dt.timedelta(days=int(regle.split(":", 1)[1]))
        if regle.startswith("nth:"):
            corps, _, decalage = regle[4:].partition("+")
            mois, n, jour_semaine = (int(x) for x in corps.split(":"))
            jour = _nieme(annee, mois, n, jour_semaine)
            return jour + dt.timedelta(days=int(decalage or 0)) if jour else None
    except (ValueError, TypeError):
        return None
    return None


# ───────────────────────────────────── prénoms ─────────────────────────────────────

def prenoms_du_jour(jour: dt.date) -> dict[str, Any]:
    """{"principal": [...], "fete": "", "aussi": [...], "accord": bool} ; vide si le fichier manque."""
    fiche = (_charger("prenoms.json").get("jours") or {}).get(jour.strftime("%m-%d")) or {}
    return {"principal": list(fiche.get("principal") or []), "fete": fiche.get("fete") or "",
            "aussi": list(fiche.get("aussi") or []), "accord": bool(fiche.get("accord"))}


def saints_du_jour(jour: dt.date, chemin: Path | None = None) -> list[str]:
    donnees = _charger("saints.json", chemin)
    return list((donnees.get("jours") or {}).get(jour.strftime("%m-%d"), []))


def _et(noms: list[str]) -> str:
    return noms[0] if len(noms) == 1 else ", ".join(noms[:-1]) + " et " + noms[-1] if noms else ""


def prenoms_en_texte(jour: dt.date) -> list[str]:
    """Lignes prêtes pour la rubrique « Fête du prénom » : les prénoms à souhaiter, sans les saints
    (l'auditeur fête des prénoms d'amis, pas des saints)."""
    p = prenoms_du_jour(jour)
    lignes: list[str] = []
    if p["principal"]:
        lignes.append(f"Prénom fêté aujourd'hui (calendrier traditionnel français) : {_et(p['principal'])}"
                      + (f" — {p['fete']}" if p["fete"] else ""))
        if p["aussi"]:
            lignes.append(f"Autres prénoms que l'on fête aussi ce jour-là, selon les calendriers : {_et(p['aussi'])}")
    elif p["fete"]:
        lignes.append(f"Pas de prénom fixe ce jour-là dans le calendrier traditionnel : c'est {p['fete']}"
                      + (f" (prénoms parfois fêtés ce jour-là : {_et(p['aussi'])})" if p["aussi"] else ""))
    return lignes


# ───────────────────────────────────── journées ─────────────────────────────────────

def _date_longue(jour: dt.date) -> str:
    return f"{jour.day} {MOIS[jour.month - 1]}"


def _entrees_du_jour(jour: dt.date) -> list[dict[str, Any]]:
    donnees = _charger("journees.json")
    trouvees = list((donnees.get("fixes") or {}).get(jour.strftime("%m-%d"), []))
    for r in donnees.get("regles") or []:
        if date_regle(r.get("regle", ""), jour.year) == jour:
            trouvees.append(r)
    return trouvees


def journees_du_jour(jour: dt.date, code_pays: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Entrées du jour rangées par famille : onu, nationales, pays (celui de l'auditeur), populaires."""
    famille: dict[str, list[dict[str, Any]]] = {"onu": [], "nationales": [], "pays": [], "populaires": []}
    for e in _entrees_du_jour(jour):
        cat = e.get("cat")
        if cat == "onu":
            famille["onu"].append(e)
        elif cat == "nationale":
            famille["nationales"].append(e)
        else:
            portee = e.get("portee") or []
            if code_pays and "monde" not in portee and code_pays not in portee:
                continue
            famille["populaires" if e.get("fiab") == "populaire" else "pays"].append(e)
    # le pays de l'auditeur d'abord, puis les autres par ordre alphabétique
    famille["nationales"].sort(key=lambda e: (e.get("iso") != code_pays, e.get("pays", "")))
    return famille


def _nom_onu(e: dict[str, Any]) -> str:
    nom = f"{e['nom']} ({e['org']})" if e.get("org") else e["nom"]
    if e.get("semaine"):
        nom += f", {e['semaine']}"
    return nom + (" [sujet sensible : à traiter avec tact]" if e.get("sensible") else "")


def _nom_nationale(e: dict[str, Any]) -> str:
    texte = f"{e['pays']} : {e['nom']}"
    if e.get("drapeau") == "C" and e.get("note"):
        texte += f" [date ou statut contesté : {e['note']}]"
    return texte


def lignes_du_jour(jour: dt.date, code_pays: str | None = None) -> list[str]:
    """Fêtes nationales et journées du jour, une ligne par famille, sans réseau."""
    f = journees_du_jour(jour, code_pays)
    lignes: list[str] = []
    if f["onu"]:
        lignes.append("Journées internationales officielles (ONU et agences) : " + " ; ".join(_nom_onu(e) for e in f["onu"]))
    if f["nationales"]:
        lignes.append("Fêtes nationales dans le monde ce jour-là : " + " ; ".join(_nom_nationale(e) for e in f["nationales"]))
    if f["pays"]:
        lignes.append(f"Chez l'auditeur ({NOMS_PAYS.get(code_pays or '', 'France, Suisse, Belgique')}) : "
                      + " ; ".join(e["nom"] + (f" — {e['note']}" if e.get("note") else "") for e in f["pays"]))
    if f["populaires"]:
        lignes.append("Journées non officielles (à présenter comme telles) : "
                      + " ; ".join(e["nom"] + (f" — {e['note']}" if e.get("note") else "") for e in f["populaires"]))
    return lignes
