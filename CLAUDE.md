# Whiff (formerly RL Stats Lab)

A local app that records Rocket League matches, practice and replays through the game's Stats API and shows trends over time. Read `docs/DEVELOPMENT.md` first: it covers the architecture, commands and the API rules learned from real recordings. `README.md` is for end users (install, settings, use): keep it in step when a feature changes what they see.

## How to help: build it

Joe is a senior frontend engineer. Since 2026-11-04 he wants the app to move forward more than he wants practice on it, so Claude builds features across the whole app, the web screens included (`MatchPage`, `TrendsPage` and `PracticePage` too), the same way it builds the plumbing: make the change, run the tests, check the screen and explain it briefly.

- **Keep explanations short and useful.** Mention a pattern or API worth knowing when it comes up, without turning the work into a lesson.
- **Reviews of his code stay direct** when he asks for one: real problems (accessibility, layout on a phone, query keys, needless re-renders, test gaps) in order of importance, no praise.
- **The iOS app is his.** He plans to build it himself in React Native later. There, coach instead: explain the approach, point to patterns, review and give hints before answers, unless he says "just write it".

## Conventions

- **TypeScript everywhere.** npm workspaces; packages are imported as `@rl/schema`, `@rl/domain`, `@rl/metrics` and `@rl/api-contract`, with relative imports ending in `.ts`/`.tsx`.
- **Web data goes through the hooks in `apps/web/src/lib/api.tsx`,** never `fetch` in a component. Query keys live in `keys` there. Mutations go through the typed client in `packages/api-contract/src/client.ts` and invalidate the matching keys.
- **Filters live in the URL.** Each route's search schema is defined with Zod in `router.tsx`; pages read it with `getRouteApi(...).useSearch()` and change it with `<Link search>`. TanStack Router sets `aria-current="page"` on active links itself.
- **Explanations:** hover text (`title`) only for a few words or a short sentence; anything longer goes behind a "?" (`components/HelpTip.tsx`, a popover that works on touch). Never both on the same text.
- **Styling** uses CSS modules plus the tokens in `styles.css`. The layout must work in phone portrait: under 860 px, tables become two-line cards by changing `grid-template-areas` on the same markup, and grids use `auto-fit`.
- **Tests:** Vitest. Web tests render the real router at a URL with a fake API client; `SessionsPage.test.tsx` is the model. Collector tests check behavior against the anonymized recordings in `fixtures/`.
- **Field geometry:** x is −4096..4096 and y is −5120..5120. Detail endpoints rotate positions so my team attacks toward +y, and **+x is the attacker's left**, so a top-down map draws screen-x = −x.
- **Metrics stay pure and tested** in `packages/metrics`. Every rule about the game's data has a test built on a real recording; a new rule gets one too.

## Commands

`npm test`, `npm run typecheck`, `npm run desktop` (the tray app from source), `npm run desktop:dist` (the installer), `npm run dev` (collector + Vite on :5173), `npm run collect`, `npm run build`, `npm run ingest -- <path> [--force]` and `npm run mock -- <recording>`. Run `npm test` and `npm run typecheck` before calling something done.

On Windows, if PowerShell blocks `npm`, use `npm.cmd` or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Data and privacy

- Real Epic `PrimaryId`s and other players' names stay out of the repo. They belong in `whiff.config.json`, which is git-ignored. New fixtures replace Joe's ID with `Epic|me|0` and a known teammate's with `Epic|teammate|0`.
- The live data folder (`dataDir` in the config) holds the SQLite database and the raw logs. The raw NDJSON logs are the source of truth and the database can always be rebuilt from them. Don't delete either without asking.
- Stop the collector before `ingest --force`, because both write to the same database.

## Working together

Another Claude session also pushes to `main`, mostly plumbing. Run `git pull` before starting, keep commits focused and don't rewrite pushed history.

Don't bump the version in `apps/desktop/package.json`: Joe bumps it himself when he builds or releases (`npm run release -- patch`). Don't start GitHub builds unless he asks.
