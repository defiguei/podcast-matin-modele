"""Tests hors ligne du podcast : toutes les requêtes réseau sont simulées."""
import base64
import contextlib
import datetime as dt
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from urllib.parse import unquote_plus
from zoneinfo import ZoneInfo

PROJET = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJET))
import horaire  # noqa: E402
import podcast  # noqa: E402

# Rien n'est écrit dans le projet : copie des réglages dans un dossier temporaire.
RACINE_TEST = Path(tempfile.mkdtemp(prefix="podcast-test-"))
shutil.copy(PROJET / "reglages.toml", RACINE_TEST / "reglages.toml")
# Valeurs de référence des tests, quels que soient les réglages du dépôt.
_reglages = (RACINE_TEST / "reglages.toml").read_text(encoding="utf-8")
for _cle, _valeur in (("duree_minutes", "5"), ("nombre_sujets", "5"), ("vitesse_parole", '"normale"')):
    _reglages = re.sub(rf"(?m)^{_cle}\s*=.*$", f"{_cle} = {_valeur}", _reglages)
(RACINE_TEST / "reglages.toml").write_text(_reglages, encoding="utf-8")
podcast.RACINE = RACINE_TEST
MEMOIRE = RACINE_TEST / "memoire.json"

ZH = ZoneInfo("Europe/Zurich")


def _exception_annotee(type_, valeur, trace):
    import traceback
    texte = "".join(traceback.format_exception(type_, valeur, trace))
    if os.environ.get("GITHUB_ACTIONS"):
        print("::error title=Exception::" + texte[-3000:].replace("\n", "%0A"), flush=True)
    sys.__excepthook__(type_, valeur, trace)


sys.excepthook = _exception_annotee
UTC = dt.timezone.utc
echecs = []


def verifier(condition, message):
    print(("  ok  " if condition else "  ÉCHEC ") + message)
    if not condition:
        echecs.append(message)
        if os.environ.get("GITHUB_ACTIONS"):
            print(f"::error title=Test raté::{message[:900]}", flush=True)


def memoire():
    return json.loads(MEMOIRE.read_text(encoding="utf-8"))


def oublier_remplissage():
    """Le faux Gemini écrit toujours très court : le podcast apprend à demander plus. Pour les contrôles
    de longueur exacte, on repart d'une mémoire sans cette correction."""
    m = memoire()
    m["remplissage"] = None
    MEMOIRE.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")


# ───────────────────────── 1. créneau horaire ─────────────────────────
print("1. Créneau horaire")
verifier(horaire.normaliser("5h45") == "05:45" and horaire.normaliser("6:30") == "06:30",
         "normalisation de l'heure")

# ───────────────────────── 2. agenda iCal ─────────────────────────────
print("\n2. Lecture de l'agenda")
ENTETE = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//FR
X-WR-CALNAME:Perso
X-WR-TIMEZONE:Europe/Zurich
BEGIN:VTIMEZONE
TZID:Europe/Zurich
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
"""
ICS = ENTETE + b"""BEGIN:VEVENT
UID:1
DTSTART;TZID=Europe/Zurich:20261012T090000
DTEND;TZID=Europe/Zurich:20261012T103000
SUMMARY:R\xc3\xa9union projet Alpha
LOCATION:Lausanne\\, EPFL
DESCRIPTION:Pr\xc3\xa9parer les slides. Lien : https://meet.example.com/abc
END:VEVENT
BEGIN:VEVENT
UID:2
DTSTART:20261012T160000Z
DTEND:20261012T170000Z
SUMMARY:Appel avec Sophie
END:VEVENT
BEGIN:VEVENT
UID:3
DTSTART;VALUE=DATE:20261012
DTEND;VALUE=DATE:20261013
SUMMARY:Anniversaire de Marie
END:VEVENT
BEGIN:VEVENT
UID:4
DTSTART;VALUE=DATE:20261010
DTEND;VALUE=DATE:20261021
SUMMARY:Vacances scolaires
END:VEVENT
BEGIN:VEVENT
UID:5
DTSTART;TZID=Europe/Zurich:20260907T190000
DTEND;TZID=Europe/Zurich:20260907T200000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=Europe/Zurich:20261014T190000
SUMMARY:Cours de yoga
END:VEVENT
BEGIN:VEVENT
UID:6
DTSTART;TZID=Europe/Zurich:20261013T080000
DTEND;TZID=Europe/Zurich:20261013T090000
STATUS:CANCELLED
SUMMARY:Rendez-vous annul\xc3\xa9
END:VEVENT
BEGIN:VEVENT
UID:7
DTSTART:20261015T120000
DURATION:PT1H30M
SUMMARY:D\xc3\xa9jeuner flottant
END:VEVENT
BEGIN:VEVENT
UID:8
DTSTART;TZID=Europe/Zurich:20261030T090000
DTEND;TZID=Europe/Zurich:20261030T100000
SUMMARY:Hors fen\xc3\xaatre
END:VEVENT
END:VCALENDAR
"""
# Agenda vide pendant des semaines, puis un week-end à Barcelone.
ICS_VIDE = ENTETE + b"""BEGIN:VEVENT
UID:20
DTSTART;VALUE=DATE:20261106
DTEND;VALUE=DATE:20261109
SUMMARY:Week-end \xc3\xa0 Barcelone
LOCATION:Barcelone\\, Espagne
END:VEVENT
BEGIN:VEVENT
UID:21
DTSTART;TZID=Europe/Zurich:20261120T190000
DTEND;TZID=Europe/Zurich:20261120T220000
SUMMARY:Concert
END:VEVENT
END:VCALENDAR
"""
maintenant = dt.datetime(2026, 10, 12, 5, 46, tzinfo=ZH)
reglages = podcast.charger_reglages(RACINE_TEST / "reglages.toml")
debut = maintenant.replace(hour=0, minute=0)
evs = podcast.lire_evenements(ICS, ZH, debut, debut + dt.timedelta(days=7))
titres = [e.titre for e in sorted(evs, key=lambda e: e.debut)]
verifier("Réunion projet Alpha" in titres, "événement avec fuseau")
verifier("Rendez-vous annulé" not in titres, "événement annulé ignoré")
verifier("Hors fenêtre" not in titres, "événement hors fenêtre ignoré")
yoga = [e for e in evs if e.titre == "Cours de yoga"]
verifier(len(yoga) == 1 and yoga[0].debut.date() == dt.date(2026, 10, 12),
         "récurrence + exception (lundi seulement, mercredi exclu)")
appel = [e for e in evs if e.titre == "Appel avec Sophie"][0]
verifier(appel.debut.hour == 18, f"heure UTC convertie en heure suisse : {appel.debut}")
flottant = [e for e in evs if e.titre == "Déjeuner flottant"][0]
verifier(flottant.debut.hour == 12 and flottant.fin.hour == 13 and flottant.fin.minute == 30,
         "heure flottante + durée")
reunion = [e for e in evs if e.titre == "Réunion projet Alpha"][0]
verifier("https" not in reunion.note and "(lien)" in reunion.note, "lien masqué dans la note")
resume = podcast.resumer_agenda(evs, maintenant)
verifier("du samedi 10 octobre au mardi 20 octobre, journées entières (déjà commencé)" in resume,
         "événement de plusieurs jours déjà commencé")
verifier("de 9 h à 10 h 30 : Réunion projet Alpha — lieu : Lausanne, EPFL" in resume, "format heure + lieu")

vides = podcast.lire_evenements(ICS_VIDE, ZH, debut, debut + dt.timedelta(days=90))
texte_vide = podcast.resumer_agenda([], maintenant, vides[0], 90)
print("   " + texte_vide.replace("\n", "\n   "))
verifier("PROCHAIN ÉVÉNEMENT (dans 25 jours, vendredi 6 novembre 2026)" in texte_vide
         and "du vendredi 6 novembre au dimanche 8 novembre" in texte_vide,
         "agenda vide → prochain événement, même lointain")
verifier(podcast.resumer_agenda([], maintenant, None, 90)
         == "Aucun événement dans l'agenda pour les 90 prochains jours.", "agenda entièrement vide")
demain = podcast.Evenement("Dentiste", maintenant + dt.timedelta(days=1), None, False)
verifier("(dans 1 jour," in podcast.resumer_agenda([], maintenant, demain, 90), "« dans 1 jour » au singulier")
verifier(podcast.evoque_un_lieu(vides[0]) and podcast.evoque_un_lieu(vides[1])
         and not podcast.evoque_un_lieu(podcast.Evenement("Appel avec Sophie", maintenant, None, False)),
         "repérage des événements qui évoquent un lieu ou une sortie")

# « Chaque année le 4 février » écrit par Google Agenda sans le mois : pas le 4 de chaque mois.
ANNUELS = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VEVENT
UID:annuel-sans-mois
DTSTART;VALUE=DATE:20240204
DTEND;VALUE=DATE:20240205
RRULE:FREQ=YEARLY;BYMONTHDAY=4
SUMMARY:Anniversaire de Fuzi
END:VEVENT
BEGIN:VEVENT
UID:mensuel
DTSTART;VALUE=DATE:20240204
DTEND;VALUE=DATE:20240205
RRULE:FREQ=MONTHLY;BYMONTHDAY=4
SUMMARY:Loyer
END:VEVENT
BEGIN:VEVENT
UID:annuel-premier-mercredi
DTSTART;VALUE=DATE:20260107
DTEND;VALUE=DATE:20260108
RRULE:FREQ=YEARLY;BYDAY=1WE
SUMMARY:Premier mercredi de l'annee
END:VEVENT
END:VCALENDAR
"""
annuels = podcast.lire_evenements(ANNUELS, ZH, dt.datetime(2026, 10, 30, tzinfo=ZH), dt.datetime(2027, 10, 30, tzinfo=ZH))
dates = lambda titre: [e.debut.date().isoformat() for e in annuels if e.titre == titre]
verifier(dates("Anniversaire de Fuzi") == ["2027-02-04"],
         f"annuel sans mois (Google) : une fois par an, dans le mois de début ({dates('Anniversaire de Fuzi')})")
verifier(len(dates("Loyer")) == 12 and dates("Premier mercredi de l'annee") == ["2027-01-06"],
         "les autres récurrences ne changent pas (mensuel, 1er mercredi de l'année)")

