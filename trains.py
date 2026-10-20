"""Suivi d'un train précis en temps réel : retard, suppression, voie, correspondances.

Trois réseaux, chacun avec sa source officielle :
  - Suisse : transport.opendata.ch (données CFF), puis search.ch en secours (sans clé)
  - Belgique : iRail (données SNCB, sans clé)
  - France : API SNCF (clé gratuite, secret SNCF_API_KEY ; https://numerique.sncf.com/startup/api/)

Chaque source renvoie None quand elle ne reconnaît pas les gares ou le train :
la suivante est alors essayée. Les noms de gares renvoyés sont comparés à ceux
demandés, pour ne jamais annoncer le retard d'un autre train (transport.opendata.ch
confond par exemple « Bruxelles-Central » avec « Zürich, Central »).
"""

from __future__ import annotations

import datetime as dt
import difflib
import os
import re
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

from sources import Sources, cle, journal

FUSEAU = ZoneInfo("Europe/Zurich")      # même heure à Bruxelles et à Paris
URL_OPENDATA = "https://transport.opendata.ch/v1/connections"
URL_SEARCH_CH = "https://search.ch/timetable/api/route.json"
URL_IRAIL = "https://api.irail.be/connections/"
URL_SNCF = "https://api.sncf.com/v1/coverage/sncf"
ECART_MAX_MINUTES = 10                  # au-delà, ce n'est plus « le train de 7 h 31 »

MOTS_PAYS = [
    ("CH", r"\b(cff|sbb|ffs|bls|tpf|suisse)\b"),
    ("BE", r"\b(sncb|nmbs|irail|belgique|belge)\b"),
    ("FR", r"\b(sncf|ter|tgv|ouigo|intercites|transilien|rer|france)\b"),
]
NOMS_SOURCES = {"CH": "CFF", "BE": "SNCB", "FR": "SNCF"}


@dataclass
class Etape:
    """Un train du trajet (le premier, puis chaque correspondance)."""
    train: str
    de: str
    a: str
    depart: str                          # HH:MM prévu
    arrivee: str
    retard_depart: int | None = None     # minutes ; None = pas de donnée temps réel
    retard_arrivee: int | None = None
    supprime: bool = False
    voie: str = ""
    voie_changee: bool = False


@dataclass
class EtatTrain:
    source: str
    de: str
    a: str
    heure_demandee: str
    etapes: list[Etape] = field(default_factory=list)
    temps_reel: bool = False             # au moins une donnée temps réel reçue
    remarques: list[str] = field(default_factory=list)
    consulte_a: str = ""

    @property
    def premier(self) -> Etape:
        return self.etapes[0]

    @property
    def retard_arrivee(self) -> int | None:
        return self.etapes[-1].retard_arrivee


# ─────────────────────────────── utilitaires ────────────────────────────────

def heure_valide(texte: str) -> str:
    m = re.fullmatch(r"\s*(\d{1,2})\s*[h:.]\s*(\d{2})?\s*", str(texte or ""))
    if not m or int(m.group(1)) > 23 or int(m.group(2) or 0) > 59:
        return ""
    return f"{int(m.group(1)):02d}:{int(m.group(2) or 0):02d}"


def minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


# Noms français → noms renvoyés par les transporteurs (allemand, néerlandais).
ALIAS_GARES = {
    "bale": "basel", "soleure": "solothurn", "lucerne": "luzern", "coire": "chur", "berne": "bern",
    "bienne": "biel", "morat": "murten", "saint gall": "st gallen", "st gall": "st gallen",
    "schaffhouse": "schaffhausen", "thoune": "thun", "zoug": "zug", "brigue": "brig", "loeche": "leuk",
    "sierre": "siders", "anvers": "antwerpen", "gand": "gent", "louvain": "leuven", "malines": "mechelen",
    "bruges": "brugge", "courtrai": "kortrijk", "bruxelles": "brussel", "liege": "luik", "mons": "bergen",
    "genf": "geneve",
}


