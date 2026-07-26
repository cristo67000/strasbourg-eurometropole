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
  function modeStation(station) {
    if (station[5] === "SNCF") return "gare";
    var lignes = Reseau.lignes();
    return station[4].some(function (l) { return lignes[l].type === 0; })
      ? "tram" : "bus";
  }

  function geojsonStations() {
    var lignes = Reseau.lignes();
    var rang = { gare: 0, tram: 1, bus: 2 };
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

  /* Idempotente : appelée dès que le réseau est chargé puis à chaque
     « styledata » — un changement de thème reconstruit le style et supprime
     les couches maison. On se fie à « styledata » et non à isStyleLoaded(),
     qui reste faux jusqu'au premier rendu (donc indéfiniment si l'onglet
     n'est pas affiché). */
  function ajouterCouches() {
    if (!carte || !Reseau.stations || !stylePret) return;
    if (carte.getSource("cts-traces")) return;

    carte.addSource("cts-traces", { type: "geojson", data: "data/cts-traces.geojson" });
    carte.addSource("cts-stations", { type: "geojson", data: geojsonStations() });

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

    ["cts-stations-points", "cts-stations-noms"].forEach(function (couche) {
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
    ["cts-traces-halo", "cts-traces-lignes", "cts-stations-points", "cts-stations-noms"]
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
