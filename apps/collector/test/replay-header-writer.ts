/** Writes a header in the .replay format, to test the reader without shipping anyone's replay. */
export class HeaderWriter {
  private parts: number[] = [];
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(...b);
    return this;
  }
  u64(v: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.parts.push(...b);
    return this;
  }
  str(s: string) {
    const bytes = [...new TextEncoder().encode(s), 0];
    this.u32(bytes.length);
    this.parts.push(...bytes);
    return this;
  }
  prop(name: string, type: string, write: (w: HeaderWriter) => void) {
    this.str(name).str(type).u64(0n);
    write(this);
    return this;
  }
  byte(v: number) {
    this.parts.push(v);
    return this;
  }
  bytes() {
    return new Uint8Array(this.parts);
  }
}

/** A minimal header: the fields the app reads, plus the goal list. */
export function minimalHeader(opts: { replayId: string; matchGuid: string; date: string; goals: { frame: number; team: number }[] }) {
  const bytes = new HeaderWriter()
    .u32(0)
    .u32(0)
    .u32(868)
    .u32(34)
    .u32(12)
    .str("TAGame.Replay_Soccar_TA")
    .prop("TotalSecondsPlayed", "FloatProperty", (w) => w.u32(0x43960000)) // 300.0
    .prop("Goals", "ArrayProperty", (w) => {
      w.u32(opts.goals.length);
      for (const g of opts.goals) {
        w.prop("frame", "IntProperty", (x) => x.u32(g.frame))
          .prop("PlayerName", "StrProperty", (x) => x.str("Player"))
          .prop("PlayerTeam", "IntProperty", (x) => x.u32(g.team))
          .str("None");
      }
    })
    .prop("Id", "StrProperty", (w) => w.str(opts.replayId))
    .prop("MatchGUID", "StrProperty", (w) => w.str(opts.matchGuid))
    .prop("Date", "StrProperty", (w) => w.str(opts.date))
    .str("None")
    .bytes();
  // The header size counts from after the size and CRC fields.
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength - 8, true);
  return bytes;
}