# Recherche de gare en Suisse : transport.opendata.ch prend « Bâle » pour Balerna.
NOMS_SUISSES = {
    "bale": "Basel", "soleure": "Solothurn", "lucerne": "Luzern", "coire": "Chur", "berne": "Bern",
    "bienne": "Biel/Bienne", "morat": "Murten", "saint gall": "St. Gallen", "st gall": "St. Gallen",
    "schaffhouse": "Schaffhausen", "thoune": "Thun", "zoug": "Zug", "brigue": "Brig", "loeche": "Leuk",
}


def nom_suisse(nom: str) -> str:
    """« Bâle » → « Basel », « Lucerne gare » → « Luzern gare » ; le reste inchangé."""
    mots = nom.split()
    for n in (2, 1):
        if len(mots) >= n and cle(" ".join(mots[:n])) in NOMS_SUISSES:
            return " ".join([NOMS_SUISSES[cle(" ".join(mots[:n]))]] + mots[n:])
    debut = re.match(r"^(saint|st)-(\w+)", nom, re.I)
    if debut and cle(f"{debut.group(1)} {debut.group(2)}") in NOMS_SUISSES:
        return NOMS_SUISSES[cle(f"{debut.group(1)} {debut.group(2)}")] + nom[debut.end():]
    return nom


def _alias(nom: str) -> str:
    n = cle(nom)
    for francais, local in ALIAS_GARES.items():
        n = re.sub(rf"^{francais}\b", local, n)
    return n


def meme_gare(demande: str, *trouves: str) -> bool:
    """« Berne » = « Bern », « Yverdon » = « Yverdon-les-Bains », mais pas
    « Bruxelles-Central » = « Zürich, Central »."""
    for a in {cle(demande), _alias(demande)}:
        if a and any(_meme_nom(a, b) for trouve in trouves for b in {cle(trouve), _alias(trouve)} if b):
            return True
    return False


def _meme_nom(a: str, b: str) -> bool:
    return bool(re.search(rf"\b{re.escape(a)}\b", b) or re.search(rf"\b{re.escape(b)}\b", a)
                or (min(len(a), len(b)) >= 7 and difflib.SequenceMatcher(None, a, b).ratio() >= 0.85))


def ecart(a: int | None, b: int | None) -> int | None:
    return None if a is None or b is None else a - b


def _heure_iso(texte: str | None) -> str:
    """'2026-10-20T07:31:00+0200' ou '2026-10-20 07:31:00' → '07:31'."""
    m = re.search(r"[T ](\d{2}:\d{2})", str(texte or ""))
    return m.group(1) if m else ""


def _minutes_iso(texte: str | None) -> int | None:
    h = _heure_iso(texte)
    return minutes(h) if h else None


def _retard_texte(valeur) -> int | None:
    """search.ch : '+3' → 3, '+0' → 0, '' → None."""
    m = re.fullmatch(r"\s*([+-]?\d+)\s*", str(valeur or ""))
    return int(m.group(1)) if m else None


def choisir_depart(candidats: list[tuple[str, object]], heure: str) -> tuple[str, object] | None:
    """Le départ prévu à l'heure demandée, sinon le plus proche (à 10 min près)."""
    valides = [(h, x) for h, x in candidats if h]
    if not valides:
        return None
    meilleur = min(valides, key=lambda c: abs(minutes(c[0]) - minutes(heure)))
    return meilleur if abs(minutes(meilleur[0]) - minutes(heure)) <= ECART_MAX_MINUTES else None


# ───────────────────────────────── Suisse ───────────────────────────────────

