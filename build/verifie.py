# -*- coding: utf-8 -*-
"""Contrôles de cohérence des données produites dans data/.

Vérifie la structure des fichiers, la validité des index croisés, le décodage
complet des motifs de desserte, la couverture calendaire (aucun jour sans
desserte) et la vraisemblance géographique. En prime, recompte les arrêts et
les connexions redécodés et les compare aux totaux du GTFS source : c'est le
contrôle le plus parlant sur l'absence de perte à l'encodage.

Sort en code 1 si une anomalie bloquante est détectée.

Usage : python build/verifie.py
"""
import collections
import datetime as dt
import json
import math
import sys
import zipfile
from pathlib import Path

import codec

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"
CACHE = Path(__file__).resolve().parent / "cache"
BBOX = (48.40, 7.50, 48.70, 7.92)  # sud, ouest, nord, est — emprise des tuiles

anomalies = []
avertissements = []


def erreur(msg):
    anomalies.append(msg)
    print("  ANOMALIE  " + msg)


def alerte(msg):
    avertissements.append(msg)
    print("  attention " + msg)


def charger(nom):
    chemin = DATA / nom
    if not chemin.exists():
        erreur(f"{nom} absent")
        return None
    return json.loads(chemin.read_text(encoding="utf-8"))


def dates_service(texte, origine):
    """Écarts en jours encodés -> ensemble de dates AAAAMMJJ."""
    if not texte:
        return set()
    base = dt.date(int(origine[:4]), int(origine[4:6]), int(origine[6:]))
    return {
        (base + dt.timedelta(days=e)).strftime("%Y%m%d")
        for e in codec.decoder_suite(texte)
    }


def prepare_services(brut):
    """Décode une fois pour toutes les calendriers du fichier courses.json."""
    services = []
    for s in brut:
        services.append({
            "jours": s[0], "debut": s[1], "fin": s[2],
            "plus": dates_service(s[3], s[1]), "sauf": dates_service(s[4], s[1]),
        })
    return services


def service_actif(service, date):
    """Reproduit la logique GTFS : calendar.txt + exceptions calendar_dates."""
    iso = date.strftime("%Y%m%d")
    if iso in service["sauf"]:
        return False
    if iso in service["plus"]:
        return True
    if not (service["debut"] <= iso <= service["fin"]):
        return False
    return bool(service["jours"] & (1 << date.weekday()))


def decoder_motifs(cours, nb_stations, nb_lignes, nb_destinations, nb_services):
    """Décode les motifs et contrôle la validité de chaque champ."""
    motifs = []
    for i, m in enumerate(cours["motifs"]):
        if not (0 <= m["l"] < nb_lignes):
            erreur(f"motif {i} : index de ligne invalide {m['l']}")
            return None
        if not (0 <= m["d"] < nb_destinations):
            erreur(f"motif {i} : index de destination invalide {m['d']}")
            return None

        stations = codec.decoder_entiers(m["s"])
        # un motif d'une seule station n'est légitime que s'il est tronqué au
        # périmètre : le train ne fait que desservir cette gare avant de partir
        if len(stations) < 1 or (len(stations) == 1 and not m.get("f")):
            erreur(f"motif {i} : {len(stations)} station(s) sans troncature")
            return None
        if any(not (0 <= s < nb_stations) for s in stations):
            erreur(f"motif {i} : index de station hors bornes")
            return None

        profils = [codec.decoder_suite(p) for p in m["p"]]
        for j, p in enumerate(profils):
            if len(p) != len(stations):
                erreur(f"motif {i} profil {j} : {len(p)} écarts pour "
                       f"{len(stations)} stations")
                return None
            if p[0] != 0:
                erreur(f"motif {i} profil {j} : ne commence pas à 0 ({p[0]})")
                return None
            if any(p[k + 1] < p[k] for k in range(len(p) - 1)):
                erreur(f"motif {i} profil {j} : écarts non croissants")
                return None

        attentes = {}
        for t in m.get("w", []):
            if not (0 <= t[0] < len(profils)) or not (0 <= t[1] < len(stations)):
                erreur(f"motif {i} : attente hors bornes {t}")
                return None
            attentes[(t[0], t[1])] = t[2]

        courses = []
        for c in m["c"]:
            svc, bases_txt, profils_txt = c
            if not (0 <= svc < nb_services):
                erreur(f"motif {i} : index de calendrier invalide {svc}")
                return None
            bases = codec.decoder_suite(bases_txt)
            idx_profils = codec.decoder_entiers(profils_txt)
            if len(bases) != len(idx_profils):
                erreur(f"motif {i} : {len(bases)} heures pour "
                       f"{len(idx_profils)} profils")
                return None
            if any(not (0 <= p < len(profils)) for p in idx_profils):
                erreur(f"motif {i} : index de profil hors bornes")
                return None
            if any(b < 0 or b > 30 * 60 for b in bases):
                erreur(f"motif {i} : heure de base hors bornes")
                return None
            courses.append((svc, bases, idx_profils))

        motifs.append({
            "ligne": m["l"], "dest": m["d"], "stations": stations,
            "profils": profils, "attentes": attentes, "courses": courses,
            "tronque": bool(m.get("f")),
        })
    return motifs


