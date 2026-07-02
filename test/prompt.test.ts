import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { assembleSystemPrompt, stripFrontmatter } from "../src/prompt";

test("stripFrontmatter removes leading YAML frontmatter only", () => {
  expect(stripFrontmatter("---\nname: x\n---\nBody")).toBe("Body");
  expect(stripFrontmatter("---\nname: x\n---")).toBe("");
  expect(stripFrontmatter("Text\n---\nnot frontmatter")).toBe("Text\n---\nnot frontmatter");
});

test("assembleSystemPrompt inlines stripped skills", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-eval-prompt-test-"));
  try {
    const agent = join(dir, "agent.md");
    const skill = join(dir, "SKILL.md");
    writeFileSync(agent, "---\nname: agent\n---\nAgent body", "utf8");
    writeFileSync(skill, "---\nname: skill\n---\nSkill body", "utf8");

    const prompt = assembleSystemPrompt(agent, [skill]);
    expect(prompt).toContain("Agent body");
    expect(prompt).toContain("===== SKILL (inlined for eval):");
    expect(prompt).toContain("Skill body");
    expect(prompt).not.toContain("name: agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
