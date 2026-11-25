# PFP Modifier

Remplace les visages d'une même personne, sur toutes tes photos, par l'image de ton choix.
Tout tourne dans le navigateur : aucune image n'est envoyée sur internet
(détection et reconnaissance faciales : face-api / TensorFlow.js ; détourage : U²-Netp via onnxruntime-web ;
modèles dans `models/`).

## Lancer sur l'ordinateur

```
python serveur.py
```
puis ouvrir http://localhost:8000. Il faut passer par ce serveur : en double-cliquant
sur `index.html`, le navigateur refuse de charger les modèles.

## Installer sur l'iPhone en standalone (hors ligne, sans serveur)

iOS n'exécute pas une page web ouverte depuis un fichier local. L'app s'installe donc comme une
PWA : on la charge **une seule fois** depuis une adresse HTTPS, et ensuite tout (code + modèles,
≈30 Mo) est stocké sur l'iPhone. Elle marche alors en mode avion, sans aucun serveur.

1. Héberge ce dossier une fois en HTTPS (GitHub Pages, Netlify, Cloudflare Pages… : ce sont des fichiers statiques).
2. Ouvre l'adresse dans Safari sur l'iPhone et attends la mention « disponible hors ligne » en haut.
3. Partager → « Sur l'écran d'accueil ».
4. Lance-la depuis l'icône : elle fonctionne sans connexion. L'hébergement peut même être supprimé ensuite.

Pour une mise à jour de l'app, change `VERSION` dans `sw.js`, puis réhéberge.

## Lancer sur l'iPhone via l'ordinateur (dépannage)

1. Lance `python serveur.py` sur l'ordinateur. Il affiche une adresse « réseau local » du type `http://192.168.1.20:8000`.
2. Sur l'iPhone, connecté au même Wi-Fi, ouvre cette adresse dans Safari.
3. Le calcul se fait sur l'iPhone lui-même : l'ordinateur sert seulement à distribuer les fichiers.
4. Pour enregistrer : bouton « Enregistrer », ou appui long sur l'image agrandie puis « Ajouter à Photos ».

Si Windows demande d'autoriser Python sur le réseau, accepte pour les réseaux privés.

