"""Tests hors ligne de la version 3 : réglages venus du bot, règles, sources,
chapitres, boutons, recherche, extraits de voix, filet de sécurité.
Toutes les requêtes réseau sont simulées."""
import base64
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

PROJET = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJET))
import horaire  # noqa: E402
import liaison  # noqa: E402
import podcast  # noqa: E402
import recherche  # noqa: E402
import regles as moteur  # noqa: E402
import sources  # noqa: E402
from pochette import creer_pochette  # noqa: E402

ZH = ZoneInfo("Europe/Zurich")


def _exception_annotee(type_, valeur, trace):
    import traceback
    texte = "".join(traceback.format_exception(type_, valeur, trace))
    if os.environ.get("GITHUB_ACTIONS"):
        print("::error title=Exception::" + texte[-3000:].replace("\n", "%0A"), flush=True)
    sys.__excepthook__(type_, valeur, trace)


sys.excepthook = _exception_annotee
echecs = []


def verifier(condition, message):
    print(("  ok  " if condition else "  ÉCHEC ") + message)
    if not condition:
        echecs.append(message)
        if os.environ.get("GITHUB_ACTIONS"):
            print(f"::error title=Test raté::{message[:900]}", flush=True)


RACINE_TEST = Path(tempfile.mkdtemp(prefix="podcast-v3-"))
shutil.copy(PROJET / "reglages.toml", RACINE_TEST / "reglages.toml")
(RACINE_TEST / "donnees").mkdir()
shutil.copy(PROJET / "donnees" / "saints.json", RACINE_TEST / "donnees" / "saints.json")
podcast.RACINE = RACINE_TEST
MEMOIRE = RACINE_TEST / "memoire.json"

# ───────────────────────── configuration type du bot ─────────────────────────


def config_bot():
    return {
        "version": 1,
        "planning": {"jours": {"lun": "06:45", "mar": "06:45", "mer": "06:45", "jeu": "06:45", "ven": "06:45",
                               "sam": "09:00", "dim": None},
                     "exceptions": [{"date": "2026-10-16", "heure": "05:30"}],
                     "pauses": [{"du": "2026-12-20", "au": "2026-12-27"}], "feries": "dimanche",
                     "rattrapage": True, "avance_minutes": 5},
        "format": {"duree_minutes": 4, "nombre_sujets": 3, "ton": "humour"},
        "voix": {"vitesse": "rapide", "tutoiement": False, "prenom": "Daniel",
                 "animateurs": [{"nom": "Léa", "voix": "Kore"}, {"nom": "Hugo", "voix": "Puck"}]},
        "deroule": [{"cle": "ouverture", "actif": True}, {"cle": "agenda", "actif": True},
                    {"cle": "R1", "actif": True}, {"cle": "R2", "actif": True},
                    {"cle": "deplacements", "actif": False}, {"cle": "approfondissements", "actif": True},
                    {"cle": "actualites", "actif": True}, {"cle": "R5", "actif": False}, {"cle": "cloture", "actif": True}],
        "agenda": {"jours": 5, "horizon": 60, "notes": False, "deplacements": False, "jours_deplacements": 14},
        "actus": {"ville": "Yverdon-les-Bains", "sujets_preferes": ["vélo"], "sujets_a_eviter": ["sport"],
                  "flux": [{"nom": "RTS Info", "url": "https://www.rts.ch/info/?format=rss/news"}],
                  "fraicheur_heures": 48, "articles": 20, "citer_sources": "les_deux",
                  "locale_sujets": 3, "locale_articles": 6, "locale_fraicheur_heures": 72,
                  "locale_preferes": ["travaux"], "locale_a_eviter": ["faits divers"]},
        "consignes": ["toujours un point sur Yverdon"],
        "consignes_rubriques": {"agenda": ["Ne parle de la piscine que la veille."], "actualites": ["Commence par l'économie"],
                                "inconnue": ["ignorée"], "cloture": "pas une liste"},
        "a_approfondir": [{"sujet": "Grève CFF", "demande_le": "2026-10-12T18:00"},
                          {"sujet": "Vieux sujet", "demande_le": "2026-10-10T09:00"}],
        "regles": [
            {"id": "R1", "titre": "Saint du jour", "consigne": "Dire le saint du jour.",
             "periode": {"type": "toujours", "debut": None, "fin": None, "jours": []}, "condition": None,
             "rubrique": {"titre": "Saint du jour", "apres": "agenda", "longueur": "phrase"},
             "recherche": {"fiche": {}, "sources": ["saints"], "requetes": []}, "etat": "active", "importance": "normale"},
            {"id": "R2", "titre": "Sortie enfants", "consigne": "Proposer une sortie avec les enfants samedi.",
             "periode": {"type": "dates", "debut": "2026-10-12", "fin": "2026-10-17", "jours": []}, "condition": None,
             "rubrique": {"titre": "Idées pour samedi", "apres": "R1", "longueur": "developpee"},
             "recherche": {"fiche": {"quoi": "activité avec les enfants", "avec_qui": "en famille", "ages": "6 et 9 ans",
                                     "ou": "autour de Vallorbe", "quand": "le sam. 17 oct.", "transport": "train",
                                     "budget": {"max": 20, "unite": "personne", "transport_inclus": False},
                                     "inclure": ["intérieur"], "exclure": [], "attendu": "3 idées"},
                           "sources": ["web", "meteo", "transports", "lieux", "wikivoyage"], "requetes": []},
             "etat": "active", "importance": "prioritaire"},
            {"id": "R3", "titre": "Affaires de foot", "consigne": "Rappeler de préparer le sac de foot.",
             "periode": {"type": "toujours", "jours": []}, "condition": {"texte": "un match de foot", "moment": "veille", "n": 1},
             "rubrique": None, "recherche": None, "etat": "active"},
            {"id": "R4", "titre": "Vendredi humour", "consigne": "Une blague pour finir.",
             "periode": {"type": "jours", "jours": ["ven"]}, "rubrique": None, "recherche": None, "etat": "active"},
            {"id": "R5", "titre": "Météo", "consigne": "La météo.", "periode": {"type": "toujours"},
             "rubrique": {"titre": "Météo", "apres": "agenda", "longueur": "phrase"},
             "recherche": {"fiche": {}, "sources": ["meteo"], "requetes": []}, "etat": "active"},
            {"id": "R6", "titre": "Ponctuelle", "consigne": "Recherche ponctuelle.", "periode": {"type": "ponctuelle"},
             "recherche": {"fiche": {"quoi": "rando", "ou": "Jura"}, "sources": ["web"], "requetes": []}, "etat": "active"},
            {"id": "R7", "titre": "En pause", "consigne": "x", "periode": {"type": "toujours"}, "etat": "pause"},
            {"id": "R8", "titre": "Finie", "consigne": "x", "periode": {"type": "dates", "fin": "2026-10-01"}, "etat": "active"},
            {"id": "R9", "titre": "Une fois servie", "consigne": "x", "periode": {"type": "une_fois"}, "servie": True, "etat": "active"},
        ],
        "prochain_numero": 10,
    }


# ───────────────────────── 1. liaison et filet ──────────────────────────────
print("1. Liaison avec le bot et filet de sécurité")
verifier(liaison.secret_partage("123:TEST") == hashlib.sha256(b"podcast:123:TEST").hexdigest()[:48],
         "secret partagé identique à celui du bot")
planning = config_bot()["planning"]
verifier(horaire.heure_prevue(planning, dt.date(2026, 10, 13)) == "06:45", "mardi : 6 h 45")
verifier(horaire.heure_prevue(planning, dt.date(2026, 10, 17)) == "09:00", "samedi : 9 h")
verifier(horaire.heure_prevue(planning, dt.date(2026, 10, 18)) is None, "dimanche : pas d'épisode")
verifier(horaire.heure_prevue(planning, dt.date(2026, 10, 16)) == "05:30", "exception du vendredi 16")
verifier(horaire.heure_prevue(planning, dt.date(2026, 12, 22)) is None, "pause de Noël")
verifier(horaire.heure_prevue(planning, dt.date(2026, 9, 21)) is None, "Jeûne fédéral comme un dimanche (sans épisode)")
verifier(horaire.feries_vaud(2027) >= {dt.date(2027, 3, 26), dt.date(2027, 3, 29), dt.date(2027, 9, 20)},
         "fériés vaudois 2027 (Vendredi saint, Lundi de Pâques, Jeûne)")
utc = dt.timezone.utc
export = {"format": "bot-v2", "heure_prevue_aujourdhui": "06:45", "episode_envoye_aujourdhui": False}
cas = [
    (dt.datetime(2026, 10, 13, 5, 30, tzinfo=utc), export, None, "", "", "7 h 30 : le bot s'en charge (45 min)"),
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=utc), export, None, "", "filet", "8 h 30 : 105 min de retard → filet"),
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=utc), {**export, "episode_envoye_aujourdhui": True}, None, "", "", "épisode déjà parti (bot)"),
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=utc), export, None, "2026-10-13", "", "épisode déjà parti (mémoire)"),
    (dt.datetime(2026, 10, 18, 9, 17, tzinfo=utc), {**export, "heure_prevue_aujourdhui": None}, None, "", "", "dimanche sans épisode"),
    (dt.datetime(2026, 10, 13, 4, 30, tzinfo=utc), None, config_bot(), "", "", "bot injoignable, 6 h 30 : pas encore"),
    (dt.datetime(2026, 10, 13, 5, 30, tzinfo=utc), None, config_bot(), "", "filet", "bot injoignable, 7 h 30 : sauvegarde → filet"),
]
export_lance = {**export, "episode_lance_aujourdhui": True}
cas += [
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=utc), {**export_lance, "config": {"planning": {"rattrapage": True, "delai_rattrapage": 30}}},
     None, "", "filet", "lancé par le bot, rattrapage à 30 min : 105 min de retard → filet"),
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=utc), {**export_lance, "config": {"planning": {"rattrapage": True, "delai_rattrapage": 120}}},
     None, "", "", "lancé par le bot, rattrapage à 2 h : on attend le bot (marge 150 min)"),
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=utc), {**export_lance, "config": {"planning": {"rattrapage": False}}},
     None, "", "", "lancé par le bot, rattrapage désactivé : GitHub ne relance pas"),
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=utc), {**export, "episode_lance_aujourdhui": False, "config": {"planning": {"rattrapage": False}}},
     None, "", "filet", "jamais lancé par le bot : le filet reste actif même sans rattrapage"),
]
for instant, exp, secours, dernier, attendu, libelle in cas:
    mode, texte = horaire.decider_filet(instant, "Europe/Zurich", exp, secours, dernier)
    verifier(mode == attendu, f"{libelle} ({texte})")

# ───────────────────────── 2. réglages du bot ───────────────────────────────
print("\n2. Réglages venus du bot")
reglages = podcast.charger_reglages(RACINE_TEST / "reglages.toml")
memoire = podcast.memoire_vide()
memoire["dernier_episode"] = {"date": "2026-10-12", "envoye_le": "2026-10-12T07:31"}
memoire["debit_mots_minute"] = {"rapide": 212}
e = podcast.effectifs_depuis_bot(reglages, memoire, config_bot())
verifier(e["duree_minutes"] == 4 and e["nombre_sujets"] == 3 and e["ton"] == "humour", "format")
verifier(e["vitesse_parole"] == "rapide" and e["mots_par_minute"] == 212, "vitesse et débit mesuré")
verifier(e["tutoiement"] is False and e["prenom_auditeur"] == "Daniel" and e["animateurs"][0]["voix"] == "Kore", "voix")
verifier(e["jours_agenda"] == 5 and e["jours_deplacements"] == 0 and e["inclure_notes_agenda"] is False, "agenda")
verifier(e["ville_habituelle"] == "Yverdon-les-Bains" and e["flux"][0]["nom"] == "RTS Info" and "citer_sources" not in e, "actus")
verifier(e["articles_actus"] == 20 and e["articles_par_flux"] == 20 and e["fraicheur_heures"] == 48, "actualités globales : articles lus, répartis entre les médias")
c_flux = config_bot()
c_flux["actus"] = {**c_flux["actus"], "flux_lus": ["rts00001", "inconnu1"]}
c_flux["sources"] = {"flux": [{"id": "labo0001", "nom": "Labo", "url": "https://labo.ch/rss"}, {"id": "rts00001", "nom": "RTS", "url": "https://www.rts.ch/rss"}]}
e_flux = podcast.effectifs_depuis_bot(reglages, memoire, c_flux)
verifier([f["nom"] for f in e_flux["flux"]] == ["RTS"] and e_flux["articles_par_flux"] == 20, "actualités globales : les flux cochés, parmi tous les flux")
verifier(e["locale_sujets"] == 3 and e["locale_articles"] == 6 and e["locale_fraicheur_heures"] == 72
         and e["locale_preferes"] == ["travaux"] and e["locale_a_eviter"] == ["faits divers"], "actu locale : réglée comme les actualités globales")
