// Whether a tick's evidence names a file: by its path, or by its file name when that has an extension.
import { escapeRegExp } from "./text.ts";
import path from "node:path";

const WITH_EXTENSION = /\.\w+$/u,
  nameForms = (file: string): readonly string[] => {
    const name = path.basename(file);
    if (WITH_EXTENSION.test(name)) {
      return [file, name];
    }
    return [file];
  },
  // As a whole name: "a.js" does not name "a.jsx" or "a.js.bak".
  namesFile = (evidence: string, file: string): boolean =>
    nameForms(file).some((form) => new RegExp(String.raw`(?:^|[^\w./-])${escapeRegExp(form)}(?=$|[^\w./-]|\.(?:$|\s))`, "u").test(evidence));

export { namesFile };
