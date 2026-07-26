/* Strasbourg & Eurométropole — socle carte
   MapLibre GL + PMTiles locales, thème clair/sombre, 3D, recherche de rues.
   Expose le namespace `Carte`, dont dépend transports.js. */
"use strict";

var Carte = (function () {
  // ---------- Configuration ----------
  var VUE_INITIALE = { center: [7.7521, 48.5734], zoom: 14.5 }; // cathédrale
  var LIMITES = [[7.45, 48.37], [7.97, 48.73]];                 // bbox EMS + marge
  var URL_TUILES = new URL("data/tiles.pmtiles", location.href).href;
  var URL_GLYPHES = new URL("assets/glyphs/", location.href).href + "{fontstack}/{range}.pbf";

  var protocole = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocole.tile.bind(protocole));

  // ---------- Thème ----------
  function themeInitial() {
    var memorise = localStorage.getItem("theme");
    if (memorise === "clair" || memorise === "sombre") return memorise;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "sombre" : "clair";
  }

  var theme = themeInitial();
  var en3D = false;

  function construireStyle(nomTheme) {
    var flavorNom = nomTheme === "sombre" ? "dark" : "light";
    var flavor = basemaps.namedFlavor(flavorNom);
    var couches = basemaps.layers("protomaps", flavor, { lang: "fr" });

    // `place=locality` (OSM) désigne des lieux-dits historiques sans
    // population réelle (Flurnamen alsaciens, souvent en allemand : « Auf
    // den Stadtweg », « Neben dem Kreuzpfad »…), à distinguer des vrais
    // villages (`kind_detail` = village/town/city, eux toujours nommés en
    // français). Masqués : ce ne sont pas des toponymes utiles à la
    // navigation, seulement du bruit cartographique dans ce cas précis.
    couches.forEach(function (c) {
      if (c.id === "places_locality") {
        c.filter = ["all", c.filter, ["!=", "kind_detail", "locality"]];
      }
    });

    // Couche 3D maison (les tuiles portent height / min_height)
    couches.push({
      id: "batiments-3d",
      type: "fill-extrusion",
      source: "protomaps",
      "source-layer": "buildings",
      minzoom: 14,
      layout: { visibility: en3D ? "visible" : "none" },
      paint: {
        "fill-extrusion-color": flavor.buildings,
        "fill-extrusion-height": ["coalesce", ["get", "height"], 8],
        "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
        "fill-extrusion-opacity": 0.85
      }
    });

    return {
      version: 8,
      glyphs: URL_GLYPHES,
      sprite: new URL("assets/sprites/v4/" + flavorNom, location.href).href,
      sources: {
        protomaps: {
          type: "vector",
          url: "pmtiles://" + URL_TUILES,
          attribution: "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> · <a href=\"https://protomaps.com\">Protomaps</a>"
        }
      },
      layers: couches
    };
  }

  function appliquerTheme() {
    document.body.classList.toggle("sombre", theme === "sombre");
    localStorage.setItem("theme", theme);
  }
  appliquerTheme();

  // ---------- Carte ----------
  var carte = new maplibregl.Map({
    container: "carte",
    style: construireStyle(theme),
    center: VUE_INITIALE.center,
    zoom: VUE_INITIALE.zoom,
    minZoom: 8,
    maxZoom: 19,
    maxBounds: LIMITES,
    attributionControl: { compact: true }
  });

  carte.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  carte.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true
  }), "top-right");
  carte.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  /* Le style de Protomaps référence quelques pictogrammes absents du jeu de
     sprites officiel (townhall, hospital, station). Un substitut transparent
     évite un avertissement par tuile ; le libellé du lieu reste affiché. */
  carte.on("styleimagemissing", function (ev) {
    if (!carte.hasImage(ev.id)) {
      carte.addImage(ev.id, { width: 1, height: 1, data: new Uint8Array(4) });
    }
  });

  // ---------- Boutons ----------
  var btnTheme = document.getElementById("btn-theme");
  var btn3D = document.getElementById("btn-3d");

  btnTheme.addEventListener("click", function () {
    theme = theme === "sombre" ? "clair" : "sombre";
    appliquerTheme();
    carte.setStyle(construireStyle(theme));
  });

  btn3D.addEventListener("click", function () {
    en3D = !en3D;
    btn3D.setAttribute("aria-pressed", String(en3D));
    if (carte.getLayer("batiments-3d")) {
      carte.setLayoutProperty("batiments-3d", "visibility", en3D ? "visible" : "none");
    }
    carte.easeTo({ pitch: en3D ? 60 : 0, duration: 600 });
  });

  // ---------- Recherche ----------
  var champ = document.getElementById("champ-recherche");
  var listeResultats = document.getElementById("resultats");
  // entrée : [nom, lat, lon, type, contexte, données propres au type]
  var indexRues = null;
  var entreesExternes = [];   // injectées par transports.js (arrêts CTS)
  var index = null;
  var indexNormalise = null;
  var marqueur = null;
  var selection = -1;
  var affiches = [];

  function normaliser(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function reconstruireIndex() {
    index = (indexRues || []).concat(entreesExternes);
    indexNormalise = index.map(function (e) { return normaliser(e[0]); });
  }

  function chargerIndex() {
    if (indexRues) return Promise.resolve();
    return fetch("data/rues.json")
      .then(function (r) { return r.json(); })
      .then(function (donnees) {
        indexRues = donnees;
        reconstruireIndex();
      });
  }

  /* Permet à transports.js d'ajouter les arrêts CTS à la recherche. */
  function ajouterEntreesRecherche(entrees) {
    entreesExternes = entreesExternes.concat(entrees);
    if (indexRues) reconstruireIndex();
  }

  function fermerResultats() {
    listeResultats.hidden = true;
    listeResultats.textContent = "";
    selection = -1;
    affiches = [];
  }

  function allerA(entree) {
    fermerResultats();
    champ.value = entree[0];
    champ.blur();

    // arrêts et musées ouvrent directement leur fiche, sans marqueur
    if (typeof entree[5] === "number" &&
        (entree[3] === "arret" || entree[3] === "musee")) {
      if (marqueur) { marqueur.remove(); marqueur = null; }
      carte.flyTo({ center: [entree[2], entree[1]], zoom: 16.5 });
      if (entree[3] === "arret") Transports.ouvrirFicheStation(entree[5]);
      else Musees.ouvrirFiche(entree[5]);
      return;
    }

    if (marqueur) marqueur.remove();
    marqueur = new maplibregl.Marker({ color: "#1a5fb4" })
      .setLngLat([entree[2], entree[1]])
      .addTo(carte);
    carte.flyTo({ center: [entree[2], entree[1]], zoom: entree[3] === "lieu" ? 14.5 : 16.5 });
  }

  /* Entrées correspondant à la requête, les plus pertinentes d'abord.
     L'index doit avoir été chargé (voir chercher()). */
  function trouver(requete, maximum) {
    var q = normaliser(requete.trim());
    if (q.length < 2 || !indexNormalise) return [];

    var resultats = [];
    for (var i = 0; i < indexNormalise.length && resultats.length < 60; i++) {
      var pos = indexNormalise[i].indexOf(q);
      if (pos !== -1) resultats.push([pos, i]);
    }
    // priorité aux noms qui commencent par la requête, puis aux arrêts
    resultats.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] - b[0];
      var arretA = index[a[1]][3] === "arret" ? 0 : 1;
      var arretB = index[b[1]][3] === "arret" ? 0 : 1;
      return arretA - arretB;
    });
    return resultats.slice(0, maximum).map(function (r) { return index[r[1]]; });
  }

  /* Recherche utilisable par les autres modules (champs d'itinéraire). */
  function chercher(requete, maximum) {
    return chargerIndex().then(function () {
      return trouver(requete, maximum || 8);
    });
  }

  function afficherResultats(requete) {
    if (normaliser(requete.trim()).length < 2) { fermerResultats(); return; }
    var resultats = trouver(requete, 9);

    listeResultats.textContent = "";
    selection = -1;
    affiches = [];

    if (resultats.length === 0) {
      var vide = document.createElement("li");
      vide.className = "vide";
      vide.textContent = "Aucun résultat";
      listeResultats.appendChild(vide);
    } else {
      resultats.forEach(function (entree) {
        affiches.push(entree);
        var li = document.createElement("li");
        var nom = document.createElement("span");
        nom.textContent = entree[0];
        var type = document.createElement("span");
        var remarquable = entree[3] === "arret" || entree[3] === "musee";
        type.className = "type" + (remarquable ? " arret" : "");
        if (entree[3] === "arret") type.textContent = "arrêt " + (entree[4] || "");
        else if (entree[3] === "musee") type.textContent = "musée";
        else if (entree[3] === "lieu") type.textContent = "localité";
        else type.textContent = entree[4] || "rue";
        li.appendChild(nom);
        li.appendChild(type);
        li.addEventListener("mousedown", function (ev) {
          ev.preventDefault(); // conserve le focus, évite blur avant le clic
          allerA(entree);
        });
        listeResultats.appendChild(li);
      });
    }
    listeResultats.hidden = false;
  }

  function majSelection(delta) {
    var items = listeResultats.querySelectorAll("li:not(.vide)");
    if (items.length === 0) return;
    if (selection >= 0) items[selection].classList.remove("actif");
    selection = (selection + delta + items.length) % items.length;
    items[selection].classList.add("actif");
    items[selection].scrollIntoView({ block: "nearest" });
  }

  champ.addEventListener("input", function () {
    chargerIndex().then(function () { afficherResultats(champ.value); });
  });
  champ.addEventListener("focus", function () {
    if (champ.value.trim().length >= 2) {
      chargerIndex().then(function () { afficherResultats(champ.value); });
    }
  });
  champ.addEventListener("blur", function () {
    setTimeout(fermerResultats, 150);
  });
  champ.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); majSelection(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); majSelection(-1); }
    else if (ev.key === "Enter") {
      var cible = selection >= 0 ? affiches[selection] : affiches[0];
      if (cible) allerA(cible);
    } else if (ev.key === "Escape") {
      fermerResultats();
      champ.blur();
    }
  });

  return {
    instance: function () { return carte; },
    themeSombre: function () { return theme === "sombre"; },
    ajouterEntreesRecherche: ajouterEntreesRecherche,
    chercher: chercher
  };
})();
