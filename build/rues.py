# -*- coding: utf-8 -*-
"""Construit data/rues.json : index de recherche des rues et localités.

Interroge Overpass sur la bbox de l'Eurométropole (+ Kehl), regroupe les
tronçons portant le même nom en « rues » distinctes par commune approchée
(clustering ~1,5 km), et produit un JSON compact :
    [[nom, lat, lon, type], ...]   type: "rue" | "lieu"
"""
import json
import math
import urllib.request
from pathlib import Path

BBOX = "48.40,7.50,48.70,7.92"  # sud, ouest, nord, est
MIROIRS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
OUT = Path(__file__).resolve().parent.parent / "data" / "rues.json"

QUERY = f"""
[out:json][timeout:180];
(
  way["highway"]["name"]({BBOX});
  node["place"~"^(city|town|village|suburb|neighbourhood|quarter)$"]["name"]({BBOX});
);
out tags center;
"""


def fetch():
    derniere_erreur = None
    for url in MIROIRS:
        req = urllib.request.Request(
            url,
            data=("data=" + urllib.parse.quote(QUERY)).encode(),
            headers={"User-Agent": "strasbourg-eurometropole-build/1.0"},
        )
        try:
            print(f"Interrogation de {url} ...")
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)
        except Exception as e:  # 504, timeout... on passe au miroir suivant
            derniere_erreur = e
            print(f"  échec : {e}")
    raise derniere_erreur


def dist_km(a, b):
    dx = (a[1] - b[1]) * 74.0  # ~km par degré de longitude à 48,5° N
    dy = (a[0] - b[0]) * 111.2
    return math.hypot(dx, dy)


def cluster(points, seuil_km=1.5):
    """Regroupe les centres de tronçons homonymes en rues distinctes."""
    groupes = []
    for p in points:
        for g in groupes:
            if dist_km(p, g["centre"]) < seuil_km:
                g["pts"].append(p)
                n = len(g["pts"])
                g["centre"] = (
                    sum(q[0] for q in g["pts"]) / n,
                    sum(q[1] for q in g["pts"]) / n,
                )
                break
        else:
            groupes.append({"pts": [p], "centre": p})
    return [g["centre"] for g in groupes]


def main():
    data = fetch()
    rues = {}
    lieux = []
    for el in data["elements"]:
        nom = el["tags"].get("name", "").strip()
        if not nom:
            continue
        if el["type"] == "node":
            lieux.append((nom, round(el["lat"], 5), round(el["lon"], 5)))
        else:
            c = el.get("center")
            if c:
                rues.setdefault(nom, []).append((c["lat"], c["lon"]))

    def lieu_proche(lat, lon):
        """Nom de la localité la plus proche (pour distinguer les homonymes)."""
        meilleur, d_min = "", 1e9
        for nom, la, lo in lieux:
            d = dist_km((lat, lon), (la, lo))
            if d < d_min:
                meilleur, d_min = nom, d
        return meilleur

    entries = []
    for nom, pts in rues.items():
        for lat, lon in cluster(pts):
            entries.append(
                [nom, round(lat, 5), round(lon, 5), "rue", lieu_proche(lat, lon)]
            )
    for nom, lat, lon in lieux:
        entries.append([nom, lat, lon, "lieu"])

    entries.sort(key=lambda e: e[0].lower())
    OUT.write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"{len(rues)} noms de rues, {len(entries)} entrées -> {OUT}")


if __name__ == "__main__":
    main()
