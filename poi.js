/* POI personnels (restaurants, bars, cinémas, commerces…) : appui long sur la
   carte (ou clic droit, plus pratique au clavier/souris) pour en ajouter un.
   Stockage IndexedDB — rien n'est envoyé nulle part, tout reste sur l'appareil,
   y compris hors ligne. Export/import JSON pour la sauvegarde ou le transfert
   vers un autre téléphone. */
"use strict";

var Poi = (function () {
  var BASE = "strasbourg-poi";
  var STORE = "poi";
  var carte = null;
  var stylePret = false;
  var visible = true;
  var baseOuverte = null;

  var CATEGORIES = {
    restaurant: { label: "Restaurant", couleur: "#e67e22" },
    bar: { label: "Bar", couleur: "#c0392b" },
    cinema: { label: "Cinéma", couleur: "#8e44ad" },
    commerce: { label: "Commerce", couleur: "#2e7d32" },
    autre: { label: "Autre", couleur: "#616161" }
  };
  var ORDRE_CATEGORIES = ["restaurant", "bar", "cinema", "commerce", "autre"];
  var filtresActifs = {};
  ORDRE_CATEGORIES.forEach(function (c) { filtresActifs[c] = true; });

  // ---------- IndexedDB ----------
  function ouvrirBase() {
    if (baseOuverte) return baseOuverte;
    baseOuverte = new Promise(function (resolve, reject) {
      var requete = indexedDB.open(BASE, 1);
      requete.onupgradeneeded = function () {
        requete.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      };
      requete.onsuccess = function () { resolve(requete.result); };
      requete.onerror = function () { reject(requete.error); };
    });
    return baseOuverte;
  }

  function transaction(mode) {
    return ouvrirBase().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); });
  }

  function promesseRequete(requete) {
    return new Promise(function (resolve, reject) {
      requete.onsuccess = function () { resolve(requete.result); };
      requete.onerror = function () { reject(requete.error); };
    });
  }

  function tout() {
    return transaction("readonly").then(function (magasin) { return promesseRequete(magasin.getAll()); });
  }

  function ajouter(entree) {
    return transaction("readwrite").then(function (magasin) { return promesseRequete(magasin.add(entree)); });
  }

  function maj(entree) {
    return transaction("readwrite").then(function (magasin) { return promesseRequete(magasin.put(entree)); });
  }

  function supprimer(id) {
    return transaction("readwrite").then(function (magasin) { return promesseRequete(magasin.delete(id)); });
  }

  // ---------- couche cartographique ----------
  function geojson(liste) {
    return {
      type: "FeatureCollection",
      features: liste.map(function (p) {
        return {
          type: "Feature", id: p.id,
          properties: { id: p.id, nom: p.nom, categorie: p.categorie },
          geometry: { type: "Point", coordinates: [p.lon, p.lat] }
        };
      })
    };
  }

  function expressionCouleur() {
    var expr = ["match", ["get", "categorie"]];
    ORDRE_CATEGORIES.forEach(function (c) { expr.push(c, CATEGORIES[c].couleur); });
    expr.push(CATEGORIES.autre.couleur);
    return expr;
  }

  function rafraichirCouche() {
    if (!carte || !carte.getSource("poi")) return Promise.resolve();
    return tout().then(function (liste) {
      carte.getSource("poi").setData(geojson(liste));
      appliquerFiltreCouche();
    });
  }

  function appliquerFiltreCouche() {
    var actives = ORDRE_CATEGORIES.filter(function (c) { return filtresActifs[c]; });
    var filtre = actives.length === ORDRE_CATEGORIES.length ? null
      : ["in", ["get", "categorie"], ["literal", actives]];
    ["poi-points", "poi-noms"].forEach(function (id) {
      if (carte.getLayer(id)) carte.setFilter(id, filtre);
    });
  }

  function ajouterCouches() {
    if (!carte || !stylePret) return;
    if (carte.getSource("poi")) return;
    var sombre = Carte.themeSombre();
    var vis = visible ? "visible" : "none";

    carte.addSource("poi", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    carte.addLayer({
      id: "poi-points",
      type: "circle",
      source: "poi",
      layout: { visibility: vis },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 4, 15, 7, 17, 9],
        "circle-color": expressionCouleur(),
        "circle-stroke-color": sombre ? "#1b1b1b" : "#ffffff",
        "circle-stroke-width": 2
      }
    });
    carte.addLayer({
      id: "poi-noms",
      type: "symbol",
      source: "poi",
      minzoom: 14,
      layout: {
        visibility: vis,
        "text-field": ["get", "nom"],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 17, 13],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true
      },
      paint: {
        "text-color": expressionCouleur(),
        "text-halo-color": sombre ? "#111111" : "#ffffff",
        "text-halo-width": 1.8
      }
    });

    ["poi-points", "poi-noms"].forEach(function (couche) {
      carte.on("click", couche, function (ev) {
        if (ev.features && ev.features.length) ouvrirFiche(ev.features[0].properties.id);
      });
      carte.on("mouseenter", couche, function () { carte.getCanvas().style.cursor = "pointer"; });
      carte.on("mouseleave", couche, function () { carte.getCanvas().style.cursor = ""; });
    });

    rafraichirCouche();
  }

  function basculerVisibilite(force) {
    visible = typeof force === "boolean" ? force : !visible;
    ["poi-points", "poi-noms"].forEach(function (id) {
      if (carte.getLayer(id)) carte.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    });
    return visible;
  }

  // ---------- création (appui long / clic droit) ----------
  function coordonnees(ev) {
    var rect = carte.getCanvas().getBoundingClientRect();
    var pt = ev.touches && ev.touches.length ? ev.touches[0] : ev;
    var ll = carte.unproject([pt.clientX - rect.left, pt.clientY - rect.top]);
    return { lat: ll.lat, lon: ll.lng };
  }

  var appuiTimer = null;
  var appuiDepart = null;

  function armerAppuiLong(canvas) {
    canvas.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
      ouvrirFormulaire(null, coordonnees(ev));
    });

    canvas.addEventListener("touchstart", function (ev) {
      if (ev.touches.length !== 1) { clearTimeout(appuiTimer); appuiTimer = null; return; }
      appuiDepart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
      appuiTimer = setTimeout(function () {
        appuiTimer = null;
        var rect = carte.getCanvas().getBoundingClientRect();
        var ll = carte.unproject([appuiDepart.x - rect.left, appuiDepart.y - rect.top]);
        ouvrirFormulaire(null, { lat: ll.lat, lon: ll.lng });
      }, 550);
    }, { passive: true });

    function annulerAppui(ev) {
      if (!appuiTimer) return;
      if (ev.type === "touchmove" && appuiDepart) {
        var t = ev.touches[0];
        var dist = Math.hypot(t.clientX - appuiDepart.x, t.clientY - appuiDepart.y);
        if (dist < 12) return; // léger tremblement toléré
      }
      clearTimeout(appuiTimer);
      appuiTimer = null;
    }
    canvas.addEventListener("touchmove", annulerAppui, { passive: true });
    canvas.addEventListener("touchend", annulerAppui);
    canvas.addEventListener("touchcancel", annulerAppui);
  }

  // ---------- formulaires ----------
  function ligneChamp(libelle, element) {
    var label = document.createElement("label");
    label.className = "champ-poi";
    var span = document.createElement("span");
    span.textContent = libelle;
    label.appendChild(span);
    label.appendChild(element);
    return label;
  }

  function ouvrirFormulaire(poi, coordsCreation) {
    var creation = !poi;
    var corps = Transports.ouvrirFiche(creation ? "Nouveau POI" : "Modifier « " + poi.nom + " »", "");

    var form = document.createElement("form");
    form.className = "form-poi";

    var champNom = document.createElement("input");
    champNom.type = "text";
    champNom.required = true;
    champNom.maxLength = 60;
    champNom.value = poi ? poi.nom : "";
    champNom.placeholder = "Nom du lieu";
    form.appendChild(ligneChamp("Nom", champNom));

    var champCat = document.createElement("select");
    ORDRE_CATEGORIES.forEach(function (c) {
      var option = document.createElement("option");
      option.value = c;
      option.textContent = CATEGORIES[c].label;
      champCat.appendChild(option);
    });
    champCat.value = poi ? poi.categorie : "restaurant";
    form.appendChild(ligneChamp("Catégorie", champCat));

    var champNote = document.createElement("select");
    [["", "Sans note"], ["1", "★"], ["2", "★★"], ["3", "★★★"], ["4", "★★★★"], ["5", "★★★★★"]]
      .forEach(function (paire) {
        var option = document.createElement("option");
        option.value = paire[0];
        option.textContent = paire[1];
        champNote.appendChild(option);
      });
    champNote.value = poi && poi.note ? String(poi.note) : "";
    form.appendChild(ligneChamp("Note", champNote));

    var champCommentaire = document.createElement("textarea");
    champCommentaire.rows = 3;
    champCommentaire.maxLength = 500;
    champCommentaire.placeholder = "Commentaire personnel (facultatif)";
    champCommentaire.value = poi ? (poi.commentaire || "") : "";
    form.appendChild(ligneChamp("Commentaire", champCommentaire));

    var actions = document.createElement("div");
    actions.className = "actions";
    var btnValider = document.createElement("button");
    btnValider.type = "submit";
    btnValider.className = "btn-calculer";
    btnValider.textContent = creation ? "Ajouter" : "Enregistrer";
    actions.appendChild(btnValider);
    if (!creation) {
      var btnAnnuler = document.createElement("button");
      btnAnnuler.type = "button";
      btnAnnuler.textContent = "Annuler";
      btnAnnuler.addEventListener("click", function () { ouvrirFiche(poi.id); });
      actions.appendChild(btnAnnuler);
    }
    form.appendChild(actions);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var nom = champNom.value.trim();
      if (!nom) return;
      var donnees = {
        nom: nom,
        categorie: champCat.value,
        note: champNote.value ? parseInt(champNote.value, 10) : null,
        commentaire: champCommentaire.value.trim(),
        lat: creation ? coordsCreation.lat : poi.lat,
        lon: creation ? coordsCreation.lon : poi.lon,
        cree: creation ? Date.now() : poi.cree
      };
      var promesse = creation ? ajouter(donnees) : maj(Object.assign({ id: poi.id }, donnees));
      promesse.then(function (id) {
        rafraichirCouche();
        ouvrirFiche(creation ? id : poi.id);
      });
    });

    corps.appendChild(form);

    if (creation) {
      var note = document.createElement("p");
      note.className = "note";
      note.textContent = "Position : " + coordsCreation.lat.toFixed(5) + ", " + coordsCreation.lon.toFixed(5) +
        ". Rien n'est envoyé : la fiche reste uniquement sur cet appareil.";
      corps.appendChild(note);
    }
  }

  // ---------- fiche de consultation ----------
  function etoiles(note) {
    if (!note) return "";
    return "★".repeat(note) + "☆".repeat(5 - note);
  }

  function ouvrirFiche(id) {
    tout().then(function (liste) {
      var poi = liste.filter(function (p) { return p.id === id; })[0];
      if (!poi) { ouvrirListe(); return; }
      var corps = Transports.ouvrirFiche(poi.nom, CATEGORIES[poi.categorie].label);

      if (poi.note) {
        var note = document.createElement("p");
        note.className = "note-etoiles";
        note.textContent = etoiles(poi.note);
        corps.appendChild(note);
      }
      if (poi.commentaire) {
        var commentaire = document.createElement("p");
        commentaire.className = "description-lieu";
        commentaire.textContent = poi.commentaire;
        corps.appendChild(commentaire);
      }

      var actions = document.createElement("div");
      actions.className = "actions";
      var btnItineraire = document.createElement("button");
      btnItineraire.type = "button";
      btnItineraire.textContent = "M'y rendre";
      btnItineraire.addEventListener("click", function () {
        Itineraires.definirArrivee({ lat: poi.lat, lon: poi.lon, nom: poi.nom });
        Itineraires.ouvrir();
      });
      actions.appendChild(btnItineraire);

      var btnModifier = document.createElement("button");
      btnModifier.type = "button";
      btnModifier.textContent = "Modifier";
      btnModifier.addEventListener("click", function () { ouvrirFormulaire(poi); });
      actions.appendChild(btnModifier);

      var btnSupprimer = document.createElement("button");
      btnSupprimer.type = "button";
      btnSupprimer.textContent = "Supprimer";
      btnSupprimer.addEventListener("click", function () {
        if (!confirm("Supprimer « " + poi.nom + " » ?")) return;
        supprimer(poi.id).then(function () {
          rafraichirCouche();
          ouvrirListe();
        });
      });
      actions.appendChild(btnSupprimer);
      corps.appendChild(actions);
    });
  }

  // ---------- export / import ----------
  function exporter() {
    tout().then(function (liste) {
      var contenu = JSON.stringify(liste, null, 2);
      var lien = document.createElement("a");
      lien.href = URL.createObjectURL(new Blob([contenu], { type: "application/json" }));
      lien.download = "poi-strasbourg-eurometropole.json";
      lien.click();
      URL.revokeObjectURL(lien.href);
    });
  }

  function importerFichier(fichier, etat) {
    if (!fichier) return;
    fichier.text().then(function (texte) {
      var entrees = JSON.parse(texte);
      if (!Array.isArray(entrees)) throw new Error("format inattendu");
      var valides = entrees.filter(function (e) {
        return e && typeof e.nom === "string" && typeof e.lat === "number" && typeof e.lon === "number";
      });
      return Promise.all(valides.map(function (e) {
        return ajouter({
          nom: e.nom,
          categorie: CATEGORIES[e.categorie] ? e.categorie : "autre",
          note: typeof e.note === "number" ? e.note : null,
          commentaire: typeof e.commentaire === "string" ? e.commentaire : "",
          lat: e.lat, lon: e.lon,
          cree: typeof e.cree === "number" ? e.cree : Date.now()
        });
      })).then(function (ids) {
        rafraichirCouche();
        ouvrirListe(ids.length + " POI importés.");
      });
    }).catch(function (e) {
      if (etat) etat.textContent = "Import impossible : " + e.message;
    });
  }

  // ---------- liste ----------
  function ouvrirListe(messageEtat) {
    var corps = Transports.ouvrirFiche("Mes POI", "Chargement…");
    tout().then(function (liste) {
      corps = Transports.ouvrirFiche("Mes POI", liste.length + (liste.length > 1 ? " lieux" : " lieu"));

      var filtres = document.createElement("div");
      filtres.className = "chips-filtre";
      ORDRE_CATEGORIES.forEach(function (c) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip" + (filtresActifs[c] ? " actif" : "");
        chip.style.borderColor = CATEGORIES[c].couleur;
        if (filtresActifs[c]) chip.style.background = CATEGORIES[c].couleur;
        chip.textContent = CATEGORIES[c].label;
        chip.addEventListener("click", function () {
          filtresActifs[c] = !filtresActifs[c];
          appliquerFiltreCouche();
          ouvrirListe();
        });
        filtres.appendChild(chip);
      });
      corps.appendChild(filtres);

      var actions = document.createElement("div");
      actions.className = "actions";
      var btnExport = document.createElement("button");
      btnExport.type = "button";
      btnExport.textContent = "Exporter (JSON)";
      btnExport.disabled = liste.length === 0;
      btnExport.addEventListener("click", exporter);
      actions.appendChild(btnExport);

      var inputFichier = document.createElement("input");
      inputFichier.type = "file";
      inputFichier.accept = "application/json";
      inputFichier.hidden = true;

      var btnImport = document.createElement("button");
      btnImport.type = "button";
      btnImport.textContent = "Importer…";
      btnImport.addEventListener("click", function () { inputFichier.click(); });
      actions.appendChild(btnImport);
      corps.appendChild(actions);

      var etatImport = document.createElement("p");
      etatImport.className = "note";
      if (messageEtat) etatImport.textContent = messageEtat;
      corps.appendChild(etatImport);
      inputFichier.addEventListener("change", function () {
        importerFichier(inputFichier.files[0], etatImport);
      });
      corps.appendChild(inputFichier);

      var affiches = liste.filter(function (p) { return filtresActifs[p.categorie]; })
        .sort(function (a, b) { return a.nom.localeCompare(b.nom, "fr"); });

      if (!liste.length) {
        var vide = document.createElement("p");
        vide.className = "note";
        vide.textContent = "Aucun POI pour l'instant. Appui long sur la carte " +
          "(ou clic droit) pour ajouter un restaurant, un bar, un cinéma…";
        corps.appendChild(vide);
      } else if (!affiches.length) {
        var masque = document.createElement("p");
        masque.className = "note";
        masque.textContent = "Aucun POI dans les catégories sélectionnées.";
        corps.appendChild(masque);
      } else {
        affiches.forEach(function (p) {
          var bouton = document.createElement("button");
          bouton.type = "button";
          bouton.className = "carte-ligne";
          var pastille = document.createElement("span");
          pastille.className = "pastille-cat";
          pastille.style.background = CATEGORIES[p.categorie].couleur;
          bouton.appendChild(pastille);
          var nom = document.createElement("span");
          nom.textContent = p.nom + (p.note ? "  " + etoiles(p.note) : "");
          bouton.appendChild(nom);
          bouton.addEventListener("click", function () { ouvrirFiche(p.id); });
          corps.appendChild(bouton);
        });
      }
    });
  }

  // ---------- mise en route ----------
  function initialiser(instanceCarte) {
    carte = instanceCarte;
    armerAppuiLong(carte.getCanvas());

    var chip = document.getElementById("chip-poi");
    if (chip) chip.addEventListener("click", ouvrirListe);

    carte.on("styledata", function () {
      stylePret = true;
      ajouterCouches();
    });
    if (carte.isStyleLoaded()) stylePret = true;
    ajouterCouches();
  }

  return {
    initialiser: initialiser,
    ouvrirListe: ouvrirListe,
    ouvrirFiche: ouvrirFiche,
    basculerVisibilite: basculerVisibilite,
    categories: function () { return CATEGORIES; }
  };
})();
