# -*- coding: utf-8 -*-
"""Tracés des lignes CTS depuis les relations OpenStreetMap.

Le GTFS de la CTS ne fournit pas shapes.txt : la géométrie des lignes est donc
reconstruite depuis les relations `type=route` d'OSM (opérateur CTS), qui
suivent les voies réelles — nettement plus juste qu'une ligne droite entre
arrêts, en particulier pour le tram.

Traitement : assemblage des tronçons bout à bout, simplification
Douglas-Peucker, puis élimination des variantes redondantes (les deux sens
d'une même ligne se superposent) tout en conservant les antennes.

Produit data/cts-traces.geojson.

Usage : python build/traces.py
"""
import json
import math
import sys
from pathlib import Path

import overpass

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"

TOL_RACCORD_M = 30      # écart maximal entre deux tronçons jugés contigus
TOL_SIMPLIF_M = 3       # tolérance Douglas-Peucker (~3 px au zoom 17)
TOL_DOUBLON_M = 20      # distance en deçà de laquelle un point est « déjà couvert »
PART_COUVERTE = 0.80    # au-delà, la variante est jugée redondante
LONGUEUR_MIN_M = 400    # on écarte les fragments trop courts

REQUETE = """
[out:json][timeout:600];
rel[type=route][route=%s][operator~"Transports Strasbourgeois"](%f,%f,%f,%f);
out geom;
"""


# ------------------------------------------------------------- géométrie de base

def metres(a, b):
    """Distance approchée en mètres entre deux (lon, lat) à la latitude de Strasbourg."""
    return math.hypot((a[0] - b[0]) * 74000.0, (a[1] - b[1]) * 111200.0)


def assembler(troncons):
    """Raccorde des tronçons (listes de (lon, lat)) en polylignes continues."""
    polylignes = []
    courant = None
    premier = True
    for tr in troncons:
        if len(tr) < 2:
            continue
        if courant is None:
            courant, premier = list(tr), True
            continue
        if metres(courant[-1], tr[0]) <= TOL_RACCORD_M:
            courant.extend(tr[1:])
        elif metres(courant[-1], tr[-1]) <= TOL_RACCORD_M:
            courant.extend(reversed(tr[:-1]))
        elif premier and metres(courant[0], tr[0]) <= TOL_RACCORD_M:
            # le tout premier tronçon peut être orienté à l'envers
            courant.reverse()
            courant.extend(tr[1:])
        elif premier and metres(courant[0], tr[-1]) <= TOL_RACCORD_M:
            courant.reverse()
            courant.extend(reversed(tr[:-1]))
        else:
            polylignes.append(courant)
            courant = list(tr)
            premier = True
            continue
        premier = False
    if courant:
        polylignes.append(courant)
    return polylignes


def simplifier(points, tolerance=TOL_SIMPLIF_M):
    """Douglas-Peucker itératif (évite la récursion sur les longs tracés)."""
    if len(points) < 3:
        return list(points)
    garder = [False] * len(points)
    garder[0] = garder[-1] = True
    pile = [(0, len(points) - 1)]
    while pile:
        debut, fin = pile.pop()
        a, b = points[debut], points[fin]
        ax, ay = a[0] * 74000.0, a[1] * 111200.0
        bx, by = b[0] * 74000.0, b[1] * 111200.0
        dx, dy = bx - ax, by - ay
        norme = dx * dx + dy * dy
        pire, pire_i = -1.0, -1
        for i in range(debut + 1, fin):
            px, py = points[i][0] * 74000.0, points[i][1] * 111200.0
            if norme == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / norme))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > pire:
                pire, pire_i = d, i
        if pire > tolerance:
            garder[pire_i] = True
            pile.append((debut, pire_i))
            pile.append((pire_i, fin))
    return [p for p, g in zip(points, garder) if g]


def longueur_m(points):
    return sum(metres(points[i], points[i + 1]) for i in range(len(points) - 1))