verifier(e["consignes_rubriques"] == {"agenda": ["Ne parle de la piscine que la veille"], "actualites": ["Commence par l'économie"]},
         f"consignes par rubrique fournie (inconnues et mal formées écartées) : {e['consignes_rubriques']}")
verifier([a["sujet"] for a in e["a_approfondir"]] == ["Grève CFF"], "seuls les sujets demandés après le dernier épisode")
verifier(e["modeles_texte"] == reglages["modeles_texte"] and e["debit_mp3_kbps"] == reglages["debit_mp3_kbps"],
         "la partie technique reste celle de reglages.toml")
verifier(podcast.rubrique_active(e, "actualites") and not podcast.rubrique_active(e, "deplacements"), "rubriques actives")
# Une seule voix : le bot n'envoie qu'un animateur, le script et la voix s'adaptent.
solo = config_bot()
solo["voix"]["animateurs"] = [{"nom": "Léa", "voix": "Aoede"}]
e_solo = podcast.effectifs_depuis_bot(reglages, memoire, solo)
consigne_solo = podcast.consigne_systeme(e_solo)
verifier(len(e_solo["animateurs"]) == 1 and "une seule voix, Léa" in consigne_solo and "|ah enfin|" not in consigne_solo,
         "une seule voix : un animateur, script en chronique")
# Budget dans une autre devise, et sortie sans déplacement.
verifier(moteur.budget_en_mots({"budget": {"max": 30, "unite": "personne", "devise": "EUR", "transport_inclus": True}})
         == "30 EUR maximum par personne, transport compris", "budget en euros")
verifier(moteur.budget_en_mots({"transport": "aucun", "budget": {"max": 15, "unite": "total", "devise": "CHF"}})
         == "15 CHF maximum pour tout le groupe", "sans déplacement : pas de mention du transport")
# Fériés d'un autre pays : liste fournie par le bot.
plan_fr = {**planning, "feries": "aucun", "feries_region": "FR", "feries_cache": {"2026": [["2026-11-11", "Armistice"]]}}
verifier(horaire.heure_prevue(plan_fr, dt.date(2026, 11, 11)) is None and horaire.heure_prevue(plan_fr, dt.date(2026, 9, 21)) is not None,
         "fériés français : 11 novembre sans épisode, Jeûne fédéral normal")
mauvais = config_bot()
mauvais["voix"]["animateurs"] = [{"nom": "Léa", "voix": "Kore"}, {"nom": "Lea", "voix": "Puck"}]
mauvais["format"]["duree_minutes"] = 99
e2 = podcast.effectifs_depuis_bot(reglages, memoire, mauvais)
verifier(e2["animateurs"] == reglages["animateurs"] and e2["duree_minutes"] == 12, "valeurs invalides corrigées")
secours = RACINE_TEST / "preferences.json"
secours.write_text(json.dumps({"format": "bot-v2", "config": config_bot()}), encoding="utf-8")
verifier(liaison.config_de_secours(secours)["config"]["format"]["ton"] == "humour", "sauvegarde du bot relue")
secours.write_text(json.dumps({"preferences": {"vitesse_parole": "lente"}}), encoding="utf-8")
verifier(liaison.config_de_secours(secours) is None, "ancien format ignoré par le secours")
secours.unlink()

# ───────────────────────── 3. sélection des règles ──────────────────────────
print("\n3. Règles du jour")
jeudi = dt.date(2026, 10, 15)
programmees, conditionnelles = moteur.selectionner(config_bot(), jeudi)
verifier([r["id"] for r in programmees] == ["R1", "R2", "R5"], f"programmées : {[r['id'] for r in programmees]}")
verifier([r["id"] for r in conditionnelles] == ["R3"], "condition d'agenda à vérifier : R3")
programmees, _ = moteur.selectionner(config_bot(), dt.date(2026, 10, 16))
verifier("R4" in [r["id"] for r in programmees], "R4 le vendredi seulement")
programmees, _ = moteur.selectionner(config_bot(), dt.date(2026, 10, 18))
verifier("R2" not in [r["id"] for r in programmees], "R2 terminée après le 17")
programmees, _ = moteur.selectionner(config_bot(), jeudi, ["r6", "R7"])
verifier({"R6", "R7"} <= {r["id"] for r in programmees}, "règles forcées (épisode à la demande) même ponctuelle ou en pause")
verifier(moteur.etat_regle(config_bot()["regles"][8], jeudi) == "terminee", "une seule fois, déjà servie")
verifier(moteur.est_recherche(config_bot()["regles"][1]) and not moteur.est_recherche(config_bot()["regles"][0]),
         "règle de recherche reconnue")

# ───────────────────────── 4. planification ─────────────────────────────────
print("\n4. Planification (modèle léger)")
demandes = []


def planificateur(systeme, entree, schema):
    demandes.append((systeme, entree, schema))
    return {"regles": [
        {"id": "R3", "applique": True, "evenement": "Match FC Yverdon, vendredi 16 octobre à 19 h"},
        {"id": "R2", "applique": False, "date_cible": "2026-10-17", "requetes": ["activités enfants Vallorbe octobre"],
         "lieux": ["Vallorbe"], "categories": ["grotte", "musee", "inconnue"], "rayon_km": 15},
        {"id": "R99", "applique": True},
    ]}


plans = moteur.planifier([config_bot()["regles"][i] for i in (0, 1, 2)], ["- vendredi 16 octobre à 19 h : Match FC Yverdon"],
                         jeudi, "Yverdon-les-Bains", planificateur)
verifier(len(demandes) == 1 and "veille" in demandes[0][1] and "Match FC Yverdon" in demandes[0][1], "un seul appel avec règles et agenda")
verifier("R1" not in demandes[0][1], "la règle des saints n'a pas besoin du modèle")
verifier(plans["R3"]["applique"] and "Match" in plans["R3"]["evenement"], "condition remplie : la veille du match")
verifier(plans["R2"]["applique"] is True, "une règle sans condition s'applique quoi qu'en dise le modèle")
verifier(plans["R2"]["categories"] == ["grotte", "musee"] and plans["R2"]["lieux"] == ["Vallorbe"] and plans["R2"]["date_cible"] == "2026-10-17",
         "catégories filtrées, lieu et date retenus")


def en_panne(*_):
    raise podcast.ErreurPodcast("Gemini muet")


plans = moteur.planifier([config_bot()["regles"][i] for i in (1, 2)], [], jeudi, "Yverdon-les-Bains", en_panne)
verifier(plans["R3"]["applique"] is False and plans["R2"]["applique"] is True, "sans le modèle : conditions ignorées, recherches gardées")
verifier(plans["R2"]["lieux"] == ["Vallorbe"] and "aire_de_jeux" in plans["R2"]["categories"], "valeurs par défaut tirées de la fiche")
verifier(moteur.plan_par_defaut({"id": "R", "recherche": {"fiche": {"ou": "entre Yverdon et Neuchâtel"}, "requetes": []}}, "")["lieux"]
         == ["Yverdon", "Neuchâtel"], "« entre X et Y » → deux lieux")

# ───────────────────────── 5. collecte des sources ──────────────────────────


class FaussesSources(sources.Sources):
    def __init__(self, cle_tavily="cle-tavily-test"):
        super().__init__(cle_tavily or "cle-tavily-test")
        self.appels = []

    def geocoder(self, nom):
        self.appels.append(("geo", nom))
        return {"Vallorbe": {"nom": "Vallorbe", "lat": 46.712, "lon": 6.378, "pays": "Suisse", "region": "Vaud"},
                "Yverdon-les-Bains": {"nom": "Yverdon-les-Bains", "lat": 46.778, "lon": 6.641, "pays": "Suisse", "region": "Vaud"},
                "Neuchâtel": {"nom": "Neuchâtel", "lat": 46.99, "lon": 6.93, "pays": "Suisse", "region": "Neuchâtel"},
                }.get(nom)

    def meteo(self, lat, lon, jour):
        self.appels.append(("meteo", jour))
        return {"date": jour.isoformat(), "ciel": "averses", "max": 14.2, "min": 6.8, "pluie": 70, "vent": 12}

    def trajets(self, depart, arrivee, jour, heure="09:00", nombre=3):
        self.appels.append(("trains", depart, arrivee, jour))
        return [{"depart": "09:04", "arrivee": "09:43", "duree": "39 min", "correspondances": 1, "moyens": ["R"], "de": depart, "a": arrivee},
                {"depart": "10:04", "arrivee": "10:43", "duree": "39 min", "correspondances": 1, "moyens": ["R"], "de": depart, "a": arrivee}]

    def lieux(self, lat, lon, categories, rayon_km=10, maximum=12):
        self.appels.append(("osm", tuple(categories), rayon_km))
        return [{"nom": "Grottes de Vallorbe", "lat": 46.703, "lon": 6.367, "type": "attraction", "site": "https://www.grottesdevallorbe.ch",
                 "horaires": "Mo-Su 09:30-17:00", "adresse": "Vallorbe", "wikipedia": "fr:Grottes de Vallorbe", "accessible": "", "distance": 1.6},
                {"nom": "Musée du Fer", "lat": 46.713, "lon": 6.379, "type": "museum", "site": "", "horaires": "", "adresse": "", "wikipedia": "",
                 "accessible": "yes", "distance": 0.2}]

    def wikivoyage(self, nom):
        self.appels.append(("wikivoyage", nom))
        return {"titre": "Vallorbe", "extrait": "Vallorbe est une petite ville du Jura vaudois.", "image": "https://upload.wikimedia.org/vallorbe.jpg",
                "url": "https://fr.wikivoyage.org/wiki/Vallorbe"}

    def wikipedia(self, recherche_):
        return {"titre": "Grottes de Vallorbe", "extrait": "", "image": "https://upload.wikimedia.org/grottes.jpg", "lat": 46.703, "lon": 6.367,
                "url": "https://fr.wikipedia.org/wiki/Grottes_de_Vallorbe"}

    def web(self, requete, maximum=5, images=False, jours=None, domaines=None):
        self.appels.append(("web", requete) if not domaines else ("web", requete, tuple(domaines)))
        self.credits_tavily += 1
        return {"resultats": [{"titre": "Grottes de Vallorbe – tarifs", "url": "https://www.grottesdevallorbe.ch/tarifs",
                               "contenu": "Adultes 22 CHF, enfants 6-16 ans 12 CHF.", "score": 0.9},
                              {"titre": "Juraparc", "url": "https://www.juraparc.ch", "contenu": "Parc animalier, entrée libre.", "score": 0.7}],
                "images": ["https://exemple.ch/photo.jpg"] if images else []}

    def nominatim_chercher(self, requete, pays="ch"):
        self.appels.append(("nominatim", requete))
        return {"lat": 46.71, "lon": 6.37, "adresse": "Vallorbe, Vaud, Suisse"}


print("\n5. Collecte des informations d'une règle")
src = FaussesSources()
regle2 = config_bot()["regles"][1]
plan2 = {"applique": True, "evenement": "", "date_cible": "2026-10-17", "requetes": ["activités enfants Vallorbe"],
         "lieux": ["Vallorbe"], "categories": ["grotte", "musee"], "rayon_km": 15}
