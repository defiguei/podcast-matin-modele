#!/usr/bin/env python3
"""Mise à jour du code depuis le modèle (lancée par le bouton « Mettre à jour »
de l'application, via le workflow « Mettre à jour »).

Ce qui t'appartient n'est jamais touché : memoire.json, preferences.json
(sauvegarde de tes réglages) et reglages.toml. Tes réglages eux-mêmes vivent
dans ton bot Cloudflare, qui les garde. Le reste est recopié depuis le modèle,
avec ton dépôt et l'adresse de ton bot à la place des repères du modèle.

Variables : MODELE (ex. « auteur/podcast-matin-modele »), VERSION, ADRESSE
(adresse du bot), GITHUB_REPOSITORY, GH_TOKEN, et BOT_GITHUB_TOKEN (jeton du
bot, avec la permission « Workflows » : secret partagé avec le bot, et envoi des
fichiers d'automatisation).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

RACINE = Path(__file__).resolve().parent
PERSONNELS = {"memoire.json", "preferences.json", "reglages.toml"}
# Écrits en deux morceaux : la mise à jour ne doit pas les remplacer ici même.
REPERE_DEPOT = "TON-COMPTE" "/podcast-matin"
REPERE_HOTE = "podcast.TON-SOUS-DOMAINE" ".workers.dev"
TEXTE = {".py", ".js", ".mjs", ".toml", ".yml", ".yaml", ".md", ".json", ".txt", ".html", ".gitignore"}


def journal(message: str) -> None:
    print(message, flush=True)


def git(*args: str, cwd: Path | None = None, verifier: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd or RACINE, text=True, capture_output=True, check=verifier)


def relancer_deploiement() -> None:
    """Un envoi fait avec le jeton du workflow ne relance rien tout seul : on déploie le bot."""
    subprocess.run(["gh", "workflow", "run", "deployer-bot.yml", "--ref", "main"], cwd=RACINE, check=False)


def fichiers(dossier: Path) -> set[str]:
    return {p.relative_to(dossier).as_posix() for p in dossier.rglob("*")
            if p.is_file() and ".git" not in p.relative_to(dossier).parts}


def copier(modele: Path, cible: Path, depot: str, hote: str, sans_workflows: bool = False) -> tuple[list[str], list[str]]:
    """Recopie le modèle dans cible ; renvoie (fichiers changés, fichiers supprimés)."""
    infos = json.loads((modele / "version.json").read_text(encoding="utf-8")) if (modele / "version.json").exists() else {}
    changes, supprimes = [], []
    for chemin in sorted(fichiers(modele)):
        if chemin in PERSONNELS or (sans_workflows and chemin.startswith(".github/workflows/")):
            continue
        source, destination = modele / chemin, cible / chemin
        if source.suffix in TEXTE or source.name == ".gitignore":
            contenu = source.read_text(encoding="utf-8").replace(REPERE_DEPOT, depot).replace(REPERE_HOTE, hote)
            if destination.exists() and destination.read_text(encoding="utf-8", errors="replace") == contenu:
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contenu, encoding="utf-8")
        else:
            if destination.exists() and destination.read_bytes() == source.read_bytes():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        changes.append(chemin)
    for chemin in infos.get("supprimes") or []:
        chemin = str(chemin).strip("/")
        if not chemin or chemin in PERSONNELS or ".." in chemin or (sans_workflows and chemin.startswith(".github/workflows/")):
            continue
        cible_chemin = cible / chemin
        if cible_chemin.is_file():
            cible_chemin.unlink()
            supprimes.append(chemin)
    return changes, supprimes


def adresse_actuelle(racine: Path) -> str:
    """L'adresse du bot déjà inscrite dans ce dépôt (wrangler.toml), faute de mieux."""
    try:
        texte = (racine / "cloudflare" / "wrangler.toml").read_text(encoding="utf-8")
    except OSError:
        return ""
    trouve = re.search(r'^ADRESSE\s*=\s*"(https://[^"]+)"', texte, re.M)
    return trouve.group(1) if trouve and REPERE_HOTE not in trouve.group(1) else ""


