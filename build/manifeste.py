#!/usr/bin/env python3
"""Liste les fichiers de l'app shell à pré-cacher par le service worker.

769 fichiers de glyphes rendent une liste écrite à la main impraticable et
fragile (un fichier oublié = mode hors ligne cassé). Ce script énumère les
dossiers concernés et écrit `data/precache.json`, que `sw.js` lit à
l'installation. `tiles.pmtiles` en est volontairement exclu : trop gros
pour un pré-cache automatique, il est proposé en téléchargement à part
(bouton « Installer la carte hors ligne »)."""
import json
import pathlib

RACINE = pathlib.Path(__file__).resolve().parent.parent

DOSSIERS = ["lib", "assets/glyphs", "assets/sprites", "icons", "img/musees"]
FICHIERS_RACINE = [
    "index.html",
    "style.css",
    "manifest.webmanifest",
    "app.js",
    "reseau.js",
    "itineraires.js",
    "musees.js",
    "poi.js",
    "transports.js",
    "pwa.js",
]
FICHIERS_DATA = [
    "data/rues.json",
    "data/reseau.json",
    "data/courses.json",
    "data/cts-traces.geojson",
    "data/cts-tarifs.json",
    "data/musees.json",
    "data/version.json",
]


def lister():
    chemins = []
    for rel in FICHIERS_RACINE + FICHIERS_DATA:
        if (RACINE / rel).is_file():
            chemins.append(rel)
        else:
            print("! absent, ignoré :", rel)

    for dossier in DOSSIERS:
        base = RACINE / dossier
        if not base.is_dir():
            print("! dossier absent, ignoré :", dossier)
            continue
        for chemin in sorted(base.rglob("*")):
            if chemin.is_file():
                chemins.append(chemin.relative_to(RACINE).as_posix())

    return chemins


def main():
    chemins = lister()

    version = json.loads((RACINE / "data" / "version.json").read_text(encoding="utf-8"))

    sortie = {
        "build": version["build"],
        "fichiers": chemins,
    }
    (RACINE / "data" / "precache.json").write_text(
        json.dumps(sortie, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{len(chemins)} fichiers listés dans data/precache.json (build {version['build']})")


if __name__ == "__main__":
    main()
