// Watchdog: node presence rules + GitHub Actions dispatch for Kaggle restart.

export interface WatchdogConfig {
  ghRepo?: string;
  ghPat?: string;
  dispatchIntervalMs: number; // 20 min guard
  staleAfterMs: number; // 15 min
  onlineWindowMs: number; // 10 min expected node.online after dispatch
}

export interface KaggleStatusResult {
  running: boolean;
  raw: unknown;
}

export function defaultWatchdogConfig(env: { GH_REPO?: string; GH_PAT?: string }): WatchdogConfig {
  return {
    ghRepo: env.GH_REPO,
    ghPat: env.GH_PAT,
    dispatchIntervalMs: 20 * 60 * 1000,
    staleAfterMs: 15 * 60 * 1000,
    onlineWindowMs: 10 * 60 * 1000,
  };
}

// Dispatch = trigger the GitHub Actions workflow that pushes the Kaggle kernel.
export async function dispatchRestart(
  cfg: WatchdogConfig,
  opts: { mock?: boolean; log?: (line: string) => void } = {},
): Promise<{ ok: boolean; detail: string }> {
  const log = opts.log ?? (() => {});
  if (!cfg.ghRepo || !cfg.ghPat) {
    log("watchdog: GH_REPO/GH_PAT not configured — dispatch skipped");
    return { ok: false, detail: "gh_not_configured" };
  }
  const url = `https://api.github.com/repos/${cfg.ghRepo}/actions/workflows/restart-kaggle.yml/dispatches`;
  const body = JSON.stringify({ ref: "main" });
  if (opts.mock) {
    log(`watchdog: [MOCK] dispatch POST ${url} ref=main`);
    return { ok: true, detail: "mock_dispatch" };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.ghPat}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body,
    });
    const detail = `dispatch HTTP ${res.status}`;
    log(`watchdog: ${detail}`);
    return { ok: res.ok, detail };
  } catch (e) {
    log(`watchdog: dispatch error ${(e as Error).message}`);
    return { ok: false, detail: (e as Error).message };
  }
}

// Fallback / guard check: is a Kaggle kernel session already running?
export async function kaggleKernelStatus(
  cfg: { kaggleUser?: string; kaggleKey?: string; kernelSlug?: string },
  opts: { mock?: boolean } = {},
): Promise<KaggleStatusResult> {
  if (opts.mock || !cfg.kaggleUser || !cfg.kaggleKey) return { running: false, raw: "unconfigured" };
  try {
    const res = await fetch(`https://www.kaggle.com/api/v1/kernels/status?user_name=${cfg.kaggleUser}`, {
      headers: {
        authorization: "Basic " + btoa(`${cfg.kaggleUser}:${cfg.kaggleKey}`),
      },
    });
    const data = (await res.json()) as { status?: string }[];
    const running = (data ?? []).some(k => (k.status ?? "").toLowerCase() === "running");
    return { running, raw: data };
  } catch {
    return { running: false, raw: "error" };
  }
}