# ───────────────────────── 3. flux RSS ────────────────────────────────
print("\n3. Lecture des flux")
GOOGLE = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>À la une - Google Actualités</title>
<item><title>Le Conseil fédéral adopte le budget 2027 - RTS</title><link>https://news.google.com/rss/articles/AAA</link>
<pubDate>Mon, 12 Oct 2026 03:10:00 GMT</pubDate><description>&lt;a href="https://x"&gt;Le Conseil fédéral adopte le budget 2027&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;RTS&lt;/font&gt;</description><source url="https://www.rts.ch">RTS</source></item>
<item><title>Grève des trains en France: perturbations à Genève - Tribune de Genève</title><link>https://news.google.com/rss/articles/BBB</link>
<pubDate>Mon, 12 Oct 2026 02:00:00 GMT</pubDate><description>x</description><source url="https://www.tdg.ch">Tribune de Genève</source></item>
<item><title>Vieille nouvelle - Le Temps</title><link>https://news.google.com/rss/articles/CCC</link>
<pubDate>Wed, 07 Oct 2026 08:00:00 GMT</pubDate><source url="https://www.letemps.ch">Le Temps</source></item>
</channel></rss>""".encode()
RTS = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>RTS Info</title>
<item><title>Le Conseil fédéral adopte le budget 2027</title><link>https://www.rts.ch/info/1</link>
<pubDate>Mon, 12 Oct 2026 05:00:00 +0200</pubDate><description>&lt;p&gt;Le gouvernement a validé un budget &lt;b&gt;équilibré&lt;/b&gt; malgré la hausse des dépenses militaires.&lt;/p&gt;</description></item>
<item><title>Météo : premières neiges attendues dès 1200 mètres</title><link>https://www.rts.ch/info/2</link>
<pubDate>Mon, 12 Oct 2026 04:30:00 +0200</pubDate><description>Les Alpes valaisannes devraient blanchir dès mardi.</description></item>
</channel></rss>""".encode()


def flux_recherche(requete):
    """Résultat d'une recherche Google Actualités (un article par requête)."""
    return f"""<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>"{requete}" - Google Actualités</title>
<item><title>Dernières nouvelles : {requete} - Le Temps</title><link>https://news.google.com/rss/articles/R-{abs(hash(requete))}</link>
<pubDate>Sun, 11 Oct 2026 18:00:00 GMT</pubDate><description>Article sur {requete}.</description><source url="https://www.letemps.ch">Le Temps</source></item>
</channel></rss>""".encode()


seuil = maintenant.astimezone(UTC) - dt.timedelta(hours=36)
g = podcast.lire_flux(GOOGLE, "Google Actualités – Suisse", 8, seuil)
verifier([a.titre for a in g] == ["Le Conseil fédéral adopte le budget 2027",
                                   "Grève des trains en France: perturbations à Genève"],
         "titres Google nettoyés, vieille nouvelle filtrée")
verifier(g[0].source == "RTS" and g[0].resume == "", "source réelle, résumé redondant retiré")
r = podcast.lire_flux(RTS, "RTS Info", 8, seuil)
verifier(r[0].resume.startswith("Le gouvernement a validé un budget équilibré"), "HTML retiré")

# ───────────────────── 4. préférences et mémoire ───────────────────────
print("\n4. Préférences et mémoire")
m = podcast.memoire_vide()
verifier(not any(cle in m for cle in ("telegram_dernier_update", "historique_retours", "episodes_refaits")),
         "mémoire : plus rien de l'ancienne conversation")
m["preferences"].update({"vitesse_parole": "lente", "ville_habituelle": "Lausanne", "sujets_preferes": ["Technologie"],
                         "sujets_a_eviter": ["Sport"], "consignes": ["plus d'humour"]})
m["a_approfondir"] = [{"sujet": "IA en Suisse", "demande_le": "2026-10-10"},
                      {"sujet": "réforme des retraites", "demande_le": "2026-10-12"}]
eff = podcast.reglages_effectifs(reglages, m)
verifier(eff["vitesse_parole"] == "lente" and eff["ville_habituelle"] == "Lausanne"
         and reglages["vitesse_parole"] == "normale", "la mémoire l'emporte sur reglages.toml (sans le modifier)")
consigne = podcast.consigne_systeme(eff)
verifier("entre 960 et 1056 mots" in consigne and "n'écris pas moins de 960 mots" in consigne,
         "vitesse lente + approfondissement : 6 min × 160 mots, avec un minimum")
verifier("Thèmes qui ne l'intéressent pas : Sport" in consigne and "plus d'humour" in consigne,
         "thèmes évités et consignes transmis au rédacteur")
var = podcast.variantes_voix([("Lea", "Bonjour"), ("Hugo", "Salut")], {"Lea": "Aoede", "Hugo": "Puck"},
                             "speaking a little slowly")
verifier(len(var) == 6 and var[0]["input"][0]["content"][0]["annotations"][0].get("style")
         == "speaking a little slowly" and "style" not in var[3]["input"][0]["content"][0]["annotations"][0],
         "consigne de vitesse envoyée à la voix, puis retirée en dernier recours")
verifier(len(podcast.variantes_voix([("Lea", "x")], {"Lea": "Aoede"})) == 3, "vitesse normale : pas de consigne de style")

# ───────────────────── 5. bout en bout (réseau simulé) ─────────────────
print("\n5. Bout en bout, réseau simulé")
SCRIPT = {
    "titre": "**Budget, neige et yoga**",
    "repliques": [
        {"animateur": "Léa", "texte": "Bonjour ! On est lundi 12 octobre, et il est l'heure de se réveiller en douceur. <breath>"},
        {"animateur": "Hugo", "texte": "Salut ! Café en main ? |ah oui| Parce qu'on a une journée bien remplie. <laugh>"},
        {"animateur": "Hugo", "texte": "Bon, on commence par ton agenda."},
        {"animateur": "Lea", "texte": "À 9 h, réunion projet Alpha à Lausanne [1]. Pense aux slides ! 📊 <excited>"},
        {"animateur": "Hugo", "texte": "Et à 18 h, l'appel avec Sophie, puis le yoga à 19 h. Voir https://exemple.ch"},
        {"animateur": "Léa", "texte": "Côté actus : le Conseil fédéral a adopté le budget 2027 |ah enfin| hier soir. Et une barre | orpheline"},
        {"animateur": "Hugo", "texte": "Et la neige arrive dès 1200 mètres <short pause> sortez les bonnets."},
        {"animateur": "Inconnu", "texte": "Voilà pour ce matin, belle journée !"},
        {"animateur": "Hugo", "texte": "   "},
    ],
    "sujets": ["Agenda du jour", "Budget 2027", "Premières neiges"],
    "sources": [1, "3", 99],
}
os.environ.update({
    "GEMINI_API_KEY": "cle-test-123",
    "BOT_GITHUB_TOKEN": "gh-jeton-test",
    "CALENDAR_ICS_URL": "webcal://p01-caldav.icloud.com/published/2/SECRET  https://calendar.google.com/calendar/ical/x/private-SECRET/basic.ics",
    "GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "moi/podcast-matin",
    "GITHUB_RUN_ID": "42",
})


def pcm_ton(secondes, taux=24000):
    n = int(secondes * taux)
    return b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / taux))) for i in range(n))


class Reponse:
    def __init__(self, statut, donnees=None, contenu=None, entetes=None):
        self.status_code = statut
        self._donnees = donnees
        self.content = contenu if contenu is not None else json.dumps(donnees or {}).encode()
        self.text = self.content.decode("utf-8", "replace")
        self.headers = entetes or {}

    def json(self):
        if self._donnees is None:
            raise ValueError("pas de JSON")
        return self._donnees

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.HTTPError(response=self)


appels = []
fichiers_bot: dict[str, bytes] = {}        # ce que le bot garde (PUT /api/fichier)
scenario = {
    "quota_premier_modele_voix": True, "refuser_mode": True, "refuser_style": False, "wav": False,
    "tronquer_une_fois": False, "agenda": ICS, "deplacements": [], "pannes": {}, "stockage": True,
}


def reponse_texte(objet):
    texte = json.dumps(objet, ensure_ascii=False)
    return Reponse(200, {"status": "completed", "steps": [
        {"type": "thought", "content": []},
        {"type": "model_output", "content": [{"type": "text", "text": texte[:50]},
                                             {"type": "text", "text": texte[50:]}]}]})


def faux_get(url, timeout=None, headers=None):
    appels.append(("GET", url))
    if "icloud" in url:
        assert url.startswith("https://"), "webcal:// doit devenir https://"
        return Reponse(200, contenu=scenario["agenda"])
    if "calendar.google" in url:
        return Reponse(404, contenu=b"not found")
    if "news.google.com/rss/search" in url:
        requete = unquote_plus(url.split("q=", 1)[1].split("&", 1)[0]).rsplit(" when:", 1)[0]
        return Reponse(200, contenu=flux_recherche(requete))
    if "news.google" in url:
        return Reponse(200, contenu=GOOGLE)
    if "rts.ch" in url:
        return Reponse(200, contenu=RTS)
    return Reponse(403, contenu=b"<html>blocked</html>")    # le bot ne donne pas de réglages : reglages.toml


