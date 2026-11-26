# Whiff

Whiff records your Rocket League matches, practice and replays while you play, and shows you how you play over time: results, per-match stats, replay analysis and the trends behind your wins and losses. It runs on your own PC, from the system tray, and keeps everything there.

It reads the game's official [Stats API](https://www.rocketleague.com/developer/stats-api), the same data feed streaming overlays use. It doesn't change the game or read its memory.

> Whiff is built with AI: it's written almost entirely by Claude (Anthropic's AI model) from one player's requests and feedback, which is to say it's vibe coded. Expect rough edges, and please report them.
>
> Not affiliated with or endorsed by Psyonix or Epic Games. Rocket League is a trademark of Psyonix.

## What you get

- **Every match recorded:** score, goals, assists, saves, shots, touches and your share of them, with whether you played solo or with known teammates. Ranked, tournaments, private matches and the extra modes; casual matches only if you want them.
- **Sessions:** your matches, newest first, with filters for mode, teammates, result, replay status and dates, and cards that sum up what's listed (win rate, MVP share, close games, per-match averages, numbers from your replays).
- **Match pages:** the goal timeline, a top-down map of every touch, the scoreboard and, from the saved replay, boost, positioning, 50/50s, races to the ball and moments worth reviewing. A **Watch** button jumps the game straight to any moment.
- **Practice:** freeplay and training sessions are recorded too, with time spent and touches. Pages for trends over time and practice are still being built (Settings → Advanced shows them early).
- **Replays:** reminders before an unsaved replay drops out of the game's Match History, and a button that plays your saved replays through the game, one after another, to fill in what live play doesn't show.
- **ballchasing.com (optional):** upload your replays automatically, and get back replays you uploaded but didn't save.

## Requirements

- Windows 10 or 11.
- Rocket League, from Epic Games or Steam.

## Install

1. Download `Whiff-Setup-<version>.exe` from the [latest release](https://github.com/fwonkas/Whiff/releases/latest).
2. Run it. It installs for your Windows user only and needs no administrator rights. Windows may warn that it doesn't recognize the app (the installer isn't code-signed): choose **More info**, then **Run anyway**.
3. Whiff opens its dashboard the first time it starts. After that it starts in the system tray (the area by the clock; it may be under the **^** arrow), including when you sign in to Windows. Settings → General can turn off starting at sign-in, open the dashboard every time, and take you to the Windows setting that keeps the icon on the taskbar.

## First run

1. **Turn on the Stats API.** It's off in the game by default. Whiff finds Rocket League and offers to turn it on; say yes, and allow the Windows permission prompt (the game's settings are in a protected folder). If Rocket League was running, restart it. A game update can turn it off again; Whiff notices and offers again.
2. **Play.** Start a match or some freeplay. Whiff recognizes you from your first match and asks once, in the dashboard, to confirm it picked the right player.
3. **Open the dashboard:** click the tray icon (it opens by itself the first time). Closing the window keeps Whiff running in the tray. The dashboard keeps itself up to date (new matches, saved and analyzed replays, uploads), so there's no need to refresh it.

The tray icon turns gray while recording is paused and gets an orange badge when an update is ready; hover over it for what Whiff is doing. Right-click it for the menu: launch Rocket League, open the dashboard, pause recording, replays, settings, updates and quit.

## Using it

### Sessions and matches

**Sessions** lists everything you've played. The chips above it filter by mode (1s, 2s, 3s or an extra mode), teammates, result, replay status, dates and stars; the filters are in the page address, so a bookmark keeps them. The cards beside the list describe exactly what's listed.

Star a match to keep it handy: the star at the start of its row, or beside the title on its page. The ★ chip lists only starred matches (with how many there are). Stars stay when matches are re-imported.

