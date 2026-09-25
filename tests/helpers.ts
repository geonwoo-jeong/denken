// Shared setup for the DENKEN engine tests: a project with fake claude/codex CLIs on PATH, and one run in it.
import { FAKE, SCRIPTS } from "./test-paths.ts";
import type { JsonObject, Place, TestRun } from "./test-types.ts";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { envText, inherited } from "./test-env.ts";
import { REQUEST } from "./test-scenario.ts";
import path from "node:path";
import { run } from "./test-process.ts";
import { runTools } from "./test-run.ts";
import { textAt } from "./test-json.ts";
import { tmpdir } from "node:os";

const EXECUTABLE = 0o755,
  NO_CONFIG: JsonObject = {},
  placeOf = (dir: string): Place => {
    const bin = path.join(dir, "bin"),
      scenarioPath = path.join(dir, "scenario.json");
    return {
      bin,
      dir,
      env: Object.assign(inherited(), {
        DENKEN_SKIP_AUTH_CHECK: "1",
        DENKEN_WORKTREES: path.join(dir, "worktrees"),
        FAKE_SCENARIO: scenarioPath,
        PATH: `${bin}:${envText("PATH")}`,
        XDG_CONFIG_HOME: path.join(dir, "xdg"),
      }),
      proj: path.join(dir, "proj"),
      scenarioPath,
    };
  },
  // Seeds are off unless a test turns them on in its config: they add FLAMME's calls to every run.
  prepareFiles = async (place: Place, scenario: JsonObject): Promise<void> => {
    await mkdir(place.bin);
    await mkdir(place.proj);
    await chmod(FAKE, EXECUTABLE);
    await symlink(FAKE, path.join(place.bin, "claude"));
    await symlink(FAKE, path.join(place.bin, "codex"));
    await writeFile(place.scenarioPath, JSON.stringify(scenario));
    await mkdir(path.join(place.dir, "xdg", "denken"), { recursive: true });
    await writeFile(path.join(place.dir, "xdg", "denken", "config.json"), JSON.stringify({ seeds: { claude: false, codex: false } }));
  },
  initRepo = async (place: Place): Promise<void> => {
    const where = { cwd: place.proj, env: place.env };
    await run("git", ["init", "-q"], where);
    await writeFile(path.join(place.proj, "a.txt"), "a\n");
    await writeFile(path.join(place.proj, "src.txt"), "src\n");
    await run("git", ["add", "."], where);
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], where);
  },
  writeConfig = async (place: Place, config: JsonObject): Promise<void> => {
    if (config !== NO_CONFIG) {
      await mkdir(path.join(place.proj, ".denken"), { recursive: true });
      await writeFile(path.join(place.proj, ".denken", "config.json"), JSON.stringify(config));
    }
  },
  // A new run, with DENKEN's request.md written: the test starts it (or not) itself.
  newRun = async (place: Place): Promise<string> => {
    const script = path.join(SCRIPTS, "denken.ts"),
      created = await run(process.execPath, [script, "new", "test task"], { cwd: place.proj, env: place.env }),
      runPath = textAt(created.json, "run");
    await writeFile(path.join(place.proj, runPath, "request.md"), REQUEST);
    return runPath;
  },
  setup = async (scenario: JsonObject = {}, config: JsonObject = NO_CONFIG): Promise<TestRun> => {
    const dir = await mkdtemp(path.join(tmpdir(), "denken-test-")),
      place = placeOf(dir);
    await prepareFiles(place, scenario);
    await initRepo(place);
    await writeConfig(place, config);
    return runTools(place, await newRun(place));
  };

export { setup };
