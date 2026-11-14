import { z } from "zod";

/** Commands the game accepts on the same socket. Verified in the 2026-10-21 spike. */

export const ChangePOV = z.object({
  Command: z.literal("ChangePOV"),
  Data: z
    .object({
      /** "Ball" or a spectator shortcut as a digit string. */
      Focus: z.union([z.literal("Ball"), z.string().regex(/^\d+$/)]).optional(),
      Perspective: z
        .enum(["Fly", "SoftAttach", "HardAttach", "PlayerView", "AutoCam", "Camera_Director"])
        .optional(),
    })
    .refine((d) => d.Focus !== undefined || d.Perspective !== undefined, {
      message: "Focus or Perspective is required",
    }),
});

/** Works by FileName (the replay ID) only; Path did nothing in testing. Failures are silent. */
export const LoadReplay = z.object({
  Command: z.literal("LoadReplay"),
  Data: z.object({ FileName: z.string().min(1).optional(), Path: z.string().optional() }),
});

/** TimeSeconds lands on replay frame TimeSeconds × 30, not on match clock. Past the end clamps. */
export const SeekReplay = z.object({
  Command: z.literal("SeekReplay"),
  Data: z.object({ Frame: z.number().int().nonnegative().optional(), TimeSeconds: z.number().nonnegative().optional() }),
});

/** 0 pauses. Effective maximum is about 10. */
export const SetGameSpeed = z.object({
  Command: z.literal("SetGameSpeed"),
  Data: z.object({ Speed: z.number().min(0) }),
});

/** Persists into later live matches: always restore it. */
export const SetHUDVisibility = z.object({
  Command: z.literal("SetHUDVisibility"),
  Data: z.object({ bVisible: z.boolean() }),
});

export const SetMatchPaused = z.object({
  Command: z.literal("SetMatchPaused"),
  Data: z.object({ bPaused: z.boolean() }),
});

export const GameCommand = z.discriminatedUnion("Command", [
  ChangePOV,
  LoadReplay,
  SeekReplay,
  SetGameSpeed,
  SetHUDVisibility,
  SetMatchPaused,
]);
export type GameCommand = z.infer<typeof GameCommand>;

/** Frames per SeekReplay second. */
export const SEEK_FRAMES_PER_SECOND = 30;

export const commands = {
  seekToFrame: (frame: number): GameCommand => ({
    Command: "SeekReplay",
    Data: { TimeSeconds: Math.max(0, frame) / SEEK_FRAMES_PER_SECOND },
  }),
  load: (replayId: string): GameCommand => ({ Command: "LoadReplay", Data: { FileName: replayId } }),
  speed: (speed: number): GameCommand => ({ Command: "SetGameSpeed", Data: { Speed: speed } }),
  pause: (paused: boolean): GameCommand => ({ Command: "SetMatchPaused", Data: { bPaused: paused } }),
  hud: (visible: boolean): GameCommand => ({ Command: "SetHUDVisibility", Data: { bVisible: visible } }),
  pov: (focus: "Ball" | number, perspective?: z.infer<typeof ChangePOV>["Data"]["Perspective"]): GameCommand => ({
    Command: "ChangePOV",
    Data: { Focus: focus === "Ball" ? "Ball" : String(focus), ...(perspective ? { Perspective: perspective } : {}) },
  }),
};
