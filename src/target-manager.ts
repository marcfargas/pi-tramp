/**
 * TargetManager — Tier 1.
 *
 * Pure state management for targets. Loads config, merges global + project,
 * tracks current target, emits events on switch.
 *
 * No I/O beyond config file reading. No transport dependencies.
 */

import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { homedir } from "os";
import { TargetsFileSchema, TargetConfigSchema, type Target, type TargetConfig, type TargetsFile } from "./types.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface TargetManagerEvents {
  target_switched: { from: string | null; to: string };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function loadConfigFile(filePath: string): Promise<TargetsFile | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const json = JSON.parse(raw);
    const result = TargetsFileSchema.safeParse(json);
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `  - ${i.path.join(".")}: ${i.message}`,
      );
      throw new Error(
        `Invalid targets config in ${filePath}:\n${issues.join("\n")}`,
      );
    }
    return result.data;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`, { cause: err });
    }
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null; // File doesn't exist — that's fine
    }
    throw err;
  }
}

function mergeConfigs(
  global: TargetsFile | null,
  project: TargetsFile | null,
): TargetsFile {
  if (!global && !project) return { targets: {} };
  if (!global) return project!;
  if (!project) return global;

  return {
    default: project.default ?? global.default,
    targets: {
      ...global.targets,
      ...project.targets,
    },
  };
}

// ---------------------------------------------------------------------------
// TargetManager
// ---------------------------------------------------------------------------

export class TargetManager extends EventEmitter {
  private targets: Map<string, Target> = new Map();
  private _currentTarget: string | null = null;
  private projectRoot: string | null;

  constructor(projectRoot?: string) {
    super();
    this.projectRoot = projectRoot ?? null;
  }

  // --- Accessors ---

  get currentTargetName(): string | null {
    return this._currentTarget;
  }

  get currentTarget(): Target | null {
    if (!this._currentTarget) return null;
    return this.targets.get(this._currentTarget) ?? null;
  }

  // --- Config loading ---

  async loadConfig(): Promise<void> {
    const globalPath = resolve(homedir(), ".pi", "targets.json");
    const projectPath = this.projectRoot
      ? resolve(this.projectRoot, ".pi", "targets.json")
      : null;

    const global = await loadConfigFile(globalPath);
    const project = projectPath ? await loadConfigFile(projectPath) : null;
    const merged = mergeConfigs(global, project);

    // Clear existing config targets (keep dynamic targets)
    for (const [name, target] of this.targets) {
      if (!target.isDynamic) {
        this.targets.delete(name);
      }
    }

    // Load merged targets
    for (const [name, config] of Object.entries(merged.targets)) {
      this.targets.set(name, {
        name,
        config,
        isDynamic: false,
      });
    }

    // Set default target if configured and not already set
    if (merged.default && merged.default !== "local" && this._currentTarget === null) {
      if (this.targets.has(merged.default)) {
        this._currentTarget = merged.default;
      }
    }
  }

  // --- CRUD ---

  getTarget(name: string): Target | undefined {
    return this.targets.get(name);
  }

  listTargets(): Target[] {
    return Array.from(this.targets.values());
  }

  createTarget(name: string, config: TargetConfig, persist = false): Target {
    if (name === "local") {
      throw new Error("'local' is a reserved target name");
    }
    if (this.targets.has(name)) {
      throw new Error(`Target '${name}' already exists`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error("Target name must be alphanumeric with dashes/underscores");
    }

    // Validate config through Zod schema
    const validated = TargetConfigSchema.parse(config);

    const target: Target = {
      name,
      config: validated,
      isDynamic: !persist,
    };
    this.targets.set(name, target);
    return target;
  }

  removeTarget(name: string): void {
    const target = this.targets.get(name);
    if (!target) {
      throw new Error(`Target '${name}' not found`);
    }
    if (this._currentTarget === name) {
      this._currentTarget = null;
    }
    this.targets.delete(name);
  }

  // --- Switching ---

  switchTarget(name: string): void {
    if (name === "local") {
      const from = this._currentTarget;
      this._currentTarget = null;
      if (from !== null) {
        this.emit("target_switched", { from, to: "local" });
      }
      return;
    }

    if (!this.targets.has(name)) {
      const available = Array.from(this.targets.keys()).join(", ");
      throw new Error(
        `Target '${name}' not found. Available targets: ${available || "(none)"}`,
      );
    }

    const from = this._currentTarget;
    this._currentTarget = name;

    if (from !== name) {
      this.emit("target_switched", { from, to: name });
    }
  }

  clearTarget(): void {
    const from = this._currentTarget;
    this._currentTarget = null;
    if (from !== null) {
      this.emit("target_switched", { from, to: "local" });
    }
  }

  // --- Typed event emitter helpers ---

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
