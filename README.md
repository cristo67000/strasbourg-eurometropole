# Strasbourg & Eurométropole

**En ligne : https://cristo67000.github.io/strasbourg-eurometropole/**

Carte très détaillée de Strasbourg et de l'Eurométropole (+ Kehl), 100 % statique,
conçue pour être consultable **hors ligne** sur smartphone. Voir
[ARCHITECTURE.md](ARCHITECTURE.md) pour le plan complet (transports CTS, TER,
musées, itinéraires, PWA…).

**Phase 1 réalisée** : socle carte — MapLibre GL + tuiles vectorielles PMTiles
locales (31 Mo), toutes les rues nommées, thèmes clair/sombre, vue 3D des
bâtiments (hauteurs OSM), recherche de rues et localités (6 010 noms),
géolocalisation locale.

**Phase 2 réalisée** : réseau CTS hors ligne — 48 lignes (dont 6 trams),
569 stations, tracés suivant les voies réelles, fiche arrêt avec prochains
passages calculés localement, parcours détaillé de chaque ligne, grille
tarifaire embarquée. Les arrêts sont cherchables au même titre que les rues.

**Phase 3 réalisée** : itinéraires porte-à-porte hors ligne (algorithme CSA),
marche d'accès et de sortie incluse, correspondances à pied entre arrêts
proches, trois variantes par recherche, tracé du trajet sur la carte. Environ
30 000 connexions scannées en 20 ms. À cette occasion le modèle de données a
été refondu autour de « motifs de desserte » : six fois plus compact tout en
portant la structure complète des courses, désormais partagée par les fiches
arrêt et le calcul d'itinéraires.

