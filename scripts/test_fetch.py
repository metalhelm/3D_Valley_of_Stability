import urllib.request
import csv
import io
import json

url = "https://www-nds.iaea.org/relnsd/v1/data?fields=ground_states"
req = urllib.request.Request(url, headers={'User-Agent': 'NuclideScape/1.0'})

print("Fetching data from IAEA...")
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        content = resp.read().decode('utf-8')
        lines = content.strip().splitlines()
        print(f"Total lines returned: {len(lines)}")
        if lines:
            reader = csv.DictReader(lines)
            fields = reader.fieldnames
            print("Fields:", fields)
            sample_rows = []
            for i, row in enumerate(reader):
                if i < 5:
                    sample_rows.append(row)
                if i == 5:
                    print("Sample row 0:", json.dumps(sample_rows[0], indent=2))
                    break
except Exception as e:
    print(f"Error fetching: {e}")
