import urllib.request
import csv
import io
import json
import os

url = "https://www-nds.iaea.org/relnsd/v1/data?fields=ground_states&nuclides=all"
print(f"Fetching IAEA data from {url}...")
req = urllib.request.Request(url, headers={'User-Agent': 'NuclideScape/1.0'})

with urllib.request.urlopen(req, timeout=60) as resp:
    text = resp.read().decode('utf-8', errors='replace')

reader = csv.DictReader(io.StringIO(text))

nuclides = []
for row in reader:
    try:
        z_str = row.get('z', '').strip()
        n_str = row.get('n', '').strip()
        if not z_str or not n_str:
            continue
        z = int(z_str)
        n = int(n_str)
        symbol = row.get('symbol', '').strip()
        mass = z + n
        
        # Binding energy per nucleon (IAEA provides this in keV)
        binding_str = row.get('binding', '').strip()
        binding_kev = float(binding_str) if binding_str else 0.0
        binding_mev = binding_kev / 1000.0  # convert keV -> MeV
        
        # Mass excess (keV -> MeV)
        me_str = row.get('massexcess', '').strip()
        mass_excess_mev = (float(me_str) / 1000.0) if me_str else 0.0
        
        # Half life
        hl_str = row.get('half_life', '').strip()
        is_stable = (hl_str.upper() == 'STABLE')
        hl_sec_str = row.get('half_life_sec', '').strip()
        half_life_sec = None
        if hl_sec_str:
            try:
                half_life_sec = float(hl_sec_str)
            except ValueError:
                pass

        # Fixed half life (seconds): 10 billion years for stable, prompt limit (1e-22 s) for unbound/unknown
        TEN_BILLION_YEARS_SEC = 10 * 1e9 * 365.25 * 86400  # 3.15576e17 s
        MIN_HALF_LIFE_SEC = 1e-22
        if is_stable or hl_str.upper() == 'STABLE':
            fixed_half_life_sec = TEN_BILLION_YEARS_SEC
        elif half_life_sec is not None and half_life_sec > 0:
            fixed_half_life_sec = min(TEN_BILLION_YEARS_SEC, max(MIN_HALF_LIFE_SEC, half_life_sec))
        else:
            fixed_half_life_sec = MIN_HALF_LIFE_SEC

        # Exclude nuclides with Z > 20 and no / zero binding energy (unmeasured ground states that clutter up the 3D model)
        if z > 20 and binding_mev <= 0.0001:
            continue
        
        # Decay modes
        decay_modes = []
        for i in (1, 2, 3):
            d_mode = row.get(f'decay_{i}', '').strip()
            d_pct_str = row.get(f'decay_{i}_%', '').strip()
            if d_mode:
                fraction = 1.0
                if d_pct_str:
                    try:
                        fraction = float(d_pct_str) / 100.0
                    except ValueError:
                        pass
                decay_modes.append({
                    "mode": d_mode,
                    "fraction": fraction
                })
        
        nuclides.append({
            "id": f"{symbol}-{mass}",
            "Z": z,
            "N": n,
            "symbol": symbol,
            "mass": mass,
            "is_stable": is_stable,
            "half_life": hl_str,
            "half_life_sec": half_life_sec,
            "fixed_half_life_sec": fixed_half_life_sec,
            "binding_kev": binding_kev,
            "binding_mev": binding_mev,
            "mass_excess_mev": mass_excess_mev,
            "decay_modes": decay_modes
        })
    except Exception as e:
        print(f"Error parsing row: {e}")
        continue

print(f"Parsed {len(nuclides)} nuclides successfully.")

# Stats
max_n = max(n['N'] for n in nuclides)
max_z = max(n['Z'] for n in nuclides)
max_b = max(n['binding_mev'] for n in nuclides)
min_b = min(n['binding_mev'] for n in nuclides)
print(f"Range: N=[0, {max_n}], Z=[0, {max_z}], Binding energy=[{min_b:.2f}, {max_b:.2f}] MeV")

# Save to public/data/nuclides.json
out_dir = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')
os.makedirs(out_dir, exist_ok=True)
out_file = os.path.join(out_dir, 'nuclides.json')
with open(out_file, 'w', encoding='utf-8') as f:
    json.dump(nuclides, f, separators=(',', ':'))

print(f"Saved {os.path.getsize(out_file)} bytes to {out_file}")