def faux_gemini(corps, headers):
    assert headers["x-goog-api-key"] == "cle-test-123"
    assert corps["store"] is False
    modele = corps["model"]
    if modele.endswith("-tts"):
        if scenario["quota_premier_modele_voix"] and modele == "gemini-3.8-flash-tts":
            return Reponse(429, {"error": {"code": 429, "message": "Quota exceeded",
                                           "details": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel"}]}})
        config = corps["generation_config"]["speech_config"]
        if scenario["refuser_mode"] and "mode" in config:
            return Reponse(400, {"error": {"code": 400, "message": 'Invalid JSON payload received. Unknown name "mode" at speech_config'}})
        annotations = [c["annotations"][0] for c in corps["input"][0]["content"]]
        if scenario["refuser_style"] and any("style" in a for a in annotations):
            return Reponse(400, {"error": {"code": 400, "message": 'Invalid JSON payload received. Unknown name "style"'}})
        textes = [c["text"] for c in corps["input"][0]["content"]]
        secondes = sum(len(t) for t in textes) / 15
        if scenario["tronquer_une_fois"] and len(textes) > 2:
            scenario["tronquer_une_fois"] = False
            secondes = 1.0
        pcm = pcm_ton(secondes)
        if scenario["wav"] or corps["response_format"].get("mime_type") is None:
            tampon = io.BytesIO()
            with wave.open(tampon, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(24000)
                w.writeframes(pcm)
            bloc = {"type": "audio", "data": base64.b64encode(tampon.getvalue()).decode(), "mime_type": "audio/wav"}
        else:
            bloc = {"type": "audio", "data": base64.b64encode(pcm).decode(), "mime_type": "audio/l16", "sample_rate": 24000}
        return Reponse(200, {"status": "completed", "steps": [{"type": "model_output", "content": [bloc]}]})

    systeme = corps["system_instruction"]
    proprietes = corps.get("response_format", {}).get("schema", {}).get("properties", {})
    if "Tu repères dans l'agenda" in systeme:
        assert "deplacements" in proprietes
        return reponse_texte({"deplacements": scenario["deplacements"]})
    assert "Tu écris le script" in systeme
    pannes = scenario["pannes"].get(modele) or []
    if pannes:
        panne = pannes.pop(0)
        if panne == "timeout":
            import requests
            raise requests.ReadTimeout("simulé")
        if panne == "429":
            return Reponse(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
                                           "message": "Your project has exceeded a quota. See https://ai.dev/rate-limit to manage your rate limits."}})
        return Reponse(503, {"error": {"code": 503, "message": "The model is overloaded."}})
    assert proprietes["repliques"]["items"]["properties"]["animateur"]["enum"] == ["Léa", "Hugo"]
    return reponse_texte(SCRIPT)


def faux_post(url, json=None, data=None, files=None, timeout=None, headers=None):
    appels.append(("POST", url, json if json is not None else data, files))
    if "generativelanguage" in url:
        return faux_gemini(json, headers)
    if url.endswith("/api/evenement"):
        assert headers["X-Podcast-Secret"] == podcast.Bot("").secret
        return Reponse(200, {"ok": True})
    return Reponse(404, {"ok": False, "description": "inconnu"})


def faux_put(url, params=None, data=None, timeout=None, headers=None):
    nom = (params or {}).get("nom")
    appels.append(("PUT", url, nom, len(data or b"")))
    if not scenario["stockage"]:
        return Reponse(503, contenu=b"indisponible")
    fichiers_bot[nom] = data
    return Reponse(200, {"ok": True, "taille": len(data or b"")})


def appels_gemini(sorte):
    resultat = []
    for a in appels:
        if a[0] != "POST" or "generativelanguage" not in a[1]:
            continue
        corps = a[2]
        if corps["model"].endswith("-tts"):
            genre = "voix"
        elif "Tu repères dans l'agenda" in corps["system_instruction"]:
            genre = "deplacements"
        else:
            genre = "script"
        if genre == sorte:
            resultat.append(corps)
    return resultat


def evenements_bot(sorte=None):
    return [a[2] for a in appels if a[0] == "POST" and a[1].endswith("/api/evenement") and (sorte is None or a[2].get("type") == sorte)]


def recherches():
    return [unquote_plus(a[1].split("q=", 1)[1].split("&", 1)[0]) for a in appels
            if a[0] == "GET" and "news.google.com/rss/search" in a[1]]


def a_la_date(annee, mois, jour, heure=5, minute=46):
    podcast.heure_actuelle = lambda fuseau: dt.datetime(annee, mois, jour, heure, minute, tzinfo=ZH).astimezone(fuseau)


podcast.requests.get = faux_get
podcast.requests.post = faux_post
podcast.requests.put = faux_put
sommeils = []
podcast.time.sleep = sommeils.append
podcast.SEUIL_SCRIPT_COURT = 0   # le faux script est court : testé à part (5l)
a_la_date(2026, 10, 12)

# 5a. Premier épisode : confié au bot (audio et pochette), puis l'événement qui le décrit.
print("5a. Premier épisode")
code = podcast.main([])
verifier(code == 0, f"main() termine sans erreur (code {code})")
textes_gemini = appels_gemini("script")
verifier(len(textes_gemini) == 1, "un seul appel pour le script")
demande = textes_gemini[0]["input"]
verifier("SECRET" not in json.dumps(textes_gemini[0]), "le lien secret de l'agenda n'est pas envoyé à Gemini")
verifier("Réunion projet Alpha" in demande and "RTS" in demande, "agenda + actus dans la demande")
verifier("de 9 h à 10 h 30 : Réunion projet Alpha" in demande and "de midi à 13 h 30 : Déjeuner flottant" in demande,
         "heures correctes dans la demande de bout en bout")
verifier("Hors fenêtre" not in demande and "PROCHAIN ÉVÉNEMENT" not in demande,
         "agenda chargé : pas de « prochain événement », rien au-delà de 7 jours")
verifier("agenda 2 inaccessible" in demande, "agenda en panne signalé dans la demande")
dep = appels_gemini("deplacements")
verifier(len(dep) == 1 and "Réunion projet Alpha" in dep[0]["input"] and "Cours de yoga" not in dep[0]["input"]
         and "Hors fenêtre" not in dep[0]["input"], "repérage des déplacements : seulement les candidats à 14 jours")
verifier(dep and dep[0]["model"] == "gemini-3.5-flash-lite", "repérage confié au modèle léger")
verifier("DÉPLACEMENTS" not in demande, "aucun déplacement → pas de section")
voix = appels_gemini("voix")
modeles_voix = [c["model"] for c in voix]
verifier(modeles_voix[0] == "gemini-3.8-flash-tts" and all(mv == "gemini-3.8-flash-lite-tts" for mv in modeles_voix[1:]),
         "quota épuisé → modèle de voix suivant")
derniere = voix[-1]
verifier("mode" not in derniere["generation_config"]["speech_config"], "option refusée retirée")
contenu = derniere["input"][0]["content"]
verifier(all(c["annotations"][0] == {"type": "speech_metadata", "speaker": c["annotations"][0]["speaker"]}
             and c["annotations"][0]["speaker"] in ("Lea", "Hugo") for c in contenu),
         "chaque réplique porte son locuteur (ASCII), sans consigne de vitesse en mode normal")
textes = " ".join(c["text"] for c in contenu)
verifier("<excited>" not in textes and "📊" not in textes and "https" not in textes and "[1]" not in textes,
         "balise inconnue, emoji, URL et références retirés")
verifier("<breath>" in textes and "<laugh>" in textes and "|ah oui|" in textes and "|ah enfin|" in textes,
         "sons non verbaux et réactions conservés")
speakers = [c["annotations"][0]["speaker"] for c in contenu]
verifier(all(x != y for x, y in zip(speakers, speakers[1:])), "répliques consécutives fusionnées (alternance)")

depots = [a[2] for a in appels if a[0] == "PUT"]
verifier(len(depots) == 2 and depots[0] == "2026-10/2026-10-12-054600.mp3" and depots[1] == "2026-10/2026-10-12-054600.jpg",
         f"audio puis pochette confiés au bot, rangés par mois : {depots}")
mp3 = fichiers_bot[depots[0]]
pochette = fichiers_bot[depots[1]]
verifier(pochette[:2] == b"\xff\xd8" and len(pochette) < 200_000, "pochette JPEG (moins de 200 ko)")
episode = evenements_bot("episode")[-1]
(RACINE_TEST / "test.mp3").write_bytes(mp3)
verifier(episode["audio"] == depots[0] and episode["pochette"] == depots[1] and episode["taille"] == len(mp3)
         and episode["ref"] == 54600 and "message_id" not in episode and "file_id" not in episode,
         "l'événement de l'épisode désigne les fichiers gardés par le bot")
verifier(episode["titre"] == "Budget, neige et yoga", f"titre nettoyé : {episode['titre']}")
verifier(any("news.google.com/rss/articles/AAA" in s["url"] for s in episode["sources"]), "lien de la source citée")
if shutil.which("ffprobe"):
    sonde = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels:format=duration",
                            "-of", "json", str(RACINE_TEST / "test.mp3")], capture_output=True, text=True)
    infos = json.loads(sonde.stdout)
    verifier(infos["streams"][0]["codec_name"] == "mp3" and infos["streams"][0]["channels"] == 1, "MP3 mono valide")
    verifier(abs(float(infos["format"]["duration"]) - int(episode["duree"])) < 3, "durée annoncée ≈ durée réelle")
else:   # sans ffmpeg (machine de test GitHub) : en-tête MPEG et durée d'après le débit (64 kbit/s)
    verifier(mp3[0] == 0xFF and (mp3[1] & 0xE0) == 0xE0 and (mp3[3] >> 6) == 3, "MP3 valide (en-tête MPEG, mono)")
    verifier(abs(len(mp3) * 8 / 64000 - int(episode["duree"])) < 3, "durée annoncée ≈ durée réelle")
mem = memoire()
verifier(mem["dernier_episode"] == {"date": "2026-10-12", "titre": "Budget, neige et yoga", "envoye_le": "2026-10-12T05:46",
                                    "sujets": ["Agenda du jour", "Budget 2027", "Premières neiges"],
                                    "deplacements": [], "regles": []}, f"épisode mémorisé : {mem['dernier_episode']}")

# Préférences d'une installation d'avant le bot (gardées dans memoire.json) : elles s'appliquent encore.
m = memoire()
m["preferences"].update({"vitesse_parole": "lente", "ville_habituelle": "Lausanne", "sujets_preferes": ["technologie"],
                         "sujets_a_eviter": ["sport"], "consignes": ["plus d'humour"]})
m["a_approfondir"] = [{"sujet": "la réforme des retraites", "demande_le": "2026-10-12"}]
MEMOIRE.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")

# 5c. Épisode du lendemain : préférences appliquées, agenda vide → prochain événement + voyage.
print("\n5c. Épisode du lendemain (agenda vide, voyage à venir)")
appels.clear()
oublier_remplissage()
a_la_date(2026, 10, 13)
scenario.update({"agenda": ICS_VIDE, "quota_premier_modele_voix": False, "refuser_mode": False,
                 "refuser_style": True, "deplacements": [{
                     "lieu": "Barcelone", "pays": "Espagne", "quand": "du vendredi 6 au dimanche 8 novembre",
                     "nature": "voyage", "evenement": "Week-end à Barcelone", "recherche": "Barcelone"}]})
code = podcast.main([])
verifier(code == 0, f"épisode généré (code {code})")
demande = appels_gemini("script")[0]["input"]
systeme = appels_gemini("script")[0]["system_instruction"]
print("\n--- extrait de la demande envoyée à Gemini ---\n" + demande[:2200] + "\n---")
verifier("PROCHAIN ÉVÉNEMENT (dans 24 jours, vendredi 6 novembre 2026)" in demande, "agenda vide → prochain événement")
dep = appels_gemini("deplacements")
verifier(dep and "Week-end à Barcelone" in dep[0]["input"] and "Lausanne" in dep[0]["system_instruction"],
         "le prochain événement (dans 24 jours) est examiné comme déplacement, avec la ville de l'auditeur")
verifier("=== DÉPLACEMENTS ===" in demande and "Barcelone (Espagne) — voyage, du vendredi 6 au dimanche 8 novembre" in demande
         and "Dernières nouvelles : Barcelone" in demande, "section DÉPLACEMENTS avec les actus du lieu")
