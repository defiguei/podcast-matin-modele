"""Moteur de règles : quelles règles s'appliquent aujourd'hui, quelles
informations aller chercher pour chacune, et comment les présenter à Gemini.

Une règle vient du bot (Cloudflare). Elle a une consigne, une période, parfois
une condition d'agenda (« la veille d'un match »), une rubrique placée dans le
déroulé, et pour les sorties une fiche de recherche (quoi, avec qui, où, quand,
transport, budget…) avec ses sources.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from typing import Any, Callable

import trains
import pays
from fetes import prenoms_en_texte
from sources import CATEGORIES_OSM, Sources, cle, distance_km, feries, journal, lien_itineraire

JOURS_CODES = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
        "septembre", "octobre", "novembre", "décembre"]
RUBRIQUES = {
    "ouverture": "Ouverture", "agenda": "Agenda", "deplacements": "Mes déplacements",
    "actu_locale": "Actu locale", "approfondissements": "À creuser", "actualites": "Actualités globales", "cloture": "Clôture",
}
LONGUEURS = {"phrase": "une seule phrase", "courte": "courte (2 à 4 répliques)",
             "developpee": "développée (6 à 10 répliques)"}
TRANSPORTS = {"voiture": "en voiture", "train": "en train ou transports publics", "velo": "à vélo",
              "pied": "à pied", "peu_importe": "transport indifférent",
              "aucun": "sans déplacement (sur place, à la maison ou dans le quartier)"}

MOTS_CATEGORIES = [
    (r"mus[ée]e|expo", ["musee", "galerie"]),
    (r"ch[âa]teau|patrimoine|histoire|vieille ville|visite", ["chateau", "musee", "attraction"]),
    (r"rando|randonn|marche|balade|promenade|sommet|montagne", ["point_de_vue", "sommet", "cascade"]),
    (r"enfant|famille|kids|gamin", ["aire_de_jeux", "zoo", "parc_attractions", "musee", "ferme"]),
    (r"piscine|baignade|nager|lac|plage", ["piscine", "plage"]),
    (r"therm|bains|spa|d[ée]tente|wellness", ["bains_thermaux"]),
    (r"th[ée][âa]tre|spectacle|concert|op[ée]ra|culture", ["theatre", "musee", "galerie"]),
    (r"cin[ée]ma|film", ["cinema"]),
    (r"resto|restaurant|manger|gastronom|d[îi]ner|d[ée]jeuner", ["restaurant"]),
    (r"caf[ée]|brunch", ["cafe"]),
    (r"grotte", ["grotte"]),
    (r"cascade", ["cascade"]),
    (r"patin", ["patinoire"]),
    (r"escalade|grimpe", ["escalade"]),
    (r"bowling", ["bowling"]),
    (r"escape", ["escape_game"]),
    (r"nature|parc|jardin", ["parc", "point_de_vue"]),
    (r"zoo|animaux|ferme", ["zoo", "ferme"]),
]


def date_longue(jour: dt.date) -> str:
    return f"{JOURS[jour.weekday()]} {jour.day}{'er' if jour.day == 1 else ''} {MOIS[jour.month - 1]} {jour.year}"


def date_iso(valeur: Any) -> dt.date | None:
    try:
        return dt.date.fromisoformat(str(valeur)[:10])
    except ValueError:
        return None


# ────────────────────────────── sélection ───────────────────────────────────

def etat_regle(regle: dict, jour: dt.date) -> str:
    if regle.get("etat") == "pause":
        return "pause"
    p = regle.get("periode") or {}
    if p.get("type") == "ponctuelle":
        return "ponctuelle"
    if p.get("type") == "une_fois":
        return "terminee" if regle.get("servie") else "active"
    fin, debut = date_iso(p.get("fin")), date_iso(p.get("debut"))
    if fin and jour > fin:
        return "terminee"
    if debut and jour < debut:
        return "a_venir"
    return "active"


def est_recherche(regle: dict) -> bool:
    r = regle.get("recherche") or {}
    f = r.get("fiche") or {}
    return bool(f.get("quoi") or f.get("ou") or any(s in ("web", "lieux", "wikivoyage", "transports")
                                                      for s in r.get("sources") or []))


def selectionner(config: dict, jour: dt.date, forcees: list[str] | None = None) -> tuple[list[dict], list[dict]]:
    """Règles programmées aujourd'hui, et règles soumises à une condition d'agenda.
    Les règles « forcées » (épisode à la demande sur une règle) passent toujours."""
    forcees = [f.upper() for f in forcees or []]
    programmees, conditionnelles = [], []
    for regle in config.get("regles") or []:
        if regle.get("id") in forcees:
            programmees.append({**regle, "_forcee": True})
            continue
        if etat_regle(regle, jour) != "active":
            continue
        periode = regle.get("periode") or {}
        if periode.get("type") == "jours" and JOURS_CODES[jour.weekday()] not in (periode.get("jours") or []):
            continue
        (conditionnelles if regle.get("condition") else programmees).append(regle)
    return programmees, conditionnelles


# ─────────────────────────── planification (Lite) ───────────────────────────

def schema_plan() -> dict:
    return {"type": "object", "properties": {"regles": {"type": "array", "items": {"type": "object", "properties": {
        "id": {"type": "string"}, "applique": {"type": "boolean"}, "evenement": {"type": "string"},
        "date_cible": {"type": "string"},
        "requetes": {"type": "array", "items": {"type": "string"}},
        "lieux": {"type": "array", "items": {"type": "string"}},
        "categories": {"type": "array", "items": {"type": "string", "enum": list(CATEGORIES_OSM)}},
        "rayon_km": {"type": "number"},
        "train": {"type": "object", "properties": {
            "de": {"type": "string"}, "a": {"type": "string"}, "heure": {"type": "string"},
            "pays": {"type": "string", "enum": ["CH", "FR", "BE", ""]}}},
    }, "required": ["id", "applique"]}}}, "required": ["regles"]}


def consigne_plan(jour: dt.date, ville: str) -> str:
    profil = pays.profil()
    return f"""Tu prépares les règles du podcast du matin d'un auditeur qui vit {profil['ou']} (ville : {ville or "inconnue"}). Aujourd'hui : {date_longue(jour)}.
