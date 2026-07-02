export class CliError extends Error {
  readonly exitCode = 2;
}

export type FlagSpec = {
  arity: "none" | "one";
  repeat?: boolean;
};

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  one(name: string): string | undefined;
  many(name: string): string[];
  has(name: string): boolean;
  number(name: string, defaultValue: number): number;
}

export function parseArgs(argv: string[], specs: FlagSpecs): ParsedArgs {
  const out: Record<string, string[]> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") || token === "--") {
      throw new CliError(`unexpected positional argument: ${token}`);
    }

    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    const spec = specs[name];
    if (!spec) {
      throw new CliError(`unknown flag: --${name}`);
    }

    if (!spec.repeat && out[name]?.length) {
      throw new CliError(`flag cannot be repeated: --${name}`);
    }

    if (spec.arity === "none") {
      if (inlineValue !== undefined) {
        throw new CliError(`flag does not take a value: --${name}`);
      }
      out[name] ??= [];
      out[name].push("true");
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      i += 1;
      value = argv[i];
    }
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`missing value for --${name}`);
    }

    out[name] ??= [];
    out[name].push(value);
  }

  return {
    one(name: string) {
      return out[name]?.[0];
    },
    many(name: string) {
      return out[name] ?? [];
    },
    has(name: string) {
      return Object.hasOwn(out, name);
    },
    number(name: string, defaultValue: number) {
      const raw = out[name]?.[0];
      if (raw === undefined) return defaultValue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new CliError(`--${name} must be a number`);
      }
      return parsed;
    },
  };
}
