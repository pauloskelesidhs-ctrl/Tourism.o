// Tourist Greece PWA (menu-first, local-only)
//
// Data sources:
// - POIs: OpenStreetMap via Overpass API (free, legal, nationwide)
// - Accessibility points: local JSON (you control)
// - Beaches: discovered via Overpass (beach + beach bars), then “party score” ranking
//
// Notes on iPhone:
// - Location prompt works in Safari and in PWA mode.
// - Notifications on iOS PWAs are supported on newer iOS versions, but behavior varies.
//   We request permission gracefully; if it’s not available, app still works.

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Local-only: change radius to taste (meters)
const RADIUS_DEFAULT = 2500;     // essentials/health
const RADIUS_BEACHES = 12000;    // beaches, party content
const RADIUS_BARS = 6000;
const RADIUS_CLUBS = 8000;

const state = {
  user: null,          // {lat, lon}
  view: "home",        // home | list | detail
  currentList: [],     // array of items
  currentType: null,   // which menu card
  selected: null,      // selected item
  filters: {
    expensiveToCheap: true,
    beachBarsOnly: false,
  },
  accessPoints: []
};

// ---------- UI helpers ----------
const el = (id) => document.getElementById(id);

function showHome(){
  el("listPanel").classList.add("hidden");
  el("detailPanel").classList.add("hidden");
  el("homeMenu").classList.remove("hidden");
  state.view = "home";
}

function showList(){
  el("homeMenu").classList.add("hidden");
  el("detailPanel").classList.add("hidden");
  el("listPanel").classList.remove("hidden");
  state.view = "list";
}

function showDetail(){
  el("homeMenu").classList.add("hidden");
  el("listPanel").classList.add("hidden");
  el("detailPanel").classList.remove("hidden");
  state.view = "detail";
}

function setSubtitle(text){
  el("subtitle").textContent = text;
}

function setLocationText(){
  if(!state.user){
    el("locText").textContent = "Location not set yet.";
    setSubtitle("Local-only guide");
    return;
  }
  el("locText").textContent = `📍 ${state.user.lat.toFixed(4)}, ${state.user.lon.toFixed(4)} (showing nearby only)`;
  setSubtitle("Showing places near your current area");
}

function metersToText(m){
  if (m >= 1000) return `${(m/1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

function haversineMeters(a, b){
  const R = 6371000;
  const toRad = (x) => x * Math.PI/180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(s)));
}

function appleMapsNavigateUrl(destLat, destLon, label="Destination"){
  const q = encodeURIComponent(label);
  return `https://maps.apple.com/?daddr=${destLat},${destLon}&dirflg=d&q=${q}`;
}

// ---------- Overpass ----------
async function overpass(query){
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {"Content-Type":"text/plain"},
    body: query
  });
  if(!res.ok){
    throw new Error(`Overpass error ${res.status}`);
  }
  return res.json();
}

function overpassAroundTags(lat, lon, radius, blocks){
  return `
    [out:json][timeout:25];
    (
      ${blocks}
    );
    out center;
  `.trim().replaceAll("LAT", lat).replaceAll("LON", lon).replaceAll("RADIUS", radius);
}

function normalizeElement(elm){
  const c = elm.type === "node"
    ? {lat: elm.lat, lon: elm.lon}
    : {lat: elm.center?.lat, lon: elm.center?.lon};

  const tags = elm.tags || {};
  return {
    id: `${elm.type}:${elm.id}`,
    name: tags.name || tags.brand || "Unnamed",
    lat: c.lat,
    lon: c.lon,
    tags
  };
}

// ---------- Load local JSON (accessibility) ----------
async function loadAccessPoints(){
  try{
    const res = await fetch("data/access_points_gr.json");
    if(!res.ok) return;
    state.accessPoints = await res.json();
  } catch {
    state.accessPoints = [];
  }
}

// ---------- Data fetchers (per menu card) ----------
async function fetchEssentials(){
  const {lat, lon} = state.user;
  const radius = RADIUS_DEFAULT;

  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=atm];
    node(around:RADIUS,LAT,LON)[shop=supermarket];
    node(around:RADIUS,LAT,LON)[shop=convenience];
    node(around:RADIUS,LAT,LON)[tourism=hotel];
    node(around:RADIUS,LAT,LON)[tourism=motel];
    node(around:RADIUS,LAT,LON)[amenity=car_rental];
  `;
  const q = overpassAroundTags(lat, lon, radius, blocks);
  const data = await overpass(q);
  const items = (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: classifyEssential(p.tags),
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);

  return items;
}

function classifyEssential(tags){
  if(tags.amenity === "atm") return {icon:"🏧", label:"ATM"};
  if(tags.shop === "supermarket" || tags.shop === "convenience") return {icon:"🛒", label:"Market"};
  if(tags.tourism === "hotel" || tags.tourism === "motel") return {icon:"🏨", label:"Hotel/Motel"};
  if(tags.amenity === "car_rental") return {icon:"🚗", label:"Car Rental"};
  return {icon:"📍", label:"Place"};
}

async function fetchHealth(){
  const {lat, lon} = state.user;
  const radius = RADIUS_DEFAULT;

  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=hospital];
    way(around:RADIUS,LAT,LON)[amenity=hospital];
    node(around:RADIUS,LAT,LON)[amenity=clinic];
    node(around:RADIUS,LAT,LON)[amenity=doctors];
    node(around:RADIUS,LAT,LON)[amenity=pharmacy];
  `;
  const q = overpassAroundTags(lat, lon, radius, blocks);
  const data = await overpass(q);
  const items = (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: classifyHealth(p.tags),
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);

  return items;
}

