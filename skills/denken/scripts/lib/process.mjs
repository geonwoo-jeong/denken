// The agent CLI's process: started in its own process group, timed out, and stopped with
// everything it started.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { ROOT, sleep } from "./core.mjs";

// Each agent CLI leads its own process group, so the test runners, servers and shells it
// starts can be stopped with it. Signals go to the whole group (negative pid).

export function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function stopGroup(pgid) {
  if (!pgid || !signalGroup(pgid, 0)) return;
  signalGroup(pgid, "SIGTERM");
  for (let i = 0; i < 30 && signalGroup(pgid, 0); i++) await sleep(100);
  signalGroup(pgid, "SIGKILL");
}

// Stop a group only if its leader is still the agent CLI we started, never a reused pid.
export async function stopCallGroup(base, provider) {
  const pgid = Number(existsSync(`${base}.cli.pid`) ? readFileSync(`${base}.cli.pid`, "utf8") : 0);
  if (!pgid) return;
  const command = spawnSync("ps", ["-o", "command=", "-p", String(pgid)], { encoding: "utf8" }).stdout ?? "";
  if (command.includes(provider)) await stopGroup(pgid);
}

export async function runCli(provider, args, input, base, timeoutMs, env = null) {
  const logFd = openSync(`${base}.log`, "w");
  const child = spawn(provider, args, { cwd: ROOT, stdio: ["pipe", logFd, logFd], detached: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
  closeSync(logFd);
  if (child.pid) writeFileSync(`${base}.cli.pid`, String(child.pid));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopGroup(child.pid);
  }, timeoutMs);
  const result = await new Promise((done) => {
    child.on("error", (error) => done({ status: null, error }));
    child.on("exit", (status, signal) => done({ status, signal }));
  });
  clearTimeout(timer);
  await stopGroup(child.pid);
  return { ...result, timedOut };
}
