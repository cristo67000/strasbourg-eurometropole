#!/usr/bin/env python3
"""Génère les icônes PWA (icons/icon-*.png) : flèche de la cathédrale
stylisée sur fond bleu (couleur d'accent de l'app, #1a5fb4). Pas de photo
ni de police : un simple polygone, cohérent avec l'esprit « zéro build »."""
import pathlib
from PIL import Image, ImageDraw

RACINE = pathlib.Path(__file__).resolve().parent.parent
DOSSIER_ICONES = RACINE / "icons"

BLEU = (26, 95, 180, 255)
BLANC = (255, 255, 255, 255)


def fleche(dessin, cx, base_y, hauteur, largeur):
    """Silhouette simplifiée d'une flèche gothique (corps + pointe + croix)."""
    corps_haut = base_y - hauteur * 0.55
    pointe_haut = base_y - hauteur
    demi = largeur / 2
    dessin.polygon(
        [
            (cx - demi, base_y),
            (cx - demi * 0.55, corps_haut),
            (cx, pointe_haut),
            (cx + demi * 0.55, corps_haut),
            (cx + demi, base_y),
        ],
        fill=BLANC,
    )
    # petite croix au sommet
    ep = largeur * 0.06
    lc = largeur * 0.22
    dessin.rectangle([cx - ep, pointe_haut - lc, cx + ep, pointe_haut], fill=BLANC)
    dessin.rectangle([cx - lc / 2, pointe_haut - lc * 0.65, cx + lc / 2, pointe_haut - lc * 0.65 + ep * 2], fill=BLANC)


def image_base(taille, marge_ratio):
    img = Image.new("RGBA", (taille, taille), BLEU)
    d = ImageDraw.Draw(img)
    marge = taille * marge_ratio
    cx = taille / 2
    base_y = taille - marge
    hauteur = taille - 2 * marge
    largeur = hauteur * 0.42
    fleche(d, cx, base_y, hauteur, largeur)
    return img


def main():
    DOSSIER_ICONES.mkdir(exist_ok=True)

    image_base(192, 0.16).save(DOSSIER_ICONES / "icon-192.png")
    image_base(512, 0.16).save(DOSSIER_ICONES / "icon-512.png")
    # maskable : zone de sécurité ~40 % du rayon, donc marge généreuse
    image_base(512, 0.28).save(DOSSIER_ICONES / "icon-maskable-512.png")

    print("Icônes écrites dans", DOSSIER_ICONES)


if __name__ == "__main__":
    main()
