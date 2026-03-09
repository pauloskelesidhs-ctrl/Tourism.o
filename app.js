const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const RADIUS_DEFAULT = 2500;
const RADIUS_BEACHES = 12000;
const RADIUS_BARS = 6000;
const RADIUS_CLUBS = 8000;
const RADIUS_COFFEE = 4000;

const state = {
  user: null,
  view: "home",
  currentList: [],
  currentType: null,
  selected: null,
  filters: {
    // universal
    priceMin: 1,
    priceMax: 5,
    // party only
    vibe: "any", // any | chill | sunset | dayparty | afterparty
    beachBarsOnly: false,
    expensiveToCheap: true
  },
  accessPoints: []
};

const el = (id) => document.getElementById(id);

// ---------- helpers ----------
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
function setSubtitle(text){ el("subtitle").textContent = text; }

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

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function euros(t){ return "€".repeat(clamp(t,1,5)); }

// ---------- Overpass ----------
async function overpass(query){
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {"Content-Type":"text/plain"},
    body: query
  });
  if(!res.ok) throw new Error(`Overpass error ${res.status}`);
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

// ---------- Local JSON (accessibility) ----------
async function loadAccessPoints(){
  try{
    const res = await fetch("data/access_points_gr.json");
    if(!res.ok) return;
    state.accessPoints = await res.json();
  } catch {
    state.accessPoints = [];
  }
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
      priceTier: 1,
      distance: haversineMeters({lat,lon},{lat:a.lat, lon:a.lon})
    }))
    .filter(x => x.distance <= 8000)
    .sort((a,b)=>a.distance-b.distance);
}

// ---------- Price tier heuristics (ALL sectors) ----------
// NOTE: OSM does not contain real “prices” consistently.
// We estimate tiers so your price bar works everywhere.
// Later you can add user-reported prices (like we do for party beaches).
function priceTierFromTags(tags){
  const amenity = tags.amenity;
  const shop = tags.shop;
  const tourism = tags.tourism;

  // Hotels: luxury-ish if stars present
  if(tourism === "hotel" || tourism === "motel"){
    const stars = Number(tags.stars || 0);
    if(stars >= 5) return 5;
    if(stars === 4) return 4;
    if(stars === 3) return 3;
    return 2;
  }

  // ATMs: no price concept; keep neutral
  if(amenity === "atm") return 2;

  // Markets: convenience tends to be pricier than supermarket
  if(shop === "supermarket") return 2;
  if(shop === "convenience") return 3;

  // Health: not a “price” thing; keep low/neutral
  if(amenity === "hospital") return 1;
  if(amenity === "pharmacy") return 2;
  if(amenity === "clinic" || amenity === "doctors") return 2;

  // Coffee/food/nightlife heuristic
  if(amenity === "cafe") return 2;
  if(amenity === "fast_food") return 1;
  if(amenity === "restaurant") return 3;
  if(amenity === "bar" || amenity === "pub") return 3;
  if(amenity === "nightclub") return 4;

  return 2;
}

function passesPrice(item){
  return item.priceTier >= state.filters.priceMin && item.priceTier <= state.filters.priceMax;
}

// ---------- Sectors ----------
async function fetchEssentials(){
  const {lat, lon} = state.user;
  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=atm];
    node(around:RADIUS,LAT,LON)[shop=supermarket];
    node(around:RADIUS,LAT,LON)[shop=convenience];
    node(around:RADIUS,LAT,LON)[tourism=hotel];
    node(around:RADIUS,LAT,LON)[tourism=motel];
    node(around:RADIUS,LAT,LON)[amenity=car_rental];
  `;
  const data = await overpass(overpassAroundTags(lat, lon, RADIUS_DEFAULT, blocks));
  return (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: classifyEssential(p.tags),
    priceTier: priceTierFromTags(p.tags),
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);
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
  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=hospital];
    way(around:RADIUS,LAT,LON)[amenity=hospital];
    node(around:RADIUS,LAT,LON)[amenity=clinic];
    node(around:RADIUS,LAT,LON)[amenity=doctors];
    node(around:RADIUS,LAT,LON)[amenity=pharmacy];
  `;
  const data = await overpass(overpassAroundTags(lat, lon, RADIUS_DEFAULT, blocks));
  return (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: classifyHealth(p.tags),
    priceTier: priceTierFromTags(p.tags),
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);
}
function classifyHealth(tags){
  if(tags.amenity === "hospital") return {icon:"🏥", label:"Hospital"};
  if(tags.amenity === "pharmacy") return {icon:"💊", label:"Pharmacy"};
  if(tags.amenity === "doctors" || tags.amenity === "clinic") return {icon:"🩺", label:"Doctor/Clinic"};
  return {icon:"📍", label:"Health"};
}

