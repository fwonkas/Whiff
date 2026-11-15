# Whiff: development notes

How Whiff (formerly RL Stats Lab) is built, how to run it from source, and what the game's [Stats API](https://www.rocketleague.com/developer/stats-api) actually does. For installing and using the app, see the [README](../README.md).

Status: **build step 3 of 6** (history dashboard). The plumbing and the Sessions screen are done; Match detail, Trends and Practice are being built.

## How it works

```
Rocket League ──ws:49124──▶ collector ──▶ raw NDJSON log (source of truth)
                              │       └─▶ SQLite (rebuildable projection)
                              └── :49200 ── /api/*   read API (+ pack tags, notes)
                                         ├─ /live    live feed, replay commands
                                         └─ /        the built web app
```

| Package | What it is |
| --- | --- |
| `packages/schema` | Zod schemas for every game message and command, written against real recordings. |
| `packages/domain` | Session types (matches, practice, replays) shared by everything below. |
| `packages/metrics` | Pure, tested metrics: touch share, contested touches, possession runs, thirds, series with rolling averages, splits, practice summaries. |
| `packages/api-contract` | API query schemas, response types and a small typed client. The server validates with it; the web app builds requests with it. |
| `apps/collector` | The only client of the game's socket. Sessionizes the stream, writes the raw log and database, and serves the API, live feed and web app. |
| `apps/web` | React, Vite, TanStack Router (filters as typed URL search params) and TanStack Query. |
| `tools/mock-game` | Replays any recording as if it were the game, at any speed. |
| `fixtures/` | Anonymized recordings from real sessions, used by the tests; `*.subtr.json.gz` are anonymized subtr-actor extracts of real replays. |

### Replay analysis (subtr-actor)

