import { z } from "zod";

/**
 * The settings screen's view of the settings file, and the changes it can
 * send. The file stays the source of truth (people edit it by hand too);
 * unknown keys in it are kept.
 */

export const SHORTCUT_ACTIONS = ["backfill", "pause", "dashboard", "replayAgain"] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** Desktop notifications by kind. Problems (something failed) always show. */
export const NOTIFICATION_KINDS = ["launch", "replays", "matchHistory", "recording"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const Theme = z.enum(["auto", "light", "dark"]);
export type Theme = z.infer<typeof Theme>;

/** Columns of the Sessions list, in display order; the replay control always shows. */
export const SESSION_COLUMNS = ["time", "playlist", "arena", "result", "score", "stats", "touches", "share", "notes"] as const;
export type SessionColumn = (typeof SESSION_COLUMNS)[number];
export const DEFAULT_SESSION_COLUMNS: SessionColumn[] = ["playlist", "result", "score", "stats", "touches", "share", "notes"];
/** Columns of the Replays list; the actions always show. */
export const REPLAY_COLUMNS = ["when", "playlist", "arena", "result", "status"] as const;
export type ReplayColumn = (typeof REPLAY_COLUMNS)[number];
export const DEFAULT_REPLAY_COLUMNS: ReplayColumn[] = ["when", "playlist", "result", "status"];

/** Kinds of match whose saved replays can upload to ballchasing, each with its own settings. */
/** Ranked and casual matchmaking (both "Online" in a replay's header), tournaments and private matches. */
export const UPLOAD_KINDS = ["ranked", "casual", "tournament", "private"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
export const UploadVisibility = z.enum(["public", "unlisted", "private"]);
export type UploadVisibility = z.infer<typeof UploadVisibility>;
export interface UploadRule {
  enabled: boolean;
  visibility: UploadVisibility;
  /** A ballchasing group ID to add the replays to, or null for none. */
  group: string | null;
}
export const DEFAULT_UPLOAD_RULES: Record<UploadKind, UploadRule> = {
  ranked: { enabled: true, visibility: "public", group: null },
  casual: { enabled: false, visibility: "public", group: null },
  tournament: { enabled: true, visibility: "public", group: null },
  private: { enabled: true, visibility: "private", group: null },
};
/** A group as pasted: its ID, or a ballchasing.com/group/<id> link. */
const GroupId = z
  .string()
  .trim()
  .transform((s) => s.replace(/^https?:\/\/(www\.)?ballchasing\.com\/group\//i, "").replace(/[/?#].*$/, ""))
  .pipe(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "a group ID is letters, digits, - and _ (or paste the group's link)"));
const ruleSchema = (d: UploadRule) =>
  z.object({ enabled: z.boolean().default(d.enabled), visibility: UploadVisibility.default(d.visibility), group: GroupId.nullable().default(d.group) });
/**
 * Before 0.2.3 one "online" rule covered ranked and casual. A settings file
 * that still has it: ranked takes it, and casual takes its visibility and
 * group but starts off. Each new rule's own saved values win.
 */
function splitOnlineRule(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !("online" in raw)) return raw;
  const { online, ...rest } = raw as Record<string, unknown>;
  if (!online || typeof online !== "object") return rest;
  const obj = (v: unknown) => (v && typeof v === "object" ? v : {});
  return { ...rest, ranked: { ...online, ...obj(rest.ranked) }, casual: { ...online, enabled: false, ...obj(rest.casual) } };
}
export const UploadRules = z.preprocess(
  splitOnlineRule,
  z.object({
    ranked: ruleSchema(DEFAULT_UPLOAD_RULES.ranked).default(DEFAULT_UPLOAD_RULES.ranked),
    casual: ruleSchema(DEFAULT_UPLOAD_RULES.casual).default(DEFAULT_UPLOAD_RULES.casual),
    tournament: ruleSchema(DEFAULT_UPLOAD_RULES.tournament).default(DEFAULT_UPLOAD_RULES.tournament),
    private: ruleSchema(DEFAULT_UPLOAD_RULES.private).default(DEFAULT_UPLOAD_RULES.private),
  }),
);
export type UploadRules = Record<UploadKind, UploadRule>;
const RulePatch = z.object({ enabled: z.boolean(), visibility: UploadVisibility, group: GroupId.nullable() }).partial().strict();

export const UiSettings = z.object({
  theme: Theme.default("auto"),
  /** Filters the Sessions link opens with. */
  defaultTeamSize: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().default(null),
  defaultWith: z.enum(["solo", "party"]).nullable().default(null),
  /** Sessions loaded at a time on the Sessions screen (scrolling near the end of the list loads the next batch). */
  sessionsPageSize: z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(200)]).default(100),
  /** Which list columns show (any order; shown in the list's own order). Null: the defaults. Not in the settings screen yet. */
  sessionsColumns: z.array(z.enum(SESSION_COLUMNS)).nullable().default(null),
  replaysColumns: z.array(z.enum(REPLAY_COLUMNS)).nullable().default(null),
  /**
   * What Watch buttons do while Rocket League isn't running: stay disabled,
   * hide (and Sessions drops its Replay column), or start the game and open
   * the replay. Null: from the older switch below, else disabled.
   */
  watchWithoutGame: z.enum(["disabled", "hidden", "launch"]).nullable().default(null),
  /** 0.1.31's switch, read when watchWithoutGame isn't set: true means hidden. */
  hideReplayControlsWithoutGame: z.boolean().default(false),
  /**
   * Mark Watch buttons (orange) for matches not recorded live whose replay was
   * only played through faster than 1x, so it can be watched again at 1x.
   */
  markFastPlaybacks: z.boolean().default(false),
  /**
   * Show the Trends and Practice pages (nav links and routes). Off while they
   * aren't built out; their addresses open Sessions. Temporary: goes once work
   * on those pages starts.
   */
  showTrendsPractice: z.boolean().default(false),
  /** The last choice for "Quit Rocket League when done" when playing saved replays. */
  quitAfterReplays: z.boolean().default(false),
  /** Desktop app: open the dashboard every time Whiff starts, start at sign-in included (it always does on the very first start). */
  openDashboardOnLaunch: z.boolean().default(false),
});
export type UiSettings = z.infer<typeof UiSettings>;
export const DEFAULT_UI: UiSettings = UiSettings.parse({});