c = moteur.collecter(regle2, plan2, src, jeudi, "Yverdon-les-Bains", lambda q: [f"24 heures — Nouveauté à {q}"])
verifier("Fiche :" in c.texte and "6 et 9 ans" in c.texte and "20 CHF maximum par personne, transport non compris" in c.texte, "fiche et budget dans la section")
verifier("Date visée : samedi 17 octobre 2026 (dans 2 jours)" in c.texte, "date visée")
verifier("Météo prévue (Vallorbe, samedi 17 octobre 2026) : averses, 7 à 14 °C, risque de pluie 70 %" in c.texte, "météo du jour de la sortie")
verifier("Train (horaires, prix non fournis) : Yverdon-les-Bains → Vallorbe : départ 09:04" in c.texte, "train depuis la ville")
verifier("Grottes de Vallorbe (attraction, à 1,6 km, horaires : Mo-Su 09:30-17:00)" in c.texte and "accessible en fauteuil" in c.texte, "lieux OpenStreetMap")
verifier("Wikivoyage — Vallorbe" in c.texte and "[W1] Grottes de Vallorbe – tarifs" in c.texte, "Wikivoyage et recherche web")
verifier(("osm", ("grotte", "musee"), 15.0) in src.appels and ("meteo", dt.date(2026, 10, 17)) in src.appels, "catégories et date demandées")
verifier(c.itineraire.startswith("https://www.google.com/maps/dir/?api=1&origin=Yverdon-les-Bains&destination=Vallorbe&travelmode=transit"),
         f"lien d'itinéraire en transports publics : {c.itineraire}")
verifier(("Wikivoyage : Vallorbe", "https://fr.wikivoyage.org/wiki/Vallorbe") in c.liens and c.images, "liens et image gardés")
regle1 = config_bot()["regles"][0]
c1 = moteur.collecter(regle1, moteur.plan_par_defaut(regle1, "Yverdon-les-Bains"), FaussesSources(), jeudi, "Yverdon-les-Bains")
saints = json.loads((PROJET / "donnees" / "saints.json").read_text(encoding="utf-8"))["jours"]["10-15"]
verifier(saints and "Prénom fêté aujourd'hui" in c1.texte and "Thérèse" in c1.texte and "Saints et fêtes" not in c1.texte,
         "15 octobre : prénoms fêtés (Thérèse), sans liste de saints")
verifier(isinstance(sources.saints_du_jour(dt.date(2028, 2, 29)), list), "29 février sans erreur")

# ───────────── 5 ter. prénoms, saints, journées et fêtes (données de référence) ─────────────
import fetes  # noqa: E402
import subprocess  # noqa: E402

print("\n5 ter. Prénoms, saints, journées et fêtes nationales (données de référence, sans réseau)")
dpm = fetes.prenoms_du_jour
verifier(dpm(dt.date(2026, 10, 23))["principal"] == ["Jean"], f"23 octobre : Jean ({dpm(dt.date(2026, 10, 23))})")
verifier(dpm(dt.date(2026, 6, 24))["principal"] == ["Jean-Baptiste"], "24 juin : Jean-Baptiste")
verifier(dpm(dt.date(2026, 4, 28))["principal"] == ["Valérie"], "28 avril : Valérie")
verifier(dpm(dt.date(2028, 2, 29))["principal"] == ["Auguste"], "29 février : Auguste")
verifier(dpm(dt.date(2026, 6, 29))["principal"] == ["Pierre", "Paul"], "29 juin : Pierre et Paul")
verifier(dpm(dt.date(2026, 11, 1))["principal"] == [] and "Toussaint" in dpm(dt.date(2026, 11, 1))["fete"],
         "Toussaint : pas de prénom fixe, la fête est nommée")
tous_saints = json.loads((PROJET / "donnees" / "saints.json").read_text(encoding="utf-8"))["jours"]
verifier(len(tous_saints) == 366 and "06-31" not in tous_saints, "calendrier des saints : 366 jours, pas de 31 juin")
verifier(any("Jean le Baptiste" in s for s in sources.saints_du_jour(dt.date(2026, 6, 24))),
         "24 juin : Jean-Baptiste (mai et juin n'étaient plus inversés dans le calendrier des saints)")
verifier(any("Joseph" in s for s in sources.saints_du_jour(dt.date(2026, 5, 1))), "1er mai : saint Joseph")
verifier(any("Pierre" in s for s in sources.saints_du_jour(dt.date(2026, 6, 29))), "29 juin : saint Pierre")
verifier(sources.saints_du_jour(dt.date(2026, 5, 24)) == ["St-Donatien", "St-Rogatien"], "24 mai : Donatien et Rogatien")
r_p0 = {"id": "R9", "titre": "Fête du prénom", "consigne": "Prénoms fêtés", "etat": "active", "importance": "normale",
        "recherche": {"fiche": {}, "sources": ["saints"], "requetes": []}}
cp0 = moteur.collecter(r_p0, moteur.plan_par_defaut(r_p0, "Yverdon-les-Bains"), FaussesSources(), dt.date(2026, 10, 23), "Yverdon-les-Bains")
verifier("Prénom fêté aujourd'hui (calendrier traditionnel français) : Jean" in cp0.texte
         and "Saints et fêtes" not in cp0.texte and "St-Hyacinthe" not in cp0.texte,
         "rubrique prénom : le prénom traditionnel, pas de liste de saints")
# journées : mobiles, par pays, prudence
verifier(fetes.date_regle("fete_meres_fr", 2023) == dt.date(2023, 6, 4) and fetes.date_regle("fete_meres_fr", 2026) == dt.date(2026, 5, 31),
         "fête des mères en France : le dernier dimanche de mai, sauf Pentecôte (4 juin 2023, 31 mai 2026)")
verifier(fetes.date_regle("nth:11:4:3+1", 2026) == dt.date(2026, 11, 27), "Black Friday 2026 : 27 novembre")
verifier(fetes.date_regle("nth:10:-1:6", 2026) == dt.date(2026, 10, 25), "passage à l'heure d'hiver 2026 : 25 octobre")
verifier(fetes.date_regle("paques:-47", 2026) == dt.date(2026, 2, 17), "Mardi gras 2026 : 17 février")
mere_fr = [e["nom"] for e in fetes.journees_du_jour(dt.date(2026, 5, 31), "FR")["pays"]]
mere_ch = [e["nom"] for e in fetes.journees_du_jour(dt.date(2026, 5, 10), "CH")["pays"]]
verifier("Fête des mères" in mere_fr and "Fête des mères" in mere_ch
         and "Fête des mères" not in [e["nom"] for e in fetes.journees_du_jour(dt.date(2026, 5, 10), "FR")["pays"]],
         "fête des mères : une date par pays (31 mai en France, 10 mai en Suisse)")
aout = fetes.journees_du_jour(dt.date(2026, 8, 1), "CH")["nationales"]
verifier(aout and aout[0]["iso"] == "CH", f"1er août : la Suisse d'abord ({[e['iso'] for e in aout]})")
kosovo = " ".join(fetes.lignes_du_jour(dt.date(2026, 2, 17), "CH"))
verifier("Kosovo" in kosovo and "contesté" in kosovo, "fête nationale contestée : annoncée avec sa réserve")
verifier("[sujet sensible" in " ".join(fetes.lignes_du_jour(dt.date(2026, 11, 25), "CH")), "journée à sujet douloureux : signalée")
verifier("Semaine mondiale de l'allaitement maternel (OMS), du 1er au 7 août" in " ".join(fetes.lignes_du_jour(dt.date(2026, 8, 3), "FR")),
         "semaine internationale : dite avec ses dates")
verifier("(à présenter comme telles)" in " ".join(fetes.lignes_du_jour(dt.date(2026, 10, 23), "CH")), "journée non officielle : à présenter comme telle")
verifier(all(fetes.lignes_du_jour(dt.date(2027, m, d), "BE") is not None for m, d in [(1, 1), (12, 31), (7, 21)]), "tous les jours se lisent")


class SansReseau(FaussesSources):
    def _json(self, *a, **k):
        raise AssertionError("les fêtes ne doivent faire aucun appel réseau")


verifier(any("Zambie" in x for x in SansReseau().fetes(dt.date(2026, 10, 24))), "fêtes du jour : aucun appel réseau")
ci_off = moteur.collecter({**r_p0, "recherche": {"fiche": {}, "sources": ["fetes"], "requetes": []}},
                          moteur.plan_par_defaut(r_p0, "Yverdon-les-Bains"), SansReseau(), dt.date(2026, 10, 24), "Yverdon-les-Bains")
verifier("données de référence du podcast" in ci_off.texte and "Journée des Nations Unies" in ci_off.texte, "rubrique « journées » : lit les données intégrées")
# Les fichiers fabriqués correspondent aux tables, et chaque mois du calendrier des prénoms concorde avec celui des saints.
fabrication = subprocess.run([sys.executable, str(PROJET / "outils" / "construire_fetes.py"), "--verifier"], capture_output=True, text=True)
verifier(fabrication.returncode == 0, f"données de fêtes à jour et cohérentes : {(fabrication.stdout + fabrication.stderr).strip()[-300:]}")

# ───────────────────────── 5 bis. suivi d'un train ──────────────────────────
import trains  # noqa: E402

print("\n5 bis. Suivi d'un train en temps réel")
for texte, attendu in [
    ("Retard depuis Yverdon vers Berne à 7h31", {"de": "Yverdon", "a": "Berne", "heure": "07:31"}),
    ("Le train de 7h31 de Yverdon à Berne", {"de": "Yverdon", "a": "Berne", "heure": "07:31"}),
    ("Retard du train Bruxelles-Midi vers Liège-Guillemins à 17:04", {"de": "Bruxelles-Midi", "a": "Liège-Guillemins", "heure": "17:04"}),
    ("Ponctualité de mon TER de Lyon Part-Dieu à Grenoble à 7h12.", {"de": "Lyon Part-Dieu", "a": "Grenoble", "heure": "07:12"}),
    ("Train de Paris Gare de Lyon à Dijon à 9h15", {"de": "Paris Gare de Lyon", "a": "Dijon", "heure": "09:15"}),
    ("Activités atypiques à Grenoble ce week-end", None),
]:
    verifier(trains.trajet_depuis_texte(texte) == attendu, f"trajet lu dans « {texte} » : {trains.trajet_depuis_texte(texte)}")
verifier(trains.meme_gare("Berne", "Bern") and trains.meme_gare("Bâle", "Basel SBB") and trains.meme_gare("Yverdon", "Yverdon-les-Bains")
         and trains.meme_gare("Bruxelles-Midi", "Brussel-Zuid/Bruxelles-Midi"), "noms de gares équivalents reconnus")
verifier(not trains.meme_gare("Bruxelles-Central", "Zürich, Central") and not trains.meme_gare("Berne", "Bernex"),
         "une autre gare n'est pas prise pour la bonne")
verifier(trains.nom_suisse("Bâle") == "Basel" and trains.nom_suisse("Saint-Gall") == "St. Gallen" and trains.nom_suisse("Yverdon") == "Yverdon",
         "noms français des gares suisses traduits pour la recherche")
verifier(trains.pays_probables("", "Retard SNCF")[0] == "FR" and trains.pays_probables("BE", "CFF")[:2] == ["BE", "CH"]
         and trains.pays_probables("", "Retard")[0] == "CH", "ordre des réseaux : indice, mots, puis Suisse")

regle_cff = {"id": "R4", "titre": "Retard CFF", "consigne": "Retard depuis Yverdon vers Berne à 7h31",
             "condition": {"texte": "UNIBE", "moment": "jour_meme", "n": 1}, "rubrique": {"titre": "Retard CFF", "longueur": "phrase"},
             "recherche": {"fiche": {"transport": "train"}, "sources": ["transports"], "requetes": []}}