**Phase 4 réalisée** : gares SNCF/TER intégrées au même réseau que la CTS —
un itinéraire peut enchaîner tram et train sans traitement particulier
(ex. Homme de Fer → aéroport d'Entzheim en tram + TER). Musées et lieux de
visite : 33 lieux croisant OpenStreetMap (horaires, position, accessibilité),
le jeu officiel de la Ville (description, lien) et des photos Wikimedia
Commons avec crédit, sans jamais inventer d'horaire ni de tarif. Un indicateur
« ouvert / fermé » est calculé localement, jours fériés d'Alsace-Moselle
compris, avec repli honnête sur l'horaire brut quand la syntaxe dépasse ce
qui est interprété.

**Phase 5 réalisée** : application installable et 100 % utilisable hors ligne.
Un service worker précache le code, les styles, les polices et toutes les
données (812 fichiers) dès la première visite ; le fond de carte
(`tiles.pmtiles`, ~31 Mo) se télécharge à part, à la demande, via le bouton
« Carte hors ligne », avec barre de progression. Testé serveur coupé :
carte, recherche, réseau et fiches restent pleinement fonctionnels.

**Phase 6 réalisée** : POI personnels — appui long sur la carte (clic droit possible
aussi) ouvre un formulaire (nom, catégorie, note, commentaire) ; les lieux sont stockés
en IndexedDB, donc pérennes et jamais transmis nulle part. Couche dédiée filtrable par
catégorie, panneau « Mes POI » avec export et import JSON pour sauvegarder ou transférer
sa liste vers un autre téléphone.

**Phase 7 (code prêt, non déployé)** : mode en ligne optionnel — passages CTS et SNCF
en temps réel via un petit proxy Cloudflare Worker (`worker/`) qui garde les tokens
côté serveur. Chip « Mode en ligne » pour coller l'URL du Worker une fois déployé
(voir `worker/README.md`) ; tant qu'aucune URL n'est renseignée, l'app se comporte
exactement comme en phase 6 (horaires théoriques uniquement). Non fait : les
expositions en cours, faute de jeu de données ouvert trouvé pour l'agenda culturel.

**Phase 8 réalisée** : publication sur GitHub Pages (dépôt public
`cristo67000/strasbourg-eurometropole`), vérifiée en ligne — service worker installé,
814 fichiers précachés, carte et fiches fonctionnelles. Le Worker Cloudflare de la
phase 7 reste à déployer séparément quand les comptes/tokens seront disponibles.

**Icônes tram/bus** : les arrêts affichent désormais un pictogramme dédié (tram, bus,
ou pilule bicolore pour les arrêts desservis par les deux), visible à partir du zoom 13.
Un clic ouvre la fiche habituelle, enrichie d'une section « Lignes et directions » :
pour chaque ligne, ses deux sens (jusqu'à 4 pour une ligne à branches) avec le terminus
et l'arrêt suivant — voir [ARCHITECTURE.md § 3.6](ARCHITECTURE.md#36-icônes-trambus-et-fiche--lignes-et-directions--réalisé).

**Fond de carte allégé** : les micro-toponymes historiques en allemand (lieux-dits sans
population réelle, ex. Cronenbourg/Schiltigheim) ainsi que les snacks/fast-food,
épiceries/supérettes et instituts de beauté ne sont plus affichés.

**Restaurants, bureaux de poste, librairies, médiathèques** : un clic sur ces points déjà
affichés par le fond de carte ouvre désormais une bulle avec l'état d'ouverture, les
horaires bruts et le site web, quand OpenStreetMap les renseigne — voir
[ARCHITECTURE.md § 5.1](ARCHITECTURE.md#51-commerces-et-services-restaurants-bureaux-de-poste-librairies-médiathèques--réalisé).

## Lancer en local

Le serveur standard de Python ne gère pas les requêtes HTTP *Range* dont
PMTiles a besoin ; utiliser le serveur fourni :

```
python build/serveur.py 8135
```

puis ouvrir http://localhost:8135

## Régénérer les données

- **Tuiles** (fond de carte, depuis la build quotidienne Protomaps) :

  ```
  build\pmtiles.exe extract https://build.protomaps.com/AAAAMMJJ.pmtiles data/tiles.pmtiles --bbox=7.50,48.40,7.92,48.70
  ```

- **Index des rues** (Overpass/OSM) : `python build/rues.py`

- **Réseau CTS + SNCF** (GTFS officiels, à refaire à chaque changement
  d'horaires — rentrée, Marché de Noël, été) :

  ```
  python build/reseau.py
  ```

  Option `--sans-ter` pour reconstruire la seule CTS (plus rapide, utile en
  développement).

- **Musées et lieux de visite** (OpenStreetMap + fiches de la Ville + photos
  Commons) :

  ```
  python build/musees.py
  ```

  Option `--sans-photos` pour aller plus vite (les fichiers `img/musees/*.webp`
  ne sont alors ni rafraîchis ni supprimés).

- **Restaurants, bureaux de poste, librairies, médiathèques** (horaires et site web,
  OpenStreetMap) :

  ```
  python build/commerces.py
  ```

- **Liste de précache du service worker** (à refaire après tout ajout ou
  suppression de fichier servi par l'app) :

  ```
  python build/manifeste.py
  ```

- **Icônes de l'app** (rarement nécessaire, seulement si le motif change) :

  ```
  python build/icones.py
  ```

- **Tracés des lignes** (relations OSM ; le GTFS CTS n'a pas de `shapes.txt`) :

  ```
  python build/traces.py
  ```

- **Contrôles de cohérence** — à lancer après toute régénération :

  ```
  python build/verifie.py
  ```

Mettre à jour `data/version.json` après régénération. Les archives
téléchargées et les réponses Overpass sont mises en cache dans `build/cache/`
(non versionné) ; supprimer ce dossier force un rechargement complet.

## Crédits et licences

- Données cartographiques © les contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL)
- Horaires, arrêts et tarifs : [GTFS CTS](https://www.cts-strasbourg.eu) via
  [transport.data.gouv.fr](https://transport.data.gouv.fr) (licence ouverte)
- Tuiles : [Protomaps](https://protomaps.com) (builds quotidiennes libres)
- Rendu : [MapLibre GL JS](https://maplibre.org) (BSD), [PMTiles](https://github.com/protomaps/PMTiles) (BSD)
- Polices Noto (OFL, voir `assets/glyphs/OFL.txt`)
