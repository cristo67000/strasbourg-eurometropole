# -*- coding: utf-8 -*-
"""Restaurants, cafés, bars, bureaux de poste, librairies, médiathèques,
pharmacies et épiceries bio -> data/commerces.json.

Seule source : OpenStreetMap (via Overpass), qui porte `opening_hours` et
`website`/`contact:website` pour ces catégories — aucune autre source ouverte
équivalente n'existe pour l'agglomération entière (voir build/musees.py pour
le même choix, déjà justifié). Ni tarif ni menu ne sont publiés ici : hors de
ce qu'OSM fournit de façon fiable.

Usage : python build/commerces.py
"""
import json
import sys
import time
from pathlib import Path

import overpass

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"

REQUETE = """
[out:json][timeout:200];
(
  nwr[amenity=restaurant](%f,%f,%f,%f);
  nwr[amenity=cafe](%f,%f,%f,%f);
  nwr[amenity=bar](%f,%f,%f,%f);
  nwr[amenity=post_office](%f,%f,%f,%f);
  nwr[shop=books](%f,%f,%f,%f);
  nwr[amenity=library](%f,%f,%f,%f);
  nwr[amenity=pharmacy](%f,%f,%f,%f);
  nwr[shop=supermarket][organic=only](%f,%f,%f,%f);
  nwr[shop=convenience][organic=only](%f,%f,%f,%f);
);
out tags center;
"""

CATEGORIE_PAR_TAGS = [
    (("amenity", "restaurant"), "restaurant"),
    (("amenity", "cafe"), "cafe"),
    (("amenity", "bar"), "bar"),
    (("amenity", "post_office"), "post_office"),
    (("shop", "books"), "books"),
    (("amenity", "library"), "library"),
    (("amenity", "pharmacy"), "pharmacy"),
]

# Traduction des valeurs `cuisine` OSM les plus courantes à Strasbourg ; une
# valeur absente du dictionnaire est affichée telle quelle (mieux qu'un
# silence total, mais jamais inventée). Pas de tarif ni de menu — seulement
# la nature de la cuisine, déjà publiée par l'établissement lui-même sur OSM.
CUISINE_FR = {
    "italian": "italienne", "pizza": "pizza", "kebab": "kebab",
    "vietnamese": "vietnamienne", "chinese": "chinoise", "japanese": "japonaise",
    "sushi": "sushis", "thai": "thaïlandaise", "indian": "indienne",
    "french": "française", "burger": "burgers", "sandwich": "sandwichs",
    "coffee_shop": "café", "ice_cream": "glaces", "bakery": "boulangerie",
    "regional": "régionale", "international": "internationale", "asian": "asiatique",
    "mexican": "mexicaine", "greek": "grecque", "turkish": "turque",
    "lebanese": "libanaise", "seafood": "fruits de mer", "steak_house": "grillades",
    "vegetarian": "végétarienne", "vegan": "vegan", "fine_dining": "gastronomique",
    "tapas": "tapas", "bistro": "bistrot", "crepe": "crêpes", "alsatian": "alsacienne",
    "german": "allemande", "spanish": "espagnole", "portuguese": "portugaise",
    "korean": "coréenne", "american": "américaine", "brasserie": "brasserie",
    "fish": "poisson", "noodle": "nouilles", "bubble_tea": "bubble tea",
    "donut": "donuts", "chicken": "poulet", "wok": "wok",
    "indonesian": "indonésienne", "african": "africaine", "moroccan": "marocaine",
    "tunisian": "tunisienne", "middle_eastern": "moyen-orientale",
}

# Doublons ou données OSM datées, repérés à l'usage et corrigés à la main
# plutôt que dans le jeu de données lui-même : documentés ici pour rester
# traçables et ne pas être écrasés à la prochaine régénération.
EXCLUS_MANUELLEMENT = {
    # même lieu que « Médiathèque Olympe de Gouges (Centre ville) », à 5 m
    "Médiathèque Jeunesse Olympe de Gouges (Centre ville)",
}
CORRECTIFS_HORAIRES = {
    # horaires réels communiqués par l'utilisateur (2026-07-28) ; ceux d'OSM
    # étaient inconsistants entre les deux fiches en doublon ci-dessus
    "Médiathèque Olympe de Gouges (Centre ville)":
        "Jan-Jun,Sep-Dec Tu-Sa 10:00-19:00; Jul,Aug Tu-Fr 13:00-18:00; "
        "Jul,Aug Sa 10:00-12:00,14:00-18:00; Mo off; PH off",
}