verifier("=== À APPROFONDIR (demandé par l'auditeur) ===" in demande and "la réforme des retraites" in demande
         and "Dernières nouvelles : la réforme des retraites" in demande, "sujet à creuser + articles trouvés")
verifier("Dernières nouvelles : technologie" in demande and "centre d'intérêt : technologie" in demande
         and "=== ACTU LOCALE (Lausanne) ===" in demande and "actu locale : Lausanne" in demande,
         "recherches sur les centres d'intérêt, et section ACTU LOCALE séparée")
verifier("=== ÉPISODE PRÉCÉDENT ===" in demande and "Épisode d'hier : « Budget, neige et yoga »" in demande,
         "rappel de l'épisode de la veille (pour ne pas se répéter)")
faites = recherches()
verifier("la réforme des retraites when:14d" in faites and "Barcelone when:7d" in faites
         and "technologie when:36h" in faites and "Lausanne when:7d" in faites, f"recherches : {faites}")
verifier("Thèmes qui ne l'intéressent pas : sport" in systeme and "plus d'humour" in systeme
         and "entre 960 et" in systeme, "préférences et vitesse transmises au rédacteur")
voix = appels_gemini("voix")
styles = [c["input"][0]["content"][0]["annotations"][0].get("style") for c in voix]
verifier(styles[0] == "speaking a little slowly" and styles[-1] is None,
         f"vitesse lente demandée à la voix, retirée si l'API la refuse : {styles}")
mem = memoire()
verifier(mem["a_approfondir"] == [] and mem["dernier_episode"]["deplacements"] == ["Barcelone"]
         and mem["dernier_episode"]["date"] == "2026-10-13", "sujets creusés oubliés, épisode mémorisé")
verifier(mem["preferences"]["vitesse_parole"] == "lente", "préférences durables conservées")

# 5e. Audio WAV et audio tronqué.
print("\n5e. Audio WAV et audio tronqué")
appels.clear()
oublier_remplissage()
m = memoire()
m["preferences"]["duree_minutes"] = 7.0
MEMOIRE.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
scenario.update({"wav": True, "tronquer_une_fois": True, "agenda": ICS, "refuser_style": False, "deplacements": []})
a_la_date(2026, 10, 14)
code = podcast.main([])
voix = appels_gemini("voix")
verifier(code == 0, "WAV accepté")
verifier(len(voix) == 3, f"audio tronqué → nouvelle tentative en deux moitiés ({len(voix)} appels)")
verifier("mode" in voix[0]["generation_config"]["speech_config"], "option conversational envoyée quand elle est acceptée")
episodes = evenements_bot("episode")
verifier(episodes and episodes[-1].get("rubriques") and all(r["texte"] and r["titre"] for r in episodes[-1]["rubriques"].values()),
         "l'événement de l'épisode porte le texte de chaque rubrique (pour son résumé dans l'application)")
debit = memoire()["debit_mots_minute"]["lente"]
verifier(f"entre {7 * debit} et" in appels_gemini("script")[0]["system_instruction"],
         f"durée de 7 minutes appliquée, au débit mesuré pour « lente » ({debit} mots/min)")
# Gemini a écrit court (script de test de ~95 mots) : le podcast s'en souvient et demande plus la fois suivante.
rempl = memoire()["remplissage"]
verifier(isinstance(rempl, float) and 0.5 <= rempl < 0.9,
         f"longueur : Gemini a écrit court, le réglage de remplissage baisse ({rempl})")
mots_avant = 7 * debit
verifier(round(mots_avant / max(0.5, rempl)) > mots_avant, "longueur : la consigne suivante demandera plus de mots que la durée choisie")
verifier(podcast._remplissage({"remplissage": 0.1}) == 0.5 and podcast._remplissage({}) == 1.0 and podcast._remplissage({"remplissage": 2}) == 1.0,
         "remplissage : borné entre 0,5 et 1, 1 sans mesure")

# 5f. Essai local sans envoi : la mémoire n'est pas modifiée.
print("\n5f. Essai sans envoi")
avant = MEMOIRE.read_text(encoding="utf-8")
appels.clear()
with contextlib.redirect_stdout(io.StringIO()):
    code = podcast.main(["--sans-envoi"])
verifier(code == 0 and (RACINE_TEST / "sortie" / "podcast-2026-10-14.mp3").exists(), "MP3 écrit dans sortie/")
verifier(MEMOIRE.read_text(encoding="utf-8") == avant and not [a for a in appels if a[0] == "PUT"] and not evenements_bot(),
         "rien confié au bot, mémoire intacte")

# 5g. Le bot ne peut pas garder l'épisode : rien n'est parti, la mémoire le sait.
print("\n5g. Bot sans stockage")
appels.clear()
scenario["stockage"] = False
a_la_date(2026, 10, 15, 5, 46)
with contextlib.redirect_stdout(io.StringIO()):
    code = podcast.main(["--mode", "manuel"])
echec = evenements_bot("echec")
verifier(code == 1 and len([a for a in appels if a[0] == "PUT"]) == 2 and not evenements_bot("episode"),
         "dépôt refusé (deux essais) : pas d'épisode annoncé, code 1")
verifier(echec and "garder" in echec[-1]["message"], f"échec signalé par notification : {echec}")
verifier(memoire()["dernier_episode"]["date"] == "2026-10-14", "épisode non marqué comme envoyé")
scenario["stockage"] = True
m = memoire()
m["preferences"] = podcast.memoire_vide()["preferences"]
MEMOIRE.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")

# 5h. Gemini surchargé : on passe vite au modèle suivant, jusqu'au modèle léger.
print("\n5h. Gemini surchargé")
appels.clear()
sommeils.clear()
scenario["pannes"] = {"gemini-3.8-flash": ["timeout"], "gemini-3.6-flash": ["429", "429"],
                      "gemini-flash-latest": ["429", "429"]}
a_la_date(2026, 10, 15)
code = podcast.main([])
essais = [c["model"] for c in appels_gemini("script")]
verifier(code == 0 and essais == ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
         f"modèle muet ou refus → suivant tout de suite, sans user le quota ; modèle léger en dernier recours : {essais}")
verifier([x for x in sommeils if x > 10] == [], f"aucune attente inutile : {sommeils}")
verifier(memoire()["dernier_episode"]["date"] == "2026-10-15", "épisode quand même envoyé")

# 5i. Tous surchargés au premier tour : nouveau tour après une pause.
print("\n5i. Tous surchargés, puis ça repart")
appels.clear()
sommeils.clear()
scenario["pannes"] = {"gemini-3.8-flash": ["timeout"], "gemini-3.6-flash": ["429"],
                      "gemini-3.5-flash-lite": ["timeout"], "gemini-3.1-flash-lite": ["timeout"]}
a_la_date(2026, 10, 16)
code = podcast.main([])
essais = [c["model"] for c in appels_gemini("script")]
verifier(code == 0 and 60 in sommeils and essais == ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite",
                                                     "gemini-3.1-flash-lite", "gemini-3.8-flash"],
         f"second tour après 60 s, sans redemander au modèle qui a refusé : {essais} / attentes {sommeils}")

# 5j. Rattrapage : seulement si l'épisode du matin n'est pas parti.
print("\n5j. Rattrapage")
appels.clear()
os.environ["RATTRAPAGE"] = "true"
code = podcast.main([])
verifier(code == 0 and not appels_gemini("script") and not evenements_bot("episode"),
         "épisode déjà parti ce matin → le rattrapage ne refait rien")
appels.clear()
a_la_date(2026, 10, 17, 6, 46)
code = podcast.main([])
verifier(code == 0 and appels_gemini("script") and evenements_bot("episode"),
         "épisode pas encore parti → le rattrapage l'envoie")
del os.environ["RATTRAPAGE"]
# Les secrets GitHub présents sont signalés au bot (écran Connexions) par l'épisode, pas par la lecture
# des agendas, qui n'en reçoit qu'une partie (sinon Tavily semblerait avoir disparu).
ancien_get_secrets = podcast.requests.get


def get_bot_secrets(url, timeout=None, headers=None):
    if url.endswith("/api/config"):
        return Reponse(200, {"format": "bot-v2", "version": "test", "config": {}})
    return ancien_get_secrets(url, timeout=timeout, headers=headers)


podcast.requests.get = get_bot_secrets
os.environ["RATTRAPAGE"] = "true"
appels.clear()
with contextlib.redirect_stdout(io.StringIO()):
    podcast.main([])
verifier(evenements_bot("secrets"), "l'épisode signale au bot les secrets GitHub présents")
del os.environ["RATTRAPAGE"]
appels.clear()
with contextlib.redirect_stdout(io.StringIO()):
    podcast.main(["--agendas"])
podcast.requests.get = ancien_get_secrets
verifier(not evenements_bot("secrets"), "lecture des agendas : secrets GitHub pas signalés")

# 5k. Échec à l'heure prévue : notification rassurante, pas d'e-mail d'échec, rattrapage annoncé.
print("\n5k. Échec avec rattrapage prévu")
appels.clear()
sommeils.clear()
scenario["pannes"] = {m: ["timeout"] * 3 for m in ("gemini-3.8-flash", "gemini-3.6-flash",
                                                   "gemini-3.5-flash-lite", "gemini-3.1-flash-lite")}
ancien_get = podcast.requests.get


def get_bot_planning(url, timeout=None, headers=None):
    if url.endswith("/api/config"):
        appels.append(("GET", url))
        return Reponse(200, {"format": "bot-v2", "version": "test", "heure_prevue_aujourdhui": "05:45",
                             "config": {"planning": {"rattrapage": True, "delai_rattrapage": 60}}})
    return ancien_get(url, timeout=timeout, headers=headers)


podcast.requests.get = get_bot_planning
a_la_date(2026, 10, 18)
with contextlib.redirect_stdout(io.StringIO()) as sortie:
    code = podcast.main(["--mode", "planifie"])
podcast.requests.get = ancien_get
alerte = evenements_bot("echec")
verifier(code == 0 and "::warning::" in sortie.getvalue(), "code 0 (le rattrapage s'en charge) + avertissement dans GitHub")
verifier(alerte and alerte[-1]["titre"].startswith("⏳") and "Nouvel essai automatique à 6 h 45" in alerte[-1]["message"]
         and "Les serveurs de Gemini ne répondent pas" in alerte[-1]["message"], f"notification claire : {alerte}")
verifier(sommeils.count(60) == 1 and sommeils.count(180) == 1, f"trois tours espacés : {sommeils}")
verifier(memoire()["dernier_episode"]["date"] == "2026-10-17", "épisode du jour non marqué comme envoyé")
scenario["pannes"] = {}