Saved replays are parsed with [subtr-actor](https://github.com/rlrml/subtr-actor) (boxcars underneath), from its npm WASM build `@rlrml/subtr-actor`, pinned to an exact version because it changes quickly. Everything it returns is read in `apps/collector/src/subtr/extract.ts` and nowhere else.

- **Ingest.** The collector works through saved replays in the background, newest first, one at a time in a worker thread (about 5 s each), and not while a match, practice or replay is being played. Each replay's result goes in the `replay_analysis` table by match GUID, once per analyzer (`subtr-actor <version> / rules <n>`): a new library version or a change to the rules (`REPLAY_RULES_VERSION`) redoes them all. A replay it can't parse is recorded and not retried until then.
- **What's kept.** From subtr-actor's stats timeline the extract keeps the players, a few event streams (rotation and depth roles, shadow defense, boost pickups, 50/50s, beaten-to-ball, whiffs, demos, touches, goals/shots/saves, goal context), the boost tracks and each frame's time and clock. `analyzeReplay` in `packages/metrics` turns that into per-player positioning (share as last back and as first man), boost (average, time empty and full, pads, wasted boost), challenges (50/50s, races to the ball, whiffs) and demos, plus moments to review.
- **Units and frames.** subtr-actor reports boost on the network's 0–255 scale; the metrics use the HUD's 0–100. Its frames are the replay's own frame numbers, the same as the header's goal frames, so a moment's frame works with `POST /api/replay/goto`. Player IDs are converted to Stats API PrimaryIds (`PlayStation` → `PS4|…|0`, `Xbox` → `XboxOne|…|0`) so they match live recordings.
- **On screen.** A match's page shows the numbers for every player and my moments to review (whiffs, races lost, 50/50s lost, demos taken, goals conceded while last back), each with a Watch button that jumps the game there 5 s before.
- **Fixtures.** `npm run replay-fixture -- <file.replay> <name>` writes `fixtures/<name>.subtr.json.gz`: the extract with my ID as `Epic|me|0` (from the settings file, or `--me`), known teammates as `Epic|teammate|0` and everyone else as `anonNNNN` / `Player-NNN`. Real replays stay out of the repo; set `RL_REPLAY=<file>` to run the end-to-end worker test against one.
- **Still to come:** the embedded 3D replay viewer (`@rlrml/player`), AI coaching from the metrics and moments, and later a "similar situation" search. subtr-actor can also read and write custom training packs (`.tem`), which could turn a replay moment into a drill.

## Running from source (Windows)

1. Install Node.js 22.13 or newer (`node --version`). The database uses Node's built-in SQLite, so nothing needs compiling.
2. Enable the Stats API: in `<Rocket League install>\TAGame\Config\TAStatsAPI.ini` (or `DefaultStatsAPI.ini`), under `[TAGame.MatchStatsExporter_TA]`, set `PacketSendRate=30`. Restart the game after any change.
3. Install, test and build:
   ```
   npm install
   npm test
   npm run build
   ```
4. Create `whiff.config.json` in the repo root (it's git-ignored; a `rl-stats-lab.config.json` from before the rename still works):
   ```json
   {
     "myPrimaryIds": ["Epic|<your id>|0"],
     "knownTeammates": [{ "primaryId": "Epic|<their id>|0", "name": "Friend" }],
     "dataDir": "C:\\Users\\<you>\\AppData\\Local\\Whiff"
   }
   ```
   Optional: `"replayLeadSeconds": 10` (how far before a goal a replay jump starts; the review section can change it per jump), `"practiceGameSpeed": 0.85` (your usual practice speed, used when a freeplay or training session's speed can't be measured: no goals, or Disable Goal Reset on, which stops the game sending goal events), `"port"` (default 49200) `"ballchasingToken"` (your API key from ballchasing.com/upload, for downloading replays you uploaded there; see below) and `"allowLan": true` to open the app from your phone on the same network. That is off by default, because anyone on the network could then read your stats and send replay commands to the game.

   `dataDir` defaults to `%LOCALAPPDATA%\Whiff` (`~/.local/share/whiff` elsewhere). Keep it outside OneDrive: file sync and a live SQLite database don't mix.

## Desktop app

`apps/desktop` packages the collector as a Windows tray app with Electron, so nobody needs Node:

- A tray icon shows the status (green: recording, gray: waiting for Rocket League, amber: paused). Click it to open the dashboard in the app's own window (closing it keeps the app in the tray; "Open dashboard in browser" is in the menu too); right-click for Pause recording, Start when I sign in, the data folder, the settings file, the log, updates and Quit.
- **Launch Rocket League** in the tray menu (while the game isn't connected) starts it through Epic, or Steam, or a `"launchUri"` from the settings file. If a game update turned the Stats API off, it offers to turn it back on first, which works without a restart only before the game starts. If the game is already running, it brings it to the front. The dashboard's "Game not running" indicator does the same when clicked (in the desktop app only; `POST /api/game/launch`).
- **Watch with the game closed** (Settings → Game & replays): Watch buttons stay disabled (default), hide (Sessions drops its Replay column), or start Rocket League; then the collector opens the replay (or jumps to the moment) about 8 s after the game connects, retries once if it hasn't opened 15 s later, and gives up after 4 minutes.
- **Sessions cards** describe the listed matches with every filter applied (dates and result included); one card compares solo and with-teammates win rates when both have decided matches and the teammates chip doesn't pick one, Practice only when the list isn't matches-only. Record shows the win rate and the share of wins I was MVP in (under the result chips it shows the wins with the MVP share, the losses with how many were by one goal, or the MVPs as a share of wins). Close games (one-goal share, average margin, overtime and its record) and a Per match table (goals, assists, saves, shots, score, touch share: mean and median) cover the decided matches.
- **Filters** on Sessions: a mode (1s, 2s or 3s of standard play, or an extra mode with matches: tournaments, Rumble, Snow Day, private…, one at a time; the rarer ones sit under an "Other" chip that names the one picked), teammates, result (wins, losses or MVP) and dates (from and to, either open, both included). Replays filters by replay status, result and dates. A chip that would show nothing or everything is off.
- **Replays** (Settings → Game & replays since 0.1.43; there was a Replays tab before) shows every match's replay: saved (and whether it was played through), still in the game's Match History (its place of 20 and the days left, flagged when it's about to drop out) or gone. From there: play saved replays (new matches only, or all), get the missing ones from ballchasing, or one match's. Match History warnings and replay notifications open it when clicked, and so does the tray's "matches have no saved replay" item.
- Sessions and Replays rows have a Watch button when the replay is saved: it opens the replay in the game from the start (`POST /api/replay/watch`). A match only the game's Match History still has is flagged "Save", more urgently when ballchasing was asked and doesn't have it either (ballchasing answers are remembered per match).
- Replays can delete a match, after a confirmation: the database rows (and any replay playbacks of it) go, and a note keeps re-ingesting from bringing it back. The raw log and the replay file stay.
- List columns are configurable in the settings file (not the settings screen yet): `"ui": { "sessionsColumns": [...], "replaysColumns": [...] }`, from `time, playlist, arena, result, score, stats, touches, share, notes` and `when, playlist, arena, result, status`; null or absent means the defaults (Sessions without time and arena, with my score; Replays without arena). Columns keep the list's own order.
- Casual matches (playlists 1–4 and casual limited-time modes) aren't saved unless `"recordCasual": true` (Settings → Game & replays). The raw log keeps them.
- A match nobody touched the ball in (a lobby that fell apart at kickoff, saved as a 0–0 forfeit) isn't kept; ones saved before that rule are removed at startup.
- The tray menu: Launch Rocket League (while it isn't running), Open dashboard, Pause recording, a Replays submenu (play saved replays, ballchasing, matches with no saved replay), the Stats API switch when it's off, Settings…, Check for updates and Quit. The settings file, the log and the browser address are under Settings → Advanced; the data folder under Data & network; start at sign-in under General.
- **Settings…** in the tray menu, or the gear in the dashboard's header, opens the settings: theme (light, dark or the system's), start at sign-in, the Sessions link's default filters and page size, your player ID and known teammates (with players from your team to pick from; changing them re-sorts past matches into Solo and With teammates), replay lead time, the practice speed fallback, the replays folder, shortcuts, which notifications show, the ballchasing key, the data folder, the port and network access. They save into the settings file as you change them; the data folder, port and network access apply after a restart, which the desktop app can do from there. Settings can be changed only on the PC running the app; with `allowLan`, other devices can read them, without the ballchasing key. The dialog's tab is in the URL hash (`#settings/shortcuts`).
- **Get missing replays from ballchasing** in the tray menu downloads the replays of recorded matches that have none saved (the game's Match History keeps only the last 20) from your ballchasing.com uploads, into the game's replays folder under their replay IDs, so review and backfill can use them like replays saved in the game. A match is found by arena, score and date in your uploads, confirmed by the match GUID in the replay's details, and the file's own header is checked before it's kept. The review section on a match page offers the same for one match. Without a `ballchasingToken`, the menu item says how to add one.
- **Auto-upload to ballchasing:** with a key, saved replays go up to ballchasing.com on their own, one a minute (`POST /api/v2/upload`), newest first. `"ballchasingUpload"` (on by default; the Settings switch stays disabled until a key is saved) turns it on, and `"ballchasingUploads"` sets each kind of match: `ranked`, `casual`, `tournament` and `private`, each with `enabled`, `visibility` (public, unlisted or private) and an optional ballchasing `group` (its ID; the settings screen also takes the group's link). The replay header's MatchType gives Online, Tournament or Private; Online is split by the match's playlist (`db.playlistsByGuid`: the live recording, a playthrough, or the note left when a casual match wasn't kept), and an Online match with no known playlist counts as ranked. Defaults: casual off, the rest on; public except private. Before 0.2.3 one `online` rule covered ranked and casual; a settings file that still has it gives ranked its values and casual its visibility and group, switched off (`UploadRules` in `packages/api-contract/src/config.ts`). Each replay goes once: the app remembers what ballchasing has (uploaded, already there, or downloaded from there), checks your uploads list before sending so replays you uploaded by hand aren't sent again, waits while the daily upload quota is used up, and skips replays still being written, offline ones and those of deleted matches. The Replays card on Sessions (Ballchasing tab) shows how many are left.
- Later: more with ballchasing groups.
- **Play saved replays…** in the tray menu plays your saved replays at 2x, one after another, so matches you never recorded become matches (and recorded ones gain the other players' car data). It skips replays already played through, and stops when you start a match or freeplay. The dashboard's header has the same thing as **Play N** (the number of replays left to play), with progress and Stop while it runs; in the desktop app on Windows, "Quit Rocket League when done" closes the game a few seconds after the last replay ends (not after a stop).
- While replays play, a notification shows each one's place in the queue and the time left (estimated from each replay's length). Notifications replace each other and dismiss themselves.
- Match History in the game keeps your last 20 matches from 30 days, and replays can only be saved from there. When a recorded match with no saved replay is about to drop out, the app says so; the tray menu shows how many recent matches have none.
- Global shortcuts, editable under `"shortcuts"` in the settings file (`null` turns one off): `Ctrl+Alt+B` starts or stops playing saved replays (all that are left), `Ctrl+Alt+P` pauses or resumes recording, `Ctrl+Alt+D` opens the dashboard, `Ctrl+Alt+R` goes back to where the last replay jump started (the Stats API has no replay bookmarks, so the app remembers the jump itself). They work while the game has focus.
- It recognizes your player from the in-game camera in your first match and saves the ID, so there's nothing to configure.
- It finds Rocket League through the Epic launcher (or Steam), reads the Stats API's WebSocket port (`WebPort`, 49124; `Port` is a raw TCP socket) and offers to turn the Stats API on. The game is usually under Program Files, so Windows asks for permission.
- Settings live in `%APPDATA%\Whiff\whiff.config.json` (same keys as the repo config; the data folder defaults to `%LOCALAPPDATA%\Whiff`). Logs are next to it in `logs`. On first start after the rename, `moveFromRlStatsLab` (`apps/collector/src/migrate.ts`) moves RL Stats Lab's settings from `%APPDATA%\RL Stats Lab` and, if it was in the old default place, its data from `~/rl-stats-lab-data`. The app ID stays `dev.rlstatslab.desktop`, so installs upgrade in place.

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build the web app and run the tray app from source. Stop `npm run collect` first: both use port 49200. |
| `npm run desktop:dist` | Build the installer (`apps/desktop/release/Whiff-Setup-<version>.exe`). Run it on Windows. |

`npm run ship` runs `npm ci` and `desktop:dist`, then opens the release folder (`npm run ship:run` launches the installer instead).

### Releases and updates

`npm run release` tags the version in `apps/desktop/package.json` and pushes it (`npm run release -- patch`, `minor`, `major` or `1.2.3` bumps and commits the version first). It needs a clean, up-to-date `main`. The tag starts the "Desktop app" workflow on GitHub Actions: typecheck, tests, the installer, then a published release with the installer, its blockmap, `latest.yml` and the commit subjects since the previous tag as notes (commits are the changelog, so write their subjects for users). A tag that doesn't match the version fails the build before anything is uploaded. Running the workflow by hand from the Actions tab makes a draft release instead, a test build installed copies don't see.

Installed copies use electron-updater: they check the latest published release at start and every 6 hours (and from the tray's **Check for updates**), download a newer version in the background (only the changed blocks, thanks to the blockmap), notify, and install it when Whiff quits. The installer isn't code-signed, so electron-updater doesn't check a signature. Installs from before 0.2.0 look for updates in the old repo, so they need one manual install of a release from fwonkas/Whiff.

The app and tray icons are rendered from `apps/desktop/assets/icon.svg` by `apps/desktop/scripts/make-icons.mjs` (the tray adds a state dot) and committed. The dashboard's favicon, SVG icon and Apple touch icon are in `apps/web/public`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run collect` | Records, and serves the app at http://localhost:49200 (run `npm run build` first). It can run all the time: it reconnects when the game starts, writes one raw log per game launch (gzipped once finished, at the next launch or start: about 48 to 1, and ingest reads `.ndjson.gz` the same), and ends any open session when the game closes. Ctrl+C to stop. |
| `npm run dev` | Development: the collector (restarts on change) plus Vite with hot reload at http://localhost:5173. |
| `npm run ingest -- <file or folder> [--force]` | Import recordings (`.ndjson` or `.ndjson.gz`, searched recursively). Already-imported files are skipped. |
| `npm run replay-fixture -- <file.replay> <name> [--me <PrimaryId>]` | Make an anonymized replay-analysis fixture from a saved replay (see Replay analysis). |
| `npm run mock -- <recording> [--speed 10] [--port 49124]` | Serve a recording as if it were the game, to develop without playing. |
| `npm test` | All tests: sessionizer, metrics, API, mock game → collector → database, and the web screens. |
| `npm run typecheck` | Type-check the Node packages and the web app. |

## Building the screens

Sessions (`apps/web/src/routes/SessionsPage.tsx`) is the worked example:

- **Filters live in the URL.** The route validates them with Zod (`router.tsx`), the page reads them with `getRouteApi("/sessions").useSearch()`, and `FilterChips` are links that change one search param.
- **Data comes from hooks** in `lib/api.tsx` (`useSessions`, `useSummary`, `useSession`, `useTrends`, `useSplits`, `usePractice`), never from `fetch` in a component. Query keys live in one place so the live feed can refresh everything when a session is saved.
- **One markup, two layouts.** Each row is a CSS grid; under 860 px only `grid-template-areas` changes, turning the table into two-line cards.
- **Tests** render the real router at a URL with a fake API client (`SessionsPage.test.tsx`).

The match page shows the goal timeline (mine above the line, theirs below, overtime shaded), the replay review, a touch map (top-down, my team attacking up; filter by whose touches, or choose a goal to see the touches in the 12 seconds before it, numbered in order) and the scoreboard (my team first, MVP and known teammates marked). Practice sessions show their numbers instead.

Replay review: in the desktop app, a jump also brings Rocket League to the front and points the camera at your car (or the director camera). `useReview(id)` lists a match's goals for and against with replay frames (from the saved replay's header, or a playback's frame index), and `useReplayGoto()` makes the game load that replay and jump a few seconds before a frame. It answers `{ ok: false, reason }` when the game can't (not running, or a match in progress). Play pauses just after the goal: 58 frames after it when ticks show that (the cut to the next kickoff comes about 66 frames after `GoalScored`, and paused at the cut the game has already switched to the free Fly camera), or at `GoalReplayStart`/`CountdownBegin` otherwise. A seek has taken only once the game sends `MatchDestroyed`; until then ticks show the old frame, so the camera and the pause wait for it. Paused at that cut, ticks say `bReplay: false` but keep their `Frame`; only ticks without a frame mean the replay was left.

Trends and Practice are wired to their data and show it raw in collapsible panels; they're hidden unless Settings → Advanced → "Show Trends and Practice" is on. The comment at the top of each file lists what to build, from the mockup. About (`AboutPage.tsx`) shows the version from `apps/desktop/package.json`, which Vite builds in as `__APP_VERSION__`.

## What the API actually does

The API's behavior differs from its documentation in ways that matter. Each rule below came from a recorded session and is covered by a test:

- `Data` arrives as a JSON string inside the envelope.
- `MatchGuid` is empty on every live event; ticks (`UpdateState`) carry the real one.
- Online goals fire `GoalScored` twice. The second event (blank scorer, at the end of the goal replay) has the correct location; the first often carries the previous goal's location.
- Speeds are km/h, not Unreal units per second.
- Boolean car flags are omitted when false, and `bOnWall` arrives with `bOnGround: true`.
- Live car state arrives for you and your teammates only; replays carry it for everyone.
- `BallHit` repeats within one contact (collapsed within 100 ms). `CrossbarHit` repeats while the ball or puck rests on the bar (collapsed within 500 ms).
- The clock counts up in overtime and freeplay, and down per shot in training.
- Final stats come from the `MatchEnded` snapshot: after it, casual lobbies show the next match's GUID and Snow Day resets the score to 0–0.
- A match you leave ends in `MatchDestroyed` with no `MatchEnded`, and it's recorded as abandoned.
- Bots all share `PrimaryId` `Unknown|0|0`.
- Private matches are playlist 6 and get their own `MatchGuid`, like online ones. They have no fixed team size, so it's read from the lobby. They're listed but left out of records, trends and splits, as are extra modes (Hoops 27, Rumble 28, Dropshot 29, Snow Day 30) and limited-time modes such as Spooky Cube (playlist 67, 3v3). Filtering by playlist includes them. Tournaments (playlist 34) have no fixed size either; they count as standard play at their measured size.
- In training, every attempt ends in one `GoalScored`, made or missed. The outcome comes from the team score change, which also covers defense packs.
- Practice game speed (such as 85%) can be measured: from the clock in training, and from `GoalTime` in freeplay.
- `SeekReplay` `TimeSeconds` lands on replay frame `TimeSeconds × 30`, not on match clock. Replay sessions store a frame index for seeking.
- A `.replay` file's header holds the match's `MatchGUID` (the same ID the Stats API sends), the replay `Id`, `Date` (the match's end, UTC), `MatchStartEpoch`, `bForfeit` and per-player stats, so saved replays can be matched to recorded matches without loading them.
- `LoadReplay` works by `FileName` only (the replay ID, which is also the `.replay` file name). Failures are silent.
- `SetHUDVisibility` persists into later matches, so the collector restores it.
- A forfeit ends a match with time left: the clock jumps to 0:00 just before `MatchEnded`. A forfeit can come at a tied score.
- Playing a saved replay sends the match's messages again, with every player's car state, `BoostPickup` events (live play sends none), one `GoalScored` per goal with the correct location, and about 93% of touches at 2x. It sends no stat feed and no `MatchEnded`, and pauses itself at the end. A complete playback (from the first kickoff to the end, no forward skips) of a match with no live recording becomes that match, marked as from a replay; for a recorded match it adds the other players' cars and boost pickups.
