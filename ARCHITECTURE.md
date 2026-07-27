# Strasbourg & Eurométropole — Architecture de l'application

PWA statique (zéro build, pas de Node), consultable **100 % hors ligne** sur smartphone,
avec un **mode en ligne optionnel** qui actualise horaires, tarifs et perturbations en temps réel.
Hébergement : GitHub Pages (compte cristo67000), comme les autres projets — en ligne
depuis le 2026-07-26 sur https://cristo67000.github.io/strasbourg-eurometropole/.

---

## 1. Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────┐
│                     PWA (index.html)                        │
│                                                             │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────┐   │
│  │ MapLibre GL  │  │ Moteur        │  │ Panneaux UI     │   │
│  │ (carte 2D/3D)│  │ d'itinéraires │  │ arrêts/musées/  │   │
│  │              │  │ (CSA en JS)   │  │ POI perso       │   │
│  └──────┬───────┘  └───────┬───────┘  └────────┬────────┘   │
│         │                  │                   │            │
│  ┌──────┴──────────────────┴───────────────────┴────────┐   │
│  │              Couche données (data/)                  │   │
│  │  tiles.pmtiles │ gtfs-cts.json │ ter.json │ musees…  │   │
│  └──────────────────────────┬───────────────────────────┘   │
│                             │                               │
│  ┌──────────────────────────┴───────────────────────────┐   │
│  │  Service worker (cache-first) + IndexedDB (POI perso)│   │
│  └──────────────────────────────────────────────────────┘   │
└───────────────┬─────────────────────────────────────────────┘
                │ mode EN LIGNE uniquement
        ┌───────┴────────────────────────────┐
        │ Proxy Cloudflare Worker (gratuit)  │
        │  → API CTS (SIRI Lite, temps réel) │
        │  → API SNCF (Navitia)              │
        └────────────────────────────────────┘
```

Deux régimes de fonctionnement :

| | Hors ligne (défaut) | En ligne (option) |
|---|---|---|
| Carte | Tuiles vectorielles embarquées (PMTiles) | idem (rien à télécharger) |
| Horaires CTS | Horaires théoriques GTFS embarqués | Passages temps réel (SIRI Lite) |
| Trains | Horaires théoriques TER embarqués | Retards / perturbations (API SNCF) |
| Musées | Horaires + tarifs figés au dernier build | Expositions en cours actualisées |
| Itinéraires | Calcul local (algorithme CSA) | idem + prise en compte des retards |

---

## 2. La carte — MapLibre GL JS + PMTiles (et pas Leaflet)

**Décision clé du projet.** Leaflet (utilisé sur les autres projets) affiche des tuiles
*raster* : hors ligne, il faudrait embarquer des centaines de Mo d'images et les noms de
rues seraient des pixels. Ici on passe à :

- **MapLibre GL JS** (~800 Ko, un seul `<script>`, zéro build — même philosophie que Leaflet) ;
- **PMTiles** : tout le fond de carte vectoriel de l'Eurométropole dans **un seul fichier**
  `tiles.pmtiles` (~30–60 Mo pour les 33 communes, zoom 0→15 monde dézoomé + zoom 16/17
  détaillé sur l'EMS). Lecture par requêtes HTTP *Range* (supportées par GitHub Pages)
  et par le service worker une fois en cache.

Ce que ça apporte :

- **Toutes les rues nommées** : les noms sont des données vectorielles, rendus nets à
  n'importe quel zoom, rotation, inclinaison.
- **3D réelle** : couche `fill-extrusion` sur les bâtiments OSM (hauteurs `building:height`
  très bien renseignées sur Strasbourg — cathédrale, Neustadt, institutions européennes).
  Bouton 2D/3D qui incline la caméra à 60°.
- **Mode sombre gratuit** : deux fichiers de style JSON (clair/sombre) sur les mêmes tuiles.

Fabrication du fichier (pipeline local, une commande) :

1. Extrait OSM `alsace-latest.osm.pbf` (Geofabrik), découpé sur la bbox EMS ;
2. **tilemaker** ou **planetiler** (binaires autonomes, pas de Node) → `tiles.pmtiles`
   au schéma OpenMapTiles/Shortbread ;
3. Alternative sans rien installer : extraits sur mesure de **Protomaps** (bbox → .pmtiles).

Glyphes de police et sprites embarqués dans `assets/` (obligatoire hors ligne).

---

## 3. Transports CTS (bus + tram)

### 3.1 Données théoriques (hors ligne) — *réalisé*

Source : **GTFS officiel CTS**, `https://opendata.cts-strasbourg.eu/google_transit.zip`
(référencé sur transport.data.gouv.fr, et non sur data.strasbourg.eu comme supposé
initialement). `build/cts.py` le transforme en JSON compacts :

- `data/cts-reseau.json` (50 Ko) — 48 lignes avec couleurs officielles et parcours
  ordonnés, et 569 **stations** obtenues en regroupant les 1 360 points d'arrêt
  (le GTFS n'a pas de `parent_station` : on groupe par préfixe d'identifiant
  `NOM_NN`, puis on fusionne les homonymes à moins de 400 m).
- `data/cts-courses.json` (**0,23 Mo**) — la structure complète des 47 147 courses,
  les 121 calendriers et les 574 correspondances à pied.