Pour chaque règle fournie, renvoie :
- applique : pour une règle AVEC condition d'agenda, true seulement si un événement de l'agenda fourni remplit la condition au bon moment : « jour_meme » = l'événement a lieu aujourd'hui ; « veille » = il a lieu demain ; « jours_avant N » = il a lieu dans 1 à N jours. Pour une règle sans condition : true.
- evenement : l'événement concerné (titre et date), s'il y en a un.
- date_cible : la date visée (AAAA-MM-JJ) : date de la sortie ou de l'événement ; vide si aucune.
- pour une règle de recherche (sortie, activité, idée) : requetes = 2 ou 3 recherches web courtes et efficaces en français, avec le lieu et la période (ex. « activités enfants {profil['exemple_ville']} vacances octobre 2026 », « {profil['exemple_rando']} ») ; lieux = villes ou lieux précis à situer sur une carte, le plus important d'abord (pour « entre X et Y », donne X et Y) ; categories = types de lieux utiles ; rayon_km = rayon de recherche autour du lieu (3 à 30).
- pour une règle qui surveille un train précis (retard, ponctualité, suppression d'un train à une heure donnée) : train = gare de départ (de), gare d'arrivée (a), heure de départ prévue (heure, HH:MM) et pays du réseau (pays : CH, FR ou BE). Laisse train vide pour toute autre règle.
N'invente aucun événement : appuie-toi seulement sur l'agenda fourni."""


def decrire_pour_plan(regle: dict) -> str:
    morceaux = [f"{regle['id']} — {regle.get('consigne') or regle.get('titre', '')}"]
    c = regle.get("condition")
    if c:
        moment = {"jour_meme": "le jour même", "veille": "la veille", "jours_avant": f"jours_avant {c.get('n', 1)}"}.get(c.get("moment"), "le jour même")
        morceaux.append(f"condition : « {c.get('texte', '')} » ({moment})")
    f = (regle.get("recherche") or {}).get("fiche") or {}
    details = [f"{k}={f[k]}" for k in ("quoi", "avec_qui", "ages", "ou", "quand", "transport") if f.get(k)]
    if details:
        morceaux.append("recherche : " + ", ".join(details))
    if (regle.get("recherche") or {}).get("requetes"):
        morceaux.append("recherches proposées : " + " ; ".join(regle["recherche"]["requetes"]))
    return " | ".join(morceaux)


def categories_depuis_texte(texte: str) -> list[str]:
    trouvees: list[str] = []
    for motif, categories in MOTS_CATEGORIES:
        if re.search(motif, texte, re.IGNORECASE):
            trouvees += [c for c in categories if c not in trouvees]
    return trouvees[:5] or ["attraction", "musee", "point_de_vue"]


def nettoyer_lieu(texte: str) -> str:
    t = re.sub(r"^(autour|près|pres|vers|du côté|dans la région|dans le|dans la|dans les|à|a|au|aux|en)\s+(de |d'|du |des )?",
               "", str(texte or "").strip(), flags=re.IGNORECASE)
    return t.strip(" ,.")


def plan_par_defaut(regle: dict, ville: str) -> dict:
    f = (regle.get("recherche") or {}).get("fiche") or {}
    lieux = [nettoyer_lieu(x) for x in re.split(r"\s+et\s+|\s*,\s*", re.sub(r"^entre\s+", "", f.get("ou") or "", flags=re.I)) if x.strip()]
    lieux_fiche = list(lieux)
    if not lieux and ville:
        lieux = [ville]
    requetes = list((regle.get("recherche") or {}).get("requetes") or [])
    if not requetes and (f.get("quoi") or lieux_fiche):
        requetes = [" ".join(x for x in (f.get("quoi", ""), lieux_fiche[0] if lieux_fiche else "") if x)]
    return {"applique": not regle.get("condition"), "evenement": "", "date_cible": "", "requetes": requetes[:3],
            "lieux": lieux[:2], "categories": categories_depuis_texte(f"{f.get('quoi', '')} {regle.get('consigne', '')}"),
            "rayon_km": f.get("rayon_km") or 12, "train": trajet_de_la_regle(regle)}


def trajet_de_la_regle(regle: dict) -> dict | None:
    """Train précis à surveiller, lu dans la consigne (« depuis Yverdon vers Berne à 7h31 »)."""
    if not trains.est_suivi_de_train(regle):
        return None
    return trains.trajet_depuis_texte(regle.get("consigne") or "") or trains.trajet_depuis_texte(regle.get("titre") or "")


def planifier(regles: list[dict], agenda: list[str], jour: dt.date, ville: str,
              demander: Callable[[str, str, dict], dict] | None) -> dict[str, dict]:
    """Un seul appel au modèle léger pour toutes les règles qui en ont besoin :
    conditions d'agenda à vérifier, requêtes et lieux des recherches."""
    plans = {r["id"]: plan_par_defaut(r, ville) for r in regles}
    a_demander = [r for r in regles if r.get("condition") or est_recherche(r)]
    if not a_demander or demander is None:
        return plans
    entree = ("RÈGLES :\n" + "\n".join(f"- {decrire_pour_plan(r)}" for r in a_demander)
              + "\n\nAGENDA (31 prochains jours) :\n" + ("\n".join(agenda) or "(vide)"))
    try:
        reponse = demander(consigne_plan(jour, ville), entree, schema_plan())
    except Exception as erreur:   # sans le planificateur : valeurs par défaut, conditions ignorées
        print(f"Planification des règles impossible : {erreur}", flush=True)
        return plans
    for element in reponse.get("regles") or []:
        identifiant = {i.upper(): i for i in plans}.get(str(element.get("id", "")).upper(), "")
        if identifiant not in plans:
            continue
        plan = plans[identifiant]
        plan["applique"] = bool(element.get("applique"))
        plan["evenement"] = str(element.get("evenement") or "")[:160]
        if date_iso(element.get("date_cible")):
            plan["date_cible"] = str(element["date_cible"])[:10]
        requetes = [str(q).strip()[:120] for q in element.get("requetes") or [] if str(q).strip()]
        if requetes:
            plan["requetes"] = requetes[:3]
        lieux = [nettoyer_lieu(x)[:80] for x in element.get("lieux") or [] if str(x).strip()]
        if lieux:
            plan["lieux"] = lieux[:2]
        categories = [c for c in element.get("categories") or [] if c in CATEGORIES_OSM]
        if categories:
            plan["categories"] = categories[:5]
        if isinstance(element.get("rayon_km"), (int, float)) and 1 <= element["rayon_km"] <= 40:
            plan["rayon_km"] = element["rayon_km"]
        # Train : la consigne lue mot à mot prime ; le modèle complète (pays, tournures libres).
        propose = element.get("train") or {}
        if isinstance(propose, dict):
            reseau = str(propose.get("pays") or "").upper()
            reseau = reseau if reseau in ("CH", "FR", "BE") else ""
            if plan.get("train"):
                plan["train"] = {**plan["train"], "pays": reseau}
            elif propose.get("de") and propose.get("a") and trains.heure_valide(propose.get("heure", "")):
                plan["train"] = {"de": str(propose["de"]).strip()[:60], "a": str(propose["a"]).strip()[:60],
                                 "heure": trains.heure_valide(propose["heure"]), "pays": reseau}
    # Une règle sans condition s'applique toujours, même si le modèle hésite.
    for r in regles:
        if not r.get("condition"):
            plans[r["id"]]["applique"] = True
    return plans


# ───────────────────────────── collecte ─────────────────────────────────────

@dataclass
class Collecte:
    regle: dict
    plan: dict
    texte: str = ""
    lieux: list[dict] = field(default_factory=list)
    liens: list[tuple[str, str]] = field(default_factory=list)
    images: list[str] = field(default_factory=list)
    meteo: dict | None = None
    trajets: list[dict] = field(default_factory=list)
    point: dict | None = None
    date_cible: dt.date | None = None
    itineraire: str = ""
    web: list[dict] = field(default_factory=list)
    train: Any = None


def budget_en_mots(fiche: dict) -> str:
    b = fiche.get("budget") or {}
    if b.get("max") is None:
        return ""
    if b["max"] == 0:
        return "gratuit uniquement"
    unite = "pour tout le groupe" if b.get("unite") == "total" else "par personne"
    devise = str(b.get("devise") or "CHF")[:4]
    if fiche.get("transport") == "aucun":
        return f"{str(b['max']).replace('.', ',')} {devise} maximum {unite}"
    transport = "transport compris" if b.get("transport_inclus") else "transport non compris"
    return f"{str(b['max']).replace('.', ',')} {devise} maximum {unite}, {transport}"


def fiche_en_mots(fiche: dict) -> str:
    morceaux = []
    for cle_fiche, libelle in (("quoi", "quoi"), ("avec_qui", "avec qui"), ("ages", "âges"), ("ou", "où"), ("quand", "quand")):
        if fiche.get(cle_fiche):
            morceaux.append(f"{libelle} : {fiche[cle_fiche]}")
    if fiche.get("transport"):
        morceaux.append(f"transport : {TRANSPORTS.get(fiche['transport'], fiche['transport'])}")
    if budget_en_mots(fiche):
        morceaux.append(f"budget : {budget_en_mots(fiche)}")
    if fiche.get("inclure"):
        morceaux.append("à inclure : " + ", ".join(fiche["inclure"]))
    if fiche.get("exclure"):
        morceaux.append("à exclure : " + ", ".join(fiche["exclure"]))
    if fiche.get("attendu"):
        morceaux.append(f"attendu : {fiche['attendu']}")
    return " ; ".join(morceaux)


def sources_lues(regle: dict, config: dict | None = None) -> set[str]:
    """Les sources cochées dans la fiche de la rubrique, sans celles retirées dans Réglages ›
    Sources (catégories coupées, flux spécialisés supprimés). Rien d'autre n'est lu."""
    reglages = (config or {}).get("sources") or {}
    coupees = set(reglages.get("coupees") or [])
    flux = {f"flux:{f.get('id')}" for f in reglages.get("flux") or [] if isinstance(f, dict)}
    cochees = set(((regle.get("recherche") or {}).get("sources")) or [])
    return {s for s in cochees if (s in flux if s.startswith("flux:") else s not in coupees)}


def collecter(regle: dict, plan: dict, sources: Sources, jour: dt.date, ville: str,
              chercher_actus: Callable[[str], list[str]] | None = None, profondeur: int = 1,
              config: dict | None = None, lire_flux: Callable[[dict], list[str]] | None = None,
              agenda: list[str] | None = None) -> Collecte:
    """Va chercher les informations dont la règle a besoin et prépare sa section.
    Seules les sources cochées dans sa fiche sont lues (sources_lues)."""
    r = regle
    recherche = r.get("recherche") or {}
    fiche = recherche.get("fiche") or {}
    noms_sources = sources_lues(r, config)
    collecte = Collecte(regle=r, plan=plan)
    collecte.date_cible = date_iso(plan.get("date_cible")) or jour
    lignes = [f"RÈGLE {r['id']} — « {(r.get('rubrique') or {}).get('titre') or r.get('titre', '')} »",
              f"Consigne : {r.get('consigne', '')}"]
    if plan.get("evenement"):
        lignes.append(f"Événement de l'agenda concerné : {plan['evenement']}")
    if fiche_en_mots(fiche):
        lignes.append(f"Fiche : {fiche_en_mots(fiche)}")
    if collecte.date_cible != jour:
        ecart = (collecte.date_cible - jour).days
        lignes.append(f"Date visée : {date_longue(collecte.date_cible)} (dans {ecart} jour{'s' if abs(ecart) > 1 else ''})")

    if "saints" in noms_sources:
        lignes.extend(prenoms_en_texte(jour) or ["Prénoms et saints du jour : aucun trouvé"])
    if "fetes" in noms_sources:
        fetes = sources.fetes(jour)
        lignes.append(f"Fêtes nationales, journées internationales et usages du {date_longue(jour)} (données de référence du podcast) :")
        lignes.extend(f"  - {f}" for f in fetes or ["aucune trouvée"])
        collecte.liens.append((f"Wikipédia : {jour.day} {MOIS[jour.month - 1]}",
                               f"https://fr.wikipedia.org/wiki/{jour.day}_{MOIS[jour.month - 1]}"))
    if "feries" in noms_sources:
        feries_proches = feries(jour, 14)
        lignes.append("Jours fériés des deux prochaines semaines : "
                      + ("; ".join(f"{date_longue(d)} : {nom}" for d, nom in feries_proches) if feries_proches else "aucun"))

    # Lieu principal (ou milieu de deux lieux).
    geographique = bool(fiche.get("ou") or fiche.get("quoi") or fiche.get("lat") is not None
                        or noms_sources & {"lieux", "wikivoyage", "transports"})
    lieux_plan = (plan.get("lieux") or []) if geographique else []
    points = [p for p in (sources.geocoder(n) for n in lieux_plan[:2]) if p]
    if not points and fiche.get("lat") is not None and fiche.get("lon") is not None:
        points = [{"nom": fiche.get("ou") or "position partagée", "lat": fiche["lat"], "lon": fiche["lon"], "pays": "", "region": ""}]
    rayon = float(plan.get("rayon_km") or 12)
    if len(points) == 2:
        ecart_km = distance_km((points[0]["lat"], points[0]["lon"]), (points[1]["lat"], points[1]["lon"]))
        collecte.point = {"nom": f"entre {points[0]['nom']} et {points[1]['nom']}",
                          "lat": (points[0]["lat"] + points[1]["lat"]) / 2, "lon": (points[0]["lon"] + points[1]["lon"]) / 2}
        rayon = max(rayon, ecart_km / 2 + 4)
    elif points:
        collecte.point = points[0]

    besoin_meteo = "meteo" in noms_sources
    if besoin_meteo and collecte.point:
        collecte.meteo = sources.meteo(collecte.point["lat"], collecte.point["lon"], collecte.date_cible)
        if collecte.meteo:
            lignes.append(f"Météo prévue ({collecte.point['nom']}, {date_longue(collecte.date_cible)}) : {Sources.meteo_en_mots(collecte.meteo)}")
        elif (collecte.date_cible - jour).days > 15:
            lignes.append("Météo : trop tôt pour une prévision fiable.")
    elif besoin_meteo and ville:
        point_ville = sources.geocoder(ville)
        if point_ville:
            collecte.meteo = sources.meteo(point_ville["lat"], point_ville["lon"], collecte.date_cible)
            if collecte.meteo:
                lignes.append(f"Météo prévue ({point_ville['nom']}) : {Sources.meteo_en_mots(collecte.meteo)}")

    # Train précis : état en temps réel (retard, suppression, voie, correspondances).
    suivi = plan.get("train") if "transports" in noms_sources else None
    if suivi:
        etat, problemes = trains.etat_train(sources, suivi["de"], suivi["a"], jour, suivi["heure"],
                                            suivi.get("pays", ""), f"{r.get('titre', '')} {r.get('consigne', '')}")
        lignes.append(trains.en_mots(etat, problemes, suivi["de"], suivi["a"], suivi["heure"]))
        collecte.train = etat
        if etat:
            p = etat.premier
            journal(f"Train {r['id']} : {p.train} de {p.depart} {etat.de} → {etat.a} ({etat.source}) : "
                    + ("supprimé" if p.supprime else f"départ {p.retard_depart if p.retard_depart is not None else '?'} min, "
                       f"arrivée {etat.retard_arrivee if etat.retard_arrivee is not None else '?'} min"))
        else:
            journal(f"Train {r['id']} : état non vérifié ({'; '.join(problemes)}).")

    # Destination : le premier lieu qui n'est pas la ville de l'auditeur (« entre Yverdon et Vallorbe »).
    destination = next((pt["nom"] for pt in points if cle(pt["nom"]) != cle(ville)), points[0]["nom"] if points else "")
    point_destination = next((pt for pt in points if pt["nom"] == destination), None)
    transport = fiche.get("transport", "")
    if destination and ville and cle(destination) != cle(ville) and transport != "aucun" and not suivi:
        collecte.itineraire = lien_itineraire(ville, destination, transport)
        if "transports" in noms_sources and transport != "voiture":
            collecte.trajets = sources.trajets(ville, destination, collecte.date_cible, "09:00")
            if collecte.trajets:
                lignes.append(f"Train (horaires, prix non fournis) : {Sources.trajets_en_mots(collecte.trajets)}")
        if transport == "voiture":
            point_ville = sources.geocoder(ville)
            if point_ville and point_destination:
                km = distance_km((point_ville["lat"], point_ville["lon"]), (point_destination["lat"], point_destination["lon"]))
                lignes.append(f"Distance à vol d'oiseau depuis {ville} : environ {round(km)} km")

    if "lieux" in noms_sources and collecte.point:
        categories = plan.get("categories") or ["attraction"]
        # « Entre X et Y » : autour de chaque lieu et du milieu, pour ne rien manquer aux deux bouts.
        centres = [(collecte.point, rayon)] + ([(pt, 8) for pt in points] if len(points) == 2 else [])
        vus: set[str] = set()
        for centre, rayon_centre in centres:
            for lieu in sources.lieux(centre["lat"], centre["lon"], categories, rayon_centre, maximum=8 * profondeur):
                if cle(lieu["nom"]) not in vus:
                    vus.add(cle(lieu["nom"]))
                    collecte.lieux.append(lieu)
        collecte.lieux = collecte.lieux[: 10 * profondeur]
        if collecte.lieux:
            lignes.append(f"Lieux à proximité de {collecte.point['nom']} (Wikipédia et OpenStreetMap) :")
            for lieu in collecte.lieux:
                details = [lieu["type"], f"à {str(lieu['distance']).replace('.', ',')} km"]
                if lieu["horaires"]:
                    details.append(f"horaires : {lieu['horaires']}")
                if lieu["accessible"] == "yes":
                    details.append("accessible en fauteuil")
                lignes.append(f"  - {lieu['nom']} ({', '.join(d for d in details if d)})")

    if "wikivoyage" in noms_sources and points:
        guide = sources.wikivoyage(destination or points[0]["nom"])
        if guide:
            lignes.append(f"Wikivoyage — {guide['titre']} : {guide['extrait'][:900]}")
            collecte.liens.append((f"Wikivoyage : {guide['titre']}", guide["url"]))
            if guide["image"]:
                collecte.images.append(guide["image"])

    if "web" in noms_sources:
        requetes = plan.get("requetes") or [
            " ".join(x for x in (r.get("consigne") or r.get("titre", ""), date_longue(jour)) if x)]
        for numero, requete in enumerate(requetes[: 1 + profondeur]):
            trouve = sources.web(requete, maximum=5 if profondeur == 1 else 7, images=profondeur > 1)
            collecte.images += trouve["images"][:4]
            for resultat in trouve["resultats"]:
                if any(resultat["url"] == w["url"] for w in collecte.web):
                    continue
                collecte.web.append(resultat)
        if collecte.web:
            lignes.append("Recherche web :")
            for i, resultat in enumerate(collecte.web[: 6 * profondeur], 1):
                lignes.append(f"  [W{i}] {resultat['titre']} — {resultat['contenu'][:400]} ({resultat['url']})")
                collecte.liens.append((resultat["titre"], resultat["url"]))
        elif not sources.tavily_cle:
            lignes.append("Recherche web : non configurée (clé Tavily manquante, à ajouter dans Réglages › Connexions).")

    if "actus" in noms_sources and chercher_actus:
        requetes_plan = plan.get("requetes") or []
        if requetes_plan:
            sujet = requetes_plan[0]
        elif geographique:
            sujet = " ".join(x for x in (fiche.get("quoi", ""), destination or ville) if x) or r.get("titre", "")
        else:
            sujet = fiche.get("quoi") or r.get("consigne") or r.get("titre", "")
        actus = chercher_actus(sujet)
        if actus:
            lignes.append("Actualités liées :")
            lignes += [f"  - {a}" for a in actus[:5]]

    # Flux spécialisés choisis dans la fiche (Réglages › Sources).
    for flux in ((config or {}).get("sources") or {}).get("flux") or []:
        if f"flux:{flux.get('id')}" in noms_sources and lire_flux:
            articles = lire_flux(flux)
            lignes.append(f"Flux « {flux.get('nom', '?')} » : " + ("" if articles else "rien de récent"))
            lignes += [f"  - {a}" for a in articles[:6]]

    if "agenda" in noms_sources and agenda is not None:
        lignes.append("Agenda des prochains jours : " + ("" if agenda else "rien de prévu"))
        lignes += [f"  - {e}" for e in agenda[:15]]

    lignes.append("N'utilise que ces informations pour les faits (lieux, prix, horaires, dates) ; "
                  "si une information manque, dis-le ou reste général.")
    collecte.texte = "\n".join(lignes)
    return collecte


def agenda_pour_plan(evenements: list, quand_court: Callable[[Any], str]) -> list[str]:
    return [f"- {quand_court(e)} : {e.titre}" + (f" — lieu : {e.lieu}" if getattr(e, "lieu", "") else "")
            for e in evenements[:40]]


def deroule_du_jour(config: dict, collectes: dict[str, Collecte], actifs: dict[str, bool]) -> list[tuple[str, str]]:
    """Rubriques du jour dans l'ordre choisi par l'auditeur : (clé, titre).
    actifs indique, pour les rubriques fixes, si elles ont du contenu aujourd'hui."""
    rubriques = []
    deroule = config.get("deroule") or [{"cle": c, "actif": True} for c in RUBRIQUES]
    connues = {element.get("cle") for element in deroule}
    for element in deroule:
        cle_rubrique = element.get("cle")
        if not element.get("actif", True):
            continue
        if cle_rubrique in RUBRIQUES:
            if actifs.get(cle_rubrique, True):
                rubriques.append((cle_rubrique, RUBRIQUES[cle_rubrique]))
        elif cle_rubrique in collectes and (collectes[cle_rubrique].regle.get("rubrique")):
            rubriques.append((cle_rubrique, collectes[cle_rubrique].regle["rubrique"].get("titre") or cle_rubrique))
    # Une règle à rubrique absente du déroulé (ancienne configuration) passe après l'agenda.
    for identifiant, collecte in collectes.items():
        if collecte.regle.get("rubrique") and identifiant not in connues:
            position = next((i + 1 for i, (c, _) in enumerate(rubriques) if c == "agenda"), 1)
            rubriques.insert(position, (identifiant, collecte.regle["rubrique"].get("titre") or identifiant))
    return rubriques
