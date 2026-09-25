// Run by git-dir.test.ts with GIT_DIR set, as a git hook would: the harness sets up a test project and says where it is.
import { setup } from "./helpers.ts";

const made = await setup();

process.stdout.write(`${JSON.stringify({ env: made.env, proj: made.proj, run: made.run })}\n`);
