# WikiMasters - Userscripts

Userscripts [Tampermonkey](https://www.tampermonkey.net/) pour [wiki-masters.com](https://www.wiki-masters.com/).

Deux scripts indépendants :

| Script | Rôle |
| --- | --- |
| `wikimasters-auction-alert.user.js` | Repère les enchères qui se terminent bientôt (panneau flottant). |
| `wikimasters-quick-sell.user.js` | Met une carte en vente en un clic depuis ta collection. |

> Scripts à usage personnel. L'utilisation d'outils tiers peut être contraire aux conditions d'utilisation du site : à utiliser à tes risques.

---

# 1) Alerte enchères

Panneau flottant (bas à droite) qui repère en temps quasi réel les **enchères du Marketplace qui se terminent bientôt**, avec rareté, prix courant et **prix moyen constaté**. Il **ne mise jamais** à ta place.

## Fonctionnalités

- **Enchères se terminant bientôt** (fenêtres `0-2 min`, `1-2 min`, `0-5 min`, `0-10 min`, `Tout`).
- **Compte à rebours** en direct ; section **« À venir »** pour celles hors fenêtre.
- **Section « Expirées »** : les enchères suivies gardent leur nom 2 min après la fin.
- **Couleurs de rareté** (`C`, `PC`, `R`, `SR`, `UR`, `L`), **filtre multi-raretés**.
- **Filtres prix min / max** (optionnels), **recherche texte** (nom/catégorie, sans accents).
- **Tri** fin imminente / prix, **nombre d'annonces à charger** (`100`→`2000`).
- **Prix moyen constaté** (pastille + badge `~prix` sur les cartes du site).
- **Pause** et **gel de la liste au survol**, panneau **réductible**, **largeur adaptative**.
- **Réglages économes sur mobile**, **préférences mémorisées**, **sans son**.

## Utilisation

Sur le **Marketplace** : le panneau s'affiche. Bouton **réduire / agrandir**, filtres **Fenêtre / Raretés / Recherche / Prix / Trier / Charger**, boutons **Pause**, **Actualiser**, **Vider**.

Ligne de statut : `jeton OK`, `HTTP 200`, `lignes N`, `stock M`, `maj Ns`.

## Debug (console F12)

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

# 2) Vente rapide

Ajoute un **bouton `Vendre` en overlay sur chaque carte de ta collection**, et un bouton flottant **« ＋ Vendre une carte »**. Un formulaire s'ouvre : carte, **prix de départ**, **durée** (presets 1 h / 6 h / 12 h / 24 h / 3 j). En un clic, la carte est mise en vente sans passer par le menu.

## ⚠️ Étape indispensable (une seule fois)

Le script ne devine pas l'API du site : il **apprend la requête** de mise en vente que fait le site, puis la **rejoue** en remplaçant carte / prix / durée.

1. Fais **une mise en vente manuelle** (menu du site) **avec le script actif**.
2. Le script capture la requête.
3. Ensuite, l'overlay et le formulaire fonctionnent en un clic.

Tant que tu n'as pas fait cette mise en vente, le formulaire affiche un message d'aide (bloc jaune).

## Debug (console F12)

| Commande | Rôle |
| --- | --- |
| `WMQS_LAST` | Dernière requête de mise en vente apprise |
| `WMQS_LISTINGS()` | Historique des requêtes apprises |
| `WMQS_OWNED()` | Cartes de ta collection |
| `WMQS_FORM()` | Ouvre le formulaire |
| `WMQS_SUBMIT(card, prix, duréeMs, cb)` | Rejoue une mise en vente |

---

# Installation

## Ordinateur

1. Installer l'extension **Tampermonkey** (Chrome, Firefox, Edge, Opera...).
2. Ouvrir chaque fichier `.user.js` puis **Installer** (ou dans Tampermonkey : *Ajouter un nouveau script* → coller → `Ctrl+S`).

## Android

Chrome Android ne supporte pas les extensions. Utiliser :

- **Firefox Android + Tampermonkey** (recommandé), ou
- **Kiwi Browser** (Chromium acceptant les extensions du Chrome Web Store) + Tampermonkey.

Puis se connecter à `wiki-masters.com` et installer les scripts (coller, ou *Utilitaires → Importer un fichier*).

Astuce : héberger les `.user.js` (par ex. un Gist « raw ») et les installer par URL pour mettre à jour en un clic.

---

# Fonctionnement

Le site tourne sur **Next.js + Supabase**. Les scripts :

1. capturent les données et le **jeton de session** du site (hooks `fetch`, `XMLHttpRequest`, `WebSocket`) ;
2. interrogent les tables `auctions` (et `cards`, publique) avec ce jeton ;
3. calculent le **prix moyen** via la colonne `final_price` des ventes passées.

Aucune donnée n'est envoyée ailleurs : tout reste dans le navigateur.

---

# Dépannage

- **Panneau vide** : regarde la ligne de statut. `lignes 0` = aucune enchère à venir renvoyée (le marketplace fonctionne par vagues). `lignes 500` mais rien à l'écran = élargis la fenêtre.
- **`jeton -` / HTTP 401** : le jeton dure ~1 h. Reconnecte-toi ou recharge la page ; il est recapturé automatiquement.
- **Vente : rien ne se passe** : vérifie `WMQS_LAST`. S'il est `null`, refais une mise en vente manuelle avec le script actif.
- **Prix moyen absent** : la colonne `final_price` n'est pas encore renseignée pour ces cartes.
