import urllib.request

url = "https://www-nds.iaea.org/relnsd/v1/data?fields=ground_states"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

with urllib.request.urlopen(req, timeout=30) as resp:
    data = resp.read()
    print("Length in bytes:", len(data))
    print("First 300 bytes:", data[:300])