def suisse_opendata(sources: Sources, de: str, a: str, jour: dt.date, heure: str) -> EtatTrain | None:
    donnees = sources._json("GET", URL_OPENDATA, params={
        "from": nom_suisse(de), "to": nom_suisse(a), "date": jour.isoformat(), "time": heure, "limit": 4, "transportations[]": "train"})
    connexions = donnees.get("connections") or []
    if not connexions:
        return None
    depart_c, arrivee_c = connexions[0].get("from") or {}, connexions[0].get("to") or {}
    nom_de = (depart_c.get("station") or {}).get("name", "")
    nom_a = (arrivee_c.get("station") or {}).get("name", "")
    if not (meme_gare(de, nom_de) and meme_gare(a, nom_a)):
        journal(f"Train : CFF a compris « {nom_de} → {nom_a} » pour « {de} → {a} », ignoré.")
        return None
    choix = choisir_depart([(_heure_iso((c.get("from") or {}).get("departure")), c) for c in connexions], heure)
    if not choix:
        return None
    connexion = choix[1]
    etat = EtatTrain(NOMS_SOURCES["CH"], nom_de, nom_a, heure)
    for section in connexion.get("sections") or []:
        voyage = section.get("journey")
        if not voyage:
            continue                      # marche à pied entre deux quais
        dep, arr = section.get("departure") or {}, section.get("arrival") or {}
        prevu_dep, prevu_arr = _minutes_iso(dep.get("departure")), _minutes_iso(arr.get("arrival"))
        reel_dep = _minutes_iso((dep.get("prognosis") or {}).get("departure"))
        reel_arr = _minutes_iso((arr.get("prognosis") or {}).get("arrival"))
        retard_dep = dep.get("delay") if isinstance(dep.get("delay"), int) else ecart(reel_dep, prevu_dep)
        retard_arr = arr.get("delay") if isinstance(arr.get("delay"), int) else ecart(reel_arr, prevu_arr)
        voie_prevue = str(dep.get("platform") or "")
        voie_reelle = str((dep.get("prognosis") or {}).get("platform") or "")
        nom = " ".join(x for x in (voyage.get("category"), voyage.get("number")) if x)
        etat.etapes.append(Etape(
            train=nom or str(voyage.get("name") or "train"),
            de=(dep.get("station") or {}).get("name", ""), a=(arr.get("station") or {}).get("name", ""),
            depart=_heure_iso(dep.get("departure")), arrivee=_heure_iso(arr.get("arrival")),
            retard_depart=retard_dep, retard_arrivee=retard_arr,
            voie=voie_reelle or voie_prevue, voie_changee=bool(voie_reelle and voie_prevue and voie_reelle != voie_prevue)))
    if not etat.etapes:
        return None
    etat.temps_reel = any(e.retard_depart is not None or e.retard_arrivee is not None for e in etat.etapes)
    return etat


def suisse_search_ch(sources: Sources, de: str, a: str, jour: dt.date, heure: str) -> EtatTrain | None:
    donnees = sources._json("GET", URL_SEARCH_CH, params={
        "from": nom_suisse(de), "to": nom_suisse(a), "date": jour.strftime("%d.%m.%Y"), "time": heure, "num": 4,
        "show_delays": 1, "show_trackchanges": 1, "transportation_types": "train"})
    connexions = donnees.get("connections") or []
    if not connexions:
        return None
    if not (meme_gare(de, connexions[0].get("from", "")) and meme_gare(a, connexions[0].get("to", ""))):
        journal(f"Train : search.ch a compris « {connexions[0].get('from')} → {connexions[0].get('to')} », ignoré.")
        return None
    choix = choisir_depart([(_heure_iso(c.get("departure")), c) for c in connexions], heure)
    if not choix:
        return None
    connexion = choix[1]
    etat = EtatTrain(NOMS_SOURCES["CH"], connexion.get("from", de), connexion.get("to", a), heure)
    for etape in connexion.get("legs") or []:
        if not etape.get("line") or etape.get("type") in ("walk", "strain_walk"):
            continue
        sortie = etape.get("exit") or {}
        voie = str(etape.get("track") or "")
        etat.etapes.append(Etape(
            train=str(etape.get("line")), de=etape.get("name", ""), a=sortie.get("name", ""),
            depart=_heure_iso(etape.get("departure")), arrivee=_heure_iso(sortie.get("arrival")),
            retard_depart=_retard_texte(etape.get("dep_delay")), retard_arrivee=_retard_texte(sortie.get("arr_delay")),
            supprime=str(etape.get("dep_delay", "")).strip().upper() == "X" or bool(etape.get("cancelled")),
            voie=voie.rstrip("!"), voie_changee=voie.endswith("!")))
    if not etat.etapes:
        return None
    etat.temps_reel = any(e.retard_depart is not None or e.retard_arrivee is not None or e.supprime for e in etat.etapes)
    return etat


# ──────────────────────────────── Belgique ──────────────────────────────────

def _horaire_irail(horodatage) -> str:
    try:
        return dt.datetime.fromtimestamp(int(horodatage), FUSEAU).strftime("%H:%M")
    except (TypeError, ValueError):
        return ""


