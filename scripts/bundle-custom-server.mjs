import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const target = process.env.MAESTRO_SERVER_TARGET;
const rustc = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = target ?? rustc.match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error("Cannot determine the daemon target");
const names = {
  "x86_64-pc-windows-msvc": "maestro-custom-server-windows-x86_64.exe",
  "x86_64-unknown-linux-gnu": "maestro-custom-server-linux-x86_64",
  "aarch64-unknown-linux-gnu": "maestro-custom-server-linux-arm64",
  "aarch64-apple-darwin": "maestro-custom-server-macos-arm64",
};
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "maestro-server",
    "--release",
    "-j",
    "4",
    ...(target ? ["--target", target] : []),
  ],
  { stdio: "inherit" },
);
const filename = triple.includes("windows") ? "maestro-server.exe" : "maestro-server";
const directory = resolve("src-tauri/server-assets");
mkdirSync(directory, { recursive: true });
copyFileSync(
  resolve(
    process.env.CARGO_TARGET_DIR ?? "target",
    ...(target ? [target] : []),
    "release",
    filename,
  ),
  resolve(directory, names[triple] ?? `maestro-custom-server-${triple}`),
);
