# -*- coding: utf-8 -*-
"""GTFS CTS + SNCF -> JSON compacts pour la consultation hors ligne.

Produit dans data/ :
  reseau.json     lignes, stations (arrêts CTS et gares), parcours
  courses.json    motifs de desserte, profils horaires, courses, calendriers
                  et correspondances à pied
  cts-tarifs.json grille tarifaire CTS (GTFS-Fares v2)

Usage : python build/reseau.py [--sans-ter]

Modèle de données. Plutôt que la liste brute des connexions (891 641 pour la
seule CTS), on stocke les « motifs de desserte » — une ligne, une destination,
une séquence de stations — et, par motif, les quelques profils horaires
distincts (écarts en minutes depuis le premier arrêt). Une course se réduit
alors à un triplet calendrier / heure de départ / profil. Le fichier sert aussi
bien à afficher les prochains passages qu'à calculer un itinéraire (algorithme
CSA côté client).

Les deux réseaux vivent dans le même jeu de données : le moteur d'itinéraires
enchaîne donc tram, bus et train sans traitement particulier. Les gares ne sont
pas fusionnées avec les arrêts CTS voisins (les noms diffèrent : « Strasbourg »
côté SNCF, « Gare Centrale » côté CTS) ; ce sont les correspondances à pied,
calculées sur l'ensemble, qui les relient.

Le GTFS CTS ne contient pas shapes.txt : les tracés des lignes sont produits
séparément par build/traces.py depuis les relations OpenStreetMap.
"""
import argparse
import csv
import datetime as dt
import io
import json
import math
import sys
import unicodedata
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import codec

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"
CACHE = Path(__file__).resolve().parent / "cache"

URL_CTS = "https://opendata.cts-strasbourg.eu/google_transit.zip"
URL_SNCF = "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip"

# Zone retenue pour les gares (sud, ouest, nord, est). Identique à l'emprise
# des tuiles : une gare hors carte n'aurait aucun sens à l'écran. Les gares
# écartées restent nommées comme destinations de train (Obernai, Sélestat…).
BBOX = (48.40, 7.50, 48.70, 7.92)

FUSION_KM = 0.4          # arrêts homonymes plus proches -> une seule station
SEUIL_PARCOURS = 0.05    # part des courses d'une ligne pour afficher un parcours
CORRESPONDANCE_M = 400   # distance maximale d'une correspondance à pied
DETOUR = 1.3             # les rues ne vont pas en ligne droite
VITESSE_M_MIN = 75.0     # 4,5 km/h


# ---------------------------------------------------------------- utilitaires

def normaliser(nom):
    sans_accent = "".join(
        c for c in unicodedata.normalize("NFD", nom) if unicodedata.category(c) != "Mn"
    )
    return " ".join(sans_accent.lower().split())


def dist_km(a, b):
    return math.hypot((a[1] - b[1]) * 74.0, (a[0] - b[0]) * 111.2)


def minutes_depuis_minuit(hhmmss):
    """« 05:35:00 » -> 335 ; « 25:30:00 » -> 1530 (courses après minuit)."""
    if not hhmmss:
        return None
    parties = hhmmss.strip().split(":")
    if len(parties) < 2 or not parties[0]:
        return None
    return int(parties[0]) * 60 + int(parties[1])


def lire_csv(zf, nom):
    with zf.open(nom) as f:
        texte = io.TextIOWrapper(f, encoding="utf-8-sig", newline="")
        for ligne in csv.DictReader(texte):
            yield ligne


def telecharger(url, nom):
    CACHE.mkdir(exist_ok=True)
    cible = CACHE / nom
    if cible.exists():
        print(f"  en cache : {cible.name}")
        return cible
    print(f"  téléchargement de {url}")
    with urllib.request.urlopen(url, timeout=600) as r, open(cible, "wb") as f:
        f.write(r.read())
    print(f"  {cible.name} : {cible.stat().st_size / 1e6:.1f} Mo")
    return cible