def _minutes_irail(secondes) -> int | None:
    try:
        return round(int(secondes) / 60)
    except (TypeError, ValueError):
        return None


def _noms_irail(bloc: dict) -> tuple[str, ...]:
    info = bloc.get("stationinfo") or {}
    return tuple(x for x in (bloc.get("station"), info.get("name"), info.get("standardname")) if x)


def belgique(sources: Sources, de: str, a: str, jour: dt.date, heure: str) -> EtatTrain | None:
    donnees = sources._json("GET", URL_IRAIL, params={
        "from": de, "to": a, "date": jour.strftime("%d%m%y"), "time": heure.replace(":", ""),
        "timesel": "departure", "format": "json", "lang": "fr", "typeOfTransport": "trains"})
    connexions = donnees.get("connection") or []
    if not connexions:
        return None
    d0, a0 = connexions[0].get("departure") or {}, connexions[0].get("arrival") or {}
    if not (meme_gare(de, *_noms_irail(d0)) and meme_gare(a, *_noms_irail(a0))):
        journal(f"Train : SNCB a compris « {d0.get('station')} → {a0.get('station')} », ignoré.")
        return None
    choix = choisir_depart([(_horaire_irail((c.get("departure") or {}).get("time")), c) for c in connexions], heure)
    if not choix:
        return None
    c = choix[1]
    dep, arr = c.get("departure") or {}, c.get("arrival") or {}
    vias = (c.get("vias") or {}).get("via") or []
    if isinstance(vias, dict):
        vias = [vias]
    # Points de passage : départ, chaque correspondance, arrivée.
    points = [("depart", dep)] + [("via", v) for v in vias] + [("arrivee", arr)]
    etat = EtatTrain(NOMS_SOURCES["BE"], dep.get("station", de), arr.get("station", a), heure, temps_reel=True)
    for (genre, debut), (_, fin) in zip(points, points[1:]):
        quitte = debut if genre == "depart" else (debut.get("departure") or {})
        atteint = fin if fin is arr else (fin.get("arrival") or {})
        vehicule = (quitte.get("vehicleinfo") or debut.get("vehicleinfo") or {})
        voie_info = quitte.get("platforminfo") or {}
        etat.etapes.append(Etape(
            train=vehicule.get("shortname") or str(quitte.get("vehicle") or "train").replace("BE.NMBS.", ""),
            de=debut.get("station", ""), a=fin.get("station", ""),
            depart=_horaire_irail(quitte.get("time")), arrivee=_horaire_irail(atteint.get("time")),
            retard_depart=_minutes_irail(quitte.get("delay")), retard_arrivee=_minutes_irail(atteint.get("delay")),
            supprime=str(quitte.get("canceled", "0")) == "1" or str(atteint.get("canceled", "0")) == "1",
            voie=str(quitte.get("platform") or "").replace("?", ""),
            voie_changee=str(voie_info.get("normal", "1")) == "0"))
    return etat if etat.etapes else None


# ───────────────────────────────── France ───────────────────────────────────

def _sncf(sources: Sources, cle_api: str, chemin: str, **params) -> dict:
    return sources._json("GET", f"{URL_SNCF}/{chemin}", params=params, auth=(cle_api, ""))


def _gare_sncf(sources: Sources, cle_api: str, nom: str) -> dict | None:
    def chercher() -> dict | None:
        lieux = _sncf(sources, cle_api, "places", q=nom, **{"type[]": "stop_area", "count": 3}).get("places") or []
        return next(({"id": p["id"], "nom": p.get("name", nom)} for p in lieux if p.get("id")), None)
    return sources._memo(f"sncf:gare:{cle(nom)}", chercher)


def _hhmm_navitia(texte: str | None) -> str:
    """'20261020T073100' → '07:31' ; '073100' → '07:31'."""
    m = re.search(r"(?:T|^)(\d{2})(\d{2})\d{2}$", str(texte or ""))
    return f"{m.group(1)}:{m.group(2)}" if m else ""


