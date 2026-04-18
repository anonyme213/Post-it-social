# Post-it Social

Application sociale de post-it sécurisée avec Node.js, Express, SQLite et HTTPS.

## Fonctionnalités

- ✅ Authentification sécurisée (bcrypt, sessions)
- ✅ Gestion des droits (create, edit, delete, admin)
- ✅ Post-its avec texte, position, auteur, date
- ✅ Double-clic pour créer des post-its
- ✅ Drag & drop pour déplacer
- ✅ Modification et suppression des post-its
- ✅ Multi-tableaux (boards)
- ✅ Temps réel (Socket.IO)
- ✅ Upload d'images
- ✅ Historique des modifications (admin)
- ✅ Pagination et recherche
- ✅ HTTPS obligatoire
- ✅ Protection XSS (DOMPurify)
- ✅ Rate limiting
- ✅ Logs d'audit
- ✅ API REST complète
- ✅ Documentation Swagger
- ✅ Tests unitaires et e2e
- ✅ Docker support
- ✅ Compression gzip
- ✅ Cache HTTP
- ✅ Rate limiting Redis
- ✅ Notifications tentatives connexion échouées
- ✅ Tests sécurité (Snyk)
- ✅ Benchmarks performance
- ✅ Monitoring PM2
- ✅ Reverse proxy Nginx
- ✅ Docker Compose avec Redis

## Scripts disponibles

```bash
npm start          # Démarrage production
npm run dev        # Démarrage développement
npm run lint       # Vérification code
npm run format     # Formatage code
npm test           # Tests unitaires
npm run test:e2e   # Tests end-to-end
npm run security   # Scan sécurité Snyk
npm run benchmark  # Benchmarks performance
npm run pm2:start  # Démarrage avec PM2
npm run pm2:stop   # Arrêt PM2
```

## Installation

### Prérequis
- Node.js >= 16
- npm

### Installation
```bash
git clone <repository>
cd post-it-social
npm install
```

### Configuration
Créer un fichier `.env` :
```env
NODE_ENV=development
SESSION_SECRET=votre-secret-super-securise
ADMIN_PASSWORD=admin123
PORT=3000
DB_PATH=./db/postit.db
CERT_DIR=./cert
LOG_LEVEL=info
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880
```

### Démarrage
```bash
# Développement
npm run dev

# Production
npm start

# Avec Docker
docker build -t postit-social .
docker run -p 3000:3000 postit-social
```

### Certificats HTTPS
Générés automatiquement en développement. Pour production, utiliser Let's Encrypt.

## Comptes par défaut

- **Admin** : `admin` / `admin123` (configurable via ADMIN_PASSWORD)
- **Guest** : utilisateur non connecté (droits limités)

## API

### Routes principales
- `GET /` - Page principale
- `GET /:boardSlug` - Page d'un tableau
- `POST /signup` - Inscription
- `POST /login` - Connexion
- `POST /logout` - Déconnexion

### API Post-its
- `GET /api/:boardSlug/liste?limit=50&offset=0&search=texte` - Lister les post-its
- `POST /api/:boardSlug/ajouter` - Créer un post-it
- `POST /api/:boardSlug/modifier/:id` - Modifier un post-it
- `POST /api/:boardSlug/effacer/:id` - Supprimer un post-it
- `GET /api/:boardSlug/historique/:id` - Historique (admin)

### Administration
- `GET /admin` - Gestion des droits utilisateurs
- `GET /api-docs` - Documentation Swagger
- `GET /health` - Health check

## Développement

### Scripts disponibles
```bash
npm run dev          # Démarrage avec nodemon
npm run lint         # Vérification ESLint
npm run lint:fix     # Correction automatique ESLint
npm run format       # Formatage Prettier
npm run test         # Tests unitaires
npm run test:watch   # Tests en mode watch
npm run test:e2e     # Tests end-to-end
npm run security     # Scan sécurité Snyk
npm run benchmark    # Benchmarks performance
npm run test:security # Tests sécurité spécifiques
```

### Tests
```bash
# Tests unitaires
npm test

# Tests e2e (nécessite le serveur en cours)
npx playwright install
npm run test:e2e
```

## Sécurité

- **Authentification** : bcrypt, sessions sécurisées
- **Autorisation** : Vérification des droits côté serveur
- **Protection XSS** : DOMPurify côté client
- **CSRF** : Tokens sur tous les formulaires
- **Rate limiting** : Sur les API et login (Redis)
- **HTTPS** : Obligatoire
- **Logs** : Audit des actions sensibles, tentatives connexion échouées
- **Validation** : express-validator sur toutes les entrées
- **Headers sécurité** : Helmet.js
- **Tests sécurité** : Snyk scans

## Déploiement

### Avec Docker Compose (recommandé)
```bash
docker-compose up --build
```

### Avec PM2
```bash
npm run pm2:start
npm run pm2:stop
```

### Avec Nginx (reverse proxy)
```bash
# Copier nginx.conf dans /etc/nginx/sites-available/
# Activer et redémarrer Nginx
sudo systemctl restart nginx
```

### Sur Vercel
```bash
# Installer Vercel CLI
npm i -g vercel
vercel --prod
```

### Sur Heroku
```bash
# Créer l'app Heroku
heroku create votre-app-postit
git push heroku main
```

### Variables production
```env
NODE_ENV=production
REDIS_HOST=redis
REDIS_PORT=6379
SESSION_SECRET=<secret-production>
ADMIN_PASSWORD=<password-admin>
DATABASE_URL=<url-base-donnees>
```

## Architecture

### Diagramme système
```
Client Browser → Nginx → Express.js Server
                        ↓
               ┌────────┼────────┐
               │        │        │
            SQLite   Redis   File System
             (data)  (cache)  (uploads)
```

### Flux de données
1. Client → Serveur (API REST + validation)
2. Base de données (SQLite)
3. Cache/Rate limiting (Redis)
4. Réponse + Socket.IO temps réel
├── public/            # Assets statiques
├── tests/             # Tests
└── uploads/           # Images uploadées
```

## Déploiement

### Variables d'environnement
- `NODE_ENV` : `production` ou `development`
- `SESSION_SECRET` : Clé secrète pour les sessions
- `ADMIN_PASSWORD` : Mot de passe admin initial
- `PORT` : Port d'écoute (défaut 3000)
- `DB_PATH` : Chemin base de données
- `CERT_DIR` : Dossier certificats
- `LOG_LEVEL` : Niveau de logs
- `RATE_LIMIT_WINDOW_MS` : Fenêtre rate limit
- `RATE_LIMIT_MAX` : Max requêtes par fenêtre
- `UPLOAD_DIR` : Dossier uploads
- `MAX_FILE_SIZE` : Taille max fichiers

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## Licence

MIT
