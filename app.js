require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const csurf = require('csurf');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const compression = require('compression');
const { Server } = require('socket.io');
const winston = require('winston');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const logsDir = path.join(__dirname, 'logs');
const publicDir = path.join(__dirname, 'public');
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(dataDir, 'uploads');

for (const dir of [logsDir, publicDir, dataDir, uploadDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'postit-social' },
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'combined.log') })
  ]
});

if (!isProduction) {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET requis en production');
}

if (isProduction) {
  app.set('trust proxy', 1);
}

const db = require('./db/db');
const authRoutes = require('./routes/auth');
const postitsRoutes = require('./routes/postits');
const adminRoutes = require('./routes/admin');
const boardsRoutes = require('./routes/boards');
const { attachUser, normalizeUser } = require('./middlewares/authMiddleware');

function isValidBoardSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(slug);
}

function wantsJson(req) {
  const accept = req.headers.accept || '';
  return accept.includes('application/json') || req.path.startsWith('/api/');
}

function getBoardPath(boardSlug) {
  return boardSlug === 'general' ? '/' : `/${boardSlug}`;
}

function requestIsSecure(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

function getBoardBySlug(boardSlug) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, slug FROM boards WHERE slug = ?', [boardSlug], (err, row) => {
      if (err) return reject(err);
      return resolve(row || null);
    });
  });
}

function ensureBoardExists(boardSlug, creatorId = null) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO boards (slug, creator_id) VALUES (?, ?)',
      [boardSlug, creatorId],
      (err) => {
        if (err) return reject(err);
        return resolve();
      }
    );
  });
}

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const assetVersion = process.env.ASSET_VERSION || 'v7';

app.locals.assetVersion = assetVersion;

if (!process.env.SESSION_SECRET && !isProduction) {
  logger.warn('SESSION_SECRET non défini : secret temporaire généré pour cette session.');
}

app.locals.guestUser = {
  id: null,
  username: 'guest',
  can_create: false,
  can_edit: false,
  can_delete: false,
  is_admin: false
};

app.use(
  helmet({
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
          }
        }
      : false
  })
);

app.use((req, res, next) => {
  if (process.env.FORCE_HTTPS === 'true' && !requestIsSecure(req)) {
    const host = req.headers.host;
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  return next();
});

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  '/assets',
  express.static(publicDir, {
    maxAge: isProduction ? '1d' : 0,
    setHeaders: (res) => {
      if (!isProduction) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
      }
    }
  })
);

app.use(
  session({
    name: 'postit.sid',
    store: new SQLiteStore({
      db: 'sessions.db',
      dir: dataDir,
      table: 'sessions'
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction || process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

app.use(csurf({ cookie: false }));
app.use(attachUser);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const message = 'Trop de tentatives, réessayez dans 15 minutes';

    if (wantsJson(req)) {
      return res.status(429).json({ error: message });
    }

    return res.status(429).send(message);
  }
});

const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, path: req.path });
    return res.status(429).json({ error: 'Trop de requêtes, réessayez plus tard' });
  }
});

app.use('/api/', apiLimiter);
app.post('/login', loginLimiter);

app.use(
  '/uploads',
  express.static(uploadDir, {
    maxAge: isProduction ? '1d' : 0
  })
);

app.use(authRoutes);
app.use(postitsRoutes);
app.use(adminRoutes);
app.use(boardsRoutes);

app.get('/health', (req, res) => {
  db.get('SELECT 1', (err) => {
    if (err) {
      logger.error('Health check failed', { error: err.message });
      return res.status(500).json({ status: 'error', database: 'down' });
    }

    return res.json({
      status: 'ok',
      database: 'up',
      timestamp: new Date().toISOString()
    });
  });
});

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Post-it Social API',
      version: '1.0.0',
      description: "API pour l'application de post-it sociale"
    },
    servers: [
      {
        url: `${process.env.USE_HTTPS === 'true' ? 'https' : 'http'}://localhost:${port}`,
        description: 'Serveur local'
      }
    ]
  },
  apis: ['./routes/*.js']
};

const specs = swaggerJsdoc(swaggerOptions);

if (!isProduction) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
}

async function renderBoardPage(req, res) {
  const boardSlug = req.params.boardSlug || 'general';

  if (!isValidBoardSlug(boardSlug)) {
    return res.status(400).send('Nom de tableau invalide');
  }

  try {
    let board = await getBoardBySlug(boardSlug);

    if (!board) {
      if (!req.session?.userId) {
        return res.status(404).send('Tableau introuvable');
      }

      await ensureBoardExists(boardSlug, req.session.userId);
      board = await getBoardBySlug(boardSlug);
    }

    return res.render('index', {
      boardSlug: board.slug,
      boardPath: getBoardPath(board.slug)
    });
  } catch (err) {
    logger.error('Erreur lecture/création tableau', {
      error: err.message,
      boardSlug
    });

    return res.status(500).send('Erreur interne');
  }
}

app.get('/', (req, res) => {
  req.params.boardSlug = 'general';
  return renderBoardPage(req, res);
});

app.get('/:boardSlug', renderBoardPage);

app.use((req, res) => {
  if (wantsJson(req)) {
    return res.status(404).json({ error: 'Route introuvable' });
  }

  return res.status(404).send('Page introuvable');
});

