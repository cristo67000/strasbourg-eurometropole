/* Mode en ligne (phase 7) : passages CTS/SNCF en temps réel via un proxy
   Cloudflare Worker (voir worker/README.md) qui garde les tokens côté
   serveur. Tant qu'aucune URL de proxy n'est configurée — ou qu'il ne
   répond pas — l'app se comporte exactement comme hors ligne : uniquement
   les horaires théoriques déjà calculés par transports.js. Rien de ceci
   n'est nécessaire au fonctionnement hors ligne de l'app. */
"use strict";

var TempsReel = (function () {
  var CLE = "tr-base";
  var DELAI_MS = 4000;

  function base() {
    return (localStorage.getItem(CLE) || "").replace(/\/+$/, "");
  }

  function actif() {
    return !!base();
  }

  function definirBase(url) {
    if (url) localStorage.setItem(CLE, url.trim());
    else localStorage.removeItem(CLE);
  }

  function requeteJSON(chemin) {
    var b = base();
    if (!b) return Promise.resolve(null);
    var controleur = new AbortController();
    var minuteur = setTimeout(function () { controleur.abort(); }, DELAI_MS);
    return fetch(b + chemin, { signal: controleur.signal })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .finally(function () { clearTimeout(minuteur); });
  }

  /* Contrairement à requeteJSON, distingue « le proxy répond » (même par une
     erreur applicative — refs manquant, token invalide…) de « injoignable »
     (réseau coupé, mauvaise URL, CORS mal configuré) : une requête réseau
     qui échoue rejette au lieu de se résoudre en `null`. */
  function verifierConnexion() {
    var b = base();
    if (!b) return Promise.resolve(false);
    var controleur = new AbortController();
    var minuteur = setTimeout(function () { controleur.abort(); }, DELAI_MS);
    return fetch(b + "/cts/passages", { signal: controleur.signal })
      .then(function () { return true; })
      .catch(function () { return false; })
      .finally(function () { clearTimeout(minuteur); });
  }

  function passagesCts(refs) {
    return requeteJSON("/cts/passages?refs=" + refs.map(encodeURIComponent).join(","))
      .then(function (d) { return d && d.passages ? d.passages : null; });
  }

  function passagesSncf(ref) {
    return requeteJSON("/sncf/passages?gare=" + encodeURIComponent(ref))
      .then(function (d) { return d && d.passages ? d.passages : null; });
  }

  // ---------- affichage dans la fiche arrêt/gare ----------
  function formaterISO(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function badgePourLigne(nomLigne) {
    var lignes = Reseau.lignes();
    for (var i = 0; i < lignes.length; i++) {
      if (lignes[i].nom === nomLigne) return Transports.badgeLigne(i);
    }
    var span = document.createElement("span");
    span.className = "badge";
    span.style.background = "#616161";
    span.style.color = "#ffffff";
    span.textContent = nomLigne;
    return span;
  }

  function ligneCts(p) {
    var l = document.createElement("div");
    l.className = "passage";
    l.appendChild(badgePourLigne(p.ligne));
    var dest = document.createElement("span");
    dest.className = "destination";
    dest.textContent = p.destination;
    l.appendChild(dest);
    var heure = document.createElement("span");
    heure.className = "heures";
    heure.textContent = formaterISO(p.heure);
    l.appendChild(heure);
    return l;
  }

  function ligneSncf(p) {
    var l = document.createElement("div");
    l.className = "passage";
    var badge = document.createElement("span");
    badge.className = "badge";
    badge.style.background = "#616161";
    badge.style.color = "#ffffff";
    badge.textContent = p.ligne;
    l.appendChild(badge);
    var dest = document.createElement("span");
    dest.className = "destination";
    dest.textContent = p.destination;
    l.appendChild(dest);
    var heure = document.createElement("span");
    heure.className = "heures";
    heure.textContent = formaterISO(p.estime) + (p.retard ? " (retardé)" : "");
    l.appendChild(heure);
    return l;
  }

  /* Tente de remplacer les horaires théoriques déjà affichés par du temps
     réel. `conteneur` doit être le nœud qui porte les passages théoriques ;
     s'il n'est plus attaché au DOM à la réponse (fiche fermée ou remplacée
     entre-temps), on abandonne silencieusement — pas d'ordre d'annulation
     de fetch nécessaire, ce test suffit. */
  function essayerStation(station, conteneur) {
    if (!actif() || !conteneur) return;
    var refs = station[6] || [];
    if (!refs.length) return;
    var gare = station[5] === "SNCF";
    var promesse = gare ? passagesSncf(refs[0]) : passagesCts(refs);

    promesse.then(function (passages) {
      if (!conteneur.isConnected || !passages) return;
      conteneur.textContent = "";
      var entete = document.createElement("p");
      entete.className = "note tr-badge";
      entete.textContent = "● Temps réel (" + (gare ? "SNCF" : "CTS") + ")";
      conteneur.appendChild(entete);
      if (!passages.length) {
        var vide = document.createElement("p");
        vide.className = "note";
        vide.textContent = "Aucun passage annoncé pour l'instant.";
        conteneur.appendChild(vide);
        return;
      }
      passages.slice(0, 8).forEach(function (p) {
        conteneur.appendChild(gare ? ligneSncf(p) : ligneCts(p));
      });
    });
  }

  // ---------- panneau de configuration ----------
  function ouvrirPanneau() {
    var corps = Transports.ouvrirFiche("Mode en ligne", "");

    var etat = document.createElement("p");
    etat.className = "note";
    corps.appendChild(etat);

    var champ = document.createElement("input");
    champ.type = "url";
    champ.placeholder = "https://….workers.dev";
    champ.value = base();
    var ligneChamp = document.createElement("label");
    ligneChamp.className = "champ-poi";
    var libelle = document.createElement("span");
    libelle.textContent = "URL du proxy (Cloudflare Worker)";
    ligneChamp.appendChild(libelle);
    ligneChamp.appendChild(champ);
    corps.appendChild(ligneChamp);

    var actions = document.createElement("div");
    actions.className = "actions";
    var btnTester = document.createElement("button");
    btnTester.type = "button";
    btnTester.className = "btn-calculer";
    btnTester.textContent = "Enregistrer et tester";
    actions.appendChild(btnTester);
    var btnDesactiver = document.createElement("button");
    btnDesactiver.type = "button";
    btnDesactiver.textContent = "Désactiver";
    actions.appendChild(btnDesactiver);
    corps.appendChild(actions);

    function rafraichirEtat() {
      if (!actif()) {
        etat.textContent = "Non configuré : l'app affiche uniquement les " +
          "horaires théoriques, comme hors ligne.";
        return;
      }
      etat.textContent = "Vérification…";
      verifierConnexion().then(function (ok) {
        etat.textContent = ok
          ? "Configuré et joignable : " + base() +
            ". Les fiches arrêt/gare tenteront le temps réel automatiquement."
          : "Configuré, mais injoignable pour l'instant (URL incorrecte, " +
            "Worker non déployé, ou hors ligne). Les horaires théoriques " +
            "restent utilisés en attendant.";
      });
    }

    btnTester.addEventListener("click", function () {
      definirBase(champ.value);
      rafraichirEtat();
    });
    btnDesactiver.addEventListener("click", function () {
      definirBase(null);
      champ.value = "";
      rafraichirEtat();
    });

    var note = document.createElement("p");
    note.className = "note";
    note.textContent = "Le proxy doit être déployé au préalable (voir " +
      "worker/README.md dans le dépôt) : il garde les tokens CTS et SNCF " +
      "côté serveur. Rien d'autre que l'heure des passages ne transite " +
      "par ce proxy.";
    corps.appendChild(note);

    rafraichirEtat();
  }

  function initialiser() {
    var chip = document.getElementById("chip-en-ligne");
    if (chip) chip.addEventListener("click", ouvrirPanneau);
  }

  return {
    initialiser: initialiser,
    actif: actif,
    essayerStation: essayerStation,
    ouvrirPanneau: ouvrirPanneau
  };
})();
