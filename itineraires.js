/* Itinéraires porte-à-porte, calculés entièrement hors ligne.

   Algorithme CSA (Connection Scan Algorithm) : les connexions du jour — un
   tronçon entre deux arrêts consécutifs d'une course — sont parcourues une
   seule fois par ordre d'heure de départ, en tenant à jour la meilleure heure
   d'arrivée connue à chaque station. Les correspondances à pied entre stations
   proches sont relâchées à chaque amélioration.

   Marche d'accès et de sortie incluses ; la position de l'utilisateur ne quitte
   jamais l'appareil. */
"use strict";

var Itineraires = (function () {
  var INF = 1e9;
  var FENETRE_MIN = 300;      // profondeur de scan : 5 h
  var RAYON_ACCES_M = 900;    // marche depuis l'origine / vers la destination
  var MAX_ACCES = 14;
  var NB_SOLUTIONS = 3;

  var etat = { depart: null, arrivee: null };   // {lat, lon, nom}
  var connexionsCache = null;                   // {cle, data}

  // ---------- utilitaires d'affichage ----------
  function formaterHeure(minutes) {
    var m = ((minutes % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mn = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mn < 10 ? "0" : "") + mn;
  }

  function formaterDuree(minutes) {
    if (minutes < 60) return minutes + " min";
    var h = Math.floor(minutes / 60), mn = minutes % 60;
    return mn ? h + " h " + (mn < 10 ? "0" : "") + mn : h + " h";
  }

  // ---------- cœur : un balayage CSA ----------

  /* accesDepart : [{station, minutes, metres}] atteignables à pied au départ.
     coursesExclues : courses à ignorer, pour énumérer de vraies variantes sans
     recalculer les connexions. Exclure une course plutôt qu'une plage horaire
     évite de proposer le même véhicule pris deux arrêts plus loin. */
  function balayer(conns, accesDepart, tDepart, coursesExclues) {
    var nbSt = Reseau.stations().length;
    var arrivee = new Int32Array(nbSt).fill(INF);
    var pret = new Int32Array(nbSt).fill(INF);
    var marche = new Int32Array(nbSt).fill(INF);  // minutes de marche cumulées
    var venue = new Array(nbSt).fill(null);
    var monte = new Uint8Array(conns.nbCourses);
    var voisins = Reseau.voisins();

    /* À heure d'arrivée égale, on retient le trajet qui marche le moins :
       sinon, atteindre une station à pied « à temps » pour un véhicule qui
       passe aussi par l'arrêt de départ ferait conseiller douze minutes de
       marche là où il suffit d'attendre le même tram sur place. */
    function ameliore(st, heure, marcheCumulee) {
      return heure < arrivee[st] || (heure === arrivee[st] && marcheCumulee < marche[st]);
    }

    for (var a = 0; a < accesDepart.length; a++) {
      var acces = accesDepart[a];
      var t = tDepart + acces.minutes;
      if (ameliore(acces.station, t, acces.minutes)) {
        arrivee[acces.station] = t;
        pret[acces.station] = t;
        marche[acces.station] = acces.minutes;
        venue[acces.station] = {
          type: "depart", minutes: acces.minutes, metres: acces.metres
        };
      }
    }

    for (var i = 0; i < conns.nb; i++) {
      var dep = conns.dep[i];
      var course = conns.course[i];
      if (coursesExclues[course]) continue;
      var de = conns.de[i];
      if (!monte[course]) {
        if (pret[de] > dep) continue;
        monte[course] = 1;
      }
      var vers = conns.vers[i], arr = conns.arr[i];
      var marcheIci = marche[de] === INF ? 0 : marche[de];
      if (!ameliore(vers, arr, marcheIci)) continue;

      arrivee[vers] = arr;
      marche[vers] = marcheIci;
      venue[vers] = { type: "vehicule", conn: i };
      if (arr + Reseau.TRANSFERT_MIN < pret[vers]) pret[vers] = arr + Reseau.TRANSFERT_MIN;

      // une correspondance à pied vaut aussi battement : pas de marge en plus
      var vs = voisins[vers];
      for (var v = 0; v < vs.length; v++) {
        var y = vs[v][0], ty = arr + vs[v][1], my = marcheIci + vs[v][1];
        if (ameliore(y, ty, my)) {
          arrivee[y] = ty;
          marche[y] = my;
          venue[y] = { type: "marche", depuis: vers, minutes: vs[v][1] };
          if (ty < pret[y]) pret[y] = ty;
        }
      }
    }
    return { arrivee: arrivee, venue: venue, marche: marche };
  }

  /* Remonte les prédécesseurs depuis la station d'arrivée. Les tronçons
     consécutifs d'une même course sont fusionnés en un seul trajet à bord. */
  function reconstruire(res, conns, stFinale) {
    var etapes = [];
    var st = stFinale;
    var garde = 0;
    while (res.venue[st] && res.venue[st].type !== "depart" && garde++ < 300) {
      var v = res.venue[st];
      if (v.type === "marche") {
        etapes.push({
          type: "marche", de: v.depuis, vers: st, minutes: v.minutes
        });
        st = v.depuis;
      } else {
        var i = v.conn;
        var course = conns.course[i];
        var stFin = conns.vers[i], hArrivee = conns.arr[i];
        var idxMotif = conns.motif[i];
        var stDebut = conns.de[i], hDepart = conns.dep[i];
        var arrets = 1;
        while (true) {
          var precedent = res.venue[stDebut];
          if (precedent && precedent.type === "vehicule" &&
              conns.course[precedent.conn] === course) {
            i = precedent.conn;
            stDebut = conns.de[i];
            hDepart = conns.dep[i];
            arrets++;
          } else {
            break;
          }
        }
        etapes.push({
          type: "vehicule", motif: idxMotif, de: stDebut, vers: stFin,
          depart: hDepart, arrivee: hArrivee, arrets: arrets, course: course
        });
        st = stDebut;
      }
    }
    var origine = res.venue[st];
    if (!origine || origine.type !== "depart") return null;
    etapes.push({
      type: "acces", vers: st, minutes: origine.minutes, metres: origine.metres
    });
    etapes.reverse();
    return etapes;
  }

  /* Recale le point de montée le plus en amont possible sur la même course.

     Le CSA minimise l'heure d'arrivée station par station : rejoindre à pied
     un arrêt plus loin peut « gagner » quelques minutes sur cette station sans
     rien gagner sur la course elle-même. On conseillerait alors onze minutes
     de marche pour prendre le tram qui passe de toute façon à l'arrêt de
     départ. On remonte donc la course tant qu'un arrêt amont est joignable à
     pied plus facilement, à heure d'arrivée finale inchangée. */
  function recalerMontee(etapes, conns, accesParStation, tDepart) {
    var iVehicule = -1;
    for (var i = 0; i < etapes.length; i++) {
      if (etapes[i].type === "vehicule") { iVehicule = i; break; }
    }
    if (iVehicule < 1 || etapes[0].type !== "acces") return etapes;

    var leg = etapes[iVehicule];
    var info = conns.infos[leg.course];
    if (!info) return etapes;
    var stations = Reseau.motifs()[info.motif].stations;

    // position de montée dans le motif
    var position = -1;
    for (var p = 0; p < stations.length; p++) {
      if (stations[p] === leg.de && info.base + info.profil[p] === leg.depart) {
        position = p;
        break;
      }
    }
    if (position <= 0) return etapes;

    var meilleur = null;
    var marcheActuelle = etapes[0].minutes;
    for (var j = position - 1; j >= 0; j--) {
      var acces = accesParStation[stations[j]];
      if (!acces || acces.minutes >= marcheActuelle) continue;
      var depart = info.base + info.profil[j];
      if (tDepart + acces.minutes > depart) continue;   // pas le temps d'y être
      if (!meilleur || acces.minutes < meilleur.acces.minutes) {
        meilleur = { position: j, acces: acces, depart: depart };
      }
    }
    if (!meilleur) return etapes;

    etapes[0] = {
      type: "acces", vers: stations[meilleur.position],
      minutes: meilleur.acces.minutes, metres: meilleur.acces.metres
    };
    leg.de = stations[meilleur.position];
    leg.depart = meilleur.depart;
    leg.arrets += position - meilleur.position;
    return etapes;
  }

  /* Note sur chaque tronçon à bord la suite des stations traversées, pour
     pouvoir tracer le trajet sans conserver les connexions. */
  function completerChemins(etapes, conns) {
    etapes.forEach(function (e) {
      if (e.type !== "vehicule") return;
      var info = conns.infos[e.course];
      if (!info) return;
      var stations = Reseau.motifs()[info.motif].stations;
      var debut = -1, fin = -1;
      for (var p = 0; p < stations.length; p++) {
        if (debut < 0) {
          if (stations[p] === e.de && info.base + info.profil[p] === e.depart) debut = p;
        } else if (stations[p] === e.vers) {
          fin = p;
          break;
        }
      }
      if (debut >= 0 && fin > debut) e.chemin = stations.slice(debut, fin + 1);
    });
  }

  /* Géométrie du trajet : la suite des arrêts pour les tronçons à bord, un
     segment droit pour la marche. Les tracés de lignes ne sont pas découpés
     par arrêt, on relie donc les stations entre elles. */
  function geometrie(solution, depart, arrivee) {
    var st = Reseau.stations();
    var features = [];

    function trait(coords, couleur, mode) {
      if (coords.length < 2) return;
      features.push({
        type: "Feature",
        properties: { couleur: couleur, mode: mode },
        geometry: { type: "LineString", coordinates: coords }
      });
    }

    var grise = "#888888";
    solution.etapes.forEach(function (e) {
      if (e.type === "vehicule") {
        var chemin = e.chemin || [e.de, e.vers];
        var l = Reseau.lignes()[Reseau.motifs()[e.motif].l];
        trait(chemin.map(function (i) { return [st[i][3], st[i][2]]; }), l.couleur, "transport");
      } else if (e.type === "acces") {
        trait([[depart.lon, depart.lat], [st[e.vers][3], st[e.vers][2]]], grise, "marche");
      } else if (e.type === "sortie") {
        trait([[st[e.de][3], st[e.de][2]], [arrivee.lon, arrivee.lat]], grise, "marche");
      } else if (e.type === "marche") {
        trait([[st[e.de][3], st[e.de][2]], [st[e.vers][3], st[e.vers][2]]], grise, "marche");
      }
    });
    return features;
  }

  // ---------- calcul complet ----------
  function calculer(depart, arrivee, quand) {
    var tDepart = Reseau.minuteDuJour(quand);
    var accesDepart = Reseau.stationsProches(depart.lat, depart.lon, RAYON_ACCES_M, MAX_ACCES);
    var accesArrivee = Reseau.stationsProches(arrivee.lat, arrivee.lon, RAYON_ACCES_M, MAX_ACCES);

    if (!accesDepart.length || !accesArrivee.length) {
      return { erreur: "Aucun arrêt à moins de " + RAYON_ACCES_M + " m " +
                       (accesDepart.length ? "de l'arrivée" : "du départ") + "." };
    }

    // marche directe si les deux points sont voisins
    var directM = Reseau.distanceM(depart.lat, depart.lon, arrivee.lat, arrivee.lon);
    var marcheDirecte = Reseau.minutesDeMarche(directM);

    var cle = Reseau.iso(quand) + "|" + tDepart;
    if (!connexionsCache || connexionsCache.cle !== cle) {
      var t0 = performance.now();
      connexionsCache = {
        cle: cle,
        data: Reseau.connexions(quand, tDepart, tDepart + FENETRE_MIN)
      };
      connexionsCache.ms = Math.round(performance.now() - t0);
    }
    var conns = connexionsCache.data;

    var accesParStation = {};
    accesDepart.forEach(function (a) { accesParStation[a.station] = a; });

    var solutions = [];
    var coursesExclues = new Uint8Array(conns.nbCourses);
    for (var essai = 0; essai < NB_SOLUTIONS; essai++) {
      var res = balayer(conns, accesDepart, tDepart, coursesExclues);

      // meilleure station de descente, marche finale comprise
      var meilleure = null;
      for (var k = 0; k < accesArrivee.length; k++) {
        var acces = accesArrivee[k];
        if (res.arrivee[acces.station] >= INF) continue;
        var total = res.arrivee[acces.station] + acces.minutes;
        if (!meilleure || total < meilleure.total) {
          meilleure = { total: total, station: acces.station, sortie: acces };
        }
      }
      if (!meilleure) break;

      var etapes = reconstruire(res, conns, meilleure.station);
      if (!etapes) break;
      etapes = recalerMontee(etapes, conns, accesParStation, tDepart);
      completerChemins(etapes, conns);
      if (meilleure.sortie.minutes > 0) {
        etapes.push({
          type: "sortie", de: meilleure.station,
          minutes: meilleure.sortie.minutes, metres: meilleure.sortie.metres
        });
      }

      var premierVehicule = etapes.filter(function (e) { return e.type === "vehicule"; });
      if (!premierVehicule.length) break;
      var depart0 = premierVehicule[0].depart;
      var arrivee0 = premierVehicule[premierVehicule.length - 1].arrivee;

      solutions.push({
        etapes: etapes,
        depart: depart0 - etapes[0].minutes,
        arrivee: meilleure.total,
        duree: meilleure.total - (depart0 - etapes[0].minutes),
        correspondances: premierVehicule.length - 1
      });
      coursesExclues[premierVehicule[0].course] = 1;
    }

    solutions.sort(function (a, b) {
      return a.arrivee - b.arrivee || a.duree - b.duree;
    });

    return {
      solutions: solutions,
      marcheDirecte: directM <= 1800 ? { minutes: marcheDirecte, metres: directM } : null,
      diagnostic: {
        connexions: conns.nb, courses: conns.nbCourses,
        constructionMs: connexionsCache.ms
      }
    };
  }

  // ---------- interface ----------
  function nomStation(idx) {
    return Reseau.stations()[idx][1];
  }

  function badgeMotif(idxMotif) {
    var m = Reseau.motifs()[idxMotif];
    var l = Reseau.lignes()[m.l];
    var span = document.createElement("span");
    span.className = "badge";
    span.textContent = l.nom;
    span.style.backgroundColor = l.couleur;
    span.style.color = l.texte;
    return span;
  }

  function rendreEtape(etape) {
    var div = document.createElement("div");
    div.className = "etape " + etape.type;

    if (etape.type === "acces" || etape.type === "sortie" || etape.type === "marche") {
      var icone = document.createElement("span");
      icone.className = "icone-marche";
      icone.textContent = "⏱";
      div.appendChild(icone);
      var texte = document.createElement("span");
      texte.className = "texte-etape";
      if (etape.type === "acces") {
        texte.textContent = etape.minutes === 0
          ? "Départ de " + nomStation(etape.vers)
          : "Marche " + etape.minutes + " min (" + Math.round(etape.metres) +
            " m) jusqu'à " + nomStation(etape.vers);
      } else if (etape.type === "sortie") {
        texte.textContent = "Marche " + etape.minutes + " min (" +
          Math.round(etape.metres) + " m) jusqu'à l'arrivée";
      } else {
        texte.textContent = "Correspondance à pied " + etape.minutes + " min vers " +
          nomStation(etape.vers);
      }
      div.appendChild(texte);
      return div;
    }

    div.appendChild(badgeMotif(etape.motif));
    var corps = document.createElement("span");
    corps.className = "texte-etape";
    var m = Reseau.motifs()[etape.motif];
    var dir = document.createElement("strong");
    dir.textContent = "direction " + Reseau.destinations()[m.d];
    corps.appendChild(dir);
    corps.appendChild(document.createElement("br"));
    var detail = document.createElement("span");
    detail.className = "detail-etape";
    detail.textContent = formaterHeure(etape.depart) + " " + nomStation(etape.de) +
      " → " + formaterHeure(etape.arrivee) + " " + nomStation(etape.vers) +
      " · " + etape.arrets + (etape.arrets > 1 ? " arrêts" : " arrêt");
    corps.appendChild(detail);
    div.appendChild(corps);
    return div;
  }

  function rendreSolution(sol, rang, tracer) {
    var bloc = document.createElement("details");
    bloc.className = "solution";
    if (rang === 0) bloc.open = true;
    // n'afficher qu'un trajet à la fois sur la carte : celui qu'on déplie
    bloc.addEventListener("toggle", function () {
      if (bloc.open) tracer(sol, bloc);
    });

    var resume = document.createElement("summary");
    var horaires = document.createElement("span");
    horaires.className = "resume-horaires";
    horaires.textContent = formaterHeure(sol.depart) + " → " + formaterHeure(sol.arrivee);
    resume.appendChild(horaires);

    var badges = document.createElement("span");
    badges.className = "resume-badges";
    sol.etapes.forEach(function (e) {
      if (e.type === "vehicule") badges.appendChild(badgeMotif(e.motif));
    });
    resume.appendChild(badges);

    var duree = document.createElement("span");
    duree.className = "resume-duree";
    duree.textContent = formaterDuree(sol.duree) +
      (sol.correspondances ? " · " + sol.correspondances +
        (sol.correspondances > 1 ? " changements" : " changement") : " · direct");
    resume.appendChild(duree);
    bloc.appendChild(resume);

    sol.etapes.forEach(function (e) { bloc.appendChild(rendreEtape(e)); });
    return bloc;
  }

  // ---------- formulaire ----------
  function champLieu(role, valeurInitiale, surChoix) {
    var enveloppe = document.createElement("div");
    enveloppe.className = "champ-lieu";

    var input = document.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = role;
    input.setAttribute("aria-label", role);
    if (valeurInitiale) input.value = valeurInitiale.nom;
    enveloppe.appendChild(input);

    var liste = document.createElement("ul");
    liste.className = "suggestions";
    liste.hidden = true;
    enveloppe.appendChild(liste);

    function fermer() { liste.hidden = true; liste.textContent = ""; }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q.length < 2) { fermer(); return; }
      Carte.chercher(q, 6).then(function (entrees) {
        liste.textContent = "";
        if (!entrees.length) { fermer(); return; }
        entrees.forEach(function (e) {
          var li = document.createElement("li");
          var nom = document.createElement("span");
          nom.textContent = e[0];
          var type = document.createElement("span");
          type.className = "type";
          type.textContent = e[3] === "arret" ? "arrêt " + (e[4] || "")
            : (e[3] === "lieu" ? "localité" : (e[4] || "rue"));
          li.appendChild(nom);
          li.appendChild(type);
          li.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            input.value = e[0];
            fermer();
            surChoix({ lat: e[1], lon: e[2], nom: e[0] });
          });
          liste.appendChild(li);
        });
        liste.hidden = false;
      });
    });
    input.addEventListener("blur", function () { setTimeout(fermer, 150); });

    return { element: enveloppe, input: input };
  }

  function ouvrir() {
    var corps = Transports.ouvrirFiche("Itinéraire", "Calcul hors ligne");

    var form = document.createElement("div");
    form.className = "form-itineraire";

    var champDepart = champLieu("Départ", etat.depart, function (lieu) {
      etat.depart = lieu;
    });
    var champArrivee = champLieu("Arrivée", etat.arrivee, function (lieu) {
      etat.arrivee = lieu;
    });

    var ligneDepart = document.createElement("div");
    ligneDepart.className = "ligne-champ";
    ligneDepart.appendChild(champDepart.element);
    var btnPosition = document.createElement("button");
    btnPosition.type = "button";
    btnPosition.className = "btn-position";
    btnPosition.title = "Utiliser ma position";
    btnPosition.textContent = "◎";
    ligneDepart.appendChild(btnPosition);
    form.appendChild(ligneDepart);

    form.appendChild(champArrivee.element);

    var ligneQuand = document.createElement("div");
    ligneQuand.className = "ligne-champ";
    var maintenant = new Date();
    var champDate = document.createElement("input");
    champDate.type = "date";
    champDate.value = maintenant.getFullYear() + "-" +
      String(maintenant.getMonth() + 1).padStart(2, "0") + "-" +
      String(maintenant.getDate()).padStart(2, "0");
    var champHeure = document.createElement("input");
    champHeure.type = "time";
    champHeure.value = String(maintenant.getHours()).padStart(2, "0") + ":" +
      String(maintenant.getMinutes()).padStart(2, "0");
    ligneQuand.appendChild(champDate);
    ligneQuand.appendChild(champHeure);
    form.appendChild(ligneQuand);

    var btnCalculer = document.createElement("button");
    btnCalculer.type = "button";
    btnCalculer.className = "btn-calculer";
    btnCalculer.textContent = "Calculer l'itinéraire";
    form.appendChild(btnCalculer);

    corps.appendChild(form);

    var zoneResultats = document.createElement("div");
    zoneResultats.className = "resultats-itineraire";
    corps.appendChild(zoneResultats);

    function message(texte, classe) {
      zoneResultats.textContent = "";
      var p = document.createElement("p");
      p.className = classe || "note";
      p.textContent = texte;
      zoneResultats.appendChild(p);
    }

    btnPosition.addEventListener("click", function () {
      if (!navigator.geolocation) {
        message("La géolocalisation n'est pas disponible sur cet appareil.");
        return;
      }
      btnPosition.disabled = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        btnPosition.disabled = false;
        etat.depart = {
          lat: pos.coords.latitude, lon: pos.coords.longitude, nom: "Ma position"
        };
        champDepart.input.value = "Ma position";
      }, function (err) {
        btnPosition.disabled = false;
        message("Position indisponible : " + err.message);
      }, { enableHighAccuracy: true, timeout: 10000 });
    });

    btnCalculer.addEventListener("click", function () {
      if (!etat.depart || !etat.arrivee) {
        message("Choisissez un départ et une arrivée dans les suggestions.");
        return;
      }
      var quand = new Date(champDate.value + "T" + (champHeure.value || "00:00"));
      if (isNaN(quand.getTime())) { message("Date ou heure invalide."); return; }

      message("Calcul en cours…");
      Reseau.charger().then(function () {
        var t0 = performance.now();
        var res = calculer(etat.depart, etat.arrivee, quand);
        var ms = Math.round(performance.now() - t0);

        zoneResultats.textContent = "";
        if (res.erreur) { message(res.erreur); return; }

        var entete = document.createElement("p");
        entete.className = "note";
        entete.textContent = etat.depart.nom + " → " + etat.arrivee.nom;
        zoneResultats.appendChild(entete);

        if (!res.solutions.length) {
          message("Aucun trajet en transport dans les " +
            Math.round(FENETRE_MIN / 60) + " h suivantes.");
        } else {
          var blocs = [];
          var tracer = function (sol, bloc) {
            blocs.forEach(function (b) { if (b !== bloc) b.open = false; });
            Transports.dessinerTrajet(geometrie(sol, etat.depart, etat.arrivee));
          };
          res.solutions.forEach(function (sol, rang) {
            var bloc = rendreSolution(sol, rang, tracer);
            blocs.push(bloc);
            zoneResultats.appendChild(bloc);
          });
          Transports.dessinerTrajet(geometrie(res.solutions[0], etat.depart, etat.arrivee));
        }

        if (res.marcheDirecte) {
          var marche = document.createElement("p");
          marche.className = "note";
          marche.textContent = "À pied directement : " + res.marcheDirecte.minutes +
            " min (" + Math.round(res.marcheDirecte.metres) + " m).";
          zoneResultats.appendChild(marche);
        }

        var diag = document.createElement("p");
        diag.className = "note";
        diag.textContent = res.diagnostic.connexions + " connexions scannées en " +
          ms + " ms · horaires théoriques CTS.";
        zoneResultats.appendChild(diag);
      }).catch(function (e) {
        message("Horaires indisponibles : " + e.message);
      });
    });

    // pré-remplissage depuis une fiche arrêt
    if (etat.depart && !champDepart.input.value) champDepart.input.value = etat.depart.nom;
    if (etat.arrivee && !champArrivee.input.value) champArrivee.input.value = etat.arrivee.nom;
  }

  function definirDepart(lieu) { etat.depart = lieu; }
  function definirArrivee(lieu) { etat.arrivee = lieu; }

  function initialiser() {
    var chip = document.getElementById("chip-itineraire");
    if (chip) chip.addEventListener("click", ouvrir);
  }

  return {
    initialiser: initialiser,
    ouvrir: ouvrir,
    definirDepart: definirDepart,
    definirArrivee: definirArrivee,
    calculer: calculer,   // exposé pour les contrôles
    etat: function () { return etat; }
  };
})();
