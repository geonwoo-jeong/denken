// The tick's test command: run as given, without a shell, and its output kept as the tick's log.
import { ROOT } from "./paths.ts";
import { START } from "./text.ts";
import type { TestRun } from "./types-tick.ts";
import { fail } from "./output.ts";
import { lastOf } from "./lists.ts";
import { runProcess } from "./processes.ts";
import { writeText } from "./files.ts";

const SUMMARY_LINES = -2,
  LAST_MAX = 160,
  SUCCESS = 0,
  SAFE_ARG = /^[\w@%+=:,./-]+$/u,
  SUMMARY = /\b(?:pass(?:ed|es)?|fail(?:ed|ures?)?|tests?)\b/iu,
  // The command as a shell would read it, for the log and the record.
  shellText = (argv: readonly string[]): string =>
    argv
      .map((arg) => {
        if (SAFE_ARG.test(arg)) {
          return arg;
        }
        return `'${arg.replaceAll("'", String.raw`'\''`)}'`;
      })
      .join(" "),
  // The test runner's pass/fail summary (e.g. "ℹ pass 10 / ℹ fail 0"), else the last line of its output.
  lastLineOf = (stdout: string, stderr: string): string => {
    const out = (stdout.trim() || stderr.trim()).split("\n").filter(Boolean),
      summary = out.filter((line) => SUMMARY.test(line)).slice(SUMMARY_LINES).join(" / ");
    return (summary || (lastOf(out) ?? "")).slice(START, LAST_MAX);
  },
  runTest = async (argv: readonly string[], logFile: string): Promise<TestRun> => {
    const [program = "", ...rest] = argv,
      result = await runProcess(program, rest, { cwd: ROOT });
    if (result.missing) {
      fail(`command not found: ${program}. Pass the command and its arguments as separate words after --, not as one quoted string; write sh -c '...' explicitly if you need a shell.`);
    }
    await writeText(logFile, `$ ${shellText(argv)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n[exit ${result.status}]\n`);
    return { lastLine: lastLineOf(result.stdout, result.stderr), log: logFile, passed: result.status === SUCCESS, status: result.status };
  };

export { runTest, shellText };
