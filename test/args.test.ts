import { expect, test } from "bun:test";
import { CliError, parseArgs } from "../src/args";

const specs = {
  prompt: { arity: "one" as const },
  skill: { arity: "one" as const, repeat: true },
  tools: { arity: "one" as const },
  keep: { arity: "none" as const },
};

test("parseArgs parses repeated, empty, and boolean flags", () => {
  const args = parseArgs(["--prompt=hello", "--skill", "a.md", "--skill", "b.md", "--tools", "", "--keep"], specs);

  expect(args.one("prompt")).toBe("hello");
  expect(args.many("skill")).toEqual(["a.md", "b.md"]);
  expect(args.one("tools")).toBe("");
  expect(args.has("keep")).toBe(true);
});

test("parseArgs rejects unknown and missing flags", () => {
  expect(() => parseArgs(["--wat"], specs)).toThrow(CliError);
  expect(() => parseArgs(["--prompt"], specs)).toThrow(CliError);
});