def dans_zone(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


# ------------------------------------------------------------------ calendrier

def lire_services(zf, prefixe):
    """service_id préfixé -> {jours (bitmask lundi=1), debut, fin, plus[], sauf[]}.

    Les deux réseaux n'emploient pas les mêmes mécanismes : la CTS s'appuie sur
    calendar.txt (jours de circulation + exceptions), la SNCF uniquement sur
    calendar_dates.txt (liste explicite de dates). Le format de sortie couvre
    les deux cas.
    """
    services = {}
    try:
        for r in lire_csv(zf, "calendar.txt"):
            masque = 0
            for i, jour in enumerate(
                ("monday", "tuesday", "wednesday", "thursday", "friday",
                 "saturday", "sunday")
            ):
                if r[jour] == "1":
                    masque |= 1 << i
            services[prefixe + r["service_id"]] = {
                "jours": masque, "debut": r["start_date"], "fin": r["end_date"],
                "plus": [], "sauf": [],
            }
    except KeyError:
        pass  # flux sans calendar.txt (cas de la SNCF)

    try:
        exceptions = list(lire_csv(zf, "calendar_dates.txt"))
    except KeyError:
        exceptions = []
    for r in exceptions:
        sid = prefixe + r["service_id"]
        s = services.setdefault(
            sid, {"jours": 0, "debut": "99999999", "fin": "00000000",
                  "plus": [], "sauf": []}
        )
        (s["plus"] if r["exception_type"] == "1" else s["sauf"]).append(r["date"])
        if r["exception_type"] == "1":
            s["debut"] = min(s["debut"], r["date"])
            s["fin"] = max(s["fin"], r["date"])
    return services


def encoder_dates(dates, origine):
    """Dates AAAAMMJJ -> écarts en jours depuis `origine`, en varint.

    Les 21 786 dates de circulation de la SNCF pèseraient près de 300 Ko en
    clair ; encodées en écarts, elles tiennent en quelques dizaines de Ko.
    """
    if not dates:
        return ""
    base = dt.date(int(origine[:4]), int(origine[4:6]), int(origine[6:]))
    ecarts = []
    for d in sorted(set(dates)):
        jour = dt.date(int(d[:4]), int(d[4:6]), int(d[6:]))
        ecart = (jour - base).days
        if ecart >= 0:
            ecarts.append(ecart)
    return codec.encoder_suite(ecarts)


# --------------------------------------------------------- lecture d'un réseau

def lire_gtfs(zf, prefixe, agence, filtrer_zone, couleur_defaut):
    """Lit un flux GTFS et renvoie stations, lignes, calendriers et motifs.

    Tout est manipulé par identifiants textuels ; l'indexation n'a lieu qu'à
    l'assemblage final, quand les deux réseaux sont réunis.

    filtrer_zone : ne conserver que les arrêts de la zone (indispensable pour la
    SNCF, dont le flux est national). Les courses sont alors tronquées ; on
    retient le terminus réel pour pouvoir annoncer la destination.
    """
    arrets = {}          # stop_id de stop_times -> clé de station
    stations = {}        # clé -> {nom, lat, lon}
    noms_globaux = {}    # stop_id -> nom, pour retrouver un terminus hors zone

    brut = list(lire_csv(zf, "stops.txt"))
    for r in brut:
        noms_globaux[r["stop_id"]] = r["stop_name"].strip()

    if brut and "location_type" in brut[0]:
        # flux structuré en StopArea / StopPoint (SNCF)
        zones = {}
        for r in brut:
            if r["location_type"] == "1":
                try:
                    lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
                except ValueError:
                    continue
                if filtrer_zone and not dans_zone(lat, lon):
                    continue
                zones[r["stop_id"]] = {"nom": r["stop_name"].strip(),
                                       "lat": lat, "lon": lon}
        for r in brut:
            if r["location_type"] != "1":
                p = r.get("parent_station") or ""
                if p in zones:
                    arrets[r["stop_id"]] = prefixe + p
        for sid in zones:
            arrets.setdefault(sid, prefixe + sid)
            stations[prefixe + sid] = zones[sid]
    else:
        # flux plat (CTS) : le préfixe de l'identifiant désigne la station
        par_prefixe = defaultdict(list)
        for r in brut:
            try:
                lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
            except ValueError:
                continue
            if filtrer_zone and not dans_zone(lat, lon):
                continue
            par_prefixe[r["stop_id"].rsplit("_", 1)[0]].append(
                {"id": r["stop_id"], "nom": r["stop_name"].strip(),
                 "lat": lat, "lon": lon}
            )
        prelim = []
        for pref, membres in par_prefixe.items():
            nom = Counter(m["nom"] for m in membres).most_common(1)[0][0]
            prelim.append({
                "pref": pref, "nom": nom, "cle": normaliser(nom),
                "lat": sum(m["lat"] for m in membres) / len(membres),
                "lon": sum(m["lon"] for m in membres) / len(membres),
                "membres": [m["id"] for m in membres],
            })
        par_cle = defaultdict(list)
        for p in prelim:
            par_cle[p["cle"]].append(p)
        # fusion des préfixes homonymes proches (tram + bus, ex. Baggersee)
        for groupe in par_cle.values():
            paquets = []
            for p in groupe:
                for paquet in paquets:
                    if dist_km((p["lat"], p["lon"]),
                               (paquet[0]["lat"], paquet[0]["lon"])) < FUSION_KM:
                        paquet.append(p)
                        break
                else:
                    paquets.append([p])
            for paquet in paquets:
                total = sum(len(x["membres"]) for x in paquet)
                principal = max(paquet, key=lambda x: len(x["membres"]))
                cle = prefixe + principal["pref"]
                stations[cle] = {
                    "nom": principal["nom"],
                    "lat": sum(x["lat"] * len(x["membres"]) for x in paquet) / total,
                    "lon": sum(x["lon"] * len(x["membres"]) for x in paquet) / total,
                }
                for x in paquet:
                    for m in x["membres"]:
                        arrets[m] = cle

    # --- lignes
    lignes = {}
    for r in lire_csv(zf, "routes.txt"):
        lignes[prefixe + r["route_id"]] = {
            "nom": (r["route_short_name"] or "").strip() or "?",
            "desc": (r["route_long_name"] or "").strip().strip('"'),
            "type": int(r["route_type"]),
            "couleur": "#" + ((r.get("route_color") or "").strip() or couleur_defaut),
            "texte": "#" + ((r.get("route_text_color") or "").strip() or "FFFFFF"),
            "agence": agence,
        }

    services = lire_services(zf, prefixe)

    infos = {}
    for r in lire_csv(zf, "trips.txt"):
        infos[r["trip_id"]] = (prefixe + r["route_id"], prefixe + r["service_id"])

    # --- stop_times en flux : le fichier pèse jusqu'à 70 Mo
    motifs = defaultdict(list)
    etapes = []
    # vrai quand des arrêts hors zone suivent le dernier arrêt conservé : la
    # course se poursuit alors au-delà du périmètre. À ne pas confondre avec un
    # simple trou au milieu du parcours (un train peut desservir Hochfelden
    # entre deux gares de la zone) : le voyageur reste à bord, les horaires
    # conservés restent justes, et le dernier arrêt reste un terminus.
    suite_hors_zone = False
    terminus = ""
    courante = None
    vues = set()
    lus = 0

    def clore():
        if courante is None or not etapes:
            return
        # une course qui ne fait que terminer son parcours dans la zone n'offre
        # ni départ ni connexion : elle n'a rien à apprendre à l'utilisateur
        if len(etapes) < 2 and not suite_hors_zone:
            return
        etapes.sort()
        ligne, service = infos[courante]
        stations_course = tuple(e[1] for e in etapes)
        base = etapes[0][2]
        offsets = tuple(e[2] - base for e in etapes)
        attentes = tuple(e[2] - e[3] for e in etapes)
        cle = (ligne, terminus, stations_course, 1 if suite_hors_zone else 0)
        motifs[cle].append((service, base, offsets, attentes))

    for r in lire_csv(zf, "stop_times.txt"):
        lus += 1
        if lus % 250000 == 0:
            print(f"    stop_times : {lus} lignes lues…")
        tid = r["trip_id"]
        if tid not in infos:
            continue
        if tid != courante:
            clore()
            if tid in vues:
                raise SystemExit(f"stop_times.txt n'est pas groupé par course ({tid})")
            vues.add(tid)
            courante, etapes = tid, []
            suite_hors_zone = False
            terminus = ""
        # le terminus est le dernier arrêt de la course, dans la zone ou non
        terminus = noms_globaux.get(r["stop_id"], terminus)
        cle_station = arrets.get(r["stop_id"])
        if cle_station is None:
            if etapes:
                suite_hors_zone = True
            continue
        depart = minutes_depuis_minuit(r["departure_time"] or r["arrival_time"])
        arrivee = minutes_depuis_minuit(r["arrival_time"] or r["departure_time"])
        if depart is None:
            continue
        etapes.append((int(r["stop_sequence"]), cle_station, depart, arrivee))
        suite_hors_zone = False   # un arrêt conservé referme la troncature
    clore()
    print(f"    stop_times : {lus} lignes")

    return {"stations": stations, "lignes": lignes, "services": services,
            "motifs": motifs, "agence": agence}


# ----------------------------------------------------------------- assemblage

def correspondances_a_pied(stations):
    liens = []
    for i in range(len(stations)):
        for j in range(i + 1, len(stations)):
            a, b = stations[i], stations[j]
            m = math.hypot((a["lon"] - b["lon"]) * 74000.0,
                           (a["lat"] - b["lat"]) * 111200.0)
            if m <= CORRESPONDANCE_M:
                liens.append([i, j, max(1, round(m * DETOUR / VITESSE_M_MIN))])
    return liens


def assembler(reseaux):
    """Réunit les réseaux lus et attribue les index définitifs."""
    stations = []
    for r in reseaux:
        for cle, s in r["stations"].items():
            stations.append({
                "cle": cle, "nom": s["nom"],
                "lat": round(s["lat"], 5), "lon": round(s["lon"], 5),
                "agence": r["agence"],
            })
    stations.sort(key=lambda s: (normaliser(s["nom"]), s["cle"]))
    idx_station = {s["cle"]: i for i, s in enumerate(stations)}

    # lignes : seules celles réellement desservies dans la zone
    utilisees = set()
    for r in reseaux:
        for (ligne, _d, _s, _t) in r["motifs"]:
            utilisees.add(ligne)
    lignes = []
    idx_ligne = {}
    for r in reseaux:
        for cle, l in sorted(r["lignes"].items()):
            if cle in utilisees:
                idx_ligne[cle] = len(lignes)
                lignes.append(dict(l))

    # calendriers : le flux SNCF étant national, il en contient des milliers
    # dont la quasi-totalité ne concerne aucune course retenue.
    tous = {}
    for r in reseaux:
        tous.update(r["services"])
    references = set()
    for r in reseaux:
        for courses in r["motifs"].values():
            for svc, _base, _o, _a in courses:
                references.add(svc)
    services = {sid: s for sid, s in tous.items() if sid in references}
    print(f"  calendriers : {len(services)} retenus sur {len(tous)}")
    ordre_services = sorted(services)
    idx_service = {sid: i for i, sid in enumerate(ordre_services)}

    destinations = []
    idx_destination = {}

    def cle_dest(nom):
        if nom not in idx_destination:
            idx_destination[nom] = len(destinations)
            destinations.append(nom)
        return idx_destination[nom]

    motifs_sortie = []
    poids = defaultdict(Counter)
    lignes_par_station = defaultdict(set)
    courses_par_ligne = Counter()
    total_courses = total_profils = total_arrets = 0

    for r in reseaux:
        for (ligne, dest, stations_course, tronque), courses in sorted(
            r["motifs"].items(), key=lambda kv: (idx_ligne[kv[0][0]], kv[0][1])
        ):
            il = idx_ligne[ligne]
            idd = cle_dest(dest)
            suite = [idx_station[c] for c in stations_course]
            for st in suite:
                lignes_par_station[st].add(il)
            courses_par_ligne[il] += len(courses)
            poids[(il, idd)][tuple(suite)] += len(courses)

            profils = {}
            for _svc, _base, offsets, attentes in courses:
                profils.setdefault((offsets, attentes), len(profils))
            total_profils += len(profils)

            par_service = defaultdict(list)
            for svc, base, offsets, attentes in courses:
                par_service[idx_service[svc]].append((base, profils[(offsets, attentes)]))
            listes = []
            for svc in sorted(par_service):
                paires = sorted(par_service[svc])
                listes.append([
                    svc,
                    codec.encoder_suite([p[0] for p in paires]),
                    "".join(codec.encoder_entier(p[1]) for p in paires),
                ])
                total_courses += len(paires)
                total_arrets += len(paires) * len(suite)

            ordre = sorted(profils, key=lambda k: profils[k])
            motif = {
                "l": il, "d": idd,
                "s": "".join(codec.encoder_entier(v) for v in suite),
                "p": [codec.encoder_suite(offsets) for offsets, _ in ordre],
                "c": listes,
            }
            attentes_eparses = []
            for i, (_offsets, att) in enumerate(ordre):
                for position, valeur in enumerate(att):
                    if valeur:
                        attentes_eparses.append([i, position, valeur])
            if attentes_eparses:
                motif["w"] = attentes_eparses
            if tronque:
                # la course poursuit hors zone : son dernier arrêt connu est
                # bien un départ, il doit figurer dans les prochains passages
                motif["f"] = 1
            motifs_sortie.append(motif)

    # parcours représentatifs (affichage « détail de la ligne »)
    parcours = defaultdict(list)
    for (il, idd), compteur in poids.items():
        if sum(compteur.values()) / (courses_par_ligne[il] or 1) < SEUIL_PARCOURS:
            continue
        meilleure = max(compteur.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
        propre = [s for i, s in enumerate(meilleure) if i == 0 or s != meilleure[i - 1]]
        if len(propre) > 1:
            parcours[il].append([idd, propre])
    for il in parcours:
        parcours[il].sort(key=lambda x: -len(x[1]))
    for i, l in enumerate(lignes):
        l["parcours"] = parcours.get(i, [])

    liens = correspondances_a_pied(stations)

    reseau = {
        "lignes": lignes,
        "destinations": destinations,
        "stations": [
            [s["cle"], s["nom"], s["lat"], s["lon"],
             sorted(lignes_par_station[i]), s["agence"]]
            for i, s in enumerate(stations)
        ],
    }
    cours = {
        "services": [
            [services[sid]["jours"], services[sid]["debut"], services[sid]["fin"],
             encoder_dates(services[sid]["plus"], services[sid]["debut"]),
             encoder_dates(services[sid]["sauf"], services[sid]["debut"])]
            for sid in ordre_services
        ],
        "motifs": motifs_sortie,
        "correspondances": liens,
        "marche": {"vitesse_m_min": VITESSE_M_MIN, "detour": DETOUR},
    }

    print(f"{len(stations)} stations, {len(lignes)} lignes, "
          f"{len(motifs_sortie)} motifs, {total_profils} profils")
    print(f"{total_courses} courses, {total_arrets} arrêts desservis, "
          f"{len(liens)} correspondances à pied")
    return reseau, cours


def lire_tarifs(zf):
    medias = {
        r["fare_media_id"]: (r["fare_media_name"].strip() or r["fare_media_id"])
        for r in lire_csv(zf, "fare_media.txt")
    }
    categories = {
        r["rider_category_id"]: r["rider_category_name"].strip()
        for r in lire_csv(zf, "rider_categories.txt")
    }
    produits = {}
    for r in lire_csv(zf, "fare_products.txt"):
        cle = (r["fare_product_id"], r["rider_category_id"], r["amount"])
        p = produits.setdefault(cle, {
            "nom": r["fare_product_name"].strip(),
            "categorie": categories.get(r["rider_category_id"], ""),
            "prix": float(r["amount"]), "supports": [],
        })
        support = medias.get(r["fare_media_id"], r["fare_media_id"])
        if support not in p["supports"]:
            p["supports"].append(support)
    return {
        "source": "GTFS-Fares v2 CTS",
        "produits": sorted(produits.values(), key=lambda p: (p["prix"], p["nom"])),
    }


def ecrire(nom, contenu):
    chemin = DATA / nom
    chemin.write_text(
        json.dumps(contenu, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"  {nom} : {chemin.stat().st_size / 1e6:.2f} Mo")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sans-ter", action="store_true",
                    help="ne pas intégrer le réseau ferroviaire")
    args = ap.parse_args()

    print("Réseau CTS :")
    zf_cts = zipfile.ZipFile(telecharger(URL_CTS, "google_transit.zip"))
    cts = lire_gtfs(zf_cts, "c:", "CTS", filtrer_zone=False, couleur_defaut="666666")
    print(f"  {len(cts['stations'])} stations, {len(cts['motifs'])} motifs")

    reseaux = [cts]
    if not args.sans_ter:
        print("Réseau ferroviaire (SNCF) :")
        zf_ter = zipfile.ZipFile(telecharger(URL_SNCF, "sncf_gtfs.zip"))
        ter = lire_gtfs(zf_ter, "s:", "SNCF", filtrer_zone=True,
                        couleur_defaut="4A5A6A")
        print(f"  {len(ter['stations'])} gares, {len(ter['motifs'])} motifs")
        reseaux.append(ter)

    reseau, cours = assembler(reseaux)
    tarifs = lire_tarifs(zf_cts)
    print(f"{len(tarifs['produits'])} tarifs CTS")

    DATA.mkdir(exist_ok=True)
    print("Écriture :")
    ecrire("reseau.json", reseau)
    ecrire("courses.json", cours)
    ecrire("cts-tarifs.json", tarifs)

    for ancien in ("cts-reseau.json", "cts-courses.json", "cts-horaires.json"):
        chemin = DATA / ancien
        if chemin.exists():
            chemin.unlink()
            print(f"  {ancien} supprimé (remplacé)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
