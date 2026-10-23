#!/usr/bin/env python3
"""Fabrique les données de référence des fêtes à partir des tables de outils/fetes/.

    python3 outils/construire_fetes.py              écrit donnees/prenoms.json et donnees/journees.json
    python3 outils/construire_fetes.py --verifier   ne touche à rien ; échoue si les fichiers ne sont pas
                                                    à jour ou si un contrôle de qualité échoue (test)
    python3 outils/construire_fetes.py --rapport    en plus, détaille désaccords et recoupements

Tables (une ligne = une entrée, « # » = commentaire) :
    prenoms.txt     calendrier traditionnel des prénoms (366 jours)
    onu.txt         journées et semaines internationales
    nationales.txt  fêtes nationales par pays
    usages.txt      usages de France, Suisse, Belgique et fêtes populaires
    ref_mfat.txt, ref_wikipedia.txt   listes tierces servant à recouper les fêtes nationales

Contrôles : 366 jours exactement ; dates valides ; règles de jours mobiles calculables ; fêtes
contestées toujours accompagnées d'une note ; accord du calendrier des prénoms avec donnees/saints.json
d'au moins 40 % dans CHAQUE mois (c'est ce contrôle qui aurait trouvé mai et juin inversés).
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RACINE))
import fetes  # noqa: E402  (date_regle, MOIS)

TABLES = RACINE / "outils" / "fetes"
JOURS = [(dt.date(2024, 1, 1) + dt.timedelta(n)).strftime("%m-%d") for n in range(366)]
SEUIL_ACCORD_MOIS = 0.40
MAX_AUSSI = 3

erreurs: list[str] = []


def lignes(nom: str) -> list[tuple[int, list[str]]]:
    """Lignes utiles d'une table : (numéro, champs séparés par « | »)."""
    sortie = []
    for i, brut in enumerate((TABLES / nom).read_text(encoding="utf-8").splitlines(), 1):
        if brut.strip() and not brut.lstrip().startswith("#"):
            sortie.append((i, [c.strip() for c in brut.split("|")]))
    return sortie


def echec(fichier: str, numero: int, message: str) -> None:
    erreurs.append(f"{fichier}:{numero} : {message}")


