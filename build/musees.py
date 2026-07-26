# -*- coding: utf-8 -*-
"""Musées et lieux de visite -> data/musees.json (+ photos dans img/musees/).

Croisement de trois sources, chacune pour ce qu'elle sait faire :

* **OpenStreetMap** (via Overpass) fournit l'ossature : position exacte,
  `opening_hours` en syntaxe normalisée, indication payant/gratuit,
  accessibilité, site web. C'est la seule source ouverte à porter des horaires
  exploitables pour l'agglomération entière, Kehl comprise.
* **data.strasbourg.eu** (jeu « lieux_culture ») apporte la description
  officielle en français et le lien vers la fiche de la Ville. Ce jeu ne
  contient **aucun horaire** : les 362 fiches ont toutes `periods` vide.
* **Wikidata / Wikimedia Commons** fournit une photographie, uniquement quand
  la propriété P18 la rattache explicitement au lieu — un rapprochement par
  nom sur Commons produirait des faux positifs.

Aucun tarif n'est inventé : on ne publie que l'indication payant/gratuit d'OSM
et un lien vers la source officielle. Les horaires sont recopiés tels quels et
datés ; leur interprétation (ouvert/fermé) a lieu côté client, avec repli sur
l'affichage brut quand la syntaxe dépasse le sous-ensemble reconnu.

Usage : python build/musees.py [--sans-photos]
"""
import argparse
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

import overpass

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"
IMAGES = RACINE / "img" / "musees"
CACHE = Path(__file__).resolve().parent / "cache"

URL_LIEUX = ("https://data.strasbourg.eu/api/explore/v2.1/catalog/datasets/"
             "lieux_culture/exports/json")
API_WIKIDATA = "https://www.wikidata.org/w/api.php"
API_COMMONS = "https://commons.wikimedia.org/w/api.php"

# Wikimedia refuse les requêtes dont l'agent n'identifie pas l'outil et un
# moyen de contact (politique robots, https://w.wiki/4wJS).
AGENT = ("strasbourg-eurometropole-build/1.0 "
         "(+https://github.com/cristo67000; carte hors ligne) Python-urllib")
PAUSE_COMMONS = 1.2   # secondes entre deux téléchargements d'image

RAPPROCHEMENT_M = 250     # distance maximale pour rapprocher OSM et fiche Ville
LARGEUR_PHOTO = 720       # largeur des vignettes embarquées
MOTS_VIDES = {"le", "la", "les", "de", "des", "du", "d", "l", "et", "a", "au",
              "aux", "musee", "museum", "centre", "maison", "strasbourg"}

REQUETE = """
[out:json][timeout:200];
(
  nwr[tourism=museum](%f,%f,%f,%f);
  nwr[tourism=aquarium](%f,%f,%f,%f);
  nwr[amenity=planetarium](%f,%f,%f,%f);
  nwr[tourism=gallery][name](%f,%f,%f,%f);
);
out tags center;
"""


# ---------------------------------------------------------------- utilitaires

def normaliser(nom):
    sans_accent = "".join(
        c for c in unicodedata.normalize("NFD", nom or "")
        if unicodedata.category(c) != "Mn"
    )
    return " ".join(sans_accent.lower().replace("'", " ").split())


def mots_cles(nom):
    return {m for m in re.split(r"[^a-z0-9]+", normaliser(nom))
            if m and m not in MOTS_VIDES}


def similarite(a, b):
    ma, mb = mots_cles(a), mots_cles(b)
    if not ma or not mb:
        return 0.0
    return len(ma & mb) / len(ma | mb)


def metres(lat1, lon1, lat2, lon2):
    return math.hypot((lon1 - lon2) * 74000.0, (lat1 - lat2) * 111200.0)


