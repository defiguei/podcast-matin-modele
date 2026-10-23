"""Sources d'informations gratuites pour les règles et les recherches.

Chaque fonction est tolérante : en cas de panne elle renvoie une valeur vide
et l'épisode continue. Aucune clé n'est journalisée.

  - Open-Meteo : géocodage et météo (sans clé)
  - transport.opendata.ch : horaires des trains suisses (sans clé) ; suivi d'un train précis
    en temps réel (CH, BE, FR) dans trains.py
  - OpenStreetMap (Overpass, Nominatim) : lieux, adresses (sans clé)
  - Wikivoyage, Wikipédia : présentation d'un lieu, photos (sans clé)
  - Tavily : recherche web (clé gratuite, secret TAVILY_API_KEY)
  - prénoms fêtés, saints, journées internationales, fêtes nationales et usages : données de
    référence intégrées (fetes.py, donnees/*.json), aucun appel réseau ; jours fériés du pays choisi
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import time
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import requests

import fetes
import pays

RACINE = Path(__file__).resolve().parent
AGENT = "podcast-matin/3.0 (podcast personnel ; https://github.com/TON-COMPTE/podcast-matin)"
URL_GEOCODAGE = "https://geocoding-api.open-meteo.com/v1/search"
URL_METEO = "https://api.open-meteo.com/v1/forecast"
URL_TRAINS = "https://transport.opendata.ch/v1/connections"
# Serveurs Overpass publics : le principal, puis des miroirs s'il est saturé.
URLS_OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
URL_NOMINATIM = "https://nominatim.openstreetmap.org"
URL_WIKIVOYAGE = "https://fr.wikivoyage.org/w/api.php"
URL_WIKIPEDIA = "https://fr.wikipedia.org/w/api.php"
URL_TAVILY = "https://api.tavily.com/search"

METEO_CODES = {
    0: "ciel dégagé", 1: "plutôt dégagé", 2: "partiellement nuageux", 3: "couvert",
    45: "brouillard", 48: "brouillard givrant", 51: "bruine légère", 53: "bruine", 55: "forte bruine",
    56: "bruine verglaçante", 57: "bruine verglaçante", 61: "pluie faible", 63: "pluie",
    65: "forte pluie", 66: "pluie verglaçante", 67: "pluie verglaçante", 71: "neige faible",
    73: "neige", 75: "forte neige", 77: "grésil", 80: "averses faibles", 81: "averses",
    82: "fortes averses", 85: "averses de neige", 86: "fortes averses de neige", 95: "orages",
    96: "orages avec grêle", 99: "orages avec grêle",
}

# Catégories de lieux OpenStreetMap que le planificateur peut demander.
CATEGORIES_OSM: dict[str, list[str]] = {
    "musee": ['["tourism"="museum"]'],
    "chateau": ['["historic"~"^(castle|fort|ruins|archaeological_site)$"]'],
    "point_de_vue": ['["tourism"="viewpoint"]'],
    "zoo": ['["tourism"~"^(zoo|aquarium)$"]'],
    "parc_attractions": ['["tourism"="theme_park"]'],
    "aire_de_jeux": ['["leisure"="playground"]'],
    "piscine": ['["leisure"~"^(water_park|swimming_pool)$"]["access"!~"private|customers"]'],
    "bains_thermaux": ['["amenity"="public_bath"]', '["leisure"="spa"]'],
    "theatre": ['["amenity"~"^(theatre|arts_centre|concert_hall)$"]'],
    "cinema": ['["amenity"="cinema"]'],
    "restaurant": ['["amenity"="restaurant"]'],
    "cafe": ['["amenity"="cafe"]'],
    "sommet": ['["natural"="peak"]'],
    "cascade": ['["waterway"="waterfall"]'],
    "grotte": ['["natural"="cave_entrance"]'],
    "attraction": ['["tourism"="attraction"]'],
    "plage": ['["natural"="beach"]', '["leisure"="beach_resort"]'],
    "patinoire": ['["leisure"="ice_rink"]'],
    "escalade": ['["sport"="climbing"]'],
    "bowling": ['["leisure"="bowling_alley"]'],
    "escape_game": ['["leisure"="escape_game"]'],
    "bibliotheque": ['["amenity"="library"]'],
    "galerie": ['["tourism"="gallery"]'],
    "parc": ['["leisure"="park"]'],
    "ferme": ['["tourism"="attraction"]["animal"]', '["shop"="farm"]'],
}


def journal(message: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def sans_accents(texte: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", texte) if not unicodedata.combining(c))


def cle(texte: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", sans_accents(str(texte).lower())).strip()


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


class Sources:
    """Accès aux services ; un cache évite de redemander deux fois la même chose."""

    def __init__(self, tavily: str = "", session: requests.Session | None = None) -> None:
        self.tavily_cle = tavily.strip()
        self.session = session or requests.Session()
        self.cache: dict[str, Any] = {}
        self.credits_tavily = 0
        self.dernier_nominatim = 0.0
        self.osm_en_panne = False      # après une panne complète, on ne réessaie plus pendant l'exécution

    # ── utilitaire ──
    def _json(self, methode: str, url: str, delai: int = 20, **options) -> Any:
        options.setdefault("headers", {})
        options["headers"].setdefault("User-Agent", AGENT)
        reponse = self.session.request(methode, url, timeout=delai, **options)
        reponse.raise_for_status()
        return reponse.json()

    def _memo(self, cle_cache: str, fonction, *args):
        if cle_cache not in self.cache:
            self.cache[cle_cache] = fonction(*args)
        return self.cache[cle_cache]

    # ── géocodage ──
    def geocoder(self, nom: str) -> dict | None:
        """Ville ou lieu → {nom, lat, lon, pays, region}. Le pays de l'auditeur d'abord."""
        nom = re.sub(r"^(autour|près|pres|vers|du côté)\s+(de|d'|du|des)\s*", "", str(nom or "").strip(), flags=re.I)
        if not nom:
            return None
        return self._memo(f"geo:{cle(nom)}", self._geocoder, nom)

    def _geocoder(self, nom: str) -> dict | None:
        for code_pays in (pays.code(), ""):
            try:
                parametres = {"name": nom, "count": 1, "language": "fr", "format": "json"}
                if code_pays:
                    parametres["country_code"] = code_pays
                donnees = self._json("GET", URL_GEOCODAGE, params=parametres)
                resultats = donnees.get("results") or []
                if resultats:
                    r = resultats[0]
                    return {"nom": r.get("name", nom), "lat": r["latitude"], "lon": r["longitude"],
                            "pays": r.get("country", ""), "region": r.get("admin1", "")}
            except Exception as erreur:
                journal(f"Géocodage de « {nom} » impossible : {type(erreur).__name__}")
                return None
        lieu = self.nominatim_chercher(nom)
        if lieu:
            return {"nom": nom, "lat": lieu["lat"], "lon": lieu["lon"], "pays": "", "region": ""}
        return None

    def nominatim_chercher(self, requete: str, code_pays: str = "") -> dict | None:
        """Adresse ou nom de lieu précis → coordonnées (1 requête par seconde au plus)."""
        if not requete.strip():
            return None
        def chercher() -> dict | None:
            attente = 1.1 - (time.monotonic() - self.dernier_nominatim)
            if attente > 0:
                time.sleep(attente)
            self.dernier_nominatim = time.monotonic()
            try:
                resultats = self._json("GET", f"{URL_NOMINATIM}/search", params={
                    "q": requete, "format": "jsonv2", "limit": 1, "countrycodes": (code_pays or pays.code()).lower(),
                    "accept-language": "fr", "addressdetails": 1})
            except Exception as erreur:
                journal(f"Nominatim indisponible : {type(erreur).__name__}")
                return None
            if not resultats:
                return None
            r = resultats[0]
            return {"lat": float(r["lat"]), "lon": float(r["lon"]), "adresse": r.get("display_name", "")}
        return self._memo(f"nom:{cle(requete)}", chercher)

    # ── météo ──
    def meteo(self, lat: float, lon: float, jour: dt.date) -> dict | None:
        """Prévision du jour (jusqu'à 15 jours à l'avance)."""
        def prevoir() -> dict | None:
            try:
                donnees = self._json("GET", URL_METEO, params={
                    "latitude": round(lat, 3), "longitude": round(lon, 3), "timezone": "auto",
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
                    "forecast_days": 16})
            except Exception as erreur:
                journal(f"Météo indisponible : {type(erreur).__name__}")
                return None
            jours = (donnees.get("daily") or {}).get("time") or []
            if jour.isoformat() not in jours:
                return None
            i = jours.index(jour.isoformat())
            d = donnees["daily"]
            def valeur(cle_meteo: str):
                serie = d.get(cle_meteo) or []
                return serie[i] if i < len(serie) else None
            code = valeur("weather_code")
            return {"date": jour.isoformat(), "ciel": METEO_CODES.get(int(code), "variable") if code is not None else "inconnu",
                    "max": valeur("temperature_2m_max"), "min": valeur("temperature_2m_min"),
                    "pluie": valeur("precipitation_probability_max"), "vent": valeur("wind_speed_10m_max")}
        return self._memo(f"meteo:{lat:.2f}:{lon:.2f}:{jour}", prevoir)

    @staticmethod
    def meteo_en_mots(m: dict | None) -> str:
        if not m:
            return ""
        morceaux = [m["ciel"]]
        if m.get("min") is not None and m.get("max") is not None:
            morceaux.append(f"{round(m['min'])} à {round(m['max'])} °C")
        if m.get("pluie") is not None:
            morceaux.append(f"risque de pluie {round(m['pluie'])} %")
        if m.get("vent") is not None and m["vent"] >= 30:
            morceaux.append(f"vent jusqu'à {round(m['vent'])} km/h")
        return ", ".join(morceaux)

    # ── trains ──
    def trajets(self, depart: str, arrivee: str, jour: dt.date, heure: str = "09:00", nombre: int = 3) -> list[dict]:
        def chercher() -> list[dict]:
            try:
                donnees = self._json("GET", URL_TRAINS, params={
                    "from": depart, "to": arrivee, "date": jour.isoformat(), "time": heure, "limit": nombre})
            except Exception as erreur:
                journal(f"Horaires CFF indisponibles : {type(erreur).__name__}")
                return []
            resultats = []
            for c in donnees.get("connections") or []:
                duree = re.sub(r"^\d+d", "", str(c.get("duration") or ""))
                h, m = (duree.split(":") + ["0", "0"])[:2] if duree else ("0", "0")
                depart_h = str((c.get("from") or {}).get("departure") or "")[11:16]
                arrivee_h = str((c.get("to") or {}).get("arrival") or "")[11:16]
                resultats.append({
                    "depart": depart_h, "arrivee": arrivee_h,
                    "duree": f"{int(h)} h {int(m):02d}" if int(h) else f"{int(m)} min",
                    "correspondances": int(c.get("transfers") or 0),
                    "moyens": [p for p in c.get("products") or [] if p],
                    "de": ((c.get("from") or {}).get("station") or {}).get("name", depart),
                    "a": ((c.get("to") or {}).get("station") or {}).get("name", arrivee),
                })
            return resultats
        return self._memo(f"cff:{cle(depart)}:{cle(arrivee)}:{jour}:{heure}", chercher)

    @staticmethod
    def trajets_en_mots(trajets: list[dict]) -> str:
        if not trajets:
            return ""
        t = trajets[0]
        corr = "direct" if not t["correspondances"] else f"{t['correspondances']} correspondance{'s' if t['correspondances'] > 1 else ''}"
        autres = ", ".join(x["depart"] for x in trajets[1:] if x["depart"])
        return (f"{t['de']} → {t['a']} : départ {t['depart']}, arrivée {t['arrivee']} ({t['duree']}, {corr})"
                + (f" ; autres départs : {autres}" if autres else ""))

    # ── lieux OpenStreetMap ──
    def lieux(self, lat: float, lon: float, categories: list[str], rayon_km: float = 10, maximum: int = 12) -> list[dict]:
        """Lieux notables (Wikipédia, avec photo) puis lieux OpenStreetMap des catégories demandées."""
        notables = self.lieux_wikipedia(lat, lon, rayon_km, maximum)
        osm = self.lieux_osm(lat, lon, categories, rayon_km, maximum)
        vus = {cle(l["nom"]) for l in notables}
        fusion = notables[: maximum // 2 + 1] + [l for l in osm if cle(l["nom"]) not in vus]
        return (fusion + notables[maximum // 2 + 1:])[:maximum]

    def lieux_wikipedia(self, lat: float, lon: float, rayon_km: float = 10, maximum: int = 12) -> list[dict]:
        """Articles Wikipédia situés près du point (sans les communes, gares, routes…)."""
        def chercher() -> list[dict]:
            try:
                donnees = self._json("GET", URL_WIKIPEDIA, params={
                    "action": "query", "format": "json", "generator": "geosearch",
                    "ggscoord": f"{lat:.5f}|{lon:.5f}", "ggsradius": int(max(1, min(10, rayon_km)) * 1000), "ggslimit": 40,
                    "prop": "coordinates|description|pageimages", "piprop": "thumbnail", "pithumbsize": 800,
                    "colimit": "max", "pilimit": "max"})
            except Exception as erreur:
                journal(f"Wikipédia (lieux) indisponible : {type(erreur).__name__}")
                return []
            exclus = re.compile(r"commune|village|localité|hameau|district|quartier|gare|ligne (ferroviaire|de chemin)|route|autoroute|"
                                r"cours d'eau|rivière|paroisse|canton|municipalit|ancienne commune|lieu-dit|tunnel|col routier|"
                                r"entreprise|banque|société|fondation|association|fédération|organisation|agglomération|"
                                r"parti politique|école|lycée|gymnase|hôpital|personnalité|pénitentiaire|prison|halte|station|arrêt|"
                                r"hôtel de ville|administration|tribunal|caserne|cimetière|usine|centrale", re.I)
            lieux = []
            for page in (donnees.get("query") or {}).get("pages", {}).values():
                position = (page.get("coordinates") or [{}])[0]
                description = page.get("description", "")
                if "lat" not in position or exclus.search(description) or re.match(r"^(Gare|Liste|Église réformée)\b", page.get("title", "")):
                    continue
                lieux.append({"nom": page["title"], "lat": position["lat"], "lon": position["lon"],
                              "type": description[:60] or "lieu notable", "site": "", "horaires": "", "adresse": "",
                              "wikipedia": f"fr:{page['title']}", "accessible": "",
                              "image": (page.get("thumbnail") or {}).get("source", ""),
                              "distance": round(distance_km((lat, lon), (position["lat"], position["lon"])), 1)})
            lieux.sort(key=lambda x: x["distance"])
            return lieux[:maximum]
        return self._memo(f"wpgeo:{lat:.3f}:{lon:.3f}:{rayon_km}", chercher)

    def lieux_osm(self, lat: float, lon: float, categories: list[str], rayon_km: float = 10, maximum: int = 12) -> list[dict]:
        filtres = [f for c in categories for f in CATEGORIES_OSM.get(c, [])]
        if not filtres or self.osm_en_panne:
            return []
        # Requêtes courtes (rayon ≤ 10 km, nœuds et chemins seulement) : les serveurs
        # publics saturent vite sur les grandes zones.
        rayon = int(max(1, min(10, rayon_km)) * 1000)
        def chercher() -> list[dict]:
            corps = "".join(f'nw{f}["name"](around:{rayon},{lat:.5f},{lon:.5f});' for f in filtres[:6])
            requete = f"[out:json][timeout:20];({corps});out center tags 40;"
            donnees = None
            for url in URLS_OVERPASS[:1]:     # un seul essai : les miroirs publics saturent aussi
                try:
                    reponse = self.session.post(url, data={"data": requete}, timeout=(5, 20), headers={"User-Agent": AGENT})
                except requests.RequestException as erreur:
                    journal(f"OpenStreetMap ({url.split('/')[2]}) injoignable : {type(erreur).__name__}")
                    continue
                if reponse.status_code == 200:
                    try:
                        donnees = reponse.json()
                        break
                    except ValueError:
                        journal(f"OpenStreetMap ({url.split('/')[2]}) : réponse illisible")
                        continue
                journal(f"OpenStreetMap ({url.split('/')[2]}) : HTTP {reponse.status_code} {reponse.text[:160]!r}")
                if reponse.status_code == 400:
                    break               # requête refusée : inutile d'essayer ailleurs
            if donnees is None:
                self.osm_en_panne = True
                return []
            trouves = []
            vus = set()
            for element in donnees.get("elements") or []:
                tags = element.get("tags") or {}
                nom = tags.get("name:fr") or tags.get("name")
                position = element.get("center") or element
                if not nom or "lat" not in position or cle(nom) in vus:
                    continue
                vus.add(cle(nom))
                adresse = " ".join(x for x in (tags.get("addr:street", ""), tags.get("addr:housenumber", "")) if x)
                ville = tags.get("addr:city", "")
                trouves.append({
                    "nom": nom, "lat": position["lat"], "lon": position["lon"],
                    "type": next((v for k, v in tags.items() if k in ("tourism", "leisure", "amenity", "historic", "natural", "sport")), ""),
                    "site": tags.get("website") or tags.get("contact:website") or "",
                    "horaires": tags.get("opening_hours", ""),
                    "adresse": ", ".join(x for x in (adresse, ville) if x),
                    "wikipedia": tags.get("wikipedia", ""),
                    "accessible": tags.get("wheelchair", ""),
                    "distance": round(distance_km((lat, lon), (position["lat"], position["lon"])), 1),
                })
            # Les lieux connus (Wikipédia, site web) d'abord, puis les plus proches.
            trouves.sort(key=lambda x: (not x["wikipedia"], not x["site"], x["distance"]))
            return trouves[:maximum]
        return self._memo(f"osm:{lat:.3f}:{lon:.3f}:{','.join(sorted(categories))}:{rayon}", chercher)

    # ── Wikivoyage / Wikipédia ──
    def wikivoyage(self, nom: str) -> dict | None:
        def chercher() -> dict | None:
            try:
                donnees = self._json("GET", URL_WIKIVOYAGE, params={
                    "action": "query", "format": "json", "prop": "extracts|pageimages", "exintro": 1,
                    "explaintext": 1, "redirects": 1, "pithumbsize": 800, "titles": nom})
            except Exception as erreur:
                journal(f"Wikivoyage indisponible : {type(erreur).__name__}")
                return None
            for page in (donnees.get("query") or {}).get("pages", {}).values():
                if page.get("missing") is not None or not page.get("extract"):
                    continue
                return {"titre": page.get("title", nom), "extrait": page["extract"][:1500],
                        "image": (page.get("thumbnail") or {}).get("source", ""),
                        "url": f"https://fr.wikivoyage.org/wiki/{quote(page.get('title', nom).replace(' ', '_'))}"}
            return None
        return self._memo(f"wv:{cle(nom)}", chercher)

    def wikipedia(self, recherche: str) -> dict | None:
        """Premier article correspondant : extrait, image, coordonnées."""
        def chercher() -> dict | None:
            try:
                donnees = self._json("GET", URL_WIKIPEDIA, params={
                    "action": "query", "format": "json", "prop": "pageimages|extracts|coordinates",
                    "exintro": 1, "explaintext": 1, "exsentences": 3, "pithumbsize": 800, "redirects": 1,
                    "generator": "search", "gsrsearch": recherche, "gsrlimit": 1})
            except Exception as erreur:
                journal(f"Wikipédia indisponible : {type(erreur).__name__}")
                return None
            for page in (donnees.get("query") or {}).get("pages", {}).values():
                coordonnees = (page.get("coordinates") or [{}])[0]
                return {"titre": page.get("title", ""), "extrait": page.get("extract", "")[:600],
                        "image": (page.get("thumbnail") or {}).get("source", ""),
                        "lat": coordonnees.get("lat"), "lon": coordonnees.get("lon"),
                        "url": f"https://fr.wikipedia.org/wiki/{quote(page.get('title', '').replace(' ', '_'))}"}
            return None
        return self._memo(f"wp:{cle(recherche)}", chercher)

    # ── recherche web ──
    def web(self, requete: str, maximum: int = 5, images: bool = False, jours: int | None = None) -> dict:
        """Recherche Tavily (1 crédit par recherche simple). Sans clé : résultat vide."""
        if not self.tavily_cle or not requete.strip():
            return {"resultats": [], "images": []}
        def chercher() -> dict:
            corps: dict[str, Any] = {"query": requete[:380], "search_depth": "basic", "max_results": maximum,
                                     "include_answer": False, "include_images": images, "topic": "general",
                                     "country": "switzerland"}
            if jours:
                corps["time_range"] = "week" if jours <= 7 else "month" if jours <= 31 else "year"
            for essai in range(2):
                try:
                    donnees = self._json("POST", URL_TAVILY, delai=30, json=corps,
                                         headers={"Authorization": f"Bearer {self.tavily_cle}", "User-Agent": AGENT})
                    self.credits_tavily += 1
                    break
                except requests.HTTPError as erreur:
                    statut = erreur.response.status_code if erreur.response is not None else 0
                    if statut == 400 and "country" in corps:      # paramètre refusé : version simple
                        corps.pop("country", None)
                        continue
                    journal(f"Recherche web refusée (HTTP {statut}).")
                    return {"resultats": [], "images": []}
                except Exception as erreur:
                    journal(f"Recherche web indisponible : {type(erreur).__name__}")
                    return {"resultats": [], "images": []}
            else:
                return {"resultats": [], "images": []}
            resultats = [{"titre": r.get("title", ""), "url": r.get("url", ""),
                          "contenu": re.sub(r"\s+", " ", r.get("content", ""))[:700], "score": r.get("score", 0)}
                         for r in donnees.get("results") or [] if r.get("url")]
            images_trouvees = [i if isinstance(i, str) else i.get("url", "") for i in donnees.get("images") or []]
            journal(f"Recherche web « {requete[:60]} » : {len(resultats)} résultat(s).")
            return {"resultats": resultats, "images": [i for i in images_trouvees if i]}
        return self._memo(f"web:{cle(requete)}:{maximum}:{images}:{jours}", chercher)


# ── calendrier ──

def _methode_fetes(self, jour: dt.date) -> list[str]:
    """Fêtes nationales, journées internationales et usages du jour, du pays choisi : données de
    référence intégrées (fetes.py), sans réseau — plus de Wikipédia au moment de fabriquer l'épisode."""
    return fetes.lignes_du_jour(jour, pays.code())


Sources.fetes = _methode_fetes

saints_du_jour = fetes.saints_du_jour       # le calendrier des saints vit dans fetes.py


def feries(debut: dt.date, jours: int = 7) -> list[tuple[dt.date, str]]:
    """Jours fériés de la région choisie dans l'application, entre debut et debut + jours."""
    return pays.feries(debut, jours)


def lien_itineraire(depart: str, arrivee: str, transport: str = "") -> str:
    """Lien Google Maps (itinéraire) : transports publics, voiture, vélo ou à pied."""
    mode = {"voiture": "driving", "velo": "bicycling", "pied": "walking"}.get(transport, "transit")
    return "https://www.google.com/maps/dir/?" + urlencode(
        {"api": 1, "origin": depart, "destination": arrivee, "travelmode": mode})


def lien_carte(lat: float, lon: float) -> str:
    return f"https://www.openstreetmap.org/?mlat={lat:.5f}&mlon={lon:.5f}#map=15/{lat:.5f}/{lon:.5f}"
