# 🎙️ Podcast du matin

Chaque matin, un épisode audio rien que pour toi : deux animateurs te parlent de ton agenda, des nouvelles qui t'intéressent et de tout ce que tu leur as demandé (la fête du jour, la météo, ton train, une idée de sortie pour samedi…).

- **Tout se règle dans une application** : l'heure de chaque jour, la durée, les voix, les rubriques, les clés et tes agendas. Elle s'ouvre dans Telegram, ou dans le navigateur de n'importe quel appareil.
- **Tu écoutes où tu veux** : dans l'application, dans Telegram, ou dans ton appli de podcasts (Apple Podcasts, AntennaPod…) grâce à un flux privé.
- **Gratuit, rien chez toi** : ton ordinateur n'a pas besoin d'être allumé (offres gratuites de Cloudflare, GitHub, Gemini, Tavily et Telegram).
- **Suisse, France ou Belgique** : le pays règle l'heure, les jours fériés, la devise et les médias.
- **Mises à jour en un bouton**, sans toucher à tes réglages.

> **Installer :** [docs/INSTALLATION.md](docs/INSTALLATION.md) · **Mettre à jour une ancienne installation :** [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md)

---

## L'application 📱

Dans Telegram, touche **Application** à gauche du champ de saisie (ou **🎧 Ouvrir dans l'application** sous l'épisode). Au premier lancement, cinq petites étapes te guident : qui tu es, l'heure, ton agenda, la clé Gemini.

| Onglet | Ce qu'on y trouve |
|---|---|
| **Accueil** | Le prochain épisode (*Générer maintenant*, *Sauter*), le lecteur avec ses chapitres, 👍 👎, les idées trouvées, et **« Demande-moi quelque chose »** pour tout régler en une phrase, écrite ou dite. |
| **Épisode** | **Ton épisode, dans l'ordre** : chaque passage (agenda, actualités, actu locale, déplacements, à creuser, et tes rubriques) avec sa fiche. Glisser pour réordonner, pause, et le bouton **+** pour ajouter une rubrique. |
| **Idées** | Les recherches ponctuelles : « une sortie avec les enfants samedi, en train, moins de 20 € » ; les résultats arrivent par écrit (photos, prix, carte) ou en mini-podcast. |
| **Planning** | Heure et activation de chaque jour, jours fériés, rattrapage, exceptions, pauses, calendrier. |
| **Réglages** | **Moi** (prénom, ville, pays) · **Voix** · **Durée et style** (ton, consignes) · **Connexions** (clés et agendas) · **Application** (flux privé, autres appareils, version). |

Chaque changement s'annule depuis l'accueil (*Annuler*). Tu peux toujours écrire ou dicter au bot dans Telegram si tu préfères : il comprend « 6 h 45 en semaine, rien le dimanche », « plus d'humour », « refais le podcast »…

### Les rubriques

Une rubrique est un passage de ton épisode. **Toutes se règlent de la même façon**, par leur fiche, qu'elles soient fournies (Agenda, Actualités, Actu locale, Mes déplacements, À creuser) ou ajoutées par toi. Le catalogue du bouton **+** propose :

- **Fête du prénom**, **Journée du jour**, **Météo** ;
- **Rappel selon l'agenda** : « la veille d'un match, rappelle-moi de préparer mon sac » ;
- **Mon train** : retard ou suppression de ton train habituel (CFF, SNCF, SNCB) ;
- **Actu d'un pays ou d'un thème** : « l'actualité du Portugal », « les nouvelles du vélo » ;
- **Idée de sortie** : quoi, avec qui, où, quand, transport, budget ; présentée dans tes épisodes ;
- ou **une rubrique libre**, décrite en une phrase.

L'application choisit les sources utiles à chaque rubrique (tu peux les changer dans la fiche), et règle sa place et sa longueur. Les **consignes de style** (Réglages › Durée et style) servent au ton général : « plus d'humour le vendredi ». Une consigne qui parle d'un rendez-vous est repérée, et l'application propose d'en faire un rappel selon l'agenda, plus fiable.

### Les connexions

**Réglages › Connexions** reçoit tes clés : chacune est testée avant d'être enregistrée, gardée par ton bot et jamais réaffichée en entier.

