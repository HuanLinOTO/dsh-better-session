import type { Dirent } from "node:fs";
import { access, cp, glob, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DSH_PACKAGE = "@deepseek-ai/dsh";

export interface OfficialPackage {
  readonly dir: string;
  readonly version: string;
}

export interface OfficialResolutionInput {
  readonly workspace: string;

  readonly workspaceRoot: string;

  readonly toolRoot: string;

  readonly dshVersion?: string;

  readonly closureModulesDir?: string;
}

interface PackageManifest {
  readonly version?: unknown;
  readonly files?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(dir: string): Promise<PackageManifest> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return {};
  }
}

// The tool's own dependency on the desktop host variant (`import.meta.resolve` runs from this
// module, so it can only reach the tool's own dependency). Returns the payload directory and its
// manifest version, or `undefined` before the variant is built.

// Install the tool's host payload into a closure, replacing any payload already there. Returns the
// installed payload directory.

function isPackagePayload(path: string, root: string): boolean {
  const relativePath = path.slice(root.length).replace(/^[\\/]+/u, "");
  return relativePath === "" || !relativePath.split(/[\\/]/u).includes("node_modules");
}

async function expandPackageFiles(dir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const match of glob(pattern, { cwd: dir })) matches.push(match);
  if (matches.length > 0) return matches;

  return (await pathExists(join(dir, pattern))) ? [pattern] : [];
}

async function packagePayload(dir: string): Promise<string[] | undefined> {
  const files = (await readManifest(dir)).files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const included = new Set<string>(["package.json"]);
  const excluded = new Set<string>();
  for (const value of files) {
    if (typeof value !== "string" || value === "") continue;
    const negated = value.startsWith("!");
    for (const match of await expandPackageFiles(dir, negated ? value.slice(1) : value)) {
      if (negated) excluded.add(match);
      else included.add(match);
    }
  }
  return [...included].filter((entry) => !excluded.has(entry)).sort();
}

function isInstalledPackage(dir: string): boolean {
  return dir.split(/[\\/]/u).includes("node_modules");
}

export async function copyPackageTree(source: string, target: string): Promise<void> {
  const payload = isInstalledPackage(source) ? undefined : await packagePayload(source);
  const copy = async (from: string, to: string): Promise<void> => {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, {
      recursive: true,
      dereference: true,
      filter: (entry) => isPackagePayload(entry, source),
    });
  };
  if (payload === undefined) {
    await copy(source, target);
    return;
  }
  for (const entry of payload) {
    const from = join(source, ...entry.split("/"));
    if (await pathExists(from)) await copy(from, join(target, ...entry.split("/")));
  }
}

export async function closurePackageDirs(modulesDir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const add = async (name: string, dir: string): Promise<void> => {
    if (found.has(name)) return;
    try {
      found.set(name, await realpath(dir));
    } catch {
      found.set(name, dir);
    }
  };
  const collect = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        let scoped: Dirent[];
        try {
          scoped = await readdir(path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of scoped) {
          if (!child.name.startsWith("."))
            await add(`${entry.name}/${child.name}`, join(path, child.name));
        }
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) await add(entry.name, path);
    }
  };
  await collect(modulesDir);
  const virtual = join(modulesDir, ".pnpm");
  if (await pathExists(virtual)) {
    for (const entry of await readdir(virtual, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const layer = join(virtual, entry.name, "node_modules");
      if (await pathExists(layer)) await collect(layer);
    }
  }
  return found;
}

export async function missingOfficialPackages(modulesDir: string): Promise<Map<string, string[]>> {
  const dirs = await closurePackageDirs(modulesDir);
  const present = new Set(dirs.keys());
  const missing = new Map<string, string[]>();
  for (const [name, dir] of dirs) {
    if (!name.startsWith("@deepseek-ai/")) continue;
    const manifest = await readManifest(dir);
    for (const field of ["dependencies", "peerDependencies"] as const) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (!dependency.startsWith("@deepseek-ai/") || present.has(dependency)) continue;
        if (
          field === "peerDependencies" &&
          manifest.peerDependenciesMeta?.[dependency]?.optional === true
        )
          continue;
        const requiredBy = missing.get(dependency) ?? [];
        if (!requiredBy.includes(name)) requiredBy.push(name);
        missing.set(dependency, requiredBy);
      }
    }
  }
  return missing;
}