# 5l. Script trop court : une seconde demande, plus longue, au même modèle.
print("\n5l. Script trop court")
appels.clear()
podcast.SEUIL_SCRIPT_COURT = 0.8
a_la_date(2026, 10, 19)
code = podcast.main([])
scripts = appels_gemini("script")
verifier(code == 0 and len(scripts) == 2 and "c'est trop court" in scripts[1]["input"]
         and scripts[1]["model"] == scripts[0]["model"], "une seule relance, au même modèle, en demandant plus de mots")
mem = memoire()
verifier(isinstance(mem["debit_mots_minute"].get("lente"), int), f"débit mesuré mémorisé : {mem['debit_mots_minute']}")
podcast.SEUIL_SCRIPT_COURT = 0

# 5n. Ancien format de preferences.json (réglages et sujets à creuser).
print("\n5n. Ancien preferences.json")
appels.clear()
(RACINE_TEST / "preferences.json").write_text(json.dumps({
    "preferences": {"vitesse_parole": "rapide", "duree_minutes": 4, "ville_habituelle": "Yverdon",
                    "sujets_preferes": [], "sujets_a_eviter": ["sport"], "consignes": []},
    "a_approfondir": [{"sujet": "ancien sujet", "demande_le": "2026-10-19T04:00"},
                      {"sujet": "élections fédérales", "demande_le": "2026-10-19T21:40"}]}), encoding="utf-8")
a_la_date(2026, 10, 20, 7, 31)
code = podcast.main([])
systeme = appels_gemini("script")[0]["system_instruction"]
demande = appels_gemini("script")[0]["input"]
verifier(code == 0 and evenements_bot("episode"), "épisode confié au bot")
verifier("pour durer 5 minutes" in systeme, "durée lue dans preferences.json (4 min + 1 pour l'approfondissement)")
verifier("élections fédérales" in demande and "ancien sujet" not in demande,
         "seul le sujet demandé après le dernier épisode est approfondi")
verifier("Thèmes qui ne l'intéressent pas : sport" in systeme, "thèmes évités lus dans preferences.json")
(RACINE_TEST / "preferences.json").unlink()

# ─────────────── 6. erreurs : clé invalide, jeton du bot absent ───────────────
print("\n6. Messages d'erreur")
ancien_post = podcast.requests.post


def post_cle_invalide(url, **kw):
    if "generativelanguage" in url:
        appels.append(("POST", url, kw.get("json"), None))
        return Reponse(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.",
                                       "details": [{"reason": "API_KEY_INVALID"}]}})
    return ancien_post(url, **kw)


appels.clear()
podcast.requests.post = post_cle_invalide
with contextlib.redirect_stdout(io.StringIO()):
    code = podcast.main([])
alerte = evenements_bot("echec")
verifier(code == 1 and alerte and "clé Gemini est refusée" in alerte[-1]["message"], f"clé invalide → code 1 + notification claire : {alerte}")
podcast.requests.post = ancien_post
os.environ["BOT_GITHUB_TOKEN"] = ""
appels.clear()
journal_capture = io.StringIO()
with contextlib.redirect_stdout(journal_capture):
    code = podcast.main([])
verifier(code == 1 and "BOT_GITHUB_TOKEN" in journal_capture.getvalue() and not appels_gemini("script"),
         "sans jeton GitHub du bot : message clair, rien de préparé pour rien")
os.environ["BOT_GITHUB_TOKEN"] = "gh-jeton-test"

# Consignes : une vraie phrase n'est pas coupée ; les autres listes restent courtes.
longue = "Rappelle-moi uniquement la veille et le jour de l'événement piscine de prendre mon maillot et ma serviette"
verifier(podcast.nettoyer_liste([longue], 20, podcast.LONGUEUR_CONSIGNE) == [longue], "consigne de plus de 80 caractères gardée entière")
verifier(len(podcast.nettoyer_liste(["mot " * 50])[0]) <= 81, "les autres listes restent limitées à 80 caractères (plus « … »)")
verifier(podcast.effectifs_depuis_bot(podcast.charger_reglages(podcast.RACINE / "reglages.toml"), podcast.memoire_vide(),
                                     {"consignes": [longue]})["consignes"] == [longue], "consigne longue transmise à l'épisode")

# Dépôt sans bot (le modèle) : les créneaux programmés ne lancent aucun épisode.
import tempfile
with tempfile.TemporaryDirectory() as dossier:
    sortie = Path(dossier) / "sortie.txt"
    anciens = {k: os.environ.get(k) for k in ("EVENEMENT", "BOT_GITHUB_TOKEN", "BOT_URL", "RACINE", "GITHUB_OUTPUT")}
    os.environ.update({"EVENEMENT": "schedule", "BOT_GITHUB_TOKEN": "", "BOT_URL": "", "RACINE": dossier,
                       "GITHUB_OUTPUT": str(sortie)})
    with contextlib.redirect_stdout(io.StringIO()):
        horaire.main()
    for cle, valeur in anciens.items():
        if valeur is None:
            os.environ.pop(cle, None)
        else:
            os.environ[cle] = valeur
    verifier("go=false" in sortie.read_text(), "dépôt sans bot : pas d'épisode programmé")
    # Le filet de sécurité lit le bot avec le secret du jeton GitHub.
    vus, lire_bot = [], horaire.lire_bot
    horaire.lire_bot = lambda adresse, jeton: vus.append(jeton) or None
    ancien_jeton = os.environ.get("BOT_GITHUB_TOKEN")
    os.environ.update({"EVENEMENT": "schedule", "BOT_GITHUB_TOKEN": "gh-jeton", "BOT_URL": "https://bot.exemple",
                       "RACINE": dossier, "GITHUB_OUTPUT": str(sortie)})
    with contextlib.redirect_stdout(io.StringIO()):
        horaire.main()
    horaire.lire_bot = lire_bot
    os.environ["BOT_GITHUB_TOKEN"] = ancien_jeton or ""
    verifier(vus == ["gh-jeton"] and "go=false" in sortie.read_text(), f"filet de sécurité : le bot est lu avec le jeton GitHub ({vus})")

# Clés et agendas saisis dans l'application : appliqués et masqués dans le journal de GitHub.
import liaison
anciens = {k: os.environ.get(k) for k in ("GEMINI_API_KEY", "TAVILY_API_KEY", "SNCF_API_KEY", "CALENDAR_ICS_URL", "GITHUB_ACTIONS")}
os.environ.update({"GEMINI_API_KEY": "secret-github", "CALENDAR_ICS_URL": "https://a.example/1.ics", "GITHUB_ACTIONS": "true"})
os.environ.pop("TAVILY_API_KEY", None); os.environ.pop("SNCF_API_KEY", None)
presents = liaison.secrets_presents()
sortie_masques = io.StringIO()
with contextlib.redirect_stdout(sortie_masques):
    appliquees = liaison.appliquer_cles({"cles": {"gemini": "cle-app", "tavily": "tvly-app"}, "agendas_urls": ["https://b.example/2.ics", "https://a.example/1.ics"]})
verifier(presents == ["GEMINI_API_KEY", "CALENDAR_ICS_URL"], f"secrets GitHub présents : {presents}")
verifier(os.environ["GEMINI_API_KEY"] == "cle-app" and os.environ["TAVILY_API_KEY"] == "tvly-app"
         and os.environ["CALENDAR_ICS_URL"].split() == ["https://a.example/1.ics", "https://b.example/2.ics"], "clés et agendas de l'application appliqués (sans doublon)")
verifier("::add-mask::cle-app" in sortie_masques.getvalue() and "::add-mask::https://b.example/2.ics" in sortie_masques.getvalue(), "valeurs masquées dans le journal")
verifier(set(appliquees) == {"GEMINI_API_KEY", "TAVILY_API_KEY", "CALENDAR_ICS_URL"}, f"appliquées : {appliquees}")
for cle, valeur in anciens.items():
    if valeur is None:
        os.environ.pop(cle, None)
    else:
        os.environ[cle] = valeur

# Le modèle annonce la version du bot (version.json = VERSION de cloudflare/src/etat.js).
version_modele = json.loads((PROJET / "version.json").read_text(encoding="utf-8"))
version_bot = re.search(r'export const VERSION = "([^"]+)"', (PROJET / "cloudflare" / "src" / "etat.js").read_text(encoding="utf-8")).group(1)
verifier(version_modele["version"] == version_bot, f"version.json ({version_modele['version']}) = VERSION du bot ({version_bot})")

# Mise à jour depuis le modèle : tout sauf les fichiers personnels, repères remplacés.
import mise_a_jour
with tempfile.TemporaryDirectory() as dossier:
    modele, copie = Path(dossier) / "modele", Path(dossier) / "copie"
    for base in (modele, copie):
        (base / ".github" / "workflows").mkdir(parents=True)
    (modele / "version.json").write_text(json.dumps({"version": "9", "supprimes": ["vieux.py", "memoire.json"]}), encoding="utf-8")
    (modele / "podcast.py").write_text(f"DEPOT = '{mise_a_jour.REPERE_DEPOT}' ; BOT = 'https://{mise_a_jour.REPERE_HOTE}'\n", encoding="utf-8")
    (modele / "memoire.json").write_text("{}\n", encoding="utf-8")
    (modele / "reglages.toml").write_text("fuseau_horaire = \"Europe/Zurich\"\n", encoding="utf-8")
    (modele / ".github" / "workflows" / "a.yml").write_text("name: A\n", encoding="utf-8")
    (copie / "memoire.json").write_text('{"dernier_episode": {"date": "2026-10-20"}}\n', encoding="utf-8")
    (copie / "reglages.toml").write_text("fuseau_horaire = \"Europe/Paris\"\n", encoding="utf-8")
    (copie / "vieux.py").write_text("x = 1\n", encoding="utf-8")
    (copie / "outils.py").write_text("y = 2\n", encoding="utf-8")
    changes, supprimes = mise_a_jour.copier(modele, copie, "alice/podcast-matin", "podcast.alice.workers.dev")
    verifier("alice/podcast-matin" in (copie / "podcast.py").read_text() and "podcast.alice.workers.dev" in (copie / "podcast.py").read_text(),
             "mise à jour : dépôt et adresse du bot de la personne")
    verifier("dernier_episode" in (copie / "memoire.json").read_text() and "Paris" in (copie / "reglages.toml").read_text(),
             "mise à jour : memoire.json et reglages.toml intacts")
    verifier(supprimes == ["vieux.py"] and (copie / "outils.py").exists() and (copie / "memoire.json").exists(), f"mise à jour : seuls les fichiers retirés du modèle disparaissent ({supprimes})")
    verifier(".github/workflows/a.yml" in changes, "mise à jour : fichiers d'automatisation copiés")
    (copie / ".github" / "workflows" / "a.yml").unlink()
    changes2, _ = mise_a_jour.copier(modele, copie, "alice/podcast-matin", "podcast.alice.workers.dev", sans_workflows=True)
    verifier(changes2 == [] and not (copie / ".github" / "workflows" / "a.yml").exists(), "sans la permission Workflows : automatisation laissée de côté")