def france(sources: Sources, de: str, a: str, jour: dt.date, heure: str, cle_api: str) -> EtatTrain | None:
    if not cle_api:
        return None
    gare_de, gare_a = _gare_sncf(sources, cle_api, de), _gare_sncf(sources, cle_api, a)
    if not gare_de or not gare_a or not (meme_gare(de, gare_de["nom"]) and meme_gare(a, gare_a["nom"])):
        return None
    quand = f"{jour.strftime('%Y%m%d')}T{heure.replace(':', '')}00"
    base = _sncf(sources, cle_api, "journeys", **{"from": gare_de["id"], "to": gare_a["id"], "datetime": quand,
                                                  "datetime_represents": "departure", "count": 4,
                                                  "data_freshness": "base_schedule"})
    trajets = base.get("journeys") or []
    def premier_train(j: dict) -> dict:
        return next((s for s in j.get("sections") or [] if s.get("type") == "public_transport"), {})
    choix = choisir_depart([(_hhmm_navitia(premier_train(j).get("departure_date_time")), j) for j in trajets], heure)
    if not choix:
        return None
    trajet = choix[1]
    perturbations = {p.get("id"): p for p in base.get("disruptions") or []}
    etat = EtatTrain(NOMS_SOURCES["FR"], gare_de["nom"], gare_a["nom"], heure, temps_reel=True)
    for section in trajet.get("sections") or []:
        if section.get("type") != "public_transport":
            continue
        info = section.get("display_informations") or {}
        nom_de = (section.get("from") or {}).get("name", "")
        nom_a = (section.get("to") or {}).get("name", "")
        etape = Etape(
            train=" ".join(x for x in (info.get("commercial_mode"), info.get("headsign") or info.get("trip_short_name")) if x) or "train",
            de=nom_de, a=nom_a, depart=_hhmm_navitia(section.get("base_departure_date_time") or section.get("departure_date_time")),
            arrivee=_hhmm_navitia(section.get("base_arrival_date_time") or section.get("arrival_date_time")),
            retard_depart=0, retard_arrivee=0)
        for lien in info.get("links") or []:
            p = perturbations.get(lien.get("id"))
            if not p:
                continue
            effet = (p.get("severity") or {}).get("effect", "")
            if effet == "NO_SERVICE":
                etape.supprime = True
            message = next((m.get("text") for m in p.get("messages") or [] if m.get("text")), "")
            if message:
                etat.remarques.append(re.sub(r"<[^>]+>", " ", message)[:240])
            for objet in p.get("impacted_objects") or []:
                for arret in objet.get("impacted_stops") or []:
                    nom_arret = (arret.get("stop_point") or {}).get("name", "")
                    if meme_gare(nom_de, nom_arret):
                        if arret.get("departure_status") == "deleted":
                            etape.supprime = True
                        etape.retard_depart = ecart(_minutes_iso("T" + _hhmm_navitia(arret.get("amended_departure_time"))),
                                                    _minutes_iso("T" + _hhmm_navitia(arret.get("base_departure_time")))) or 0
                    if meme_gare(nom_a, nom_arret):
                        if arret.get("arrival_status") == "deleted":
                            etape.supprime = True
                        etape.retard_arrivee = ecart(_minutes_iso("T" + _hhmm_navitia(arret.get("amended_arrival_time"))),
                                                     _minutes_iso("T" + _hhmm_navitia(arret.get("base_arrival_time")))) or 0
        etat.etapes.append(etape)
    return etat if etat.etapes else None


# ─────────────────────────────── aiguillage ─────────────────────────────────

def pays_probables(indice: str, texte: str) -> list[str]:
    """Ordre d'essai des réseaux : l'indice du planificateur, puis les mots de la consigne."""
    ordre: list[str] = []
    if str(indice or "").upper() in NOMS_SOURCES:
        ordre.append(str(indice).upper())
    t = cle(texte)
    for pays, motif in MOTS_PAYS:
        if re.search(motif, t) and pays not in ordre:
            ordre.append(pays)
    return ordre + [p for p in ("CH", "BE", "FR") if p not in ordre]