Pour une utilisation sans ordinateur, tu peux héberger le dossier sur n'importe quel hébergement
de fichiers statiques en HTTPS (GitHub Pages, Netlify…). Le calcul reste fait sur le téléphone, et
le menu de partage iOS (« Enregistrer l'image ») est alors disponible.

## Version

Sous le titre, l'app affiche « Version du JJ/MM/AAAA à HH:MM » (heure locale) et, si l'appareil est en ligne,
« à jour ✓ » ou « nouvelle version … disponible » avec un bouton « Mettre à jour ». Hors ligne, elle indique
que la vérification est impossible.

Pour publier : `python nouvelle-version.py` (numéro + date/heure dans sw.js, app.js et version.json), puis commit et push.

Index des collections (dans `data/`, à refaire de temps en temps puis publier) :
- `python index-smb3.py` : SMB Gen3, lu sur la blockchain Solana (RPC public). À relancer quand de nouveaux tonneaux sont ouverts.
- `python index-mayc.py` : MAYC, via l'API NFT d'Alchemy (clé publique « demo »). L'API officielle MAYC est derrière Cloudflare.
- `python index-smb2.py` : SMB Gen2, lu sur Arweave (collection figée, une fois suffit ; reprend là où il s'est arrêté). Un singe absent de l'index est quand même trouvé, en passant par le manifeste Arweave (plus lent).

## Utilisation

1. **Les images** : les photos à modifier, puis les images de remplacement. Si une image de
   remplacement contient un visage, elle est cadrée dessus par défaut.
   Touche une image de remplacement (ou « Ajuster l'image » dans une personne) pour :
   - **recadrer** : glisser pour déplacer, pincer / molette / curseur pour zoomer, deux doigts ou curseur pour tourner ;
     raccourcis « Centrer sur le visage », « Carré central », « Image entière » ;
   - **retirer l'arrière-plan** : « auto » (IA U²-Net, sujet principal : personne, animal, objet)
     ou « fond uni » (logos, fonds d'une seule couleur, avec un curseur de tolérance).
   - **gomme** : « Gomme » efface en frottant (la photo d'origine réapparaît à cet endroit), « Restaurer » fait revenir
     ce qui a été gommé ; taille réglable, « Annuler le dernier trait », « Tout restaurer ». Deux doigts déplacent et zooment ;
   - **miroir** ;
   - **forme et taille propres à cette image** (sinon elle suit l'étape 3), contour oui / non ;
   - **retouches** : luminosité, contraste, saturation.
   - **découpe au col** (garder seulement la tête d'un personnage) : outil « Col », glisse pour placer la pointe
     de la ligne jaune à la jonction chemise / cou ; règle l'ouverture (V < 180° < Λ), l'inclinaison et l'arrondi.
     Tout ce qui est sous la ligne est retiré. « Cadrer sur ce qui reste » recadre sur la tête ;
   - **modèles de découpe** : « Enregistrer comme modèle » garde col, détourage, cadrage, forme, taille et retouches.
     Touche un modèle pour l'appliquer à une autre image, ou choisis-le dans « Préparer les nouvelles images » :
     toutes les images ajoutées ensuite sont découpées automatiquement (cadrage recalculé sur ce qui reste,
     donc ça suit un personnage légèrement décalé) ;
   - **Collections NFT** : choisis la collection, tape un ou plusieurs numéros (« 12, 340 ») puis « Ajouter »
     (on peut en lancer d'autres pendant les téléchargements). Connexion nécessaire :

     | Collection | Numéros | Source de l'image |
     |---|---|---|
     | Big Pudgy | 0 à 8887 | IPFS |
     | Lil Pudgy | 0 à 22221 | API Pudgy Penguins |
     | BAYC | 0 à 9999 | métadonnées IPFS, puis image IPFS |
     | MAYC | 0 à 30007 (≈ 19 500 existent) | index `data/mayc/` (numéro → image IPFS) |
     | SMB Gen2 | 1 à 5000 | index `data/smb2.json` (numéro → image Arweave) |
     | SMB Gen3 | 1 à 15000 (≈ 8 300 révélés) | index `data/smb3.json` (numéro → métadonnées Irys), puis image |

     Les SMB (pixel art) sont agrandis sans flou. Les boutons « Lil bleu », « Lil rose » et « Big classique » ajoutent
     des penguins sans chapeau ni accessoire (les Big n'existent pas en bleu).
     Chaque collection a son **preset** (fond retiré, coupé au col, tête cadrée, forme Libre) : ajuste une image
     puis « Enregistrer comme preset … » dans « Modèles de découpe » ; il est appliqué aux autres images de
     la même collection déjà dans la liste et aux prochaines. « Preset d'origine » revient au réglage par défaut ;
   - **bibliothèque** : chaque image posée sur une photo que tu enregistres y est gardée automatiquement, avec son
     recadrage, son détourage, sa gomme et ses réglages (une seule fois par image : un même fichier n'est jamais dupliqué,
     et le réajouter récupère ses réglages). Touche une image de la bibliothèque pour la réutiliser, touche son nom pour
     la renommer, cherche par nom (sans tenir compte des accents ni des majuscules).
     La bibliothèque vit dans l'app, sur l'appareil. « Sauvegarder dans Fichiers » en fait une copie (un fichier .json)
     à ranger dans le dossier de ton choix (Partager → Enregistrer dans Fichiers) ; « Restaurer une sauvegarde » la recharge.
2. **Les personnes** : « Détecter les visages ». Les visages sont regroupés par personne (deux visages
   d'une même photo ne sont jamais mis ensemble).
   - Touche des visages pour les sélectionner, puis « Nouvelle personne », « Déplacer vers… » ou « Ignorer ».
   - « Fusionner avec… » réunit deux personnes.
   - Le curseur « Regroupement » puis « Regrouper à nouveau » refait tout le regroupement (les corrections manuelles sont perdues).
   - Choisis l'image de remplacement de chaque personne.
3. **Le rendu** : forme (ovale, rond, carré arrondi, carré, hexagone, étoile, cœur, ou « Libre » sans découpe, idéal avec une image détourée),
   taille, inclinaison, contour (avec « Libre » + image détourée, le contour suit la silhouette, façon sticker).
4. **Résultats** : aperçus en direct, export en pleine résolution. « Ajuster » sur une photo permet de régler
   chaque visage à la main : glisser pour déplacer, pincer / molette / curseurs pour la taille et l'angle,
   pincer en dehors des visages (ou « + » / « − », molette) pour zoomer sur la photo et glisser pour s'y déplacer,
   « Vue entière » pour revenir. La vue peut dépasser les bords de la photo (et dézoomer jusqu'à 50 %) pour poser
   un visage à moitié dehors : la partie hors photo est assombrie et sera coupée à l'enregistrement ; « Miroir » pour retourner l'image posée sur ce visage seulement (pratique pour qu'elle regarde du bon côté),
   « Ne pas remplacer ce visage » pour le laisser intact sur cette photo.
   **Visage non détecté** : « + Visage » (ou le bouton « + Visage » sous une photo sans visage) puis choisis l'image ;
   elle se pose au centre de la vue, à régler comme les autres. Elle rejoint la personne qui a déjà cette image
   (sinon une nouvelle personne). « Supprimer ce visage ajouté » pour l'enlever.

Des photos ajoutées plus tard sont rattachées aux personnes existantes sans perdre tes corrections.