function classifyHealth(tags){
  if(tags.amenity === "hospital") return {icon:"🏥", label:"Hospital"};
  if(tags.amenity === "pharmacy") return {icon:"💊", label:"Pharmacy"};
  if(tags.amenity === "doctors" || tags.amenity === "clinic") return {icon:"🩺", label:"Doctor/Clinic"};
  return {icon:"📍", label:"Health"};
}

async function fetchBeachBars(){
  const {lat, lon} = state.user;
  const radius = RADIUS_BARS;

  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=bar];
    node(around:RADIUS,LAT,LON)[amenity=pub];
    node(around:RADIUS,LAT,LON)[amenity=nightclub];
    node(around:RADIUS,LAT,LON)[amenity=restaurant];
  `;
  const q = overpassAroundTags(lat, lon, radius, blocks);
  const data = await overpass(q);

  const items = (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: {icon:"🍸", label: (p.tags.amenity === "nightclub" ? "Nightclub" : "Bar/Spot")},
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);

  return items;
}

async function fetchClubs(){
  const {lat, lon} = state.user;
  const radius = RADIUS_CLUBS;

  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=nightclub];
    node(around:RADIUS,LAT,LON)[amenity=bar];
  `;
  const q = overpassAroundTags(lat, lon, radius, blocks);
  const data = await overpass(q);

  const items = (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: {icon:"🎧", label: (p.tags.amenity === "nightclub" ? "Nightclub" : "Bar")},
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);

  return items;
}

async function fetchPartyBeaches(){
  const {lat, lon} = state.user;

  // 1) Find beaches
  const blocksBeaches = `
    node(around:RADIUS,LAT,LON)[natural=beach];
    way(around:RADIUS,LAT,LON)[natural=beach];
    node(around:RADIUS,LAT,LON)[tourism=beach];
    way(around:RADIUS,LAT,LON)[tourism=beach];
  `;
  const qBeaches = overpassAroundTags(lat, lon, RADIUS_BEACHES, blocksBeaches);
  const beachesData = await overpass(qBeaches);
  const beaches = (beachesData.elements || []).map(normalizeElement)
    .filter(b => b.lat && b.lon)
    .map(b => ({
      ...b,
      distance: haversineMeters({lat,lon},{lat:b.lat, lon:b.lon}),
    }))
    .sort((a,b)=>a.distance-b.distance)
    .slice(0, 40);

  // 2) Find bars/clubs/restaurants
  const blocksBars = `
    node(around:RADIUS,LAT,LON)[amenity=bar];
    node(around:RADIUS,LAT,LON)[amenity=pub];
    node(around:RADIUS,LAT,LON)[amenity=nightclub];
    node(around:RADIUS,LAT,LON)[amenity=restaurant];
  `;
  const qBars = overpassAroundTags(lat, lon, RADIUS_BEACHES, blocksBars);
  const barsData = await overpass(qBars);
  const bars = (barsData.elements || []).map(normalizeElement).filter(x => x.lat && x.lon);

  // 3) Score by nearby party density
  const withScore = beaches.map(b => {
    let nearbyBars = 0;
    for (const bar of bars){
      const d = haversineMeters({lat:b.lat, lon:b.lon}, {lat:bar.lat, lon:bar.lon});
      if(d <= 700) nearbyBars++;
    }
    const hasBeachBar = nearbyBars > 0;

    // Estimated price tier from density
    let priceTier = 1;
    if(nearbyBars >= 1) priceTier = 2;
    if(nearbyBars >= 3) priceTier = 3;
    if(nearbyBars >= 6) priceTier = 4;
    if(nearbyBars >= 10) priceTier = 5;

    const partyScore = (hasBeachBar ? 40 : 0) + Math.min(nearbyBars, 12) * 6 + Math.max(0, (6000 - b.distance)/600);

    return {
      ...b,
      kind: {icon: hasBeachBar ? "🏖️🍹" : "🏖️", label: "Beach"},
      hasBeachBar,
      nearbyBars,
      priceTier,
      partyScore
    };
  });

  let list = withScore;
  if(state.filters.beachBarsOnly){
    list = list.filter(x => x.hasBeachBar);
  }

  list.sort((a,b)=>{
    if(state.filters.expensiveToCheap){
      if(a.priceTier !== b.priceTier) return b.priceTier - a.priceTier;
    } else {
      if(a.priceTier !== b.priceTier) return a.priceTier - b.priceTier;
    }
    if(a.partyScore !== b.partyScore) return b.partyScore - a.partyScore;
    return a.distance - b.distance;
  });

  return list.slice(0, 30);
}