def texte_multilingue(valeur):
    """Le jeu de la Ville sérialise ses champs traduits sans accolades."""
    if isinstance(valeur, dict):
        return (valeur.get("fr_FR") or next(iter(valeur.values()), "") or "").strip()
    if isinstance(valeur, str):
        if '"fr_FR"' in valeur:
            try:
                return (json.loads("{" + valeur + "}").get("fr_FR") or "").strip()
            except json.JSONDecodeError:
                # certaines fiches contiennent des retours à la ligne bruts,
                # invalides en JSON : on extrait la seule valeur utile.
                # Surtout pas de décodage « unicode_escape » ici, il
                # interpréterait l'UTF-8 comme du Latin-1.
                trouve = re.search(r'"fr_FR"\s*:\s*("(?:[^"\\]|\\.)*")', valeur, re.S)
                if trouve:
                    try:
                        return json.loads(trouve.group(1)).strip()
                    except json.JSONDecodeError:
                        return trouve.group(1).strip('"').strip()
                return ""
        return valeur.strip()
    return ""


def sans_html(texte, maximum=520):
    texte = re.sub(r"<[^>]+>", " ", texte or "")
    texte = (texte.replace("&nbsp;", " ").replace("&amp;", "&")
             .replace("&quot;", '"').replace("&#39;", "'")
             .replace("&laquo;", "«").replace("&raquo;", "»"))
    texte = " ".join(texte.split())
    if len(texte) > maximum:
        coupe = texte[:maximum].rsplit(" ", 1)[0]
        texte = coupe + "…"
    return texte


def json_distant(url, params=None, essais=3):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    derniere = None
    for _ in range(essais):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            derniere = e
            time.sleep(2)
    raise RuntimeError(f"échec sur {url} : {derniere}")


# -------------------------------------------------------------------- sources

def lire_osm():
    bbox = overpass.BBOX
    requete = REQUETE % (bbox * 4)
    data = overpass.interroger(requete)
    lieux = []
    for e in data["elements"]:
        t = e.get("tags", {})
        nom = (t.get("name") or "").strip()
        if not nom:
            continue
        centre = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if centre.get("lat") is None:
            continue
        lieux.append({
            "nom": nom,
            "lat": round(float(centre["lat"]), 5),
            "lon": round(float(centre["lon"]), 5),
            "categorie": t.get("tourism") or t.get("amenity") or "musee",
            "horaires": (t.get("opening_hours") or "").strip(),
            "payant": t.get("fee"),
            "site": (t.get("website") or t.get("contact:website") or "").strip(),
            "telephone": (t.get("phone") or t.get("contact:phone") or "").strip(),
            "wikidata": (t.get("wikidata") or "").strip(),
            "fauteuil": t.get("wheelchair"),
            "osm": f"{e['type']}/{e['id']}",
        })
    print(f"  {len(lieux)} lieux OSM, dont "
          f"{sum(1 for l in lieux if l['horaires'])} avec horaires")
    return lieux


def lire_ville():
    """Jeu « lieux_culture » de data.strasbourg.eu, mis en cache localement."""
    cache = CACHE / "lieux_culture.json"
    if cache.exists():
        print(f"  cache {cache.name}")
        brut = json.loads(cache.read_text(encoding="utf-8"))
    else:
        print("  téléchargement du jeu lieux_culture")
        brut = json_distant(URL_LIEUX)
        CACHE.mkdir(exist_ok=True)
        cache.write_text(json.dumps(brut, ensure_ascii=False), encoding="utf-8")

    fiches = []
    for r in brut:
        geo = r.get("point_geo") or {}
        if not geo.get("lat"):
            continue
        fiches.append({
            "nom": texte_multilingue(r.get("name")),
            "lat": float(geo["lat"]), "lon": float(geo["lon"]),
            "types": r.get("types") or "",
            "description": sans_html(texte_multilingue(r.get("description"))),
            "adresse": (r.get("address") or "").replace(" France", "").strip(),
            "lien": r.get("friendlyurl") or "",
            "site": r.get("websiteurl") or "",
            "telephone": r.get("phone") or "",
            "fauteuil": r.get("accessforwheelchair"),
        })
    print(f"  {len(fiches)} fiches de la Ville")
    return fiches