# Les repères n'apparaissent que sous leur forme exacte : chez chacun, il n'en reste aucun
# (une forme échappée, comme dans une expression régulière, échapperait au remplacement).
# Vérifié dans le modèle seulement : un dépôt personnel peut avoir ses propres fichiers.
def reperes_restants() -> list[str]:
    ignores = {"node_modules", ".git", ".wrangler", "__pycache__", "sortie", ".venv"}
    with tempfile.TemporaryDirectory() as dossier:
        propre, copie = Path(dossier) / "modele", Path(dossier) / "copie"
        shutil.copytree(PROJET, propre, ignore=lambda d, noms: [n for n in noms if n in ignores])
        copie.mkdir()
        mise_a_jour.copier(propre, copie, "alice/podcast-matin", "podcast.alice.workers.dev")
        return [str(f.relative_to(copie)) for f in copie.rglob("*")
                if f.is_file() and f.suffix in mise_a_jour.TEXTE
                and f.name != "mise_a_jour.py"   # il garde les repères, écrits en deux morceaux
                and any(r in f.read_text(encoding="utf-8", errors="replace") for r in ("TON-" "COMPTE", "TON-" "SOUS-DOMAINE"))]

if mise_a_jour.REPERE_DEPOT in (PROJET / "cloudflare" / "wrangler.toml").read_text(encoding="utf-8"):
    restes = reperes_restants()
    verifier(not restes, f"mise à jour : aucun repère du modèle ne reste chez chacun {restes}")

