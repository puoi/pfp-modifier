"""Reconstruit data/smb2.json : numéro SMB Gen2 -> identifiant Arweave de son image.

Sans index, l'app devrait lire pour chaque singe le fichier de métadonnées (via le manifeste Arweave de la
collection) puis l'image : deux requêtes vers arweave.net, parfois très lent. Avec l'index : une seule.
Les images Gen2 ne changent plus (métadonnées figées sur Arweave), l'index n'a pas besoin d'être refait.

Usage : python index-smb2.py
"""
import concurrent.futures, datetime, json, os, re, time, urllib.request

MANIFEST = 'w4RVczdWwyiWS8tXgDenLEL7iFDdu4bi2YVmGyQo_dE'
GW = 'https://arweave.net/'
root = os.path.dirname(os.path.abspath(__file__))
out_path = os.path.join(root, 'data', 'smb2.json')

def get(url, tries=8):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'pfp-modifier-index'})
            return urllib.request.urlopen(req, timeout=40).read()
        except Exception:
            time.sleep(2 + attempt * 2)
    raise RuntimeError('échec : ' + url)

paths = json.loads(get(GW + 'raw/' + MANIFEST))['paths']
meta_ids = {int(p[:-5]): v['id'] for p, v in paths.items() if re.fullmatch(r'\d+\.json', p)}
# reprise : garde ce qui a déjà été trouvé
images = {}
if os.path.exists(out_path):
    images = {int(k): v for k, v in json.load(open(out_path, encoding='utf-8'))['image'].items()}
todo = [n for n in sorted(meta_ids) if n not in images]
print(f'{len(meta_ids)} singes, {len(todo)} à lire')

def one(n):
    data = json.loads(get(GW + meta_ids[n]))
    m = re.search(r'arweave\.net/([A-Za-z0-9_-]{43})', data.get('image', ''))
    return n, m.group(1) if m else None

def save():
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'updated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                   'base': GW, 'count': len(images),
                   'image': {str(k): images[k] for k in sorted(images)}}, f, separators=(',', ':'))
        f.write('\n')

done = 0
with concurrent.futures.ThreadPoolExecutor(8) as pool:
    for fut in concurrent.futures.as_completed([pool.submit(one, n) for n in todo]):
        try:
            n, img = fut.result()
            if img:
                images[n] = img
        except Exception as err:
            print(err)
        done += 1
        if done % 250 == 0:
            save()
            print(f'{done}/{len(todo)}', flush=True)
save()
print(f'{len(images)} SMB Gen2 indexés')
