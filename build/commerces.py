# -*- coding: utf-8 -*-
"""Restaurants, cafés, bars, bureaux de poste, librairies et médiathèques ->
data/commerces.json.

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
]


def categorie(tags):
    for (cle, valeur), nom in CATEGORIE_PAR_TAGS:
        if tags.get(cle) == valeur:
            return nom
    return None


def lire_osm():
    bbox = overpass.BBOX
    requete = REQUETE % (bbox * 6)
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
        })
    print(f"  {len(lieux)} lieux OSM, dont "
          f"{sum(1 for l in lieux if l['horaires'])} avec horaires, "
          f"{sum(1 for l in lieux if l['site'])} avec site web")
    for (_, _), cat in CATEGORIE_PAR_TAGS:
        n = sum(1 for l in lieux if l["categorie"] == cat)
        print(f"    {cat} : {n}")
    return lieux


def main():
    print("OpenStreetMap :")
    lieux = lire_osm()
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
