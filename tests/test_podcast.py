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


# ───────────────────────── 1. créneau horaire ─────────────────────────
print("1. Créneau horaire (été / hiver)")
cas = [
    ("schedule", "45 3 * * *", dt.datetime(2026, 10, 12, 3, 47, tzinfo=UTC), True),   # été
    ("schedule", "45 4 * * *", dt.datetime(2026, 10, 12, 4, 47, tzinfo=UTC), False),
    ("schedule", "45 3 * * *", dt.datetime(2026, 11, 12, 3, 46, tzinfo=UTC), False),  # hiver
    ("schedule", "45 4 * * *", dt.datetime(2026, 11, 12, 4, 46, tzinfo=UTC), True),
    ("schedule", "45 3 * * *", dt.datetime(2026, 10, 25, 3, 50, tzinfo=UTC), False),  # jour du changement
    ("schedule", "45 4 * * *", dt.datetime(2026, 10, 25, 4, 50, tzinfo=UTC), True),
    ("schedule", "45 3 * * *", dt.datetime(2026, 7, 1, 4, 40, tzinfo=UTC), True),     # 55 min de retard
    ("schedule", "45 3 * * *", dt.datetime(2026, 3, 29, 3, 46, tzinfo=UTC), True),    # passage à l'heure d'été
    ("workflow_dispatch", "", dt.datetime(2026, 10, 12, 12, 0, tzinfo=UTC), True),
    ("schedule", "*/5 * * * *", dt.datetime(2026, 10, 12, 12, 0, tzinfo=UTC), True),
]
for evenement, prog, instant, attendu in cas:
    ok, texte = horaire.doit_tourner(evenement, prog, "05:45", "Europe/Zurich", instant)
    verifier(ok == attendu, f"{evenement} {prog!r} à {instant:%Y-%m-%d %H:%M} UTC → {ok}")
modes = {}
for jour, nom in ((dt.datetime(2026, 10, 12, tzinfo=UTC), "été"), (dt.datetime(2026, 11, 12, tzinfo=UTC), "hiver")):
    for heure_utc in (3, 4, 5):
        instant = jour.replace(hour=heure_utc, minute=46)
        modes[(nom, heure_utc)] = horaire.decider("schedule", f"45 {heure_utc} * * *", "05:45", "Europe/Zurich", instant)[0]
verifier(modes == {("été", 3): "normal", ("été", 4): "rattrapage", ("été", 5): "",
                   ("hiver", 3): "", ("hiver", 4): "normal", ("hiver", 5): "rattrapage"},
         f"trois créneaux : épisode à 5 h 45, rattrapage à 6 h 45, été comme hiver : {modes}")
verifier(horaire.une_heure_plus_tard("23:30") == "00:30", "rattrapage après minuit")
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
m["a_approfondir"] = [{"sujet": "IA en Suisse", "demande_le": "2026-10-10"}]
podcast.appliquer_retours(m, {
    "vitesse_parole": "lente", "duree_minutes": 5, "ville_habituelle": "Lausanne",
    "sujets_preferes": ["Technologie", "sport", "technologie"], "sujets_a_eviter": ["Sport"],
    "consignes": ["plus d'humour"], "a_approfondir": ["IA en Suisse", "réforme des retraites"],
    "reponse": "ok"}, reglages, maintenant)
p = m["preferences"]
verifier(p["vitesse_parole"] == "lente" and p["duree_minutes"] is None and p["ville_habituelle"] == "Lausanne",
         f"seules les valeurs différentes de reglages.toml sont gardées : {p}")
verifier(p["sujets_preferes"] == ["Technologie"] and p["sujets_a_eviter"] == ["Sport"],
         "doublons retirés ; un thème évité n'est pas aussi préféré")
