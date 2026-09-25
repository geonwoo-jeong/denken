// Where the engine's scripts and the fake agent CLI are. DENKEN_TEST_FAKE points the tests at another fake.
import { envText } from "./test-env.ts";
import path from "node:path";

const SCRIPTS = path.join(import.meta.dirname, "..", "skills", "denken", "scripts"),
  FAKE = envText("DENKEN_TEST_FAKE") || path.join(import.meta.dirname, "fake-cli.ts");

export { FAKE, SCRIPTS };
