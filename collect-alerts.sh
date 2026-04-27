#!/bin/bash
# Collects alerts from tzevaadom API and appends new ones to a cumulative file
DATA_DIR="/var/www/topspeed-0.duckdns.org/safe-route/data"
CUMULATIVE="$DATA_DIR/alerts-cumulative.json"
TEMP="$DATA_DIR/alerts-temp.json"

# Fetch current alerts
curl -s "https://api.tzevaadom.co.il/alerts-history" -o "$TEMP" 2>/dev/null

# Initialize cumulative file if not exists
if [ ! -f "$CUMULATIVE" ]; then
  echo '[]' > "$CUMULATIVE"
fi

# Merge: add new alerts that don't already exist (by id)
python3 << 'PY'
import json, os

data_dir = "/var/www/topspeed-0.duckdns.org/safe-route/data"
cum_file = os.path.join(data_dir, "alerts-cumulative.json")
temp_file = os.path.join(data_dir, "alerts-temp.json")

try:
    with open(cum_file) as f:
        cumulative = json.load(f)
except:
    cumulative = []

try:
    with open(temp_file) as f:
        new_data = json.load(f)
except:
    new_data = []

existing_ids = {e.get('id') for e in cumulative}
added = 0
for event in new_data:
    eid = event.get('id')
    if eid and eid not in existing_ids:
        cumulative.append(event)
        existing_ids.add(eid)
        added += 1

# Sort by first alert time (newest first)
cumulative.sort(key=lambda e: max((a.get('time',0) for a in e.get('alerts',[])), default=0), reverse=True)

# Keep max 90 days of data (trim old)
import time
cutoff = time.time() - 90 * 86400
filtered = []
for e in cumulative:
    times = [a.get('time',0) for a in e.get('alerts',[])]
    if times and max(times) >= cutoff:
        filtered.append(e)

with open(cum_file, 'w') as f:
    json.dump(filtered, f, ensure_ascii=False)

print(f"Added {added} new events. Total: {len(filtered)} events.")
PY

rm -f "$TEMP"
