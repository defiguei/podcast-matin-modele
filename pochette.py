"""Pochette de l'épisode (vignette affichée par l'application et le flux privé).

Image carrée de 320 px en JPEG (moins de 200 ko) :
la date en grand sur un dégradé dont la couleur change avec le jour de la
semaine, et le titre de l'épisode.
"""

from __future__ import annotations

import datetime as dt
import io
from pathlib import Path

JOURS = ["LUNDI", "MARDI", "MERCREDI", "JEUDI", "VENDREDI", "SAMEDI", "DIMANCHE"]
MOIS = ["JANV.", "FÉVR.", "MARS", "AVRIL", "MAI", "JUIN", "JUIL.", "AOÛT", "SEPT.", "OCT.", "NOV.", "DÉC."]
# Couleurs (haut, bas) par jour de la semaine : aube, matin, midi…
COULEURS = [
    ((255, 159, 67), (238, 82, 83)),     # lundi : orange → corail
    ((72, 219, 251), (10, 121, 177)),    # mardi : ciel → bleu
    ((29, 209, 161), (16, 172, 132)),    # mercredi : menthe
    ((254, 202, 87), (255, 107, 107)),   # jeudi : soleil → rose
    ((95, 39, 205), (52, 31, 151)),      # vendredi : violet
    ((255, 159, 243), (243, 104, 224)),  # samedi : rose
    ((84, 160, 255), (46, 134, 222)),    # dimanche : bleu doux
]
POLICES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]


def _police(taille: int):
    from PIL import ImageFont
    for chemin in POLICES:
        if Path(chemin).exists():
            return ImageFont.truetype(chemin, taille)
    try:
        return ImageFont.load_default(size=taille)
    except TypeError:
        return ImageFont.load_default()


def _couper(texte: str, police, largeur: int, dessin, lignes_max: int = 3) -> list[str]:
    mots, lignes, courante = texte.split(), [], ""
    for mot in mots:
        essai = f"{courante} {mot}".strip()
        if dessin.textlength(essai, font=police) <= largeur:
            courante = essai
        else:
            if courante:
                lignes.append(courante)
            courante = mot
    if courante:
        lignes.append(courante)
    if len(lignes) > lignes_max:
        lignes = lignes[:lignes_max]
        lignes[-1] = lignes[-1].rstrip(" ,.;:") + "…"
    return lignes


def creer_pochette(jour: dt.date, titre: str, sous_titre: str = "PODCAST DU MATIN") -> bytes | None:
    """JPEG de 320 × 320, ou None si Pillow n'est pas disponible."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    taille = 320
    haut, bas = COULEURS[jour.weekday()]
    image = Image.new("RGB", (taille, taille))
    dessin = ImageDraw.Draw(image)
    for y in range(taille):
        t = y / (taille - 1)
        dessin.line([(0, y), (taille, y)], fill=tuple(round(h + (b - h) * t) for h, b in zip(haut, bas)))
    # Soleil levant stylisé.
    dessin.ellipse((196, -64, 384, 124), fill=(255, 255, 255, 0), outline=(255, 255, 255), width=3)
    dessin.ellipse((222, -38, 358, 98), outline=(255, 255, 255), width=2)
    blanc = (255, 255, 255)
    dessin.text((22, 20), sous_titre, font=_police(15), fill=blanc)
    dessin.text((20, 52), str(jour.day), font=_police(96), fill=blanc)
    dessin.text((24, 160), f"{JOURS[jour.weekday()]} · {MOIS[jour.month - 1]}", font=_police(18), fill=blanc)
    dessin.line([(24, 194), (120, 194)], fill=blanc, width=3)
    police_titre = _police(21)
    for i, ligne in enumerate(_couper(titre, police_titre, taille - 44, dessin)):
        dessin.text((22, 208 + i * 28), ligne, font=police_titre, fill=blanc)
    sortie = io.BytesIO()
    for qualite in (88, 75, 60):
        sortie.seek(0)
        sortie.truncate()
        image.save(sortie, "JPEG", quality=qualite, optimize=True)
        if sortie.tell() < 190_000:
            break
    return sortie.getvalue()

