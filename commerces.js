/* Bulle d'info (horaires + site web) pour les restaurants, cafés, bars,
   bureaux de poste, librairies et médiathèques déjà affichés par le fond de
   carte (couche « pois » du style Protomaps, posée par app.js). Ce module
   n'ajoute aucune couche ni aucun marqueur : il rend cliquables des points
   déjà visibles, en allant chercher le détail (OpenStreetMap, comme pour les
   musées — voir musees.js) le plus proche du point cliqué. Interprétation
   des horaires déléguée à Musees.etatOuverture/resume, chargé avant ce
   script (index.html). */
"use strict";

var Commerces = (function () {
  var donnees = null;
  var chargement = null;
  var carte = null;
  var DISTANCE_MAX_M = 40;

  var LIBELLES = {
    restaurant: "Restaurant",
    cafe: "Café",
    bar: "Bar",
    post_office: "Bureau de poste",
    books: "Librairie",
    library: "Médiathèque"
  };

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
    charger().catch(function (e) {
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

    // curseur en main uniquement sur les 4 catégories cliquables : les
    // autres genres de la couche « pois » (bancs, toilettes, œuvres…)
    // restent volontairement non interactifs.
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