verifier(m["a_approfondir"] == [{"sujet": "IA en Suisse", "demande_le": "2026-10-10"},
                                {"sujet": "réforme des retraites", "demande_le": "2026-10-12"}],
         "sujets à approfondir datés (date d'origine conservée)")
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
html_reglages = podcast.resume_preferences(reglages, m)
verifier("Vitesse de parole : lente" in html_reglages and "Lausanne" in html_reglages, "/reglages lisible")

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
    "TELEGRAM_BOT_TOKEN": "111:jeton-test",
    "TELEGRAM_CHAT_ID": "",
    "CALENDAR_ICS_URL": "webcal://p01-caldav.icloud.com/published/2/SECRET  https://calendar.google.com/calendar/ical/x/private-SECRET/basic.ics",
    "GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "moi/podcast-matin",
    "GITHUB_RUN_ID": "42",
})
VOCAL = b"OggS\x00\x02" + b"\x01" * 200     # faux message vocal Telegram


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
scenario = {
    "quota_premier_modele_voix": True, "refuser_mode": True, "refuser_style": False, "wav": False,
    "tronquer_une_fois": False, "agenda": ICS, "deplacements": [], "retours": None,
    "retours_quota": False, "updates": [], "pannes": {},
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
    if "api.telegram.org/file/bot111:jeton-test/voice/file_7.oga" in url:
        return Reponse(200, contenu=VOCAL)
    return Reponse(403, contenu=b"<html>blocked</html>")


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
    if "Tu gères les réglages" in systeme:
        assert "reponse" in proprietes
        if scenario["retours_quota"]:
            return Reponse(429, {"error": {"code": 429, "message": "Quota exceeded for metric: generate_requests_per_model_per_day, limit: 0"}})
        return reponse_texte(scenario["retours"])
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


def faux_telegram(methode, data):
    if methode == "getUpdates":
        offset = int(data.get("offset", 0))
        if offset:      # Telegram oublie les messages déjà confirmés
            scenario["updates"] = [u for u in scenario["updates"] if u["update_id"] >= offset]
        return Reponse(200, {"ok": True, "result": list(scenario["updates"])})
    if methode == "getFile":
        assert data["file_id"] == "VOIX7"
        return Reponse(200, {"ok": True, "result": {"file_id": "VOIX7", "file_path": "voice/file_7.oga"}})
    if methode == "getMe":
        return Reponse(200, {"ok": True, "result": {"username": "MonPodcastDuMatin_bot"}})
    if methode in ("sendMessage", "sendAudio"):
        return Reponse(200, {"ok": True, "result": {"message_id": 5}})
    return Reponse(404, {"ok": False, "description": "inconnu"})


def faux_post(url, json=None, data=None, files=None, timeout=None, headers=None):
    appels.append(("POST", url, json if json is not None else data, files))
    if "generativelanguage" in url:
        return faux_gemini(json, headers)
    if "api.telegram.org" in url:
        return faux_telegram(url.rsplit("/", 1)[1], data or {})
    return Reponse(404, {"ok": False, "description": "inconnu"})


def appels_gemini(sorte):
    resultat = []
    for a in appels:
        if a[0] != "POST" or "generativelanguage" not in a[1]:
            continue
        corps = a[2]
        if corps["model"].endswith("-tts"):
            genre = "voix"
        elif "Tu gères les réglages" in corps["system_instruction"]:
            genre = "retours"
        elif "Tu repères dans l'agenda" in corps["system_instruction"]:
            genre = "deplacements"
        else:
            genre = "script"
        if genre == sorte:
            resultat.append(corps)
    return resultat


def appels_telegram():
    return [(a[1].rsplit("/", 1)[1], a[2], a[3]) for a in appels if a[0] == "POST" and "api.telegram.org" in a[1]]


def recherches():
    return [unquote_plus(a[1].split("q=", 1)[1].split("&", 1)[0]) for a in appels
            if a[0] == "GET" and "news.google.com/rss/search" in a[1]]


def a_la_date(annee, mois, jour, heure=5, minute=46):
    podcast.heure_actuelle = lambda fuseau: dt.datetime(annee, mois, jour, heure, minute, tzinfo=ZH).astimezone(fuseau)


podcast.requests.get = faux_get
podcast.requests.post = faux_post
sommeils = []
podcast.time.sleep = sommeils.append
podcast.SEUIL_SCRIPT_COURT = 0   # le faux script est court : testé à part (5l)
a_la_date(2026, 10, 12)

# 5a. Tout premier épisode : le bot trouve la conversation, répond à /start.
print("5a. Premier épisode")
scenario["updates"] = [{"update_id": 1, "message": {"chat": {"id": 987654321, "type": "private"},
                                                    "from": {"id": 987654321, "is_bot": False},
                                                    "text": "/start"}}]
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

tg = appels_telegram()
methodes = [t[0] for t in tg]
verifier(methodes == ["getUpdates", "sendMessage", "getUpdates", "sendMessage", "getUpdates", "sendAudio"],
         f"séquence Telegram : {methodes}")
verifier("987654321" in tg[1][1]["text"], "identifiant de conversation communiqué")
verifier("Écris-moi, ou envoie-moi un vocal" in tg[3][1]["text"], "/start → mode d'emploi du bot")
donnees, fichiers = tg[-1][1], tg[-1][2]
mp3 = fichiers["audio"][1]
(RACINE_TEST / "test.mp3").write_bytes(mp3)
print("\n--- légende Telegram ---\n" + donnees["caption"] + "\n---")
verifier(len(donnees["caption"]) <= 1024, f"légende ≤ 1024 caractères ({len(donnees['caption'])})")
verifier("Budget, neige et yoga" in donnees["caption"] and "**" not in donnees["caption"], "titre nettoyé")
verifier("news.google.com/rss/articles/AAA" in donnees["caption"], "lien de la source citée")
verifier("Écris-moi ou utilise les boutons" in donnees["caption"], "invitation à répondre au bot")
verifier("reply_markup" not in donnees, "sans le bot de la version 3 : pas de boutons sous l'épisode")
verifier("thumbnail" in fichiers and fichiers["thumbnail"][1][:2] == b"\xff\xd8" and len(fichiers["thumbnail"][1]) < 200_000,
         "pochette JPEG jointe (moins de 200 ko)")
if shutil.which("ffprobe"):
    sonde = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels:format=duration",
                            "-of", "json", str(RACINE_TEST / "test.mp3")], capture_output=True, text=True)
    infos = json.loads(sonde.stdout)
    verifier(infos["streams"][0]["codec_name"] == "mp3" and infos["streams"][0]["channels"] == 1, "MP3 mono valide")
    verifier(abs(float(infos["format"]["duration"]) - int(donnees["duration"])) < 3, "durée annoncée ≈ durée réelle")
