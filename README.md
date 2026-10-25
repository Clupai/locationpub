# Where Am I

A small static website that shows your location live on a map, with photos and facts about the place you're in.

## Features

- **Live location tracking**: follows you as you move (browser Geolocation `watchPosition`), with an accuracy circle.
- **About this place**: street address, the town or city's Wikipedia description and photo, and the current weather.
- **Nearby places with pictures**: up to 15 Wikipedia-listed landmarks within 10 km, shown on the map and in a list with thumbnails and distances.
- **Explore anywhere**: click any point on the map to see the same info for that spot, then press **Recenter** to go back to yourself.
- No API keys and no build step. It uses OpenStreetMap/Nominatim, Wikipedia and Open-Meteo.

## Run it

Browsers only share location with pages served over **HTTPS** or from **localhost**.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

To publish it, enable **GitHub Pages** for this repository (Settings → Pages → deploy from branch, root folder). Pages serves over HTTPS, so location works there too.

## Files

- `index.html`: page layout
- `style.css`: styling (light and dark mode, mobile friendly)
- `app.js`: map, location tracking and data lookups

## Notes

- Place info is re-fetched only after you move more than 300 m, to stay within Nominatim's usage policy.
- Your location is only sent to the public APIs above to look up the place. Nothing is stored.
