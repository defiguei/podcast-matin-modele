"""Fabrique les icônes de l'application (écran d'accueil, appli installée) :
un lever de soleil sombre sur fond orange, comme dans l'application.
Écrit src/icones.js (PNG en base64). Usage : python3 test/fabriquer_icones.py
"""
import base64
import io
from pathlib import Path

from PIL import Image, ImageDraw

ORANGE, SOMBRE = (242, 166, 90), (26, 18, 6)


def icone(taille: int, marge: float = 0.0) -> bytes:
    echelle = 4  # dessin agrandi puis réduit : bords lisses
    t = taille * echelle
    image = Image.new("RGB", (t, t), ORANGE)
    d = ImageDraw.Draw(image)
    interieur = t * (1 - 2 * marge)
    def p(x: float, y: float) -> tuple[float, float]:   # coordonnées sur une grille de 24
        return (t * marge + x / 24 * interieur, t * marge + y / 24 * interieur)
    e = max(2, int(interieur / 24 * 1.6))
    d.line([p(4, 17.5), p(20, 17.5)], fill=SOMBRE, width=e)
    x0, y0 = p(7, 12.5); x1, y1 = p(17, 22.5)
    d.arc([x0, y0, x1, y1], 180, 360, fill=SOMBRE, width=e)
    for a, b in [((12, 6.5), (12, 9.5)), ((5.6, 10.1), (7.4, 11.9)), ((18.4, 10.1), (16.6, 11.9))]:
        d.line([p(*a), p(*b)], fill=SOMBRE, width=e)
    for (x, y) in [p(4, 17.5), p(20, 17.5), p(12, 6.5), p(12, 9.5), p(5.6, 10.1), p(7.4, 11.9), p(18.4, 10.1), p(16.6, 11.9)]:
        d.ellipse([x - e / 2, y - e / 2, x + e / 2, y + e / 2], fill=SOMBRE)
    image = image.resize((taille, taille), Image.LANCZOS)
    tampon = io.BytesIO()
    image.save(tampon, "PNG", optimize=True)
    return tampon.getvalue()


icones = {"icone192": icone(192, 0.12), "icone512": icone(512, 0.12), "masque512": icone(512, 0.2), "pomme180": icone(180, 0.12)}
lignes = ["// Icônes de l'application (fabriquées par test/fabriquer_icones.py) : PNG en base64.",
          *[f'export const {nom} = "{base64.b64encode(octets).decode()}";' for nom, octets in icones.items()]]
(Path(__file__).resolve().parent.parent / "src" / "icones.js").write_text("\n".join(lignes) + "\n", encoding="utf-8")
print({nom: len(octets) for nom, octets in icones.items()})