- `data/cts-tarifs.json` — 30 titres, voir 3.4.

**Modèle « motifs de desserte ».** Une première version stockait, par station, la
liste des minutes de passage : 1,34 Mo, et l'identité des courses était perdue — donc
inexploitable pour un itinéraire. Le modèle retenu part du constat que les 47 147
courses ne dessinent que **255 séquences d'arrêts distinctes** et 2 664 profils
horaires (écarts en minutes depuis le premier arrêt). Une course se réduit alors à un
triplet calendrier / heure de départ / profil, et le fichier sert *à la fois* les
fiches arrêt et le calcul d'itinéraires — six fois plus petit avec strictement plus
d'information. Tout est encodé en varint base 64 (`build/codec.py`, miroir JS dans
`reseau.js`). `build/verifie.py` recompte les arrêts et les courses redécodés et les
compare au GTFS source : 938 788 et 47 147, encodage sans perte.

Détail conservé pour l'exactitude : arrivée et départ diffèrent dans 0,04 % des
arrêts seulement (battements aux terminus, jusqu'à 16 min). Ces écarts sont stockés
à part, en liste éparse, plutôt que de doubler tous les profils.

**Deux écarts par rapport au plan initial, découverts sur les données réelles :**

1. *Pas de `shapes.txt`* dans le GTFS CTS : aucune géométrie de ligne n'est fournie.
   Les tracés viennent donc des relations OpenStreetMap (§ 3.5).
2. *Types de jours irréguliers* : outre Semaine/Samedi/Dimanche, le GTFS contient des
   calendriers `Jeu`, `Mardi`, `Mercredi`, `L`, `D`, `F`… et beaucoup de calendriers
   d'un seul jour. Le raccourci « trois types de jours » prévu au départ aurait été
   faux ; le client applique donc la **vraie résolution GTFS** (plage de validité +
   masque de jours + exceptions `calendar_dates`), soit une quinzaine de lignes de JS.

Conséquence visible et correcte : pendant les travaux d'été 2026, certains arrêts du
centre (Homme de Fer) n'ont de tram qu'en soirée, le jour étant assuré par les lignes
« Remplacement-A/E » et « Remplacement-B/F ». La fiche arrêt l'annonce explicitement
(« reprise à 22:00 ») au lieu de renvoyer au lendemain.

### 3.2 Temps réel (en ligne) — *réalisé côté code, non vérifié en conditions réelles*

L'API temps réel CTS (`api.cts-strasbourg.eu`, SIRI Lite : `stop-monitoring`,
`general-message`) et l'API SNCF (Navitia, `api.sncf.com`) exigent chacune un
**token**. Un site statique ne peut pas embarquer un secret → **`worker/index.js`**,
un Worker Cloudflare (offre gratuite suffisante) qui :

- garde les deux tokens côté serveur (`wrangler secret put`, jamais dans le dépôt),
- ajoute les en-têtes CORS,
- met en cache les réponses à l'edge (30 s passages, 120 s perturbations),
- ne relaie que trois endpoints en lecture (`/cts/passages`, `/cts/perturbations`,
  `/sncf/passages`) — aucune écriture possible vers CTS ou SNCF.

Client (**`temps-reel.js`**) : un chip « Mode en ligne » ouvre un panneau où coller
l'URL du Worker déployé (stockée en `localStorage`, jamais ailleurs). Tant qu'aucune
URL n'est configurée — ou que le Worker ne répond pas dans les 4 s (`AbortController`)
— l'app se comporte **exactement** comme en phase 6 : uniquement les horaires
théoriques déjà calculés par `transports.js`. Quand une réponse arrive à temps, elle
remplace en place le contenu théorique déjà affiché (repérage par nœud DOM toujours
attaché — `Node.isConnected` —, pas de mécanisme d'annulation de fetch nécessaire) et
affiche un badge « ● Temps réel ».

Pour cibler le bon arrêt/gare côté CTS/SNCF, `build/reseau.py` a été étendu (phase 7)
pour conserver, par station, les identifiants bruts du GTFS d'origine (`stop_code`
CTS type `10A`, ou id `StopArea:OCE…` SNCF) dans un 7ᵉ champ du tableau station —
c'était disponible en mémoire pendant la construction, mais jusque-là jeté après le
regroupement en stations logiques.

**Non vérifié en conditions réelles, faute de token au moment de l'écriture** (voir
`worker/README.md`) : le format exact des réponses SIRI Lite et Navitia a été suivi
au plus près de la spécification officielle (`api.cts-strasbourg.eu/v1/swagger.json`
récupérée et lue en détail, documentation Navitia), mais seule une vraie requête avec
un vrai token le confirmera. Si un champ diffère, la correction se limite à
`worker/index.js` — le contrat exposé au client (`{ligne, destination, heure}` /
`{ligne, destination, theorique, estime, retard}`) ne change pas.