class Grille:
    """Index spatial sommaire, pour tester si un point est déjà couvert."""

    def __init__(self, pas_m=TOL_DOUBLON_M):
        self.pas_lon = pas_m / 74000.0
        self.pas_lat = pas_m / 111200.0
        self.cases = set()

    def _case(self, p):
        return (int(p[0] / self.pas_lon), int(p[1] / self.pas_lat))

    def ajouter(self, points):
        # on densifie pour ne pas laisser de trous entre deux sommets éloignés
        for i in range(len(points) - 1):
            a, b = points[i], points[i + 1]
            n = max(1, int(metres(a, b) / (TOL_DOUBLON_M / 2)))
            for k in range(n + 1):
                t = k / n
                self.cases.add(self._case((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)))

    def couvert(self, p):
        cx, cy = self._case(p)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if (cx + dx, cy + dy) in self.cases:
                    return True
        return False


# ------------------------------------------------------------------- programme

def recuperer(mode):
    """Relations OSM du mode donné, en passant par un cache local.

    Les réponses Overpass pèsent quelques Mo et le service est souvent
    saturé : on évite de le réinterroger quand on ne fait que réajuster
    les paramètres de simplification.
    """
    cache = Path(__file__).resolve().parent / "cache" / f"osm-{mode}.json"
    if cache.exists():
        print(f"Relations {mode} : cache {cache.name}")
        return json.loads(cache.read_text(encoding="utf-8"))["elements"]

    requete = REQUETE % ((mode,) + overpass.BBOX)
    print(f"Relations {mode} :")
    data = overpass.interroger(requete, timeout=600)
    print(f"  {len(data['elements'])} relations reçues")
    cache.parent.mkdir(exist_ok=True)
    cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data["elements"]


def couleurs_gtfs():
    """nom de ligne -> (couleur, type) d'après cts-reseau.json."""
    chemin = DATA / "cts-reseau.json"
    if not chemin.exists():
        print("  (cts-reseau.json absent : couleurs par défaut)")
        return {}
    reseau = json.loads(chemin.read_text(encoding="utf-8"))
    return {l["nom"]: (l["couleur"], l["type"]) for l in reseau["lignes"]}


def main():
    couleurs = couleurs_gtfs()
    relations = []
    for mode in ("tram", "bus"):
        relations.extend((mode, r) for r in recuperer(mode))

    # regroupement par indicatif de ligne
    par_ref = {}
    for mode, rel in relations:
        ref = (rel.get("tags", {}).get("ref") or "").strip()
        if not ref:
            continue
        troncons = [
            [(p["lon"], p["lat"]) for p in m["geometry"]]
            for m in rel.get("members", [])
            if m["type"] == "way" and m.get("role", "") == "" and m.get("geometry")
        ]
        if not troncons:
            continue
        for poly in assembler(troncons):
            poly = simplifier(poly)
            if longueur_m(poly) >= LONGUEUR_MIN_M:
                par_ref.setdefault(ref, {"mode": mode, "variantes": []})["variantes"].append(poly)

    # élimination des variantes redondantes, les plus longues d'abord
    traces = []
    for ref in sorted(par_ref, key=lambda r: (len(r), r)):
        infos = par_ref[ref]
        grille = Grille()
        gardees = 0
        for poly in sorted(infos["variantes"], key=longueur_m, reverse=True):
            couverts = sum(1 for p in poly if grille.couvert(p))
            if gardees and couverts / len(poly) > PART_COUVERTE:
                continue
            grille.ajouter(poly)
            gardees += 1
            couleur, type_gtfs = couleurs.get(ref, ("#666666", 3 if infos["mode"] == "bus" else 0))
            traces.append({
                "type": "Feature",
                "properties": {
                    "ref": ref,
                    "mode": "tram" if type_gtfs == 0 else "bus",
                    "couleur": couleur,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[round(x, 5), round(y, 5)] for x, y in poly],
                },
            })
        print(f"  {ref:>10} : {gardees}/{len(infos['variantes'])} variantes conservées")

    inconnues = sorted(r for r in par_ref if r not in couleurs)
    if inconnues:
        print(f"Indicatifs OSM absents du GTFS (conservés, couleur par défaut) : {inconnues}")

    geojson = {"type": "FeatureCollection", "features": traces}
    chemin = DATA / "cts-traces.geojson"
    chemin.write_text(
        json.dumps(geojson, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    points = sum(len(t["geometry"]["coordinates"]) for t in traces)
    print(f"\n{len(traces)} tracés, {points} points -> {chemin.name} "
          f"({chemin.stat().st_size / 1e6:.2f} Mo)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