def main():
    print("== Réseau ==")
    reseau = charger("reseau.json")
    cours = charger("courses.json")
    if not reseau or not cours:
        return 1

    lignes, stations = reseau["lignes"], reseau["stations"]
    destinations = reseau["destinations"]
    services = prepare_services(cours["services"])
    par_agence = collections.Counter(l.get("agence", "?") for l in lignes)
    gares = [s for s in stations if len(s) > 5 and s[5] == "SNCF"]
    print(f"  {len(lignes)} lignes ({dict(par_agence)}), {len(stations)} stations "
          f"dont {len(gares)} gares, {len(services)} calendriers, "
          f"{len(cours['motifs'])} motifs")

    refs_tram = sorted(l["nom"] for l in lignes
                       if l["type"] == 0 and l.get("agence") == "CTS")
    if refs_tram != ["A", "B", "C", "D", "E", "F"]:
        erreur(f"lignes de tram inattendues : {refs_tram}")
    else:
        print(f"  tram : {' '.join(refs_tram)}")
    if not gares:
        alerte("aucune gare : le réseau ferroviaire n'a pas été intégré")

    print("== Stations ==")
    sans_ligne = [s[1] for s in stations if not s[4]]
    if sans_ligne:
        alerte(f"{len(sans_ligne)} station(s) sans ligne : {sans_ligne[:5]}")
    hors_zone = [
        s[1] for s in stations
        if not (BBOX[0] <= s[2] <= BBOX[2] and BBOX[1] <= s[3] <= BBOX[3])
    ]
    if hors_zone:
        erreur(f"{len(hors_zone)} station(s) hors zone : {hors_zone[:5]}")
    else:
        print(f"  {len(stations) - len(sans_ligne)} stations desservies, 0 hors zone")

    print("== Motifs de desserte ==")
    motifs = decoder_motifs(cours, len(stations), len(lignes),
                            len(destinations), len(services))
    if motifs is None:
        return 1
    par_agence = collections.defaultdict(lambda: {"courses": 0, "arrets": 0,
                                                  "connexions": 0, "motifs": 0})
    for m in motifs:
        agence = lignes[m["ligne"]].get("agence", "?")
        stats = par_agence[agence]
        stats["motifs"] += 1
        for _svc, bases, _p in m["courses"]:
            stats["courses"] += len(bases)
            stats["arrets"] += len(bases) * len(m["stations"])
            stats["connexions"] += len(bases) * (len(m["stations"]) - 1)
    for agence, stats in sorted(par_agence.items()):
        print(f"  {agence:5} : {stats['motifs']:4} motifs, {stats['courses']:6} courses, "
              f"{stats['arrets']:7} arrêts, {stats['connexions']:7} connexions")
    nb_profils = sum(len(m["profils"]) for m in motifs)
    tronques = sum(1 for m in motifs if m["tronque"])
    print(f"  {nb_profils} profils horaires, {tronques} motifs tronqués au périmètre")

    # comparaison au GTFS CTS : détecte toute perte à l'encodage. Le flux SNCF
    # étant filtré à la zone, aucun total de référence simple n'existe pour lui.
    gtfs = CACHE / "google_transit.zip"
    if gtfs.exists():
        with zipfile.ZipFile(gtfs) as zf:
            with zf.open("stop_times.txt") as f:
                lignes_gtfs = sum(1 for _ in f) - 1
            with zf.open("trips.txt") as f:
                courses_gtfs = sum(1 for _ in f) - 1
        cts = par_agence.get("CTS", {"arrets": 0, "courses": 0})
        if cts["arrets"] != lignes_gtfs:
            erreur(f"arrêts CTS redécodés {cts['arrets']} != "
                   f"stop_times du GTFS {lignes_gtfs}")
        elif cts["courses"] != courses_gtfs:
            erreur(f"courses CTS redécodées {cts['courses']} != "
                   f"trips du GTFS {courses_gtfs}")
        else:
            print(f"  CTS conforme à sa source ({lignes_gtfs} stop_times, "
                  f"{courses_gtfs} trips) : encodage sans perte")
    else:
        alerte("GTFS CTS absent du cache : comparaison à la source impossible")

    lignes_vues = {m["ligne"] for m in motifs}
    if len(lignes_vues) != len(lignes):
        alerte(f"{len(lignes) - len(lignes_vues)} ligne(s) sans aucune course")

    print("== Correspondances à pied ==")
    liens = cours["correspondances"]
    mauvais = [c for c in liens
               if not (0 <= c[0] < len(stations)) or not (0 <= c[1] < len(stations))]
    if mauvais:
        erreur(f"{len(mauvais)} correspondance(s) avec un index invalide")
    trop_loin = 0
    for a, b, minutes in liens:
        sa, sb = stations[a], stations[b]
        m = math.hypot((sa[3] - sb[3]) * 74000.0, (sa[2] - sb[2]) * 111200.0)
        if m > 400:
            trop_loin += 1
    if trop_loin:
        erreur(f"{trop_loin} correspondance(s) au-delà de 400 m")
    else:
        print(f"  {len(liens)} liens, tous à moins de 400 m, "
              f"{min(c[2] for c in liens)}–{max(c[2] for c in liens)} min de marche")
    isolees = len(stations) - len({c[0] for c in liens} | {c[1] for c in liens})
    print(f"  {isolees} stations sans correspondance à pied voisine")

    print("== Couverture calendaire (30 jours) ==")
    aujourdhui = dt.date.today()
    jours_vides = []
    for delta in range(30):
        jour = aujourdhui + dt.timedelta(days=delta)
        actifs = {i for i, s in enumerate(services) if service_actif(s, jour)}
        passages = sum(
            len(bases) * len(m["stations"])
            for m in motifs for svc, bases, _p in m["courses"] if svc in actifs
        )
        if delta < 8 or passages == 0:
            print(f"  {jour} {['lun','mar','mer','jeu','ven','sam','dim'][jour.weekday()]} : "
                  f"{len(actifs):3} calendriers, {passages:6} passages")
        if passages == 0:
            jours_vides.append(str(jour))
    if jours_vides:
        erreur(f"{len(jours_vides)} jour(s) sans aucune desserte : {jours_vides[:5]}")

    derniere_fin = max(s["fin"] for s in services)
    print(f"  horaires connus jusqu'au {derniere_fin}")
    reste = (dt.date(int(derniere_fin[:4]), int(derniere_fin[4:6]), int(derniere_fin[6:]))
             - aujourdhui).days
    if reste < 21:
        alerte(f"le GTFS n'est valide que {reste} jours encore — régénérer les données")

    print("== Tarifs ==")
    tarifs = charger("cts-tarifs.json")
    if tarifs:
        prix = [p["prix"] for p in tarifs["produits"]]
        print(f"  {len(prix)} produits, de {min(prix):.2f} à {max(prix):.2f} EUR")
        if not any(abs(p - 1.90) < 0.01 for p in prix):
            alerte("aucun titre à 1,90 EUR : la grille tarifaire a peut-être changé")

    print("== Tracés ==")
    traces = DATA / "cts-traces.geojson"
    if traces.exists():
        g = json.loads(traces.read_text(encoding="utf-8"))
        refs = {f["properties"]["ref"] for f in g["features"]}
        # les tracés proviennent des relations OSM de la CTS ; le ferroviaire
        # n'en a pas, c'est voulu
        manquantes = sorted(
            {l["nom"] for l in lignes if l.get("agence") == "CTS"} - refs
        )
        points = sum(len(f["geometry"]["coordinates"]) for f in g["features"])
        print(f"  {len(g['features'])} tracés, {points} points, "
              f"{traces.stat().st_size / 1e6:.2f} Mo")
        if manquantes:
            alerte(f"{len(manquantes)} ligne(s) sans tracé : {manquantes}")
    else:
        alerte("cts-traces.geojson absent (lancer build/traces.py)")

    print()
    print(f"Bilan : {len(anomalies)} anomalie(s), {len(avertissements)} avertissement(s)")
    return 1 if anomalies else 0


if __name__ == "__main__":
    sys.exit(main())
