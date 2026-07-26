# -*- coding: utf-8 -*-
"""Accès mutualisé à l'API Overpass, avec bascule automatique entre miroirs.

Le miroir principal renvoie souvent 504 aux heures chargées ; on réessaie
sur les miroirs suivants avant d'abandonner.
"""
import json
import time
import urllib.parse
import urllib.request

MIROIRS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# Sud, ouest, nord, est. Cale sur l'emprise des tuiles (data/tiles.pmtiles) :
# tout ce que l'application référence doit être visible sur le fond de carte.
BBOX = (48.40, 7.50, 48.70, 7.92)


def interroger(requete, essais_par_miroir=2, timeout=300):
    """Exécute une requête Overpass QL et renvoie le JSON décodé."""
    derniere = None
    for url in MIROIRS:
        for essai in range(essais_par_miroir):
            try:
                print(f"  Overpass : {url} (essai {essai + 1})")
                req = urllib.request.Request(
                    url,
                    data=("data=" + urllib.parse.quote(requete)).encode(),
                    headers={"User-Agent": "strasbourg-eurometropole-build/1.0"},
                )
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.load(r)
            except Exception as e:
                derniere = e
                print(f"    échec : {e}")
                time.sleep(3)
    raise RuntimeError(f"tous les miroirs Overpass ont échoué : {derniere}")
