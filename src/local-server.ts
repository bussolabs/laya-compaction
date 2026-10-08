// Local mode: one shared laya-serve on 127.0.0.1, started on demand and left
// running. Nothing here imports Node, so the Claude Code hook (which has no
// Node runtime) and the library share it; each brings its own driver.

/** Port of the local server when `LAYA_LOCAL_PORT` is unset. */
export const LOCAL_DEFAULT_PORT = 8765;

/** Checkpoint every local request asks for (a fine-tune replaces it via `LAYA_MODEL_DIR`). */
export const LOCAL_MODEL = 'multilingual';

/** The pinned server package `uv tool run` installs. */
export const LAYA_SERVE_SPEC = 'laya[serve]==0.4.0';

/** The first start installs Python packages and downloads the checkpoint. */
export const LOCAL_STARTUP_TIMEOUT_MS = 600_000;

const POLL_MS = 1_000;

/** Exit status of the spawn script when `uv` is not installed. */
export const UV_MISSING_EXIT = 127;

export const UV_MISSING_MESSAGE =
  'uv is not installed: Laya local mode starts laya-serve with `uv tool run` (https://docs.astral.sh/uv/); install uv or set LAYA_URL';

export function localPort(value: string | number | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : LOCAL_DEFAULT_PORT;
}

export function localBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The `sh` script that starts the server detached, run as
 * `sh -c <script> sh <root> <port> [<checkpoint dir>]` where `<root>` holds
 * `serve/laya_serve.py` (or is the `.claude-plugin` folder next to it).
 * It returns at once: the server outlives the caller and logs to
 * `~/.cache/laya-local/serve.log`. A lock file (stale after a minute) and a
 * process check keep concurrent callers from starting two servers.
 */
export const SPAWN_SCRIPT = `set -u
root=$1; port=$2; checkpoint=\${3:-}
command -v uv >/dev/null 2>&1 || { echo "uv not found" >&2; exit ${UV_MISSING_EXIT}; }
launcher=
for candidate in "$root/serve/laya_serve.py" "$root/../serve/laya_serve.py"; do
  if [ -f "$candidate" ]; then launcher=$candidate; break; fi
done
[ -n "$launcher" ] || { echo "serve/laya_serve.py not found under $root" >&2; exit 2; }
dir="$HOME/.cache/laya-local"
mkdir -p "$dir"
lock="$dir/spawn.lock"
if [ -e "$lock" ] && [ -n "$(find "$lock" -mmin +1 2>/dev/null)" ]; then rm -f "$lock"; fi
if pgrep -f "laya_serve.py $port" >/dev/null 2>&1; then exit 0; fi
( set -C; : > "$lock" ) 2>/dev/null || exit 0
env LAYA_HOST=127.0.0.1 LAYA_PORT="$port" LAYA_DEFAULT_MODEL=${LOCAL_MODEL} LAYA_IDLE_UNLOAD_SECONDS=900 \${checkpoint:+"LAYA_CHECKPOINT=$checkpoint"} \\
  nohup uv tool run --python 3.12 --from "${LAYA_SERVE_SPEC}" python "$launcher" "$port" >> "$dir/serve.log" 2>&1 < /dev/null &
exit 0
`;

export function spawnArgv(root: string, port: number, checkpoint?: string): string[] {
  return ['sh', '-c', SPAWN_SCRIPT, 'sh', root, String(port), ...(checkpoint ? [checkpoint] : [])];
}

/** What starting and waiting for the server needs from its host. */
export interface LocalServerDriver {
  /** True when `GET <url>/health` answers 2xx; false when nothing answers. */
  health(url: string): Promise<boolean>;
  /** Runs the spawn script; resolves with its exit status and stderr. */
  spawn(argv: readonly string[]): Promise<{ exitCode: number; stderr: string }>;
  sleep(ms: number): Promise<void>;
  now(): Promise<number> | number;
}

/**
 * Makes sure the local server answers on `port`, starting it when it does
 * not and waiting until it is healthy. Returns its base URL; throws when uv is
 * missing, the start fails or the server stays down past the timeout.
 */
export async function ensureLocalServer(
  driver: LocalServerDriver,
  options: { root: string; port: number; checkpoint?: string; timeoutMs?: number; pollMs?: number },
): Promise<string> {
  const url = localBaseUrl(options.port);
  if (await driver.health(url)) return url;
  const started = await driver.spawn(spawnArgv(options.root, options.port, options.checkpoint));
  if (started.exitCode === UV_MISSING_EXIT) throw new Error(UV_MISSING_MESSAGE);
  if (started.exitCode !== 0) {
    throw new Error(`could not start laya-serve (${started.exitCode}): ${started.stderr.trim().slice(0, 200)}`);
  }
  const deadline = (await driver.now()) + (options.timeoutMs ?? LOCAL_STARTUP_TIMEOUT_MS);
  while ((await driver.now()) < deadline) {
    await driver.sleep(options.pollMs ?? POLL_MS);
    if (await driver.health(url)) return url;
  }
  throw new Error(
    `laya-serve did not answer on ${url} in time; see ~/.cache/laya-local/serve.log`,
  );
}
