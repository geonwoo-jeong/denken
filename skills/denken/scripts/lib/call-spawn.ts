// The _exec process that runs a call: detached, so it outlives the engine command that launched it.
import { ROOT, SCRIPT, callBase } from "./paths.ts";
import { spawn } from "node:child_process";
import { writeText } from "./files.ts";

const spawnExec = async (runDir: string, id: string): Promise<void> => {
  const child = spawn(process.execPath, [SCRIPT, "_exec", runDir, id], { cwd: ROOT, detached: true, stdio: "ignore" });
  await writeText(`${callBase(runDir, id)}.pid`, String(child.pid ?? ""));
  child.unref();
};

export { spawnExec };
