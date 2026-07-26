/* Proxy Cloudflare Worker — mode en ligne (phase 7).
 *
 * Un site statique ne peut pas embarquer les tokens CTS et SNCF (secrets).
 * Ce Worker les garde côté serveur, ajoute les en-têtes CORS, met les
 * réponses en cache 30 s (le quota des deux API est limité) et ne relaie
 * QUE des lectures — aucune écriture n'est possible vers CTS ou SNCF.
 *
 * Endpoints exposés à l'app :
 *   GET /cts/passages?refs=10A,10B          (StopCode CTS, séparés par virgule)
 *   GET /cts/perturbations[?lignes=A,B]      (messages généraux réseau)
 *   GET /sncf/passages?gare=StopArea:OCE87212308
 *
 * Références exactes tirées du swagger officiel (api.cts-strasbourg.eu/v1/
 * swagger.json) et de la documentation Navitia (doc.navitia.io) — non
 * vérifiées en conditions réelles faute de token au moment de l'écriture :
 * à confirmer sur les premières vraies réponses une fois les comptes
 * ouverts (voir README.md du dossier worker/).
 *
 * Déploiement : voir worker/README.md.
 */

const CTS_BASE = "https://api.cts-strasbourg.eu/v1";
const SNCF_BASE = "https://api.sncf.com/v1/coverage/sncf";
const CACHE_SECONDES = 30;

function basicAuth(token) {
  return "Basic " + btoa(token + ":");
}

function reponseJSON(corps, statut, origine) {
  return new Response(JSON.stringify(corps), {
    status: statut || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origine,
      "Cache-Control": "public, max-age=" + CACHE_SECONDES,
    },
  });
}

function erreurJSON(message, origine, statut) {
  return reponseJSON({ erreur: message }, statut || 502, origine);
}

// ---------- CTS (SIRI Lite) ----------

async function ctsPassages(refs, env, origine) {
  if (!refs.length) return erreurJSON("paramètre 'refs' manquant", origine, 400);
  var params = new URLSearchParams();
  refs.forEach(function (r) { params.append("MonitoringRef", r); });
  params.set("MaximumStopVisits", "6");

  var reponse = await fetch(CTS_BASE + "/siri/2.0/stop-monitoring?" + params.toString(), {
    headers: { Authorization: basicAuth(env.CTS_TOKEN), Accept: "application/json" },
    cf: { cacheTtl: CACHE_SECONDES, cacheEverything: true },
  });
  if (!reponse.ok) return erreurJSON("CTS a répondu " + reponse.status, origine, 502);
  var donnees = await reponse.json();

  var visites = [];
  var livraisons = (donnees.ServiceDelivery && donnees.ServiceDelivery.StopMonitoringDelivery) || [];
  livraisons.forEach(function (l) {
    (l.MonitoredStopVisit || []).forEach(function (v) { visites.push(v); });
  });

  var passages = visites.map(function (v) {
    var mvj = v.MonitoredVehicleJourney || {};
    var mc = mvj.MonitoredCall || {};
    var heure = mc.ExpectedDepartureTime || mc.ExpectedArrivalTime || null;
    return {
      ligne: mvj.PublishedLineName || mvj.LineRef || "?",
      destination: mvj.DestinationName || "",
      heure: heure,
    };
  }).filter(function (p) { return p.heure; })
    .sort(function (a, b) { return a.heure < b.heure ? -1 : 1; });

  return reponseJSON({ temps_reel: true, passages: passages }, 200, origine);
}

async function ctsPerturbations(lignes, env, origine) {
  var params = new URLSearchParams();
  lignes.forEach(function (l) { params.append("LineRef", l); });

  var reponse = await fetch(CTS_BASE + "/siri/2.0/general-message?" + params.toString(), {
    headers: { Authorization: basicAuth(env.CTS_TOKEN), Accept: "application/json" },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!reponse.ok) return erreurJSON("CTS a répondu " + reponse.status, origine, 502);
  var donnees = await reponse.json();

  var messages = (donnees.ServiceDelivery && donnees.ServiceDelivery.GeneralMessageDelivery) || [];
  var infos = [];
  messages.forEach(function (d) {
    (d.InfoMessage || []).forEach(function (m) {
      var contenu = m.Content || {};
      var texte = "";
      (contenu.Message || []).forEach(function (bloc) {
        if (bloc.MessageZoneRef !== "title") return;
        var fr = (bloc.MessageText || []).filter(function (t) { return t.Lang === "fr" || !t.Lang; })[0];
        if (fr && fr.Value) texte = fr.Value;
      });
      if (texte) {
        infos.push({
          texte: texte,
          lignes: contenu.ImpactedLineRef || [],
          reseau_entier: contenu.ImpactedGroupOfLinesRef === "CTS",
        });
      }
    });
  });

  return reponseJSON({ perturbations: infos }, 200, origine);
}

// ---------- SNCF (Navitia) ----------

async function sncfPassages(gare, env, origine) {
  if (!gare) return erreurJSON("paramètre 'gare' manquant", origine, 400);
  // reseau.json stocke l'id brut du GTFS SNCF ("StopArea:OCE...") ; Navitia
  // attend le même suffixe préfixé en minuscules ("stop_area:OCE...").
  var idNavitia = "stop_area:" + gare.replace(/^StopArea:/i, "");

  var reponse = await fetch(
    SNCF_BASE + "/stop_areas/" + encodeURIComponent(idNavitia) + "/departures?count=6",
    {
      headers: { Authorization: basicAuth(env.SNCF_TOKEN), Accept: "application/json" },
      cf: { cacheTtl: CACHE_SECONDES, cacheEverything: true },
    }
  );
  if (!reponse.ok) return erreurJSON("SNCF a répondu " + reponse.status, origine, 502);
  var donnees = await reponse.json();

  var passages = (donnees.departures || []).map(function (d) {
    var infos = d.display_informations || {};
    var sdt = d.stop_date_time || {};
    var theorique = sdt.base_departure_date_time || sdt.departure_date_time;
    var estime = sdt.departure_date_time || theorique;
    return {
      ligne: infos.code || infos.commercial_mode || "TER",
      destination: infos.direction || infos.headsign || "",
      theorique: theorique,
      estime: estime,
      retard: theorique && estime && theorique !== estime,
    };
  });

  return reponseJSON({ temps_reel: true, passages: passages }, 200, origine);
}

// ---------- routage ----------

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var origine = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origine,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }
    if (request.method !== "GET") {
      return erreurJSON("méthode non lue seule refusée", origine, 405);
    }

    try {
      if (url.pathname === "/cts/passages") {
        var refs = (url.searchParams.get("refs") || "").split(",").filter(Boolean);
        return await ctsPassages(refs, env, origine);
      }
      if (url.pathname === "/cts/perturbations") {
        var lignes = (url.searchParams.get("lignes") || "").split(",").filter(Boolean);
        return await ctsPerturbations(lignes, env, origine);
      }
      if (url.pathname === "/sncf/passages") {
        return await sncfPassages(url.searchParams.get("gare"), env, origine);
      }
      return erreurJSON("route inconnue", origine, 404);
    } catch (e) {
      return erreurJSON("erreur interne : " + e.message, origine, 500);
    }
  },
};
