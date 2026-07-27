/* Bulle d'info (horaires + site web) pour les restaurants, cafés, bars,
   bureaux de poste, librairies, médiathèques, pharmacies et épiceries bio.

   Deux mécanismes cohabitent, selon que la catégorie est déjà affichée par
   le fond de carte ou non :
   - restaurants/cafés/bars/postes/librairies/médiathèques : déjà des points
     visibles de la couche « pois » du style Protomaps (posée par app.js) —
     ce module se contente de les rendre cliquables, sans ajouter de couche.
   - pharmacies/épiceries bio : absentes du fond de carte (vérifié par
     introspection — pas de genre « organic », et « pharmacy » existe dans
     les tuiles mais sans icône dans le jeu de sprites) — ce module leur
     ajoute sa propre couche de marqueurs, comme musees.js pour les musées.

   Dans les deux cas, même détail (OpenStreetMap) et même fiche. Horaires
   délégués à Musees.etatOuverture/resume, chargé avant ce script. */
"use strict";

var Commerces = (function () {
  var donnees = null;
  var chargement = null;
  var carte = null;
  var stylePret = false;
  var DISTANCE_MAX_M = 40;

  var LIBELLES = {
    restaurant: "Restaurant",
    cafe: "Café",
    bar: "Bar",
    post_office: "Bureau de poste",
    books: "Librairie",
    library: "Médiathèque",
    pharmacy: "Pharmacie",
    organic: "Épicerie bio"
  };

  // catégories sans équivalent dans le fond de carte : celles-ci seules
  // reçoivent une couche de marqueurs dédiée (voir ajouterCouches ci-dessous)
  var CATEGORIES_COUCHE_DEDIEE = ["pharmacy", "organic"];
  var COULEURS_COUCHE_DEDIEE = { pharmacy: "#2e7d32", organic: "#8d6e63" };
  var GLYPHES_COUCHE_DEDIEE = { pharmacy: "\u{1F48A}", organic: "\u{1F331}" };

  function charger() {
    if (chargement) return chargement;
    chargement = fetch("data/commerces.json")
      .then(function (r) {
        if (!r.ok) throw new Error("commerces.json indisponible");
        return r.json();
      })
      .then(function (d) { donnees = d; return d; });
    return chargement;
  }

  function distanceM(lat1, lon1, lat2, lon2) {
    return Math.hypot((lon1 - lon2) * 74000.0, (lat1 - lat2) * 111200.0);
  }

  // ---------- couche dédiée (pharmacies, épiceries bio) ----------
  // Icône dessinée au canvas (pastille colorée + emoji), pas d'asset à
  // précacher — même technique que les pictogrammes tram/bus de
  // transports.js, dupliquée ici en une quinzaine de lignes plutôt que
  // partagée entre modules pour ce seul besoin.
  function icone(couleur, glyphe) {
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

  function geojsonCoucheDediee() {
    var features = [];
    donnees.lieux.forEach(function (l, idx) {
      if (CATEGORIES_COUCHE_DEDIEE.indexOf(l.categorie) === -1) return;
      features.push({
        type: "Feature", id: idx,
        properties: { idx: idx, nom: l.nom, categorie: l.categorie },
        geometry: { type: "Point", coordinates: [l.lon, l.lat] }
      });
    });
    return { type: "FeatureCollection", features: features };
  }

  function ajouterCouches() {
    if (!carte || !donnees || !stylePret) return;
    if (carte.getSource("commerces-dedies")) return;
    var sombre = Carte.themeSombre();

    carte.addSource("commerces-dedies", { type: "geojson", data: geojsonCoucheDediee() });
    CATEGORIES_COUCHE_DEDIEE.forEach(function (cat) {
      if (!carte.hasImage("commerce-" + cat)) {
        carte.addImage("commerce-" + cat, icone(COULEURS_COUCHE_DEDIEE[cat], GLYPHES_COUCHE_DEDIEE[cat]),
          { pixelRatio: 2 });
      }
    });

    carte.addLayer({
      id: "commerces-dedies-points",
      type: "circle",
      source: "commerces-dedies",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3, 15, 5, 17, 7],
        "circle-color": ["match", ["get", "categorie"],
          "pharmacy", COULEURS_COUCHE_DEDIEE.pharmacy,
          "organic", COULEURS_COUCHE_DEDIEE.organic,
          "#616161"],
        "circle-stroke-color": sombre ? "#1b1b1b" : "#ffffff",
        "circle-stroke-width": 2
      }
    });
    carte.addLayer({
      id: "commerces-dedies-icones",
      type: "symbol",
      source: "commerces-dedies",
      minzoom: 14,
      layout: {
        "icon-image": ["match", ["get", "categorie"],
          "pharmacy", "commerce-pharmacy",
          "organic", "commerce-organic",
          ""],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.28, 17, 0.45],
        "icon-allow-overlap": true,
        "text-field": ["get", "nom"],
        "text-font": ["Noto Sans Medium"],
        "text-size": 10,
        "text-offset": [0, 1.3],
        "text-anchor": "top",
        "text-optional": true
      },
      paint: {
        "text-color": sombre ? "#f0f0f0" : "#1c1c1c",
        "text-halo-color": sombre ? "#111111" : "#ffffff",
        "text-halo-width": 1.6
      }
    });

    ["commerces-dedies-points", "commerces-dedies-icones"].forEach(function (couche) {
      carte.on("click", couche, function (ev) {
        if (!ev.features || !ev.features.length) return;
        var idx = ev.features[0].properties.idx;
        charger().then(function () { ouvrirFiche(donnees.lieux[idx]); });
      });
      carte.on("mouseenter", couche, function () { carte.getCanvas().style.cursor = "pointer"; });
      carte.on("mouseleave", couche, function () { carte.getCanvas().style.cursor = ""; });
    });
  }

  /* Le clic tombe sur un point du fond de carte (Protomaps), pas directement
     sur une entrée de commerces.json : on rapproche par catégorie + plus
     proche voisin, comme musees.py le fait déjà pour d'autres sources. Un
     même lieu OSM donne presque toujours une position identique des deux
     côtés (même base de données) — la marge de 40 m couvre les écarts
     d'arrondi et les cas où le point du fond de carte est le centroïde d'un
     bâtiment plutôt que le nœud exact. */
  function trouver(categorie, lat, lon) {
    if (!donnees) return null;
    var meilleur = null, dMin = DISTANCE_MAX_M;
    donnees.lieux.forEach(function (l) {
      if (l.categorie !== categorie) return;
      var d = distanceM(lat, lon, l.lat, l.lon);
      if (d < dMin) { dMin = d; meilleur = l; }
    });
    return meilleur;
  }

  function ligneEtatOuverture(horaires) {
    var etat = Musees.etatOuverture(horaires, new Date());
    var ligne = document.createElement("div");
    ligne.className = "ligne-etat";
    var pastille = document.createElement("span");
    pastille.className = "pastille " + etat.etat;
    pastille.textContent = etat.etat === "ouvert" ? "Ouvert"
      : etat.etat === "ferme" ? "Fermé" : "Horaires à vérifier";
    ligne.appendChild(pastille);
    if (etat.texte) {
      var detail = document.createElement("span");
      detail.className = "detail-etat";
      detail.textContent = etat.texte;
      ligne.appendChild(detail);
    }
    return ligne;
  }

  function ouvrirFiche(lieu) {
    var corps = Transports.ouvrirFiche(lieu.nom, LIBELLES[lieu.categorie] || "");

    if (lieu.description) {
      var desc = document.createElement("p");
      desc.className = "description-lieu";
      desc.textContent = lieu.description;
      corps.appendChild(desc);
    }

    if (lieu.horaires) {
      corps.appendChild(ligneEtatOuverture(lieu.horaires));
      var lignes = Musees.resume(lieu.horaires);
      if (lignes) {
        var ul = document.createElement("ul");
        ul.className = "horaires-resume";
        lignes.forEach(function (texte) {
          var li = document.createElement("li");
          li.textContent = texte;
          ul.appendChild(li);
        });
        corps.appendChild(ul);
      } else {
        // syntaxe hors du sous-ensemble reconnu (mois, vacances scolaires…) :
        // l'horaire brut reste affiché plutôt que de ne rien montrer
        var brut = document.createElement("p");
        brut.className = "horaires-bruts";
        brut.textContent = lieu.horaires;
        corps.appendChild(brut);
      }
    } else {
      var pasHoraire = document.createElement("p");
      pasHoraire.className = "note";
      pasHoraire.textContent = "Horaires non renseignés dans OpenStreetMap.";
      corps.appendChild(pasHoraire);
    }

    if (lieu.site) {
      var liens = document.createElement("p");
      liens.className = "note";
      var a = document.createElement("a");
      a.href = lieu.site;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Site internet";
      liens.appendChild(a);
      corps.appendChild(liens);
    }

    var actions = document.createElement("div");
    actions.className = "actions";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "M'y rendre";
    btn.addEventListener("click", function () {
      Itineraires.definirArrivee({ lat: lieu.lat, lon: lieu.lon, nom: lieu.nom });
      Itineraires.ouvrir();
    });
    actions.appendChild(btn);
    corps.appendChild(actions);

    var source = document.createElement("p");
    source.className = "note";
    source.textContent = "Données OpenStreetMap relevées le " + donnees.releve +
      ". Aucun tarif ni menu n'est publié ici : vérifier auprès de l'établissement.";
    corps.appendChild(source);
  }

  function ouvrirFicheIntrouvable(categorie, nom) {
    var corps = Transports.ouvrirFiche(nom || LIBELLES[categorie], LIBELLES[categorie] || "");
    var note = document.createElement("p");
    note.className = "note";
    note.textContent = "Détails indisponibles pour ce lieu (absent du relevé OpenStreetMap le plus récent).";
    corps.appendChild(note);
  }

  // ---------- clic sur la couche « pois » du fond de carte ----------
  function initialiser(instanceCarte) {
    carte = instanceCarte;

    carte.on("styledata", function () {
      stylePret = true;
      ajouterCouches();
    });
    if (carte.isStyleLoaded()) stylePret = true;

    charger().then(function () {
      ajouterCouches();
    }).catch(function (e) {
      console.warn("Commerces indisponibles :", e.message);
    });

    carte.on("click", "pois", function (ev) {
      var p = ev.features && ev.features[0] && ev.features[0].properties;
      if (!p || !LIBELLES[p.kind]) return;
      charger().then(function () {
        var lieu = trouver(p.kind, ev.lngLat.lat, ev.lngLat.lng);
        if (lieu) ouvrirFiche(lieu);
        else ouvrirFicheIntrouvable(p.kind, p.name);
      }).catch(function (e) {
        Transports.ouvrirFiche(p.name || "", "").textContent =
          "Détails indisponibles : " + e.message;
      });
    });

    // curseur en main uniquement sur les catégories cliquables de la couche
    // « pois » (les pharmacies/épiceries bio, sur leur propre couche, gèrent
    // déjà leur curseur plus haut) : les autres genres (bancs, toilettes,
    // œuvres…) restent volontairement non interactifs.
    carte.on("mousemove", "pois", function (ev) {
      var p = ev.features && ev.features[0] && ev.features[0].properties;
      carte.getCanvas().style.cursor = (p && LIBELLES[p.kind]) ? "pointer" : "";
    });
    carte.on("mouseleave", "pois", function () {
      carte.getCanvas().style.cursor = "";
    });
  }

  return { initialiser: initialiser };
})();
