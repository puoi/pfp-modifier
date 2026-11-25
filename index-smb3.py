"""Reconstruit data/smb3.json : numéro SMB Gen3 -> adresse de ses métadonnées.

Les SMB Gen3 (Solana) n'ont pas d'adresse d'image prévisible à partir du numéro : chaque NFT a son propre
fichier de métadonnées sur Irys/Arweave. On lit donc une fois les comptes de métadonnées Metaplex de la collection
(autorité de mise à jour MonkeDAO Gen3) via le RPC public de Solana, et on garde « numéro -> identifiant Irys ».
L'app lit ensuite ce fichier, puis les métadonnées, puis l'image.

À relancer de temps en temps (nouveaux tonneaux ouverts) : python index-smb3.py
"""
import base64, datetime, json, os, re, struct, urllib.request

RPC = 'https://api.mainnet-beta.solana.com'
METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
GEN3_AUTHORITY = 'GfELr1GA9bLmgiMymUm7h8nDkZLG2Ls6txSsANopeVEW'
IRYS = 'https://gateway.irys.xyz/'

body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'getProgramAccounts', 'params': [METADATA_PROGRAM, {
    'encoding': 'base64',
    'dataSlice': {'offset': 65, 'length': 254},  # nom (4+32), symbole (4+10), uri (4+200)
    'filters': [{'memcmp': {'offset': 1, 'bytes': GEN3_AUTHORITY}}],
}]}).encode()
req = urllib.request.Request(RPC, data=body, headers={'Content-Type': 'application/json', 'User-Agent': 'pfp-modifier-index'})
accounts = json.load(urllib.request.urlopen(req, timeout=300))['result']

def read_str(b, off):
    n = struct.unpack_from('<I', b, off)[0]
    return b[off + 4:off + 4 + n].decode('utf-8', 'replace').rstrip('\x00'), off + 4 + n

meta = {}
for a in accounts:
    b = base64.b64decode(a['account']['data'][0])
    name, o = read_str(b, 0)
    _sym, o = read_str(b, o)
    uri, o = read_str(b, o)
    m = re.fullmatch(r'SMB Gen3 #(\d+)', name.strip())
    if not m or not uri:
        continue  # tonneaux pas encore ouverts, objets annexes
    meta[int(m.group(1))] = uri[len(IRYS):] if uri.startswith(IRYS) else uri

root = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(root, 'data'), exist_ok=True)
out = {
    'updated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'base': IRYS,
    'count': len(meta),
    'meta': {str(k): meta[k] for k in sorted(meta)},
}
with open(os.path.join(root, 'data', 'smb3.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(out, f, separators=(',', ':'))
    f.write('\n')
print(f"{len(meta)} SMB Gen3 indexés (n° {min(meta)} à {max(meta)})")