| Clé | À quoi elle sert | Coût |
|---|---|---|
| **Gemini** (obligatoire) | Écrit et dit l'épisode | Gratuit ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) |
| **Tavily** | Cherche sur internet pour les idées de sortie | Gratuit, 1 000 recherches par mois ([app.tavily.com](https://app.tavily.com)) |
| **SNCF** | Seulement pour suivre un train en France | Gratuit ([numerique.sncf.com/startup/api](https://numerique.sncf.com/startup/api/)) |

Tes **agendas** (Google, Outlook…) s'ajoutent au même endroit, ou depuis la fiche Agenda, avec leur adresse secrète iCal. Une clé déjà rangée en secret GitHub continue de marcher : celle de l'application passe avant.

### Hors de Telegram

- **Flux privé** (Réglages › Application) : une adresse secrète à coller dans ton appli de podcasts. Les épisodes s'y téléchargent la nuit, avec chapitres et pochette.
- **Autres appareils** : ouvre l'adresse de ton bot (`https://podcast.TON-SOUS-DOMAINE.workers.dev/app`) dans n'importe quel navigateur et entre le code affiché par *Afficher un code*. L'application peut ensuite s'ajouter à l'écran d'accueil.

Tes épisodes (audio, pochette, texte) sont gardés par ton bot pendant un an : l'application et le flux les lisent chez lui. Telegram reste nécessaire pour l'installation et pour recevoir l'épisode chaque matin.

---

## Les sources

| Source | Ce qu'elle apporte | Clé |
|---|---|---|
| Recherche web (Tavily) | Événements, prix, horaires, programmes | Tavily |
| Open-Meteo | Météo jusqu'à 15 jours | Aucune |
| CFF, SNCB, SNCF | Trains en temps réel | SNCF seulement |
| OpenStreetMap | Musées, piscines, aires de jeux, points de vue… autour d'un lieu | Aucune |
| Wikivoyage, Wikipédia | Présentation d'un lieu, photos | Aucune |
| Calendrier des saints, fêtes du jour | Prénoms fêtés, journées internationales | Aucune |
| Jours fériés | Calculés (Vaud, France) ou téléchargés (autres cantons, Belgique) | Aucune |
| Actualités | Google Actualités et les médias de ton pays, plus tes flux RSS | Aucune |

Les faits précis (prix, horaires, dates) viennent des sources. Quand une information manque, les animateurs le disent plutôt que de l'inventer.

---

## Comment ça marche

- **Le bot** (dossier `cloudflare/`) tourne gratuitement chez Cloudflare. Il sert l'application, garde tes réglages, tes rubriques, tes clés et **tes épisodes d'un an**, et **lance chaque épisode à l'heure prévue**. Il sauvegarde tout chaque nuit dans `preferences.json`.
- **GitHub fabrique les épisodes** (`podcast.py`) : il demande tes réglages au bot, lit ton agenda, les actus et les sources de tes rubriques, fait écrire le dialogue par Gemini, le met en voix et l'envoie.
- **Filet de sécurité** : si l'épisode n'est pas parti à l'heure, le bot relance un essai ; si le bot lui-même était en panne, GitHub prépare l'épisode à partir de la sauvegarde.
- **Deux dépôts** : le **modèle** (`podcast-matin-modele`, public) porte le code commun ; chaque personne a son dépôt privé `podcast-matin`, qui se met à jour depuis le modèle avec le bouton **Mettre à jour** (Réglages › Application). `memoire.json`, `preferences.json` et `reglages.toml` ne sont jamais touchés.

## Bon à savoir

- **Gratuité.** GitHub : environ 4 minutes par épisode, loin des 2 000 minutes offertes par mois. Cloudflare : un an d'épisodes tient en 1 à 2 Go, sur les 5 Go offerts (les plus anciens s'effacent d'eux-mêmes). Gemini : quelques requêtes par épisode, avec un modèle de secours quand un quota du jour est épuisé (6 épisodes à la demande par jour au plus, pour garder celui du matin). Tavily : 15 recherches par jour au plus.
- **Confidentialité.** Tes clés et tes agendas restent chez ton bot (ou dans les secrets GitHub) : jamais dans le dépôt, les journaux ni les messages à Gemini. Pour écrire l'épisode, Google reçoit le titre, l'heure et le lieu de tes rendez-vous ; Tavily reçoit les recherches de tes rubriques. Le bot ignore toute autre personne que toi, et l'application ne s'ouvre qu'avec ton compte Telegram ou un appareil que tu as autorisé.
- **Licence.** [PolyForm Noncommercial 1.0.0](LICENSE.md) : tu peux utiliser, modifier et partager ce code pour un usage personnel et non commercial. Tout usage commercial demande l'accord de l'auteur.
- **Conditions d'utilisation.** Google destine officiellement l'API Gemini aux développeurs ; pour un usage personnel comme celui-ci, c'est une zone grise.
- **Idées de sortie.** Prix et horaires viennent des sites trouvés ; quand ils manquent, c'est écrit « à vérifier ».

## Dépannage

| Message ou souci | Que faire |
|---|---|
| ⏳ « raté pour l'instant, nouvel essai à … » | Rien : un rattrapage est prévu (souvent une surcharge passagère de Gemini). |
| « La clé Gemini manque » ou « est refusée » | Réglages › Connexions : colle la clé et touche *Tester*. |
| « agenda inaccessible » | L'adresse iCal a changé : retire l'agenda et ajoute la nouvelle adresse. |
| « Recherche web : non configurée » | Ajoute la clé Tavily dans Réglages › Connexions. |
| Le bot ne répond plus | Ouvre `https://podcast.TON-SOUS-DOMAINE.workers.dev/installer` dans ton navigateur. |
| *Déployer le bot* en orange | Il manque `CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_ACCOUNT_ID` (secrets GitHub). |
| La mise à jour n'a pas touché aux fichiers d'automatisation | Le jeton GitHub n'a pas la permission *Workflows* : voir [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md). |

Le détail d'une exécution : onglet *Actions* de ton dépôt → l'exécution → ses étapes.

---

## Pour les curieux

| Fichier | Rôle |
|---|---|
| `cloudflare/src/` | Le bot : état et planning (`etat.js`), application (`app.html`, `miniapp.js`), fichiers des épisodes (`audio.js`), clés et agendas (`connexions.js`), flux privé (`flux.js`), réglages et rubriques (`config.js`), compréhension des messages (`comprendre.js`) |
| `podcast.py` | Fabrication de l'épisode : agenda, actus, script, voix, envoi |
| `regles.py`, `sources.py`, `trains.py` | Rubriques du jour, sources gratuites, trains |
| `pays.py`, `donnees/pays.json` | Profils Suisse, France, Belgique |
| `recherche.py` | Résultats de recherche, mini-podcast, extraits de voix |
| `horaire.py` | Filet de sécurité des déclenchements GitHub |
| `mise_a_jour.py`, `version.json` | Mise à jour depuis le modèle |
| `reglages.toml` | Partie technique : modèles Gemini, débit du MP3… (l'application a le dernier mot) |
| `memoire.json`, `preferences.json` | Débit réel de la voix, dernier épisode ; sauvegarde quotidienne des réglages |

**Tests** (aucun service réel n'est appelé) : `python tests/test_podcast.py`, `python tests/test_regles.py`, et dans `cloudflare/` : `npm ci && npm test` (bot de bout en bout, avec de faux Telegram, Gemini et GitHub). Ils tournent aussi sur GitHub à chaque changement. `node test/apercu.mjs` (dans `cloudflare/`) ouvre un aperçu local de l'application.

**Essai sans rien envoyer** :

```sh
pip install -r requirements.txt
GEMINI_API_KEY=ta_clé CALENDAR_ICS_URL=ton_lien python podcast.py --sans-envoi
```

Le MP3, le texte, les chapitres et la pochette sont écrits dans `sortie/`.

**Publier une nouvelle version du modèle** : changer `VERSION` et `NOUVEAUTES` dans `cloudflare/src/etat.js`, et la même version dans `version.json` (avec ses nouveautés, et les fichiers à supprimer chez chacun dans `supprimes`). Les bots la proposent dans les 24 heures.