**Non fait à cette phase** : les expositions en cours (§ 5). Aucun jeu de données
ouvert correspondant n'a été trouvé sur data.strasbourg.eu au moment de la recherche
(catalogue complet des 398 jeux passé en revue par mots-clés — seul `lieux_culture`,
déjà utilisé en phase 4, s'en approche, et il ne contient aucun horaire ni agenda).
`build/expositions.py` n'a donc pas été écrit plutôt que de fabriquer une donnée
absente — cohérent avec la règle du projet de ne jamais afficher une information
qu'on ne peut vérifier (§ 5). À reconsidérer si une source fiable apparaît (OpenAgenda
d'un musée en particulier, par exemple).

### 3.3 Itinéraires porte-à-porte (hors ligne) — *réalisé*

Moteur maison en JS (`itineraires.js`), algorithme **CSA (Connection Scan Algorithm)** —
beaucoup plus simple que RAPTOR et largement assez rapide à l'échelle d'un réseau urbain.

Écart par rapport au plan : **aucun fichier de connexions n'est livré**. Les 891 641
connexions du réseau seraient trop lourdes ; elles sont **reconstruites à la demande**
depuis les motifs (§ 3.1), pour la seule fenêtre utile. Mesuré : 30 000 connexions
construites et triées en 17 ms, trois solutions en 20 ms au total.

1. Départ = position GPS, arrêt ou adresse ; arrêts accessibles à pied dans un rayon
   de 900 m (4,5 km/h, détour × 1,3).
2. Les connexions couvrent **veille / jour / lendemain** : une course codée à 25:30
   la veille circule à 01:30 aujourd'hui, et un itinéraire de nuit doit la voir.
3. Battement de 2 min pour changer de véhicule ; une correspondance à pied (574 paires
   d'arrêts à moins de 400 m, précalculées) tient lieu de battement.
4. Trois variantes par recherche, obtenues en **excluant la course** du premier
   véhicule — et non une plage horaire, sinon on propose le même tram pris deux
   arrêts plus loin.

Deux corrections issues des essais, à conserver en tête : le CSA minimise l'heure
d'arrivée *station par station*, ce qui peut conseiller de longues marches sans gain
réel. D'où (a) une **égalité tranchée en faveur de moins de marche**, et (b) un
**recalage du point de montée** le plus en amont possible sur la même course. Sans
cela l'app conseillait onze minutes de marche pour prendre un tram qui passait de
toute façon à l'arrêt de départ.

La géolocalisation reste **100 % locale** (même principe que vos autres apps — jamais envoyée).

### 3.4 Tarifs (hors ligne) — *réalisé, non prévu au départ*

Bonne surprise : le GTFS CTS embarque **GTFS-Fares v2** (`fare_products`,
`rider_categories`, `fare_media`). Les 30 titres — de l'aller simple à 1,90 € aux
abonnements par quotient familial — sont donc consultables hors ligne, avec le support
(BSC, Badgéo, Appli) et la catégorie de voyageur. Un avertissement invite à vérifier
auprès de la CTS avant achat, les grilles évoluant entre deux régénérations.

### 3.5 Tracés des lignes — *réalisé*

Faute de `shapes.txt`, `build/traces.py` reconstruit la géométrie depuis les
139 relations OSM `type=route` de l'opérateur (attention : OSM utilise
`operator="Compagnie des Transports Strasbourgeois"`, jamais « CTS »). Traitement :

1. assemblage des tronçons bout à bout, avec réorientation (le tram A donne une
   polyligne continue de 14,74 km à partir de 126 tronçons — longueur exacte) ;
2. simplification Douglas-Peucker à 3 m, soit ~3 px au zoom 17 ;
3. élimination des variantes redondantes — les deux sens se superposent — par
   couverture spatiale, en conservant les antennes.

Résultat : 57 polylignes, 5 455 points, **110 Ko** pour les 48 lignes. Les tracés
suivent les voies réelles, ce qui est très supérieur à des segments droits entre arrêts.
Seules les 2 lignes de substitution temporaires n'ont pas de tracé (absentes d'OSM).

### 3.6 Icônes tram/bus et fiche « lignes et directions » — *réalisé*

Distinction visuelle immédiate tram/bus, demandée après coup. Toutes les données
nécessaires étaient déjà présentes (aucune API supplémentaire) :

- **type de ligne** : `ligne.type` (GTFS `route_type`, 0 = tram, 3 = bus) — déjà utilisé
  par `modeStation()` pour colorer les pastilles, étendu pour détecter le cas
  **« mixte »** (arrêt desservi par au moins une ligne de chaque, ex. Aristide Briand,
  Jean Jaurès) resté non distingué jusqu'ici (un arrêt tram+bus s'affichait comme tram).
- **directions et arrêt suivant** : `ligne.parcours` (déjà utilisé par la fiche ligne)
  donne, par ligne, la liste ordonnée des arrêts pour chaque tracé canonique — chercher
  la position de la station dans chaque tracé donne directement le terminus (premier
  élément du couple) et l'arrêt suivant (position + 1), sans nouveau calcul ni fichier.

Icônes dessinées **au canvas à l'exécution** (pastille + emoji 🚊/🚌), pas d'asset à
précacher : cohérent avec le principe zéro-build du projet. L'icône « mixte » est une
pilule à deux moitiés (rouge tram, bleu bus) plutôt qu'un pictogramme composite, pour
qu'un simple coup d'œil montre les deux modes sans avoir à lire une légende. Posées en
couche `symbol` séparée des pastilles `circle` existantes (gardées à tous les zooms
pour rester visibles dézoomé), visible à partir du zoom 13 seulement.

Deux ajustements faits en cours de route :