def categorie(tags):
    # « épicerie bio » = magasin qui ne vend QUE du bio (`organic=only`),
    # jamais un supermarché classique qui en propose aussi (`organic=yes` —
    # Lidl, Auchan, Grand Frais… en sont tous une fausse piste écartée en
    # vérifiant sur de vraies données avant d'écrire la requête définitive).
    if tags.get("organic") == "only" and tags.get("shop") in ("supermarket", "convenience"):
        return "organic"
    for (cle, valeur), nom in CATEGORIE_PAR_TAGS:
        if tags.get(cle) == valeur:
            return nom
    return None


def description(tags, cat):
    """Quelques mots quand OSM en fournit — jamais de texte inventé."""
    brut = (tags.get("description") or "").strip()
    if brut:
        return brut[:160]
    cuisine = (tags.get("cuisine") or "").strip()
    if cuisine:
        mots = [CUISINE_FR.get(c.strip(), c.strip().replace("_", " "))
                for c in cuisine.split(";") if c.strip()]
        if mots:
            return "Cuisine : " + ", ".join(mots)
    if cat in ("post_office", "library"):
        operateur = (tags.get("operator") or "").strip()
        # sigle administratif hérité (Communauté Urbaine de Strasbourg,
        # renommée Eurométropole de Strasbourg en 2015) : d'autres fiches du
        # même réseau portent déjà le nom actuel, gardé cohérent ici plutôt
        # que d'afficher un sigle qui ne veut plus rien dire pour personne
        if operateur == "CUS":
            operateur = "Eurométropole de Strasbourg"
        if operateur:
            return operateur
    if cat == "organic":
        marque = (tags.get("brand") or "").strip()
        if marque and marque.lower() not in tags.get("name", "").lower():
            return "Réseau : " + marque
    return ""


def lire_osm():
    bbox = overpass.BBOX
    requete = REQUETE % (bbox * 9)
    data = overpass.interroger(requete)
    lieux = []
    for e in data["elements"]:
        t = e.get("tags", {})
        nom = (t.get("name") or "").strip()
        if not nom:
            continue
        cat = categorie(t)
        if not cat:
            continue
        centre = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if centre.get("lat") is None:
            continue
        lieux.append({
            "nom": nom,
            "lat": round(float(centre["lat"]), 5),
            "lon": round(float(centre["lon"]), 5),
            "categorie": cat,
            "horaires": (t.get("opening_hours") or "").strip(),
            "site": (t.get("website") or t.get("contact:website") or "").strip(),
            "telephone": (t.get("phone") or t.get("contact:phone") or "").strip(),
            "description": description(t, cat),
        })
    print(f"  {len(lieux)} lieux OSM, dont "
          f"{sum(1 for l in lieux if l['horaires'])} avec horaires, "
          f"{sum(1 for l in lieux if l['site'])} avec site web, "
          f"{sum(1 for l in lieux if l['description'])} avec description")
    categories_uniques = []
    for l in lieux:
        if l["categorie"] not in categories_uniques:
            categories_uniques.append(l["categorie"])
    for cat in categories_uniques:
        n = sum(1 for l in lieux if l["categorie"] == cat)
        print(f"    {cat} : {n}")
    return lieux


def appliquer_correctifs(lieux):
    avant = len(lieux)
    lieux = [l for l in lieux if l["nom"] not in EXCLUS_MANUELLEMENT]
    if avant != len(lieux):
        print(f"  {avant - len(lieux)} doublon(s) manuel(s) écarté(s)")
    n = 0
    for l in lieux:
        if l["nom"] in CORRECTIFS_HORAIRES:
            l["horaires"] = CORRECTIFS_HORAIRES[l["nom"]]
            n += 1
    if n:
        print(f"  {n} horaire(s) corrigé(s) manuellement")
    return lieux


def main():
    print("OpenStreetMap :")
    lieux = lire_osm()
    lieux = appliquer_correctifs(lieux)
    lieux.sort(key=lambda l: (l["categorie"], l["nom"]))

    sortie = {
        "source": "OpenStreetMap (position, horaires, site web) — ODbL",
        "releve": time.strftime("%Y-%m-%d"),
        "avertissement": "Horaires et site relevés dans OpenStreetMap à la date "
                         "ci-dessus ; aucun tarif ni menu n'est publié. Vérifier "
                         "auprès de l'établissement avant de s'y rendre.",
        "lieux": lieux,
    }
    DATA.mkdir(exist_ok=True)
    chemin = DATA / "commerces.json"
    chemin.write_text(json.dumps(sortie, ensure_ascii=False, separators=(",", ":")),
                      encoding="utf-8")
    print(f"\n{len(lieux)} lieux -> {chemin.name} ({chemin.stat().st_size / 1e3:.0f} Ko)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
