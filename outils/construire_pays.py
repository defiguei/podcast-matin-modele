#!/usr/bin/env python3
"""Fabrique donnees/pays.json : un profil par pays (fuseau, devise, jours fériés, actualités…).

Les profils CH, FR et BE sont écrits à la main (médias, exemples) et ne sont jamais touchés.
Les autres sont déduits de bases standard : noms français et langues officielles (CLDR, via babel),
devise (CLDR), fuseau de la zone principale (base des fuseaux horaires, zone.tab) ; leur flux d'actualités
est l'édition locale de Google Actualités. Ces profils sont marqués "auto": true.

Les pays proposés sont ceux qui ont une fête nationale dans outils/fetes/nationales.txt, plus CH, FR et BE.
À relancer après avoir modifié cette liste : python3 outils/construire_pays.py
(nécessite le paquet babel ; le résultat est enregistré dans le dépôt, le podcast n'en a pas besoin.)
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from babel import Locale
from babel.languages import get_official_languages
from babel.numbers import get_territory_currencies

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "donnees" / "pays.json"
MAIN = ("CH", "FR", "BE")
# Zone principale quand zone.tab en liste plusieurs et que la première n'est pas la capitale.
ZONES = {"US": "America/New_York", "CA": "America/Toronto", "AU": "Australia/Sydney", "BR": "America/Sao_Paulo",
         "RU": "Europe/Moscow", "MX": "America/Mexico_City", "CN": "Asia/Shanghai", "ID": "Asia/Jakarta",
         "KZ": "Asia/Almaty", "CL": "America/Santiago", "EC": "America/Guayaquil", "ES": "Europe/Madrid",
         "PT": "Europe/Lisbon", "NZ": "Pacific/Auckland", "MN": "Asia/Ulaanbaatar", "DE": "Europe/Berlin",
         "GB": "Europe/London", "UA": "Europe/Kyiv"}
# Langue des actualités quand la première langue officielle n'a pas d'édition Google Actualités probable.
LANGUES = {"IN": "en", "PK": "en", "NG": "en", "ZA": "en", "PH": "en", "SG": "en", "KE": "en", "GH": "en",
           "CD": "fr", "CH": "fr", "BE": "fr", "LU": "fr", "CA": "fr", "CM": "fr", "SN": "fr", "CI": "fr"}
SANS_PAYS = {
    "nom": "Pas renseigné", "fuseau": "Europe/Zurich", "devise": "EUR", "feries": "--", "actus_langue": "fr",
    "actus_pays": "FR", "accept_language": "fr;q=0.9,en;q=0.5", "ou": "dont le pays n'est pas précisé",
    "habitant": "un auditeur dont le pays n'est pas précisé", "d_abord": "l'actualité proche de l'auditeur",
    "exemple_ville": "Genève", "exemple_rando": "randonnée facile près de chez l'auditeur",
    "flux": [{"nom": "Google Actualités – monde", "url": "https://news.google.com/rss?hl=fr&gl=FR&ceid=FR:fr"}],
}


def zones_principales() -> dict[str, str]:
    zones: dict[str, str] = {}
    for ligne in Path("/usr/share/zoneinfo/zone.tab").read_text(encoding="utf-8").splitlines():
        if ligne.startswith("#") or not ligne.strip():
            continue
        code, _, zone = ligne.split("\t")[:3]
        zones.setdefault(code, zone)
    return zones


def codes_demandes() -> list[str]:
    codes = set(MAIN)
    for ligne in (RACINE / "outils" / "fetes" / "nationales.txt").read_text(encoding="utf-8").splitlines():
        morceaux = [m.strip() for m in ligne.split("|")]
        if len(morceaux) > 2 and re.fullmatch(r"[A-Z]{2}", morceaux[1]):
            codes.add(morceaux[1])
    return sorted(codes)


def profil_auto(code: str, nom: str, zone: str, langue: str, devise: str) -> dict:
    ville = zone.split("/")[-1].replace("_", " ")
    return {
        "auto": True, "nom": nom, "fuseau": zone, "devise": devise, "feries": code,
        "actus_langue": langue, "actus_pays": code, "accept_language": f"{langue}-{code},{langue};q=0.9,fr;q=0.6",
        "ou": f"résidant dans le pays suivant : {nom}", "habitant": f"un habitant du pays suivant : {nom}",
        "d_abord": f"le pays « {nom} »", "exemple_ville": ville, "exemple_rando": f"randonnée facile près de {ville}",
        "flux": [{"nom": f"Google Actualités – {nom}",
                  "url": f"https://news.google.com/rss?hl={langue}&gl={code}&ceid={code}:{langue}"}],
    }


def main() -> None:
    ancien = json.loads(SORTIE.read_text(encoding="utf-8"))
    noms = Locale("fr").territories
    zones = {**zones_principales(), **ZONES}
    resultat = {c: ancien[c] for c in MAIN}
    manques = []
    for code in codes_demandes():
        if code in MAIN:
            continue
        zone, nom = zones.get(code), noms.get(code)
        devises = get_territory_currencies(code)
        if not zone or not nom or not devises:
            manques.append(code)
            continue
        langue = LANGUES.get(code) or (get_official_languages(code, regional=True, de_facto=True) or ("en",))[0]
        resultat[code] = profil_auto(code, nom, zone, langue.split("_")[0], devises[0])
    ordre = sorted((c for c in resultat if c not in MAIN), key=lambda c: resultat[c]["nom"])
    sortie = {**{c: resultat[c] for c in MAIN}, **{c: resultat[c] for c in ordre}, "--": SANS_PAYS}
    SORTIE.write_text(json.dumps(sortie, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(sortie) - 1} pays écrits dans {SORTIE.relative_to(RACINE)}"
          + (f" ; sans profil (données manquantes) : {', '.join(manques)}" if manques else ""))


if __name__ == "__main__":
    main()
