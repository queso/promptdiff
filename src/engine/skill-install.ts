import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type Delivery = "inline" | "install";

export interface ResolvedSkill {
  /** Directory that contains SKILL.md (and any supporting files). */
  dir: string;
  /** Registry name: frontmatter `name:` if present, else the directory basename. */
  name: string;
}

export interface InstallResult {
  installed: ResolvedSkill[];
  warnings: string[];
}

/**
 * Accepts either a skill directory or a path to its SKILL.md and returns the
 * directory plus the name Claude Code will register it under.
 */
export function resolveSkill(path: string): ResolvedSkill {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`skill path does not exist: ${path}`);
  }

  const dir = statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  const skillFile = join(dir, "SKILL.md");
  if (!existsSync(skillFile)) {
    throw new Error(`skill directory has no SKILL.md: ${dir}`);
  }

  return { dir, name: skillNameFrom(skillFile) ?? basename(dir) };
}

/**
 * Copies skill directories into the sandbox's project skills path
 * (<sandbox>/.claude/skills/<name>) with frontmatter intact, so headless Claude
 * discovers them through the normal registry instead of inlined prompt text.
 */
export function installSkills(
  skillPaths: string[],
  sandboxDir: string,
  userSkillsDir = defaultUserSkillsDir(),
): InstallResult {
  const installed: ResolvedSkill[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const path of skillPaths) {
    const skill = resolveSkill(path);
    if (seen.has(skill.name)) {
      throw new Error(`duplicate skill name in one arm: ${skill.name}`);
    }
    seen.add(skill.name);

    const destination = join(sandboxDir, ".claude", "skills", skill.name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(skill.dir, destination, { recursive: true });
    installed.push(skill);

    // A user-level skill with the same name loads in every run of every arm,
    // contaminating the comparison. Detection only; unlinking is the operator's call.
    if (existsSync(join(userSkillsDir, skill.name))) {
      warnings.push(
        `user-level skill "${skill.name}" exists at ${join(userSkillsDir, skill.name)} and will also load in both arms — remove or rename it for a clean comparison`,
      );
    }
  }

  return { installed, warnings };
}

export function deliveryValue(value: unknown, fallback: Delivery): Delivery {
  if (value === undefined) return fallback;
  if (value === "inline" || value === "install") return value;
  throw new Error(`delivery must be "inline" or "install"`);
}

function skillNameFrom(skillFile: string): string | undefined {
  const content = readFileSync(skillFile, "utf8");
  const frontmatter = content.match(/^---[ \t]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---/);
  if (!frontmatter) return undefined;
  const name = frontmatter[1].match(/^name:\s*["']?([A-Za-z0-9][A-Za-z0-9_-]*)["']?\s*$/m);
  return name?.[1];
}

function defaultUserSkillsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "skills");
}
