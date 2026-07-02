import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export interface SandboxSpec {
  root: string;
  seed?: string;
  prefix: string;
  keep: boolean;
}

export interface PreparedSandbox {
  dir: string;
  cleanup(): void;
}

export function prepareSandbox(spec: SandboxSpec): PreparedSandbox {
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  assertSeedIsUsable(spec.seed, root);

  const dir = createUniqueDir(root, spec.prefix);
  if (spec.seed) {
    copyDirectoryContents(resolve(spec.seed), dir);
  }

  return {
    dir,
    cleanup() {
      if (!spec.keep) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function createUniqueDir(root: string, prefix: string): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60) || "run";
  let attempt = 0;
  while (attempt < 1_000) {
    const suffix = `${Date.now()}-${process.pid}-${attempt}`;
    const dir = join(root, `${safePrefix}-${suffix}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if (isAlreadyExists(error)) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error(`could not create unique sandbox in ${root}`);
}

function assertSeedIsUsable(seed: string | undefined, root: string): void {
  if (!seed) return;
  const resolvedSeed = resolve(seed);
  if (!existsSync(resolvedSeed)) {
    throw new Error(`sandbox seed does not exist: ${seed}`);
  }
  if (!statSync(resolvedSeed).isDirectory()) {
    throw new Error(`sandbox seed must be a directory: ${seed}`);
  }

  const realSeed = realpathSync(resolvedSeed);
  const realRoot = realpathSync(root);
  if (realRoot === realSeed || realRoot.startsWith(realSeed + sep)) {
    throw new Error(`sandbox root must not be inside the seed directory: ${root}`);
  }
}

function copyDirectoryContents(seed: string, destination: string): void {
  for (const entry of readdirSync(seed)) {
    cpSync(join(seed, entry), join(destination, basename(entry)), {
      recursive: true,
      errorOnExist: false,
    });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}