plan_cff = moteur.plan_par_defaut(regle_cff, "Yverdon-les-Bains")
verifier(plan_cff["train"] == {"de": "Yverdon", "a": "Berne", "heure": "07:31"}, f"plan : train lu dans la consigne ({plan_cff['train']})")
verifier(moteur.plan_par_defaut(config_bot()["regles"][1], "Yverdon-les-Bains")["train"] is None, "pas de train pour une sortie")
plans_t = moteur.planifier([regle_cff, {**regle_cff, "id": "R9", "consigne": "Dis-moi si mon train du matin pour Lausanne est en retard"}],
                           [], jeudi, "Yverdon", lambda *a: {"regles": [
                               {"id": "R4", "applique": True, "train": {"de": "Genève", "a": "Zurich", "heure": "6h", "pays": "CH"}},
                               {"id": "R9", "applique": True, "train": {"de": "Yverdon-les-Bains", "a": "Lausanne", "heure": "7h05", "pays": "CH"}}]})
verifier(plans_t["R4"]["train"] == {"de": "Yverdon", "a": "Berne", "heure": "07:31", "pays": "CH"},
         "la consigne prime sur le modèle, qui ajoute le pays")
verifier(plans_t["R9"]["train"] == {"de": "Yverdon-les-Bains", "a": "Lausanne", "heure": "07:05", "pays": "CH"},
         "tournure libre : trajet complété par le modèle")


def arret_od(gare, depart=None, arrivee=None, retard=None, prevision=None, voie="1", voie_prevue=None):
    return {"station": {"name": gare}, "departure": depart, "arrival": arrivee, "delay": retard, "platform": voie,
            "prognosis": {"departure": prevision if depart else None, "arrival": prevision if arrivee else None, "platform": voie_prevue}}


OD_CFF = {"connections": [
    {"from": arret_od("Yverdon-les-Bains", depart="2026-10-15T07:01:00+0200", retard=0),
     "to": arret_od("Bern", arrivee="2026-10-15T08:08:00+0200", retard=0), "sections": []},
    {"from": arret_od("Yverdon-les-Bains", depart="2026-10-15T07:31:00+0200", retard=4),
     "to": arret_od("Bern", arrivee="2026-10-15T08:48:00+0200", retard=0),
     "sections": [
         {"journey": {"category": "IC", "number": "51", "name": "001611"},
          "departure": arret_od("Yverdon-les-Bains", depart="2026-10-15T07:31:00+0200", retard=4,
                                prevision="2026-10-15T07:35:00+0200", voie="1", voie_prevue="2"),
          "arrival": arret_od("Biel/Bienne", arrivee="2026-10-15T08:12:00+0200", retard=9)},
         {"journey": None, "walk": {"duration": 120},
          "departure": arret_od("Biel/Bienne", depart="2026-10-15T08:12:00+0200"), "arrival": arret_od("Biel/Bienne", arrivee="2026-10-15T08:14:00+0200")},
         {"journey": {"category": "IR", "number": "65", "name": "003328"},
          "departure": arret_od("Biel/Bienne", depart="2026-10-15T08:20:00+0200", retard=0, voie="7"),
          "arrival": arret_od("Bern", arrivee="2026-10-15T08:48:00+0200", retard=0)}]}]}
SC_CFF = {"connections": [{"from": "Yverdon-les-Bains", "to": "Bern", "departure": "2026-10-15 07:31:00", "legs": [
    {"departure": "2026-10-15 07:31:00", "name": "Yverdon-les-Bains", "line": "IC 51", "type": "express_train", "track": "1!",
     "dep_delay": "+6", "exit": {"arrival": "2026-10-15 08:48:00", "name": "Bern", "arr_delay": "+5"}},
    {"arrival": "2026-10-15 08:48:00", "name": "Bern"}]}]}


class SourcesTrains(FaussesSources):
    def __init__(self, reponses):
        super().__init__()
        self.reponses = reponses

    def _json(self, methode, url, delai=20, **options):
        self.appels.append(("json", url, options.get("params")))
        for morceau, reponse in self.reponses.items():
            if morceau in url:
                if isinstance(reponse, Exception):
                    raise reponse
                return reponse
        raise ConnectionError(url)


src_t = SourcesTrains({"opendata": OD_CFF})
c_t = moteur.collecter(regle_cff, plan_cff, src_t, jeudi, "Yverdon-les-Bains")
verifier("Train IC 51 de 07 h 31, Yverdon-les-Bains → Biel/Bienne, départ avec 4 min de retard, voie 2 (CHANGEMENT DE VOIE)" in c_t.texte,
         "retard au départ, en minutes, avec la voie")
verifier("Correspondance IR 65 de 08 h 20, Biel/Bienne → Bern, départ à l'heure" in c_t.texte
         and "ATTENTION : correspondance à Biel/Bienne menacée (marge de -1 min)" in c_t.texte, "correspondance menacée signalée")
verifier("Train (horaires CFF" not in c_t.texte and not [a for a in src_t.appels if a[0] == "trains"], "plus d'horaire générique de 9 h")
verifier(c_t.train.temps_reel and c_t.train.source == "CFF", "état gardé dans la collecte")
params_od = next(a[2] for a in src_t.appels if a[0] == "json" and "opendata" in a[1])
verifier(params_od["time"] == "07:31" and params_od["date"] == "2026-10-15" and params_od["from"] == "Yverdon", "demande au bon jour et à la bonne heure")

src_t = SourcesTrains({"opendata": ConnectionError("panne"), "search.ch": SC_CFF})
c_t = moteur.collecter(regle_cff, plan_cff, src_t, jeudi, "Yverdon-les-Bains")
verifier("départ avec 6 min de retard, voie 1 (CHANGEMENT DE VOIE), arrivée prévue à 08 h 48 avec 5 min de retard" in c_t.texte,
         "CFF en panne : search.ch prend le relais")
od_faux = {"connections": [{**OD_CFF["connections"][1], "from": arret_od("Zürich, Central", depart="2026-10-15T07:31:00+0200"),
                            "to": arret_od("Pully Guillemin", arrivee="2026-10-15T09:00:00+0200")}]}
src_t = SourcesTrains({"opendata": od_faux, "search.ch": {"connections": []}, "irail": ConnectionError("x")})
c_t = moteur.collecter(regle_cff, plan_cff, src_t, jeudi, "Yverdon-les-Bains")
verifier("état NON VÉRIFIÉ" in c_t.texte and "N'annonce AUCUN retard" in c_t.texte and c_t.train is None,
         "gares mal comprises partout : rien n'est inventé")

IR_BE = {"connection": [{"departure": {"station": "Bruxelles-Midi", "stationinfo": {"name": "Bruxelles-Midi", "standardname": "Brussel-Zuid/Bruxelles-Midi"},
                                       "time": str(int(dt.datetime(2026, 10, 15, 17, 4, tzinfo=ZoneInfo("Europe/Brussels")).timestamp())),
                                       "delay": "420", "canceled": "0", "platform": "18", "platforminfo": {"name": "18", "normal": "0"},
                                       "vehicleinfo": {"shortname": "IC 2537"}},
                         "arrival": {"station": "Liège-Guillemins", "stationinfo": {"name": "Liège-Guillemins"},
                                     "time": str(int(dt.datetime(2026, 10, 15, 18, 10, tzinfo=ZoneInfo("Europe/Brussels")).timestamp())),
                                     "delay": "300", "canceled": "0", "platform": "3"},
                         "vias": {"number": "1", "via": [{"station": "Louvain",
                             "arrival": {"time": str(int(dt.datetime(2026, 10, 15, 17, 30, tzinfo=ZoneInfo("Europe/Brussels")).timestamp())), "delay": "420"},
                             "departure": {"time": str(int(dt.datetime(2026, 10, 15, 17, 40, tzinfo=ZoneInfo("Europe/Brussels")).timestamp())),
                                           "delay": "0", "canceled": "1", "platform": "5", "vehicleinfo": {"shortname": "IC 1736"}}}]}}]}
etat_be, _ = trains.etat_train(SourcesTrains({"irail": IR_BE}), "Bruxelles-Midi", "Liège-Guillemins", jeudi, "17:04", "BE")
texte_be = trains.en_mots(etat_be, [], "Bruxelles-Midi", "Liège-Guillemins", "17:04")
verifier(etat_be and etat_be.source == "SNCB" and "IC 2537 de 17 h 04, Bruxelles-Midi → Louvain, départ avec 7 min de retard, voie 18 (CHANGEMENT DE VOIE)" in texte_be
         and "Correspondance IC 1736 de 17 h 40, Louvain → Liège-Guillemins, SUPPRIMÉ" in texte_be, f"Belgique (iRail) : retard, voie, suppression\n{texte_be}")

SNCF_PLACES = {"places": [{"id": "stop_area:SNCF:87723197", "name": "Lyon Part Dieu (Lyon)"}]}
SNCF_GRENOBLE = {"places": [{"id": "stop_area:SNCF:87747006", "name": "Grenoble (Grenoble)"}]}
SNCF_TRAJETS = {"journeys": [{"sections": [
    {"type": "public_transport", "departure_date_time": "20261015T071200", "base_departure_date_time": "20261015T071200",
     "arrival_date_time": "20261015T084500", "base_arrival_date_time": "20261015T084500",
     "from": {"name": "Lyon Part Dieu (Lyon)"}, "to": {"name": "Grenoble (Grenoble)"},
     "display_informations": {"commercial_mode": "TER", "headsign": "886512", "links": [{"type": "disruption", "id": "d1"}]}}]}],
    "disruptions": [{"id": "d1", "severity": {"effect": "SIGNIFICANT_DELAYS"}, "messages": [{"text": "Accident de personne"}],
                     "impacted_objects": [{"impacted_stops": [
                         {"stop_point": {"name": "Lyon Part Dieu"}, "base_departure_time": "071200", "amended_departure_time": "073200", "departure_status": "delayed"},
                         {"stop_point": {"name": "Grenoble"}, "base_arrival_time": "084500", "amended_arrival_time": "090500", "arrival_status": "delayed"}]}]}]}


class SourcesSncf(SourcesTrains):
    def _json(self, methode, url, delai=20, **options):
        if url.endswith("/places"):
            self.appels.append(("auth", options.get("auth")))
            return SNCF_PLACES if "Lyon" in options["params"]["q"] else SNCF_GRENOBLE
        return super()._json(methode, url, delai, **options)


src_fr = SourcesSncf({"api.sncf.com": SNCF_TRAJETS, "opendata": {"connections": []}})
etat_fr, pb_fr = trains.etat_train(src_fr, "Lyon Part-Dieu", "Grenoble", jeudi, "07:12", texte="mon TER", cle_sncf="cle-sncf")
texte_fr = trains.en_mots(etat_fr, pb_fr, "Lyon Part-Dieu", "Grenoble", "07:12")
verifier(etat_fr and etat_fr.source == "SNCF" and "TER 886512 de 07 h 12" in texte_fr and "départ avec 20 min de retard" in texte_fr
         and "arrivée prévue à 08 h 45 avec 20 min de retard" in texte_fr and "Info transporteur : Accident de personne" in texte_fr
         and ("auth", ("cle-sncf", "")) in src_fr.appels, f"France (API SNCF) : retard lu dans la perturbation\n{texte_fr}")
etat_fr, pb_fr = trains.etat_train(SourcesTrains({"opendata": {"connections": []}, "search.ch": {"connections": []}, "irail": {"connection": []}}),
                                   "Lyon Part-Dieu", "Grenoble", jeudi, "07:12", texte="SNCF", cle_sncf="")
verifier(etat_fr is None and any("clé SNCF manquante" in p for p in pb_fr), "France sans clé : signalé, rien d'inventé")


class Refus(Exception):
    def __init__(self, statut):
        super().__init__(f"HTTP {statut}")
        self.response = type("R", (), {"status_code": statut})()


_, pb_inconnu = trains.etat_train(SourcesTrains({"opendata": {"connections": []}, "search.ch": {"connections": []}, "irail": Refus(400)}),
                                  "Lyon Part-Dieu", "Grenoble", jeudi, "07:12", cle_sncf="")
verifier(not [p for p in pb_inconnu if "SNCB" in p], f"gare inconnue en Belgique : pas une panne ({pb_inconnu})")

# Mémoire multi-jours des articles.
class _A:
    def __init__(self, n, titre): self.numero, self.titre = n, titre
