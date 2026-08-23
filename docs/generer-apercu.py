# -*- coding: utf-8 -*-
"""
Image d'aperçu pour le partage de lien (Open Graph), pour chaque application.

Quand on envoie l'adresse d'une application par message, le destinataire ne voit
qu'une URL nue, et n'ouvre pas. Cette image lui donne un visage.

Rien n'est inventé : tout est lu dans le manifeste de l'application — son nom,
sa description, sa couleur de thème — et l'icône est la sienne. Une application
qu'on renomme ou qu'on recolore n'a qu'à relancer ce script.

    python generer-apercu.py            # dans le dossier de l'application
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

LARGEUR, HAUTEUR = 1200, 630
E = 2  # suréchantillonnage : Pillow ne lisse pas, on dessine grand puis on réduit


def police(taille, gras=False):
    """Une police système lisible, quelle que soit la machine."""
    noms = (["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"]
            if gras else
            ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"])
    for nom in noms:
        for dossier in (r"C:\Windows\Fonts", "/usr/share/fonts/truetype/dejavu"):
            chemin = os.path.join(dossier, nom)
            if os.path.exists(chemin):
                return ImageFont.truetype(chemin, taille)
    return ImageFont.load_default()


def couleur(valeur, defaut=(24, 28, 34)):
    """« #1e3a5f » → (30, 58, 95)."""
    if not valeur or not valeur.startswith("#"):
        return defaut
    valeur = valeur.lstrip("#")
    if len(valeur) == 3:
        valeur = "".join(c * 2 for c in valeur)
    try:
        return tuple(int(valeur[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return defaut


def clair(rvb):
    """Luminance perçue, pour choisir une couleur de texte lisible."""
    r, v, b = rvb
    return (0.299 * r + 0.587 * v + 0.114 * b) / 255 > 0.55


def melanger(a, b, part):
    return tuple(round(x + (y - x) * part) for x, y in zip(a, b))


def couper_mots(texte, dessin, fonte, largeur_max, lignes_max):
    """Découpe un texte en lignes qui tiennent dans la largeur donnée."""
    mots = texte.split()
    lignes, courante = [], ""
    for mot in mots:
        essai = (courante + " " + mot).strip()
        if dessin.textlength(essai, font=fonte) <= largeur_max:
            courante = essai
        else:
            if courante:
                lignes.append(courante)
            courante = mot
            if len(lignes) == lignes_max:
                break
    if courante and len(lignes) < lignes_max:
        lignes.append(courante)
    if len(lignes) == lignes_max and len(" ".join(lignes)) < len(texte):
        derniere = lignes[-1]
        while (derniere and dessin.textlength(derniere + " …", font=fonte) > largeur_max):
            derniere = derniere.rsplit(" ", 1)[0]
        lignes[-1] = derniere + " …"
    return lignes


def couper_phrase(texte, limite):
    """Première phrase, ou début coupé au mot."""
    texte = " ".join((texte or "").split())
    for fin in (" : ", ". ", " — "):
        if fin in texte[:limite + 40]:
            texte = texte.split(fin)[0]
            break
    if len(texte) <= limite:
        return texte.rstrip(" .,;:")
    return texte[:limite].rsplit(" ", 1)[0].rstrip(" .,;:") + "…"


def dessiner(racine):
    manifeste = json.load(open(os.path.join(racine, "manifest.webmanifest"), encoding="utf-8"))
    fond = couleur(manifeste.get("theme_color"))

    # Un fond trop clair rendrait l'icône et le texte illisibles : on l'assombrit.
    if clair(fond):
        fond = melanger(fond, (18, 20, 24), 0.72)
    texte_vif = (255, 255, 255)
    texte_doux = melanger(fond, (255, 255, 255), 0.62)
    filet = melanger(fond, (255, 255, 255), 0.45)

    image = Image.new("RGB", (LARGEUR * E, HAUTEUR * E), fond)
    d = ImageDraw.Draw(image)

    # L'icône de l'application, à droite, dans un cadre arrondi.
    chemin_icone = os.path.join(racine, "icons", "icon-512.png")
    if os.path.exists(chemin_icone):
        cote = 300 * E
        icone = Image.open(chemin_icone).convert("RGBA").resize((cote, cote), Image.LANCZOS)
        masque = Image.new("L", (cote, cote), 0)
        ImageDraw.Draw(masque).rounded_rectangle([0, 0, cote - 1, cote - 1],
                                                 radius=cote // 6, fill=255)
        position = (LARGEUR * E - cote - 90 * E, (HAUTEUR * E - cote) // 2)
        # Un halo discret, pour détacher l'icône des fonds sombres.
        halo = Image.new("RGB", (cote + 24 * E, cote + 24 * E),
                         melanger(fond, (255, 255, 255), 0.12))
        masque_halo = Image.new("L", halo.size, 0)
        ImageDraw.Draw(masque_halo).rounded_rectangle(
            [0, 0, halo.size[0] - 1, halo.size[1] - 1], radius=cote // 5, fill=255)
        image.paste(halo, (position[0] - 12 * E, position[1] - 12 * E), masque_halo)
        image.paste(icone, position, masque)

    # Le texte, à gauche.
    nom = manifeste.get("name", "")
    titre, sous_titre = (nom.split("—", 1) + [""])[:2]
    titre, sous_titre = titre.strip(), sous_titre.strip()

    marge = 90 * E
    largeur_texte = LARGEUR * E - marge - 420 * E

    fonte_titre = police(64 * E, gras=True)
    lignes_titre = couper_mots(titre, d, fonte_titre, largeur_texte, 2)
    if len(lignes_titre) > 1:
        fonte_titre = police(52 * E, gras=True)
        lignes_titre = couper_mots(titre, d, fonte_titre, largeur_texte, 2)

    fonte_sous = police(32 * E)
    fonte_desc = police(27 * E)
    description = couper_phrase(manifeste.get("description", ""), 120)
    lignes_desc = couper_mots(description, d, fonte_desc, largeur_texte, 3)

    hauteur_titre = len(lignes_titre) * int(fonte_titre.size * 1.16)
    hauteur_sous = int(fonte_sous.size * 1.9) if sous_titre else 0
    hauteur_desc = len(lignes_desc) * int(fonte_desc.size * 1.4)
    y = (HAUTEUR * E - (hauteur_titre + hauteur_sous + hauteur_desc)) // 2

    # Filet vertical, à gauche du titre.
    d.rounded_rectangle([marge - 22 * E, y + 6 * E, marge - 16 * E, y + hauteur_titre - 6 * E],
                        radius=3 * E, fill=filet)

    for ligne in lignes_titre:
        d.text((marge, y), ligne, font=fonte_titre, fill=texte_vif)
        y += int(fonte_titre.size * 1.16)
    if sous_titre:
        y += int(fonte_sous.size * 0.35)
        d.text((marge, y), sous_titre, font=fonte_sous, fill=texte_doux)
        y += int(fonte_sous.size * 1.55)
    for ligne in lignes_desc:
        d.text((marge, y), ligne, font=fonte_desc, fill=texte_doux)
        y += int(fonte_desc.size * 1.4)

    return image.resize((LARGEUR, HAUTEUR), Image.LANCZOS)


def main():
    racine = sys.argv[1] if len(sys.argv) > 1 else "."
    sortie = os.path.join(racine, "icons", "apercu-1200x630.png")
    dessiner(racine).save(sortie, optimize=True)
    print(f"  {os.path.basename(racine):28} {os.path.getsize(sortie) // 1024} Ko")


if __name__ == "__main__":
    main()
