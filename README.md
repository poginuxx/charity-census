# Charity Census

Solo-use PWA for tracking charity patients managed by residents — paste a
NeuroReferral message from Viber, review the parsed fields, commit to the
census. Spec: [CHARITY_CENSUS_PARSER_SPEC.md](CHARITY_CENSUS_PARSER_SPEC.md).

## Running locally

PWAs must be served over HTTP (a double-clicked `index.html` won't register
the service worker or offer install). From this folder:

```sh
python3 -m http.server 8321
```

then open <http://localhost:8321>.

## Tests

Parser regression tests (Phase 3+) run with Node's built-in test runner, no
packages needed:

```sh
node --test
```

## Layout

- `index.html`, `css/`, `js/app.js` — app shell and UI glue
- `lib/` — parser, de-identify, identity resolution, trends, diff/tray logic
  (pure JS, shared between browser and tests)
- `sw.js`, `manifest.webmanifest`, `icons/` — PWA installability