else:   # sans ffmpeg (machine de test GitHub) : en-tête MPEG et durée d'après le débit (64 kbit/s)
    verifier(mp3[0] == 0xFF and (mp3[1] & 0xE0) == 0xE0 and (mp3[3] >> 6) == 3, "MP3 valide (en-tête MPEG, mono)")
    verifier(abs(len(mp3) * 8 / 64000 - int(donnees["duration"])) < 3, "durée annoncée ≈ durée réelle")
mem = memoire()
verifier(mem["telegram_dernier_update"] == 1, "message /start marqué comme lu")
verifier(mem["dernier_episode"] == {"date": "2026-10-12", "titre": "Budget, neige et yoga", "envoye_le": "2026-10-12T05:46",
                                    "sujets": ["Agenda du jour", "Budget 2027", "Premières neiges"],
                                    "deplacements": [], "regles": []}, f"épisode mémorisé : {mem['dernier_episode']}")

# 5b. Messages de l'auditeur (texte + vocal), lus par le passage de la journée.
print("\n5b. Messages au bot (passage de la journée)")
os.environ["TELEGRAM_CHAT_ID"] = "987654321"
appels.clear()
moi = {"id": 987654321, "is_bot": False}
scenario["updates"] = [
    {"update_id": 10, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi,
                                  "text": "Parle un peu plus lentement, et le sport ne m'intéresse pas."}},
    {"update_id": 11, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi,
                                  "voice": {"file_id": "VOIX7", "duration": 7, "mime_type": "audio/ogg"}}},
    {"update_id": 12, "message": {"chat": {"id": 555, "type": "private"}, "from": {"id": 555, "is_bot": False},
                                  "text": "Je suis un inconnu"}},
    {"update_id": 13, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi, "text": "/reglages"}},
]
scenario["retours"] = {
    "vitesse_parole": "lente", "duree_minutes": 5, "ville_habituelle": "Lausanne",
    "sujets_preferes": ["technologie"], "sujets_a_eviter": ["sport"], "consignes": ["plus d'humour"],
    "a_approfondir": ["la réforme des retraites"],
    "reponse": "C'est noté : je parle plus lentement, sans sport, et demain on creuse la réforme des retraites.",
}
a_la_date(2026, 10, 12, 9, 17)
code = podcast.main(["--retours"])
verifier(code == 0, "mode --retours : code 0")
retours = appels_gemini("retours")
verifier(len(retours) == 1 and retours[0]["model"] == "gemini-3.5-flash-lite", "un appel au modèle léger")
entree = retours[0]["input"]
textes_entree = " ".join(c.get("text", "") for c in entree)
verifier("Réglages actuels" in textes_entree and "Budget 2027" in textes_entree,
         "contexte transmis : réglages et sujets du dernier épisode")