async function fetchCoffee(){
  const {lat, lon} = state.user;
  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=cafe];
    node(around:RADIUS,LAT,LON)[amenity=coffee_shop];
    node(around:RADIUS,LAT,LON)[shop=coffee];
  `;
  const data = await overpass(overpassAroundTags(lat, lon, RADIUS_COFFEE, blocks));
  return (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: {icon:"☕", label:"Coffee"},
    priceTier: priceTierFromTags(p.tags),
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);
}

async function fetchBeachBars(){
  const {lat, lon} = state.user;
  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=bar];
    node(around:RADIUS,LAT,LON)[amenity=pub];
    node(around:RADIUS,LAT,LON)[amenity=restaurant];
    node(around:RADIUS,LAT,LON)[amenity=nightclub];
  `;
  const data = await overpass(overpassAroundTags(lat, lon, RADIUS_BARS, blocks));
  return (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: {icon:"🍸", label: (p.tags.amenity === "nightclub" ? "Nightclub" : "Bar/Spot")},
    priceTier: priceTierFromTags(p.tags),
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);
}

async function fetchClubs(){
  const {lat, lon} = state.user;
  const blocks = `
    node(around:RADIUS,LAT,LON)[amenity=nightclub];
    node(around:RADIUS,LAT,LON)[amenity=bar];
  `;
  const data = await overpass(overpassAroundTags(lat, lon, RADIUS_CLUBS, blocks));
  return (data.elements || []).map(normalizeElement).map(p => ({
    ...p,
    kind: {icon:"🎧", label: (p.tags.amenity === "nightclub" ? "Nightclub" : "Bar")},
    priceTier: priceTierFromTags(p.tags),
    distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
  })).sort((a,b)=>a.distance-b.distance);
}

// ---------- Party beaches: vibe + peak hours + price truth ----------
function inferVibe(nearbyBars, distanceFromUser){
  // Simple v1 logic:
  if(nearbyBars >= 10) return "afterparty";
  if(nearbyBars >= 6) return "dayparty";
  if(nearbyBars >= 3) return "sunset";
  // closer & fewer bars => chill
  if(distanceFromUser < 2500) return "chill";
  return "any";
}
function peakHoursForVibe(vibe){
  if(vibe === "chill") return "10:00–14:00";
  if(vibe === "sunset") return "17:30–21:00";
  if(vibe === "dayparty") return "15:00–20:00";
  if(vibe === "afterparty") return "23:30–05:00";
  return "16:00–22:00";
}