mem = {}
podcast.retenir_articles(mem, [_A(1, "Genève : grève des TPG"), _A(2, "Autre sujet")], {1}, dt.datetime(2026, 10, 14, 7, tzinfo=dt.timezone.utc))
verifier(podcast.cle_titre("Genève : grève des TPG") in podcast.articles_deja_traites(mem, dt.datetime(2026, 10, 15, 7, tzinfo=dt.timezone.utc)),
         "article cité hier : écarté aujourd'hui")
verifier(not podcast.articles_deja_traites(mem, dt.datetime(2026, 10, 14, 9, tzinfo=dt.timezone.utc)), "relance le même jour : rien d'écarté")
verifier(not podcast.articles_deja_traites(mem, dt.datetime(2026, 10, 25, 7, tzinfo=dt.timezone.utc)), "oublié après 7 jours")

# La mémoire survit à l'enregistrement puis à la relecture de memoire.json (elle s'effaçait chaque jour).
import tempfile
from pathlib import Path as _Path
with tempfile.TemporaryDirectory() as dossier:
    chemin = _Path(dossier) / "memoire.json"
    lue = podcast.charger_memoire(chemin)
    podcast.retenir_articles(lue, [_A(1, "Des reliques exceptionnelles présentées lors du pèlerinage")], {1},
                             dt.datetime(2026, 10, 18, 7, tzinfo=dt.timezone.utc), ["Festival Jimei x Arles : le programme"])
    podcast.sauver_memoire(chemin, lue)
    lue = podcast.charger_memoire(chemin)
    podcast.retenir_articles(lue, [_A(1, "Yverdon : chasse aux dealers, fausse info")], {1},
                             dt.datetime(2026, 10, 19, 7, tzinfo=dt.timezone.utc))
    podcast.sauver_memoire(chemin, lue)
    deja = podcast.articles_deja_traites(podcast.charger_memoire(chemin), dt.datetime(2026, 10, 20, 7, tzinfo=dt.timezone.utc))
    verifier(podcast.cle_titre("Des reliques exceptionnelles présentées lors du pèlerinage") in deja
             and podcast.cle_titre("Yverdon : chasse aux dealers, fausse info") in deja
             and podcast.cle_titre("Festival Jimei x Arles : le programme") in deja,
             f"mémoire des actus gardée d'un jour à l'autre, rubriques comprises ({sorted(deja)})")

# Même sujet sous deux titres : écarté ; deux sujets différents d'une même ville : gardés.
cle = podcast.cle_titre
verifier(podcast.meme_sujet(cle("Reprise du trafic ferroviaire entre Yverdon et Lausanne dimanche"),
                            cle("Trafic ferroviaire entre Lausanne et Yverdon repris dimanche matin")), "même sujet, titre reformulé")
verifier(podcast.meme_sujet(cle("Aux Saintes-Maries-de-la-Mer, un pèlerinage populaire"),
                            cle("Le pèlerinage des gens du voyage aux Saintes-Maries-de-la-Mer, entre foi et retrouvailles")), "même pèlerinage")
verifier(not podcast.meme_sujet(cle("Yverdon-les-Bains : 144 arbres doivent être abattus"),
                                cle("Yverdon-les-Bains : une altercation n'était pas une chasse aux dealers")), "même ville, sujets différents")
_vus = {cle("Reprise du trafic ferroviaire entre Yverdon et Lausanne dimanche")}
_arts = [podcast.Article(titre=t, resume="", lien="", source="x") for t in
         ("Trafic ferroviaire entre Lausanne et Yverdon repris dimanche matin", "Yverdon : nouvelle piscine", "Yverdon : marché de Noël", "Yverdon : budget 2027")]
_gardes = podcast.garder_nouveaux(_arts, _vus, 2)
verifier([a.titre for a in _gardes] == ["Yverdon : nouvelle piscine", "Yverdon : marché de Noël"], "nouveaux seulement, au plus deux")

# Déplacements : les lieux déjà présentés et les idées déjà proposées sont retenus.
memlieux = {"lieux_presentes": []}
podcast.retenir_lieux(memlieux, [{"lieu": "Arles et Les Saintes-Maries-de-la-Mer", "evenement": "Camargue"}],
                      ["arènes d'Arles", "musée Réattu"], dt.datetime(2026, 10, 18, 7, tzinfo=dt.timezone.utc))
podcast.retenir_lieux(memlieux, [{"lieu": "Les Saintes-Maries-de-la-Mer", "evenement": "Camargue"}],
                      ["promenade en bateau sur le Petit-Rhône"], dt.datetime(2026, 10, 19, 7, tzinfo=dt.timezone.utc))
verifier(len(memlieux["lieux_presentes"]) == 1, f"même déplacement sous deux noms : une seule fiche ({memlieux})")
deja_lieu = podcast.lieu_deja_presente(memlieux, {"lieu": "Camarkas, Saintes Maries de la Mer", "evenement": "Séjour"},
                                       dt.datetime(2026, 10, 20, 7, tzinfo=dt.timezone.utc))
verifier(deja_lieu and len(deja_lieu["dates"]) == 2 and "musée Réattu" in deja_lieu["idees"], f"lieu reconnu, idées déjà proposées connues ({deja_lieu})")
texte_deja = podcast.deja_presente_en_mots(deja_lieu, dt.datetime(2026, 10, 20, 7, tzinfo=dt.timezone.utc))
verifier("2 épisodes" in texte_deja and "hier" in texte_deja and "promenade en bateau" in texte_deja, texte_deja)
verifier(not podcast.lieu_deja_presente(memlieux, {"lieu": "Genève", "evenement": "Réunion"}, dt.datetime(2026, 10, 20, 7, tzinfo=dt.timezone.utc)),
         "autre lieu : rien de déjà dit")
verifier(not podcast.lieu_deja_presente(memlieux, {"lieu": "Les Saintes-Maries-de-la-Mer", "evenement": "Camargue"},
                                        dt.datetime(2026, 10, 18, 9, tzinfo=dt.timezone.utc)), "épisode refait le même jour : rien de déjà dit")

# Corrections de contenu : fêtes, actus sans lieu, pas d'itinéraire hors sortie.
class SourcesFetes(FaussesSources):
    def fetes(self, jour):
        return ["Nations unies : journée mondiale du lavage des mains"]
def rubrique(titre, consigne, sources_):
    return {"id": "R9", "titre": titre, "consigne": consigne, "etat": "active", "importance": "normale",
            "recherche": {"fiche": {}, "sources": sources_, "requetes": []}}
# Seules les sources cochées sont lues (depuis Réglages › Sources : plus d'ajout d'après le titre).
r_prenom = rubrique("Fête du prénom", "Trouver les prénoms de la fête d'aujourd'hui", ["saints"])
cp = moteur.collecter(r_prenom, moteur.plan_par_defaut(r_prenom, "Yverdon-les-Bains"), SourcesFetes(), jeudi, "Yverdon-les-Bains")
verifier("Prénom fêté aujourd'hui" in cp.texte, "fête du prénom : source « prénoms » cochée, lue")
r_web = rubrique("Fête du prénom", "Trouver les prénoms de la fête d'aujourd'hui", ["web"])
cw = moteur.collecter(r_web, moteur.plan_par_defaut(r_web, "Yverdon-les-Bains"), SourcesFetes(), jeudi, "Yverdon-les-Bains")
verifier("Prénom fêté aujourd'hui" not in cw.texte and "[W1]" in cw.texte, "recherche web seule cochée : pas de prénoms ajoutés en douce")
r_intl = rubrique("Fête internationale", "Fête internationale", ["web", "fetes"])
ci = moteur.collecter(r_intl, moteur.plan_par_defaut(r_intl, "Yverdon-les-Bains"), SourcesFetes(), jeudi, "Yverdon-les-Bains")
verifier("journée mondiale du lavage des mains" in ci.texte and "[W1]" in ci.texte, "fête internationale : journées cochées + recherche web même sans requête")
# Catégorie retirée dans Réglages › Sources : jamais lue, même cochée.
config_coupee = {"sources": {"coupees": ["web"], "flux": []}}
cc = moteur.collecter(r_intl, moteur.plan_par_defaut(r_intl, "Yverdon-les-Bains"), SourcesFetes(), jeudi, "Yverdon-les-Bains", config=config_coupee)
verifier("journée mondiale du lavage des mains" in cc.texte and "[W1]" not in cc.texte, "recherche web retirée : pas lue")
verifier(moteur.sources_lues({"recherche": {"sources": ["web", "flux:abcd1234", "flux:retire1"]}},
                             {"sources": {"coupees": ["web"], "flux": [{"id": "abcd1234", "nom": "Optique", "url": "https://x/rss"}]}}) == {"flux:abcd1234"},
         "sources lues : sans catégorie retirée ni flux supprimé")
# Flux spécialisé et agenda cochés.
lus_flux = []
r_flux = rubrique("Tech optique", "Les nouveautés de l'optique", ["flux:abcd1234", "agenda"])
cf = moteur.collecter(r_flux, moteur.plan_par_defaut(r_flux, "Yverdon-les-Bains"), SourcesFetes(), jeudi, "Yverdon-les-Bains",
                      config={"sources": {"coupees": [], "flux": [{"id": "abcd1234", "nom": "Optique.ch", "url": "https://x/rss"}]}},
                      lire_flux=lambda f: lus_flux.append(f["nom"]) or ["Un laser record (https://x/1)"], agenda=["jeu. 22 : réunion"])
verifier(lus_flux == ["Optique.ch"] and "Flux « Optique.ch »" in cf.texte and "Un laser record" in cf.texte and "réunion" in cf.texte
         and "[W1]" not in cf.texte, "flux spécialisé et agenda cochés : lus, rien d'autre")
# Site de référence coché : la recherche web se limite à lui (sans recherche web générale).
config_sites = {"sources": {"coupees": [], "flux": [], "sites": [{"id": "labo1234", "nom": "Le labo", "domaine": "labo.ch"}]}}
r_site = rubrique("Labo", "Les nouvelles du labo", ["site:labo1234", "site:retire99"])
fs = FaussesSources()
cs = moteur.collecter(r_site, moteur.plan_par_defaut(r_site, ""), fs, jeudi, "", config=config_sites)
verifier(fs.appels == [("web", "Les nouvelles du labo", ("labo.ch",))] and "Sur ses sites de référence (Le labo)" in cs.texte and "[S1]" in cs.texte
         and "[W1]" not in cs.texte and any("grottesdevallorbe" in u for _, u in cs.liens), f"site de référence : recherche limitée à son domaine ({fs.appels})")
verifier(moteur.sources_lues(r_site, config_sites) == {"site:labo1234"}, "site retiré : pas lu")
cs2 = moteur.collecter(r_site, moteur.plan_par_defaut(r_site, ""), sources.Sources(""), jeudi, "", config=config_sites)
verifier("sans clé Tavily (Réglages › Sources › Services)" in cs2.texte, "site sans clé Tavily : dit pourquoi")
# Un seul agenda coché : la rubrique ne voit que ses événements.
Ev = podcast.Evenement
evs = [Ev("Match de foot", dt.datetime(2026, 10, 23, 18, 0, tzinfo=dt.timezone.utc), None, False, agenda="sport00001"),
       Ev("Dentiste", dt.datetime(2026, 10, 23, 9, 0, tzinfo=dt.timezone.utc), None, False, agenda="perso00001")]
r_tous = rubrique("Rappel", "Rappelle-moi", ["agenda"])
r_sport = rubrique("Sac de foot", "Rappelle-moi le sac", ["agenda:sport00001"])
r_sport["id"] = "R8"
plans_ag, textes_ag = moteur.planifier_par_agendas([r_tous, r_sport], evs, lambda e: e.debut.strftime("%a %H:%M"), jeudi, "", None)
verifier(len(textes_ag[r_tous["id"]]) == 2 and len(textes_ag["R8"]) == 1 and "Match" in textes_ag["R8"][0] and set(plans_ag) == {r_tous["id"], "R8"},
         f"agendas choisis par rubrique : {textes_ag}")
verifier(moteur.agendas_choisis(r_sport) == frozenset({"sport00001"}) and moteur.agendas_choisis(r_tous) is None
         and moteur.sources_lues(r_sport, {}) == {"agenda:sport00001"}, "un agenda précis est une source lue")
