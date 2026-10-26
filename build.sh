#!/bin/sh
# Pack the plugin into dist/ip-quality.zip (upload it in Komari's admin Plugins page).
# The version is YY.MMDD.N; it is bumped on every build.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
node --test tests/ >/dev/null
python3 - <<'PY'
import json, os
from datetime import datetime
p = os.path.join("plugin", "komari-plugin.json")
m = json.load(open(p, encoding="utf-8"))
pre = datetime.now().strftime("%y.%m%d.")
cur = str(m.get("version", ""))
m["version"] = pre + (str(int(cur[len(pre):]) + 1) if cur.startswith(pre) and cur[len(pre):].isdigit() else "1")
json.dump(m, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
print("version", cur, "->", m["version"])
PY
mkdir -p dist
rm -f dist/ip-quality.zip
(cd plugin && zip -qr ../dist/ip-quality.zip komari-plugin.json script.js lib -x "*.DS_Store")
echo "built $ROOT/dist/ip-quality.zip"