export const NotificationSettings = z.object(
  Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, z.boolean().default(true)])) as Record<NotificationKind, z.ZodDefault<z.ZodBoolean>>,
);
export type NotificationSettings = z.infer<typeof NotificationSettings>;

/** An Electron accelerator ("CommandOrControl+Alt+B"), or null for none. */
const Accelerator = z
  .string()
  .trim()
  .regex(/^((CommandOrControl|Ctrl|Alt|Shift|Super)\+){1,3}([A-Z0-9]|F([1-9]|1[0-9]|2[0-4]))$/, "a shortcut needs a modifier and a letter, digit or F key")
  .nullable();

const PrimaryId = z.string().trim().regex(/^[A-Za-z0-9]+\|[^|\s]+\|\d+$/, "a player ID looks like Epic|<account id>|0");

export const ConfigPatch = z
  .object({
    myPrimaryIds: z.array(PrimaryId).max(8),
    /**
     * True: the player is confirmed. Sent with myPrimaryIds while it's still
     * unconfirmed, sessions credited to the guessed player move to the one picked.
     */
    meConfirmed: z.boolean(),
    knownTeammates: z.array(z.object({ primaryId: PrimaryId, name: z.string().trim().max(64).optional() })).max(100),
    dataDir: z.string().trim().min(1),
    /** Folders with saved replays; null goes back to the game's own (Documents\My Games\…). */
    replayDirs: z.array(z.string().trim().min(1)).max(4).nullable(),
    practiceGameSpeed: z.number().gt(0).max(1).nullable(),
    /** Matches of warning before an unsaved one drops out of Match History. */
    matchHistoryWarn: z.number().int().min(1).max(15),
    replayLeadSeconds: z.number().min(0).max(60),
    recordCasual: z.boolean(),
    /** null removes it. Never sent back. */
    ballchasingToken: z.string().trim().min(1).nullable(),
    /** Upload saved replays (only does anything with a key), by kind of match. */
    ballchasingUpload: z.boolean(),
    ballchasingUploads: z.object({ ranked: RulePatch, casual: RulePatch, tournament: RulePatch, private: RulePatch }).partial().strict(),
    shortcuts: z.object(Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, Accelerator])) as Record<ShortcutAction, typeof Accelerator>).partial(),
    notifications: NotificationSettings.partial(),
    startAtLogin: z.boolean(),
    port: z.number().int().min(1024).max(65535),
    allowLan: z.boolean(),
    ui: UiSettings.partial(),
  })
  .partial()
  .strict();
