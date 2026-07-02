import { readFileSync } from "node:fs";

export function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---[ \t]*(?:\r?\n)[\s\S]*?(?:\r?\n)---[ \t]*(?:\r?\n|$)/);
  if (!match) return markdown;
  return markdown.slice(match[0].length);
}

export function assembleSystemPrompt(agentPath: string, skillPaths: string[]): string {
  const agentBody = stripFrontmatter(readFileSync(agentPath, "utf8"));
  const skills = skillPaths.map((path) => {
    const body = stripFrontmatter(readFileSync(path, "utf8"));
    return `\n\n===== SKILL (inlined for eval): ${path} =====\n${body}`;
  });
  return agentBody + skills.join("");
}