def rapprocher(lieux, fiches):
    """Associe à chaque lieu OSM la fiche officielle la plus plausible."""
    apparies = 0
    for lieu in lieux:
        meilleur, score_max = None, 0.0
        for f in fiches:
            d = metres(lieu["lat"], lieu["lon"], f["lat"], f["lon"])
            if d > RAPPROCHEMENT_M:
                continue
            sim = similarite(lieu["nom"], f["nom"])
            # la proximité seule ne suffit pas : plusieurs lieux culturels
            # partagent une adresse (palais Rohan en réunit trois)
            score = sim + (0.25 if d < 60 else 0.0)
            if score > score_max and sim >= 0.34:
                meilleur, score_max = f, score
        if meilleur:
            apparies += 1
            lieu["description"] = meilleur["description"]
            lieu["adresse"] = meilleur["adresse"]
            lieu["lien"] = meilleur["lien"]
            lieu["categorie_ville"] = meilleur["types"]
            if not lieu["site"]:
                lieu["site"] = meilleur["site"]
            if not lieu["telephone"]:
                lieu["telephone"] = meilleur["telephone"]
    print(f"  {apparies} lieux rapprochés d'une fiche officielle")

    # Les galeries d'art marchandes ne sont pas des lieux de visite ; on ne
    # garde que celles que la Ville recense comme lieu culturel (La Chambre,
    # Apollonia…).
    avant = len(lieux)
    lieux = [l for l in lieux
             if l["categorie"] != "gallery" or l.get("description")]
    if avant != len(lieux):
        print(f"  {avant - len(lieux)} galeries marchandes écartées")
    return lieux


# --------------------------------------------------------------------- photos

def photos_wikidata(lieux):
    """P18 (image) des lieux disposant d'un identifiant Wikidata."""
    ids = [l["wikidata"] for l in lieux if l["wikidata"]]
    if not ids:
        return {}
    fichiers = {}
    for debut in range(0, len(ids), 40):
        lot = ids[debut:debut + 40]
        data = json_distant(API_WIKIDATA, {
            "action": "wbgetentities", "ids": "|".join(lot),
            "props": "claims", "format": "json",
        })
        for qid, entite in (data.get("entities") or {}).items():
            revendications = (entite.get("claims") or {}).get("P18") or []
            if revendications:
                valeur = revendications[0].get("mainsnak", {}).get("datavalue", {})
                if valeur.get("value"):
                    fichiers[qid] = valeur["value"]
    print(f"  {len(fichiers)} photos référencées sur Wikidata")
    return fichiers


def details_commons(noms_fichiers):
    """URL de vignette, auteur et licence pour chaque fichier Commons."""
    details = {}
    noms = list(noms_fichiers)
    for debut in range(0, len(noms), 20):
        lot = noms[debut:debut + 20]
        data = json_distant(API_COMMONS, {
            "action": "query", "format": "json",
            "titles": "|".join("File:" + n for n in lot),
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": str(LARGEUR_PHOTO),
        })
        for page in (data.get("query", {}).get("pages") or {}).values():
            infos = (page.get("imageinfo") or [{}])[0]
            if not infos.get("thumburl"):
                continue
            meta = infos.get("extmetadata") or {}

            def champ(cle):
                return sans_html((meta.get(cle) or {}).get("value", ""), 120)

            details[page["title"][len("File:"):]] = {
                "url": infos["thumburl"],
                "auteur": champ("Artist") or "auteur inconnu",
                "licence": champ("LicenseShortName") or "voir Commons",
                "page": infos.get("descriptionurl", ""),
            }
    return details