def jeton_du_bot() -> str:
    """Un jeton GitHub avec la permission « Workflows », nécessaire pour mettre à jour
    les fichiers d'automatisation : le secret GitHub BOT_GITHUB_TOKEN."""
    jeton = os.environ.get("BOT_GITHUB_TOKEN", "").strip()
    if jeton and os.environ.get("GITHUB_ACTIONS"):
        print(f"::add-mask::{jeton}", flush=True)
    # Visible dans le résumé de l'exécution : d'où vient le jeton (jamais sa valeur).
    journal(f"::notice title=Jeton GitHub::{'secret GitHub BOT_GITHUB_TOKEN' if jeton else 'aucun (secret BOT_GITHUB_TOKEN absent)'}.")
    return jeton


def prevenir_bot(adresse: str, evenement: dict) -> None:
    try:
        from liaison import Bot
        Bot(adresse).evenement(evenement)
    except Exception as erreur:
        journal(f"Bot non prévenu : {erreur}")


def main() -> int:
    modele_nom = os.environ.get("MODELE", "").strip()
    version = os.environ.get("VERSION", "").strip()
    adresse = os.environ.get("ADRESSE", "").strip()
    depot = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", modele_nom) or not depot:
        journal("::error::Modèle ou dépôt inconnu.")
        return 1
    if not adresse:
        adresse = adresse_actuelle(RACINE)
    hote = urlparse(adresse).netloc or REPERE_HOTE
    with tempfile.TemporaryDirectory() as dossier:
        modele = Path(dossier) / "modele"
        clone = git("clone", "--depth", "1", f"https://github.com/{modele_nom}.git", str(modele), cwd=Path(dossier), verifier=False)
        if clone.returncode:
            message = "Le modèle n'est pas accessible : il doit être public."
            journal(f"::error::{message}\n{clone.stderr[-500:]}")
            prevenir_bot(adresse, {"type": "maj", "ok": False, "version": version, "message": message})
            return 1
        infos = json.loads((modele / "version.json").read_text(encoding="utf-8")) if (modele / "version.json").exists() else {}
        version = infos.get("version") or version
        jeton = jeton_du_bot()
        changes, supprimes = copier(modele, RACINE, depot, hote)
        workflows_changes = any(c.startswith(".github/workflows/") for c in changes + supprimes)
        journal(f"Version {version} : {len(changes)} fichier(s) mis à jour, {len(supprimes)} supprimé(s).")
        if not changes and not supprimes:
            prevenir_bot(adresse, {"type": "maj", "ok": True, "version": version, "message": "Déjà à jour."})
            return 0
        git("config", "user.name", "github-actions[bot]")
        git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
        git("add", "-A")
        git("commit", "-q", "-m", f"Mise à jour depuis le modèle (version {version})")
        workflows_ignores = False
        # L'en-tête d'authentification posé par actions/checkout passerait avant le jeton : on l'efface.
        pousse = git("-c", "http.https://github.com/.extraheader=", "push",
                     f"https://x-access-token:{jeton}@github.com/{depot}.git", "HEAD:main", verifier=False) if jeton else None
        if not pousse or pousse.returncode:
            # Sans la permission « Workflows » : tout sauf les fichiers d'automatisation.
            if pousse is not None:
                journal("Envoi avec le jeton du bot refusé : sans les fichiers d'automatisation.")
            git("reset", "-q", "--hard", "HEAD~1")
            changes, supprimes = copier(modele, RACINE, depot, hote, sans_workflows=True)
            git("add", "-A")
            if git("diff", "--cached", "--quiet", verifier=False).returncode == 0:
                prevenir_bot(adresse, {"type": "maj", "ok": False, "version": version,
                                       "message": "Seuls les fichiers d'automatisation ont changé : il faut un jeton GitHub avec la permission « Workflows » (docs/MISE-A-JOUR.md)."})
                return 1
            git("commit", "-q", "-m", f"Mise à jour depuis le modèle (version {version})")
            git("push", "origin", "HEAD:main")
            workflows_ignores = workflows_changes
            relancer_deploiement()
        message = f"{len(changes)} fichier(s) mis à jour."
        if workflows_ignores:
            message += " Fichiers d'automatisation non mis à jour : il faut un jeton GitHub avec la permission « Workflows » (docs/MISE-A-JOUR.md)."
        prevenir_bot(adresse, {"type": "maj", "ok": True, "version": version, "message": message, "workflows": not workflows_ignores})
        journal(f"::notice title=Mise à jour {version}::{message}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
