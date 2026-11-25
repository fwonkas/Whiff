import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveStatus } from "./live.ts";

/** Stands in for the browser's WebSocket: tests open, message and close it by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {}
  send(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useLiveStatus(), { wrapper });
  act(() => void vi.advanceTimersByTime(0));
  return { hook, invalidate, socket: () => FakeSocket.all.at(-1)! };
}

describe("the live feed keeps the screens up to date", () => {
  it("fetches again once when the collector says data changed, leaving the settings form alone", () => {
    const { invalidate, socket } = setup();
    act(() => socket().onopen!());
    act(() => {
      socket().send({ type: "changed" });
      socket().send({ type: "session", session: { id: "m1", kind: "match", startedAt: 1, outcome: "win" } });
      socket().send({ type: "changed" });
    });
    expect(invalidate).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(300));
    expect(invalidate).toHaveBeenCalledTimes(1);
    const { queryKey, predicate } = invalidate.mock.calls[0]![0] as unknown as { queryKey: string[]; predicate: (q: { queryKey: string[] }) => boolean };
    expect(queryKey).toEqual(["rl"]);
    expect(predicate({ queryKey: ["rl", "sessions"] })).toBe(true);
    expect(predicate({ queryKey: ["rl", "config"] })).toBe(false);
  });

  it("fetches again after reconnecting, since messages were missed meanwhile, but not on the first connect", () => {
    const { hook, invalidate, socket } = setup();
    act(() => socket().onopen!());
    act(() => void vi.advanceTimersByTime(300));
    expect(invalidate).not.toHaveBeenCalled();
    act(() => socket().onclose!());
    expect(hook.result.current.connected).toBe(false);
    act(() => void vi.advanceTimersByTime(3000));
    act(() => socket().onopen!());
    act(() => void vi.advanceTimersByTime(300));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(hook.result.current.connected).toBe(true);
  });
});