def etat_train(sources: Sources, de: str, a: str, jour: dt.date, heure: str, pays: str = "", texte: str = "",
               maintenant: dt.datetime | None = None, cle_sncf: str | None = None) -> tuple[EtatTrain | None, list[str]]:
    """État du train de `heure` entre `de` et `a`. Renvoie aussi les problèmes rencontrés."""
    heure = heure_valide(heure)
    cle_sncf = os.environ.get("SNCF_API_KEY", "").strip() if cle_sncf is None else cle_sncf
    problemes: list[str] = []
    if not (de and a and heure):
        return None, ["trajet incomplet (gare de départ, gare d'arrivée et heure nécessaires)"]
    essais = {"CH": [("CFF", suisse_opendata), ("search.ch", suisse_search_ch)],
              "BE": [("SNCB", belgique)],
              "FR": [("SNCF", lambda s, *x: france(s, *x, cle_api=cle_sncf))]}
    sans_temps_reel: EtatTrain | None = None
    ordre = pays_probables(pays, f"{texte} {de} {a}")
    france_visee = ordre.index("FR") < 2 and (str(pays).upper() == "FR" or re.search(MOTS_PAYS[2][1], cle(texte)))
    for p in ordre:
        if p == "FR" and not cle_sncf:
            if france_visee:
                problemes.append("temps réel SNCF non configuré (clé SNCF manquante, à ajouter dans Réglages › Connexions)")
            continue
        for nom, fonction in essais[p]:
            try:
                etat = sources._memo(f"train:{nom}:{cle(de)}:{cle(a)}:{jour}:{heure}", fonction, sources, de, a, jour, heure)
            except Exception as erreur:   # une source en panne : on passe à la suivante
                statut = getattr(getattr(erreur, "response", None), "status_code", None)
                if statut in (400, 404):    # gare inconnue de ce réseau : pas une panne
                    continue
                problemes.append(f"{nom} indisponible ({type(erreur).__name__})")
                journal(f"Train : {nom} indisponible ({type(erreur).__name__} : {str(erreur)[:120]})")
                continue
            if etat is None:
                continue
            etat.consulte_a = (maintenant or dt.datetime.now(FUSEAU)).strftime("%H:%M")
            if etat.temps_reel:
                return etat, problemes
            sans_temps_reel = sans_temps_reel or etat
    if sans_temps_reel is None:
        problemes.append(f"aucun train trouvé à {heure} (à {ECART_MAX_MINUTES} min près) entre {de} et {a}")
    return sans_temps_reel, problemes


# ─────────────────────────────── en mots ────────────────────────────────────

def _h(hhmm: str) -> str:
    return hhmm.replace(":", " h ") if hhmm else "?"


def _retard_en_mots(minutes_retard: int | None, quoi: str) -> str:
    if minutes_retard is None:
        return f"{quoi} : pas de donnée temps réel"
    if minutes_retard <= 0:
        return f"{quoi} à l'heure" if minutes_retard == 0 else f"{quoi} avec {-minutes_retard} min d'avance"
    return f"{quoi} avec {minutes_retard} min de retard"


def en_mots(etat: EtatTrain | None, problemes: list[str], de: str, a: str, heure: str) -> str:
    """Section factuelle pour les animateurs : rien à interpréter, rien à inventer."""
    if etat is None:
        detail = " ; ".join(problemes) or "aucune donnée"
        return (f"Train de {_h(heure_valide(heure))} {de} → {a} : état NON VÉRIFIÉ ({detail}).\n"
                "Dis seulement que l'état de ce train n'a pas pu être vérifié ce matin et invite à consulter "
                "l'application du transporteur. N'annonce AUCUN retard ni aucune ponctualité.")
    lignes = [f"Train surveillé — données temps réel {etat.source} consultées à {_h(etat.consulte_a)} :" if etat.temps_reel
              else f"Train surveillé — horaire {etat.source} consulté à {_h(etat.consulte_a)}, SANS donnée temps réel :"]
    p = etat.premier
    if p.depart != etat.heure_demandee:
        lignes.append(f"(aucun départ exactement à {_h(etat.heure_demandee)} : train le plus proche, prévu à {_h(p.depart)})")
    for i, e in enumerate(etat.etapes):
        prefixe = "Train" if i == 0 else "Correspondance"
        morceaux = [f"{prefixe} {e.train} de {_h(e.depart)}, {e.de} → {e.a}"]
        if e.supprime:
            morceaux.append("SUPPRIMÉ")
        else:
            morceaux.append(_retard_en_mots(e.retard_depart, "départ"))
            if e.voie:
                morceaux.append(f"voie {e.voie}" + (" (CHANGEMENT DE VOIE)" if e.voie_changee else ""))
            morceaux.append(_retard_en_mots(e.retard_arrivee, f"arrivée prévue à {_h(e.arrivee)}"))
        lignes.append("- " + ", ".join(morceaux))
    # Correspondance menacée : le premier train arrive après le départ du suivant.
    for avant, apres in zip(etat.etapes, etat.etapes[1:]):
        if avant.arrivee and apres.depart and avant.retard_arrivee and apres.retard_depart is not None:
            marge = minutes(apres.depart) + apres.retard_depart - minutes(avant.arrivee) - avant.retard_arrivee
            if marge < 2:
                lignes.append(f"- ATTENTION : correspondance à {apres.de} menacée (marge de {marge} min).")
    lignes += [f"- Info transporteur : {r}" for r in etat.remarques[:2]]
    if not etat.temps_reel:
        lignes.append("Aucune donnée temps réel pour ce train : dis que l'horaire est celui prévu et qu'aucun "
                      "retard n'est signalé pour l'instant, sans garantir la ponctualité.")
    else:
        lignes.append("Annonce clairement l'état de ce train avec le nombre exact de minutes (ou « à l'heure ») ; "
                      "précise l'heure de départ réelle s'il y a du retard. N'invente rien d'autre.")
    return "\n".join(lignes)


