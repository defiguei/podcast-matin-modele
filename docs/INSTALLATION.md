# Installer son Podcast du matin

Un podcast quotidien à deux voix, fabriqué chaque matin à partir de ton agenda et de l'actualité, **gratuit** et sans ordinateur allumé. Compte 30 à 45 minutes la première fois. Les clés des services (Gemini, Tavily) et tes agendas se règlent ensuite dans l'application : ici, il ne s'agit que de mettre le bot en ligne.

## Ce qu'il te faut

| Quoi | À quoi ça sert | Coût |
|------|----------------|------|
| Un compte **GitHub** | Héberge le code et fabrique les épisodes | Gratuit |
| Un compte **Cloudflare** | Héberge le bot, l'application et tes épisodes | Gratuit, sans carte bancaire |
| Une clé **Gemini** (Google AI Studio) | Écrit et dit l'épisode ; elle se colle dans l'application | Gratuit |

Tout passe ensuite par l'application (sur ton téléphone, comme une vraie appli) : tu y écoutes tes épisodes, une notification te prévient chaque matin, et ton appli de podcasts peut les recevoir aussi.

Ouvre un fichier texte et note chaque valeur au fur et à mesure : ce sont des secrets, ne les publie nulle part.

---

## Étape 1 · Ton dépôt GitHub

Crée un compte sur github.com, puis ouvre le modèle [github.com/defiguei/podcast-matin-modele](https://github.com/defiguei/podcast-matin-modele) → bouton vert **Use this template** → *Create a new repository*. Nom : `podcast-matin`, visibilité **Private** → *Create repository*.

## Étape 2 · Les valeurs à récupérer

### Cloudflare (2 valeurs)
Crée un compte sur dash.cloudflare.com.
- **Account ID** : *Workers & Pages* → à droite de la page. Copie-le.
- **Jeton d'API** : ta photo → *My Profile* → *API Tokens* → *Create Token* → modèle **Edit Cloudflare Workers** → *Use template*. *Account Resources* : ton compte ; *Zone Resources* : *All zones* → *Continue to summary* → *Create Token*. Copie le jeton tout de suite (il n'est montré qu'une fois).
- Dans *Workers & Pages*, si Cloudflare te demande un **sous-domaine** `xxx.workers.dev`, choisis-le et note-le : ton bot sera à l'adresse `https://podcast.xxx.workers.dev`.

### Un jeton GitHub pour le bot (1 valeur)
Le bot lance les épisodes sur GitHub et y installe les mises à jour ; ce jeton protège aussi les échanges entre GitHub et le bot. Sur GitHub : ta photo → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token*.
- *Expiration* : la plus longue possible (ou *No expiration*) ;
- *Repository access* : **Only select repositories** → `podcast-matin` ;
- *Permissions* → *Repository permissions* : **Actions**, **Contents** et **Workflows** en *Read and write*.

*Generate token*, puis copie-le.

## Étape 3 · Ranger les secrets dans GitHub

Dans ton dépôt `podcast-matin` : *Settings* → *Secrets and variables* → *Actions*.

**Onglet Secrets → New repository secret**, un par ligne :

| Nom exact | Valeur |
|---|---|
| `BOT_GITHUB_TOKEN` | le jeton GitHub du bot |
| `CLOUDFLARE_API_TOKEN` | jeton Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID Cloudflare |

**Onglet Variables → New repository variable :** `BOT_URL` = `https://podcast.xxx.workers.dev` (avec ton sous-domaine).

C'est tout : rien à taper chez Cloudflare, rien à modifier dans les fichiers. Le déploiement transmet ces secrets au bot, avec le nom de ton dépôt et son adresse.

## Étape 4 · Mettre le bot en ligne

Onglet **Actions** → *Déployer le bot* → *Run workflow*. Les tests tournent, le bot est mis en ligne, reçoit ses secrets et s'active (deux à trois minutes). Si le message est orange, il manque `CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_ACCOUNT_ID`.

Ouvre ensuite l'exécution terminée (clique dessus) : son **résumé** affiche l'adresse de ton application et un **code de connexion** à 6 chiffres (valable une heure).

## Étape 5 · L'application

Sur ton téléphone, ouvre l'adresse donnée par le résumé (`https://podcast.xxx.workers.dev/app`).
- **iPhone** : dans Safari, touche Partager › « Sur l'écran d'accueil », puis ouvre l'application **depuis l'icône** et entre le code (c'est là que les notifications marchent).
- **Android** : dans Chrome, entre le code ; Chrome propose ensuite de l'installer (menu ⋮ › « Installer l'application »).

Code expiré ? Onglet **Actions** → *Code de connexion* → *Run workflow* : un nouveau code apparaît dans le résumé de l'exécution. C'est aussi ainsi qu'on ajoute un autre appareil (ou, plus simple, *Afficher un code* dans l'application déjà ouverte : Réglages › Application).

Le premier lancement te guide en cinq étapes : ton prénom, ta ville et ton pays, l'heure de l'épisode, ton agenda (adresse secrète iCal de Google Agenda ou d'Outlook), et ta **clé Gemini** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey) → *Create API key*). Touche enfin **Générer mon premier épisode**.

Ensuite, tout se règle dans l'application : rubriques (onglet Épisode), horaires (Planning), voix, style, sources et clés (Réglages › Sources), clé Gemini (Réglages › Gemini). Dans **Réglages › Application**, mets l'interrupteur de **notifications** de ton téléphone pour être prévenu chaque matin, et, si tu veux, le **flux privé** pour ton appli de podcasts. La clé **Tavily** (facultative, gratuite sur app.tavily.com) améliore les idées de sortie.

> Facultatif : range aussi ta clé Gemini en secret GitHub `GEMINI_API_KEY`. Si le bot était un jour injoignable, le filet de sécurité de GitHub pourrait quand même fabriquer l'épisode.

---

## En cas de souci

| Souci | Que faire |
|---|---|
| Pas de code dans le résumé du déploiement | Onglet *Actions* → *Code de connexion* → *Run workflow*. S'il dit « bot injoignable », vérifie la variable `BOT_URL`. |
| « Pas de code valable » en entrant le code | Il a expiré (une heure) ou servi : demande-en un nouveau (*Code de connexion*). |
| Le bot ne semble pas activé après le déploiement | Ouvre `https://podcast.xxx.workers.dev/installer` dans ton navigateur. |
| *Déployer le bot* signale un secret manquant | Ajoute le secret nommé (étape 3), puis relance *Déployer le bot*. |
| Pas d'épisode | Onglet *Actions* → l'exécution en rouge → lis le message en haut. |
| « La clé Gemini manque » ou « est refusée » | Réglages › Gemini : colle la clé, touche *Tester*. |
| « agenda inaccessible » | L'adresse iCal a changé : retire l'agenda et ajoute la nouvelle. |
| Tu as changé le jeton `BOT_GITHUB_TOKEN` | Relance *Déployer le bot* pour que le bot reçoive le nouveau. |
| Une mise à jour ne touche pas aux fichiers d'automatisation | Le jeton GitHub du bot n'a pas la permission *Workflows* : voir [MISE-A-JOUR.md](MISE-A-JOUR.md). |

**Confidentialité :** Google reçoit le titre, l'heure et le lieu de tes rendez-vous pour écrire l'épisode ; Tavily reçoit les recherches de tes rubriques. Tes clés et tes épisodes restent chez ton bot et dans les secrets GitHub, jamais dans le code. Garde ton dépôt **privé** : le résumé des exécutions (et ses codes de connexion) n'est visible que de toi.
