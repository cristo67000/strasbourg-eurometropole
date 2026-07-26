/* Couche de données du réseau CTS, partagée par transports.js (fiches arrêt)
   et itineraires.js (calcul d'itinéraires).

   Décode cts-courses.json : 255 motifs de desserte, chacun portant ses profils
   horaires (écarts en minutes depuis le premier arrêt) et ses courses réduites
   à un triplet calendrier / heure de départ / profil. Tout le calcul horaire
   se fait localement, sans aucun accès réseau. */
"use strict";

var Reseau = (function () {
  // ---------- décodage varint (miroir de build/codec.py) ----------
  var ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
  var VALEURS = {};
  for (var i = 0; i < ALPHABET.length; i++) VALEURS[ALPHABET.charAt(i)] = i;

  /* Entiers indépendants (index de stations, de profils…). */
  function decoderEntiers(texte) {
    var out = [], courant = 0, decalage = 0;
    for (var i = 0; i < texte.length; i++) {
      var v = VALEURS[texte.charAt(i)];
      courant |= (v & 31) << decalage;
      if (v & 32) {
        decalage += 5;
      } else {
        out.push(courant);
        courant = 0;
        decalage = 0;
      }
    }
    return out;
  }

  /* Suite croissante encodée en écarts (heures de base, offsets d'un profil). */
  function decoderSuite(texte) {
    var valeurs = decoderEntiers(texte);
    var total = 0;
    for (var i = 0; i < valeurs.length; i++) {
      total += valeurs[i];
      valeurs[i] = total;
    }
    return valeurs;
  }

  // ---------- état ----------
  var reseau = null;      // cts-reseau.json
  var courses = null;     // cts-courses.json décodé
  var chargement = null;
  var motifsParStation = null;   // idxStation -> [[idxMotif, position], …]
  var voisins = null;            // idxStation -> [[idxStation, minutes], …]
  var cacheServices = {};        // "idxService|AAAAMMJJ" -> booléen

  var TRANSFERT_MIN = 2;   // battement pour changer de véhicule à une station

  // ---------- dates ----------
  function iso(date) {
    var m = date.getMonth() + 1, j = date.getDate();
    return "" + date.getFullYear() + (m < 10 ? "0" : "") + m + (j < 10 ? "0" : "") + j;
  }

  function jourSemaineLundi0(date) {
    return (date.getDay() + 6) % 7;
  }

  function minuteDuJour(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  /* Dates encodées en écarts de jours depuis le début de validité (le flux
     SNCF définit ses services par listes de dates : 21 786 au total, qui
     pèseraient 300 Ko en clair). */
  function decoderDates(texte, origine) {
    var ensemble = {};
    if (!texte) return ensemble;
    var base = new Date(
      parseInt(origine.slice(0, 4), 10),
      parseInt(origine.slice(4, 6), 10) - 1,
      parseInt(origine.slice(6, 8), 10)
    );
    decoderSuite(texte).forEach(function (ecart) {
      var d = new Date(base.getTime());
      d.setDate(d.getDate() + ecart);
      ensemble[iso(d)] = true;
    });
    return ensemble;
  }

  /* Résolution GTFS complète : plage de validité, masque de jours, puis
     exceptions de calendar_dates (qui l'emportent). Indispensable ici : la CTS
     a des calendriers d'un seul jour et des types de jours irréguliers, la SNCF
     ne s'appuie que sur des listes de dates. */
  function serviceActif(idxService, date) {
    var cle = idxService + "|" + iso(date);
    if (cle in cacheServices) return cacheServices[cle];
    var s = courses.services[idxService];
    var resultat = false;
    if (s) {
      var d = iso(date);
      if (s.sauf[d]) resultat = false;
      else if (s.plus[d]) resultat = true;
      else if (d < s.debut || d > s.fin) resultat = false;
      else resultat = (s.jours & (1 << jourSemaineLundi0(date))) !== 0;
    }
    cacheServices[cle] = resultat;
    return resultat;
  }

  // ---------- chargement ----------
  var chargementReseau = null;

  /* Le réseau seul (50 Ko) suffit à dessiner la carte : on l'expose sans
     attendre les horaires, dix fois plus lourds. */
  function chargerReseauSeul() {
    if (chargementReseau) return chargementReseau;
    chargementReseau = fetch("data/reseau.json")
      .then(function (r) {
        if (!r.ok) throw new Error("reseau.json indisponible");
        return r.json();
      })
      .then(function (d) { reseau = d; return d; });
    return chargementReseau;
  }

  function charger() {
    if (chargement) return chargement;
    chargement = Promise.all([
      chargerReseauSeul(),
      fetch("data/courses.json").then(function (r) {
        if (!r.ok) throw new Error("courses.json indisponible");
        return r.json();
      })
    ]).then(function (paire) {
      courses = paire[1];
      decoder();
      return { reseau: reseau, courses: courses };
    });
    return chargement;
  }

  function decoder() {
    courses.services = courses.services.map(function (s) {
      return {
        jours: s[0], debut: s[1], fin: s[2],
        plus: decoderDates(s[3], s[1]), sauf: decoderDates(s[4], s[1])
      };
    });

    var nbCourses = 0;
    courses.motifs.forEach(function (m) {
      m.stations = decoderEntiers(m.s);
      m.profils = m.p.map(function (p) { return decoderSuite(p); });
      // attentes (départ - arrivée) : épars, uniquement aux battements de terminus
      m.attentes = m.profils.map(function () { return null; });
      (m.w || []).forEach(function (t) {
        var idxProfil = t[0];
        if (!m.attentes[idxProfil]) {
          m.attentes[idxProfil] = new Array(m.profils[idxProfil].length).fill(0);
        }
        m.attentes[idxProfil][t[1]] = t[2];
      });
      m.courses = m.c.map(function (c) {
        var bases = decoderSuite(c[1]);
        nbCourses += bases.length;
        return { service: c[0], bases: bases, profils: decoderEntiers(c[2]) };
      });
      // « f » : la course se poursuit hors zone (train filtré au périmètre),
      // son dernier arrêt connu est donc bien un départ
      m.tronque = !!m.f;
      delete m.s; delete m.p; delete m.c; delete m.w; delete m.f;
    });
    courses.nbCourses = nbCourses;

    motifsParStation = [];
    for (var i = 0; i < reseau.stations.length; i++) motifsParStation.push([]);
    courses.motifs.forEach(function (m, idxMotif) {
      m.stations.forEach(function (st, position) {
        motifsParStation[st].push([idxMotif, position]);
      });
    });

    voisins = [];
    for (var j = 0; j < reseau.stations.length; j++) voisins.push([]);
    courses.correspondances.forEach(function (c) {
      voisins[c[0]].push([c[1], c[2]]);
      voisins[c[1]].push([c[0], c[2]]);
    });
  }

  // ---------- départs à une station ----------

  /* Tous les départs d'une station pour la date donnée, en minutes depuis
     minuit (au-delà de 1440 pour les courses passant minuit). */
  function departsStation(idxStation, date) {
    var out = [];
    var vus = {};
    var entrees = motifsParStation[idxStation] || [];
    for (var e = 0; e < entrees.length; e++) {
      var idxMotif = entrees[e][0], position = entrees[e][1];
      var m = courses.motifs[idxMotif];
      // terminus : on n'en repart pas — sauf si la course continue hors zone
      if (position === m.stations.length - 1 && !m.tronque) continue;
      for (var c = 0; c < m.courses.length; c++) {
        var course = m.courses[c];
        if (!serviceActif(course.service, date)) continue;
        for (var k = 0; k < course.bases.length; k++) {
          var minute = course.bases[k] + m.profils[course.profils[k]][position];
          // une station peut apparaître deux fois dans un motif (deux poteaux)
          var cle = m.l + "|" + m.d + "|" + minute;
          if (vus[cle]) continue;
          vus[cle] = true;
          out.push({ ligne: m.l, dest: m.d, minute: minute });
        }
      }
    }
    out.sort(function (a, b) { return a.minute - b.minute; });
    return out;
  }

  // ---------- connexions pour le calcul d'itinéraires ----------

  /* Construit les connexions (tronçons entre deux arrêts consécutifs) sur une
     fenêtre horaire, en couvrant veille / jour / lendemain : une course codée
     à 25:30 la veille circule à 01:30 aujourd'hui. Les temps renvoyés sont
     ramenés à des minutes relatives au jour de référence. */
  function connexions(dateRef, minuteDebut, minuteFin) {
    var listes = { de: [], vers: [], dep: [], arr: [], course: [], motif: [] };
    var infos = [];   // par course : de quoi retrouver ses arrêts amont
    var nbCourses = 0;

    [-1, 0, 1].forEach(function (deltaJour) {
      var jour = new Date(dateRef.getTime());
      jour.setDate(jour.getDate() + deltaJour);
      var decalage = deltaJour * 1440;

      for (var im = 0; im < courses.motifs.length; im++) {
        var m = courses.motifs[im];
        for (var ic = 0; ic < m.courses.length; ic++) {
          var course = m.courses[ic];
          if (!serviceActif(course.service, jour)) continue;
          for (var k = 0; k < course.bases.length; k++) {
            var profil = m.profils[course.profils[k]];
            var attente = m.attentes[course.profils[k]];
            var base = course.bases[k] + decalage;
            // rejet rapide des courses entièrement hors fenêtre
            if (base + profil[profil.length - 1] < minuteDebut) continue;
            if (base + profil[0] > minuteFin) continue;
            var idCourse = nbCourses++;
            infos.push({ motif: im, base: base, profil: profil, attente: attente });
            for (var i = 0; i + 1 < profil.length; i++) {
              if (m.stations[i] === m.stations[i + 1]) continue;
              var dep = base + profil[i];
              if (dep < minuteDebut || dep > minuteFin) continue;
              var arr = base + profil[i + 1] - (attente ? attente[i + 1] : 0);
              if (arr < dep) arr = dep;
              listes.de.push(m.stations[i]);
              listes.vers.push(m.stations[i + 1]);
              listes.dep.push(dep);
              listes.arr.push(arr);
              listes.course.push(idCourse);
              listes.motif.push(im);
            }
          }
        }
      }
    });

    // tri par heure de départ : prérequis de l'algorithme CSA
    var ordre = new Uint32Array(listes.dep.length);
    for (var n = 0; n < ordre.length; n++) ordre[n] = n;
    var dep = listes.dep;
    Array.prototype.sort.call(ordre, function (a, b) { return dep[a] - dep[b]; });

    var nb = ordre.length;
    var res = {
      nb: nb, nbCourses: nbCourses, infos: infos,
      de: new Uint16Array(nb), vers: new Uint16Array(nb),
      dep: new Int32Array(nb), arr: new Int32Array(nb),
      course: new Uint32Array(nb), motif: new Uint16Array(nb)
    };
    for (var p = 0; p < nb; p++) {
      var o = ordre[p];
      res.de[p] = listes.de[o];
      res.vers[p] = listes.vers[o];
      res.dep[p] = listes.dep[o];
      res.arr[p] = listes.arr[o];
      res.course[p] = listes.course[o];
      res.motif[p] = listes.motif[o];
    }
    return res;
  }

  // ---------- accès géographique ----------
  function distanceM(lat1, lon1, lat2, lon2) {
    return Math.hypot((lon1 - lon2) * 74000.0, (lat1 - lat2) * 111200.0);
  }

  function minutesDeMarche(metres) {
    var p = courses && courses.marche ? courses.marche : { vitesse_m_min: 75, detour: 1.3 };
    // on est déjà à l'arrêt : ne pas facturer une minute qui ferait rater le
    // véhicule au départ immédiat
    if (metres < 40) return 0;
    return Math.max(1, Math.round(metres * p.detour / p.vitesse_m_min));
  }

  /* Stations atteignables à pied depuis un point, la plus proche d'abord. */
  function stationsProches(lat, lon, rayonM, maximum) {
    var out = [];
    var st = reseau.stations;
    for (var i = 0; i < st.length; i++) {
      var d = distanceM(lat, lon, st[i][2], st[i][3]);
      if (d <= rayonM) out.push({ station: i, metres: d, minutes: minutesDeMarche(d) });
    }
    out.sort(function (a, b) { return a.metres - b.metres; });
    return maximum ? out.slice(0, maximum) : out;
  }

  return {
    charger: charger,
    chargerReseauSeul: chargerReseauSeul,
    pret: function () { return !!courses; },
    lignes: function () { return reseau.lignes; },
    stations: function () { return reseau.stations; },
    destinations: function () { return reseau.destinations; },
    motifs: function () { return courses.motifs; },
    voisins: function () { return voisins; },
    nbCourses: function () { return courses.nbCourses; },
    serviceActif: serviceActif,
    departsStation: departsStation,
    connexions: connexions,
    stationsProches: stationsProches,
    minutesDeMarche: minutesDeMarche,
    distanceM: distanceM,
    minuteDuJour: minuteDuJour,
    jourSemaineLundi0: jourSemaineLundi0,
    iso: iso,
    TRANSFERT_MIN: TRANSFERT_MIN
  };
})();
