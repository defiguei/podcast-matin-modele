#!/usr/bin/env python3
"""Code de connexion à l'application, demandé au bot par GitHub.

C'est ainsi qu'on ouvre l'application la première fois, ou sur un nouvel
appareil sans en avoir un autre déjà connecté sous la main : le code (6 chiffres, valable une heure, une seule fois) et un
lien qui le contient s'affichent dans le résumé de l'exécution GitHub, visible
de toi seul (dépôt privé).

    python3 code_connexion.py              # workflow « Code de connexion »
    python3 code_connexion.py --premiere   # fin du déploiement : seulement tant
                                           # qu'aucun appareil n'est connecté

Variables : BOT_URL et BOT_GITHUB_TOKEN (secret partagé).
Bibliothèque standard seulement : il tourne sans rien installer.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request


def resume(texte: str) -> None:
    """Le résumé de l'exécution (onglet Actions → l'exécution), en Markdown."""
    chemin = os.environ.get("GITHUB_STEP_SUMMARY")
    if chemin:
        with open(chemin, "a", encoding="utf-8") as fichier:
            fichier.write(texte + "\n")
    print(texte)


def main(arguments: list[str]) -> int:
    premiere = "--premiere" in arguments
    adresse = os.environ.get("BOT_URL", "").strip().rstrip("/")
    jeton = os.environ.get("BOT_GITHUB_TOKEN", "").strip()
    if not adresse or not jeton:
        print("::warning::Il faut la variable BOT_URL et le secret BOT_GITHUB_TOKEN (docs/INSTALLATION.md).")
        return 0 if premiere else 1
    secret = hashlib.sha256(f"podcast:{jeton}".encode()).hexdigest()[:48]
    requete = urllib.request.Request(f"{adresse}/api/code-connexion{'?si=premiere' if premiere else ''}",
                                     headers={"X-Podcast-Secret": secret, "User-Agent": "podcast-matin-github"})
    try:
        with urllib.request.urlopen(requete, timeout=20) as reponse:
            donnees = json.loads(reponse.read().decode("utf-8"))
    except urllib.error.HTTPError as erreur:
        message = ("le bot refuse la demande : relance « Déployer le bot » pour qu'il reçoive BOT_GITHUB_TOKEN."
                   if erreur.code == 403 else f"le bot répond {erreur.code} (version trop ancienne ? relance « Mettre à jour »).")
        print(f"::{'warning' if premiere else 'error'}::Pas de code de connexion : {message}")
        return 0 if premiere else 1
    except Exception as erreur:   # bot injoignable, adresse fausse
        print(f"::{'warning' if premiere else 'error'}::Pas de code de connexion : bot injoignable à {adresse} "
              f"({type(erreur).__name__}). Vérifie la variable BOT_URL.")
        return 0 if premiere else 1

    code = donnees.get("code")
    application = donnees.get("adresse") or f"{adresse}/app"
    if not code:
        # Fin du déploiement, quand un code n'est pas utile : on dit pourquoi, et comment en avoir un.
        pourquoi = "Un appareil est déjà connecté à l'application."
        resume("\n".join([
            "## 📱 Ton application",
            "",
            f"Adresse : **{application}** (dans le navigateur de n'importe quel appareil).",
            "",
            f"{pourquoi} Pour l'ouvrir sur un nouvel appareil, il faut un code : *Afficher un code* dans l'application "
            "déjà ouverte (Réglages › Application), ou ici : onglet **Actions** › **Code de connexion** › *Run workflow*.",
        ]))
        return 0
    jusqua = donnees.get("jusqua") or ""
    resume("\n".join([
        "## 📱 Ouvre ton podcast",
        "",
        f"1. Sur ton téléphone, ouvre **{application}**",
        f"2. Entre le code **{code}**" + (f" (valable jusqu'à {jusqua.replace(':', ' h ')}, une seule fois)." if jusqua else "."),
        "",
        f"Ou touche ce lien sur ton téléphone : {application}#code={code}",
        "",
        "Sur **iPhone**, ajoute d'abord la page à ton écran d'accueil (Partager › « Sur l'écran d'accueil »), "
        "ouvre-la depuis l'icône, puis entre le code : les notifications ne marchent que là.",
        "",
        "Besoin d'un autre code plus tard (nouvel appareil) : onglet **Actions** › **Code de connexion** › *Run workflow*.",
    ]))
    print(f"::notice title=Code de connexion::{code} — à entrer sur {application}" + (f" avant {jusqua}" if jusqua else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