verifier("Parle un peu plus lentement" in textes_entree and "Je suis un inconnu" not in textes_entree,
         "message de l'auditeur transmis, celui d'un inconnu ignoré")
audio = [c for c in entree if c.get("type") == "audio"]
verifier(len(audio) == 1 and base64.b64decode(audio[0]["data"]) == VOCAL and audio[0]["mime_type"] == "audio/ogg",
         "message vocal transmis à Gemini")
verifier(not appels_gemini("script") and not appels_gemini("voix"), "pas d'épisode en mode --retours")
tg = appels_telegram()
envoyes = [t[1]["text"] for t in tg if t[0] == "sendMessage"]
verifier(len(envoyes) == 2 and envoyes[0].startswith("✅ C'est noté") and "Vitesse de parole : lente" in envoyes[1],
         f"réponse ✅ puis /reglages : {[e[:40] for e in envoyes]}")
verifier(not any(t[0] == "sendAudio" for t in tg), "aucun audio envoyé")
mem = memoire()
verifier(mem["telegram_dernier_update"] == 13, "messages marqués comme lus")
verifier([x[1].get("offset") for x in tg if x[0] == "getUpdates"] == [2, 14],
         "messages confirmés auprès de Telegram après traitement (pour le relais Cloudflare)")
verifier(mem["preferences"]["vitesse_parole"] == "lente" and mem["preferences"]["sujets_a_eviter"] == ["sport"],
         "préférences mémorisées")
verifier(mem["a_approfondir"] == [{"sujet": "la réforme des retraites", "demande_le": "2026-10-12"}],
         "sujet à creuser mémorisé")
verifier(mem["historique_retours"][-1]["messages"] == ["Parle un peu plus lentement, et le sport ne m'intéresse pas.", "(vocal)"],
         "historique : le texte est gardé, pas l'audio")
appels.clear()
code = podcast.main(["--retours"])
verifier(code == 0 and not appels_gemini("retours") and not [t for t in appels_telegram() if t[0] == "sendMessage"],
         "passage suivant sans nouveau message : rien à faire")
offsets = [t[1].get("offset") for t in appels_telegram() if t[0] == "getUpdates"]
verifier(offsets == [14], f"lecture à partir du message suivant (offset {offsets})")
confirmations = [t[1].get("offset") for t in appels_telegram() if t[0] == "getUpdates"]

# 5c. Épisode du lendemain : préférences appliquées, agenda vide → prochain événement + voyage.
print("\n5c. Épisode du lendemain (agenda vide, voyage à venir)")
appels.clear()
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
         and "technologie when:2d" in faites and "Lausanne when:7d" in faites, f"recherches : {faites}")
verifier("Thèmes qui ne l'intéressent pas : sport" in systeme and "plus d'humour" in systeme
         and "entre 960 et" in systeme, "préférences et vitesse transmises au rédacteur")
voix = appels_gemini("voix")
styles = [c["input"][0]["content"][0]["annotations"][0].get("style") for c in voix]
verifier(styles[0] == "speaking a little slowly" and styles[-1] is None,
         f"vitesse lente demandée à la voix, retirée si l'API la refuse : {styles}")
tg = appels_telegram()
legende_html = [t[1]["caption"] for t in tg if t[0] == "sendAudio"][0]
print("\n--- légende Telegram ---\n" + legende_html + "\n---")
verifier("🔭 Prochain : Week-end à Barcelone, du vendredi 6 novembre au dimanche 8 novembre" in legende_html
         and "🧳 Barcelone" in legende_html, "légende : prochain événement et déplacement")
mem = memoire()
verifier(mem["a_approfondir"] == [] and mem["dernier_episode"]["deplacements"] == ["Barcelone"]
         and mem["dernier_episode"]["date"] == "2026-10-13", "sujets creusés oubliés, épisode mémorisé")
verifier(mem["preferences"]["vitesse_parole"] == "lente", "préférences durables conservées")