Tag matches on their page: type a tag under the title and press Enter (tags you've used before are suggested), and remove one with its ×. Matches with a known teammate (Settings → Player) are tagged with their name by themselves, shown with a person icon. Tags show in the list (when it gets narrow, Touch share, Touches and Stats make way for them first; on a phone they take a line of their own), and the tag chip lists the matches with one tag. A match's page also has notes: Add notes, or Edit, and write in Markdown (**bold**, lists, links); Ctrl+Enter saves. Tags and notes stay when matches are re-imported.

Click a match for its page. A match you left before it ended shows as **Left early**, unless all your teammates had already left: then it counts as the loss (or win) its score shows. If the result was settled for another reason, **Count it as a loss** (or win) on its page does the same. In **Replay review**, **Watch** opens the match's replay in the game, and each goal or moment has its own Watch button that jumps there a few seconds before. While watching, `Ctrl+Alt+R` goes back to where the last jump started.

### Saving replays

The game keeps your last 20 matches in **Match History**, and a replay can only be saved from there (in the game: Match History → choose the match → Save Replay). Saved replays give Whiff the most to work with. When a match you recorded is about to drop out of Match History unsaved, Whiff warns you: by default 5 matches before, then again just before it's gone (Settings → Notifications sets how early). Sessions' **Any replay** filter shows the matches that need attention.

Windows' focus settings can hide notifications while you play. To always see them, add Whiff under Windows Settings → System → Notifications → Set priority notifications.

### Playing saved replays

Live play only reports your own team's cars, and nothing at all for a match you didn't record. Playing a saved replay through the game fills that in: every player's data for recorded matches, and a whole new match for ones that weren't recorded.

Use **Play N** in the dashboard's header (it shows how many are left) or the tray's **Replays** menu. **Play new matches** plays only replays of matches Whiff didn't record; **Play all** plays the rest too, at double speed. It stops when you start a match or freeplay. Tick **Quit Rocket League when done** to close the game when the last one finishes, so you can start it and walk away.

### Keyboard shortcuts

They work while the game is in front. Change them in Settings → Shortcuts.

| Shortcut | What it does |
| --- | --- |
| `Ctrl+Alt+D` | Open the dashboard |
| `Ctrl+Alt+P` | Pause or resume recording |
| `Ctrl+Alt+B` | Start or stop playing saved replays |
| `Ctrl+Alt+R` | Go back to where the last replay jump started |
| `Ctrl+Alt+S` | Star the match whose replay is playing in the game (again to unstar it); Settings → Notifications → Stars turns its notification off |

## Settings

Open them from the gear in the dashboard's header, or **Settings…** in the tray menu. They save as you change them.

| Tab | What's there |
| --- | --- |
| General | Theme, start at sign-in, opening the dashboard at start, keeping the tray icon on the taskbar, what the Sessions link opens with |
| Player | Your player ID (found for you) and known teammates, who split your matches into solo and with teammates |
| Game & replays | Your replays at a glance, playing them, replay review lead time, whether to keep casual matches, your practice speed, the replays folder |
| Shortcuts | The keyboard shortcuts |
| Notifications | Which notifications show, and how early the Match History warning comes |
| Ballchasing | Your ballchasing.com API key and upload rules, and getting back replays you didn't save |
| Data & network | The data folder, the port, and opening the dashboard from other devices |
| Advanced | The settings file and log, and pages still being built |

### Where things are kept

| What | Where |
| --- | --- |
| Settings | `%APPDATA%\Whiff\whiff.config.json` |
| Log | `%APPDATA%\Whiff\logs\collector.log` |
| Your data: the database and raw recordings | `%LOCALAPPDATA%\Whiff` (change it under Data & network) |

The raw recordings are everything the game sent, and the database is rebuilt from them, so they're the part to back up. Keep the data folder out of OneDrive or other sync folders: syncing a database while it's in use can damage it.

### On your phone

The dashboard is a web page, served by Whiff on your PC at `http://localhost:49200`. To open it from your phone or another computer on the same network, turn on network access under Settings → Data & network, which then lists the addresses to use. Anyone on your network can then see your stats and send replay commands to the game, so leave it off on networks you don't trust.

### ballchasing.com

With an API key from [ballchasing.com/upload](https://ballchasing.com/upload) (Settings → Ballchasing), Whiff uploads your saved replays, one a minute, newest first, without sending one twice, and titles each one on ballchasing by its playlist and start time ("Ranked Doubles 2026-11-14 20:13") instead of the name you typed when saving it. By default ranked and tournament matches upload as **public**, private matches as private and casual matches not at all; change that, or add a ballchasing group, per kind of match. A match Whiff didn't record counts as ranked until playing its replay through shows otherwise. With the key, Whiff can also download replays you uploaded but didn't save in the game.

## Updating

Whiff checks for updates when it starts and every few hours, and downloads a new version in the background. When one is ready, the tray icon gets an orange badge: choose **Install update and restart** in the tray menu, or it installs the next time you quit Whiff. **Check for updates** in the tray menu checks now and, if there's a new version, downloads it, installs it and restarts Whiff. The About page shows **Update available** next to the version once one is found; clicking it does the same. You can also install a newer `Whiff-Setup-<version>.exe` over the old one. Your settings and data stay.

## Uninstalling

Windows Settings → Apps → Installed apps → Whiff → Uninstall. Your settings and data stay in the folders above; delete those too to remove everything.

## Troubleshooting

- **"Game not running" while it is:** the Stats API is probably off (often after a game update). Choose **Turn on Rocket League's Stats API…** in the tray menu, then restart the game.
- **"Port 49200 is already in use":** another copy of Whiff, or something else, is using the port. Quit it, or change the port under Settings → Data & network.
- **A match is missing:** casual matches aren't kept unless you turn that on (Settings → Game & replays). A match nobody touched the ball in isn't kept either.
- **Something else:** the log (Settings → Advanced) usually says what happened.

## License and source

MIT. The source is at [github.com/fwonkas/Whiff](https://github.com/fwonkas/Whiff). To build or change Whiff, start with [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
