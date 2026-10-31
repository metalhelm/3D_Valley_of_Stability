import urllib.request
import csv
import io

url = "https://www-nds.iaea.org/relnsd/v1/data?fields=ground_states&nuclides=all"
req = urllib.request.Request(url, headers={'User-Agent': 'NuclideScape/1.0'})

with urllib.request.urlopen(req, timeout=30) as resp:
    text = resp.read().decode('utf-8', errors='replace')
    reader = csv.DictReader(io.StringIO(text))
    print("Fieldnames:", reader.fieldnames)
    rows = list(reader)
    print(f"Total rows: {len(rows)}")
    for r in rows[:3]:
        print("\nRow:", {k: v for k, v in r.items() if v})
    # Check Fe-56, U-238, H-1
    for r in rows:
        sym = r.get('symbol', '').strip()
        z = r.get('z', '').strip()
        n = r.get('n', '').strip()
        if (z == '26' and n == '30') or (z == '92' and n == '146') or (z == '1' and n == '0'):
            print(f"\nTarget isotope (Z={z}, N={n}, Symbol={sym}):")
            print({k: v for k, v in r.items() if v})
