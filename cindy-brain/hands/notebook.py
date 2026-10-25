# %% [markdown]
# # Cindy Hands — Kaggle kernel (reference deliverable)
#
# Runs ~10.5 h per cycle. The brain (Cloudflare) supervises; this notebook is
# just the container. State is restored from the previous cycle's output
# re-mounted as input.

# %% [code] 1. Restore previous state
import os, shutil, pathlib
WORK = pathlib.Path("/kaggle/working")
INPUT_STATE = pathlib.Path("/kaggle/input/cindy-state/state")
if INPUT_STATE.exists():
    (WORK / "state").mkdir(parents=True, exist_ok=True)
    for item in INPUT_STATE.rglob("*"):
        target = WORK / "state" / item.relative_to(INPUT_STATE)
        if item.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
    print("state restored")
else:
    print("first cycle — no previous state")

# %% [code] 2. Install system packages
import subprocess
def run(cmd):
    print("$", cmd)
    subprocess.run(cmd, shell=True, check=False)
run("apt-get update -qq")
run("apt-get install -y -qq openssh-server tmux xvfb x11vnc novnc fluxbox")

# %% [code] 3. Install Node 20 (skips if present)
run("command -v node >/dev/null && node -v | grep -q v2 && echo 'node ok' || "
    "(apt-get install -y -qq nodejs npm)")

# %% [code] 4. Install BrowserOS neo (amd64 .deb) and start it under Xvfb
# Replace the URL with the current BrowserOS neo release for amd64.
run("mkdir -p /opt/browseros && cd /opt/browseros && "
    "(test -f browseros.deb || apt-get install -y -qq wget && wget -q -O browseros.deb "
    "https://github.com/nicepkg/BrowserOS/releases/latest/download/BrowserOS-linux-amd64.deb) && "
    "apt-get install -y -qq ./browseros.deb || echo 'browseros install skipped'")
run("Xvfb :99 -screen 0 1280x800x24 &")
run("export DISPLAY=:99 && (fluxbox &) && "
    "browseros --no-sandbox --remote-debugging-port=9222 --user-data-dir=/kaggle/working/browser-profile &"
    " || browseros-neo --no-sandbox --remote-debugging-port=9222 &")
print("browser launched with CDP on 9222")

# %% [code] 5. Register with the brain (secrets via Kaggle Secrets)
from kaggle_secrets import UserSecretsClient
secrets = UserSecretsClient()
CINDY_URL = os.environ.get("CINDY_URL", secrets.get_secret("CINDY_URL"))
BOOTSTRAP_TOKEN = secrets.get_secret("CINDY_NODE_BOOTSTRAP_TOKEN")
os.environ["R2_S3_ACCESS_KEY_ID"] = secrets.get_secret("R2_S3_ACCESS_KEY_ID")
os.environ["R2_S3_SECRET_ACCESS_KEY"] = secrets.get_secret("R2_S3_SECRET_ACCESS_KEY")
# Write hands kit files into place (they ship as the kernel's source files).
src = pathlib.Path("/kaggle/working")  # kernel source files land in /kaggle/working
run(f"bash {src}/bootstrap.sh '{CINDY_URL}' '{BOOTSTRAP_TOKEN}'")

# %% [code] 6. Serve for ~10.5 h in 5-min chunks
import time
SERVE_SECONDS = 10.5 * 3600
slept = 0
while slept < SERVE_SECONDS:
    time.sleep(300)
    slept += 300
    print(f"cycle alive: {slept//60} min")

# %% [code] 7. Graceful end: stop services, final snapshot, exit
run("tmux kill-session -t cindy || true")
run("bash /kaggle/working/state/node/snapshot.sh || true")
print("cycle complete — version output captured")