1. **Directions montrées = tracés canoniques, pas toutes les variantes horaires.**
   Une première version listait, par ligne, toutes les destinations réellement vues
   dans les motifs horaires — jusqu'à 5 pour une ligne à renforts de pointe (ex. tram A
   à Homme de Fer : Étoile Bourse / Graffenstaden / Parc des Sports Zénith). Bruyant et
   incohérent avec le reste de l'app. Basculé sur `ligne.parcours`, qui donne les
   2 sens attendus (jusqu'à 4 pour une ligne à branches) — la même donnée déjà affichée
   par la fiche ligne. Limite héritée, non corrigée ici (hors périmètre) : pour
   certaines lignes, `parcours` ne porte qu'un tracé complet et un ou plusieurs tracés
   partiels pour l'autre sens (ex. ligne B vers Hoenheim Gare, 12 arrêts seulement) —
   déjà le cas dans la fiche ligne avant cette phase, donc pas un écart introduit ici,
   mais à reconsidérer si `build/reseau.py` est retouché un jour.
2. **Bug latent corrigé en testant** : `Transports.ajouterCouches()` ne posait ses
   couches qu'après un test `!Reseau.stations` cru garant que les données étaient
   chargées — en réalité un test que l'*accesseur* existe, toujours vrai. Si
   l'évènement `styledata` survient avant la fin du fetch de `reseau.json` (observé de
   façon fiable dans l'environnement de test headless, possible en conditions réelles
   sur réseau lent), `geojsonStations()` levait une exception après l'ajout de la seule
   source `cts-traces`, et le garde-fou anti-doublon bloquait alors tout nouvel essai
   pour le reste de la session — carte sans arrêts CTS, sans message d'erreur visible.
   Corrigé avec un accesseur dédié `Reseau.reseauPret()` qui vérifie les données
   elles-mêmes.

---

## 4. Trains SNCF — *réalisé (hors ligne)*

Écart heureux par rapport au plan initial : le flux **GTFS national de la SNCF**
(`Export_OpenData_SNCF_GTFS_NewTripId.zip`, mis à jour quotidiennement, ~5 Mo compressé)
suffit — inutile d'aller chercher un flux TER dédié. `build/reseau.py` le filtre à
l'emprise des tuiles (30 gares : Strasbourg, Entzheim-Aéroport, Vendenheim, Geispolsheim,
La Wantzenau, Molsheim, Kehl…) et l'assemble **dans le même fichier** que la CTS.

Conséquence directe : le moteur d'itinéraires (§ 3.3) enchaîne tram et train sans code
spécifique. Vérifié : Homme de Fer → aéroport d'Entzheim en 28 min (tram D + TER),
correspondance à pied de 2 min entre « Gare Centrale » (nom CTS) et « Strasbourg »
(nom SNCF) — les deux stations ne sont **volontairement pas fusionnées**, seules les
574+ correspondances à pied les relient.

Deux subtilités du flux national, réglées dans le pipeline :

- Il contient ~9 500 calendriers dont l'écrasante majorité ne concerne aucune course
  retenue (services d'autres régions) : on ne garde que ceux réellement référencés,
  ce qui fait chuter `courses.json` de 0,88 Mo à 0,31 Mo pour les deux réseaux réunis.
- Une course SNCF peut continuer hors de l'emprise (train vers Paris, Bâle, Nancy…) :
  son terminus réel est conservé comme destination affichée même s'il est hors zone, et
  son dernier arrêt dans l'emprise reste listé comme un départ légitime. Un premier
  essai confondait ce cas avec un simple trou au milieu du parcours (une gare non
  desservie entre deux arrêts retenus) et affichait de faux départs « vers Strasbourg »
  à la gare de Strasbourg elle-même — corrigé par `verifie.py`, qui aurait dû le
  détecter d'emblée (ajouté depuis : un motif à une seule station n'est légitime que
  s'il est marqué tronqué).
- Tarifs : aucun n'est publié pour la SNCF (contrairement à la CTS, § 3.4). Un lien
  vers sncf-connect.com est affiché plutôt qu'un prix approximatif.

Non fait : le mode en ligne (Navitia, retards temps réel) reste prévu en phase 7.

---

## 5. Musées et lieux culturels — *réalisé (hors expositions, en ligne)*

Écart par rapport au plan : **pas de curation manuelle**, mais un croisement de trois
sources ouvertes, chacune pour ce qu'elle sait faire (`build/musees.py`). Un jeu
100 % « à la main » aurait exigé de collecter et tenir à jour 33 grilles d'horaires ;
ici elles sont relevées, datées, et régénérables en une commande.

- **OpenStreetMap** — seule source à porter des horaires exploitables
  (`opening_hours` en syntaxe normalisée) pour toute l'agglomération, Kehl comprise,
  plus l'indication payant/gratuit et l'accessibilité fauteuil.
- **data.strasbourg.eu** (jeu `lieux_culture`, 362 fiches) — description officielle en
  français et lien vers la fiche de la Ville. **Ne contient aucun horaire** (`periods`
  vide sur les 362 fiches) : à découvrir avant de s'appuyer dessus pour les horaires.
- **Wikidata / Wikimedia Commons** — une photo *uniquement* quand la propriété P18 la
  rattache explicitement au lieu (jamais de rapprochement par nom sur Commons, qui
  produit des faux positifs — même piège que le projet châteaux).

Le rapprochement OSM ↔ fiche officielle se fait par nom **et** proximité (< 250 m) :
la proximité seule ne suffit pas, plusieurs lieux culturels partagent une adresse
(le palais Rohan héberge trois musées).

Résultat : **33 lieux**, 22 avec horaires, 17 avec description, 12 avec photo — 23 Ko
de données + 0,9 Mo de photos WebP. Aucun tarif n'est publié nulle part dans les
sources croisées : plutôt que d'en inventer un, la fiche affiche seulement un lien
vers l'établissement.

Le badge **« Ouvert / Fermé / Horaires à vérifier »** est calculé côté client
(`musees.js`) sur un sous-ensemble volontairement restreint de la syntaxe
`opening_hours` (jours, plages horaires, `PH`, `24/7`) ; dès qu'une règle en sort
(mois, n-ième dimanche, vacances scolaires `SH`, commentaire entre guillemets), le
calcul renonce et affiche l'horaire brut plutôt que d'annoncer un état faux. Inclut
le calcul des jours fériés d'Alsace-Moselle (Vendredi saint et 26 décembre en plus
des onze jours fériés nationaux), via l'algorithme de Meeus pour Pâques.

