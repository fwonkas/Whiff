# Spike recorder

The throwaway recorder used to explore the Stats API before the collector existed. It records raw messages (in the same NDJSON format the collector writes), prints a field report and sends typed commands such as `seek 60` or `hud off`. Needs Node 22+ and no dependencies: `node spike.mjs --label <name>`.