function fetchAccess(){
  if(!state.user) return [];
  const {lat, lon} = state.user;
  return state.accessPoints
    .map(a => ({
      id: a.id,
      name: a.name || "Accessibility point",
      lat: a.lat,
      lon: a.lon,
      tags: { type: a.type, notes: a.notes || "" },
      kind: { icon:"♿️", label: a.type || "access" },
      distance: haversineMeters({lat,lon},{lat:a.lat, lon:a.lon})
    }))
    .filter(x => x.distance <= 8000)
    .sort((a,b)=>a.distance-b.distance);
}

// ---------- Rendering ----------
function renderFiltersFor(type){
  const filters = el("filters");
  filters.innerHTML = "";

  if(type === "partyBeaches"){
    const p1 = document.createElement("button");
    p1.className = "pill" + (state.filters.beachBarsOnly ? " active" : "");
    p1.textContent = "Beach bars only 🍹";
    p1.onclick = async () => {
      state.filters.beachBarsOnly = !state.filters.beachBarsOnly;
      await loadCurrentList();
    };

    const p2 = document.createElement("button");
    p2.className = "pill" + (state.filters.expensiveToCheap ? " active" : "");
    p2.textContent = state.filters.expensiveToCheap ? "€€€€€ → €" : "€ → €€€€€";
    p2.onclick = async () => {
      state.filters.expensiveToCheap = !state.filters.expensiveToCheap;
      await loadCurrentList();
    };

    filters.appendChild(p1);
    filters.appendChild(p2);
  }
}

function renderList(items){
  const list = el("list");
  list.innerHTML = "";

  if(!items.length){
    list.innerHTML = `<div class="p">No results found nearby. Try Refresh or move to another area.</div>`;
    return;
  }

  for(const item of items){
    const div = document.createElement("div");
    div.className = "item";

    const left = document.createElement("div");
    left.className = "item__left";

    const title = document.createElement("div");
    title.className = "item__title";

    const icon = item.kind?.icon || "📍";
    const price = item.priceTier ? ` ${"€".repeat(item.priceTier)}` : "";
    title.textContent = `${icon}${price} ${item.name}`;

    const meta = document.createElement("div");
    meta.className = "item__meta";
    meta.textContent = buildMeta(item);

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Open";
    btn.onclick = () => openDetails(item);

    left.appendChild(title);
    left.appendChild(meta);
    left.appendChild(btn);

    const right = document.createElement("div");
    right.className = "item__right";
    right.textContent = metersToText(item.distance || 0);

    div.appendChild(left);
    div.appendChild(right);
    list.appendChild(div);
  }
}

function buildMeta(item){
  const label = item.kind?.label ? `${item.kind.label}` : "Place";

  if(state.currentType === "partyBeaches"){
    const bars = (typeof item.nearbyBars === "number") ? ` • bars nearby: ${item.nearbyBars}` : "";
    const beachBar = item.hasBeachBar ? " • beach bar: yes" : " • beach bar: no";
    return `${label}${beachBar}${bars}`;
  }

  if(state.currentType === "access"){
    const notes = item.tags?.notes ? ` • ${item.tags.notes}` : "";
    return `${label}${notes}`;
  }

  return label;
}

// ---------- Details + Mini map ----------
let leafletMap = null;
let leafletMarker = null;
let leafletUser = null;

function openDetails(item){
  state.selected = item;
  showDetail();

  el("detailTitle").textContent = item.name;
  el("detailMeta").textContent = buildMeta(item);

  el("detailNote").textContent =
    (state.currentType === "partyBeaches")
      ? "This list is local-only. Prices are estimated from nearby party density. You can refine later with real price data."
      : "Local-only. Tap Navigate to open Apple Maps.";

  el("btnNavigate").onclick = () => {
    window.location.href = appleMapsNavigateUrl(item.lat, item.lon, item.name);
  };

  el("btnShowMap").onclick = () => {
    el("mapWrap").classList.toggle("hidden");
    if(!el("mapWrap").classList.contains("hidden")){
      initOrUpdateMiniMap(item);
    }
  };

  el("mapWrap").classList.add("hidden");
}

