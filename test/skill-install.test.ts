import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { deliveryValue, installSkills, resolveSkill } from "../src/engine/skill-install";

function makeSkillDir(root: string, dirName: string, frontmatterName?: string): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const frontmatter = frontmatterName ? `---\nname: ${frontmatterName}\ndescription: test skill\n---\n` : "";
  writeFileSync(join(dir, "SKILL.md"), `${frontmatter}# Body\n`, "utf8");
  return dir;
}

test("resolveSkill accepts a directory or its SKILL.md and prefers the frontmatter name", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-install-test-"));
  try {
    const dir = makeSkillDir(root, "some-dir", "cortex");
    expect(resolveSkill(dir)).toEqual({ dir, name: "cortex" });
    expect(resolveSkill(join(dir, "SKILL.md"))).toEqual({ dir, name: "cortex" });

    const unnamed = makeSkillDir(root, "fallback-name");
    expect(resolveSkill(unnamed).name).toBe("fallback-name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSkill rejects directories without SKILL.md", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-install-test-"));
  try {
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(() => resolveSkill(empty)).toThrow(/no SKILL.md/);
    expect(() => resolveSkill(join(root, "missing"))).toThrow(/does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkills copies the skill dir into the sandbox registry with frontmatter intact", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-install-test-"));
  try {
    const skillDir = makeSkillDir(root, "src-skill", "cortex");
    writeFileSync(join(skillDir, "extra.md"), "supporting file", "utf8");
    const sandbox = join(root, "sandbox");
    mkdirSync(sandbox);

    const result = installSkills([skillDir], sandbox, join(root, "no-user-skills"));

    const installedFile = join(sandbox, ".claude", "skills", "cortex", "SKILL.md");
    expect(existsSync(installedFile)).toBe(true);
    expect(readFileSync(installedFile, "utf8")).toStartWith("---\nname: cortex");
    expect(existsSync(join(sandbox, ".claude", "skills", "cortex", "extra.md"))).toBe(true);
    expect(result.installed).toEqual([{ dir: skillDir, name: "cortex" }]);
    expect(result.warnings).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkills warns on user-level skill name collisions and rejects duplicates in one arm", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-install-test-"));
  try {
    const skillDir = makeSkillDir(root, "variant-a", "cortex");
    const duplicate = makeSkillDir(root, "variant-b", "cortex");
    const userSkills = join(root, "user-skills");
    mkdirSync(join(userSkills, "cortex"), { recursive: true });
    const sandbox = join(root, "sandbox");
    mkdirSync(sandbox);

    const result = installSkills([skillDir], sandbox, userSkills);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('user-level skill "cortex"');

    expect(() => installSkills([skillDir, duplicate], join(root, "sandbox2"), userSkills)).toThrow(
      /duplicate skill name/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deliveryValue validates the delivery axis", () => {
  expect(deliveryValue(undefined, "inline")).toBe("inline");
  expect(deliveryValue("install", "inline")).toBe("install");
  expect(() => deliveryValue("registry", "inline")).toThrow(/delivery/);
});
