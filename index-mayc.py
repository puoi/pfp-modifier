"""Reconstruit data/mayc/<k>.json : numéro MAYC -> CID IPFS de son image (par tranches de 1000 numéros).

Les métadonnées MAYC ne sont servies que par l'API de boredapeyachtclub.com, protégée par Cloudflare : un navigateur
peut s'y faire refuser. On lit donc une fois toute la collection via l'API NFT d'Alchemy (clé publique de
démonstration « demo », pas un secret) et l'app n'a plus besoin que d'IPFS.

Usage : python index-mayc.py
"""
import json, os, re, time, urllib.parse, urllib.request

CONTRACT = '0x60E4d786628Fea6478F785A6d7e704777c86a7c6'
API = 'https://eth-mainnet.g.alchemy.com/nft/v3/demo/getNFTsForContract'
CHUNK = 1000

def get(params):
    url = API + '?' + urllib.parse.urlencode(params)
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'pfp-modifier-index', 'Accept': 'application/json'})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except Exception as err:  # limite de débit de la clé de démo : on attend et on recommence
            print('  nouvel essai :', err)
            time.sleep(3 * (attempt + 1))
    raise SystemExit('Alchemy ne répond pas')

images, missing, page = {}, [], None
while True:
    params = {'contractAddress': CONTRACT, 'withMetadata': 'true', 'limit': 100}
    if page:
        params['pageKey'] = page
    data = get(params)
    for nft in data.get('nfts', []):
        n = int(nft['tokenId'])
        img = ((nft.get('raw') or {}).get('metadata') or {}).get('image') or ''
        m = re.search(r'(?:ipfs://|/ipfs/)(?:ipfs/)?([A-Za-z0-9]{46,})', img)
        if m:
            images[n] = m.group(1)
        else:
            missing.append(n)
    page = data.get('pageKey')
    print(f'{len(images)} images', end='\r')
    if not page:
        break
    time.sleep(0.25)

root = os.path.dirname(os.path.abspath(__file__))
out_dir = os.path.join(root, 'data', 'mayc')
os.makedirs(out_dir, exist_ok=True)
chunks = {}
for n, cid in images.items():
    chunks.setdefault(n // CHUNK, {})[str(n)] = cid
for k, part in chunks.items():
    with open(os.path.join(out_dir, f'{k}.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(dict(sorted(part.items(), key=lambda x: int(x[0]))), f, separators=(',', ':'))
        f.write('\n')
print(f'\n{len(images)} MAYC indexés en {len(chunks)} fichiers' + (f' ; sans image IPFS : {missing[:20]}' if missing else ''))