app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    logger.warn('CSRF token invalide', {
      ip: req.ip,
      path: req.path,
      method: req.method
    });

    if (wantsJson(req)) {
      return res.status(403).json({ error: 'Jeton CSRF invalide ou expiré' });
    }

    return res.status(403).send('Formulaire expiré ou invalide');
  }

  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    ip: req.ip,
    path: req.path,
    method: req.method
  });

  if (wantsJson(req)) {
    return res.status(500).json({ error: 'Erreur interne' });
  }

  return res.status(500).send('Erreur interne');
});

function seedSystemUsers() {
  db.get(
    'SELECT id, username, can_create, can_edit, can_delete, is_admin FROM users WHERE username = ?',
    ['guest'],
    async (guestErr, guestRow) => {
      if (guestErr) {
        logger.error('Erreur lecture guest', { error: guestErr.message });
        return;
      }

      if (guestRow) {
        const needsUpdate =
          guestRow.can_create !== 0 ||
          guestRow.can_edit !== 0 ||
          guestRow.can_delete !== 0 ||
          guestRow.is_admin !== 0;

        if (needsUpdate) {
          db.run(
            'UPDATE users SET can_create = 0, can_edit = 0, can_delete = 0, is_admin = 0 WHERE username = ?',
            ['guest'],
            (updateErr) => {
              if (updateErr) {
                logger.error('Erreur mise à jour guest', { error: updateErr.message });
                return;
              }

              logger.info('Compte guest mis à jour');
            }
          );

          guestRow.can_create = 0;
          guestRow.can_edit = 0;
          guestRow.can_delete = 0;
          guestRow.is_admin = 0;
        }

        app.locals.guestUser = normalizeUser(guestRow);
      } else {
        try {
          const guestPassword = crypto.randomBytes(32).toString('hex');
          const guestHash = await bcrypt.hash(guestPassword, 12);

          db.run(
            'INSERT INTO users (username, password_hash, can_create, can_edit, can_delete, is_admin) VALUES (?, ?, 0, 0, 0, 0)',
            ['guest', guestHash],
            function onInsert(insertErr) {
              if (insertErr) {
                logger.error('Erreur création guest', { error: insertErr.message });
                return;
              }

              app.locals.guestUser = {
                id: this.lastID,
                username: 'guest',
                can_create: false,
                can_edit: false,
                can_delete: false,
                is_admin: false
              };

              logger.info('Compte guest créé');
            }
          );
        } catch (hashErr) {
          logger.error('Erreur hash guest', { error: hashErr.message });
        }
      }
    }
  );

  db.get('SELECT id, username FROM users WHERE username = ?', ['admin'], async (err, adminRow) => {
  if (err) {
    logger.error('Erreur vérification admin', { error: err.message });
    return;
  }

  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    if (isProduction) {
      logger.warn('ADMIN_PASSWORD absent en production');
    }
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    if (adminRow) {
      db.run(
        `
        UPDATE users
        SET password_hash = ?, can_create = 1, can_edit = 1, can_delete = 1, is_admin = 1
        WHERE username = ?
        `,
        [passwordHash, 'admin'],
        (updateErr) => {
          if (updateErr) {
            logger.error('Erreur mise à jour admin', { error: updateErr.message });
            return;
          }

          logger.info('Compte admin mis à jour');
        }
      );
    } else {
      db.run(
        `
        INSERT INTO users (username, password_hash, can_create, can_edit, can_delete, is_admin)
        VALUES (?, ?, 1, 1, 1, 1)
        `,
        ['admin', passwordHash],
        (insertErr) => {
          if (insertErr) {
            logger.error('Erreur création admin', { error: insertErr.message });
            return;
          }

          logger.info('Compte admin créé: username=admin');
        }
      );
    }
  } catch (hashErr) {
    logger.error('Erreur hash admin', { error: hashErr.message });
  }
});
}

function createServerInstance() {
  const useHttps = process.env.USE_HTTPS === 'true';
  const keyPath = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;

  if (useHttps && keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };

    return {
      protocol: 'https',
      server: https.createServer(options, app)
    };
  }

  if (useHttps) {
    logger.warn('USE_HTTPS=true mais certificats manquants, fallback en HTTP.');
  }

  return {
    protocol: 'http',
    server: http.createServer(app)
  };
}

const { server, protocol } = createServerInstance();

const io = new Server(server, {
  cors: {
    origin: false
  }
});

app.set('io', io);

io.on('connection', (socket) => {
  socket.on('board:join', (slug) => {
    if (!isValidBoardSlug(slug)) {
      return;
    }

    const room = `board:${slug}`;

    if (socket.data.room) {
      socket.leave(socket.data.room);
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.boardSlug = slug;
  });
});

db.ready
  .then(() => {
    seedSystemUsers();

    if (require.main === module) {
      server.listen(port, () => {
        logger.info(`Serveur démarré sur ${protocol}://localhost:${port}`);
        console.log(`Serveur démarré sur ${protocol}://localhost:${port}`);
      });
    }
  })
  .catch((err) => {
    logger.error('Impossible de démarrer correctement', { error: err.message });
    if (require.main === module) {
      process.exit(1);
    }
  });

module.exports = app;
module.exports.server = server;