ca = moteur.collecter(r_sport, moteur.plan_par_defaut(r_sport, ""), FaussesSources(), jeudi, "", agenda=textes_ag["R8"])
verifier("seulement les agendas choisis" in ca.texte and "Match de foot" in ca.texte and "Dentiste" not in ca.texte, "collecte : seulement son agenda")
verifier(not ci.itineraire and not ci.lieux and not ci.point, "pas d'itinéraire ni de lieux pour une rubrique sans lieu")
r_pt = rubrique("Actualité Portugal", "Cherche l'actualité à propos du Portugal", ["actus"])
sujets_actus = []
moteur.collecter(r_pt, moteur.plan_par_defaut(r_pt, "Yverdon-les-Bains"), FaussesSources(), jeudi, "Yverdon-les-Bains",
                 lambda q: sujets_actus.append(q) or [])
verifier(sujets_actus == ["Cherche l'actualité à propos du Portugal"], f"actus Portugal : sujet = la consigne, pas la ville ({sujets_actus})")
import pays
feries = sources.feries(dt.date(2026, 12, 20), 14)
verifier([nom for _, nom in feries] == ["Noël", "Nouvel An", "Saint-Berchtold"], f"fériés vaudois de fin d'année : {feries}")
pays.definir("FR", "FR")
feries_fr = sources.feries(dt.date(2026, 11, 1), 14)
verifier({d for d, _ in feries_fr} == {dt.date(2026, 11, 1), dt.date(2026, 11, 11)}, f"fériés français de novembre : {feries_fr}")
verifier(pays.feries_calcules(2027, "FR")[1] == (dt.date(2027, 3, 29), "Lundi de Pâques"), "fériés français calculés sans bibliothèque")
verifier("Vercors" in moteur.consigne_plan(jeudi, "Lyon") and "en France" in moteur.consigne_plan(jeudi, "Lyon"), "consigne de planification à la française")
pays.definir("CH")
verifier("Suisse romande" in moteur.consigne_plan(jeudi, "Yverdon"), "consigne de planification suisse par défaut")
sans_cle = sources.Sources("")
verifier(sans_cle.web("test") == {"resultats": [], "images": []}, "sans clé Tavily : pas de recherche web")
verifier(sources.lien_itineraire("Yverdon", "Lausanne", "voiture").endswith("travelmode=driving"), "itinéraire en voiture")
verifier(sources.Sources.trajets_en_mots([]) == "" and sources.Sources.meteo_en_mots(None) == "", "sources vides sans erreur")

# ───────────────────────── 6. déroulé et consigne ───────────────────────────
print("\n6. Déroulé, consigne et script")
collectes = {"R1": c1, "R2": c}
c3 = moteur.collecter(config_bot()["regles"][2], {"applique": True, "evenement": "Match vendredi"}, FaussesSources(), jeudi, "")
collectes["R3"] = c3
actifs = {"deplacements": False, "approfondissements": True, "actualites": True}
rubriques = moteur.deroule_du_jour({"deroule": e["deroule"]}, collectes, actifs)
verifier([cle for cle, _ in rubriques] == ["ouverture", "agenda", "R1", "R2", "approfondissements", "actualites", "cloture"],
         f"ordre du déroulé : {[cle for cle, _ in rubriques]}")
c5 = moteur.collecter(config_bot()["regles"][4], moteur.plan_par_defaut(config_bot()["regles"][4], ""), FaussesSources(), jeudi, "")
rubriques_bis = moteur.deroule_du_jour({"deroule": e["deroule"]}, {**collectes, "R5": c5}, actifs)
verifier("R5" not in [cle for cle, _ in rubriques_bis], "rubrique suspendue par l'auditeur : pas réinsérée")
orpheline = {"R9": moteur.Collecte(regle={"id": "R9", "rubrique": {"titre": "Citation"}}, plan={})}
verifier([cle for cle, _ in moteur.deroule_du_jour({"deroule": e["deroule"]}, orpheline, actifs)][2] == "R9",
         "rubrique absente du déroulé : placée après l'agenda")
consigne = podcast.consigne_systeme(e, rubriques, collectes)
verifier("3. « Saint du jour » (rubrique R1) : Dire le saint du jour. Longueur : une seule phrase." in consigne, "rubrique de R1 à sa place")
verifier("4. « Idées pour samedi » (rubrique R2)" in consigne and "développée (6 à 10 répliques)" in consigne, "rubrique développée de R2")
verifier("- R3 : Rappeler de préparer le sac de foot." in consigne, "règle sans rubrique à intégrer")
verifier("Vouvoie l'auditeur, qui s'appelle Daniel" in consigne and "Beaucoup d'humour" in consigne, "vouvoiement, prénom, ton")
verifier("Cite brièvement la source" not in consigne and "Consigne de style de l'auditeur, pour tout l'épisode, à respecter : toujours un point sur Yverdon" in consigne,
         "consignes de style pour tout l'épisode, plus de sources citées à l'oral")
ligne = lambda cle: next(l for l in consigne.splitlines() if l[:3].rstrip(". ").isdigit() and (cle in l))
verifier("Consignes de l'auditeur pour cette rubrique, à respecter : Ne parle de la piscine que la veille." in ligne("L'agenda"),
         "consignes de l'agenda dans sa ligne du déroulé")
verifier(all(x in ligne("Les actualités") for x in ("Thèmes préférés de l'auditeur : vélo", "Thèmes qui ne l'intéressent pas : sport",
                                                     "à respecter : Commence par l'économie.")),
         "actualités globales : thèmes et consignes dans leur ligne")
verifier("Thèmes préférés" not in consigne.split("Style et règles")[1], "les thèmes ne sont plus des règles de tout l'épisode")
locale = podcast.consigne_systeme(e, [("actu_locale", "Actu locale")], {})
verifier("3 informations au plus de Yverdon-les-Bains" in locale and "Thèmes préférés de l'auditeur : travaux" in locale
         and "Thèmes qui ne l'intéressent pas : faits divers" in locale and "vélo" not in locale,
         "actu locale : nombre de sujets et ses propres thèmes")
verifier("parmi ouverture, agenda, R1, R2, approfondissements, actualites, cloture" in consigne, "liste des rubriques pour les chapitres")
verifier("DÉPLACEMENTS" not in consigne.split("Style et règles")[0], "rubrique désactivée absente")
verifier(podcast.minutes_visees(e, collectes) == 5.5, f"durée : 4 min + 1 (approfondissement) + 0,5 (rubrique développée) = {podcast.minutes_visees(e, collectes)}")
cles = [cle for cle, _ in rubriques]
schema = podcast.schema_script(["Léa", "Hugo"], cles)
verifier(schema["properties"]["repliques"]["items"]["properties"]["rubrique"]["enum"] == cles, "rubrique demandée pour chaque réplique")
brut = {"titre": "Mardi", "sujets": ["a"], "sources": [], "repliques": [
    {"animateur": "Léa", "texte": "Bonjour !", "rubrique": "ouverture"},
    {"animateur": "Hugo", "texte": "Salut.", "rubrique": "inconnue"},
    {"animateur": "Hugo", "texte": "L'agenda.", "rubrique": "agenda"},
    {"animateur": "Léa", "texte": "Saint Bruno.", "rubrique": "R1"},
    {"animateur": "Hugo", "texte": "Les actus.", "rubrique": "actualites"},
    {"animateur": "Léa", "texte": "À demain.", "rubrique": "cloture"}]}
script = podcast.nettoyer_script(brut, ["Léa", "Hugo"], cles)
verifier([r["rubrique"] for r in script["repliques"]] == ["ouverture", "ouverture", "agenda", "R1", "actualites", "cloture"],
         "rubrique inconnue → celle d'avant ; même animateur, autre rubrique : pas fusionnés")
chapitres = podcast.calculer_chapitres(script, [0.3, 2.0, 4.1, 9.6, 15.2, 61.8], rubriques)
verifier(chapitres == [(0.0, "Ouverture"), (4.1, "Agenda"), (9.6, "Saint du jour"), (15.2, "Actualités globales"), (61.8, "Clôture")],
         f"chapitres : {chapitres}")
verifier(podcast.minute_seconde(61.8) == "1:02" and podcast.minute_seconde(0) == "0:00", "minutage lisible")
verifier(podcast.calculer_chapitres(script, [0.0], rubriques) == [], "minutage incomplet : pas de chapitres")
jpeg = creer_pochette(jeudi, "Grottes, grève et saint Géraud : un jeudi bien rempli pour finir la semaine")
verifier(jpeg and jpeg[:2] == b"\xff\xd8" and len(jpeg) < 200_000, f"pochette JPEG ({len(jpeg or b'')} octets)")
from PIL import Image  # noqa: E402
verifier(Image.open(io.BytesIO(jpeg)).size == (320, 320), "pochette 320 × 320")

# ───────────────────────── 7. épisode complet (faux réseau) ──────────────────
print("\n7. Épisode complet avec le bot")


class Reponse:
    def __init__(self, statut, donnees=None, contenu=None):
        self.status_code = statut
        self._donnees = donnees
        self.content = contenu if contenu is not None else json.dumps(donnees or {}).encode()
        self.text = self.content.decode("utf-8", "replace")
        self.headers = {}

    def json(self):
        if self._donnees is None:
            raise ValueError("pas de JSON")
        return self._donnees

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.HTTPError(response=self)


def pcm(secondes):
    return b"".join(struct.pack("<h", int(6000 * math.sin(i / 8))) for i in range(int(secondes * 24000)))


def texte_gemini(objet):
    return Reponse(200, {"status": "completed", "steps": [{"type": "model_output", "content": [{"type": "text", "text": json.dumps(objet, ensure_ascii=False)}]}]})


EXPORT = {"format": "bot-v2", "version": "test", "config": config_bot(), "aujourdhui": "2026-10-15",
          "heure_prevue_aujourdhui": "06:45", "episode_envoye_aujourdhui": False,
          "derniers_resultats": {"regles": ["R2"], "idees": ["Juraparc"]}}
etat = {"appels": [], "bot_joignable": True, "evenements": []}
SECRET_GH = liaison.secret_partage("gh-jeton-test")      # dérivé du jeton GitHub du bot
SECRETS = {SECRET_GH}


def faux_get(url, timeout=None, headers=None, params=None):
    etat["appels"].append(("GET", url))
    if url.endswith("/api/config"):
        if not etat["bot_joignable"]:
            return Reponse(503, contenu=b"indisponible")
        if (headers or {}).get("X-Podcast-Secret") not in SECRETS:
            return Reponse(403, contenu=b"interdit")
        etat["secret_vu"] = headers["X-Podcast-Secret"]
        return Reponse(200, json.loads(json.dumps(EXPORT)))
    if "rss" in url or "news.google" in url:
        return Reponse(200, contenu=b"<rss><channel><title>T</title><item><title>Budget vaudois adopt\xc3\xa9</title><link>https://exemple.ch/1</link><description>Le Grand Conseil a vot\xc3\xa9.</description></item></channel></rss>")
    return Reponse(404, contenu=b"")


