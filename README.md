# Ruta Acum

Pagină web personală, pentru telefon: cea mai rapidă rută **acum**, prin București,
plecând de la poziția GPS. Compară tramvaiul, transportul public cu metrou, trotineta
(estimare), trotineta până la metrou și mersul pe jos, ordonate după ora de sosire.
Uz personal, necomercial.

## Surse de date
| Sursă | Folosită pentru |
|---|---|
| [Transitous](https://transitous.org/) ([surse](https://transitous.org/sources/)) — API MOTIS 2 | rutare multimodală |
| GTFS-Realtime TPBI (`gtfs.tpbi.ro/api/gtfs-rt/*`) | sosiri live, poziții vehicule, alerte STB |
| OSRM ([routing.openstreetmap.de](https://routing.openstreetmap.de/)) | rute pe jos / trotinetă |
| Nominatim | geocodarea locurilor salvate |
| OpenStreetMap | hartă |

Metroul nu are date live în feed-ul TPBI și apare „după orar”. Lime nu publică un
feed GBFS pentru București, așa că trotineta e o estimare: distanța pe străzi / viteză
(implicit 15 km/h) + timp de găsit/deblocat (implicit 6 min), ambele configurabile.

Aplicația respectă [politica de utilizare Transitous](https://transitous.org/api/):
cod public, User-Agent cu link spre repo, ruta se recalculează cel mult o dată la 3 minute.
Reîmprospătarea la 30 s citește doar feed-urile STB, prin Worker.

## Confidențialitate
Locurile salvate (Acasă, Grădiniță, Birou) stau doar în `localStorage` pe telefon.
Nu există adrese în cod. Testele folosesc repere publice; testul cu locuri reale citește
`local/places.json`, care e în `.gitignore`.

## Acces și limite
Toate rutele `/api/*` (în afară de `/api/health`) cer antetul `x-key` cu cheia de acces.
Cheia e un secret al Worker-ului, nu stă în cod: `npx wrangler secret put ACCESS_KEY`
(local: `ACCESS_KEY=...` în `.dev.vars`, ignorat de git). Pagina o ține în `localStorage`
și o pui o singură dată, din ⚙ Setări.
Calculul de rută are o limită de 30 pe oră (variabila `PLAN_PER_HOUR`), ca să nu
consume limita Transitous.

Tronsoanele „cu copilul” (implicit Acasă ↔ Grădiniță) nu primesc variante cu trotinetă,
pentru că Lime e pentru un singur adult. Se schimbă din Setări.

## Structură
- `src/worker.js` — Cloudflare Worker: `/api/plan`, `/api/trips`, `/api/vehicles`, `/api/alerts`, `/api/geocode`
- `src/pb.js` — decodor protobuf GTFS-RT minimal, filtrat (CPU sub limita planului gratuit)
- `src/routes.json` — tabel linii generat din GTFS (`npm run routes`)
- `public/` — pagina (HTML/CSS/JS + Leaflet)
- `scripts/` — test end-to-end și măsurători CPU

## Rulare locală
```sh
npm install
npm run dev          # http://127.0.0.1:8787
npm run e2e          # test în terminal, cu repere publice
npm run bench        # timp CPU pentru decodarea GTFS-RT
```

## Licență
MIT