export type ConfigPatch = z.infer<typeof ConfigPatch>;

/** Settings that only take effect when the app restarts. */
export const RESTART_KEYS = ["dataDir", "port", "allowLan"] as const satisfies (keyof ConfigPatch)[];

export interface ConfigResponse {
  /** Changes are accepted only from this PC, not from other devices on the network. */
  editable: boolean;
  /** Running in the desktop app: folder picker, restart, shortcuts, start at login and notifications. */
  desktop: boolean;
  myPrimaryIds: string[];
  /** My players with the name the game last showed for each (null before any session). */
  me: { primaryId: string; name: string | null }[];
  /** False while my player is the app's own guess (from the first live play), not yet confirmed. */
  meConfirmed: boolean;
  knownTeammates: { primaryId: string; name: string | null }[];
  dataDir: string;
  /** The folders in use, and whether they're set here rather than the game's default. */
  replayDirs: string[];
  replayDirsCustom: boolean;
  practiceGameSpeed: number | null;
  matchHistoryWarn: number;
  replayLeadSeconds: number;
  recordCasual: boolean;
  ballchasingTokenSet: boolean;
  ballchasingUpload: boolean;
  ballchasingUploads: UploadRules;
  shortcuts: Record<ShortcutAction, string | null> | null;
  /** Shortcuts that are set but couldn't be registered (taken by another app, or invalid). */
  shortcutsUnavailable: string[];
  notifications: NotificationSettings | null;
  startAtLogin: boolean | null;
  port: number;
  allowLan: boolean;
  ui: UiSettings;
  /** Changed settings waiting for a restart. */
  restartPending: string[];
  /**
   * Where the dashboard answers, with the port it's running on: this PC's
   * address, and with network access on, this PC's name on the network
   * (.local) and its network addresses.
   */
  addresses: { thisPc: string; network: string[] };
  /** Desktop app only: where its files are, and the dashboard's address for a browser. */
  paths: { settingsFile: string; logFile: string; dataDir: string; dashboardUrl: string } | null;
}

/** "taskbarSettings": Windows Settings → Personalization → Taskbar, where tray icons are shown or hidden. */
export const OpenTarget = z.enum(["settingsFile", "logFile", "dataDir", "browser", "taskbarSettings"]);
export type OpenTarget = z.infer<typeof OpenTarget>;

export type ConfigPatchResponse = { ok: true; config: ConfigResponse } | { ok: false; reason: string };

/** Players who were on my team, most frequent first, for picking known teammates. */
/** Someone else in the session my player was recognized in, to pick when the guess is wrong. */
export interface MeCandidate {
  primaryId: string;
  name: string;
}

export interface TeammateSuggestion {
  primaryId: string;
  name: string;
  matches: number;
  lastPlayedAt: number;
  known: boolean;
}

export type BallchasingTestResponse = { ok: true; name: string | null; tier: string | null } | { ok: false; reason: string };
