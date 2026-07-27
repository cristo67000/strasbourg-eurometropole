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
  var MOIS_OSM = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
                    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  var MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin",
                 "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

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

  /* Découpe un `opening_hours` en règles {specMois, specJours, specHeures},
     sans les appliquer à une date précise — partagé par `intervalles()`
     (état à un instant donné) et `resume()` (résumé hebdomadaire lisible).
     `null` dès que la syntaxe dépasse le sous-ensemble reconnu (semaines,
     n-ième jour, dates absolues, vacances scolaires `SH`, commentaire
     libre…) : on préfère ne rien affirmer plutôt qu'annoncer un état ou un
     résumé faux. Les plages de mois (« Jul-Aug 13:00-18:00 », très
     courantes sur les équipements municipaux — horaires d'été distincts —
     sont en revanche reconnues : assez fréquentes pour valoir la peine. */
  function analyserRegles(horaires, refDate) {
    if (!horaires) return null;
    var texte = horaires.trim();
    if (/["]/.test(texte)) return null;               // commentaire libre
    if (/^24\/7$/.test(texte)) return [{ specMois: "", specJours: "", specHeures: "24/7" }];
    var anneeCourante = (refDate || new Date()).getFullYear();

    var motifMois = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
    var regexMois = new RegExp(
      "^((?:" + motifMois + "(?:-" + motifMois + ")?)(?:,\\s*" +
      motifMois + "(?:-" + motifMois + ")?)*)\\s*:?\\s+(.*)$"
    );
    var motifJours = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)";
    var regexRegle = new RegExp(
      "^((?:" + motifJours + "(?:-" + motifJours + ")?)(?:,\\s*" +
      motifJours + "(?:-" + motifJours + ")?)*)?\\s*(.*)$"
    );
    // certaines fiches OSM enchaînent deux clauses par une simple virgule au
    // lieu du point-virgule attendu (« Jul-Aug Tu-Fr 13:00-18:00, Jul-Aug Sa
    // 10:00-12:00,14:00-18:00 ») : une virgule immédiatement suivie d'une
    // nouvelle plage de mois vaut donc séparateur de règle, pas de plage
    // horaire — sans quoi tout le champ serait rejeté pour cette seule
    // irrégularité de ponctuation.
    var regexReprise = new RegExp(
      "(?<=\\d{1,2}:\\d{2}),\\s*(?=" + motifMois + "(?:-" + motifMois + ")?[\\s:])", "g"
    );
    // même irrégularité, mais entre deux groupes de jours plutôt que de mois
    // (fréquent sur les bars/restaurants de nuit) : « Su-Th 17:00-03:00,
    // Fr,Sa 17:00-05:00 » — à ne pas confondre avec la virgule interne à
    // « Fr,Sa », qui n'est jamais précédée d'un horaire.
    var regexRepriseJours = new RegExp(
      "(?<=\\d{1,2}:\\d{2}),\\s*(?=" + motifJours + "(?:[-,]|\\s))", "g"
    );
    texte = texte.replace(regexReprise, ";").replace(regexRepriseJours, ";");

    var sortie = [];
    var morceaux = texte.split(";");
    for (var r = 0; r < morceaux.length; r++) {
      var regle = morceaux[r].trim();
      if (!regle) continue;

      // exception à date absolue (« 2024 Jul 19 off », GTFS-like one-off) :
      // fréquente sur les fiches OSM non nettoyées après coup. Sans date
      // précise à comparer ici (specHeures pourrait suivre plusieurs
      // dates à la fois), on se contente d'un test sûr — si toutes les
      // années citées sont déjà passées, l'exception ne peut plus jamais
      // s'appliquer et peut être ignorée sans risque ; sinon (année en
      // cours ou future), on renonce comme avant plutôt que de deviner.
      if (/^\d{4}\b/.test(regle)) {
        var annees = (regle.match(/\d{4}/g) || []).map(Number);
        if (annees.length && annees.every(function (a) { return a < anneeCourante; })) {
          continue;
        }
        return null;
      }

      var specMois = "";
      var reste = regle;
      var mM = regexMois.exec(regle);
      if (mM) { specMois = mM[1].trim(); reste = mM[2].trim(); }

      if (/[:\[]/.test(reste.replace(/\d{1,2}:\d{2}/g, ""))) return null;
      // semaines, n-ième jour, dates absolues… : hors du sous-ensemble reconnu

      var m = regexRegle.exec(reste);
      if (!m) return null;
      var specJours = (m[1] || "").trim();
      var specHeures = (m[2] || "").trim();
      // vacances scolaires (SH) : jamais interprétées, quelle que soit la
      // date demandée — invalide tout le champ plutôt qu'un seul jour
      if (specJours.split(",").some(function (b) { return b.trim() === "SH"; })) {
        return null;
      }
      sortie.push({ specMois: specMois, specJours: specJours, specHeures: specHeures });
    }
    return sortie;
  }

  function moisConcerne(specMois, mois) {
    if (!specMois) return true;
    var blocs = specMois.split(",");
    for (var b = 0; b < blocs.length; b++) {
      var bloc = blocs[b].trim();
      var bornes = bloc.split("-");
      var debut = MOIS_OSM[bornes[0]];
      if (debut === undefined) return false;
      if (bornes.length === 1) {
        if (mois === debut) return true;
      } else {
        var fin = MOIS_OSM[bornes[1]];
        if (fin === undefined) return false;
        if (fin >= debut ? (mois >= debut && mois <= fin)
                         : (mois >= debut || mois <= fin)) return true;
      }
    }
    return false;
  }

  /* Intervalles d'ouverture pour une date, ou null si la syntaxe dépasse le
     sous-ensemble reconnu (on préfère ne rien affirmer). */
  function intervalles(horaires, date) {
    var regles = analyserRegles(horaires, date);
    if (regles === null) return null;
    if (regles.length === 1 && regles[0].specHeures === "24/7") return [[0, 1440]];

    var jour = (date.getDay() + 6) % 7;
    var ferie = estFerie(date);
    var resultat = [];

    for (var r = 0; r < regles.length; r++) {
      var specMois = regles[r].specMois, specJours = regles[r].specJours,
          specHeures = regles[r].specHeures;
      if (!moisConcerne(specMois, date.getMonth())) continue;

      var concerne;
      if (!specJours) {
        concerne = true;              // règle sans jour : tous les jours
      } else {
        concerne = false;
        var blocs = specJours.split(",");
        for (var b = 0; b < blocs.length; b++) {
          var bloc = blocs[b].trim();
          if (bloc === "PH") { if (ferie) concerne = true; continue; }
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

  /* Résumé hebdomadaire lisible, une ligne par règle — ex. « Du mardi au
     samedi : de 12h à 14h et de 18h à 21h » — ou `null` si `analyserRegles`
     renonce. Volontairement distinct de `etatOuverture` (qui ne parle que de
     l'instant présent) : ici on veut la semaine entière d'un coup d'œil. */
  function segmentJours(bloc) {
    if (bloc === "PH") return "les jours fériés";
    var bornes = bloc.split("-");
    if (bornes.length === 1) return "le " + JOURS_FR[JOURS_OSM[bornes[0]]];
    return "du " + JOURS_FR[JOURS_OSM[bornes[0]]] + " au " + JOURS_FR[JOURS_OSM[bornes[1]]];
  }

  function texteJours(specJours) {
    if (!specJours) return "tous les jours";
    return specJours.split(",").map(function (b) { return segmentJours(b.trim()); }).join(", ");
  }

  function segmentMois(bloc) {
    var bornes = bloc.split("-");
    if (bornes.length === 1) return MOIS_FR[MOIS_OSM[bornes[0]]];
    return "de " + MOIS_FR[MOIS_OSM[bornes[0]]] + " à " + MOIS_FR[MOIS_OSM[bornes[1]]];
  }

  function texteMois(specMois) {
    return specMois.split(",").map(function (b) { return segmentMois(b.trim()); }).join(", ");
  }

  /* « quand » complet d'une règle : mois (s'il y en a) puis jours, ex.
     « de juillet à août, du mardi au vendredi ». */
  function texteQuand(specMois, specJours) {
    var jours = texteJours(specJours);
    return specMois ? texteMois(specMois) + ", " + jours : jours;
  }

  function majuscule(texte) {
    return texte.charAt(0).toUpperCase() + texte.slice(1);
  }

  /* OSM autorise (et beaucoup de bars/restaurants de nuit l'utilisent) une
     heure de fin au-delà de 24:00 pour dire « le lendemain matin » sans
     règle séparée (ex. « 17:00-25:00 » = ouvert jusqu'à 1 h). Ramené à la
     plage 0-23 pour l'affichage — « de 17h à 1h » se lit sans ambiguïté,
     contrairement à « de 17h à 25h ». */
  function texteHeure(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    var h = parseInt(m[1], 10) % 24, mn = m[2];
    return h + "h" + (mn === "00" ? "" : mn);
  }

  function resume(horaires) {
    var regles = analyserRegles(horaires);
    if (regles === null) return null;
    if (regles.length === 1 && regles[0].specHeures === "24/7") {
      return ["Ouvert 24 h/24, 7 jours sur 7"];
    }

    var lignes = [];
    for (var r = 0; r < regles.length; r++) {
      var specMois = regles[r].specMois, specJours = regles[r].specJours,
          specHeures = regles[r].specHeures;
      if (/^(off|closed)$/i.test(specHeures)) {
        lignes.push("Fermé " + texteQuand(specMois, specJours));
        continue;
      }
      if (!specHeures) return null;
      var plages = specHeures.split(",");
      var texteHeures = [];
      for (var p = 0; p < plages.length; p++) {
        var bornes = plages[p].trim().split("-");
        if (bornes.length !== 2) return null;
        var d = texteHeure(bornes[0]), f = texteHeure(bornes[1]);
        if (d === null || f === null) return null;
        texteHeures.push("de " + d + " à " + f);
      }
      lignes.push(majuscule(texteQuand(specMois, specJours)) + " : " + texteHeures.join(" et "));
    }
    return lignes;
  }

  /* {etat, texte} : « ouvert », « ferme » ou « inconnu ». */
  function etatOuverture(horaires, maintenant) {
    var plages = intervalles(horaires, maintenant);
    if (plages === null) return { etat: "inconnu", texte: "" };
    var minute = maintenant.getHours() * 60 + maintenant.getMinutes();

    // une plage codée la veille (ex. « 17:00-25:00 » un lundi, donc jusqu'à
    // 1 h le mardi) déborde sur aujourd'hui avant l'aube : sans ce contrôle,
    // un bar ouvert jusqu'à 1 h semblerait fermé entre minuit et sa vraie
    // fermeture, faute d'être recalculé depuis la règle de la veille.
    var hier = new Date(maintenant.getTime() - 86400000);
    var plagesHier = intervalles(horaires, hier);
    if (plagesHier) {
      for (var h = 0; h < plagesHier.length; h++) {
        if (plagesHier[h][1] > 1440 && minute < plagesHier[h][1] - 1440) {
          var dureeHier = plagesHier[h][1] - plagesHier[h][0];
          return {
            etat: "ouvert",
            texte: dureeHier >= 1440 ? "ouvert 24 h/24" : "ferme à " + heure(plagesHier[h][1])
          };
        }
      }
    }

    for (var i = 0; i < plages.length; i++) {
      if (minute >= plages[i][0] && minute < plages[i][1]) {
        // une plage qui franchit minuit (bar ouvert jusqu'à 1 h, codé
        // 17:00-25:00) n'est « ouvert 24 h/24 » que si elle couvre bien la
        // journée entière (durée ≥ 1440) — sinon c'est juste une fermeture
        // après minuit, à annoncer avec sa vraie heure (`heure()` ramène
        // déjà 1500 min à 01:00)
        var dureeVraie = plages[i][1] - plages[i][0];
        var texte = dureeVraie >= 1440 ? "ouvert 24 h/24"
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
    resume: resume,
    estFerie: estFerie,
    donnees: function () { return donnees; }
  };
})();