function loadTruth(placeId){
  try{
    const raw = localStorage.getItem(`truth:${placeId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveTruth(placeId, data){
  localStorage.setItem(`truth:${placeId}`, JSON.stringify(data));
}

async function fetchPartyBeaches(){
  const {lat, lon} = state.user;

  // beaches
  const blocksBeaches = `
    node(around:RADIUS,LAT,LON)[natural=beach];
    way(around:RADIUS,LAT,LON)[natural=beach];
    node(around:RADIUS,LAT,LON)[tourism=beach];
    way(around:RADIUS,LAT,LON)[tourism=beach];
  `;
  const beachesData = await overpass(overpassAroundTags(lat, lon, RADIUS_BEACHES, blocksBeaches));
  const beaches = (beachesData.elements || []).map(normalizeElement)
    .filter(b => b.lat && b.lon)
    .map(b => ({ ...b, distance: haversineMeters({lat,lon},{lat:b.lat, lon:b.lon}) }))
    .sort((a,b)=>a.distance-b.distance)
    .slice(0, 45);

  // bars/clubs/restaurants near area
  const blocksBars = `
    node(around:RADIUS,LAT,LON)[amenity=bar];
    node(around:RADIUS,LAT,LON)[amenity=pub];
    node(around:RADIUS,LAT,LON)[amenity=nightclub];
    node(around:RADIUS,LAT,LON)[amenity=restaurant];
  `;
  const barsData = await overpass(overpassAroundTags(lat, lon, RADIUS_BEACHES, blocksBars));
  const bars = (barsData.elements || []).map(normalizeElement).filter(x => x.lat && x.lon);

  const withMeta = beaches.map(b => {
    let nearbyBars = 0;
    for (const bar of bars){
      const d = haversineMeters({lat:b.lat, lon:b.lon}, {lat:bar.lat, lon:bar.lon});
      if(d <= 700) nearbyBars++;
    }
    const hasBeachBar = nearbyBars > 0;

    // price tier from party density
    let priceTier = 1;
    if(nearbyBars >= 1) priceTier = 2;
    if(nearbyBars >= 3) priceTier = 3;
    if(nearbyBars >= 6) priceTier = 4;
    if(nearbyBars >= 10) priceTier = 5;

    const vibe = inferVibe(nearbyBars, b.distance);
    const peak = peakHoursForVibe(vibe);

    const partyScore = (hasBeachBar ? 40 : 0) + Math.min(nearbyBars, 12) * 6 + Math.max(0, (6000 - b.distance)/600);

    return {
      ...b,
      kind: {icon: hasBeachBar ? "🏖️🍹" : "🏖️", label: "Beach"},
      hasBeachBar,
      nearbyBars,
      priceTier,
      vibe,
      peakHours: peak,
      partyScore
    };
  });

  let list = withMeta;

  if(state.filters.beachBarsOnly){
    list = list.filter(x => x.hasBeachBar);
  }
  if(state.filters.vibe !== "any"){
    list = list.filter(x => x.vibe === state.filters.vibe);
  }

  // price bar applies too
  list = list.filter(passesPrice);

  // sort
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

// ---------- On-duty + Emergency ----------
function openOnDutySearch(){
  if(!state.user){
    alert("Enable location first.");
    return;
  }
  // This opens a Google search for the user's area. (Works everywhere.)
  // Later: integrate an official source per region.
  const q = encodeURIComponent("εφημερεύοντα φαρμακεία κοντά μου");
  window.open(`https://www.google.com/search?q=${q}`, "_blank");
}

async function emergencyMode(){
  if(!state.user){
    alert("Enable location first.");
    return [];
  }
  const {lat, lon} = state.user;
  const blocks = `
    node(around:6000,LAT,LON)[amenity=hospital];
    way(around:6000,LAT,LON)[amenity=hospital];
    node(around:4000,LAT,LON)[amenity=pharmacy];
  `;
  const data = await overpass(overpassAroundTags(lat, lon, 6000, blocks));
  const items = (data.elements || []).map(normalizeElement).map(p => {
    const kind = classifyHealth(p.tags);
    return {
      ...p,
      kind,
      priceTier: priceTierFromTags(p.tags),
      distance: haversineMeters({lat,lon}, {lat:p.lat, lon:p.lon})
    };
  }).sort((a,b)=>a.distance-b.distance);

  return items.slice(0, 12);
}

// ---------- UI: filters ----------
function renderFiltersFor(type){
  const filters = el("filters");
  filters.innerHTML = "";

  // universal price bar
  const priceBar = document.createElement("div");
  priceBar.style.display = "flex";
  priceBar.style.gap = "8px";
  priceBar.style.flexWrap = "wrap";

  const label = document.createElement("div");
  label.className = "pill active";
  label.textContent = `Price: ${euros(state.filters.priceMin)} to ${euros(state.filters.priceMax)}`;

  const minBtn = document.createElement("button");
  minBtn.className = "pill";
  minBtn.textContent = "Min € +";
  minBtn.onclick = async () => {
    state.filters.priceMin = clamp(state.filters.priceMin + 1, 1, state.filters.priceMax);
    await loadCurrentList();
  };

  const minBtnDown = document.createElement("button");
  minBtnDown.className = "pill";
  minBtnDown.textContent = "Min € −";
  minBtnDown.onclick = async () => {
    state.filters.priceMin = clamp(state.filters.priceMin - 1, 1, state.filters.priceMax);
    await loadCurrentList();
  };

  const maxBtn = document.createElement("button");
  maxBtn.className = "pill";
  maxBtn.textContent = "Max € +";
  maxBtn.onclick = async () => {
    state.filters.priceMax = clamp(state.filters.priceMax + 1, state.filters.priceMin, 5);
    await loadCurrentList();
  };

  const maxBtnDown = document.createElement("button");
  maxBtnDown.className = "pill";
  maxBtnDown.textContent = "Max € −";
  maxBtnDown.onclick = async () => {
    state.filters.priceMax = clamp(state.filters.priceMax - 1, state.filters.priceMin, 5);
    await loadCurrentList();
  };

  priceBar.appendChild(label);
  priceBar.appendChild(minBtnDown);
  priceBar.appendChild(minBtn);
  priceBar.appendChild(maxBtnDown);
  priceBar.appendChild(maxBtn);
  filters.appendChild(priceBar);

  // party-only filters
  if(type === "partyBeaches"){
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.flexWrap = "wrap";
    row.style.marginTop = "10px";

    const beachBarsOnly = document.createElement("button");
    beachBarsOnly.className = "pill" + (state.filters.beachBarsOnly ? " active" : "");
    beachBarsOnly.textContent = "Beach bars only 🍹";
    beachBarsOnly.onclick = async () => {
      state.filters.beachBarsOnly = !state.filters.beachBarsOnly;
      await loadCurrentList();
    };

    const sort = document.createElement("button");
    sort.className = "pill active";
    sort.textContent = state.filters.expensiveToCheap ? "€€€€€ → €" : "€ → €€€€€";
    sort.onclick = async () => {
      state.filters.expensiveToCheap = !state.filters.expensiveToCheap;
      await loadCurrentList();
    };

    const vibes = ["any","chill","sunset","dayparty","afterparty"];
    vibes.forEach(v => {
      const b = document.createElement("button");
      b.className = "pill" + (state.filters.vibe === v ? " active" : "");
      b.textContent = v === "any" ? "Vibe: Any" : `Vibe: ${v}`;
      b.onclick = async () => {
        state.filters.vibe = v;
        await loadCurrentList();
      };
      row.appendChild(b);
    });

    filters.appendChild(beachBarsOnly);
    filters.appendChild(sort);
    filters.appendChild(row);
  }
}

// ---------- Rendering ----------
function buildMeta(item){
  const label = item.kind?.label ? `${item.kind.label}` : "Place";
  const price = item.priceTier ? ` • ${euros(item.priceTier)}` : "";

  if(state.currentType === "partyBeaches"){
    const bars = (typeof item.nearbyBars === "number") ? ` • bars: ${item.nearbyBars}` : "";
    const beachBar = item.hasBeachBar ? " • beach bar: yes" : " • beach bar: no";
    const vibe = item.vibe ? ` • vibe: ${item.vibe}` : "";
    const peak = item.peakHours ? ` • peak: ${item.peakHours}` : "";
    return `${label}${price}${beachBar}${bars}${vibe}${peak}`;
  }

  if(state.currentType === "access"){
    const notes = item.tags?.notes ? ` • ${item.tags.notes}` : "";
    return `${label}${notes}`;
  }

  return `${label}${price}`;
}

function renderList(items){
  const list = el("list");
  list.innerHTML = "";

  const filtered = items.filter(passesPrice);

  if(!filtered.length){
    list.innerHTML = `<div class="p">No results in this price range. Adjust the price bar.</div>`;
    return;
  }

  for(const item of filtered){
    const div = document.createElement("div");
    div.className = "item";

    const left = document.createElement("div");
    left.className = "item__left";

    const title = document.createElement("div");
    title.className = "item__title";
    title.textContent = `${item.kind?.icon || "📍"} ${euros(item.priceTier)} ${item.name}`;

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

// ---------- Details + Mini map ----------
let leafletMap = null;
let leafletMarker = null;
let leafletUser = null;

function openDetails(item){
  state.selected = item;
  showDetail();

  el("detailTitle").textContent = `${item.kind?.icon || "📍"} ${item.name}`;
  el("detailMeta").textContent = buildMeta(item);

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

  // Price truth panel only for party beaches
  const truthPanel = el("priceTruthPanel");
  const truthSaved = el("truthSaved");
  truthSaved.textContent = "";

  if(state.currentType === "partyBeaches"){
    truthPanel.classList.remove("hidden");

    const saved = loadTruth(item.id);
    el("sunbedsInput").value = saved?.sunbeds || "";
    el("minSpendInput").value = saved?.minSpend || "";

    el("btnSaveTruth").onclick = () => {
      const sunbeds = el("sunbedsInput").value.trim();
      const minSpend = el("minSpendInput").value.trim();
      saveTruth(item.id, {sunbeds, minSpend, ts: Date.now()});
      truthSaved.textContent = "Saved ✅";
    };

    // show estimated guidance
    const estSunbeds = item.priceTier >= 4 ? "€60–€150" : item.priceTier === 3 ? "€30–€80" : "€0–€30";
    const estMinSpend = item.priceTier >= 4 ? "Often required" : item.priceTier === 3 ? "Sometimes" : "No";
    el("detailNote").textContent = `Estimated today: sunbeds ${estSunbeds} • min spend: ${estMinSpend}. Peak: ${item.peakHours}.`;
  } else {
    truthPanel.classList.add("hidden");
    el("detailNote").textContent = "Local-only. Use the price bar to narrow results.";
  }
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

// ---------- Load list ----------
async function loadCurrentList(){
  if(!state.user){
    alert("Enable location first.");
    return;
  }

  const type = state.currentType;

  // special actions
  if(type === "onduty"){
    openOnDutySearch();
    return;
  }
  if(type === "emergency"){
    showList();
    el("listTitle").textContent = "Emergency Mode";
    el("listHint").textContent = "Nearest hospital + pharmacy. Tap Open, then Navigate.";
    el("filters").innerHTML = "";
    el("list").innerHTML = `<div class="p">Loading…</div>`;
    try{
      const items = await emergencyMode();
      // Add a “Call 112” item at the top (works on phones)
      items.unshift({
        id:"call112",
        name:"Call 112 (Emergency)",
        lat: state.user.lat,
        lon: state.user.lon,
        tags:{},
        kind:{icon:"🚨", label:"Emergency"},
        priceTier: 1,
        distance: 0,
        _call112: true
      });

      // override Open for 112
      state.currentList = items;
      renderFiltersFor("emergency");
      renderList(items);

      // patch button behavior for 112 after render
      // (simple: clicking Open on that item will open details; details navigate uses Apple maps; so we add tel link inside note)
    } catch {
      el("list").innerHTML = `<div class="p">Could not load emergency results. Try again.</div>`;
    }
    updateBadges();
    return;
  }

  showList();
  el("listTitle").textContent = titleForType(type);
  el("listHint").textContent = "Use the price bar + filters to narrow results.";
  renderFiltersFor(type);
  el("list").innerHTML = `<div class="p">Loading…</div>`;

  try{
    let items = [];
    if(type === "essentials") items = await fetchEssentials();
    if(type === "health") items = await fetchHealth();
    if(type === "partyBeaches") items = await fetchPartyBeaches();
    if(type === "beachBars") items = await fetchBeachBars();
    if(type === "clubs") items = await fetchClubs();
    if(type === "coffee") items = await fetchCoffee();
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
    case "coffee": return "Coffee Near Me";
    case "essentials": return "Essentials Near Me";
    case "health": return "Health & Safety Near Me";
    case "access": return "Accessibility Near Me";
    case "onduty": return "On-duty pharmacy";
    case "emergency": return "Emergency mode";
    default: return "Near You";
  }
}

// ---------- Badges ----------
function setBadge(id,val){ const x = el(id); if(x) x.textContent = val; }

async function updateBadges(){
  if(!state.user){
    ["badgePartyBeaches","badgeBeachBars","badgeClubs","badgeCoffee","badgeEssentials","badgeHealth","badgeOnDuty","badgeEmergency","badgeAccess"]
      .forEach(id => setBadge(id,"—"));
    return;
  }
  // We update badge only for current view to avoid spamming Overpass.
  if(state.currentType === "partyBeaches") setBadge("badgePartyBeaches", `${state.currentList.length}`);
  if(state.currentType === "beachBars") setBadge("badgeBeachBars", `${state.currentList.length}`);
  if(state.currentType === "clubs") setBadge("badgeClubs", `${state.currentList.length}`);
  if(state.currentType === "coffee") setBadge("badgeCoffee", `${state.currentList.length}`);
  if(state.currentType === "essentials") setBadge("badgeEssentials", `${state.currentList.length}`);
  if(state.currentType === "health") setBadge("badgeHealth", `${state.currentList.length}`);
  if(state.currentType === "access") setBadge("badgeAccess", `${state.currentList.length}`);
  if(state.currentType === "onduty") setBadge("badgeOnDuty", `↗`);
  if(state.currentType === "emergency") setBadge("badgeEmergency", `${Math.max(0, state.currentList.length-1)}`);
}

// ---------- Location + Notifications ----------
async function enableLocation(){
  if(!navigator.geolocation){
    alert("Geolocation not supported on this device.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.user = {lat: pos.coords.latitude, lon: pos.coords.longitude};
      el("locText").textContent = `📍 ${state.user.lat.toFixed(4)}, ${state.user.lon.toFixed(4)} (local-only)`;
      setSubtitle("Showing places near your current area");
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
  new Notification("tourism.o", { body: "Alerts enabled. (Later: heat + safety reminders.)" });
}

// ---------- Quick Search -> open sector ----------
function normalizeQuery(q){
  return (q || "").toLowerCase().trim();
}
function sectorFromQuery(q){
  // map user words to sector
  if(!q) return null;

  const match = (arr) => arr.some(w => q.includes(w));
  if(match(["party","beach","beaches"])) return "partyBeaches";
  if(match(["bar","beach bar","cocktail"])) return "beachBars";
  if(match(["club","night","nightclub"])) return "clubs";
  if(match(["coffee","cafe","café","espresso"])) return "coffee";
  if(match(["atm","cash"])) return "essentials";
  if(match(["market","supermarket","mini market","groceries","hotel","rent","car"])) return "essentials";
  if(match(["hospital","doctor","clinic","pharmacy","φαρμακ"])) return "health";
  if(match(["on duty","onduty","εφημερεύ"])) return "onduty";
  if(match(["emergency","112","help"])) return "emergency";
  if(match(["ramp","wheelchair","access"])) return "access";
  return null;
}

function wireQuickSearch(){
  const input = el("quickSearch");
  const help = el("searchHelp");
  const go = async () => {
    const q = normalizeQuery(input.value);
    const sec = sectorFromQuery(q);
    if(!sec){
      help.textContent = "Try: coffee, pharmacy, hospital, atm, club, beach, on duty, emergency.";
      return;
    }
    help.textContent = "";
    state.currentType = sec;
    await loadCurrentList();
  };
  el("btnGo").onclick = go;
  input.addEventListener("keydown", (e) => {
    if(e.key === "Enter") go();
  });
}

// ---------- Wire UI ----------
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
      await loadCurrentList();
    });
  });

  wireQuickSearch();
}

// ---------- Service Worker ----------
async function registerSW(){
  if("serviceWorker" in navigator){
    try { await navigator.serviceWorker.register("sw.js"); } catch {}
  }
}

// ---------- Boot ----------
(async function main(){
  wireUI();
  await loadAccessPoints();
  el("locText").textContent = "Location not set yet.";
  setSubtitle("Local-only guide");
  await registerSW();
  await updateBadges();
})();