# 5d. Gemini indisponible pour lire un message : on prévient une seule fois, on réessaie.
print("\n5d. Message non compris (quota) : un seul avertissement")
appels.clear()
scenario.update({"retours_quota": True, "agenda": ICS, "refuser_style": False, "deplacements": []})
scenario["updates"] = [{"update_id": 20, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi,
                                                     "text": "Fais des épisodes de 7 minutes"}}]
a_la_date(2026, 10, 13, 11, 17)
code = podcast.main(["--retours"])
envoyes = [t[1]["text"] for t in appels_telegram() if t[0] == "sendMessage"]
verifier(code == 0 and len(envoyes) == 1 and envoyes[0].startswith("⏳"), f"avertissement envoyé : {envoyes}")
verifier(memoire()["telegram_dernier_update"] == 13, "message non marqué comme lu (sera relu)")
appels.clear()
code = podcast.main(["--retours"])
verifier(code == 0 and not [t for t in appels_telegram() if t[0] == "sendMessage"], "pas de second avertissement")
appels.clear()
scenario["retours_quota"] = False
scenario["retours"] = dict(scenario["retours"], duree_minutes=7, a_approfondir=[],
                           reponse="Les épisodes dureront désormais 7 minutes.")
code = podcast.main(["--retours"])
mem = memoire()
verifier(code == 0 and mem["preferences"]["duree_minutes"] == 7.0 and mem["telegram_dernier_update"] == 20,
         "quota revenu : message traité au passage suivant")

# 5e. Audio WAV et audio tronqué.
print("\n5e. Audio WAV et audio tronqué")
appels.clear()
scenario.update({"wav": True, "tronquer_une_fois": True})
a_la_date(2026, 10, 14)
code = podcast.main([])
voix = appels_gemini("voix")
verifier(code == 0, "WAV accepté")
verifier(len(voix) == 3, f"audio tronqué → nouvelle tentative en deux moitiés ({len(voix)} appels)")
verifier("mode" in voix[0]["generation_config"]["speech_config"], "option conversational envoyée quand elle est acceptée")
verifier([t[0] for t in appels_telegram()] == ["getUpdates", "sendAudio"], "avec TELEGRAM_CHAT_ID : lecture puis envoi")
debit = memoire()["debit_mots_minute"]["lente"]
verifier(f"entre {7 * debit} et" in appels_gemini("script")[0]["system_instruction"],
         f"durée de 7 minutes appliquée, au débit mesuré pour « lente » ({debit} mots/min)")

# 5f. Essai local sans envoi : la mémoire n'est pas modifiée.
print("\n5f. Essai sans envoi")
avant = MEMOIRE.read_text(encoding="utf-8")
appels.clear()
with contextlib.redirect_stdout(io.StringIO()):
    code = podcast.main(["--sans-envoi"])
verifier(code == 0 and (RACINE_TEST / "sortie" / "podcast-2026-10-14.mp3").exists(), "MP3 écrit dans sortie/")
verifier(MEMOIRE.read_text(encoding="utf-8") == avant and not appels_telegram(), "ni Telegram ni mémoire touchés")

# 5g. /reinitialiser : retour aux réglages de base, demandes précédentes annulées.
print("\n5g. /reinitialiser")
appels.clear()
scenario["updates"] = [
    {"update_id": 30, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi, "text": "Parle très vite"}},
    {"update_id": 31, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi, "text": "/reinitialiser"}},
    {"update_id": 32, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi, "text": "/reglages@MonPodcastDuMatin_bot"}},
]
a_la_date(2026, 10, 14, 13, 17)
code = podcast.main(["--retours"])
envoyes = [t[1]["text"] for t in appels_telegram() if t[0] == "sendMessage"]
verifier(code == 0 and not appels_gemini("retours"), "message annulé par /reinitialiser : pas d'appel à Gemini")
verifier(len(envoyes) == 2 and envoyes[0].startswith("🔄") and "Vitesse de parole : normale" in envoyes[1]
         and "Durée : 5 min" in envoyes[1], f"confirmation puis réglages de base : {[e[:30] for e in envoyes]}")