def telecharger_photos(lieux, fichiers):
    from PIL import Image

    IMAGES.mkdir(parents=True, exist_ok=True)
    details = details_commons(set(fichiers.values()))
    obtenues = 0
    for lieu in lieux:
        nom_fichier = fichiers.get(lieu["wikidata"])
        if not nom_fichier or nom_fichier not in details:
            continue
        info = details[nom_fichier]
        cible = IMAGES / (re.sub(r"[^a-z0-9]+", "-", normaliser(lieu["nom"])).strip("-")
                          + ".webp")
        if not cible.exists():
            brut = None
            for essai in range(3):
                try:
                    req = urllib.request.Request(info["url"],
                                                 headers={"User-Agent": AGENT})
                    with urllib.request.urlopen(req, timeout=120) as r:
                        brut = r.read()
                    break
                except Exception as e:
                    if essai == 2:
                        print(f"    photo indisponible pour {lieu['nom']} : {e}")
                    time.sleep(3 * (essai + 1))
            if brut is None:
                continue
            try:
                import io
                image = Image.open(io.BytesIO(brut)).convert("RGB")
                image.thumbnail((LARGEUR_PHOTO, LARGEUR_PHOTO * 2))
                image.save(cible, "WEBP", quality=78, method=5)
            except Exception as e:
                print(f"    image illisible pour {lieu['nom']} : {e}")
                continue
            time.sleep(PAUSE_COMMONS)   # courtoisie envers Commons
        lieu["photo"] = "img/musees/" + cible.name
        lieu["photo_credit"] = f"{info['auteur']} — {info['licence']} (Wikimedia Commons)"
        obtenues += 1
    print(f"  {obtenues} photos embarquées")


# ------------------------------------------------------------------ programme

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sans-photos", action="store_true")
    args = ap.parse_args()

    print("OpenStreetMap :")
    lieux = lire_osm()
    print("Ville et Eurométropole de Strasbourg :")
    fiches = lire_ville()
    print("Rapprochement :")
    lieux = rapprocher(lieux, fiches)

    if not args.sans_photos:
        print("Photographies :")
        try:
            fichiers = photos_wikidata(lieux)
            telecharger_photos(lieux, fichiers)
        except Exception as e:
            print(f"  photos ignorées : {e}")

    lieux.sort(key=lambda l: normaliser(l["nom"]))
    sortie = {
        "sources": {
            "osm": "OpenStreetMap (position, horaires, accessibilité) — ODbL",
            "ville": "data.strasbourg.eu, jeu « lieux_culture » "
                     "(description, lien officiel)",
            "photos": "Wikimedia Commons via Wikidata P18, crédit par photo",
        },
        "releve": time.strftime("%Y-%m-%d"),
        "avertissement": "Horaires relevés dans OpenStreetMap à la date "
                         "ci-dessus ; aucun tarif n'est publié. Vérifier auprès "
                         "de l'établissement avant de se déplacer.",
        "lieux": lieux,
    }
    # images laissées par un relevé précédent (lieu disparu ou hors emprise)
    if IMAGES.exists():
        gardees = {Path(l["photo"]).name for l in lieux if l.get("photo")}
        for p in IMAGES.glob("*.webp"):
            if p.name not in gardees:
                p.unlink()
                print(f"  photo orpheline supprimée : {p.name}")

    DATA.mkdir(exist_ok=True)
    chemin = DATA / "musees.json"
    chemin.write_text(json.dumps(sortie, ensure_ascii=False, separators=(",", ":")),
                      encoding="utf-8")
    poids_img = sum(p.stat().st_size for p in IMAGES.glob("*.webp")) if IMAGES.exists() else 0
    print(f"\n{len(lieux)} lieux -> {chemin.name} "
          f"({chemin.stat().st_size / 1e3:.0f} Ko) ; photos {poids_img / 1e6:.2f} Mo")
    print(f"  {sum(1 for l in lieux if l['horaires'])} avec horaires, "
          f"{sum(1 for l in lieux if l.get('description'))} avec description, "
          f"{sum(1 for l in lieux if l.get('photo'))} avec photo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
