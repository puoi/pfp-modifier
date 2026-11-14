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
   « Ne pas remplacer ce visage » pour le laisser intact sur cette photo.

Des photos ajoutées plus tard sont rattachées aux personnes existantes sans perdre tes corrections.
