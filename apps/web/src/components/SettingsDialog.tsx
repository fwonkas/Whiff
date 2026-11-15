import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  NOTIFICATION_KINDS,
  SHORTCUT_ACTIONS,
  UPLOAD_KINDS,
  type ConfigPatch,
  type ConfigResponse,
  type NotificationKind,
  type ShortcutAction,
  type UiSettings,
  type UploadKind,
  type UploadVisibility,
} from "@rl/api-contract";
import { useConfig, useOpenInApp, usePatchConfig, usePickFolder, useRestartApp, useTeammateSuggestions, useTestBallchasing } from "../lib/api.tsx";
import { formatDay } from "../lib/format.ts";
import { BallchasingFetch, ReplaysOverview } from "./ReplayPanels.tsx";
import styles from "./SettingsDialog.module.css";

/**
 * Settings, in a modal with a tab per section. Every control saves when it
 * changes (text fields when they lose focus or on Enter) into the settings
 * file, which stays the source of truth. The tab lives in the URL hash
 * (#settings/shortcuts), so the tray's "Settings…" can open it.
 */

export const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "player", label: "Player" },
  { id: "game", label: "Game & replays" },
  { id: "shortcuts", label: "Shortcuts", desktop: true },
  { id: "notifications", label: "Notifications", desktop: true },
  { id: "ballchasing", label: "Ballchasing" },
  { id: "data", label: "Data & network" },
  { id: "advanced", label: "Advanced", desktop: true },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export function SettingsDialog({ tab, onTab, onClose }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const config = useConfig();
  const patch = usePatchConfig();
  const titleId = useId();
  const tabIds = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
  }, []);

  const tabs = SETTINGS_TABS.filter((t) => !("desktop" in t) || config.data?.desktop);
  const current = tabs.some((t) => t.id === tab) ? tab : "general";

  const save = (p: ConfigPatch) => patch.mutate(p);
  const status = patch.isPending
    ? "Saving…"
    : patch.isError
      ? `Couldn’t save: ${patch.error.message}`
      : patch.data && !patch.data.ok
        ? `Couldn’t save: ${patch.data.reason}.`
        : patch.isSuccess
          ? "Saved."
          : "";

  // Arrow keys move between tabs (the ARIA tabs pattern); the panel follows.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.id === current);
    const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? i + 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length]!;
    onTab(t.id);
    document.getElementById(`${tabIds}-tab-${t.id}`)?.focus();
  };

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      <div className={styles.frame}>
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            Settings
          </h2>
          <span className={styles.status} role="status" aria-live="polite">
            {status}
          </span>
          <button type="button" className={styles.close} onClick={() => ref.current?.close()} aria-label="Close settings">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className={styles.body}>
          <div role="tablist" aria-label="Settings sections" aria-orientation="vertical" className={styles.tabs}>
            {tabs.map((t) => (
              <button
                key={t.id}
                id={`${tabIds}-tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={t.id === current}
                aria-controls={`${tabIds}-panel`}
                tabIndex={t.id === current ? 0 : -1}
                autoFocus={t.id === current}
                className={styles.tab}
                onClick={() => onTab(t.id)}
                onKeyDown={onTabKey}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div id={`${tabIds}-panel`} role="tabpanel" aria-labelledby={`${tabIds}-tab-${current}`} className={styles.panel} tabIndex={0}>
            {config.isPending ? (
              <p className="muted">Loading settings…</p>
            ) : config.isError ? (
              <p className="notice">Settings can’t be changed here: {config.error.message}. Edit whiff.config.json instead.</p>
            ) : (
              <>
                {!config.data.editable && (
                  <p className="notice">These settings can be changed only on the PC running Whiff.</p>
                )}
                <fieldset disabled={!config.data.editable} className={styles.fieldset}>
                  <legend className="visually-hidden">{tabs.find((t) => t.id === current)?.label}</legend>
                  <Panel tab={current} config={config.data} save={save} />
                </fieldset>
              </>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}

type PanelProps = { config: ConfigResponse; save: (p: ConfigPatch) => void };

function Panel({ tab, ...props }: PanelProps & { tab: SettingsTab }) {
  switch (tab) {
    case "general":
      return <GeneralPanel {...props} />;
    case "player":
      return <PlayerPanel {...props} />;
    case "game":
      return <GamePanel {...props} />;
    case "shortcuts":
      return <ShortcutsPanel {...props} />;
    case "notifications":
      return <NotificationsPanel {...props} />;
    case "ballchasing":
      return <BallchasingPanel {...props} />;
    case "data":
      return <DataPanel {...props} />;
    case "advanced":
      return <AdvancedPanel {...props} />;
  }
}

// --- building blocks --------------------------------------------------------

function Section({ title, children, hint }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {hint && <p className={`muted ${styles.hint}`}>{hint}</p>}
      {children}
    </section>
  );
}

function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <div className={`muted ${styles.hint}`}>{hint}</div>}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

function Select<T extends string | number | null>({
  id,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <select id={id} className={styles.input} value={i} disabled={disabled} onChange={(e) => onChange(options[Number(e.target.value)]!.value)}>
      {options.map((o, n) => (
        <option key={n} value={n}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  id,
  checked,
  onChange,
  label,
  disabled,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <label className={styles.toggle} htmlFor={id} data-disabled={disabled || undefined}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A text field that saves when it loses focus or on Enter, and only when it changed. */
function TextField({
  id,
  value,
  onCommit,
  type = "text",
  placeholder,
  mono,
  disabled,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => void;
  type?: "text" | "number" | "password";
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <input
      id={id}
      type={type}
      className={`${styles.input} ${mono ? "num" : ""}`}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function Button({ children, onClick, disabled, kind }: { children: ReactNode; onClick: () => void; disabled?: boolean; kind?: "primary" | "danger" }) {
  return (
    <button type="button" className={styles.button} data-kind={kind} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

// --- panels -----------------------------------------------------------------

/** Windows, not Whiff, decides whether the tray icon sits on the taskbar or under ^; this points to the switch. */
function TrayIconHint() {
  const open = useOpenInApp();
  return (
    <div className={styles.trayHint}>
      <p className={`muted ${styles.hint}`}>
        Windows decides whether Whiff’s icon shows on the taskbar or under the ^ arrow. To keep it on the taskbar, turn Whiff on under{" "}
        <strong>Other system tray icons</strong> in the taskbar settings (on Windows 10: <strong>Select which icons appear on the taskbar</strong>).
      </p>
      <div className={styles.actions}>
        <Button onClick={() => open.mutate("taskbarSettings")}>
          Open taskbar settings
        </Button>
      </div>
    </div>
  );
}

function GeneralPanel({ config, save }: PanelProps) {
  const id = useId();
  const ui = (p: Partial<UiSettings>) => save({ ui: p });
  return (
    <>
      <Section title="Appearance">
        <div role="radiogroup" aria-label="Theme" className={styles.segmented}>
          {(["auto", "light", "dark"] as const).map((t) => (
            <label key={t} className={styles.segment}>
              <input type="radio" name={`${id}-theme`} checked={config.ui.theme === t} onChange={() => ui({ theme: t })} />
              <span>{t === "auto" ? "Match system" : t === "light" ? "Light" : "Dark"}</span>
            </label>
          ))}
        </div>
      </Section>

      {config.desktop && (
        <Section title="Startup">
          {config.startAtLogin !== null && (
            <Toggle id={`${id}-login`} checked={config.startAtLogin} onChange={(v) => save({ startAtLogin: v })} label="Start Whiff when I sign in to Windows" />
          )}
          <Toggle
            id={`${id}-open`}
            checked={config.ui.openDashboardOnLaunch}
            onChange={(v) => ui({ openDashboardOnLaunch: v })}
            label="Open the dashboard when Whiff starts"
          />
          <TrayIconHint />
        </Section>
      )}

      <Section title="Dashboard" hint="What the Sessions link opens with. The filter chips still change it.">
        <Row label="Team size" htmlFor={`${id}-size`}>
          <Select
            id={`${id}-size`}
            value={config.ui.defaultTeamSize}
            onChange={(v) => ui({ defaultTeamSize: v })}
            options={[
              { value: null, label: "All" },
              { value: 1, label: "1s" },
              { value: 2, label: "2s" },
              { value: 3, label: "3s" },
            ]}
          />
        </Row>
        <Row label="Teammates" htmlFor={`${id}-with`}>
          <Select
            id={`${id}-with`}
            value={config.ui.defaultWith}
            onChange={(v) => ui({ defaultWith: v })}
            options={[
              { value: null, label: "Anyone" },
              { value: "solo", label: "Solo" },
              { value: "party", label: "With teammates" },
            ]}
          />
        </Row>
        <Row label="Sessions at a time" hint="How many load at first, and each time you scroll near the end of the list." htmlFor={`${id}-page`}>
          <Select
            id={`${id}-page`}
            value={config.ui.sessionsPageSize}
            onChange={(v) => ui({ sessionsPageSize: v })}
            options={[25, 50, 100, 200].map((n) => ({ value: n as 25 | 50 | 100 | 200, label: String(n) }))}
          />
        </Row>
      </Section>
    </>
  );
}

function PlayerPanel({ config, save }: PanelProps) {
  const id = useId();
  const suggestions = useTeammateSuggestions(true);
  const known = new Set(config.knownTeammates.map((t) => t.primaryId));
  const setTeammates = (list: ConfigResponse["knownTeammates"]) =>
    save({ knownTeammates: list.map((t) => ({ primaryId: t.primaryId, ...(t.name ? { name: t.name } : {}) })) });

  return (
    <>
      <Section
        title="Me"
        hint="Your player ID, as the game reports it. Whiff finds it in your first match or practice; set it here if you play on another account. Past sessions keep the player they were recorded with."
      >
        {config.me.some((m) => m.name) && (
          <Row label="Name in game">
            <span>{config.me.map((m) => m.name ?? m.primaryId).join(", ")}</span>
          </Row>
        )}
        <Row label="Player ID" htmlFor={`${id}-me`}>
          <TextField
            id={`${id}-me`}
            mono
            value={config.myPrimaryIds.join(", ")}
            placeholder="Epic|<account id>|0"
            onCommit={(v) => save({ myPrimaryIds: v.split(/[,\s]+/).filter(Boolean), meConfirmed: true })}
          />
        </Row>
      </Section>

      <Section
        title="Known teammates"
        hint="Matches with one of them on your team count as “With teammates”. Changing the list updates past matches too."
      >
        {config.knownTeammates.length ? (
          <ul className={styles.list}>
            {config.knownTeammates.map((t) => (
              <li key={t.primaryId} className={styles.listItem}>
                <TeammateName
                  value={t.name ?? ""}
                  primaryId={t.primaryId}
                  onCommit={(name) => setTeammates(config.knownTeammates.map((x) => (x.primaryId === t.primaryId ? { ...x, name: name || null } : x)))}
                />
                <Button kind="danger" onClick={() => setTeammates(config.knownTeammates.filter((x) => x.primaryId !== t.primaryId))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No known teammates yet.</p>
        )}

        <h4 className={styles.subTitle}>Played on your team</h4>
        {suggestions.isPending ? (
          <p className="muted">Loading…</p>
        ) : suggestions.isError ? (
          <p className="muted">Couldn’t load players: {suggestions.error.message}</p>
        ) : (
          <ul className={styles.list}>
            {suggestions.data
              .filter((s) => !known.has(s.primaryId))
              .slice(0, 12)
              .map((s) => (
                <li key={s.primaryId} className={styles.listItem}>
                  <span className={styles.player}>
                    <strong>{s.name}</strong>
                    <span className="muted">
                      {s.matches} {s.matches === 1 ? "match" : "matches"} · last {formatDay(s.lastPlayedAt)}
                    </span>
                  </span>
                  <Button onClick={() => setTeammates([...config.knownTeammates, { primaryId: s.primaryId, name: s.name }])}>Add</Button>
                </li>
              ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function TeammateName({ value, primaryId, onCommit }: { value: string; primaryId: string; onCommit: (v: string) => void }) {
  const id = useId();
  return (
    <span className={styles.player}>
      <label htmlFor={id} className="visually-hidden">
        Name for {primaryId}
      </label>
      <TextField id={id} value={value} placeholder="Name" onCommit={onCommit} />
      <span className={`muted num ${styles.small}`}>{primaryId}</span>
    </span>
  );
}

function GamePanel({ config, save }: PanelProps) {
  const id = useId();
  const pick = usePickFolder();
  const speeds = [null, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];
  const watchMode = config.ui.watchWithoutGame ?? (config.ui.hideReplayControlsWithoutGame ? "hidden" : "disabled");
  return (
    <>
      <Section title="Replays">
        <ReplaysOverview />
      </Section>
      <Section title="Replay review">
        <Row label="Start a jump" hint="How far before a goal a replay jump starts. The review section can change it per jump." htmlFor={`${id}-lead`}>
          <Select
            id={`${id}-lead`}
            value={config.replayLeadSeconds}
            onChange={(v) => save({ replayLeadSeconds: v })}
            options={[...new Set([3, 5, 6, 8, 10, 12, 15, 20, config.replayLeadSeconds])].sort((a, b) => a - b).map((s) => ({ value: s, label: `${s} s before` }))}
          />
        </Row>
        <Row
          label="Watch with the game closed"
          hint={
            watchMode === "hidden"
              ? "Sessions drops its Replay column too. “Save in game” flags still show on Replays and match pages."
              : watchMode === "launch"
                ? "Watch starts Rocket League, then opens the replay (or jumps to the moment) once it’s up."
                : "Watch buttons wait until Rocket League is running."
          }
          htmlFor={`${id}-watch-mode`}
        >
          <Select
            id={`${id}-watch-mode`}
            value={watchMode}
            onChange={(v) => save({ ui: { watchWithoutGame: v } })}
            options={[
              { value: "disabled", label: "Buttons disabled" },
              { value: "hidden", label: "Buttons hidden" },
              { value: "launch", label: "Start the game" },
            ]}
          />
        </Row>
      </Section>

      <Section title="Recording">
        <Toggle
          id={`${id}-casual`}
          checked={config.recordCasual}
          onChange={(v) => save({ recordCasual: v })}
          label="Record casual matches"
        />
        <p className={`muted ${styles.hint}`}>
          Off: casual matches (and casual limited-time modes) aren’t saved, so they stay out of Sessions, Trends and Replays. The raw recording still
          has them. Casual matches saved before stay until you delete them in Replays.
        </p>
      </Section>

      <Section title="Practice">
        <Row
          label="Usual game speed"
          hint="Used for freeplay and training whose speed can’t be measured: no goals, or Disable Goal Reset on."
          htmlFor={`${id}-speed`}
        >
          <Select
            id={`${id}-speed`}
            value={config.practiceGameSpeed}
            onChange={(v) => save({ practiceGameSpeed: v })}
            options={speeds.map((s) => ({ value: s, label: s === null ? "Unknown" : `${Math.round(s * 100)}%` }))}
          />
        </Row>
      </Section>

      <Section
        title="Replays folder"
        hint={config.replayDirsCustom ? "Set here." : "The game’s own folders under Documents\\My Games\\Rocket League."}
      >
        <ul className={styles.paths}>
          {config.replayDirs.map((d) => (
            <li key={d} className="num">
              {d}
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          {config.desktop && (
            <Button
              onClick={() =>
                pick.mutate(
                  { title: "Rocket League’s replays folder", defaultPath: config.replayDirs[0] },
                  { onSuccess: (path) => path && save({ replayDirs: [path] }) },
                )
              }
              disabled={pick.isPending}
            >
              Choose folder…
            </Button>
          )}
          {config.replayDirsCustom && <Button onClick={() => save({ replayDirs: null })}>Use the game’s folders</Button>}
        </div>
        {!config.desktop && (
          <Row label="Folder" htmlFor={`${id}-dirs`}>
            <TextField id={`${id}-dirs`} mono value={config.replayDirsCustom ? config.replayDirs.join("; ") : ""} placeholder="The game’s folders" onCommit={(v) => save({ replayDirs: v ? v.split(";").map((s) => s.trim()).filter(Boolean) : null })} />
          </Row>
        )}
      </Section>
    </>
  );
}

const SHORTCUT_LABELS: Record<ShortcutAction, { label: string; hint: string }> = {
  backfill: { label: "Play saved replays", hint: "Starts or stops playing all saved replays that are left." },
  pause: { label: "Pause recording", hint: "Pauses or resumes recording." },
  dashboard: { label: "Open dashboard", hint: "Brings up this window." },
  replayAgain: { label: "Replay the goal again", hint: "Back to where the last replay jump started." },
};
const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  backfill: "CommandOrControl+Alt+B",
  pause: "CommandOrControl+Alt+P",
  dashboard: "CommandOrControl+Alt+D",
  replayAgain: "CommandOrControl+Alt+R",
};

/** "CommandOrControl+Alt+B" → "Ctrl+Alt+B". */
export const shortcutLabel = (accel: string | null) => (accel ? accel.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl") : "None");

/** A key press as an Electron accelerator, or null for a press that can't be one (no modifier, or only modifiers). */
export function acceleratorFor(e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const key = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1] ?? (/^F([1-9]|1\d|2[0-4])$/.test(e.code) ? e.code : null);
  if (!key) return null;
  const mods = [e.ctrlKey || e.metaKey ? "CommandOrControl" : null, e.altKey ? "Alt" : null, e.shiftKey ? "Shift" : null].filter(Boolean);
  if (!mods.length) return null;
  return [...mods, key].join("+");
}

function ShortcutsPanel({ config, save }: PanelProps) {
  if (!config.shortcuts) return null;
  return (
    <Section title="Keyboard shortcuts" hint="They work anywhere, including while the game is in front. Click a shortcut, then press the new keys.">
      {config.shortcutsUnavailable.length > 0 && (
        <p className="notice">
          {config.shortcutsUnavailable.map(shortcutLabel).join(", ")} {config.shortcutsUnavailable.length === 1 ? "is" : "are"} taken by another
          app. Pick different keys.
        </p>
      )}
      {SHORTCUT_ACTIONS.map((a) => (
        <ShortcutRow key={a} action={a} value={config.shortcuts![a]} onChange={(v) => save({ shortcuts: { [a]: v } })} />
      ))}
    </Section>
  );
}

function ShortcutRow({ action, value, onChange }: { action: ShortcutAction; value: string | null; onChange: (v: string | null) => void }) {
  const id = useId();
  const [recording, setRecording] = useState(false);
  const { label, hint } = SHORTCUT_LABELS[action];
  return (
    <Row label={label} hint={hint}>
      <div className={styles.actions}>
        <button
          id={id}
          type="button"
          aria-label={`${label}: ${recording ? "press the new keys" : shortcutLabel(value)}`}
          className={`${styles.input} ${styles.capture} num`}
          aria-describedby={`${id}-help`}
          data-recording={recording}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            if (!recording) return;
            if (e.key === "Escape" || e.key === "Tab") return setRecording(false);
            e.preventDefault();
            const accel = acceleratorFor(e);
            if (accel) {
              setRecording(false);
              if (accel !== value) onChange(accel);
            }
          }}
        >
          {recording ? "Press keys…" : shortcutLabel(value)}
        </button>
        <span id={`${id}-help`} className="visually-hidden">
          Press Enter, then the new keys with Ctrl, Alt or Shift.
        </span>
        <Button onClick={() => onChange(null)} disabled={value === null}>
          Clear
        </Button>
        <Button onClick={() => onChange(DEFAULT_SHORTCUTS[action])} disabled={value === DEFAULT_SHORTCUTS[action]}>
          Default
        </Button>
      </div>
    </Row>
  );
}

const NOTIFICATION_LABELS: Record<NotificationKind, { label: string; hint: string }> = {
  launch: { label: "Launching the game", hint: "When Launch Rocket League starts it." },
  replays: { label: "Replay playback and downloads", hint: "Progress while playing saved replays or getting them from ballchasing." },
  matchHistory: { label: "Match History warnings", hint: "Before a match with no saved replay leaves the game’s Match History." },
  recording: { label: "Recording", hint: "Recording paused or resumed, and your player recognized." },
};

function NotificationsPanel({ config, save }: PanelProps) {
  const id = useId();
  if (!config.notifications) return null;
  return (
    <Section title="Desktop notifications" hint="Problems, like the game not sending stats, always show.">
      {NOTIFICATION_KINDS.map((k) => (
        <Row key={k} label={NOTIFICATION_LABELS[k].label} hint={NOTIFICATION_LABELS[k].hint} htmlFor={`${id}-${k}`}>
          <input id={`${id}-${k}`} type="checkbox" className={styles.check} checked={config.notifications![k]} onChange={(e) => save({ notifications: { [k]: e.target.checked } })} />
        </Row>
      ))}
      <Row
        label="Warn about unsaved replays"
        hint="How early the Match History warning comes. It warns again when your next match would drop one, with a sound, and stays until dismissed."
        htmlFor={`${id}-warn`}
      >
        <Select
          id={`${id}-warn`}
          value={config.matchHistoryWarn}
          disabled={!config.notifications.matchHistory}
          onChange={(v) => save({ matchHistoryWarn: v })}
          options={[3, 5, 8, 10].map((n) => ({ value: n, label: `${n} matches before` }))}
        />
      </Row>
    </Section>
  );
}

function BallchasingPanel({ config, save }: PanelProps) {
  const id = useId();
  const [token, setToken] = useState("");
  const test = useTestBallchasing();
  const result = test.data;
  return (
    <>
    <Section
      title="Ballchasing"
      hint={
        <>
          Upload and download ballchasing replays. Copy the key from <a href="https://ballchasing.com/upload" target="_blank" rel="noreferrer">ballchasing.com/upload</a>.
        </>
      }
    >
      <Row label="API key" hint={config.ballchasingTokenSet ? "Saved. Enter a new one to replace it." : "None saved."} htmlFor={`${id}-token`}>
        <div className={styles.actions}>
          <input
            id={`${id}-token`}
            type="password"
            className={`${styles.input} num`}
            value={token}
            autoComplete="off"
            placeholder={config.ballchasingTokenSet ? "••••••••" : "Paste your key"}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button
            kind="primary"
            disabled={!token.trim()}
            onClick={() => {
              save({ ballchasingToken: token.trim() });
              test.mutate(token.trim());
              setToken("");
            }}
          >
            Save
          </Button>
        </div>
      </Row>
      <div className={styles.actions}>
        <Button onClick={() => test.mutate(undefined)} disabled={!config.ballchasingTokenSet || test.isPending}>
          {test.isPending ? "Checking…" : "Check the key"}
        </Button>
        {config.ballchasingTokenSet && (
          <Button kind="danger" onClick={() => save({ ballchasingToken: null })}>
            Remove key
          </Button>
        )}
        <span className={styles.small} role="status">
          {test.isError
            ? `Couldn’t check: ${test.error.message}`
            : result?.ok
              ? `Works: signed in as ${result.name ?? "your account"}${result.tier ? ` (${result.tier})` : ""}.`
              : result
                ? `Didn’t work: ${result.reason}.`
                : ""}
        </span>
      </div>
      <Toggle
        id={`${id}-upload`}
        checked={config.ballchasingUpload}
        disabled={!config.ballchasingTokenSet}
        describedBy={config.ballchasingTokenSet ? undefined : `${id}-upload-hint`}
        onChange={(v) => save({ ballchasingUpload: v })}
        label="Upload saved replays automatically"
      />
      {!config.ballchasingTokenSet && (
        <p id={`${id}-upload-hint`} className={`muted ${styles.hint}`}>
          Needs an API key.
        </p>
      )}
      <UploadKinds id={id} config={config} save={save} disabled={!config.ballchasingTokenSet || !config.ballchasingUpload} />
    </Section>
    <Section title="Missing replays">
      <BallchasingFetch />
    </Section>
    </>
  );
}

const UPLOAD_KIND_LABELS: Record<UploadKind, string> = { ranked: "Ranked", casual: "Casual", tournament: "Tournament", private: "Private" };
const VISIBILITY_OPTIONS: { value: UploadVisibility; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
  { value: "private", label: "Private" },
];

/** Per kind of match: upload or not, who can see it, and a group to add it to. */
function UploadKinds({ id, config, save, disabled }: PanelProps & { id: string; disabled: boolean }) {
  return (
    <div className={styles.uploadKinds} role="group" aria-label="What uploads">
      <div className={styles.uploadHead} aria-hidden="true">
        <span>Upload</span>
        <span>Who can see them</span>
        <span>Group</span>
      </div>
      {UPLOAD_KINDS.map((k) => {
        const rule = config.ballchasingUploads[k];
        const off = disabled || !rule.enabled;
        const label = UPLOAD_KIND_LABELS[k];
        return (
          <div key={k} className={styles.uploadKind}>
            <Toggle id={`${id}-up-${k}`} checked={rule.enabled} disabled={disabled} label={label} onChange={(v) => save({ ballchasingUploads: { [k]: { enabled: v } } })} />
            <div className={styles.uploadField}>
              <label className="visually-hidden" htmlFor={`${id}-vis-${k}`}>
                {label}: who can see them
              </label>
              <Select id={`${id}-vis-${k}`} value={rule.visibility} disabled={off} options={VISIBILITY_OPTIONS} onChange={(v) => save({ ballchasingUploads: { [k]: { visibility: v } } })} />
            </div>
            <div className={styles.uploadField}>
              <label className="visually-hidden" htmlFor={`${id}-grp-${k}`}>
                {label}: group
              </label>
              <TextField
                id={`${id}-grp-${k}`}
                value={rule.group ?? ""}
                disabled={off}
                placeholder="None (ID or link)"
                onCommit={(v) => save({ ballchasingUploads: { [k]: { group: v || null } } })}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DataPanel({ config, save }: PanelProps) {
  const id = useId();
  const open = useOpenInApp();
  const pick = usePickFolder();
  const restart = useRestartApp();
  const pending = config.restartPending.length > 0;
  return (
    <>
      {pending && (
        <div className={`notice ${styles.restart}`}>
          <span>Restart Whiff to use the new {config.restartPending.map((k) => (k === "dataDir" ? "data folder" : k === "port" ? "port" : "network setting")).join(" and ")}.</span>
          {config.desktop ? (
            <Button kind="primary" onClick={() => restart.mutate()} disabled={restart.isPending}>
              {restart.isPending || restart.isSuccess ? "Restarting…" : "Restart now"}
            </Button>
          ) : (
            <span>Stop the collector and start it again.</span>
          )}
        </div>
      )}
      <Section
        title="Data folder"
        hint="The database and the raw recordings. Changing it doesn’t move what’s there: move the folder’s contents yourself while Whiff is closed, or it starts empty."
      >
        <Row label="Folder" htmlFor={`${id}-data`}>
          <div className={styles.actions}>
            <TextField id={`${id}-data`} mono value={config.dataDir} onCommit={(v) => v && save({ dataDir: v })} />
            {config.desktop && (
              <Button
                onClick={() => pick.mutate({ title: "Data folder", defaultPath: config.dataDir }, { onSuccess: (path) => path && path !== config.dataDir && save({ dataDir: path }) })}
                disabled={pick.isPending}
              >
                Choose…
              </Button>
            )}
            {config.desktop && <Button onClick={() => open.mutate("dataDir")}>Open folder</Button>}
          </div>
        </Row>
      </Section>
      <Section title="Network">
        <Row label="Port" htmlFor={`${id}-port`}>
          <TextField id={`${id}-port`} type="number" mono value={String(config.port)} onCommit={(v) => Number(v) && save({ port: Number(v) })} />
        </Row>
        <Row label="This PC">
          <div className={styles.actions}>
            <span className={`num ${styles.small} ${styles.pathText}`}>{config.addresses.thisPc}</span>
            {config.desktop && <Button onClick={() => open.mutate("browser")}>Open in browser</Button>}
          </div>
        </Row>
        <Toggle id={`${id}-lan`} checked={config.allowLan} onChange={(v) => save({ allowLan: v })} label="Open the dashboard from other devices on my network" />
        <p className={`muted ${styles.hint}`}>
          Anyone on the network could then read your stats and send replay commands to the game. Settings can still be changed only on this PC.
        </p>
        {config.allowLan && (
          <Row
            label="Addresses"
            hint={
              config.addresses.network.length
                ? "On another device, try the name first; if it doesn’t open, use a number address."
                : "Other devices can use this PC’s address after a restart."
            }
          >
            {config.addresses.network.length > 0 && (
              <ul className={styles.addresses} aria-label="Dashboard addresses">
                {config.addresses.network.map((a) => (
                  <li key={a}>
                    <span className={`num ${styles.small}`}>{a}</span>
                  </li>
                ))}
              </ul>
            )}
          </Row>
        )}
      </Section>
    </>
  );
}

function AdvancedPanel({ config, save }: PanelProps) {
  const open = useOpenInApp();
  const id = useId();
  if (!config.paths) return null;
  const p = config.paths;
  const files = [
    { what: "settingsFile", label: "Settings file", hint: "Everything on these tabs, as JSON. Edit it by hand while the app runs; it reads it again as needed.", path: p.settingsFile, button: "Open file" },
    { what: "logFile", label: "Log", hint: "What the app did, for when something goes wrong.", path: p.logFile, button: "Open log" },
  ] as const;
  return (
    <>
      <Section title="Files">
        {files.map((f) => (
          <Row key={f.what} label={f.label} hint={f.hint}>
            <div className={styles.actions}>
              <span className={`num ${styles.small} ${styles.pathText}`}>{f.path}</span>
              <Button onClick={() => open.mutate(f.what)}>{f.button}</Button>
            </div>
          </Row>
        ))}
      </Section>
      <Section title="Pages">
        <Toggle
          id={`${id}-pages`}
          checked={config.ui.showTrendsPractice}
          onChange={(v) => save({ ui: { showTrendsPractice: v } })}
          label="Show Trends and Practice"
        />
        <p className={`muted ${styles.hint}`}>These pages are still being built. Off: their links are hidden and their addresses open Sessions.</p>
      </Section>
      <Section title="Replays">
        <Toggle
          id={`${id}-fast`}
          checked={config.ui.markFastPlaybacks}
          onChange={(v) => save({ ui: { markFastPlaybacks: v } })}
          label="Mark replays played through too fast"
        />
        <p className={`muted ${styles.hint}`}>
          For matches never recorded live, the replay is the only source, and playing it faster than 1x misses a few touches. Their Watch
          buttons turn orange; watching one through at normal speed fills the touches in. Matches recorded live aren’t affected.
        </p>
      </Section>
    </>
  );
}