# ─────────────────────────── trajet dans la consigne ─────────────────────────

_GARE = r"(?P<de>[^,;.]+?)\s+(?:vers|à|a|pour|jusqu'à|jusqu'a|->|→|-)\s+(?P<a>[^,;.]+?)"
MOTIFS_TRAJET = [
    # « depuis Yverdon vers Berne à 7h31 », « de Lausanne à Genève, 8h05 »
    re.compile(r"(?:\bdepuis|\bde|\bd'|\bdu train|\btrain)\s*" + _GARE + r"\s*,?\s*(?:à|a|de|du|départ|depart|train de)?\s*"
               r"(?P<h>\d{1,2})\s*[h:]\s*(?P<m>\d{2})?", re.IGNORECASE),
    # « le train de 7h31 de Yverdon à Berne »
    re.compile(r"(?P<h>\d{1,2})\s*[h:]\s*(?P<m>\d{2})?\s*,?\s*(?:depuis|de|d')\s*" + _GARE + r"\s*$", re.IGNORECASE),
]
MOTIF_SUIVI = re.compile(r"(retard|ponctualit|à l'heure|a l'heure|supprim|annul|\bcff\b|\bsbb\b|\bsncf\b|\bsncb\b|\btrain\b)", re.I)


def _sans_gare(nom: str) -> str:
    """« mon TER de Lyon Part-Dieu » → « Lyon Part-Dieu » ; « la gare d'Yverdon » → « Yverdon »."""
    precedent = None
    nom = nom.strip()
    while nom != precedent:
        precedent = nom
        nom = re.sub(r"^(?:(?:mon|ma|le|la|du|notre|un|une)\s+)?(?:train|ter|tgv|ic|ir|re|rer|intercit\w*|ouigo|gare)?\s*"
                     r"(?:de|d'|depuis)\s*(?=\S)", "", nom, flags=re.I).strip()
        nom = re.sub(r"^(?:(?:mon|ma|le|la|du)\s+)?(?:train|ter|tgv|ic|ir|rer|gare)\s+", "", nom, flags=re.I).strip()
    return nom


def trajet_depuis_texte(texte: str) -> dict | None:
    """« Retard depuis Yverdon vers Berne à 7h31 » → {de: Yverdon, a: Berne, heure: 07:31}."""
    for motif in MOTIFS_TRAJET:
        for ligne in re.split(r"[\n.;]", str(texte or "")):
            m = motif.search(ligne.strip())
            if not m:
                continue
            heure = heure_valide(f"{m.group('h')}:{m.group('m') or '00'}")
            de, a = _sans_gare(m.group("de")), _sans_gare(m.group("a"))
            if heure and de and a:
                return {"de": de[:60], "a": a[:60], "heure": heure}
    return None


def est_suivi_de_train(regle: dict) -> bool:
    texte = f"{regle.get('titre', '')} {regle.get('consigne', '')}"
    return bool(MOTIF_SUIVI.search(texte))