Chaque fiche liste les stations proches (issues de `reseau.js`, § 3-4) et propose
« M'y rendre », qui préremplit le formulaire d'itinéraire (§ 3.3).

Reste à faire : les expositions en cours (en ligne, agenda `data.strasbourg.eu`,
phase 7).

---

## 6. POI personnels (restaurants, bars, cinémas…) — *réalisé*

- **`poi.js`** : appui long sur la carte (touch, ~550 ms, annulé si le doigt bouge de
  plus de 12 px) ou clic droit (`contextmenu`, plus pratique en développement) → ouvre
  un formulaire dans le panneau fiche (`Transports.ouvrirFiche`, réutilisé tel quel) :
  nom, catégorie (restaurant/bar/cinéma/commerce/autre), note (0 à 5 étoiles),
  commentaire libre.
- Stockage **IndexedDB** (base `strasbourg-poi`, magasin `poi`, clé auto-incrémentée) :
  pérenne, hors ligne par nature (l'API est déjà locale au navigateur), jamais envoyé
  nulle part — aucun changement à `sw.js` n'était nécessaire pour ce point.
- Export JSON (bouton → `Blob` + lien `download`) et import (fichier → `ajouter()` de
  chaque entrée valide, en filtrant celles sans nom/coordonnées) depuis le panneau
  « Mes POI » (`chip-poi`). L'import **fusionne** plutôt que de remplacer : des ids sont
  réattribués à l'insertion, pas de détection de doublon.
- Couche dédiée (`poi-points` / `poi-noms`), même construction que la couche musées,
  couleur par catégorie via une expression `match`, filtrable par catégorie (chips dans
  le panneau liste, `setFilter` avec `["in", ["get", "categorie"], [...]]`).
- Non fait à cette phase (écarté comme relevant du bonus, pas du cœur de la phase) : la
  case « afficher les POI OSM » (restaurants/bars/cinémas déjà présents comme POI
  vectoriels dans les tuiles Protomaps) et l'intégration des POI perso à la recherche
  principale — celle-ci ne gère aujourd'hui que l'ajout d'entrées, jamais leur retrait,
  ce qui aurait exigé de retravailler `app.js` pour un gain marginal (les POI se
  retrouvent déjà via le panneau « Mes POI »).

---

## 7. PWA et stratégie hors ligne — *réalisé*

- `manifest.webmanifest` + icônes (`build/icones.py`, silhouette de flèche gothique sur
  fond bleu d'accent — générées, pas dessinées à la main) → installable (TWA Play Store
  resterait possible ensuite, comme france-departements).
- **Service worker (`sw.js`)**, deux caches distincts :
  - `strasbourg-app-<build>` : app shell, styles, glyphes, sprites, icônes, JSON de
    données, photos de musées — 814 fichiers précachés à l'installation, listés par
    `build/manifeste.py` (écrire cette liste à la main était impraticable : 769 fichiers
    de glyphes). Stratégie *réseau d'abord, cache en secours* pour le code et les JSON
    (légers, mis à jour à chaque build), *cache d'abord* pour `lib/`, `assets/`,
    `icons/`, `img/` (lourds, statiques). Anciennes versions du cache purgées à l'activation.
  - `strasbourg-tuiles-v1` : `tiles.pmtiles` (~31 Mo), **jamais précaché** — téléchargé à
    la demande via le bouton « Carte hors ligne » (`pwa.js`), avec barre de progression
    (lecture du flux par morceaux, `ReadableStream`). Un petit marqueur JSON
    (`data/tiles-version.json`, copie de la section `tuiles` de `version.json`) est stocké
    à côté pour détecter une carte périmée au prochain chargement en ligne.
- **Astuce Range sur PMTiles, la vraie difficulté de cette phase** : le Cache Storage ne
  sait pas satisfaire une requête Range sur une entrée mise en cache. Solution : au
  premier accès, `sw.js` charge le blob complet en mémoire (`ArrayBuffer`, variable de
  module) une seule fois, puis découpe lui-même chaque plage demandée — pmtiles.js émet
  des dizaines de petites requêtes Range par session de navigation sur la carte, et
  re-décoder les 31 Mo à chaque fois serait inutilisable. La page prévient le SW par
  `postMessage` après avoir installé/supprimé la carte pour invalider ce cache mémoire.
- Testé en conditions réelles : app complète (carte, recherche, réseau CTS+SNCF, fiches)
  fonctionnelle serveur de développement **coupé**, y compris la recherche croisée
  rues/arrêts qui dépend de deux JSON distincts chargés depuis le cache.
- **Piège CSP découvert ici** : `worker-src blob:` (sans `'self'`) bloque
  l'**enregistrement** du service worker lui-même — l'enregistrement d'un service worker
  est gouverné par `worker-src`, qui ne retombe pas sur `script-src` dès qu'il est
  présent. Corrigé en `worker-src 'self' blob:; child-src 'self' blob:;`. Le piège
  « MapLibre exige `worker-src blob:` » (projet templiers) n'était donc que la moitié du
  problème pour une PWA installable.
- Non fait à cette phase : bannière d'installation « Ajouter à l'écran d'accueil »
  personnalisée — l'icône native du navigateur suffit, comme sur les autres projets.

---

## 8. Pipeline de données (Python 3.11, local)

```
build/
  overpass.py       # accès Overpass mutualisé, bascule entre miroirs (504 fréquents)   [fait]
  codec.py          # varint base 64 des suites d'entiers, miroir JS dans reseau.js     [fait]
  rues.py           # Overpass → rues.json (index de recherche)                         [fait]
  reseau.py         # GTFS CTS + SNCF → reseau / courses / cts-tarifs.json (unifiés)    [fait]
  traces.py         # relations OSM → cts-traces.geojson (pas de shapes.txt au GTFS)    [fait]
  musees.py         # OSM + lieux_culture + Commons → musees.json + img/musees/*.webp   [fait]
  verifie.py        # contrôles : index croisés, décodage, couverture, non-régression  [fait]
  serveur.py        # serveur de développement gérant les requêtes Range (PMTiles)      [fait]
  pmtiles.exe       # extraction des tuiles depuis build.protomaps.com                  [fait]
  icones.py         # Pillow → icons/icon-*.png (flèche gothique, sans image source)    [fait]
  manifeste.py      # énumère l'app shell → data/precache.json (précache du SW)         [fait]
  cache/            # GTFS, réponses Overpass, jeu lieux_culture (non versionné)

worker/             # proxy Cloudflare (mode en ligne, phase 7)
  index.js          # /cts/passages /cts/perturbations /sncf/passages, tokens en secrets [fait]
  wrangler.toml      #                                                                   [fait]
  README.md         # obtention des tokens, déploiement, ce qui reste à vérifier         [fait]
```

Pas d'`expositions.py` : aucune source ouverte trouvée pour l'agenda des expositions
en cours (§ 3.2) — écarté plutôt que d'inventer une donnée.

Lancement manuel à chaque changement d'horaires (rentrée, Marché de Noël, été) —
pas de CI nécessaire, cohérent avec vos habitudes. Les GTFS pèsent quelques dizaines
de Mo en entrée mais ne sont **jamais** livrés au client tels quels.

---

## 9. Arborescence livrée (GitHub Pages)

```
strasbourg-eurometropole/
  index.html            # app complète (une page, fiche en panneau bas)      [fait]
  app.js                # socle carte, thèmes, 3D, recherche (namespace Carte) [fait]
  reseau.js             # données CTS+SNCF décodées, calendriers, connexions   [fait]
  transports.js         # couches carte, fiche arrêt, passages, tarifs         [fait]
  itineraires.js        # moteur CSA et panneau d'itinéraire                   [fait]
  musees.js             # couche carte, horaires calculés, fiches, photos      [fait]
  pwa.js                # enregistrement SW, téléchargement carte + progression [fait]
  sw.js                 # service worker : précache app shell, cache tuiles    [fait]
  poi.js                 # POI perso : IndexedDB, formulaire, couche filtrable  [fait]
  temps-reel.js           # mode en ligne : proxy, config, repli théorique      [fait]
  style.css  manifest.webmanifest                                             #  [fait]
  lib/maplibre-gl.js  lib/maplibre-gl.css                    # vendorisés [fait]
  lib/pmtiles.js  lib/basemaps.js                            #            [fait]
  assets/glyphs/…  assets/sprites/v4/…                       #            [fait]
  icons/icon-192.png  icon-512.png  icon-maskable-512.png    #            [fait]
  data/
    tiles.pmtiles       # 31 Mo (< 100 Mo, limite GitHub OK)               [fait]
    rues.json           # 536 Ko, 6 010 noms                               [fait]
    reseau.json         # 60 Ko, lignes CTS+SNCF et 599 stations           [fait]
    courses.json        # 310 Ko, 49 378 courses + 918 calendriers        [fait]
    cts-traces.geojson  # 110 Ko                                          [fait]
    cts-tarifs.json     # 3 Ko                                            [fait]
    musees.json         # 23 Ko, 33 lieux                                 [fait]
    version.json        # provenance et millésime de chaque jeu           [fait]
    precache.json        # liste des 814 fichiers de l'app shell (SW)     [fait]
    expositions.json                                       # phase 7
  img/musees/*.webp     # 0,9 Mo, 12 photos créditées                     [fait]
  build/                # pipeline Python (non servi)
```

Poids actuel de l'app complète : **~45 Mo**, dont 31 Mo de tuiles et 12 Mo de glyphes
de polices (indispensables hors ligne pour les noms de rues). Tout le reste — réseau
CTS+SNCF (itinéraires compris), musées, photos — ne pèse que **1,3 Mo**. À la phase 5,
seules les tuiles seront en téléchargement optionnel ; les glyphes pourraient être
réduits en ne gardant que les plages Unicode latines réellement utilisées.

Budget total téléchargé par l'utilisateur : **~50–80 Mo**, dont l'essentiel (la carte)
en téléchargement optionnel explicite. L'app fonctionne dès ~6 Mo (carte en ligne),
le bouton « tout installer hors ligne » complète le reste.

---

## 10. Phases de développement proposées

1. ~~**Socle carte** : MapLibre + PMTiles EMS, styles clair/sombre, 3D, recherche de
   rues.~~ **Fait** (index des rues via Overpass et non extrait des tuiles : plus
   simple, et permet d'annoter chaque rue de sa commune pour lever les homonymies.)
2. ~~**Réseau CTS statique** : arrêts, tracés, horaires théoriques, fiche arrêt
   « prochains passages ».~~ **Fait**, plus les tarifs (non prévus) et la recherche
   d'arrêts. Tracés reconstruits depuis OSM faute de `shapes.txt`.
3. ~~**Itinéraires** : moteur CSA + marche à pied.~~ **Fait.** Le modèle de données a
   été refondu à cette occasion (§ 3.1), au bénéfice des fiches arrêt et du routage.
4. ~~**Musées** : dataset, fiches, « M'y rendre ». Gares TER dans le graphe.~~ **Fait.**
   Écart par rapport au plan : pas de curation manuelle, mais un croisement de trois
   sources ouvertes (§ 5) ; pas de flux TER dédié, le GTFS national SNCF filtré
   suffit et vit dans le même fichier que la CTS (§ 4). Reste : les expositions
   (phase 7, en ligne).
5. ~~**PWA hors ligne complète** : service worker, installation de la carte,
   versionnage.~~ **Fait** (§ 7). Écart : la barre de progression et le téléchargement
   se font depuis la page (`pwa.js`) et non par messages vers le service worker — plus
   simple, l'API Cache Storage est accessible depuis les deux contextes.
6. ~~**POI personnels** : IndexedDB, export/import.~~ **Fait** (§ 6). Écart : pas de case
   « afficher les POI OSM » ni d'intégration à la recherche principale — laissés de côté
   comme bonus hors du cœur de la phase (§ 6).
7. ~~**Mode en ligne** : proxy Cloudflare Worker, temps réel CTS, API SNCF,
   expositions.~~ **Fait côté code** (§ 3.2), **non vérifié en conditions réelles**
   faute de compte/token CTS et SNCF au moment de l'écriture, et **non déployé**
   faute de compte Cloudflare configuré sur ce poste — le Worker attend dans
   `worker/`, prêt à déployer (`worker/README.md`). Écart : pas d'expositions,
   aucune source ouverte trouvée (§ 3.2).
8. ~~**Publication** : GitHub Pages, puis éventuellement TWA Play Store.~~ **Fait
   pour la partie GitHub Pages** : dépôt public `cristo67000/strasbourg-eurometropole`,
   Pages activé sur `master`/`/`, vérifié en ligne (814 fichiers précachés par le
   service worker, à jour). Écart : le TWA Play Store n'a pas été demandé, reste
   pour plus tard si besoin.

Chaque phase livre une app utilisable ; le temps réel arrive volontairement en dernier
(seule brique qui dépend d'un composant serveur et de tokens).

---

## 11. Risques et points à vérifier

| Point | Risque | Parade |
|---|---|---|
| Conditions API CTS | Obtention du token, quotas | Demander le token tôt ; l'app reste complète sans (horaires théoriques) |
| Range requests GitHub Pages | Nécessaires à PMTiles | Vérifié fonctionnel ; sinon fallback : télécharger tout le fichier en cache d'un coup |
| Taille tuiles zoom 17 | > 100 Mo si zoom max trop généreux | Zoom 16 partout + 17 sur l'ellipse centre-ville seulement |
| Licences | GTFS CTS/SNCF (ODbL/licence ouverte), OSM (ODbL) | Page « À propos » avec attributions (obligatoire) |
| iOS Safari | Quota Cache Storage plus strict | Tester ; PMTiles < 60 Mo passe bien |
| **Péremption du GTFS** | Les horaires embarqués expirent (actuellement 17/01/2027) | `verifie.py` alerte à moins de 21 jours ; en ligne, proposer la mise à jour (§ 7) |
| **Perturbations et travaux** | Le GTFS théorique ne dit pas *pourquoi* un arrêt n'est plus desservi | L'API SIRI `general-message` (phase 7) fournit les infos trafic ; hors ligne, la fiche reste factuelle |

### Enseignements techniques des phases 1 à 4

- `python -m http.server` **ne gère pas** les requêtes Range dont PMTiles a besoin →
  `build/serveur.py`. GitHub Pages, lui, les gère.
- CSP : MapLibre exige `worker-src blob:` (et `child-src blob:` pour Safari).
- MapLibre analyse son style dans un `requestAnimationFrame` : en onglet masqué,
  rien ne s'initialise et `isStyleLoaded()` reste faux indéfiniment. Ne jamais
  conditionner un chargement de données à l'événement `load` de la carte ; les couches
  se posent sur `styledata`, qui ne dépend pas du rendu.
- Un changement de thème reconstruit le style et **supprime les couches maison** :
  toute fonction d'ajout de couches doit être idempotente et rejouée sur `styledata`.
- Overpass renvoie très souvent 504/429 → miroirs + cache local obligatoires.
- `line-dasharray` n'accepte **pas** d'expression liée aux données : un trait
  pointillé conditionnel exige deux couches filtrées, pas un `["case", …]`.
- Les sources GeoJSON sont chargées par le worker MapLibre : elles n'apparaissent pas
  dans `performance.getEntriesByType("resource")`, et `querySourceFeatures` ne renvoie
  que les tuiles chargées, avec géométrie découpée. Ne pas en conclure à un échec.
- Le style Protomaps référence trois pictogrammes absents du jeu de sprites officiel
  (`townhall`, `hospital`, `station`) : un substitut transparent posé sur
  `styleimagemissing` évite un avertissement par tuile.
- Un algorithme d'itinéraire correct peut donner de **mauvais conseils** : le CSA
  optimise l'arrivée station par station, pas le confort. Prévoir explicitement les
  départages (moins de marche à arrivée égale) et le recalage du point de montée.
- Toujours **caler l'emprise des données transport sur l'emprise des tuiles**, pas
  sur une bbox « raisonnable » choisie à part : une gare hors carte n'a aucun sens à
  l'écran. Les deux bbox vivaient dans des fichiers différents (`build/overpass.py`,
  `build/reseau.py`) et avaient dérivé l'une de l'autre avant d'être unifiées.
- La couche `places_locality` du fond Protomaps mélange deux choses sous le même
  `kind` : les vrais villages (`kind_detail`: village/town/city, toujours nommés
  correctement) et le tag OSM `place=locality` — des lieux-dits historiques sans
  population réelle (`population: 1000`, valeur de repli synthétique), souvent en
  allemand en Alsace (Flurnamen : « Auf den Stadtweg », « Neben dem Kreuzpfad »…).
  `lang: "fr"` ne les traduit pas puisqu'ils n'ont pas de tag `name:fr`. Filtré côté
  client (`app.js`, `construireStyle`) en excluant `kind_detail == "locality"` de
  cette seule couche — décision purement esthétique (bruit cartographique), les
  autres couches (rues, réseau CTS/SNCF) n'étaient pas concernées.
- Un flux GTFS **national** (comme celui de la SNCF) peut contenir des milliers de
  calendriers sans rapport avec la zone filtrée : élaguer aux seuls services
  réellement référencés par une course retenue, sinon le poids explose sans raison
  (0,88 Mo → 0,31 Mo ici).
- « La course continue hors zone » et « il y a un trou dans le parcours au milieu de
  la zone » sont deux choses différentes — seule la première justifie de traiter le
  dernier arrêt connu comme un terminus/départ. Confondre les deux a produit de faux
  départs (« vers Strasbourg » à la gare de Strasbourg) : le bug n'était pas visible
  sans comparer les horaires produits au GTFS source gare par gare.
- Un jeu de données officiel « le plus complet en apparence » peut être vide sur le
  champ qui vous intéresse (`lieux_culture` : 362 fiches, zéro horaire) — vérifier le
  contenu réel avant de bâtir dessus, pas seulement l'existence du jeu.
- Wikimedia/Commons **rejette les téléchargements dont le user-agent n'identifie pas
  l'outil et un contact** (politique robots) : sans ça, 429 systématique.
- Un rapprochement géographique entre deux sources ne doit **jamais** se fier à la
  seule proximité : plusieurs lieux distincts peuvent partager une adresse (le palais
  Rohan héberge trois musées) — combiner distance et similarité de nom.
- Interpréter une syntaxe partiellement standardisée (`opening_hours`) doit **échouer
  proprement** dès qu'une règle sort du sous-ensemble couvert, plutôt que d'annoncer
  un état probablement faux. Afficher l'horaire brut en repli coûte peu et évite de
  mentir.
- Le Cache Storage ne satisfait pas une requête Range sur une réponse mise en cache
  complète : pour un gros fichier lu par plages (PMTiles), il faut charger le blob en
  mémoire une fois puis découper soi-même chaque plage dans le service worker — sinon
  chaque requête Range re-décode le fichier entier.
- `worker-src` dans la CSP gouverne aussi l'**enregistrement** du service worker (pas
  seulement les Web Workers de MapLibre) et ne retombe pas sur `script-src` une fois
  présent : `worker-src blob:` seul bloque `serviceWorker.register()` d'un script même
  origine. Il faut `worker-src 'self' blob:`.
- Une liste de fichiers à précacher écrite à la main devient vite fausse (769 glyphes
  ici) : un petit script (`build/manifeste.py`) qui énumère les dossiers concernés à
  chaque build et écrit `data/precache.json` est plus fiable qu'une liste figée dans
  `sw.js`.
