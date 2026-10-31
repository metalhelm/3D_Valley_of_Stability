import urllib.request

urls = [
    "https://www-nds.iaea.org/relnsd/v1/data?fields=ground_states&nuclides=all",
    "https://www-nds.iaea.org/relnsd/v1/data?fields=all",
    "https://www-nds.iaea.org/relnsd/v1/data?fields=decay_rads",
    "https://www-nds.iaea.org/relnsd/v1/data?fields=ground_states&z_range=1:10",
    "https://www-nds.iaea.org/relnsd/v1/data?fields=levels&nuclides=1H",
    "https://www-nds.iaea.org/relnsd/v1/data?fields=ground_states&nuclide=all",
]

for u in urls:
    try:
        req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = r.read()
            print(f"URL: {u}\nStatus: {r.status}, Length: {len(data)}, Snippet: {data[:100]}\n")
    except Exception as e:
        print(f"URL: {u} Error: {e}\n")