# Mise à jour de bout en bout, sur des dépôts locaux (clone, envoi, repli sans « Workflows »).
import subprocess as sp
def initialiser(chemin: Path, fichiers: dict[str, str]) -> None:
    for nom, texte in fichiers.items():
        (chemin / nom).parent.mkdir(parents=True, exist_ok=True)
        (chemin / nom).write_text(texte, encoding="utf-8")
    for commande in (["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "départ"]):
        sp.run(["git", *commande], cwd=chemin, check=True, capture_output=True)

journaux_maj: dict[str, str] = {}

def essai_maj(jeton_github: str) -> tuple[Path, list[dict], list[str]]:
    dossier = Path(tempfile.mkdtemp())
    modele, origine, travail = dossier / "modele", dossier / "origine.git", dossier / "travail"
    modele.mkdir()
    initialiser(modele, {
        "version.json": json.dumps({"version": "2099-01-01.1", "supprimes": ["vieux.py", ".github/workflows/retours.yml"]}),
        "podcast.py": f"DEPOT = '{mise_a_jour.REPERE_DEPOT}'\n",
        "cloudflare/wrangler.toml": f'ADRESSE = "https://{mise_a_jour.REPERE_HOTE}"\n',
        "reglages.toml": "fuseau_horaire = \"Europe/Zurich\"\n",
        ".github/workflows/nouveau.yml": "name: Nouveau\n",
    })
    sp.run(["git", "init", "-q", "--bare", "-b", "main", str(origine)], check=True)
    travail.mkdir()
    initialiser(travail, {
        "podcast.py": "ancien = True\n", "vieux.py": "x = 1\n", "memoire.json": '{"a": 1}\n',
        "reglages.toml": "fuseau_horaire = \"Europe/Paris\"\n",
        "cloudflare/wrangler.toml": 'ADRESSE = "https://podcast.alice.workers.dev"\n',
        ".github/workflows/retours.yml": "name: Messages\n",
    })
    sp.run(["git", "remote", "add", "origin", str(origine)], cwd=travail, check=True)
    sp.run(["git", "push", "-q", "origin", "main"], cwd=travail, check=True, capture_output=True)
    evenements, relances = [], []
    git_real = mise_a_jour.git
    def git_simule(*args, cwd=None, verifier=True):
        args = list(args)
        if "clone" in args:
            args[args.index("https://github.com/auteur/modele.git")] = str(modele)
        if "push" in args and any("x-access-token" in a for a in args):
            if "x-access-token:bon@" not in " ".join(args):   # jeton sans « Workflows » : refusé
                return sp.CompletedProcess(args, 1, "", "refusing to allow ... workflow")
            args = [a if "x-access-token" not in a else str(origine) for a in args]
        return git_real(*args, cwd=cwd, verifier=verifier)
    anciens = (mise_a_jour.RACINE, mise_a_jour.git, mise_a_jour.prevenir_bot, mise_a_jour.relancer_deploiement)
    mise_a_jour.RACINE, mise_a_jour.git = travail, git_simule
    mise_a_jour.prevenir_bot = lambda adresse, ev: evenements.append(ev)
    mise_a_jour.relancer_deploiement = lambda: relances.append("deployer-bot")
    ancien_env = dict(os.environ)
    os.environ.update({"MODELE": "auteur/modele", "GITHUB_REPOSITORY": "alice/podcast-matin", "ADRESSE": "",
                       "VERSION": "", "BOT_GITHUB_TOKEN": jeton_github})
    journal = io.StringIO()   # ses notices iraient sinon dans le résumé de l'exécution GitHub
    try:
        with contextlib.redirect_stdout(journal):
            code = mise_a_jour.main()
    finally:
        mise_a_jour.RACINE, mise_a_jour.git, mise_a_jour.prevenir_bot, mise_a_jour.relancer_deploiement = anciens
        journaux_maj[jeton_github] = journal.getvalue()
        os.environ.clear(); os.environ.update(ancien_env)
    verifier(code == 0, f"mise à jour (jeton {jeton_github or 'absent'}) : code 0")
    resultat = dossier / "resultat"
    sp.run(["git", "clone", "-q", str(origine), str(resultat)], check=True, capture_output=True)
    return resultat, evenements, relances

resultat, evenements, relances = essai_maj("bon")
verifier((resultat / ".github/workflows/nouveau.yml").exists() and not (resultat / ".github/workflows/retours.yml").exists(),
         "mise à jour avec « Workflows » : automatisation remplacée")
verifier("alice/podcast-matin" in (resultat / "podcast.py").read_text() and "podcast.alice.workers.dev" in (resultat / "cloudflare/wrangler.toml").read_text(),
         "mise à jour : adresse du bot reprise de l'ancien wrangler.toml")
verifier('"a": 1' in (resultat / "memoire.json").read_text() and "Paris" in (resultat / "reglages.toml").read_text() and not (resultat / "vieux.py").exists(),
         "mise à jour : fichiers personnels gardés, anciens fichiers retirés")
verifier(evenements and evenements[-1].get("ok") and evenements[-1].get("workflows") and evenements[-1].get("version") == "2099-01-01.1" and not relances,
         f"mise à jour : bot prévenu, déploiement lancé par l'envoi lui-même {evenements}")
resultat, evenements, relances = essai_maj("")
verifier(not (resultat / ".github/workflows/nouveau.yml").exists() and (resultat / ".github/workflows/retours.yml").exists()
         and "alice/podcast-matin" in (resultat / "podcast.py").read_text(),
         "mise à jour sans jeton « Workflows » : code à jour, automatisation laissée")
verifier(relances == ["deployer-bot"] and evenements and evenements[-1].get("ok") and evenements[-1].get("workflows") is False
         and "Workflows" in evenements[-1].get("message", ""), f"sans jeton : bot redéployé et prévenu de la permission manquante {evenements}")
resultat, evenements, relances = essai_maj("mauvais")
verifier(not (resultat / ".github/workflows/nouveau.yml").exists() and relances == ["deployer-bot"] and evenements[-1].get("workflows") is False,
         "jeton refusé : repli sans les fichiers d'automatisation")
verifier("::notice title=Jeton GitHub::secret GitHub BOT_GITHUB_TOKEN." in journaux_maj["bon"]
         and "::notice title=Jeton GitHub::aucun" in journaux_maj[""] and not re.search(r"\bbon\b", journaux_maj["bon"].replace("::add-mask::bon", "")),
         "mise à jour : d'où vient le jeton, dans le résumé (jamais sa valeur)")

# Code de connexion à l'application : demandé au bot, affiché dans le résumé de GitHub.
print("\nCode de connexion")
import code_connexion
import urllib.error


class FausseReponseUrl(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def essai_code(arguments, reponse, env=None):
    vu = {}

    def ouvrir(requete, timeout=None):
        vu["url"], vu["secret"] = requete.full_url, requete.get_header("X-podcast-secret")
        if isinstance(reponse, Exception):
            raise reponse
        return FausseReponseUrl(json.dumps(reponse).encode())
    with tempfile.TemporaryDirectory() as dossier:
        resume_fichier = Path(dossier) / "resume.md"
        env_avant = dict(os.environ)
        os.environ.update({"BOT_URL": "https://podcast.alice.workers.dev", "BOT_GITHUB_TOKEN": "gh-jeton",
                           "GITHUB_STEP_SUMMARY": str(resume_fichier), **(env or {})})
        ancien = code_connexion.urllib.request.urlopen
        code_connexion.urllib.request.urlopen = ouvrir
        sortie = io.StringIO()
        try:
            with contextlib.redirect_stdout(sortie):
                code = code_connexion.main(arguments)
        finally:
            code_connexion.urllib.request.urlopen = ancien
            os.environ.clear(); os.environ.update(env_avant)
        return code, sortie.getvalue(), resume_fichier.read_text(encoding="utf-8") if resume_fichier.exists() else "", vu


code, sortie, resume_md, vu = essai_code(["--premiere"], {"ok": True, "code": "123456", "jusqua": "09:41", "adresse": "https://podcast.alice.workers.dev/app"})
verifier(code == 0 and "**123456**" in resume_md and "https://podcast.alice.workers.dev/app#code=123456" in resume_md and "9 h 41" in resume_md
         and vu["url"].endswith("/api/code-connexion?si=premiere") and vu["secret"] == liaison.secret_partage("gh-jeton"),
         "code de connexion : demandé avec le secret du jeton GitHub, affiché dans le résumé (code et lien)")
verifier("::notice title=Code de connexion::123456" in sortie, "code aussi en annotation de l'exécution")
code, sortie, resume_md, _ = essai_code(["--premiere"], {"ok": True, "code": None, "raison": "deja_connecte"})
verifier(code == 0 and "déjà connecté" in resume_md and "Code de connexion" in resume_md and not re.search(r"\*\*\d{6}\*\*", resume_md),
         "appareil déjà connecté : pas de code à la fin du déploiement, mais le résumé dit pourquoi et comment en avoir un")
code, sortie, _, _ = essai_code([], urllib.error.HTTPError("u", 403, "interdit", {}, None))
verifier(code == 1 and "::error::" in sortie and "Déployer le bot" in sortie, "secret refusé : erreur claire (workflow « Code de connexion »)")
code, sortie, _, _ = essai_code(["--premiere"], urllib.error.URLError("pas de réseau"))
verifier(code == 0 and "::warning::" in sortie and "BOT_URL" in sortie, "bot injoignable en fin de déploiement : simple avertissement")
code, sortie, _, _ = essai_code([], {}, {"BOT_GITHUB_TOKEN": ""})
verifier(code == 1 and "BOT_GITHUB_TOKEN" in sortie, "sans jeton : message clair")

# ── Point sur un sujet (recherche ponctuelle « point ») : un podcast, pas des articles ──
print("\n▶ Point sur un sujet")
import recherche as _recherche  # noqa: E402
import regles as _moteur  # noqa: E402


class _BotPoint:
    secret = "s"

    def __init__(self):
        self.evenements, self.deposes = [], []

    def deposer(self, nom, octets, type_):
        self.deposes.append(nom)
        return True

    def evenement(self, ev):
        self.evenements.append(ev)


_vus = {}
_anciens = (podcast.demander_json, podcast.synthetiser, podcast.encoder_mp3)
try:
    def _demander(systeme, entree, schema, modeles, cle, **_):
        _vus["systeme"], _vus["entree"] = systeme, entree
        return {"titre": "Les retards CFF", "sujets": ["chantiers", "ponctualité"], "sources": [],
                "repliques": [{"animateur": n, "texte": t} for n, t in (("Kore", "Bonjour."), ("Puck", "Le point."),
                                                                         ("Kore", "Les chantiers."), ("Puck", "À demain."))]}, "m"
    podcast.demander_json = _demander
    podcast.synthetiser = lambda script, effectifs, cle, minutage=None: (b"\0\0" * 24000 * 3, 24000)
    podcast.encoder_mp3 = lambda pcm, taux, debit: b"mp3"
    _regle = {"id": "R9", "titre": "Retards CFF", "consigne": "Fais le point sur les retards des CFF en ce moment",
              "periode": {"type": "ponctuelle"}, "recherche": {"rendu": "point", "minutes": 3, "sources": ["web", "actus"], "fiche": {}}}
    _collecte = _moteur.Collecte(regle=_regle, plan={}, texte="Recherche web :\n  [W1] CFF : ponctualité en baisse — …",
                                 liens=[("CFF : ponctualité en baisse", "https://exemple.ch/cff"), ("doublon", "http://non-https.ch")])
    _bot = _BotPoint()
    _effectifs = {"animateurs": [{"nom": "Kore"}, {"nom": "Puck"}], "mots_par_minute": 150, "tutoiement": True,
                  "modeles_texte": ["m"], "modeles_rapides": [], "debit_mp3_kbps": 64}
    _code = _recherche.lancer_point([_regle], [_collecte], _effectifs, "cle", dt.datetime(2026, 10, 23, 21, 0, tzinfo=ZH), _bot)
finally:
    podcast.demander_json, podcast.synthetiser, podcast.encoder_mp3 = _anciens
_ev = _bot.evenements[0] if _bot.evenements else {}
verifier(_code == 0 and _ev.get("format") == "point" and _ev.get("audio") and _bot.deposes[0].startswith("2026-10/point-R9-"),
         "point : un podcast déposé chez le bot, annoncé comme « point »")
verifier("3 minutes" in _vus.get("systeme", "") and "environ 450 mots" in _vus.get("systeme", "") and "état des lieux" in _vus.get("systeme", ""),
         "point : la durée demandée (3 min) règle la longueur du script, consigne d'état des lieux")
verifier(_ev.get("resultats", [{}])[0].get("sources") == [{"titre": "CFF : ponctualité en baisse", "lien": "https://exemple.ch/cff"}]
         and _ev.get("idees") == [], "point : sources gardées (https seulement), aucune « idée » ni article listé")

# ── Rubriques essentielles à la demande (menu « ··· » de leur fiche) ──
print("\n▶ Rubriques essentielles : chercher maintenant, mini-podcast")
verifier(podcast.identifiants_recherche("R5, actualites ; Agenda inconnue r7") == ["R5", "actualites", "agenda", "R7"],
         "identifiants d'une recherche : règles et rubriques essentielles")
verifier(set(_recherche.ESSENTIELLES) == set(podcast.RUBRIQUES_ESSENTIELLES), "mêmes rubriques essentielles des deux côtés")


def _echoue(fonction, *arguments):
    try:
        fonction(*arguments)
    except podcast.ErreurPodcast as erreur:
        return str(erreur)
    return ""


_config = {"actus": {"ville": "Yverdon"}, "a_approfondir": [{"sujet": "réforme des retraites"}, {"sujet": "tarifs CFF"}]}
_ess = {c: _recherche.regle_essentielle(c, _config, "Yverdon") for c in _recherche.ESSENTIELLES}
verifier(_ess["agenda"]["recherche"]["sources"] == ["agenda"] and _ess["deplacements"]["recherche"]["sources"] == ["agenda", "web", "actus"],
         "essentielles : les sources de l'épisode (agenda, déplacements)")
verifier(_ess["actu_locale"]["recherche"]["requetes"] == ["actualité Yverdon"] and "Yverdon" in _ess["actu_locale"]["consigne"],
         "actu locale : cherche dans sa ville")
verifier(_ess["approfondissements"]["recherche"]["requetes"] == ["réforme des retraites", "tarifs CFF"], "à creuser : cherche ses sujets")
verifier(all(r["id"] == c and r["recherche"]["rendu"] == "point" and r["recherche"]["sources"] for c, r in _ess.items()),
         "essentielles : identifiant, rendu « point », au moins une source")
verifier("Réglages › Moi" in _echoue(_recherche.regle_essentielle, "actu_locale", {}, ""), "actu locale sans ville : message clair")
verifier("À creuser" in _echoue(_recherche.regle_essentielle, "approfondissements", {}, "Yverdon"), "à creuser vide : message clair")
_config_reglee = {"actus": {"ville": "Yverdon", "locale_sujets": 1, "locale_preferes": ["travaux"], "sujets_a_eviter": ["sport"]},
                  "consignes_rubriques": {"agenda": ["Ne parle pas de la piscine"], "actualites": ["Commence par l'économie."]}}
_loc = _recherche.regle_essentielle("actu_locale", _config_reglee, "")
verifier(_loc["recherche"]["requetes"] == ["actualité Yverdon", "Yverdon travaux"] and _loc["consigne"].startswith("Une seule information de Yverdon")
         and "Thèmes préférés de l'auditeur : travaux" in _loc["consigne"], f"chercher maintenant : réglages de l'actu locale ({_loc['consigne']})")
verifier("à respecter : Ne parle pas de la piscine." in _recherche.regle_essentielle("agenda", _config_reglee, "")["consigne"]
         and all(x in _recherche.regle_essentielle("actualites", _config_reglee, "")["consigne"]
                 for x in ("Thèmes qui ne l'intéressent pas : sport", "Commence par l'économie.")),
         "chercher maintenant : consignes et thèmes de la rubrique")
verifier(_recherche.ESSENTIELLES["actualites"][0] == "Actualités globales" == podcast.moteur.RUBRIQUES["actualites"], "Actualités globales")
# Rubriques fournies : leurs agendas et leurs flux choisis dans leur fiche.
_config_src = {"actus": {"ville": "Yverdon"}, "a_approfondir": [{"sujet": "tarifs CFF"}],
               "sources_integrees": {"agenda": ["agenda:aaaa000001"], "deplacements": ["agenda"], "actu_locale": ["flux:local001"], "approfondissements": ["flux:local001"]}}
verifier(_recherche.regle_essentielle("agenda", _config_src, "")["recherche"]["sources"] == ["agenda:aaaa000001"]
         and _recherche.regle_essentielle("deplacements", _config_src, "")["recherche"]["sources"] == ["agenda", "web", "actus"]
         and _recherche.regle_essentielle("actu_locale", _config_src, "")["recherche"]["sources"] == ["actus", "flux:local001"]
         and _recherche.regle_essentielle("approfondissements", _config_src, "")["recherche"]["sources"] == ["web", "actus", "flux:local001"],
         "chercher maintenant : les agendas et les flux choisis dans la fiche")
_ev = lambda titre, agenda: podcast.Evenement(titre, dt.datetime(2026, 10, 30, 9, 0, tzinfo=dt.timezone.utc), None, False, agenda=agenda)
_evs = [_ev("Dentiste", "aaaa000001"), _ev("Match", "bbbb000002")]
verifier([e.titre for e in podcast.evenements_choisis(_evs, ["agenda:bbbb000002"])] == ["Match"] and len(podcast.evenements_choisis(_evs, ["agenda"])) == 2
         and len(podcast.evenements_choisis(_evs, None)) == 2, "événements des agendas choisis")
_art = podcast.Article(titre="Les CFF augmentent leurs tarifs en décembre", resume="", lien="", source="La Région", date=None)
verifier(podcast.parle_de(_art, "tarifs CFF") and not podcast.parle_de(_art, "réforme des retraites"), "article d'un flux qui parle du sujet à creuser")
_ancien_tel = podcast.telecharger
podcast.telecharger = lambda url, *a, **k: b"""<rss><channel><item><title>Travaux rue du Lac</title><pubDate>Thu, 29 Oct 2026 06:00:00 +0000</pubDate></item></channel></rss>"""
_arts = podcast.articles_de_flux({"config_bot": {"sources": {"flux": [{"id": "local001", "nom": "La Région", "url": "https://laregion.ch/rss"},
                                                                       {"id": "autre002", "nom": "Autre", "url": "https://autre.ch/rss"}]}}},
                                 ["flux:local001"], dt.datetime(2026, 10, 29, 8, 0, tzinfo=dt.timezone.utc), 48)
podcast.telecharger = _ancien_tel
verifier([a.titre for a in _arts] == ["Travaux rue du Lac"] and _arts[0].source == "La Région", f"flux cochés lus ({[a.titre for a in _arts]})")
verifier([podcast.periode_recherche(h) for h in (12, 36, 48, 72, 168, 336)] == ["12h", "36h", "2d", "3d", "7d", "14d"],
         "âge des nouvelles en heures ou en jours pour Google Actualités")

# Le planificateur répond avec des identifiants en majuscules : les nôtres (« deplacements ») doivent les retrouver.
_plans = _moteur.planifier([_ess["deplacements"]], ["mar. 3 nov. 09:00 — Vol pour Lisbonne"], dt.date(2026, 10, 24), "Yverdon",
                           lambda systeme, entree, schema: {"regles": [{"id": "DEPLACEMENTS", "applique": True, "evenement": "Vol pour Lisbonne",
                                                                          "requetes": ["Lisbonne novembre"], "lieux": ["Lisbonne"]}]})
verifier(_plans["deplacements"]["requetes"] == ["Lisbonne novembre"] and _plans["deplacements"]["lieux"] == ["Lisbonne"]
         and _plans["deplacements"]["evenement"] == "Vol pour Lisbonne", "planificateur : identifiants minuscules retrouvés")


_anciens = (podcast.demander_json, podcast.lire_actualites, _moteur.collecter, podcast.telecharger)
_vus = {}
try:
    def _demander_texte(systeme, entree, schema, modeles, cle, **_):
        _vus["systeme"], _vus["entree"], _vus["schema"] = systeme, entree, schema
        return {"titre": "À la une", "texte": "Deux sujets dominent la journée.\nLe premier concerne les CFF."}, "m"
    podcast.demander_json = _demander_texte
    podcast.lire_actualites = lambda reglages, maintenant: ([podcast.Article("Les CFF en retard", "Chantiers en cours", "https://exemple.ch/cff",
                                                                              "Le Temps"), podcast.Article("Sans lien", "", "http://non-https.ch", "X")], [])
    _moteur.collecter = lambda regle, plan, sources, jour, ville, *a, **k: _moteur.Collecte(regle=regle, plan=plan, texte="Sources lues : medias")
    _bot_e = _BotPoint()
    _eff = {"animateurs": [{"nom": "Kore"}, {"nom": "Puck"}], "mots_par_minute": 150, "tutoiement": True, "modeles_texte": ["m"],
            "modeles_rapides": ["r"], "debit_mp3_kbps": 64, "ville_habituelle": "Yverdon", "config_bot": _config, "flux": [], "fraicheur_heures": 24,
            "articles_par_flux": 3}
    _code_e = _recherche.lancer(["actualites"], "ecrit", _eff, "cle", dt.datetime(2026, 10, 24, 8, 0, tzinfo=ZH), _bot_e, {})
    _entree_e = _vus.get("entree", "")
    _agenda_env = os.environ.pop("CALENDAR_ICS_URL", None)
    try:
        _essai_agenda = _echoue(_recherche.lancer, ["agenda"], "ecrit", _eff, "cle", dt.datetime(2026, 10, 24, 8, 0, tzinfo=ZH), _bot_e, {})
    finally:
        if _agenda_env is not None:
            os.environ["CALENDAR_ICS_URL"] = _agenda_env
finally:
    podcast.demander_json, podcast.lire_actualites, _moteur.collecter, podcast.telecharger = _anciens
_ev_e = _bot_e.evenements[0] if _bot_e.evenements else {}
_res_e = (_ev_e.get("resultats") or [{}])[0]
verifier(_code_e == 0 and _ev_e.get("format") == "ecrit" and _ev_e.get("idees") == [] and not _ev_e.get("audio") and _res_e.get("regle") == "actualites",
         "chercher maintenant : un point écrit pour l'application, sans audio")
verifier(_res_e.get("intro", "").startswith("Deux sujets dominent la journée.") and "\n" not in _res_e.get("intro", ""), "point écrit : texte sur une ligne")
verifier(_res_e.get("sources") == [{"titre": "Les CFF en retard", "lien": "https://exemple.ch/cff"}], "point écrit : sources de tes médias (https seulement)")
verifier("Articles récents de ses médias" in _entree_e and "Les CFF en retard" in _entree_e, "actualités : les médias de l'auditeur sont lus")
verifier("agenda" in _essai_agenda.lower() and "Réglages › Sources › Agendas" in _essai_agenda, "agenda sans agenda branché : message clair")

# ── Recherche ponctuelle par écrit : nombre de recherches web, résultats en plus ──
print("\n▶ Recherche par écrit : recherches web et résultats en plus")
verifier([_recherche.recherches_web({"recherche": {"recherches": v}}) for v in (None, 1, 5, 9, "x")] == [3, 1, 5, 5, 3],
         "nombre de recherches web : 1 à 5, 3 par défaut")
_export_r = {"resultats_recherches": {"R4": {"idees": [{"titre": "Piscine", "lien": "https://a.ch"}, {"titre": ""}]}},
             "derniers_resultats": {"regles": ["R4", "R5"], "idees": ["Juraparc"]}}
_ponct = {"id": "R4", "periode": {"type": "ponctuelle"}}
verifier(_recherche.deja_trouves(_ponct, _export_r, ["R4"], True) == ["Piscine"]
         and _recherche.deja_trouves(_ponct, _export_r, ["R4"], False) == []
         and _recherche.deja_trouves({"id": "R5", "periode": {"type": "toujours"}}, _export_r, ["R5"], False) == ["Juraparc"],
         "déjà trouvés : « plus » écarte ceux de la recherche, relancée elle repart de zéro, une rubrique écarte ses derniers")
_desc = _moteur.decrire_pour_plan({"id": "R4", "consigne": "vélo en hiver", "_recherches": 5, "_deja": ["Pneus à clous"]})
verifier("recherches web voulues : 5" in _desc and "déjà trouvés (cherche d'autres pistes) : Pneus à clous" in _desc,
         "planificateur : nombre de recherches voulu et pistes déjà trouvées")
_r4 = {"id": "R4", "titre": "Vélo", "consigne": "vélo en hiver", "periode": {"type": "ponctuelle"},
       "recherche": {"sources": ["web"], "fiche": {}}, "_recherches": 5}
_plans5 = _moteur.planifier([_r4], [], dt.date(2026, 10, 30), "Yverdon",
                            lambda systeme, entree, schema: {"regles": [{"id": "R4", "applique": True, "requetes": list("abcdef")}]})
_plans3 = _moteur.planifier([{**_r4, "_recherches": None}], [], dt.date(2026, 10, 30), "Yverdon",
                            lambda systeme, entree, schema: {"regles": [{"id": "R4", "applique": True, "requetes": list("abcdef")}]})
verifier(_plans5["R4"]["requetes"] == list("abcde") and _plans3["R4"]["requetes"] == list("abc"),
         "planificateur : 5 requêtes quand on en veut 5, 3 sinon")


class _SourcesWeb:
    tavily_cle = "x"

    def __init__(self):
        self.requetes = []

    def web(self, requete, maximum=5, images=False, domaines=None):
        self.requetes.append(requete)
        n = len(self.requetes)
        return {"images": [], "resultats": [{"titre": f"T{n}", "contenu": "c", "url": f"https://x.ch/{n}"}]}


_src = _SourcesWeb()
_moteur.collecter(_r4, {"requetes": ["a", "b"]}, _src, dt.date(2026, 10, 30), "Yverdon", profondeur=2, config={}, nombre_requetes=4)
_src1 = _SourcesWeb()
_moteur.collecter(_r4, {"requetes": ["a", "b", "c", "d"]}, _src1, dt.date(2026, 10, 30), "Yverdon", profondeur=1, config={})
verifier(len(_src.requetes) == 4 and _src.requetes[:2] == ["a", "b"] and "vélo en hiver" in _src.requetes and len(_src1.requetes) == 2,
         "collecte : autant de recherches web que voulu (complétées par le titre et la demande) ; l'épisode garde les siennes")

_anciens = (podcast.demander_json, _moteur.collecter)
_vus_p = []
try:
    def _demander_plus(systeme, entree, schema, modeles, cle, **_):
        _vus_p.append(systeme)
        if "Tu réponds par écrit" in systeme:
            return {"intro": "", "idees": [{"titre": "Pneus à clous", "resume": "Pour la neige."}], "resume_partage": ""}, "m"
        return {"regles": []}, "m"
    podcast.demander_json = _demander_plus
    _moteur.collecter = lambda regle, plan, sources, jour, ville, *a, **k: (
        _vus_p.append(("collecte", k.get("nombre_requetes"), regle.get("_deja"))) or _moteur.Collecte(regle=regle, plan=plan, texte="matière"))
    _config_plus = {"regles": [{"id": "R4", "titre": "Vélo en hiver", "consigne": "articles sur le vélo en hiver", "periode": {"type": "ponctuelle"},
                                "recherche": {"rendu": "idees", "recherches": 2, "sources": ["web"], "fiche": {}}}]}
    _bot_p = _BotPoint()
    _code_p = _recherche.lancer(["R4"], "plus", {**_eff, "config_bot": _config_plus}, "cle", dt.datetime(2026, 10, 30, 9, 0, tzinfo=ZH), _bot_p,
                                {"resultats_recherches": {"R4": {"idees": [{"titre": "Bonnet chaud", "lien": "https://y.ch"}]}}})
finally:
    podcast.demander_json, _moteur.collecter = _anciens
_ev_p = _bot_p.evenements[0] if _bot_p.evenements else {}
_sys_p = next((x for x in _vus_p if isinstance(x, str) and "Tu réponds par écrit" in x), "")
verifier(_code_p == 0 and _ev_p.get("format") == "plus" and (_ev_p.get("resultats") or [{}])[0].get("idees", [{}])[0].get("titre") == "Pneus à clous",
         "« plus » : le lot part comme « plus »")
verifier("Ne redonne pas ce qui a déjà été trouvé : Bonnet chaud" in _sys_p and "jusqu'à 5 résultats" in _sys_p,
         "« plus » : les résultats déjà trouvés sont écartés ; 2 recherches web → 5 résultats au plus")
verifier(("collecte", 2, ["Bonnet chaud"]) in _vus_p, "« plus » : 2 recherches web, pistes déjà trouvées transmises au planificateur")
_sys_point = _recherche.consigne_point("Sortie samedi", 3, "Léa", "Hugo", 450, True)
verifier("répond à la demande" in _sys_point and "idées (sorties" in _sys_point and "état des lieux" in _sys_point,
         "recherche en podcast : un état des lieux pour un sujet, des idées pour une sortie")

print("\nRÉSULTAT :", "tout est vert ✅" if not echecs else f"{len(echecs)} échec(s) ❌")
for e in echecs:
    print("  -", e)
sys.exit(1 if echecs else 0)
