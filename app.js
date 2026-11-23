(() => {
  'use strict';

  // ================= STORAGE KEYS =================
  const STORAGE_HUBS = 'vic_saved_hubs_v1';
  const STORAGE_AMENITIES = 'vic_saved_amenities_v1';
  const STORAGE_REGIONS = 'vic_saved_regions_v1';

  // ================= LOAD SAVED CUSTOM DATA =================
  function loadJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota errors
    }
  }

  let savedHubs = loadJson(STORAGE_HUBS);
  let savedAmenities = loadJson(STORAGE_AMENITIES);
  let savedRegions = loadJson(STORAGE_REGIONS);

  // Merge saved items into live arrays (newest custom hubs at top of PROPERTIES)
  if (savedRegions.length) {
    savedRegions.forEach((r) => {
      if (!VIC_REGIONS.some((x) => x.id === r.id)) VIC_REGIONS.push(r);
    });
  }
  if (savedAmenities.length) {
    savedAmenities.forEach((a) => {
      if (!AMENITIES.some((x) => x.id === a.id)) AMENITIES.push(a);
    });
  }
  if (savedHubs.length) {
    savedHubs.forEach((h) => {
      if (!PROPERTIES.some((x) => x.id === h.id)) PROPERTIES.unshift(h);
    });
  }

  // ================= MAP INITIALIZATION (INFINITELY SCROLLABLE) =================
  const map = L.map('map', {
    center: [-37.65, 144.85],
    zoom: 8,
    minZoom: 3,
    maxZoom: 19,
    worldCopyJump: true, // Infinitely scrollable horizontally without losing markers
    zoomControl: false
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);

  // ================= BASE LAYERS & OVERLAYS =================
  const baseLayers = {
    road: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }),
    satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
      }
    ),
    walk: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Map data: &copy; OpenStreetMap, SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
    })
  };

  // Walking & Hiking Tracks Overlay (Waymarked Trails)
  const walkingTrailsOverlay = L.tileLayer(
    'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
    {
      maxZoom: 18,
      opacity: 0.85,
      attribution: 'Trails &copy; <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>'
    }
  );

  // Satellite Hybrid Street & Place Labels Overlay
  const satLabelsOverlay = L.layerGroup([
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, opacity: 0.85 }
    ),
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, opacity: 0.9 }
    )
  ]);

  let currentMode = 'road';
  baseLayers.road.addTo(map);

  // ================= MARKER LAYER GROUPS =================
  const layerGroups = {
    properties: L.layerGroup().addTo(map),
    ndis: L.layerGroup().addTo(map),
    council: L.layerGroup().addTo(map),
    shops: L.layerGroup().addTo(map),
    transit: L.layerGroup().addTo(map),
    nature: L.layerGroup().addTo(map)
  };

  const ringsLayer = L.layerGroup().addTo(map);
  const customPinLayer = L.layerGroup().addTo(map);

  // ================= CATEGORY CONFIG =================
  const CAT_META = {
    ndis: { label: 'NDIS', fullLabel: 'NDIS Physio & OT', color: '#e11d48', icon: '🩺' },
    council: { label: 'Council', fullLabel: 'Council Service', color: '#7c3aed', icon: '🏛️' },
    shops: { label: 'Shops', fullLabel: 'Shops & Supermarket', color: '#d97706', icon: '🛒' },
    transit: { label: 'Public', fullLabel: 'Public Transport', color: '#0284c7', icon: '🚆' },
    nature: { label: 'Park', fullLabel: 'Park / Nat. Park / Beach', color: '#059669', icon: '🌿' }
  };

  // ================= STATE =================
  const state = {
    region: 'all',
    type: 'all',
    minBeds: 3,
    maxPrice: 900000,
    nature: 'all',
    selectedPropertyId: null
  };

  const propertyMarkers = new Map();

  // ================= HELPERS =================
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDist(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    return `${km.toFixed(1)} km`;
  }

  function slugify(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function getRegionName(regionId) {
    const r = VIC_REGIONS.find((x) => x.id === regionId);
    return r ? r.name : regionId;
  }

  function getNearestByCategory(lat, lng) {
    const nearest = {};
    for (const cat of Object.keys(CAT_META)) {
      let best = null;
      let bestDist = Infinity;
      for (const item of AMENITIES) {
        if (item.category !== cat) continue;
        const d = haversineKm(lat, lng, item.lat, item.lng);
        if (d < bestDist) {
          bestDist = d;
          best = { ...item, distKm: d };
        }
      }
      nearest[cat] = best;
    }
    return nearest;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setSearchStatus(msg, isError = false) {
    const el = document.getElementById('searchStatus');
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('error');
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }

  // ================= DRAW 1 KM & 3 KM WALKING RINGS =================
  function drawWalkingRings(lat, lng) {
    ringsLayer.clearLayers();
    L.circle([lat, lng], {
      radius: 1000,
      color: '#059669',
      weight: 2,
      fillColor: '#10b981',
      fillOpacity: 0.09,
      interactive: false
    }).addTo(ringsLayer);

    L.circle([lat, lng], {
      radius: 3000,
      color: '#2563eb',
      weight: 1.8,
      dashArray: '6 6',
      fillColor: '#3b82f6',
      fillOpacity: 0.04,
      interactive: false
    }).addTo(ringsLayer);

    L.marker([lat + 0.0091, lng], {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: '<span style="background:rgba(5,150,105,0.9);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap;">1 km walk</span>',
        iconSize: [60, 18],
        iconAnchor: [30, 9]
      })
    }).addTo(ringsLayer);

    L.marker([lat + 0.0272, lng], {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: '<span style="background:rgba(37,99,235,0.9);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap;">3 km walk</span>',
        iconSize: [60, 18],
        iconAnchor: [30, 9]
      })
    }).addTo(ringsLayer);

    document.getElementById('clearRingsBtn').hidden = false;
  }

  function clearRingsAndCustomPin() {
    ringsLayer.clearLayers();
    customPinLayer.clearLayers();
    state.selectedPropertyId = null;
    document.getElementById('clearRingsBtn').hidden = true;
    renderPropertyList();
    refreshPropertyMarkerStyles();
  }

  // ================= POPULATE AMENITY MARKERS =================
  function renderAmenities() {
    for (const cat of Object.keys(CAT_META)) {
      layerGroups[cat].clearLayers();
    }

    AMENITIES.forEach((item) => {
      const meta = CAT_META[item.category];
      if (!meta) return;
      const icon = L.divIcon({
        className: '',
        html: `<div class="custom-marker" style="width:28px;height:28px;background:${meta.color};font-size:13px;" title="${escapeHtml(item.name)}">${meta.icon}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      const marker = L.marker([item.lat, item.lng], { icon });
      const linkHtml = item.url
        ? `<div class="popup-actions"><a href="${item.url}" target="_blank" rel="noopener noreferrer">Provider / Info ↗</a></div>`
        : '';

      marker.bindPopup(`
        <div class="popup-box">
          <div class="popup-cat" style="color:${meta.color}">${meta.icon} ${meta.fullLabel}</div>
          <h3 class="popup-title">${escapeHtml(item.name)}</h3>
          <p class="popup-sub"><strong>${escapeHtml(item.suburb)}</strong><br/>${escapeHtml(item.details)}</p>
          ${linkHtml}
        </div>
      `);

      marker.addTo(layerGroups[item.category]);
    });
  }

  // ================= FILTER & RENDER PROPERTIES =================
  function getFilteredProperties() {
    return PROPERTIES.filter((p) => {
      if (state.region !== 'all' && p.region !== state.region) return false;
      if (state.type !== 'all' && !p.typesAvailable.includes(state.type)) return false;
      if (p.beds < state.minBeds) return false;
      if (p.priceMin > state.maxPrice) return false;
      if (state.nature !== 'all' && !p.natureType.includes(state.nature)) return false;
      return true;
    });
  }

  function createPropertyIcon(prop, isSelected) {
    const shortPrice = `$${Math.round(prop.priceMin / 1000)}k–$${Math.round(prop.priceMax / 1000)}k`;
    return L.divIcon({
      className: '',
      html: `<div class="prop-marker-pill ${isSelected ? 'selected' : ''}">🏡 ${shortPrice}</div>`,
      iconSize: [96, 26],
      iconAnchor: [48, 13]
    });
  }

  function refreshPropertyMarkerStyles() {
    propertyMarkers.forEach((marker, id) => {
      const prop = PROPERTIES.find((p) => p.id === id);
      if (prop) {
        marker.setIcon(createPropertyIcon(prop, id === state.selectedPropertyId));
        marker.setZIndexOffset(id === state.selectedPropertyId ? 1000 : 200);
      }
    });
  }

  function buildPropertyPopup(prop) {
    const nearest = getNearestByCategory(prop.lat, prop.lng);
    const regionLabel = getRegionName(prop.region);
    const distRows = Object.entries(nearest)
      .filter(([, v]) => v)
      .map(([cat, v]) => {
        const meta = CAT_META[cat];
        return `<div class="popup-dist-row">
          <span>${meta.icon} <strong>${meta.label}:</strong> ${escapeHtml(v.name.split('(')[0].trim())}</span>
          <span style="white-space:nowrap;font-weight:700;color:${meta.color}">${formatDist(v.distKm)}</span>
        </div>`;
      })
      .join('');

    return `
      <div class="popup-box">
        <div class="popup-region-tag">Victoria Region: ${escapeHtml(regionLabel)}</div>
        <div class="popup-cat" style="color:var(--c-prop)">🏡 ${escapeHtml(prop.priceLabel)} · ${prop.beds} Bed ${escapeHtml(prop.type)} ${prop.isCustom ? '· 💾 Saved' : ''}</div>
        <h3 class="popup-title">${escapeHtml(prop.title)}</h3>
        <p class="popup-sub">${escapeHtml(prop.suburb)} VIC ${escapeHtml(prop.postcode || '')} · ♿ ${escapeHtml(prop.accessibilityNotes)}</p>
        <div class="popup-distances">${distRows}</div>
        <div class="popup-actions">
          <a href="${prop.reaUrl}" target="_blank" rel="noopener noreferrer">realestate.com.au ↗</a>
          <a href="${prop.domainUrl}" target="_blank" rel="noopener noreferrer" class="secondary">Domain ↗</a>
        </div>
      </div>
    `;
  }

  function selectProperty(prop, shouldFly = true) {
    state.selectedPropertyId = prop.id;
    customPinLayer.clearLayers();
    drawWalkingRings(prop.lat, prop.lng);
    refreshPropertyMarkerStyles();
    renderPropertyList();

    if (shouldFly) {
      map.flyTo([prop.lat, prop.lng], 14, { duration: 0.9 });
    }

    const marker = propertyMarkers.get(prop.id);
    if (marker) {
      marker.openPopup();
    }

    const cardEl = document.querySelector(`.prop-card[data-id="${prop.id}"]`);
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function removeSavedHub(hubId) {
    const idx = PROPERTIES.findIndex((p) => p.id === hubId);
    if (idx === -1) return;
    const hub = PROPERTIES[idx];
    PROPERTIES.splice(idx, 1);

    savedHubs = savedHubs.filter((h) => h.id !== hubId);
    saveJson(STORAGE_HUBS, savedHubs);

    // Remove associated custom region
    const rIdx = VIC_REGIONS.findIndex((r) => r.id === hub.region && r.isCustom);
    if (rIdx !== -1) VIC_REGIONS.splice(rIdx, 1);
    savedRegions = savedRegions.filter((r) => r.id !== hub.region);
    saveJson(STORAGE_REGIONS, savedRegions);

    // Remove associated custom amenities
    for (let i = AMENITIES.length - 1; i >= 0; i--) {
      if (AMENITIES[i].hubId === hubId) AMENITIES.splice(i, 1);
    }
    savedAmenities = savedAmenities.filter((a) => a.hubId !== hubId);
    saveJson(STORAGE_AMENITIES, savedAmenities);

    if (state.region === hub.region) state.region = 'all';
    if (state.selectedPropertyId === hubId) clearRingsAndCustomPin();

    renderRegionControls();
    renderAmenities();
    renderProperties();
    setSearchStatus(`Removed ${hub.suburb} from saved hubs.`);
  }

  function renderProperties() {
    layerGroups.properties.clearLayers();
    propertyMarkers.clear();

    const filtered = getFilteredProperties();

    filtered.forEach((prop) => {
      const marker = L.marker([prop.lat, prop.lng], {
        icon: createPropertyIcon(prop, prop.id === state.selectedPropertyId),
        zIndexOffset: prop.id === state.selectedPropertyId ? 1000 : 200
      });

      marker.bindPopup(() => buildPropertyPopup(prop), { maxWidth: 340 });
      marker.on('click', () => {
        selectProperty(prop, false);
      });

      marker.addTo(layerGroups.properties);
      propertyMarkers.set(prop.id, marker);
    });

    renderPropertyList(filtered);
  }

  function renderPropertyList(filtered = getFilteredProperties()) {
    const listEl = document.getElementById('propertyList');
    const countEl = document.getElementById('resultsCount');

    countEl.textContent = `${filtered.length} Victoria ${filtered.length === 1 ? 'hub' : 'hubs'} matching filters`;

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div style="padding:24px 12px;text-align:center;color:var(--text-muted);font-size:0.86rem;">
          No hubs match all current filters.<br/>Try lowering minimum bedrooms or switching region to <strong>All Victoria</strong>.
        </div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map(
        (prop) => `
      <article class="prop-card ${prop.id === state.selectedPropertyId ? 'selected' : ''}" data-id="${prop.id}" role="listitem" tabindex="0">
        <div class="prop-card-top">
          <span class="prop-price">${escapeHtml(prop.priceLabel)}</span>
          <div style="display:flex;align-items:center;gap:4px;">
            ${prop.isCustom ? '<span class="saved-badge">💾 Saved</span>' : ''}
            <span class="prop-badge">${escapeHtml(prop.suburb)} ${escapeHtml(prop.postcode || '')}</span>
            ${prop.isCustom ? `<button type="button" class="remove-hub-btn" data-remove="${prop.id}" title="Remove saved hub" aria-label="Remove ${escapeHtml(prop.suburb)}">✕</button>` : ''}
          </div>
        </div>
        <h2 class="prop-title">${escapeHtml(prop.title)}</h2>
        <div class="prop-specs">
          <span class="spec-pill">🛏️ ${prop.beds}+ bed</span>
          <span class="spec-pill">🏠 ${escapeHtml(prop.typesAvailable.join(' / '))}</span>
          ${prop.accessible ? '<span class="spec-pill accessible">♿ Single-level options</span>' : ''}
        </div>
        <ul class="prop-highlights">
          <li><span>🩺</span><span><strong>NDIS:</strong> ${escapeHtml(prop.ndisHighlight)}</span></li>
          <li><span>🏛️</span><span><strong>Council:</strong> ${escapeHtml(prop.councilHighlight)}</span></li>
          <li><span>🛒</span><span><strong>Shops:</strong> ${escapeHtml(prop.shopsHighlight)}</span></li>
          <li><span>🚆</span><span><strong>Public:</strong> ${escapeHtml(prop.transitHighlight)}</span></li>
          <li><span>🌿</span><span><strong>Park:</strong> ${escapeHtml(prop.natureHighlight)}</span></li>
        </ul>
        <div class="prop-links">
          <a class="prop-link primary" href="${prop.reaUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Live realestate.com.au ↗</a>
          <a class="prop-link" href="${prop.domainUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Domain ↗</a>
        </div>
      </article>`
      )
      .join('');

    listEl.querySelectorAll('.prop-card').forEach((card) => {
      const id = card.dataset.id;
      const prop = PROPERTIES.find((p) => p.id === id);
      if (!prop) return;
      card.addEventListener('click', () => selectProperty(prop, true));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectProperty(prop, true);
        }
      });
    });

    listEl.querySelectorAll('.remove-hub-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSavedHub(btn.dataset.remove);
      });
    });
  }

  // ================= CLICK ANYWHERE TO INSPECT 1-3 KM WALK RADIUS =================
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    customPinLayer.clearLayers();
    state.selectedPropertyId = null;
    refreshPropertyMarkerStyles();
    renderPropertyList();
    drawWalkingRings(lat, lng);

    const nearest = getNearestByCategory(lat, lng);
    const distRows = Object.entries(nearest)
      .filter(([, v]) => v)
      .map(([cat, v]) => {
        const meta = CAT_META[cat];
        return `<div class="popup-dist-row">
          <span>${meta.icon} <strong>${meta.label}:</strong> ${escapeHtml(v.name.split('(')[0].trim())}</span>
          <span style="white-space:nowrap;font-weight:700;color:${meta.color}">${formatDist(v.distKm)}</span>
        </div>`;
      })
      .join('');

    const pin = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="custom-marker" style="width:28px;height:28px;background:#0f172a;border-color:#facc15;font-size:14px;">📍</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      })
    }).addTo(customPinLayer);

    const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`;
    const ndisUrl = 'https://www.ndis.gov.au/participants/working-providers/find-registered-provider';

    pin
      .bindPopup(
        `<div class="popup-box">
          <div class="popup-cat" style="color:var(--accent)">📍 Custom Walkability Check</div>
          <h3 class="popup-title">1 km &amp; 3 km Walking Rings</h3>
          <p class="popup-sub">Coords: ${lat.toFixed(4)}, ${lng.toFixed(4)}<br/>Nearest plotted Victoria hubs:</p>
          <div class="popup-distances">${distRows}</div>
          <div class="popup-actions">
            <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>
            <a href="${ndisUrl}" target="_blank" rel="noopener noreferrer" class="secondary">NDIS Finder ↗</a>
          </div>
        </div>`,
        { maxWidth: 330 }
      )
      .openPopup();
  });

  // ================= MAP MODE SWITCHER (ROAD / SATELLITE / WALK & TRACKS) =================
  const trailsToggle = document.getElementById('trailsOverlayToggle');
  const satLabelsToggle = document.getElementById('satLabelsToggle');
  const satLabelsWrap = document.getElementById('satLabelsWrap');

  function setMapMode(mode) {
    if (mode === currentMode) return;
    map.removeLayer(baseLayers[currentMode]);
    currentMode = mode;
    baseLayers[mode].addTo(map);

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    if (mode === 'satellite') {
      satLabelsWrap.hidden = false;
      if (satLabelsToggle.checked && !map.hasLayer(satLabelsOverlay)) {
        satLabelsOverlay.addTo(map);
      }
    } else {
      satLabelsWrap.hidden = true;
      if (map.hasLayer(satLabelsOverlay)) {
        map.removeLayer(satLabelsOverlay);
      }
    }

    if (mode === 'walk') {
      trailsToggle.checked = true;
      if (!map.hasLayer(walkingTrailsOverlay)) {
        walkingTrailsOverlay.addTo(map);
      }
    }
  }

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMapMode(btn.dataset.mode));
  });

  trailsToggle.addEventListener('change', () => {
    if (trailsToggle.checked) {
      walkingTrailsOverlay.addTo(map);
    } else {
      map.removeLayer(walkingTrailsOverlay);
    }
  });

  satLabelsToggle.addEventListener('change', () => {
    if (satLabelsToggle.checked && currentMode === 'satellite') {
      satLabelsOverlay.addTo(map);
    } else {
      map.removeLayer(satLabelsOverlay);
    }
  });

  // ================= LAYER TOGGLES =================
  document.querySelectorAll('.layer-toggle input[data-layer]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const layer = layerGroups[cb.dataset.layer];
      if (!layer) return;
      if (cb.checked) {
        layer.addTo(map);
      } else {
        map.removeLayer(layer);
      }
    });
  });

  // ================= REGION SELECT & QUICK-JUMP BAR =================
  const regionSelect = document.getElementById('regionSelect');
  const regionBar = document.getElementById('regionBar');

  function renderRegionControls() {
    regionSelect.innerHTML = '';
    regionBar.innerHTML = '';

    VIC_REGIONS.forEach((reg) => {
      const opt = document.createElement('option');
      opt.value = reg.id;
      opt.textContent = reg.isCustom ? `⭐ ${reg.name}` : reg.name;
      regionSelect.appendChild(opt);

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `region-pill ${reg.id === state.region ? 'active' : ''}`;
      pill.dataset.region = reg.id;
      pill.textContent = reg.isCustom ? `⭐ ${reg.name}` : reg.name;
      pill.addEventListener('click', () => selectRegion(reg.id));
      regionBar.appendChild(pill);
    });

    regionSelect.value = state.region;
  }

  function selectRegion(regionId) {
    state.region = regionId;
    regionSelect.value = regionId;
    regionBar.querySelectorAll('.region-pill').forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.region === regionId);
    });

    const reg = VIC_REGIONS.find((r) => r.id === regionId);
    if (reg) {
      map.flyTo(reg.center, reg.zoom, { duration: 0.85 });
    }
    renderProperties();
  }

  regionSelect.addEventListener('change', () => selectRegion(regionSelect.value));

  // ================= OTHER FILTER CONTROLS =================
  document.getElementById('typeSelect').addEventListener('change', (e) => {
    state.type = e.target.value;
    renderProperties();
  });

  document.getElementById('bedsSelect').addEventListener('change', (e) => {
    state.minBeds = Number(e.target.value);
    renderProperties();
  });

  document.getElementById('priceMaxSelect').addEventListener('change', (e) => {
    state.maxPrice = Number(e.target.value);
    renderProperties();
  });

  document.querySelectorAll('.chip[data-nature]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-nature]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.nature = chip.dataset.nature;
      renderProperties();
    });
  });

  document.getElementById('clearRingsBtn').addEventListener('click', clearRingsAndCustomPin);

  // ================= LIVE VICTORIA SUBURB GEOCODE + OVERPASS AMENITIES =================
  function stringSimilarity(a, b) {
    const s1 = a.toLowerCase().trim();
    const s2 = b.toLowerCase().trim();
    if (!s1 || !s2) return 0;
    if (s1 === s2 || s2.includes(s1) || s1.includes(s2)) return 1;
    const len1 = s1.length;
    const len2 = s2.length;
    const dp = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
    for (let i = 0; i <= len1; i++) dp[i][0] = i;
    for (let j = 0; j <= len2; j++) dp[0][j] = j;
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return 1 - dp[len1][len2] / Math.max(len1, len2);
  }

  async function geocodeVictoriaSuburb(query) {
    const cleanQ = query.replace(/,?\s*(vic|victoria|australia)\b/gi, '').trim();
    const isPostcode = /^\d{4}$/.test(cleanQ);

    // 1. Try OpenStreetMap Nominatim (Victoria viewbox bounded)
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=au&viewbox=140.96,-33.98,150.0,-39.20&bounded=1&limit=5&q=${encodeURIComponent(
        cleanQ + ', Victoria, Australia'
      )}`;
      const res = await fetch(nomUrl, { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (data && data.length > 0) {
        const hit =
          data.find((d) => {
            const addr = d.address || {};
            const candidate = addr.suburb || addr.town || addr.city || addr.village || d.display_name.split(',')[0];
            return isPostcode || stringSimilarity(cleanQ, candidate) >= 0.55;
          }) || null;

        if (hit) {
          const addr = hit.address || {};
          const name =
            addr.suburb ||
            addr.town ||
            addr.city ||
            addr.village ||
            addr.municipality ||
            hit.display_name.split(',')[0].trim();
          return {
            name,
            postcode: addr.postcode || (isPostcode ? cleanQ : ''),
            lat: parseFloat(hit.lat),
            lng: parseFloat(hit.lon)
          };
        }
      }
    } catch {
      // fall through to Photon
    }

    // 2. Fallback to Photon with Victoria bbox + place tag (handles typos like "Sandiringham" -> "Sandringham"!)
    const photonQueries = [
      `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQ)}&bbox=140.96,-39.20,150.0,-33.98&osm_tag=place&limit=8`,
      `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQ)}&bbox=140.96,-39.20,150.0,-33.98&limit=8`
    ];

    for (const photonUrl of photonQueries) {
      try {
        const res = await fetch(photonUrl, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        const features = (data && data.features) || [];
        let bestFeature = null;
        let bestScore = 0;

        for (const f of features) {
          const p = f.properties || {};
          const candidate = p.name || p.locality || p.district || p.city || '';
          const score = isPostcode && p.postcode === cleanQ ? 1 : stringSimilarity(cleanQ, candidate);
          if (score > bestScore) {
            bestScore = score;
            bestFeature = f;
          }
        }

        if (bestFeature && bestScore >= 0.55) {
          const p = bestFeature.properties || {};
          const [lng, lat] = bestFeature.geometry.coordinates;
          return {
            name: p.name || p.locality || p.city || cleanQ,
            postcode: p.postcode || (isPostcode ? cleanQ : ''),
            lat,
            lng
          };
        }
      } catch {
        // try next
      }
    }

    return null;
  }

  async function fetchWithTimeout(url, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchNearbyOverpassAmenities(lat, lng, suburbName, hubId) {
    // Fast, reliable parallel local POI search via Photon (bounded within ~3.5km of suburb)
    const dLat = 0.032; // ~3.5 km
    const dLng = 0.04;  // ~3.5 km
    const bbox = `${(lng - dLng).toFixed(4)},${(lat - dLat).toFixed(4)},${(lng + dLng).toFixed(4)},${(lat + dLat).toFixed(4)}`;

    async function searchLocalPoi(queries, acceptFn) {
      for (const q of queries) {
        try {
          const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lng}&bbox=${bbox}&limit=10`;
          const res = await fetchWithTimeout(url, 3500);
          if (!res.ok) continue;
          const data = await res.json();
          const features = (data && data.features) || [];
          let best = null;
          let bestDist = Infinity;
          for (const f of features) {
            const p = f.properties || {};
            if (!p.name) continue;
            // Skip plain streets/roads/houses when looking for POIs
            if (p.osm_key === 'highway' || p.osm_key === 'place' || p.osm_value === 'house') continue;
            if (acceptFn && !acceptFn(p)) continue;
            const [fLng, fLat] = f.geometry.coordinates;
            const dist = haversineKm(lat, lng, fLat, fLng);
            if (dist <= 4.5 && dist < bestDist) {
              bestDist = dist;
              best = { name: p.name, lat: fLat, lng: fLng, distKm: dist, osmValue: p.osm_value || '' };
            }
          }
          if (best) return best;
        } catch {
          // timeout or network error: try next query
        }
      }
      return null;
    }

    const isNdisPoi = (p) => {
      const n = p.name.toLowerCase();
      if (/\b(vet|veterinary|animal|pet|dentist|dental|orthodont|beauty|nail|salon|spa|barber)\b/.test(n)) return false;
      if (p.osm_value === 'veterinary' || p.osm_value === 'dentist') return false;
      return (
        p.osm_key === 'healthcare' ||
        ['clinic', 'hospital', 'doctors', 'rehabilitation', 'physiotherapist'].includes(p.osm_value) ||
        /\b(physio|physiotherapy|occupational|allied|rehab|medical|hospital|health)\b/.test(n)
      );
    };

    const isCouncilPoi = (p) => {
      const n = p.name.toLowerCase();
      if (/\b(street library|little library|book box|free library|cafe|bar|hotel|motel|pub)\b/.test(n)) return false;
      return (
        ['library', 'townhall', 'community_centre', 'sports_centre', 'swimming_pool'].includes(p.osm_value) ||
        /\b(library|civic|council|aquatic|leisure|community centre|community hub)\b/.test(n)
      );
    };

    const isShopsPoi = (p) => {
      const n = p.name.toLowerCase();
      if (/\b(car park|parking|liquor|bottle|petrol|fuel|express)\b/.test(n)) return false;
      return (
        p.osm_key === 'shop' ||
        ['supermarket', 'mall', 'department_store', 'marketplace'].includes(p.osm_value) ||
        /\b(coles|woolworths|aldi|iga|supermarket|plaza|shopping centre)\b/.test(n)
      );
    };

    const isTransitPoi = (p) => {
      const n = p.name.toLowerCase();
      if (/\b(hotel|cafe|bar|pub|clinic|dental|medical|pharmacy|newsagency|car park|parking)\b/.test(n)) return false;
      return (
        p.osm_key === 'railway' ||
        p.osm_key === 'public_transport' ||
        ['station', 'halt', 'tram_stop', 'bus_station', 'ferry_terminal'].includes(p.osm_value)
      );
    };

    const isNaturePoi = (p) => {
      const n = p.name.toLowerCase();
      if (/\b(dentist|dental|medical|clinic|vet|hotel|motel|cafe|restaurant|bakery|shop|store|pharmacy|car park|parking|school|kindergarten|childcare|estate|apartments|real estate)\b/.test(n)) {
        return false;
      }
      return (
        (p.osm_key === 'leisure' && ['park', 'nature_reserve', 'garden', 'recreation_ground', 'common'].includes(p.osm_value)) ||
        (p.osm_key === 'natural' && ['beach', 'coastline', 'wood', 'wetland', 'water'].includes(p.osm_value)) ||
        (p.osm_key === 'boundary' && ['national_park', 'protected_area'].includes(p.osm_value))
      );
    };

    const [ndisHit, councilHit, shopsHit, transitHit, beachHit, parkHit] = await Promise.all([
      searchLocalPoi([`${suburbName} physiotherapy`, 'physiotherapy', 'occupational therapy', `${suburbName} medical`], isNdisPoi),
      searchLocalPoi([`${suburbName} library`, 'library', `${suburbName} aquatic`, 'community centre'], isCouncilPoi),
      searchLocalPoi([`coles ${suburbName}`, `woolworths ${suburbName}`, 'supermarket', 'aldi'], isShopsPoi),
      searchLocalPoi([`${suburbName} station`, 'train station', 'railway station', 'bus station'], isTransitPoi),
      searchLocalPoi([`${suburbName} beach`, 'beach', 'national park', 'nature reserve'], isNaturePoi),
      searchLocalPoi([`${suburbName} park`, `${suburbName} reserve`, 'park', 'gardens'], isNaturePoi)
    ]);

    const found = { ndis: null, council: null, shops: null, transit: null, nature: null };
    const natureTags = new Set();

    if (ndisHit) {
      found.ndis = {
        id: `${hubId}-ndis`,
        hubId,
        category: 'ndis',
        name: `${ndisHit.name} (NDIS / Allied Health)`,
        suburb: suburbName,
        lat: ndisHit.lat,
        lng: ndisHit.lng,
        distKm: ndisHit.distKm,
        details: `Local Physio / OT / Medical near ${suburbName} · Verify NDIS registration via Provider Finder`,
        url: 'https://www.ndis.gov.au/participants/working-providers/find-registered-provider'
      };
    }

    if (councilHit) {
      found.council = {
        id: `${hubId}-council`,
        hubId,
        category: 'council',
        name: councilHit.name,
        suburb: suburbName,
        lat: councilHit.lat,
        lng: councilHit.lng,
        distKm: councilHit.distKm,
        details: `Local Council / Library / Community facility in ${suburbName}`
      };
    }

    if (shopsHit) {
      found.shops = {
        id: `${hubId}-shops`,
        hubId,
        category: 'shops',
        name: shopsHit.name,
        suburb: suburbName,
        lat: shopsHit.lat,
        lng: shopsHit.lng,
        distKm: shopsHit.distKm,
        details: `Local Supermarket / Shopping near ${suburbName}`
      };
    }

    if (transitHit) {
      found.transit = {
        id: `${hubId}-transit`,
        hubId,
        category: 'transit',
        name: transitHit.name,
        suburb: suburbName,
        lat: transitHit.lat,
        lng: transitHit.lng,
        distKm: transitHit.distKm,
        details: `Local Public Transport serving ${suburbName}`
      };
    }

    const naturePick = beachHit && beachHit.distKm <= 3.0 ? beachHit : parkHit || beachHit;
    if (naturePick) {
      if (beachHit && /beach/i.test(beachHit.name)) natureTags.add('Beach');
      if (beachHit && /national|reserve/i.test(beachHit.name)) natureTags.add('National Park');
      natureTags.add('Park');
      found.nature = {
        id: `${hubId}-nature`,
        hubId,
        category: 'nature',
        name: naturePick.name,
        suburb: suburbName,
        lat: naturePick.lat,
        lng: naturePick.lng,
        distKm: naturePick.distKm,
        details: `Local Beach / Park / Reserve near ${suburbName}`
      };
    }

    return { found, natureTags: Array.from(natureTags) };
  }

  // ================= ADDRESS / SUBURB SEARCH & AUTO-ADD + SAVE =================
  const addressForm = document.getElementById('addressSearchForm');
  const addressInput = document.getElementById('addressInput');
  const searchGoBtn = document.getElementById('searchGoBtn');

  addressForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = addressInput.value.trim();
    if (!query) return;

    // 1. Check if it already matches an existing/saved hub
    const localMatch = PROPERTIES.find(
      (p) =>
        p.suburb.toLowerCase() === query.toLowerCase() ||
        p.suburb.toLowerCase().includes(query.toLowerCase()) ||
        p.title.toLowerCase().includes(query.toLowerCase()) ||
        (p.postcode && p.postcode === query)
    );

    if (localMatch) {
      if (state.region !== 'all' && state.region !== localMatch.region) {
        state.region = 'all';
        renderRegionControls();
        renderProperties();
      }
      setSearchStatus(`Jumped to ${localMatch.suburb} (${getRegionName(localMatch.region)})`);
      selectProperty(localMatch, true);
      return;
    }

    // 2. Geocode new Victoria suburb & fetch real local NDIS, Council, Shops, Public, Park!
    searchGoBtn.disabled = true;
    setSearchStatus(`🔍 Finding "${query}" in Victoria & scanning NDIS, Council, Shops, Transit & Parks...`);

    try {
      const geo = await geocodeVictoriaSuburb(query);
      if (!geo) {
        setSearchStatus(`Couldn't find "${query}" in Victoria. Try a suburb name like "Sandringham" or postcode.`, true);
        searchGoBtn.disabled = false;
        return;
      }

      // Check again by canonical geocoded suburb name (handles typos like "Sandiringham" -> "Sandringham"!)
      const existingByName = PROPERTIES.find(
        (p) => p.suburb.toLowerCase() === geo.name.toLowerCase()
      );
      if (existingByName) {
        if (state.region !== 'all' && state.region !== existingByName.region) {
          state.region = 'all';
          renderRegionControls();
          renderProperties();
        }
        setSearchStatus(`Matched "${geo.name}" — already in your Victoria hubs!`);
        selectProperty(existingByName, true);
        searchGoBtn.disabled = false;
        return;
      }

      const slug = slugify(geo.name);
      const hubId = `prop-custom-${slug}`;
      const regionId = `region-custom-${slug}`;

      // Fetch real nearby amenities from Overpass
      const { found, natureTags } = await fetchNearbyOverpassAmenities(geo.lat, geo.lng, geo.name, hubId);

      // Add discovered amenities to AMENITIES & save them
      const newAmenities = [];
      for (const cat of Object.keys(CAT_META)) {
        if (found[cat]) {
          AMENITIES.push(found[cat]);
          newAmenities.push(found[cat]);
        }
      }

      // Compute nearest for any category Overpass didn't return
      const nearest = getNearestByCategory(geo.lat, geo.lng);

      const describe = (cat, fallbackLabel) => {
        const item = found[cat] || nearest[cat];
        if (!item) return fallbackLabel;
        const d = item.distKm ?? haversineKm(geo.lat, geo.lng, item.lat, item.lng);
        return `${item.name.split('(')[0].trim()} (${formatDist(d)})`;
      };

      const pc = geo.postcode || '';
      const reaSlug = encodeURIComponent(geo.name.toLowerCase()).replace(/%20/g, '+');
      const domSlug = slugify(geo.name);

      const newRegion = {
        id: regionId,
        name: geo.name,
        center: [geo.lat, geo.lng],
        zoom: 14,
        isCustom: true
      };

      const newHub = {
        id: hubId,
        title: `${geo.name} Hub`,
        suburb: geo.name,
        postcode: pc,
        region: regionId,
        lat: geo.lat,
        lng: geo.lng,
        priceMin: 700000,
        priceMax: 900000,
        priceLabel: '$700k – $900k',
        type: 'Townhouse',
        typesAvailable: ['House', 'Townhouse', 'Unit'],
        beds: 3,
        baths: 2,
        cars: 1,
        accessible: true,
        accessibilityNotes: 'Check live listings for single-level villas, ground-floor townhouses & step-free access.',
        natureType: natureTags.length ? natureTags : ['Park'],
        ndisHighlight: describe('ndis', 'NDIS Physio & OT mobile/clinic nearby'),
        councilHighlight: describe('council', 'Local Council Library & Community Services'),
        shopsHighlight: describe('shops', 'Local Supermarket & Shopping Village'),
        transitHighlight: describe('transit', 'Local Public Transport Hub'),
        natureHighlight: describe('nature', 'Local Park / Reserve within 1–3 km'),
        reaUrl: `https://www.realestate.com.au/buy/property-house-townhouse-villa-with-2-bedrooms-between-700000-900000-in-${reaSlug},+vic${pc ? '+' + pc : ''}/list-1`,
        domainUrl: `https://www.domain.com.au/sale/${domSlug}-vic${pc ? '-' + pc : ''}/?ptype=house,town-house,villa&bedrooms=2-any&price=700000-900000`,
        isCustom: true
      };

      // Save to live state & localStorage
      VIC_REGIONS.push(newRegion);
      PROPERTIES.unshift(newHub);

      savedRegions.push(newRegion);
      savedHubs.unshift(newHub);
      savedAmenities.push(...newAmenities);

      saveJson(STORAGE_REGIONS, savedRegions);
      saveJson(STORAGE_HUBS, savedHubs);
      saveJson(STORAGE_AMENITIES, savedAmenities);

      // Show all Victoria hubs so count increments (e.g. 21 -> 22) and Sandringham is highlighted at top
      state.region = 'all';
      renderRegionControls();
      renderAmenities();
      renderProperties();
      selectProperty(newHub, true);

      setSearchStatus(`✅ Added & saved "${geo.name}" to Victoria Regions & Hubs (${getFilteredProperties().length} matching)!`);
    } catch {
      setSearchStatus('Search unavailable right now. You can still click anywhere on the map to check 1–3 km walking rings.', true);
    } finally {
      searchGoBtn.disabled = false;
    }
  });

  // ================= SIDEBAR COLLAPSE & THEME TOGGLE =================
  const sidebar = document.getElementById('sidebar');
  document.getElementById('collapseSidebarBtn').addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    setTimeout(() => map.invalidateSize(), 260);
  });

  document.getElementById('openSidebarBtn').addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
    setTimeout(() => map.invalidateSize(), 260);
  });

  const themeToggle = document.getElementById('themeToggle');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (prefersDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  themeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  });

  // ================= INITIAL RENDER =================
  renderRegionControls();
  renderAmenities();
  renderProperties();
})();
