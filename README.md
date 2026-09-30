# WikiMasters - Alerte enchères

Userscript [Tampermonkey](https://www.tampermonkey.net/) pour [wiki-masters.com](https://www.wiki-masters.com/).

Il affiche un panneau flottant qui repère en temps quasi réel les **enchères du Marketplace qui se terminent bientôt**, avec leur rareté, leur prix courant et le **prix moyen constaté** de la carte.

> Script à usage personnel. Il ne mise pas à ta place : il ne fait qu'afficher et filtrer des données publiques du marketplace.

---

## Fonctionnalités

- **Détection des enchères qui se terminent bientôt** (fenêtres réglables : `0-2 min`, `1-2 min`, `0-5 min`, `0-10 min`, `Tout`).
- **Compte à rebours** en direct ; les enchères hors fenêtre sont listées dans une section **« À venir »**.
- **Section « Expirées »** : les enchères suivies qui viennent de se terminer restent affichées (nom conservé) pendant 2 min.
- **Couleurs de rareté** (`C`, `PC`, `R`, `SR`, `UR`, `L`) : bordure, contour d'image et badge.
- **Filtre multi-raretés** (sélection multiple).
- **Filtres prix min / max** (optionnels).
- **Recherche texte** (nom ou catégorie), insensible aux accents/majuscules.
- **Tri** : fin imminente ou prix.
- **Nombre d'annonces à charger** réglable (`100`, `300`, `1000`, `2000`).
- **Prix moyen constaté** par carte (issu des ventes passées `final_price`), affiché en pastille et injecté en badge `~prix` sur les cartes du site.
- **Bouton Pause** et **gel de la liste au survol** pour cliquer sans que ça bouge.
- **Panneau réductible**, **largeur adaptative** (`min(380px, 92vw)`).
- **Réglages économes automatiques sur mobile** (moins de requêtes, moins de batterie).
- **Préférences mémorisées** (fenêtre, raretés, prix, recherche, tri, limite).
- **Sans son**.

---

## Installation

### Ordinateur

1. Installer l'extension **Tampermonkey** (Chrome, Firefox, Edge, Opera...).
2. Ouvrir le fichier `wikimasters-auction-alert.user.js` puis cliquer sur **Installer**, ou dans Tampermonkey : *Ajouter un nouveau script* → coller le contenu → `Ctrl+S`.
3. Aller sur [wiki-masters.com](https://www.wiki-masters.com/), se connecter, puis ouvrir le **Marketplace**.

### Android

Chrome Android ne supporte pas les extensions. Utiliser :

- **Firefox Android + Tampermonkey** (recommandé), ou
- **Kiwi Browser** (Chromium acceptant les extensions du Chrome Web Store) + Tampermonkey.

Puis :

1. Se connecter à `wiki-masters.com` dans ce navigateur.
2. Installer le script (coller le contenu, ou *Utilitaires → Importer un fichier*).
3. Ouvrir le **Marketplace** : le panneau apparaît.

Astuce maintenance : héberger le `.user.js` (par ex. un Gist « raw ») et l'installer par URL pour mettre à jour en un clic.

---

## Utilisation

Une fois connecté et sur le **Marketplace** :

- Le panneau s'affiche en bas à droite. Le bouton **réduire / agrandir** le replie sur sa barre de titre.
- **Fenêtre** : choisir la plage de temps à surveiller.
- **Raretés** : cliquer une ou plusieurs pastilles (`Toutes` pour réinitialiser).
- **Rechercher** : filtrer par nom/catégorie.
- **Prix min / max** : filtrer par budget (laisser vide = désactivé).
- **Trier** : `fin imminente` ou `prix`.
- **Charger** : nombre d'annonces interrogées.
- **Pause** : fige la liste. **Actualiser** : relance une requête avec tes filtres.
- Ligne de statut en bas : `jeton OK`, `HTTP 200`, `lignes N`, `stock M`, `maj Ns`.

### Outils de debug (console F12)

| Commande | Rôle |
| --- | --- |
| `WM_AUCTIONS` | Map des enchères captées |
| `WM_GET_AUTH()` | Jeton / clé / URL captés |
| `WM_DEBUG` | Compteurs et dernier statut |
| `WM_DIRECT_QUERY()` | Force une requête maintenant |
| `WM_REFRESH_PRICES()` | Recalcule les prix moyens |
| `WM_PRICE_CACHE` | Moyennes en cache par carte |
| `WM_GET_PREFS()` / `WM_SAVE_PREFS()` | Préférences mémorisées |

---

## Fonctionnement

Le site tourne sur **Next.js + Supabase**. Le script :

1. capture les données d'enchères déjà chargées par le site (hooks `fetch`, `XMLHttpRequest`, `WebSocket` Supabase) ;
2. réutilise le **jeton de session** du site pour interroger la table `auctions` ;
3. enrichit les cartes via la table publique `cards` ;
4. calcule le **prix moyen** à partir de la colonne `final_price` des ventes passées.

Aucune donnée n'est envoyée ailleurs : tout reste dans le navigateur.

---

## Dépannage

- **Panneau vide** : vérifie la ligne de statut. `lignes 0` = la base n'a renvoyé aucune enchère à venir (normal, le marketplace fonctionne par vagues). `lignes 500` mais rien à l'écran = aucune enchère dans la fenêtre choisie → élargis la fenêtre ou attends.
- **`jeton -` / HTTP 401** : le jeton de session dure ~1 h. Reconnecte-toi ou recharge la page wiki-masters ; le script le recapture automatiquement.
- **Rien ne bouge** : le bouton **Pause** est peut-être actif, ou la souris est posée sur la liste (gel au survol).
- **Prix moyen absent** : la colonne `final_price` n'est peut-être pas encore renseignée pour ces cartes.

---

## Avertissement

Ce script automatise uniquement l'**affichage**. Il ne place aucune enchère. L'utilisation d'outils tiers peut être contraire aux conditions d'utilisation du site : à utiliser à tes risques.
