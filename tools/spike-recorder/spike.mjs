// Rocket League Stats API spike recorder.
// Throwaway: records every raw message, reports which fields show up and
// lets you type replay commands to test them. Needs Node 22+ (built-in WebSocket).
//
//   node spike.mjs                 record to ./recordings/<timestamp>/
//   node spike.mjs --label replay  add a label to the folder name
//   node spike.mjs --quiet         hide the live event log
//
// Commands you can type while it runs (Enter to send):
//   pause | resume                 SetMatchPaused
//   speed <n>                      SetGameSpeed (replay only), e.g. speed 4
//   seek <seconds>                 SeekReplay by TimeSeconds
//   frame <n>                      SeekReplay by Frame
//   pov <shortcut|ball> [mode]     ChangePOV, e.g. pov 1 PlayerView, pov ball Fly
//   hud on | hud off               SetHUDVisibility
//   load <replay file name>        LoadReplay by FileName
//   raw {"Command":...}            send any JSON as-is
//   mark <note>                    write a note into the recording (no game command)
//   stats                          print the field report so far

import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const URL = process.env.RL_WS ?? "ws://localhost:49124";
const args = process.argv.slice(2);
const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "";
const quiet = args.includes("--quiet");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join("recordings", label ? `${stamp}_${label}` : stamp);
mkdirSync(dir, { recursive: true });
const out = createWriteStream(join(dir, "raw.ndjson"), { flags: "a" });

const counts = new Map(); // event name -> count
const playerKeys = { live: new Set(), replay: new Set() }; // keys seen on UpdateState players
const gameKeys = { live: new Set(), replay: new Set() };
let firstTick = null;
let lastTickLog = 0;

function write(obj) {
  out.write(JSON.stringify({ receivedAt: Date.now(), ...obj }) + "\n");
}

function handle(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    write({ unparsed: text });
    console.log("! unparsed message (saved):", text.slice(0, 120));
    return;
  }
  // Defensive: some APIs double-encode Data as a string.
  if (typeof msg.Data === "string") {
    try { msg.Data = JSON.parse(msg.Data); msg._dataWasString = true; } catch {}
  }
  write({ msg });

  const name = msg.Event ?? "(no Event field)";
  counts.set(name, (counts.get(name) ?? 0) + 1);

  if (name === "UpdateState") {
    const d = msg.Data ?? {};
    const ctx = d.Game?.bReplay ? "replay" : "live";
    for (const p of d.Players ?? []) for (const k of Object.keys(p)) playerKeys[ctx].add(k);
    for (const k of Object.keys(d.Game ?? {})) gameKeys[ctx].add(k);
    if (!firstTick) {
      firstTick = msg;
      console.log("\nFirst UpdateState (also saved):\n" + JSON.stringify(msg, null, 2).slice(0, 2000) + "\n");
    }
    // One compact line every 5 seconds so you can see it's alive.
    const now = Date.now();
    if (!quiet && now - lastTickLog > 5000) {
      lastTickLog = now;
      const g = d.Game ?? {};
      console.log(`  tick  clock=${g.TimeSeconds} replay=${g.bReplay} frame=${g.Frame ?? "-"} elapsed=${g.Elapsed ?? "-"} players=${(d.Players ?? []).length}`);
    }
    return;
  }

  if (!quiet) {
    const d = msg.Data ?? {};
    const extra =
      name === "BallHit" ? ` ${d.Players?.map((p) => p.Name).join("+")} ${Math.round(d.Ball?.PreHitSpeed ?? 0)}->${Math.round(d.Ball?.PostHitSpeed ?? 0)}` :
      name === "GoalScored" ? ` scorer=${d.Scorer?.Name} speed=${d.GoalSpeed}` :
      name === "ReplayCreated" ? ` file=${d.FileName} guid=${d.MatchGuid}` :
      d.MatchGuid !== undefined ? ` guid=${d.MatchGuid || "(empty)"}` : "";
    console.log(`${new Date().toLocaleTimeString()}  ${name}${extra}`);
  }
}

function report() {
  console.log("\n=== Event counts ===");
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);
  for (const ctx of ["live", "replay"]) {
    if (!playerKeys[ctx].size) continue;
    console.log(`\n=== Player fields seen (${ctx}) ===\n  ${[...playerKeys[ctx]].sort().join(", ")}`);
    console.log(`=== Game fields seen (${ctx}) ===\n  ${[...gameKeys[ctx]].sort().join(", ")}`);
  }
  console.log(`\nRecording: ${join(dir, "raw.ndjson")}\n`);
}

// --- connection with reconnect ---
let ws = null;
function connect() {
  ws = new WebSocket(URL);
  ws.addEventListener("open", () => { console.log(`Connected to ${URL}`); write({ note: "connected" }); });
  ws.addEventListener("message", async (e) => handle(typeof e.data === "string" ? e.data : await e.data.text?.() ?? String(e.data)));
  ws.addEventListener("close", () => {
    write({ note: "disconnected" });
    console.log("Not connected (game closed, API disabled or wrong port). Retrying in 3s...");
    setTimeout(connect, 3000);
  });
  ws.addEventListener("error", () => {}); // close handler does the retry
}
connect();

// --- typed commands ---
function send(cmd) {
  if (ws?.readyState !== WebSocket.OPEN) return console.log("Not connected; command not sent.");
  const text = JSON.stringify(cmd);
  ws.send(text);
  write({ sent: cmd });
  console.log(">> sent", text);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const [word, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (word) {
    case "pause": return send({ Command: "SetMatchPaused", Data: { bPaused: true } });
    case "resume": return send({ Command: "SetMatchPaused", Data: { bPaused: false } });
    case "speed": return send({ Command: "SetGameSpeed", Data: { Speed: Number(arg) } });
    case "seek": return send({ Command: "SeekReplay", Data: { TimeSeconds: Number(arg) } });
    case "frame": return send({ Command: "SeekReplay", Data: { Frame: Number(arg) } });
    case "pov": {
      const [focus, mode] = rest;
      const Data = {};
      if (focus) Data.Focus = focus.toLowerCase() === "ball" ? "Ball" : focus;
      if (mode) Data.Perspective = mode;
      return send({ Command: "ChangePOV", Data });
    }
    case "hud": return send({ Command: "SetHUDVisibility", Data: { bVisible: arg !== "off" } });
    case "load": return send({ Command: "LoadReplay", Data: { FileName: arg } });
    case "raw": try { return send(JSON.parse(arg)); } catch { return console.log("Invalid JSON"); }
    case "mark": write({ note: arg }); return console.log("-- noted:", arg);
    case "stats": return report();
    case "": return;
    default: console.log("Unknown command. Try: pause, resume, speed 4, seek 120, frame 3000, pov 1 PlayerView, hud off, load <name>, mark <note>, stats");
  }
});

process.on("SIGINT", () => { report(); out.end(() => process.exit(0)); });
