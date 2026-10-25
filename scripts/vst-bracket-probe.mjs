#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBingXLiveApi } from "../artifacts/api-server/src/bullet-bot/bingx-live-api.mjs";
import { createVstEndpointPacer } from "../artifacts/api-server/src/bullet-bot/vst-endpoint-pacer.mjs";

export async function main() {
  if (!process.argv.includes("--owner-approved")) throw Error("explicit_owner_approval_required");
  const path = resolve(".local/vst-bracket-probe/state.json");
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await lock.close();
  try {
  let state = null;
  try { state = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (state && !process.argv.includes("--recover")) throw Error("existing_probe_use_recover_never_new_entry");
  if (!state && process.argv.includes("--recover")) throw Error("no_probe_to_recover");
  await mkdir(dirname(path), { recursive: true });
  const save = async (record) => {
    await writeFile(`${path}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  const starts = [];
  const api = createBingXLiveApi({
    environment: "vst", requestPacer: createVstEndpointPacer(),
    writePermission: ({ method, path }) => method !== "GET" &&
      ["/openApi/swap/v2/trade/order", "/openApi/swap/v2/trade/leverage"].includes(path),
    fetchImpl: (raw, options) => {
      const url = new URL(raw);
      const method = options?.method ?? "GET";
      if (url.origin !== "https://open-api-vst.bingx.com") throw Error("VST_host_only");
      if (method !== "GET") {
        if (url.searchParams.get("symbol") !== "BTC-USDT") throw Error("BTC_probe_only");
        if (method === "POST" && url.pathname.endsWith("/leverage")) {
          if (url.searchParams.get("side") !== "LONG" ||
              url.searchParams.get("leverage") !== "10") throw Error("fixed_LONG_10_only");
        } else if (!["POST", "DELETE"].includes(method) || !url.pathname.endsWith("/order")) {
          throw Error("unexpected_probe_mutation");
        }
        starts.push({ method, path: url.pathname, type: url.searchParams.get("type"),
          at: new Date().toISOString() });
        console.log(JSON.stringify({ event: "probe_transport", ...starts.at(-1) }));
      }
      return fetch(raw, options);
    },
  });
  const result = await api.runControlledVstBracketProbe({
    state, save, makeId: () => `vbp_${randomBytes(10).toString("hex")}`,
  });
  console.log(JSON.stringify({ event: "probe_result", ...result, writes: starts }, null, 2));
  } finally {
    await unlink(lockPath);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