def faux_post(url, json=None, data=None, files=None, timeout=None, headers=None):
    etat["appels"].append(("POST", url, json if json is not None else data, files))
    if url.endswith("/api/evenement"):
        assert headers["X-Podcast-Secret"] in SECRETS
        etat["evenements"].append(json)
        return Reponse(200, {"ok": True})
    if "generativelanguage" in url:
        modele = json["model"]
        if modele.endswith("-tts"):
            secondes = sum(len(c["text"]) for c in json["input"][0]["content"]) / 16
            return Reponse(200, {"status": "completed", "steps": [{"type": "model_output", "content": [
                {"type": "audio", "data": base64.b64encode(pcm(secondes)).decode(), "mime_type": "audio/l16", "sample_rate": 24000}]}]})
        systeme = json["system_instruction"]
        if "Tu prépares les règles" in systeme:
            return texte_gemini({"regles": [{"id": "R3", "applique": True, "evenement": "Match vendredi 16"},
                                            {"id": "R2", "applique": True, "date_cible": "2026-10-17", "requetes": ["sortie enfants Vallorbe"],
                                             "lieux": ["Vallorbe"], "categories": ["grotte"]}]})
        if "Tu organises des sorties" in systeme:
            assert "Ne repropose pas : Juraparc" in systeme
            return texte_gemini({"intro": "Samedi s'annonce pluvieux : plutôt sous terre !", "conseil": "Prévoir une petite laine.",
                                 "resume_partage": "Samedi : grottes de Vallorbe avec les enfants ? 12 CHF par enfant, train à 9 h 04.",
                                 "idees": [{"titre": "Grottes de Vallorbe", "resume": "Rivière souterraine. Visite d'une heure.", "pourquoi": "Idéal par temps de pluie.",
                                            "prix": "22 CHF adulte, 12 CHF enfant", "dans_le_budget": True, "duree": "1 h 30", "horaires": "9 h 30 – 17 h",
                                            "lieu": "Grottes de Vallorbe", "adresse": "", "lien": "https://www.grottesdevallorbe.ch/tarifs", "source": "grottesdevallorbe.ch", "acces": "Train jusqu'à Vallorbe."},
                                           {"titre": "Musée du Fer", "resume": "Forge et chemin de fer.", "pourquoi": "Au sec.", "prix": "prix à vérifier",
                                            "dans_le_budget": False, "duree": "1 h", "horaires": "", "lieu": "Musée du Fer", "adresse": "", "lien": "https://inventé.example/musee",
                                            "source": "", "acces": ""}]})
        if "mini-podcast" in systeme:
            return texte_gemini({"titre": "Sous terre samedi", "sujets": ["Grottes"], "sources": [], "repliques": [
                {"animateur": "Léa", "texte": "Bonjour Daniel ! Samedi, on vous emmène sous terre."},
                {"animateur": "Hugo", "texte": "Les grottes de Vallorbe : douze francs par enfant."},
                {"animateur": "Léa", "texte": "Et le musée du fer, juste à côté."},
                {"animateur": "Hugo", "texte": "Tout est dans l'application !"}]})
        assert "Tu écris le script" in systeme, systeme[:80]
        assert "« Saint du jour » (rubrique R1)" in systeme and "« Idées pour samedi » (rubrique R2)" in systeme
        demande = json["input"] if isinstance(json["input"], str) else str(json["input"])
        assert "=== RUBRIQUE R2 ===" in demande and "Grottes de Vallorbe" in demande and "=== RUBRIQUE R3 ===" in demande
        return texte_gemini({"titre": "Grottes et saint du jour", "sujets": ["Budget vaudois"], "sources": [1], "repliques": [
            {"animateur": "Léa", "texte": "Bonjour Daniel, nous sommes jeudi 15 octobre.", "rubrique": "ouverture"},
            {"animateur": "Hugo", "texte": "Votre agenda est léger aujourd'hui.", "rubrique": "agenda"},
            {"animateur": "Léa", "texte": "On fête aujourd'hui sainte Thérèse.", "rubrique": "R1"},
            {"animateur": "Hugo", "texte": "Samedi, direction les grottes de Vallorbe avec les enfants, il va pleuvoir.", "rubrique": "R2"},
            {"animateur": "Léa", "texte": "Et pensez au sac de foot pour le match de demain !", "rubrique": "R2"},
            {"animateur": "Hugo", "texte": "Côté actualité, le budget vaudois est adopté, selon la RTS.", "rubrique": "actualites"},
            {"animateur": "Léa", "texte": "Belle journée à vous !", "rubrique": "cloture"}]})
    return Reponse(404, {"ok": False})


def faux_put(url, params=None, data=None, timeout=None, headers=None):
    etat["appels"].append(("PUT", url, (params or {}).get("nom"), data, (headers or {}).get("Content-Type")))
    if url.endswith("/api/fichier") and (headers or {}).get("X-Podcast-Secret") in SECRETS and etat.get("stockage", True):
        return Reponse(200, {"ok": True, "nom": params["nom"], "taille": len(data)})
    return Reponse(404, contenu=b"introuvable")


podcast.requests.get = faux_get
podcast.requests.post = faux_post
podcast.requests.put = faux_put
podcast.time.sleep = lambda s: None
podcast.Sources = FaussesSources
recherche.Sources = FaussesSources
podcast.heure_actuelle = lambda fuseau: dt.datetime(2026, 10, 15, 6, 40, tzinfo=ZH).astimezone(fuseau)
os.environ.update({"GEMINI_API_KEY": "cle-test", "BOT_GITHUB_TOKEN": "gh-jeton-test",
                   "CALENDAR_ICS_URL": "", "BOT_URL": "https://bot.exemple", "TAVILY_API_KEY": "tvly-test"})
for cle_env in ("MODE", "REGLES", "RATTRAPAGE", "ESSAI_SUIVANT", "RECHERCHE", "FORMAT", "ECHANTILLONS"):
    os.environ.pop(cle_env, None)
MEMOIRE.write_text(json.dumps({"dernier_episode": {"date": "2026-10-14", "envoye_le": "2026-10-14T06:46"}}), encoding="utf-8")

code = podcast.main(["--mode", "planifie"])
verifier(code == 0, f"épisode planifié sans erreur (code {code})")
verifier(etat.get("secret_vu") == SECRET_GH, "réglages lus avec le secret du jeton GitHub")
ev = [x for x in etat["evenements"] if x["type"] == "episode"][-1]
verifier(ev["type"] == "episode" and isinstance(ev["ref"], int) and 0 < ev["ref"] < 240000 and ev["mode"] == "planifie"
         and "message_id" not in ev and "file_id" not in ev, f"événement envoyé au bot (repère {ev.get('ref')})")
verifier(ev["regles"] == ["R1", "R2", "R3"] and ev["details"] == ["R2"] and ev["debut"] == "2026-10-15T06:40", f"règles appliquées : {ev['regles']}")
titres_chapitres = [t for _, t in ev["chapitres"]]
verifier(len(ev["chapitres"]) >= 4 and ev["chapitres"][0] == [0, "Ouverture"] and "Saint du jour" in titres_chapitres and "Idées pour samedi" in titres_chapitres
         and "Léa : Bonjour Daniel" in ev["transcription"], f"chapitres et texte transmis : {titres_chapitres}")
verifier(any(x["url"] == "https://exemple.ch/1" for x in ev["sources"]), "sources de l'épisode transmises")
verifier(ev["sujets"] == ["Budget vaudois"] and ev["nombre_sujets"] == 1, "sujets à creuser")
depots = [a for a in etat["appels"] if a[0] == "PUT"]
verifier(len(depots) == 2 and re.fullmatch(r"2026-10/2026-10-15-\d{6}\.mp3", depots[0][2] or "") and depots[0][4] == "audio/mpeg"
         and depots[0][3][:1] == b"\xff" and depots[1][2] == depots[0][2].replace(".mp3", ".jpg") and depots[1][3][:2] == b"\xff\xd8",
         f"MP3 et pochette confiés au bot : {[d[2] for d in depots]}")
verifier(ev["audio"] == depots[0][2] and ev["pochette"] == depots[1][2], "le bot sait où il les garde")
gemini = [a[2] for a in etat["appels"] if a[0] == "POST" and "generativelanguage" in a[1]]
planif = [g for g in gemini if "Tu prépares les règles" in g.get("system_instruction", "")]
verifier(len(planif) == 1 and planif[0]["model"] == "gemini-3.5-flash-lite", "planification par le modèle léger (un appel)")
verifier(not any("Tu repères dans l'agenda" in g.get("system_instruction", "") for g in gemini), "déplacements désactivés : aucun appel")
verifier(not any("tvly" in json.dumps(g) or "gh-jeton" in json.dumps(g) for g in gemini), "aucun secret envoyé à Gemini")
mem = json.loads(MEMOIRE.read_text(encoding="utf-8"))
verifier(mem["dernier_programme"] == "2026-10-15" and mem["dernier_episode"]["regles"] == ["R1", "R2", "R3"], "mémoire à jour")

etat["appels"].clear()
code = podcast.main(["--mode", "rattrapage"])
verifier(code == 0 and not [a for a in etat["appels"] if a[0] == "POST" and "generativelanguage" in a[1]], "rattrapage inutile : rien de refait")
code = podcast.main(["--mode", "planifie"])
verifier(code == 0 and not [a for a in etat["appels"] if a[0] == "POST" and "generativelanguage" in a[1]], "double lancement planifié : ignoré")

# Le bot ne peut pas garder l'épisode : échec clair, signalé au bot.
etat["stockage"] = False
etat["appels"].clear()
etat["evenements"].clear()
code = podcast.main(["--mode", "manuel"])
echec = [x for x in etat["evenements"] if x["type"] == "echec"]
verifier(code == 1 and echec and "rien n'est parti" in echec[-1]["message"] and not [x for x in etat["evenements"] if x["type"] == "episode"],
         "le bot ne garde pas l'épisode : échec clair, signalé au bot")
etat["stockage"] = True

# Épisode à la demande sur une règle ponctuelle (R6), bot injoignable → sauvegarde.
etat["appels"].clear()
etat["bot_joignable"] = False
(RACINE_TEST / "preferences.json").write_text(json.dumps({"format": "bot-v2", "config": config_bot()}), encoding="utf-8")
nb_ev = len(etat["evenements"])
code = podcast.main(["--mode", "manuel", "--regles", "R2"])
verifier(code == 0, "épisode à la demande avec la sauvegarde du bot")
verifier(len(etat["evenements"]) == nb_ev + 1 and etat["evenements"][-1]["mode"] == "manuel", "mode manuel signalé au bot")
etat["bot_joignable"] = True

# Échec planifié : le message annonce le rattrapage du bot.
etat["appels"].clear()
MEMOIRE.write_text(json.dumps({}), encoding="utf-8")
ancien_post = podcast.requests.post


def post_gemini_muet(url, **kw):
    if "generativelanguage" in url:
        return Reponse(503, {"error": {"message": "overloaded"}})
    return ancien_post(url, **kw)


podcast.requests.post = post_gemini_muet
code = podcast.main(["--mode", "planifie"])
podcast.requests.post = ancien_post
echec = [x for x in etat["evenements"] if x["type"] == "echec"]
verifier(code == 0 and echec and "raté pour l'instant" in echec[-1]["titre"] and "Nouvel essai automatique à 7 h 45" in echec[-1]["message"],
         "échec planifié : notification, rattrapage annoncé à 7 h 45 (heure prévue + 1 h)")

# ───────────────────────── 8. recherche et extraits ─────────────────────────
print("\n8. Résultats de recherche, mini-podcast, extraits de voix")
etat["appels"].clear()
etat["evenements"].clear()
code = podcast.main(["--recherche", "R2", "--format", "ecrit"])
verifier(code == 0, "recherche écrite sans erreur")
ev = etat["evenements"][-1]
verifier(ev["type"] == "recherche" and ev["format"] == "ecrit" and ev["idees"] == ["Grottes de Vallorbe", "Musée du Fer"] and "sondage" not in ev,
         "événement de recherche envoyé au bot (les idées)")
idees = ev["resultats"][0]["idees"]
verifier(ev["resultats"][0]["intro"].startswith("Samedi s'annonce pluvieux") and idees[0]["prix"] == "22 CHF adulte, 12 CHF enfant" and idees[0]["dans_le_budget"]
         and idees[0]["lien"] == "https://www.grottesdevallorbe.ch/tarifs", "idée complète pour l'application : prix, budget, lien")
verifier(idees[1]["lien"] == "" and "inventé.example" not in json.dumps(ev, ensure_ascii=False), "lien inventé par le modèle retiré")

etat["appels"].clear()
etat["evenements"].clear()
code = podcast.main(["--recherche", "R2", "--format", "audio"])
rech = [x for x in etat["evenements"] if x["type"] == "recherche"]
verifier(code == 0 and rech and re.fullmatch(r"\d{4}-\d{2}/idees-[\d-]+\.mp3", rech[-1]["audio"] or "") and rech[-1]["titre_audio"] == "Sous terre samedi"
         and rech[-1]["format"] == "audio", f"mini-podcast d'idées : gardé par le bot ({rech[-1].get('audio') if rech else None})")