mem = memoire()
verifier(mem["preferences"] == podcast.memoire_vide()["preferences"] and mem["telegram_dernier_update"] == 32,
         "préférences effacées, messages marqués comme lus")

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
verifier(code == 0 and not appels_gemini("script") and not [t for t in appels_telegram() if t[0] == "sendAudio"],
         "épisode déjà parti ce matin → le rattrapage ne refait rien")
appels.clear()
a_la_date(2026, 10, 17, 6, 46)
code = podcast.main([])
verifier(code == 0 and appels_gemini("script") and [t for t in appels_telegram() if t[0] == "sendAudio"],
         "épisode pas encore parti → le rattrapage l'envoie")
del os.environ["RATTRAPAGE"]

# 5k. Échec à l'heure prévue : message rassurant, pas d'e-mail d'échec, rattrapage annoncé.
print("\n5k. Échec avec rattrapage prévu")
appels.clear()
sommeils.clear()
scenario["pannes"] = {m: ["timeout"] * 3 for m in ("gemini-3.8-flash", "gemini-3.6-flash",
                                                   "gemini-3.5-flash-lite", "gemini-3.1-flash-lite")}
os.environ["ESSAI_SUIVANT"] = "06:45"
a_la_date(2026, 10, 18)
with contextlib.redirect_stdout(io.StringIO()) as sortie:
    code = podcast.main([])
alerte = [t[1]["text"] for t in appels_telegram() if t[0] == "sendMessage"]
verifier(code == 0 and "::warning::" in sortie.getvalue(), "code 0 (le rattrapage s'en charge) + avertissement dans GitHub")
verifier(alerte and alerte[-1].startswith("⏳") and "Nouvel essai automatique à 6 h 45" in alerte[-1]
         and "Les serveurs de Gemini ne répondent pas" in alerte[-1], f"message Telegram clair : {alerte}")
verifier(sommeils.count(60) == 1 and sommeils.count(180) == 1, f"trois tours espacés : {sommeils}")
verifier(memoire()["dernier_episode"]["date"] == "2026-10-17", "épisode du jour non marqué comme envoyé")
del os.environ["ESSAI_SUIVANT"]
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

# 5m. « Refais le podcast » : nouvel épisode tout de suite, au plus 3 par jour.
print("\n5m. Nouvel épisode à la demande")
appels.clear()
scenario["updates"] = [{"update_id": 40, "message": {"chat": {"id": 987654321, "type": "private"}, "from": moi,
                                                     "text": "Refais le podcast en creusant l'actu locale"}}]
scenario["retours"] = dict(scenario["retours"], a_approfondir=["actu locale"], nouvel_episode=True,
                           reponse="D'accord, je creuse l'actu locale dans un nouvel épisode.")
a_la_date(2026, 10, 19, 15, 2)
code = podcast.main(["--retours"])
tg = appels_telegram()
envoyes = [x[1]["text"] for x in tg if x[0] == "sendMessage"]
verifier(code == 0 and any(x[0] == "sendAudio" for x in tg) and appels_gemini("script"),
         "message « refais le podcast » → épisode préparé et envoyé dans la foulée")
verifier(len(envoyes) == 2 and envoyes[0].startswith("✅") and envoyes[1].startswith("🎙️"), f"réponses : {envoyes}")
verifier("actu locale" in appels_gemini("script")[0]["input"], "la demande du même message s'applique au nouvel épisode")
mem = memoire()
verifier(mem["episodes_refaits"] == {"date": "2026-10-19", "nombre": 1} and "_nouvel_episode" not in mem
         and mem["a_approfondir"] == [], f"compteur du jour, sujet creusé puis oublié : {mem['episodes_refaits']}")
for numero in (41, 42, 43):
    appels.clear()
    scenario["updates"] = [{"update_id": numero, "message": {"chat": {"id": 987654321, "type": "private"},
                                                             "from": moi, "text": "/podcast"}}]
    code = podcast.main(["--retours"])
envoyes = [x[1]["text"] for x in appels_telegram() if x[0] == "sendMessage"]
verifier(code == 0 and envoyes and envoyes[-1].startswith("🚫") and not appels_gemini("script"),
         "/podcast : au-delà de 3 épisodes refaits dans la journée, refus poli sans rien générer")
scenario["retours"]["nouvel_episode"] = False

