// Links in a skill's body that point at files it does not have: markdown links, and `references/...` style paths.
import { access } from "node:fs/promises";
import path from "node:path";

const CODE_BLOCK = /^```[\s\S]*?^```/gmu,
  LINK = /\]\((?<target>[^)\s]+)/gu,
  BUNDLED = /`(?<target>(?:references|scripts|assets)\/[^`\s]+)`/gu,
  allGroups = (pattern: Readonly<RegExp>, text: string, name: string): readonly string[] => {
    const found: string[] = [];
    for (const match of text.matchAll(pattern)) {
      found.push((match.groups ?? {})[name] ?? "");
    }
    return found;
  },
  exists = async (file: string): Promise<boolean> => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  },
  // URLs, anchors and placeholders are not files.
  isFileTarget = (target: string): boolean => !/^[a-z]+:/iu.test(target) && !target.startsWith("#") && !/[<{*]/u.test(target),
  fileOf = (skillFile: string, target: string): string => {
    const [base = ""] = target.split("#");
    return path.join(path.dirname(skillFile), decodeURI(base));
  },
  missingLinks = async (skillFile: string, body: string): Promise<readonly string[]> => {
    const text = body.replaceAll(CODE_BLOCK, ""),
      targets = [...allGroups(LINK, text, "target"), ...allGroups(BUNDLED, text, "target")].filter((target) => isFileTarget(target)),
      present = await Promise.all(
        targets.map(async (target) => {
          const found = await exists(fileOf(skillFile, target));
          return found;
        }),
      );
    return targets.filter((_target, index) => present[index] !== true).map((target) => `links to missing file: ${target}`);
  };

export { missingLinks };
