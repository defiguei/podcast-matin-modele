# Installer son Podcast du matin

Un podcast quotidien à deux voix, fabriqué chaque matin à partir de ton agenda et de l'actualité, **gratuit** et sans ordinateur allumé. Compte une dizaine de minutes. Il te faut :

| Quoi | À quoi ça sert | Coût |
|------|----------------|------|
| Un compte **GitHub** | Héberge le code et fabrique les épisodes | Gratuit |
| Un compte **Cloudflare** | Héberge le bot, l'application et tes épisodes | Gratuit, sans carte bancaire |
| Une clé **Gemini** (Google AI Studio) | Écrit et dit l'épisode ; elle se colle dans l'application, à la fin | Gratuit |

## Le plus simple : la page d'installation

👉 **[defiguei.github.io/podcast-matin-modele/installer](https://defiguei.github.io/podcast-matin-modele/installer/)**

Elle te fait créer ta copie et deux jetons (des liens tout prêts : il ne reste qu'à valider), puis elle range les jetons dans ton dépôt, met ton bot en ligne et te donne le code pour ouvrir l'application, avec un QR code à scanner. Tes jetons ne quittent pas ton navigateur, sauf vers GitHub.

Si la page ne marche pas chez toi, tout se fait aussi à la main, ci-dessous.

---

## À la main

### Étape 1 · Ta copie

Crée un compte sur github.com, puis ouvre [ce lien](https://github.com/new?template_owner=defiguei&template_name=podcast-matin-modele&owner=%40me&name=podcast-matin&visibility=private) : tout est rempli (nom `podcast-matin`, **Private**). Touche *Create repository*.

### Étape 2 · Le jeton GitHub du bot

Le bot s'en sert pour lancer les épisodes et installer les mises à jour. Ouvre [ce lien](https://github.com/settings/personal-access-tokens/new?name=Podcast+du+matin&expires_in=none&actions=write&contents=write&workflows=write) : nom, durée et permissions (**Actions**, **Contents** et **Workflows** en *Read and write*) sont remplis.
- *Repository access* : **Only select repositories** → `podcast-matin` ;
- *Generate token*, puis copie-le.

> Si le formulaire arrive vide : *Expiration* la plus longue (ou *No expiration*) ; *Permissions* → *Repository permissions* : Actions, Contents et Workflows en *Read and write*.

### Étape 3 · Le jeton Cloudflare

Crée un compte sur dash.cloudflare.com (confirme ton adresse e-mail s'il le demande), puis ouvre [ce lien](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Podcast%20du%20matin) : la liste doit contenir **Workers Scripts · Edit**. *Continue to summary* → *Create Token*, puis copie le jeton (il n'est montré qu'une fois).

> Si la liste est vide : *Create Token* → modèle **Edit Cloudflare Workers** → *Use template* ; *Zone Resources* : *All zones* → *Continue to summary* → *Create Token*.

Rien d'autre à noter chez Cloudflare : ton compte et ton adresse `workers.dev` sont trouvés (ou créés) au déploiement.

### Étape 4 · Ranger les deux jetons dans GitHub

Dans ton dépôt `podcast-matin` : *Settings* → *Secrets and variables* → *Actions* → **New repository secret**, un par ligne :

| Nom exact | Valeur |
|---|---|
| `BOT_GITHUB_TOKEN` | le jeton GitHub du bot |
| `CLOUDFLARE_API_TOKEN` | le jeton Cloudflare |

### Étape 5 · Mettre le bot en ligne

Onglet **Actions** → *Déployer le bot* → *Run workflow*. Les tests tournent, le bot est mis en ligne, reçoit ses secrets, s'active, et son adresse est inscrite dans ton dépôt (trois minutes environ).

Ouvre ensuite l'exécution terminée (clique dessus) : son **résumé** affiche l'adresse de ton application et un **code de connexion** à 6 chiffres (valable une heure).

### Étape 6 · L'application

Sur ton téléphone, ouvre l'adresse donnée par le résumé (`https://podcast.<ton-sous-domaine>.workers.dev/app`).
- **iPhone** : dans Safari, touche Partager › « Sur l'écran d'accueil », puis ouvre l'application **depuis l'icône** et entre le code (c'est là que les notifications marchent).
- **Android** : dans Chrome, entre le code ; Chrome propose ensuite de l'installer (menu ⋮ › « Installer l'application »).

Code expiré ? Onglet **Actions** → *Code de connexion* → *Run workflow* : un nouveau code apparaît dans le résumé de l'exécution. C'est aussi ainsi qu'on ajoute un autre appareil (ou, plus simple, *Afficher un code* dans l'application déjà ouverte : Réglages › Application).

---

## Ensuite, dans l'application

Le premier lancement te guide en cinq étapes : ton prénom, ta ville et ton pays, l'heure de l'épisode, ton agenda (adresse secrète iCal de Google Agenda ou d'Outlook), et ta **clé Gemini** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey) → *Create API key*). Touche enfin **Générer mon premier épisode**.

Ensuite, tout se règle dans l'application : rubriques (onglet Épisode), horaires (Planning), voix, style, sources et clés (Réglages › Sources), clé Gemini (Réglages › Gemini). Dans **Réglages › Application**, mets l'interrupteur de **notifications** de ton téléphone pour être prévenu chaque matin, et, si tu veux, le **flux privé** pour ton appli de podcasts. La clé **Tavily** (facultative, gratuite sur app.tavily.com) améliore les idées de sortie.

> Facultatif : range aussi ta clé Gemini en secret GitHub `GEMINI_API_KEY`. Si le bot était un jour injoignable, le filet de sécurité de GitHub pourrait quand même fabriquer l'épisode.

---

## En cas de souci

| Souci | Que faire |
|---|---|
| *Déployer le bot* en orange | Il manque le secret `CLOUDFLARE_API_TOKEN` (étape 4). |
| « Cloudflare refuse le jeton » | Recrée le jeton (étape 3) et remplace le secret `CLOUDFLARE_API_TOKEN`. |
| « Le jeton Cloudflare donne accès à plusieurs comptes » | Ajoute le secret `CLOUDFLARE_ACCOUNT_ID` : l'Account ID du compte à utiliser (*Workers & Pages*, à droite). |
| « Impossible de créer ton sous-domaine » | Ouvre une fois *Workers & Pages* chez Cloudflare, choisis-y un sous-domaine `….workers.dev`, puis relance *Déployer le bot*. |
| « Adresse du bot non inscrite » | Le jeton GitHub du bot doit avoir **Contents** et **Workflows** en *Read and write* (étape 2) ; remplace le secret `BOT_GITHUB_TOKEN`, puis relance *Déployer le bot*. |
| Pas de code dans le résumé du déploiement | Onglet *Actions* → *Code de connexion* → *Run workflow*. |
| « Pas de code valable » en entrant le code | Il a expiré (une heure) ou servi : demande-en un nouveau (*Code de connexion*). |
| Le bot ne semble pas activé après le déploiement | Ouvre `https://podcast.<ton-sous-domaine>.workers.dev/installer` dans ton navigateur. |
| Pas d'épisode | Onglet *Actions* → l'exécution en rouge → lis le message en haut. |
| « La clé Gemini manque » ou « est refusée » | Réglages › Gemini : colle la clé, touche *Tester*. |
| « agenda inaccessible » | L'adresse iCal a changé : retire l'agenda et ajoute la nouvelle. |
| Tu as changé le jeton `BOT_GITHUB_TOKEN` | Relance *Déployer le bot* pour que le bot reçoive le nouveau. |
| Une mise à jour ne touche pas aux fichiers d'automatisation | Le jeton GitHub du bot n'a pas la permission *Workflows* : voir [MISE-A-JOUR.md](MISE-A-JOUR.md). |

Pour imposer une autre adresse au bot (un domaine à toi), règle la variable GitHub `BOT_URL` (*Settings* → *Secrets and variables* → *Actions* → onglet *Variables*) : elle passe avant celle trouvée au déploiement.

**Confidentialité :** Google reçoit le titre, l'heure et le lieu de tes rendez-vous pour écrire l'épisode ; Tavily reçoit les recherches de tes rubriques. Tes clés et tes épisodes restent chez ton bot et dans les secrets GitHub, jamais dans le code. Garde ton dépôt **privé** : le résumé des exécutions (et ses codes de connexion) n'est visible que de toi. La page d'installation demande en plus la permission *Secrets* au jeton GitHub, pour ranger elle-même les deux jetons dans ton dépôt.
