/* Réseau CTS : couches cartographiques, fiche arrêt et prochains passages.
   Les données et tout le calcul horaire viennent de reseau.js (hors ligne). */
"use strict";

var Transports = (function () {
  var carte = null;
  var visible = true;
  var ligneIsolee = null; // indicatif de la ligne mise en évidence
  var stylePret = false;  // le style est analysé, on peut y ajouter des couches
  var tarifs = null;

  var JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

  function formaterHeure(minutes) {
    var m = ((minutes % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mn = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mn < 10 ? "0" : "") + mn;
  }

  // ---------- prochains passages ----------

  /* Passages à venir dans les `fenetre` prochaines minutes, regroupés par
     (ligne, destination). Les courses de la nuit précédente, codées au-delà
     de 24 h dans le GTFS, sont reprises avec leur horaire ramené à aujourd'hui. */
  function prochainsPassages(idxStation, maintenant, fenetre) {
    var minuteCourante = Reseau.minuteDuJour(maintenant);
    var hier = new Date(maintenant.getTime() - 86400000);
    var groupes = {};

    function ajouter(ligne, dest, reste, heure) {
      var cle = ligne + "|" + dest;
      if (!groupes[cle]) groupes[cle] = { ligne: ligne, dest: dest, passages: [] };
      groupes[cle].passages.push({ dans: reste, heure: heure });
    }

    Reseau.departsStation(idxStation, maintenant).forEach(function (d) {
      var reste = d.minute - minuteCourante;
      if (reste >= 0 && reste <= fenetre) ajouter(d.ligne, d.dest, reste, d.minute);
    });
    Reseau.departsStation(idxStation, hier).forEach(function (d) {
      if (d.minute < 1440) return;
      var reste = d.minute - 1440 - minuteCourante;
      if (reste >= 0 && reste <= fenetre) ajouter(d.ligne, d.dest, reste, d.minute - 1440);
    });

    var liste = Object.keys(groupes).map(function (c) { return groupes[c]; });
    liste.forEach(function (g) {
      g.passages.sort(function (a, b) { return a.dans - b.dans; });
      g.passages = g.passages.slice(0, 4);
    });
    liste.sort(function (a, b) { return a.passages[0].dans - b.passages[0].dans; });
    return liste;
  }

  /* Repli quand plus rien ne circule aujourd'hui : premier passage de chaque
     destination lors du prochain jour desservi (recherche sur une semaine). */
  function premiersPassages(idxStation, depuis) {
    for (var delta = 1; delta <= 7; delta++) {
      var jour = new Date(depuis.getTime() + delta * 86400000);
      var departs = Reseau.departsStation(idxStation, jour);
      if (!departs.length) continue;
      var groupes = {};
      departs.forEach(function (d) {
        var cle = d.ligne + "|" + d.dest;
        if (!groupes[cle]) {
          groupes[cle] = {
            ligne: d.ligne, dest: d.dest,
            passages: [{ dans: null, heure: d.minute }]
          };
        }
      });
      var liste = Object.keys(groupes).map(function (c) { return groupes[c]; });
      liste.sort(function (a, b) { return a.passages[0].heure - b.passages[0].heure; });
      return { jour: jour, liste: liste };
    }
    return null;
  }

  // ---------- couches cartographiques ----------
  // « mixte » : arrêt desservi à la fois par une ligne de tram (GTFS type 0)
  // et une ligne de bus (type 3) — cas fréquent aux grands pôles d'échange
  // (Homme de Fer, Gare Centrale…), à distinguer visuellement des arrêts
  // purement tram ou purement bus.
  function modeStation(station) {
    if (station[5] === "SNCF") return "gare";
    var lignes = Reseau.lignes();
    var tram = false, bus = false;
    station[4].forEach(function (l) {
      if (lignes[l].type === 0) tram = true; else bus = true;
    });
    if (tram && bus) return "mixte";
    return tram ? "tram" : "bus";
  }

  var LIBELLES_MODE = { tram: "Tram", bus: "Bus", mixte: "Tram + Bus", gare: "Gare SNCF" };

  function geojsonStations() {
    var lignes = Reseau.lignes();
    var rang = { gare: 0, mixte: 1, tram: 2, bus: 3 };
    return {
      type: "FeatureCollection",
      features: Reseau.stations().map(function (s, idx) {
        var mode = modeStation(s);
        return {
          type: "Feature",
          id: idx,
          properties: {
            idx: idx, nom: s[1], mode: mode,
            refs: s[4].map(function (l) { return lignes[l].nom; }).join(" "),
            tri: rang[mode]
          },
          geometry: { type: "Point", coordinates: [s[3], s[2]] }
        };
      })
    };
  }

  // ---------- icônes tram / bus / mixte ----------
  // Dessinées au canvas (pas d'asset externe à charger ni à précacher) :
  // pastille colorée + pictogramme emoji, lisible sans dépendre de la seule
  // couleur (accessibilité daltonisme). L'icône « mixte » est une pilule à
  // deux moitiés, une par mode, pour montrer clairement les deux à la fois.
  var iconesPretes = false;

  function canvasRond(couleur, glyphe) {
    var t = 64;
    var c = document.createElement("canvas");
    c.width = t; c.height = t;
    var ctx = c.getContext("2d");
    ctx.beginPath();
    ctx.arc(t / 2, t / 2, t / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = couleur;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.font = "34px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyphe, t / 2, t / 2 + 2);
    return ctx.getImageData(0, 0, t, t);
  }

  function canvasMixte(couleurTram, couleurBus, glypheTram, glypheBus) {
    var l = 96, h = 64, r = h / 2;
    var c = document.createElement("canvas");
    c.width = l; c.height = h;
    var ctx = c.getContext("2d");
    function moitie(x0, x1, couleur) {
      ctx.beginPath();
      ctx.moveTo(x0, 2);
      ctx.lineTo(x1, 2);
      ctx.lineTo(x1, h - 2);
      ctx.lineTo(x0, h - 2);
      ctx.closePath();
      ctx.fillStyle = couleur;
      ctx.fill();
    }
    // corps arrondi aux deux bouts, coupé au milieu par les deux rectangles
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(r, 2);
    ctx.arcTo(2, 2, 2, r, r);
    ctx.arcTo(2, h - 2, r, h - 2, r);
    ctx.lineTo(l - r, h - 2);
    ctx.arcTo(l - 2, h - 2, l - 2, r, r);
    ctx.arcTo(l - 2, 2, l - r, 2, r);
    ctx.closePath();
    ctx.clip();
    moitie(0, l / 2, couleurTram);
    moitie(l / 2, l, couleurBus);
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(r, 2);
    ctx.arcTo(2, 2, 2, r, r);
    ctx.arcTo(2, h - 2, r, h - 2, r);
    ctx.lineTo(l - r, h - 2);
    ctx.arcTo(l - 2, h - 2, l - 2, r, r);
    ctx.arcTo(l - 2, 2, l - r, 2, r);
    ctx.closePath();
    ctx.stroke();
    ctx.font = "28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glypheTram, l / 4, h / 2 + 2);
    ctx.fillText(glypheBus, l * 3 / 4, h / 2 + 2);
    return ctx.getImageData(0, 0, l, h);
  }

  function ajouterIcones() {
    if (carte.hasImage("cts-icone-tram")) return;
    carte.addImage("cts-icone-tram", canvasRond("#c8102e", "🚊"), { pixelRatio: 2 });
    carte.addImage("cts-icone-bus", canvasRond("#1a5fb4", "🚌"), { pixelRatio: 2 });
    carte.addImage("cts-icone-mixte", canvasMixte("#c8102e", "#1a5fb4", "🚊", "🚌"), { pixelRatio: 2 });
    iconesPretes = true;
  }

  /* Idempotente : appelée dès que le réseau est chargé puis à chaque
     « styledata » — un changement de thème reconstruit le style et supprime
     les couches maison. On se fie à « styledata » et non à isStyleLoaded(),
     qui reste faux jusqu'au premier rendu (donc indéfiniment si l'onglet
     n'est pas affiché). */
  function ajouterCouches() {
    // « styledata » peut survenir avant la fin du fetch de reseau.json (pas
    // seulement à l'ouverture de l'app : aussi après chaque changement de
    // thème, qui reconstruit tout le style) — reseauPret() vérifie les
    // données elles-mêmes, pas seulement que l'accesseur existe (toujours
    // vrai). Sans ce garde-fou : exception dans geojsonStations(), la source
    // cts-traces reste seule ajoutée, et le guard ci-dessous bloque alors
    // tout nouvel essai pour le reste de la session.
    if (!carte || !Reseau.reseauPret() || !stylePret) return;
    if (carte.getSource("cts-traces")) return;

    carte.addSource("cts-traces", { type: "geojson", data: "data/cts-traces.geojson" });
    carte.addSource("cts-stations", { type: "geojson", data: geojsonStations() });
    ajouterIcones();

    var vis = visible ? "visible" : "none";
    var sombre = Carte.themeSombre();

    carte.addLayer({
      id: "cts-traces-halo",
      type: "line",
      source: "cts-traces",
      layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": sombre ? "#000000" : "#ffffff",
        "line-opacity": 0.55,
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          11, ["case", ["==", ["get", "mode"], "tram"], 5, 3],
          16, ["case", ["==", ["get", "mode"], "tram"], 11, 7]
        ]
      }
    });

    carte.addLayer({
      id: "cts-traces-lignes",
      type: "line",
      source: "cts-traces",
      layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "couleur"],
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          11, ["case", ["==", ["get", "mode"], "tram"], 3, 1.6],
          16, ["case", ["==", ["get", "mode"], "tram"], 7, 4]
        ]
      }
    });

    carte.addLayer({
      id: "cts-stations-points",
      type: "circle",
      source: "cts-stations",
      layout: { visibility: vis },
      paint: {
        // les gares restent visibles bien plus tôt que les arrêts de bus
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          9, ["match", ["get", "mode"], "gare", 3.5, "tram", 1.5, 0],
          11, ["match", ["get", "mode"], "gare", 5, "tram", 3.5, 1.8],
          14, ["match", ["get", "mode"], "gare", 6.5, "tram", 5.5, 3.5],
          17, ["match", ["get", "mode"], "gare", 9, "tram", 8, 6]
        ],
        "circle-color": sombre ? "#1b1b1b" : "#ffffff",
        "circle-stroke-color": ["match", ["get", "mode"],
          "gare", "#1c1c1c", "tram", "#c8102e", "#1a5fb4"],
        "circle-stroke-width": [
          "interpolate", ["linear"], ["zoom"],
          11, ["case", ["==", ["get", "mode"], "gare"], 2, 1],
          16, ["case", ["==", ["get", "mode"], "gare"], 3.5, 2.5]
        ]
      }
    });

    carte.addLayer({
      id: "cts-stations-noms",
      type: "symbol",
      source: "cts-stations",
      minzoom: 11,
      layout: {
        visibility: vis,
        // au loin, seules les gares sont nommées : les 569 arrêts CTS
        // saturaient la carte
        "text-field": ["step", ["zoom"],
          ["case", ["==", ["get", "mode"], "gare"], ["get", "nom"], ""],
          14, ["get", "nom"]],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 10, 17, 13],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-optional": true,
        "symbol-sort-key": ["get", "tri"]
      },
      paint: {
        "text-color": sombre ? "#f0f0f0" : "#1c1c1c",
        "text-halo-color": sombre ? "#111111" : "#ffffff",
        "text-halo-width": 1.6
      }
    });

    // Pictogrammes tram/bus/mixte, en plus des pastilles ci-dessus (gardées
    // pour rester visibles très dézoomé). N'apparaissent qu'à partir d'un
    // zoom où chaque arrêt est individuellement cliquable, pour ne pas
    // surcharger la carte. Les gares SNCF n'ont pas d'icône dédiée ici
    // (mode "gare" absent du match) : elles gardent leur seule pastille,
    // déjà distincte (plus grande, liseré sombre) — hors du périmètre
    // demandé (distinguer tram/bus).
    carte.addLayer({
      id: "cts-stations-icones",
      type: "symbol",
      source: "cts-stations",
      minzoom: 13,
      layout: {
        visibility: vis,
        "icon-image": ["match", ["get", "mode"],
          "tram", "cts-icone-tram",
          "bus", "cts-icone-bus",
          "mixte", "cts-icone-mixte",
          ""],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.22, 15, 0.32, 18, 0.5],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["get", "tri"]
      }
    });

    // couche d'itinéraire, posée au-dessus et alimentée par itineraires.js
    carte.addSource("trajet", {
      type: "geojson", data: { type: "FeatureCollection", features: [] }
    });
    carte.addLayer({
      id: "trajet-contour",
      type: "line",
      source: "trajet",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": sombre ? "#000000" : "#ffffff",
        "line-width": 10, "line-opacity": 0.8
      }
    });
    // deux couches distinctes : line-dasharray n'accepte pas d'expression
    // liée aux données, un trait pointillé ne peut donc pas être conditionnel
    carte.addLayer({
      id: "trajet-marche",
      type: "line",
      source: "trajet",
      filter: ["==", ["get", "mode"], "marche"],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": sombre ? "#c8c8c8" : "#555555",
        "line-width": 4,
        "line-dasharray": [1, 1.6]
      }
    });
    carte.addLayer({
      id: "trajet-trait",
      type: "line",
      source: "trajet",
      filter: ["!=", ["get", "mode"], "marche"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "couleur"], "line-width": 5.5 }
    });

    if (ligneIsolee) appliquerIsolement();

    ["cts-stations-points", "cts-stations-noms", "cts-stations-icones"].forEach(function (couche) {
      carte.on("click", couche, function (ev) {
        if (ev.features && ev.features.length) {
          ouvrirFicheStation(ev.features[0].properties.idx);
        }
      });
      carte.on("mouseenter", couche, function () {
        carte.getCanvas().style.cursor = "pointer";
      });
      carte.on("mouseleave", couche, function () {
        carte.getCanvas().style.cursor = "";
      });
    });
  }

  function basculerVisibilite(force) {
    visible = typeof force === "boolean" ? force : !visible;
    ["cts-traces-halo", "cts-traces-lignes", "cts-stations-points", "cts-stations-noms", "cts-stations-icones"]
      .forEach(function (id) {
        if (carte.getLayer(id)) {
          carte.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
        }
      });
    document.getElementById("btn-transports").setAttribute("aria-pressed", String(visible));
    document.getElementById("chips").hidden = !visible;
    if (!visible) fermerFiche();
    return visible;
  }

  function appliquerIsolement() {
    var filtre = ligneIsolee ? ["==", ["get", "ref"], ligneIsolee] : null;
    ["cts-traces-halo", "cts-traces-lignes"].forEach(function (id) {
      if (carte.getLayer(id)) carte.setFilter(id, filtre);
    });
    if (carte.getLayer("cts-stations-points")) {
      var filtreStations = null;
      if (ligneIsolee) {
        var idxLigne = -1;
        Reseau.lignes().forEach(function (l, i) { if (l.nom === ligneIsolee) idxLigne = i; });
        var idsStations = [];
        Reseau.stations().forEach(function (s, i) {
          if (s[4].indexOf(idxLigne) !== -1) idsStations.push(i);
        });
        filtreStations = ["in", ["get", "idx"], ["literal", idsStations]];
      }
      carte.setFilter("cts-stations-points", filtreStations);
      carte.setFilter("cts-stations-noms", filtreStations);
      if (carte.getLayer("cts-stations-icones")) {
        carte.setFilter("cts-stations-icones", filtreStations);
      }
    }
    var indicateur = document.getElementById("chip-isolement");
    if (ligneIsolee) {
      indicateur.hidden = false;
      indicateur.textContent = "Ligne " + ligneIsolee + " ✕";
    } else {
      indicateur.hidden = true;
    }
  }

  function isoler(ref) {
    ligneIsolee = ref || null;
    appliquerIsolement();
  }

  // ---------- fiche (panneau bas) ----------
  function elementFiche() { return document.getElementById("fiche"); }

  function fermerFiche() {
    elementFiche().hidden = true;
    document.getElementById("fiche-corps").textContent = "";
    effacerTrajet();
  }

  function effacerTrajet() {
    if (carte && carte.getSource("trajet")) {
      carte.getSource("trajet").setData({ type: "FeatureCollection", features: [] });
    }
  }

  /* Alimente la couche d'itinéraire ; appelée par itineraires.js. */
  function dessinerTrajet(features) {
    if (!carte || !carte.getSource("trajet")) return;
    carte.getSource("trajet").setData({ type: "FeatureCollection", features: features });
    var bornes = new maplibregl.LngLatBounds();
    features.forEach(function (f) {
      f.geometry.coordinates.forEach(function (c) { bornes.extend(c); });
    });
    if (!bornes.isEmpty()) {
      carte.fitBounds(bornes, { padding: { top: 90, bottom: 340, left: 40, right: 40 } });
    }
  }

  function badgeLigne(idxLigne) {
    var l = Reseau.lignes()[idxLigne];
    var span = document.createElement("span");
    span.className = "badge";
    span.textContent = l.nom;
    span.style.backgroundColor = l.couleur;
    span.style.color = l.texte;
    span.title = l.desc;
    return span;
  }

  function ouvrirFiche(titre, sousTitre) {
    var fiche = elementFiche();
    fiche.hidden = false;
    document.getElementById("fiche-titre").textContent = titre;
    document.getElementById("fiche-sous-titre").textContent = sousTitre || "";
    var corps = document.getElementById("fiche-corps");
    corps.textContent = "";
    corps.scrollTop = 0;
    return corps;
  }

  /* Attente relative pour ce qui arrive dans l'heure, heure d'horloge au-delà :
     « 3 min » est plus parlant qu'un horaire, « 22:03 » plus qu'« dans 815 min ». */
  function ligneDePassages(groupe) {
    var l = document.createElement("div");
    l.className = "passage";
    l.appendChild(badgeLigne(groupe.ligne));

    var dest = document.createElement("span");
    dest.className = "destination";
    dest.textContent = Reseau.destinations()[groupe.dest];
    l.appendChild(dest);

    var heures = document.createElement("span");
    heures.className = "heures";
    heures.textContent = groupe.passages.map(function (p) {
      if (p.dans === null || p.dans > 60) return formaterHeure(p.heure);
      if (p.dans === 0) return "à l'approche";
      return p.dans + " min";
    }).join(" · ");
    l.appendChild(heures);
    return l;
  }

  // ---------- lignes et directions (arrêt suivant dans chaque sens) ----------

  /* Pour chaque ligne desservant la station, ses directions (identifiées par
     leur terminus) qui passent par cette station, et l'arrêt suivant dans
     chacune. S'appuie sur `ligne.parcours` (reseau.json) — le même jeu de
     tracés déjà utilisé par la fiche ligne (ouvrirFicheLigne) — plutôt que
     de reparcourir les motifs horaires : ce sont les tracés canoniques des
     deux sens (jusqu'à 4 pour une ligne à branches), pas les variantes de
     service ponctuelles (renforts, courses tronquées) qui gonfleraient la
     liste sans rien apporter d'utile ici. */
  function directionsStation(idxStation) {
    var lignes = Reseau.lignes();
    var station = Reseau.stations()[idxStation];
    return station[4].map(function (idxLigne) {
      var parDest = {};
      lignes[idxLigne].parcours.forEach(function (pair) {
        var arrets = pair[1], position = arrets.indexOf(idxStation);
        if (position === -1) return;
        var prochain = position + 1 < arrets.length ? arrets[position + 1] : null;
        var existant = parDest[pair[0]];
        if (!existant || (existant.prochain === null && prochain !== null)) {
          parDest[pair[0]] = { dest: pair[0], prochain: prochain };
        }
      });
      var directions = Object.keys(parDest).map(function (k) { return parDest[k]; });
      directions.sort(function (a, b) {
        return Reseau.destinations()[a.dest].localeCompare(Reseau.destinations()[b.dest], "fr");
      });
      return { idxLigne: idxLigne, directions: directions };
    }).filter(function (e) { return e.directions.length; })
      .sort(function (a, b) {
        return lignes[a.idxLigne].nom.localeCompare(lignes[b.idxLigne].nom, "fr", { numeric: true });
      });
  }

  function blocDirections(entreeLigne) {
    var bloc = document.createElement("div");
    bloc.className = "ligne-directions";
    var titre = document.createElement("h4");
    titre.appendChild(badgeLigne(entreeLigne.idxLigne));
    bloc.appendChild(titre);

    var ul = document.createElement("ul");
    ul.className = "directions";
    entreeLigne.directions.forEach(function (d) {
      var li = document.createElement("li");
      var nom = document.createElement("span");
      nom.className = "direction-nom";
      nom.textContent = "Direction " + Reseau.destinations()[d.dest];
      li.appendChild(nom);
      var prochain = document.createElement("span");
      prochain.className = "direction-prochain";
      prochain.textContent = d.prochain !== null
        ? "prochain arrêt : " + Reseau.stations()[d.prochain][1]
        : "terminus de cette ligne";
      li.appendChild(prochain);
      ul.appendChild(li);
    });
    bloc.appendChild(ul);
    return bloc;
  }

  function ouvrirFicheStation(idxStation) {
    var station = Reseau.stations()[idxStation];
    ouvrirFiche(station[1], "Chargement des horaires…");

    Reseau.charger().then(function () {
      var maintenant = new Date();
      var gare = station[5] === "SNCF";
      var corps = ouvrirFiche(
        (gare ? "Gare de " : "") + station[1],
        JOURS[Reseau.jourSemaineLundi0(maintenant)] + " " +
          formaterHeure(Reseau.minuteDuJour(maintenant)) + " · horaires théoriques" +
          (gare ? " SNCF" : "")
      );

      var mode = document.createElement("p");
      mode.className = "mode-arret";
      mode.textContent = LIBELLES_MODE[modeStation(station)];
      corps.appendChild(mode);

      var badges = document.createElement("div");
      badges.className = "badges";
      station[4].forEach(function (idxLigne) {
        var b = badgeLigne(idxLigne);
        b.setAttribute("role", "button");
        b.tabIndex = 0;
        b.addEventListener("click", function () { ouvrirFicheLigne(idxLigne); });
        badges.appendChild(b);
      });
      corps.appendChild(badges);

      // directions et arrêt suivant : information structurelle (toujours
      // valable), distincte des horaires réels ci-dessous
      if (!gare) {
        var directions = directionsStation(idxStation);
        if (directions.length) {
          var titreDirections = document.createElement("h3");
          titreDirections.textContent = "Lignes et directions";
          corps.appendChild(titreDirections);
          directions.forEach(function (e) { corps.appendChild(blocDirections(e)); });
        }
      }

      // liens vers le calcul d'itinéraire
      var actions = document.createElement("div");
      actions.className = "actions";
      [["Partir d'ici", "definirDepart"], ["Aller ici", "definirArrivee"]]
        .forEach(function (paire) {
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = paire[0];
          b.addEventListener("click", function () {
            Itineraires[paire[1]]({
              lat: station[2], lon: station[3], nom: station[1]
            });
            Itineraires.ouvrir();
          });
          actions.appendChild(b);
        });
      corps.appendChild(actions);

      // sans borne haute : la journée peut n'avoir de desserte qu'en soirée
      // (travaux d'été, service réduit), et l'annoncer vaut mieux que
      // renvoyer l'utilisateur au lendemain.
      var titrePassages = document.createElement("h3");
      titrePassages.textContent = "Prochains passages";
      corps.appendChild(titrePassages);
      var conteneurPassages = document.createElement("div");
      corps.appendChild(conteneurPassages);
      var groupes = prochainsPassages(idxStation, maintenant, Infinity);
      if (groupes.length) {
        if (groupes[0].passages[0].dans > 180) {
          var creux = document.createElement("p");
          creux.className = "note";
          creux.textContent = "Aucun passage dans les 3 prochaines heures ; reprise à "
            + formaterHeure(groupes[0].passages[0].heure) + ".";
          conteneurPassages.appendChild(creux);
        }
        groupes.forEach(function (g) { conteneurPassages.appendChild(ligneDePassages(g)); });
      } else {
        var suite = premiersPassages(idxStation, maintenant);
        var vide = document.createElement("p");
        vide.className = "note";
        vide.textContent = suite
          ? "Plus de passage aujourd'hui. Premiers départs " +
            JOURS[Reseau.jourSemaineLundi0(suite.jour)] + " :"
          : "Aucun passage connu à cet arrêt.";
        conteneurPassages.appendChild(vide);
        if (suite) {
          suite.liste.forEach(function (g) { conteneurPassages.appendChild(ligneDePassages(g)); });
        }
      }
      // remplace silencieusement les horaires théoriques ci-dessus si le
      // mode en ligne est configuré et répond à temps ; sinon ils restent.
      TempsReel.essayerStation(station, conteneurPassages);

      var pied = document.createElement("p");
      pied.className = "note";
      pied.textContent = gare
        ? "Horaires théoriques SNCF, sans tenir compte du trafic. Les trains " +
          "au départ vers l'extérieur de l'agglomération sont indiqués par leur " +
          "terminus ; tarifs et réservation sur sncf-connect.com."
        : "Horaires théoriques CTS — sans tenir compte du trafic.";
      corps.appendChild(pied);
    }).catch(function (e) {
      ouvrirFiche(station[1], "").textContent = "Horaires indisponibles : " + e.message;
    });
  }

  function ouvrirFicheLigne(idxLigne) {
    var l = Reseau.lignes()[idxLigne];
    var corps = ouvrirFiche((l.type === 0 ? "Tram " : "Bus ") + l.nom, l.desc);

    var actions = document.createElement("div");
    actions.className = "actions";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = ligneIsolee === l.nom ? "Afficher tout le réseau" : "Isoler sur la carte";
    btn.addEventListener("click", function () {
      isoler(ligneIsolee === l.nom ? null : l.nom);
      ouvrirFicheLigne(idxLigne);
    });
    actions.appendChild(btn);
    corps.appendChild(actions);

    if (!l.parcours.length) {
      var p = document.createElement("p");
      p.className = "note";
      p.textContent = "Parcours non disponible pour cette ligne.";
      corps.appendChild(p);
      return;
    }

    l.parcours.forEach(function (pair) {
      var titre = document.createElement("h3");
      titre.textContent = "→ " + Reseau.destinations()[pair[0]] +
        " (" + pair[1].length + " arrêts)";
      corps.appendChild(titre);

      var ul = document.createElement("ul");
      ul.className = "parcours";
      pair[1].forEach(function (idxStation) {
        var li = document.createElement("li");
        li.textContent = Reseau.stations()[idxStation][1];
        li.addEventListener("click", function () {
          var s = Reseau.stations()[idxStation];
          Carte.instance().flyTo({ center: [s[3], s[2]], zoom: 16 });
          ouvrirFicheStation(idxStation);
        });
        ul.appendChild(li);
      });
      corps.appendChild(ul);
    });
  }

  function ouvrirListeLignes() {
    var lignes = Reseau.lignes();
    var corps = ouvrirFiche("Lignes CTS", lignes.length + " lignes");
    var groupes = [
      ["Tram", function (l) { return l.type === 0; }],
      ["Lignes structurantes", function (l) { return /^C\d/.test(l.nom); }],
      ["Bus de nuit", function (l) { return /^N\d/.test(l.nom); }],
      ["Substitution", function (l) { return /^Remplacement/i.test(l.nom); }],
      ["Bus", function () { return true; }]
    ];
    var restants = lignes.map(function (l, i) { return i; });

    groupes.forEach(function (g) {
      var pris = restants.filter(function (i) { return g[1](lignes[i]); });
      if (!pris.length) return;
      restants = restants.filter(function (i) { return pris.indexOf(i) === -1; });

      var titre = document.createElement("h3");
      titre.textContent = g[0];
      corps.appendChild(titre);

      var grille = document.createElement("div");
      grille.className = "grille-lignes";
      pris.sort(function (a, b) {
        return lignes[a].nom.localeCompare(lignes[b].nom, "fr", { numeric: true });
      });
      pris.forEach(function (i) {
        var bouton = document.createElement("button");
        bouton.type = "button";
        bouton.className = "carte-ligne";
        bouton.appendChild(badgeLigne(i));
        var texte = document.createElement("span");
        texte.textContent = lignes[i].desc;
        bouton.appendChild(texte);
        bouton.addEventListener("click", function () { ouvrirFicheLigne(i); });
        grille.appendChild(bouton);
      });
      corps.appendChild(grille);
    });
  }

  function ouvrirTarifs() {
    ouvrirFiche("Tarifs CTS", "Chargement…");
    var promesse = tarifs
      ? Promise.resolve(tarifs)
      : fetch("data/cts-tarifs.json").then(function (r) { return r.json(); })
          .then(function (d) { tarifs = d; return d; });

    promesse.then(function (t) {
      var corps = ouvrirFiche("Tarifs CTS", t.produits.length + " titres");
      var table = document.createElement("table");
      table.className = "tarifs";
      var tbody = document.createElement("tbody");
      t.produits.forEach(function (p) {
        var tr = document.createElement("tr");
        var tdNom = document.createElement("td");
        tdNom.textContent = p.nom;
        if (p.categorie) {
          var petit = document.createElement("small");
          petit.textContent = p.categorie;
          tdNom.appendChild(document.createElement("br"));
          tdNom.appendChild(petit);
        }
        var tdSupports = document.createElement("td");
        tdSupports.className = "supports";
        tdSupports.textContent = p.supports.join(", ");
        var tdPrix = document.createElement("td");
        tdPrix.className = "prix";
        tdPrix.textContent = p.prix === 0 ? "gratuit" : p.prix.toFixed(2) + " €";
        tr.appendChild(tdNom);
        tr.appendChild(tdSupports);
        tr.appendChild(tdPrix);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      corps.appendChild(table);

      var note = document.createElement("p");
      note.className = "note";
      note.textContent = "Grille tarifaire embarquée (GTFS-Fares CTS) — à vérifier " +
        "auprès de la CTS avant achat.";
      corps.appendChild(note);
    }).catch(function (e) {
      ouvrirFiche("Tarifs CTS", "").textContent = "Tarifs indisponibles : " + e.message;
    });
  }

  // ---------- mise en route ----------
  function initialiser(instanceCarte) {
    carte = instanceCarte;

    document.getElementById("fiche-fermer").addEventListener("click", fermerFiche);
    document.getElementById("btn-transports").addEventListener("click", function () {
      basculerVisibilite();
    });
    document.getElementById("chip-lignes").addEventListener("click", ouvrirListeLignes);
    document.getElementById("chip-tarifs").addEventListener("click", ouvrirTarifs);
    document.getElementById("chip-isolement").addEventListener("click", function () {
      isoler(null);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !elementFiche().hidden) fermerFiche();
    });
    Itineraires.initialiser();
    Musees.initialiser(carte);
    Commerces.initialiser(carte);
    Poi.initialiser(carte);
    TempsReel.initialiser();

    carte.on("styledata", function () {
      stylePret = true;
      ajouterCouches();
    });
    if (carte.isStyleLoaded()) stylePret = true;

    Reseau.chargerReseauSeul().then(function () {
      ajouterCouches();

      // arrêts et gares deviennent cherchables au même titre que les rues
      var lignes = Reseau.lignes();
      Carte.ajouterEntreesRecherche(Reseau.stations().map(function (s, idx) {
        var refs = s[4].map(function (l) { return lignes[l].nom; }).join(" ");
        var gare = s[5] === "SNCF";
        return [s[1], s[2], s[3], "arret", gare ? "gare SNCF" : refs, idx];
      }));

      // préchargement discret : la première fiche s'ouvre alors sans attente
      var differer = window.requestIdleCallback || function (f) { setTimeout(f, 2000); };
      differer(function () { Reseau.charger().catch(function () {}); });
    }).catch(function (e) {
      console.warn("Réseau CTS indisponible :", e.message);
      document.getElementById("btn-transports").disabled = true;
      document.getElementById("chips").hidden = true;
    });
  }

  return {
    initialiser: initialiser,
    ouvrirFiche: ouvrirFiche,
    fermerFiche: fermerFiche,
    ouvrirFicheStation: ouvrirFicheStation,
    ouvrirFicheLigne: ouvrirFicheLigne,
    badgeLigne: badgeLigne,
    formaterHeure: formaterHeure,
    dessinerTrajet: dessinerTrajet,
    effacerTrajet: effacerTrajet,
    // exposés pour les contrôles manuels
    prochainsPassages: function (i, d, f) {
      return prochainsPassages(i, d, f === undefined ? 180 : f);
    },
    premiersPassages: premiersPassages
  };
})();

/* Amorçage : ce script est chargé en dernier, `Carte`, `Reseau` et
   `Itineraires` sont donc disponibles. On n'attend pas l'événement « load » de
   la carte, qui suppose un premier rendu et n'arrive jamais si l'onglet reste
   masqué ; les couches sont posées sur « styledata ». */
Transports.initialiser(Carte.instance());
