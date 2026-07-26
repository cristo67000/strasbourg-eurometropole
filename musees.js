/* Musées et lieux de visite : couche cartographique, fiche et calcul
   d'ouverture, entièrement hors ligne.

   Les horaires proviennent d'OpenStreetMap, en syntaxe `opening_hours`. Seul
   un sous-ensemble est interprété ; dès qu'une règle sort de ce cadre (mois,
   n-ième dimanche, commentaire libre), on renonce à conclure et on affiche
   l'horaire tel quel plutôt que d'annoncer une ouverture fausse. */
"use strict";

var Musees = (function () {
  var donnees = null;
  var chargement = null;
  var carte = null;
  var stylePret = false;
  var visible = true;

  var JOURS_OSM = { Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6 };
  var JOURS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi",
                  "samedi", "dimanche"];

  // ---------- jours fériés (Alsace-Moselle) ----------

  /* Dimanche de Pâques, algorithme de Meeus/Jones/Butcher. */
  function paques(annee) {
    var a = annee % 19, b = Math.floor(annee / 100), c = annee % 100;
    var d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    var mois = Math.floor((h + l - 7 * m + 114) / 31);
    var jour = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(annee, mois - 1, jour);
  }

  var cacheFeries = {};

  /* Le Bas-Rhin ajoute le Vendredi saint et le 26 décembre aux onze jours
     fériés nationaux. */
  function feries(annee) {
    if (cacheFeries[annee]) return cacheFeries[annee];
    var p = paques(annee);
    function decale(jours) {
      var d = new Date(p.getTime());
      d.setDate(d.getDate() + jours);
      return d.getMonth() + "-" + d.getDate();
    }
    var liste = {};
    [[0, 1], [4, 1], [4, 8], [6, 14], [7, 15], [10, 1], [10, 11],
     [11, 25], [11, 26]].forEach(function (md) {
      liste[md[0] + "-" + md[1]] = true;
    });
    [-2, 1, 39, 50].forEach(function (n) { liste[decale(n)] = true; });
    cacheFeries[annee] = liste;
    return liste;
  }

  function estFerie(date) {
    return !!feries(date.getFullYear())[date.getMonth() + "-" + date.getDate()];
  }

  // ---------- interprétation des horaires OSM ----------

  function minutesDepuis(texte) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(texte.trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /* Intervalles d'ouverture pour une date, ou null si la syntaxe dépasse le
     sous-ensemble reconnu (on préfère ne rien affirmer). */
  function intervalles(horaires, date) {
    if (!horaires) return null;
    var texte = horaires.trim();
    if (/["]/.test(texte)) return null;              // commentaire libre
    if (/^24\/7$/.test(texte)) return [[0, 1440]];

    var jour = (date.getDay() + 6) % 7;
    var ferie = estFerie(date);
    var resultat = [];

    var regles = texte.split(";");
    for (var r = 0; r < regles.length; r++) {
      var regle = regles[r].trim();
      if (!regle) continue;
      if (/[:\[]/.test(regle.replace(/\d{1,2}:\d{2}/g, ""))) return null;
      // mois, semaines, n-ième jour… : hors du sous-ensemble reconnu

      var motifJours = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)";
      var m = new RegExp(
        "^((?:" + motifJours + "(?:-" + motifJours + ")?)(?:," +
        motifJours + "(?:-" + motifJours + ")?)*)?\\s*(.*)$"
      ).exec(regle);
      if (!m) return null;

      var specJours = (m[1] || "").trim();
      var specHeures = (m[2] || "").trim();

      var concerne;
      if (!specJours) {
        concerne = true;              // règle sans jour : tous les jours
      } else {
        concerne = false;
        var blocs = specJours.split(",");
        for (var b = 0; b < blocs.length; b++) {
          var bloc = blocs[b].trim();
          if (bloc === "PH") { if (ferie) concerne = true; continue; }
          if (bloc === "SH") return null;   // vacances scolaires : inconnues
          var bornes = bloc.split("-");
          var debut = JOURS_OSM[bornes[0]];
          if (debut === undefined) return null;
          if (bornes.length === 1) {
            if (jour === debut) concerne = true;
          } else {
            var fin = JOURS_OSM[bornes[1]];
            if (fin === undefined) return null;
            if (fin >= debut ? (jour >= debut && jour <= fin)
                             : (jour >= debut || jour <= fin)) concerne = true;
          }
        }
      }
      if (!concerne) continue;

      if (/^(off|closed)$/i.test(specHeures)) {
        resultat = [];                // une fermeture explicite annule le reste
        continue;
      }
      if (!specHeures) return null;

      var plages = specHeures.split(",");
      for (var p = 0; p < plages.length; p++) {
        var bornesH = plages[p].trim().split("-");
        if (bornesH.length !== 2) return null;
        var d1 = minutesDepuis(bornesH[0]), f1 = minutesDepuis(bornesH[1]);
        if (d1 === null || f1 === null) return null;
        if (f1 <= d1) f1 += 1440;     // plage passant minuit
        resultat.push([d1, f1]);
      }
    }
    resultat.sort(function (a, b) { return a[0] - b[0]; });
    return resultat;
  }

  /* {etat, texte} : « ouvert », « ferme » ou « inconnu ». */
  function etatOuverture(horaires, maintenant) {
    var plages = intervalles(horaires, maintenant);
    if (plages === null) return { etat: "inconnu", texte: "" };
    var minute = maintenant.getHours() * 60 + maintenant.getMinutes();

    for (var i = 0; i < plages.length; i++) {
      if (minute >= plages[i][0] && minute < plages[i][1]) {
        var texte = plages[i][1] >= 1440 ? "ouvert 24 h/24"
          : "ferme à " + heure(plages[i][1]);
        return { etat: "ouvert", texte: texte };
      }
    }
    for (var j = 0; j < plages.length; j++) {
      if (plages[j][0] > minute) {
        return { etat: "ferme", texte: "ouvre à " + heure(plages[j][0]) };
      }
    }
    // rien aujourd'hui : chercher le prochain jour ouvert dans la semaine
    for (var d = 1; d <= 7; d++) {
      var suivant = new Date(maintenant.getTime() + d * 86400000);
      var p = intervalles(horaires, suivant);
      if (p && p.length) {
        return {
          etat: "ferme",
          texte: "ouvre " + JOURS_FR[(suivant.getDay() + 6) % 7] + " à " +
            heure(p[0][0])
        };
      }
    }
    return { etat: "ferme", texte: "" };
  }

  function heure(minutes) {
    var m = ((minutes % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mn = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mn < 10 ? "0" : "") + mn;
  }

  // ---------- chargement et couche ----------
  function charger() {
    if (chargement) return chargement;
    chargement = fetch("data/musees.json")
      .then(function (r) {
        if (!r.ok) throw new Error("musees.json indisponible");
        return r.json();
      })
      .then(function (d) { donnees = d; return d; });
    return chargement;
  }

  function geojson() {
    return {
      type: "FeatureCollection",
      features: donnees.lieux.map(function (l, idx) {
        return {
          type: "Feature", id: idx,
          properties: { idx: idx, nom: l.nom },
          geometry: { type: "Point", coordinates: [l.lon, l.lat] }
        };
      })
    };
  }

  function ajouterCouches() {
    if (!carte || !donnees || !stylePret) return;
    if (carte.getSource("musees")) return;
    var sombre = Carte.themeSombre();
    var vis = visible ? "visible" : "none";

    carte.addSource("musees", { type: "geojson", data: geojson() });
    carte.addLayer({
      id: "musees-points",
      type: "circle",
      source: "musees",
      layout: { visibility: vis },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 4, 15, 7, 17, 9],
        "circle-color": "#8e44ad",
        "circle-stroke-color": sombre ? "#1b1b1b" : "#ffffff",
        "circle-stroke-width": 2
      }
    });
    carte.addLayer({
      id: "musees-noms",
      type: "symbol",
      source: "musees",
      minzoom: 13,
      layout: {
        visibility: vis,
        "text-field": ["get", "nom"],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 13],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true
      },
      paint: {
        "text-color": "#8e44ad",
        "text-halo-color": sombre ? "#111111" : "#ffffff",
        "text-halo-width": 1.8
      }
    });

    ["musees-points", "musees-noms"].forEach(function (couche) {
      carte.on("click", couche, function (ev) {
        if (ev.features && ev.features.length) ouvrirFiche(ev.features[0].properties.idx);
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
    ["musees-points", "musees-noms"].forEach(function (id) {
      if (carte.getLayer(id)) {
        carte.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    });
    return visible;
  }

  // ---------- fiches ----------
  function pastilleEtat(lieu, maintenant) {
    var etat = etatOuverture(lieu.horaires, maintenant);
    var span = document.createElement("span");
    span.className = "pastille " + etat.etat;
    span.textContent = etat.etat === "ouvert" ? "Ouvert"
      : etat.etat === "ferme" ? "Fermé" : "Horaires à vérifier";
    return { element: span, detail: etat.texte, etat: etat.etat };
  }

  function ouvrirFiche(idx) {
    var lieu = donnees.lieux[idx];
    var maintenant = new Date();
    var corps = Transports.ouvrirFiche(lieu.nom, lieu.adresse || "");

    if (lieu.photo) {
      var figure = document.createElement("figure");
      figure.className = "photo-lieu";
      var img = document.createElement("img");
      img.src = lieu.photo;
      img.alt = lieu.nom;
      img.loading = "lazy";
      figure.appendChild(img);
      if (lieu.photo_credit) {
        var credit = document.createElement("figcaption");
        credit.textContent = lieu.photo_credit;
        figure.appendChild(credit);
      }
      corps.appendChild(figure);
    }

    // état d'ouverture et horaires bruts
    var ligneEtat = document.createElement("div");
    ligneEtat.className = "ligne-etat";
    var pastille = pastilleEtat(lieu, maintenant);
    ligneEtat.appendChild(pastille.element);
    if (pastille.detail) {
      var detail = document.createElement("span");
      detail.className = "detail-etat";
      detail.textContent = pastille.detail;
      ligneEtat.appendChild(detail);
    }
    if (lieu.payant === "yes" || lieu.payant === "no") {
      var tarif = document.createElement("span");
      tarif.className = "etiquette";
      tarif.textContent = lieu.payant === "yes" ? "payant" : "gratuit";
      ligneEtat.appendChild(tarif);
    }
    if (lieu.fauteuil === "yes" || lieu.fauteuil === "limited") {
      var acces = document.createElement("span");
      acces.className = "etiquette";
      acces.textContent = lieu.fauteuil === "yes"
        ? "accessible en fauteuil" : "accès fauteuil limité";
      ligneEtat.appendChild(acces);
    }
    corps.appendChild(ligneEtat);

    if (lieu.horaires) {
      var h = document.createElement("p");
      h.className = "horaires-bruts";
      h.textContent = lieu.horaires;
      corps.appendChild(h);
    }

    if (lieu.description) {
      var desc = document.createElement("p");
      desc.className = "description-lieu";
      desc.textContent = lieu.description;
      corps.appendChild(desc);
    }

    // desserte et itinéraire
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

    if (Reseau.pret()) {
      var proches = Reseau.stationsProches(lieu.lat, lieu.lon, 500, 4);
      if (proches.length) {
        var titre = document.createElement("h3");
        titre.textContent = "Arrêts à proximité";
        corps.appendChild(titre);
        proches.forEach(function (p) {
          var s = Reseau.stations()[p.station];
          var ligne = document.createElement("div");
          ligne.className = "passage";
          var badges = document.createElement("span");
          badges.className = "destination";
          badges.textContent = s[1] + " · " + p.minutes + " min à pied";
          ligne.appendChild(badges);
          ligne.style.cursor = "pointer";
          ligne.addEventListener("click", function () {
            Transports.ouvrirFicheStation(p.station);
          });
          corps.appendChild(ligne);
        });
      }
    }

    var liens = document.createElement("p");
    liens.className = "note";
    [["Site officiel", lieu.site], ["Fiche de la Ville", lieu.lien]]
      .forEach(function (paire) {
        if (!paire[1]) return;
        var a = document.createElement("a");
        a.href = paire[1];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = paire[0];
        liens.appendChild(a);
        liens.appendChild(document.createTextNode(" "));
      });
    if (liens.childNodes.length) corps.appendChild(liens);

    var source = document.createElement("p");
    source.className = "note";
    source.textContent = "Horaires relevés dans OpenStreetMap le " +
      donnees.releve + ". Aucun tarif n'est publié ici : vérifier auprès de " +
      "l'établissement avant de vous déplacer.";
    corps.appendChild(source);
  }

  function ouvrirListe() {
    Transports.ouvrirFiche("Musées et lieux de visite", "Chargement…");
    charger().then(function () {
      var maintenant = new Date();
      var corps = Transports.ouvrirFiche(
        "Musées et lieux de visite",
        donnees.lieux.length + " lieux · relevé du " + donnees.releve
      );
      donnees.lieux.forEach(function (lieu, idx) {
        var bouton = document.createElement("button");
        bouton.type = "button";
        bouton.className = "carte-ligne";
        var pastille = pastilleEtat(lieu, maintenant);
        bouton.appendChild(pastille.element);
        var nom = document.createElement("span");
        nom.textContent = lieu.nom;
        bouton.appendChild(nom);
        bouton.addEventListener("click", function () { ouvrirFiche(idx); });
        corps.appendChild(bouton);
      });
      var note = document.createElement("p");
      note.className = "note";
      note.textContent = donnees.avertissement;
      corps.appendChild(note);
    }).catch(function (e) {
      Transports.ouvrirFiche("Musées", "").textContent =
        "Données indisponibles : " + e.message;
    });
  }

  // ---------- mise en route ----------
  function initialiser(instanceCarte) {
    carte = instanceCarte;
    var chip = document.getElementById("chip-musees");
    if (chip) chip.addEventListener("click", ouvrirListe);

    carte.on("styledata", function () {
      stylePret = true;
      ajouterCouches();
    });
    if (carte.isStyleLoaded()) stylePret = true;

    charger().then(function () {
      ajouterCouches();
      Carte.ajouterEntreesRecherche(donnees.lieux.map(function (l, idx) {
        return [l.nom, l.lat, l.lon, "musee", "musée", idx];
      }));
    }).catch(function (e) {
      console.warn("Musées indisponibles :", e.message);
      if (chip) chip.hidden = true;
    });
  }

  return {
    initialiser: initialiser,
    ouvrirFiche: ouvrirFiche,
    ouvrirListe: ouvrirListe,
    basculerVisibilite: basculerVisibilite,
    // exposés pour les contrôles
    etatOuverture: etatOuverture,
    intervalles: intervalles,
    estFerie: estFerie,
    donnees: function () { return donnees; }
  };
})();