def norme(texte: str) -> str:
    t = unicodedata.normalize("NFD", texte.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def jour_valide(texte: str) -> bool:
    return bool(re.fullmatch(r"\d\d-\d\d", texte)) and texte in JOURS


# ───────────────────────────────────── prénoms ─────────────────────────────────────

def prenom_depuis_saint(saint: str) -> str:
    """« St-Jean de Capistran » -> « Jean » ; vide pour une fête (« Noël », « Chandeleur »…)."""
    m = re.match(r"^(?:Sts?|Stes?)-?\s*(.+)$", saint.strip())
    if not m:
        return ""
    nom = re.sub(r"\s*\(.*?\)", "", m.group(1))
    nom = re.split(r",|\s+(?:de|du|des|d')\s*|\s+le\s|\s+la\s", nom)[0].strip()
    nom = nom.split(" ")[0]
    return nom if re.fullmatch(r"[A-ZÉÈÀÂÊÎÔÛÇ][\wÀ-ÿ'-]+", nom) else ""


def construire_prenoms(rapport: list[str]) -> dict:
    saints = json.loads((RACINE / "donnees" / "saints.json").read_text(encoding="utf-8"))
    sj = saints["jours"]
    if sorted(sj) != sorted(JOURS):
        erreurs.append("donnees/saints.json : il doit contenir exactement les 366 jours (29 février compris)")
        return {}
    vus: set[str] = set()
    jours: dict[str, dict] = {}
    accord_mois: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    desaccords = []
    for numero, c in lignes("prenoms.txt"):
        if len(c) < 2 or not jour_valide(c[0]):
            echec("prenoms.txt", numero, f"ligne incorrecte : {c}")
            continue
        if c[0] in vus:
            echec("prenoms.txt", numero, f"jour en double : {c[0]}")
        vus.add(c[0])
        principal = [] if c[1] == "-" else [p.strip() for p in c[1].split("/") if p.strip()]
        fete = c[2] if len(c) > 2 else ""
        texte_saints = " ".join(norme(s) for s in sj[c[0]])
        accord = bool(principal) and any(norme(p) in texte_saints for p in principal)
        if principal:
            accord_mois[c[0][:2]][0] += 1
            accord_mois[c[0][:2]][1] += accord
            if not accord:
                desaccords.append((c[0], "/".join(principal), sj[c[0]]))
        deja = {norme(p) for p in principal}
        aussi: list[str] = []
        for s in sj[c[0]]:
            p = prenom_depuis_saint(s)
            if p and norme(p) not in deja and p not in aussi:
                aussi.append(p)
        jours[c[0]] = {"principal": principal, "fete": fete, "aussi": aussi[:MAX_AUSSI], "accord": accord}
    for j in sorted(set(JOURS) - vus):
        erreurs.append(f"prenoms.txt : jour manquant {j}")
    for mois, (total, ok) in sorted(accord_mois.items()):
        if total and ok / total < SEUIL_ACCORD_MOIS:
            erreurs.append(f"prenoms/saints : accord de {ok}/{total} seulement pour le mois {mois} "
                           f"(< {int(SEUIL_ACCORD_MOIS * 100)} %) — mois inversé ou décalé dans l'une des deux sources ?")
    total_p = sum(t for t, _ in accord_mois.values())
    total_ok = sum(o for _, o in accord_mois.values())
    rapport.append(f"PRÉNOMS : {len(jours)} jours ; accord avec le calendrier des saints {total_ok}/{total_p} "
                   f"({round(100 * total_ok / max(total_p, 1))} %) ; {sum(1 for v in jours.values() if not v['principal'])} jours de fête sans prénom fixe.")
    rapport.append("  accord par mois : " + ", ".join(f"{m}={o}/{t}" for m, (t, o) in sorted(accord_mois.items())))
    rapport.append(f"  {len(desaccords)} jours où le prénom traditionnel n'est pas parmi les saints du jour (calendriers différents) :")
    rapport.extend(f"    {j} {p:<22} saints : {', '.join(s)}" for j, p, s in desaccords)
    return {"source": ("Calendrier traditionnel des prénoms (almanach des PTT, tel que repris par les calendriers français, "
                       "belges et suisses romands), saisi dans outils/fetes/prenoms.txt ; prénoms secondaires déduits du "
                       "calendrier des saints (data.gouv.fr, Licence Ouverte, corrigé). Fabriqué par outils/construire_fetes.py."),
            "jours": {j: jours[j] for j in JOURS if j in jours}}


# ───────────────────────────────────── journées ─────────────────────────────────────

def lire_ref(nom: str) -> set[tuple[str, str]]:
    ref = set()
    for ligne in (TABLES / nom).read_text(encoding="utf-8").splitlines():
        if ligne.strip() and not ligne.lstrip().startswith("#"):
            jour, iso = ligne.split()
            ref.add((jour, iso))
    return ref


def valider_date(fichier: str, numero: int, texte: str) -> str:
    """Renvoie « fixe », « semaine » ou « regle » ; signale les dates impossibles."""
    if jour_valide(texte):
        return "fixe"
    m = re.fullmatch(r"(\d\d-\d\d)\.\.(\d\d-\d\d)", texte)
    if m and jour_valide(m.group(1)) and jour_valide(m.group(2)) and m.group(1) <= m.group(2):
        return "semaine"
    if texte == "fete_meres_fr" or re.fullmatch(r"paques:[+-]\d+", texte) or re.fullmatch(r"nth:\d+:-?\d:\d(\+\d)?", texte):
        if any(fetes.date_regle(texte, an) for an in range(2026, 2031)):
            return "regle"
    echec(fichier, numero, f"date ou règle incorrecte : « {texte} »")
    return ""


def semaine_en_mots(debut: str, fin: str) -> str:
    d1, d2 = int(debut[3:]), int(fin[3:])
    m1, m2 = fetes.MOIS[int(debut[:2]) - 1], fetes.MOIS[int(fin[:2]) - 1]
    jour = lambda d: "1er" if d == 1 else str(d)   # noqa: E731
    return f"du {jour(d1)} au {jour(d2)} {m2}" if m1 == m2 else f"du {jour(d1)} {m1} au {jour(d2)} {m2}"


def construire_journees(rapport: list[str]) -> dict:
    fixes: dict[str, list[dict]] = defaultdict(list)
    regles: list[dict] = []

    def ajouter(type_date: str, texte: str, entree: dict) -> None:
        if type_date == "fixe":
            fixes[texte].append(entree)
        elif type_date == "regle":
            regles.append({"regle": texte, **entree})
        elif type_date == "semaine":
            debut, fin = texte.split("..")
            mots = semaine_en_mots(debut, fin)
            for j in JOURS:
                if debut <= j <= fin:
                    fixes[j].append({**entree, "semaine": mots})

    # ONU et agences
    for n, c in lignes("onu.txt"):
        if len(c) != 4 or c[3] not in {"0", "1"}:
            echec("onu.txt", n, f"4 champs attendus (date | nom | organisme | sensible) : {c}")
            continue
        ajouter(valider_date("onu.txt", n, c[0]), c[0], {"nom": c[1], "cat": "onu", "org": c[2], "sensible": c[3] == "1"})

    # fêtes nationales + recoupement
    mfat, wiki = lire_ref("ref_mfat.txt"), lire_ref("ref_wikipedia.txt")
    table: dict[str, set[str]] = defaultdict(set)
    compte = Counter()
    sans_recoupement = []
    deja: set[tuple[str, str]] = set()
    for n, c in lignes("nationales.txt"):
        c = c + [""] * (7 - len(c))
        date, iso, pays, nom, type_, drapeau, note = c[:7]
        if not jour_valide(date) or not iso or not pays or not nom or drapeau not in {"S", "C"}:
            echec("nationales.txt", n, f"ligne incorrecte : {c}")
            continue
        if drapeau == "C" and not note:
            echec("nationales.txt", n, f"date contestée sans note : {pays}")
        if (date, iso) in deja:
            echec("nationales.txt", n, f"doublon : {iso} {date}")
        deja.add((date, iso))
        table[iso].add(date)
        recoupe = [nom_ref for nom_ref, ref in (("MFAT", mfat), ("Wikipédia", wiki)) if (date, iso) in ref]
        compte[len(recoupe)] += 1
        if not recoupe:
            sans_recoupement.append(f"{iso} {date} {pays}")
        entree = {"nom": nom, "cat": "nationale", "iso": iso, "pays": pays, "type": type_, "drapeau": drapeau, "recoupe": recoupe}
        if note:
            entree["note"] = note
        fixes[date].append(entree)
    pays_couverts = len(table)
    rapport.append(f"FÊTES NATIONALES : {sum(compte.values())} dates pour {pays_couverts} pays ou régions ; recoupées par les deux listes : "
                   f"{compte[2]}, par une seule : {compte[1]}, par aucune : {compte[0]}.")
    rapport.append("  non recoupées (savoir de Claude, non retrouvé dans les deux listes) : " + (", ".join(sans_recoupement) or "aucune"))
    conflits = []
    for nom_ref, ref in (("MFAT", mfat), ("Wikipédia", wiki)):
        for date, iso in sorted(ref, key=lambda x: (x[1], x[0])):
            if iso in table and date not in table[iso]:
                conflits.append(f"{iso} : {nom_ref} donne aussi {date} (table : {', '.join(sorted(table[iso]))})")
    rapport.append(f"  {len(conflits)} dates des listes tierces absentes de notre table (autre événement, date périmée ou désaccord) :")
    rapport.extend("    " + x for x in conflits)
    hors_table = sorted({iso for _, iso in mfat if iso not in table})
    rapport.append("  pays des listes tierces sans fête dans notre table : " + (", ".join(hors_table) or "aucun"))

    # usages
    for n, c in lignes("usages.txt"):
        c = c + [""] * (6 - len(c))
        date, portee, categorie, nom, fiab, note = c[:6]
        portees = [p.strip() for p in portee.split(",") if p.strip()]
        if (not nom or fiab not in {"officielle", "usuelle", "populaire"}
                or categorie not in {"pays", "religieuse", "usage", "commerciale"}
                or not portees or any(p not in {"monde", "FR", "CH", "BE"} for p in portees)):
            echec("usages.txt", n, f"ligne incorrecte : {c}")
            continue
        entree = {"nom": nom, "cat": categorie, "portee": portees, "fiab": fiab}
        if note:
            entree["note"] = note
        ajouter(valider_date("usages.txt", n, date), date, entree)

    sans_onu = [j for j in JOURS if not any(e["cat"] == "onu" for e in fixes.get(j, []))]
    rapport.append(f"JOURNÉES : {sum(1 for e in sum(fixes.values(), []) if e['cat'] == 'onu') + sum(1 for r in regles if r['cat'] == 'onu')} entrées ONU/agences, "
                   f"{len(regles)} règles de jours mobiles ; {366 - len(sans_onu)} jours sur 366 ont au moins une journée internationale.")
    return {"source": ("Journées ONU et agences (listes de l'ONU), fêtes nationales recoupées avec les listes du ministère néo-zélandais "
                       "des Affaires étrangères et de Wikipédia, usages de France, Suisse et Belgique, saisis dans outils/fetes/. "
                       "Fabriqué par outils/construire_fetes.py ; voir docs/SOURCES-FETES.md."),
            "fixes": {j: fixes[j] for j in JOURS if j in fixes},
            "regles": regles}


# ───────────────────────────────────── principal ─────────────────────────────────────

def serialiser(donnees: dict) -> str:
    return json.dumps(donnees, ensure_ascii=False, indent=1, sort_keys=False) + "\n"


def main(argv: list[str]) -> int:
    verifier, detail = "--verifier" in argv, "--rapport" in argv
    rapport: list[str] = []
    prenoms = construire_prenoms(rapport)
    journees = construire_journees(rapport)
    if erreurs:
        print("ERREURS :", *erreurs, sep="\n  ")
        return 1
    sorties = {"prenoms.json": serialiser(prenoms), "journees.json": serialiser(journees)}
    if verifier:
        perimes = [nom for nom, texte in sorties.items()
                   if not (RACINE / "donnees" / nom).exists() or (RACINE / "donnees" / nom).read_text(encoding="utf-8") != texte]
        if perimes:
            print("À régénérer (python3 outils/construire_fetes.py) :", ", ".join(perimes))
            return 1
        print("Données de fêtes à jour et cohérentes.")
        return 0
    for nom, texte in sorties.items():
        (RACINE / "donnees" / nom).write_text(texte, encoding="utf-8")
    print("\n".join(rapport if detail else [r for r in rapport if not r.startswith("    ")]))
    print("Écrit : donnees/prenoms.json, donnees/journees.json")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
