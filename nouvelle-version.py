"""Prépare une nouvelle version avant de publier : numéro + date/heure (UTC).

Met à jour d'un coup sw.js (VERSION, pour vider le cache hors ligne), app.js (APP_VERSION, affiché dans l'app)
et version.json (lu par l'app pour savoir si elle est à jour).
Usage : python nouvelle-version.py
"""
import datetime, json, os, re

root = os.path.dirname(os.path.abspath(__file__))
def path(n): return os.path.join(root, n)

sw = open(path('sw.js'), encoding='utf-8').read()
n = int(re.search(r"const VERSION = 'pfp-v(\d+)';", sw).group(1)) + 1
version = f'pfp-v{n}'
built = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

sw = re.sub(r"const VERSION = 'pfp-v\d+';", f"const VERSION = '{version}';", sw)
open(path('sw.js'), 'w', encoding='utf-8', newline='\n').write(sw)

app = open(path('app.js'), encoding='utf-8').read()
app, k = re.subn(r"const APP_VERSION = \{[^}]*\};", f"const APP_VERSION = {{ version: '{version}', built: '{built}' }};", app)
assert k == 1, 'APP_VERSION introuvable dans app.js'
open(path('app.js'), 'w', encoding='utf-8', newline='\n').write(app)

with open(path('version.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump({'version': version, 'built': built}, f)
    f.write('\n')
print(version, built)
