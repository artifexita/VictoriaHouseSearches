# 🏡 Victoria Property & NDIS / Walkability Map ($700k–$900k)

An interactive, infinitely scrollable map for exploring **$700,000 – $900,000** houses, townhouses, and single-level units across **Victoria, Australia** with proximity to:

- 🩺 **NDIS-registered Physiotherapists & Occupational Therapists**
- 🏛️ **Council Services** (libraries, civic hubs, aquatic/leisure centres)
- 🛒 **Shops & Supermarkets** (Coles, Woolworths, ALDI, shopping villages)
- 🚆 **Public Transport** (Metro & V/Line stations, bus hubs)
- 🌿 **Parks, National Parks & Beaches** (within 1–3 km walking distance)

## Features
- **Infinitely Scrollable Map** across all of Victoria (and beyond) with quick-jump region pills.
- **Switchable Map Views**:
  - **🗺️ Road** (OpenStreetMap)
  - **🛰️ Satellite** (Esri World Imagery + optional Street/Place Labels)
  - **🥾 Walk / Tracks** (OpenTopoMap + Waymarked Trails hiking & walking tracks overlay)
- **1 km & 3 km Walking Rings**: Click any hub card, marker, or anywhere on the map to inspect walking radius rings and nearest service distances.
- **Search, Add & Save Any Victoria Suburb**: Type any Victoria suburb (with typo tolerance) and click **Go** to look up local amenities, add it to the **Victoria Region** dropdown and hubs list, and save it in `localStorage`.
- **Direct Live Listings**: Pre-filtered links to `realestate.com.au` and `Domain` (`$700k–$900k`) for every hub.

## Running Locally
Open `index.html` directly, or serve locally:
```bash
python3 -m http.server 8789
```
Then visit `http://localhost:8789/`.