# 5n. Bot instantané : réglages dans preferences.json, Telegram réservé au webhook.
print("\n5n. Bot instantané (preferences.json)")
appels.clear()
(RACINE_TEST / "preferences.json").write_text(json.dumps({
    "preferences": {"vitesse_parole": "rapide", "duree_minutes": 4, "ville_habituelle": "Yverdon",
                    "sujets_preferes": [], "sujets_a_eviter": ["sport"], "consignes": []},
    "a_approfondir": [{"sujet": "ancien sujet", "demande_le": "2026-10-19T10:00"},
                      {"sujet": "élections fédérales", "demande_le": "2026-10-19T21:40"}]}), encoding="utf-8")
ancien_post_tg = podcast.requests.post


def post_webhook_actif(url, **kw):
    if url.endswith("getUpdates"):
        appels.append(("POST", url, kw.get("data"), None))
        return Reponse(409, {"ok": False, "error_code": 409,
                             "description": "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"})
    return ancien_post_tg(url, **kw)


podcast.requests.post = post_webhook_actif
a_la_date(2026, 10, 20, 7, 31)
code = podcast.main([])
systeme = appels_gemini("script")[0]["system_instruction"]
demande = appels_gemini("script")[0]["input"]
verifier(code == 0 and any(x[0] == "sendAudio" for x in appels_telegram()), "webhook actif : getUpdates refusé sans casser l'épisode")
verifier("pour durer 5 minutes" in systeme, "durée lue dans preferences.json (4 min + 1 pour l'approfondissement)")
verifier("élections fédérales" in demande and "ancien sujet" not in demande,
         "seul le sujet demandé après le dernier épisode est approfondi")
verifier("Thèmes qui ne l'intéressent pas : sport" in systeme, "thèmes évités lus dans preferences.json")
podcast.requests.post = ancien_post_tg
(RACINE_TEST / "preferences.json").unlink()

# ─────────────── 6. erreurs : clé invalide, bot jamais démarré ───────────────
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
code = podcast.main([])
alerte = [t[1]["text"] for t in appels_telegram() if t[0] == "sendMessage"]
verifier(code == 1 and alerte and "clé Gemini est refusée" in alerte[-1], "clé invalide → code 1 + alerte Telegram claire")
verifier(alerte and "actions/runs/42" in alerte[-1], "lien vers l'exécution GitHub dans l'alerte")
appels.clear()
code = podcast.main(["--retours"])
verifier(code == 0 and not [t for t in appels_telegram() if t[0] == "sendMessage"],
         "mode --retours : pas d'alerte si rien à lire")
podcast.requests.post = ancien_post


def post_sans_conversation(url, **kw):
    if url.endswith("getUpdates"):
        return Reponse(200, {"ok": True, "result": []})
    return ancien_post(url, **kw)


os.environ["TELEGRAM_CHAT_ID"] = ""
podcast.requests.post = post_sans_conversation
journal_capture = io.StringIO()
with contextlib.redirect_stdout(journal_capture):
    code = podcast.main([])
verifier(code == 1 and "@MonPodcastDuMatin_bot" in journal_capture.getvalue(),
         "bot jamais démarré → message d'aide avec le nom du bot, et code 1")
with contextlib.redirect_stdout(io.StringIO()):
    code = podcast.main(["--retours"])
verifier(code == 0, "mode --retours sans TELEGRAM_CHAT_ID : rien à faire, code 0")
podcast.requests.post = ancien_post

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
    anciens = {k: os.environ.get(k) for k in ("EVENEMENT", "TELEGRAM_BOT_TOKEN", "BOT_URL", "RACINE", "GITHUB_OUTPUT", "PROGRAMMATION")}
    os.environ.update({"EVENEMENT": "schedule", "TELEGRAM_BOT_TOKEN": "", "BOT_URL": "", "RACINE": dossier,
                       "GITHUB_OUTPUT": str(sortie), "PROGRAMMATION": "30 5 * * *"})
    with contextlib.redirect_stdout(io.StringIO()):
        horaire.main()
    for cle, valeur in anciens.items():
        if valeur is None:
            os.environ.pop(cle, None)
        else:
            os.environ[cle] = valeur
    verifier("go=false" in sortie.read_text(), "dépôt sans bot : pas d'épisode programmé")

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

print("\nRÉSULTAT :", "tout est vert ✅" if not echecs else f"{len(echecs)} échec(s) ❌")
for e in echecs:
    print("  -", e)
sys.exit(1 if echecs else 0)