function initOrUpdateMiniMap(item){
  const mapDiv = el("map");

  if(!leafletMap){
    leafletMap = L.map(mapDiv, { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(leafletMap);
  }

  const target = [item.lat, item.lon];

  if(leafletMarker){
    leafletMarker.setLatLng(target);
    leafletMarker.setPopupContent(item.name);
  } else {
    leafletMarker = L.marker(target).addTo(leafletMap).bindPopup(item.name);
  }

  if(state.user){
    const me = [state.user.lat, state.user.lon];
    if(leafletUser){
      leafletUser.setLatLng(me);
    } else {
      leafletUser = L.circleMarker(me, {radius:6}).addTo(leafletMap).bindPopup("You");
    }
  }

  leafletMap.setView(target, 14);
}

// ---------- Load list for the selected card ----------
async function loadCurrentList(){
  if(!state.user){
    alert("Enable location first.");
    return;
  }

  const type = state.currentType;
  el("listTitle").textContent = titleForType(type);
  el("listHint").textContent = "Showing places near you only (local radius).";
  renderFiltersFor(type);

  el("list").innerHTML = `<div class="p">Loading…</div>`;

  try{
    let items = [];
    if(type === "essentials") items = await fetchEssentials();
    if(type === "health") items = await fetchHealth();
    if(type === "partyBeaches") items = await fetchPartyBeaches();
    if(type === "beachBars") items = await fetchBeachBars();
    if(type === "clubs") items = await fetchClubs();
    if(type === "access") items = fetchAccess();

    state.currentList = items;
    renderList(items);

    updateBadges();
  } catch(e){
    el("list").innerHTML = `<div class="p">Could not load data right now. Try again in a minute.</div>`;
    console.error(e);
  }
}

function titleForType(t){
  switch(t){
    case "partyBeaches": return "Party Beaches Near Me";
    case "beachBars": return "Beach Bars Near Me";
    case "clubs": return "Clubs Near Me";
    case "essentials": return "Essentials Near Me";
    case "health": return "Health & Safety Near Me";
    case "access": return "Accessibility Near Me";
    default: return "Near You";
  }
}

// ---------- Badges (counts on cards) ----------
async function updateBadges(){
  const set = (id, val) => { const x = el(id); if(x) x.textContent = val; };

  if(!state.user){
    set("badgePartyBeaches","—");
    set("badgeBeachBars","—");
    set("badgeClubs","—");
    set("badgeEssentials","—");
    set("badgeHealth","—");
    set("badgeAccess","—");
    return;
  }

  if(state.currentType === "partyBeaches") set("badgePartyBeaches", `${state.currentList.length}`);
  if(state.currentType === "beachBars") set("badgeBeachBars", `${state.currentList.length}`);
  if(state.currentType === "clubs") set("badgeClubs", `${state.currentList.length}`);
  if(state.currentType === "essentials") set("badgeEssentials", `${state.currentList.length}`);
  if(state.currentType === "health") set("badgeHealth", `${state.currentList.length}`);
  if(state.currentType === "access") set("badgeAccess", `${state.currentList.length}`);
}

// ---------- Permissions ----------
async function enableLocation(){
  if(!navigator.geolocation){
    alert("Geolocation not supported on this device.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.user = {lat: pos.coords.latitude, lon: pos.coords.longitude};
      setLocationText();
    },
    () => alert("Location permission denied.")
  );
}

async function enableNotifications(){
  if(!("Notification" in window)){
    alert("Notifications are not supported in this browser.");
    return;
  }
  const perm = await Notification.requestPermission();
  if(perm !== "granted"){
    alert("Notifications not enabled.");
    return;
  }
  new Notification("Tourist Greece", { body: "Alerts enabled. (Later: heat + safety reminders.)" });
}

// ---------- Navigation wiring ----------
function wireUI(){
  el("btnLocation").onclick = enableLocation;
  el("btnNotify").onclick = enableNotifications;

  el("btnBack").onclick = showHome;
  el("btnDetailBack").onclick = () => { showList(); };
  el("btnRefresh").onclick = loadCurrentList;

  document.querySelectorAll(".card").forEach(btn => {
    btn.addEventListener("click", async () => {
      const view = btn.getAttribute("data-view");
      state.currentType = view;
      showList();
      await loadCurrentList();
    });
  });
}

// ---------- Service Worker (optional, offline shell) ----------
async function registerSW(){
  if("serviceWorker" in navigator){
    try { await navigator.serviceWorker.register("sw.js"); } catch {}
  }
}

// ---------- Boot ----------
(async function main(){
  wireUI();
  await loadAccessPoints();
  setLocationText();
  await registerSW();
  await updateBadges();
})();