etat["appels"].clear()
etat["evenements"].clear()
code = podcast.main(["--echantillons", "Aoede,kore,Inconnue,Puck"])
tts = [a for a in etat["appels"] if a[0] == "POST" and "generativelanguage" in a[1]]
verifier(code == 0 and len(tts) == 2, f"deux voix par requête : {len(tts)} requêtes pour 3 voix")
extraits = [e_ for e_ in etat["evenements"] if e_["type"] == "echantillon"]
verifier([e_["voix"] for e_ in extraits] in (["Aoede", "Kore", "Puck"], ["Kore", "Aoede", "Puck"]) and
         extraits[0]["fichier"] == extraits[1]["fichier"] and "file_id" not in extraits[0], "extraits signalés au bot (même fichier pour la paire)")
depots = [a[2] for a in etat["appels"] if a[0] == "PUT"]
verifier(len(depots) == 2 and all(re.fullmatch(r"voix/[A-Z][a-z]+-[A-Z][a-z]+-\d+\.mp3", d) for d in depots)
         and extraits[0]["fichier"] == extraits[1]["fichier"] == depots[0], f"extraits gardés par le bot : {depots}")
verifier(recherche.valider_lien("https://www.grottesdevallorbe.ch/autre", {"https://www.grottesdevallorbe.ch/tarifs"})
         == "https://www.grottesdevallorbe.ch/tarifs", "lien du même site → page de la source")

# ───────────────────────── 9. réponse illisible ─────────────────────────────
print("\n9. Réponse illisible de Gemini")
verifier(podcast.analyser_json('{"texte": "ligne 1\nligne 2", "liste": [1, 2,],}') == {"texte": "ligne 1\nligne 2", "liste": [1, 2]},
         "retours à la ligne bruts et virgules finales tolérés")
verifier(podcast.analyser_json('```json\n{"a": 1}\n```\n{"a": 2}') == {"a": 1}, "bloc de code et deux objets à la suite")
try:
    podcast.analyser_json('{"titre": "x", "repliques": [{"texte": "bla')
    verifier(False, "réponse coupée détectée")
except podcast.ReponseIllisible as erreur:
    verifier("coupée avant la fin" in str(erreur) and "Unterminated string" in str(erreur), f"réponse coupée décrite : {erreur}")
essais = []


def post_illisible_puis_bon(url, json=None, **kw):
    essais.append(json["model"])
    texte = '{"ok": true, "repliques": [{"texte": "bla' if len(essais) == 1 else '{"ok": true}'
    return Reponse(200, {"status": "completed", "steps": [{"type": "model_output", "content": [{"type": "text", "text": texte}]}]})


ancien = podcast.requests.post
podcast.requests.post = post_illisible_puis_bon
podcast.ECHEANCE = None
resultat, modele = podcast.demander_json("Tu écris le script", "x", {"type": "object"}, ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"], "cle")
verifier(resultat == {"ok": True} and essais == ["gemini-3.8-flash", "gemini-3.6-flash"] and modele == "gemini-3.6-flash",
         f"réponse coupée → nouvel essai avec le modèle suivant : {essais}")
essais.clear()
podcast.requests.post = lambda url, json=None, **kw: (essais.append(json["model"]) or Reponse(200, {"status": "completed", "steps": [
    {"type": "model_output", "content": [{"type": "text", "text": '{"coupe": "'}]}]}))
try:
    podcast.demander_json("Tu écris le script", "x", {"type": "object"}, ["gemini-3.6-flash", "gemini-3.5-flash-lite"], "cle")
    verifier(False, "deux réponses illisibles signalées")
except podcast.ReponseIllisible as erreur:
    verifier("deux réponses illisibles (gemini-3.6-flash" in str(erreur) and len(essais) == 2, f"deux échecs : message clair ({erreur})")
podcast.requests.post = ancien

print("\n10. Découverte des modèles")
classes = podcast.classer_modeles(["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
                                   "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview", "gemini-flash-latest",
                                   "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview",
                                   "gemini-2.5-pro-preview-tts", "gemini-3.1-flash-image", "gemini-3.8-live"])
verifier(classes["modeles_texte"] == ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"], f"texte : {classes['modeles_texte']}")
verifier(classes["modeles_rapides"] == ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview"], f"rapides : {classes['modeles_rapides']}")
verifier(classes["modeles_voix"] == ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"], f"voix compatibles seulement : {classes['modeles_voix']}")

print("\n11. Agendas listés, actu locale, lieux, rattrapage")
ics_a = (b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//\r\nX-WR-CALNAME:Perso (Google)\r\nBEGIN:VEVENT\r\nUID:1\r\n"
         b"DTSTAMP:20261001T000000Z\r\nDTSTART:20261016T080000Z\r\nDTEND:20261016T090000Z\r\nSUMMARY:Dentiste\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
ics_b = ics_a.replace(b"X-WR-CALNAME:Perso (Google)\r\n", b"").replace(b"Dentiste", "Réunion".encode())
url_a, url_b = "https://calendar.google.com/calendar/ical/secret-a/basic.ics", "https://outlook.office365.com/owa/calendar/secret-b/calendar.ics"
verifier(podcast.nom_agenda(ics_a, url_a, 1) == "Perso (Google)", "nom lu dans le fichier (X-WR-CALNAME)")
verifier(podcast.nom_agenda(ics_b, url_b, 2) == "Outlook", "nom déduit du service quand le fichier n'en donne pas")
identifiant_a = podcast.identifiant_agenda(url_a)
verifier(len(identifiant_a) == 10 and "secret" not in identifiant_a and identifiant_a != podcast.identifiant_agenda(url_b), "identifiant stable, sans l'adresse secrète")
ancien_telechargement = podcast.telecharger
podcast.telecharger = lambda url, *a, **k: ics_a if url == url_a else ics_b
reg = podcast.charger_reglages(RACINE_TEST / "reglages.toml")
maint = dt.datetime(2026, 10, 15, 6, 40, tzinfo=ZH)
tous, _ = podcast.lire_agendas([url_a, url_b], {**reg, "agendas_exclus": []}, maint, 30)
verifier({e_.titre for e_ in tous} == {"Dentiste", "Réunion"} and [a["nb"] for a in podcast.AGENDAS_VUS] == [1, 1], "deux agendas lus et listés")
tous, _ = podcast.lire_agendas([url_a, url_b], {**reg, "agendas_exclus": [identifiant_a]}, maint, 30)
verifier({e_.titre for e_ in tous} == {"Réunion"} and len(podcast.AGENDAS_VUS) == 2, "agenda décoché ignoré, mais toujours listé")
podcast.telecharger = ancien_telechargement

c = config_bot()
c["agenda"].update({"max_deplacements": 3, "exclus": ["abc"]})
c["actus"]["locale_articles"] = 5
e = podcast.effectifs_depuis_bot(podcast.charger_reglages(RACINE_TEST / "reglages.toml"), podcast.memoire_vide(), c)
verifier(e["max_deplacements"] == 3 and e["agendas_exclus"] == ["abc"] and e["locale_articles"] == 5, "réglages des rubriques intégrées lus")
verifier("actu_locale" in moteur.RUBRIQUES and moteur.RUBRIQUES["approfondissements"] == "À creuser", "rubriques intégrées du moteur")
rubriques = moteur.deroule_du_jour({"deroule": [{"cle": "ouverture", "actif": True}, {"cle": "actu_locale", "actif": True}, {"cle": "cloture", "actif": True}]},
                                   {}, {"actu_locale": False})
verifier([k for k, _ in rubriques] == ["ouverture", "cloture"], "actu locale sans article : rubrique sautée")

# Mode --agendas : lit seulement les noms et prévient le bot.
etat["appels"].clear(); etat["evenements"].clear()
podcast.telecharger = lambda url, *a, **k: ics_a if url == url_a else ics_b
os.environ["CALENDAR_ICS_URL"] = f"{url_a}\n{url_b}"
code = podcast.main(["--agendas"])
os.environ["CALENDAR_ICS_URL"] = ""
podcast.telecharger = ancien_telechargement
evt = [x for x in etat["evenements"] if x["type"] == "agendas"]
verifier(code == 0 and evt and [x["nom"] for x in evt[0]["liste"]] == ["Perso (Google)", "Outlook"]
         and not [a for a in etat["appels"] if "generativelanguage" in a[1] and a[0] == "POST"], "--agendas : noms envoyés au bot, sans appel à Gemini")

# Échec avec un rattrapage réglé à 30 minutes.
etat["appels"].clear()
MEMOIRE.write_text(json.dumps({}), encoding="utf-8")
podcast.requests.post = lambda url, **kw: Reponse(503, {"error": {"message": "overloaded"}}) if "generativelanguage" in url else ancien_post(url, **kw)
EXPORT["config"]["planning"]["delai_rattrapage"] = 30
code = podcast.main(["--mode", "planifie"])
EXPORT["config"]["planning"].pop("delai_rattrapage")
podcast.requests.post = ancien_post
echec = [x for x in etat["evenements"] if x["type"] == "echec"]
verifier(code == 0 and echec and "Nouvel essai automatique à 7 h 15" in echec[-1]["message"],
         "échec planifié avec rattrapage à 30 min : annoncé à 7 h 15")

# ───────────────────────── 12. sans jeton GitHub du bot ──────────────────────
print("\n12. Sans jeton GitHub du bot")
jeton_avant = os.environ.pop("BOT_GITHUB_TOKEN", None)
etat["appels"].clear()
code = podcast.main(["--mode", "manuel"])
verifier(code == 1 and not [a for a in etat["appels"] if a[0] == "POST" and "generativelanguage" in a[1]],
         "sans jeton GitHub du bot : échec clair, rien de préparé pour rien")
os.environ["BOT_GITHUB_TOKEN"] = jeton_avant or ""
print()

# ───────────── 5 quater. pays : tous les pays proposés, « Pas renseigné » ─────────────
print("\n5 quater. Pays (donnees/pays.json)")
import pays as _pays
verifier(len(_pays.PROFILS) > 150 and {"CH", "FR", "BE", "JP", "BR", "--"} <= set(_pays.PROFILS), f"{len(_pays.PROFILS)} profils, dont la Suisse, la France, la Belgique et « Pas renseigné »")
verifier(all(p_.get("fuseau") and p_.get("devise") and p_.get("flux") and p_.get("nom") for p_ in _pays.PROFILS.values()), "chaque profil a nom, fuseau, devise et média")
verifier(all(dt.datetime.now(dt.timezone.utc).astimezone(__import__("zoneinfo").ZoneInfo(p_["fuseau"])) for p_ in _pays.PROFILS.values()), "tous les fuseaux existent")
verifier(_pays.PROFILS["JP"]["fuseau"] == "Asia/Tokyo" and _pays.PROFILS["JP"]["devise"] == "JPY" and _pays.PROFILS["JP"]["feries"] == "JP", "Japon : Tokyo, yen")
verifier(not any(_pays.PROFILS[c].get("auto") for c in ("CH", "FR", "BE")) and all(p_.get("auto") for c, p_ in _pays.PROFILS.items() if c not in ("CH", "FR", "BE", "--")),
         "CH, FR, BE écrits à la main ; les autres profils marqués « auto »")
_pays.definir("--", "--", "Europe/Paris")
verifier(_pays.profil()["fuseau"] == "Europe/Paris" and _pays.feries(dt.date(2026, 12, 20), 10) == [], "pas de pays : l'heure du pays d'avant, aucun jour férié")
_pays.definir("JP", "JP")
verifier(dt.date(2026, 11, 3) in [d for d, _ in _pays.feries(dt.date(2026, 11, 1), 10)] and _pays.profil()["fuseau"] == "Asia/Tokyo", "Japon : fériés de la bibliothèque (3 novembre)")
_pays.definir("CH", "CH-VD")

if echecs:
    print(f"{len(echecs)} ÉCHEC(S) :")
    for message in echecs:
        print(" -", message)
    sys.exit(1)
print("Tous les tests de la version 3 passent ✅")

