import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureLocalServer,
  localPort,
  type LocalServerDriver,
} from './local-server.js';

/** The package root, which ships `serve/laya_serve.py` (from `src/` or `dist/`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const HEALTH_TIMEOUT_MS = 2_000;

/** A driver over Node: `fetch` for health, `sh` for the detached start. */
export function nodeDriver(fetcher: typeof fetch = fetch): LocalServerDriver {
  return {
    async health(url) {
      try {
        const response = await fetcher(`${url}/health`, {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    spawn(argv) {
      return new Promise((resolve) => {
        execFile(argv[0]!, argv.slice(1), (error, _stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({ exitCode: code, stderr: String(stderr) });
        });
      });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export interface LocalServerOptions {
  /** Defaults to `LAYA_LOCAL_PORT`, else 8765. */
  localPort?: number;
  /** Fine-tuned checkpoint served instead of `multilingual`. Defaults to `LAYA_MODEL_DIR`. */
  modelDir?: string;
  /** Replaces the Node driver, for tests. */
  driver?: LocalServerDriver;
}

/** Starts the shared local laya-serve when needed; resolves with its base URL. */
export function startLocalServer(options: LocalServerOptions = {}): Promise<string> {
  return ensureLocalServer(options.driver ?? nodeDriver(), {
    root: PACKAGE_ROOT,
    port: localPort(options.localPort ?? process.env.LAYA_LOCAL_PORT),
    checkpoint: options.modelDir ?? (process.env.LAYA_MODEL_DIR || undefined),
  });
}
