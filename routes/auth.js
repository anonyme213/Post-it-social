const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { normalizeUser, getGuestUser } = require('../middlewares/authMiddleware');

const router = express.Router();

function getSafeNext(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '/';
  }

  if (!value.startsWith('/')) {
    return '/';
  }

  if (value.startsWith('//') || value.includes('..')) {
    return '/';
  }

  return value;
}

function startUserSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        return reject(err);
      }

      req.session.userId = user.id;
      req.session.user = user;

      req.session.save((saveErr) => {
        if (saveErr) {
          return reject(saveErr);
        }

        return resolve();
      });
    });
  });
}

router.get('/signup', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/');
  }

  return res.render('signup', {
    errors: [],
    next: getSafeNext(req.query.next || '/')
  });
});

router.post(
  '/signup',
  body('username')
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Le nom d’utilisateur doit contenir entre 3 et 30 caractères')
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage('Le nom d’utilisateur ne peut contenir que lettres, chiffres, _ et -')
    .custom((value) => {
      const reserved = ['guest', 'admin'];
      if (reserved.includes(value.toLowerCase())) {
        throw new Error('Ce nom d’utilisateur est réservé');
      }
      return true;
    }),
  body('password')
    .isLength({ min: 8, max: 72 })
    .withMessage('Le mot de passe doit contenir entre 8 et 72 caractères'),
  body('confirmPassword')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('La confirmation du mot de passe est différente'),
  async (req, res) => {
    const errors = validationResult(req);
    const nextPath = getSafeNext(req.body.next || '/');

    if (!errors.isEmpty()) {
      return res.status(400).render('signup', {
        errors: errors.array(),
        next: nextPath
      });
    }

    const username = req.body.username.trim();
    const password = req.body.password;

    try {
      const passwordHash = await bcrypt.hash(password, 12);

      db.run(
        'INSERT INTO users (username, password_hash, can_create, can_edit, can_delete, is_admin) VALUES (?, ?, 1, 1, 1, 0)',
        [username, passwordHash],
        async function (err) {
          if (err) {
            if (err.message && err.message.includes('UNIQUE')) {
              return res.status(400).render('signup', {
                errors: [{ msg: 'Nom d’utilisateur déjà pris' }],
                next: nextPath
              });
            }

            console.error(err);
            return res.status(500).send('Erreur interne');
          }

          try {
            const user = {
              id: this.lastID,
              username,
              can_create: true,
              can_edit: true,
              can_delete: true,
              is_admin: false
            };

            await startUserSession(req, user);
            return res.redirect(nextPath);
          } catch (sessionErr) {
            console.error(sessionErr);
            return res.status(500).send('Erreur interne');
          }
        }
      );
    } catch (hashErr) {
      console.error(hashErr);
      return res.status(500).send('Erreur interne');
    }
  }
);

router.get('/login', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/');
  }

  return res.render('login', {
    errors: [],
    next: getSafeNext(req.query.next || '/')
  });
});

router.post(
  '/login',
  body('username').trim().notEmpty().withMessage('Username requis'),
  body('password').notEmpty().withMessage('Mot de passe requis'),
  (req, res) => {
    const errors = validationResult(req);
    const nextPath = getSafeNext(req.body.next || '/');

    if (!errors.isEmpty()) {
      return res.status(400).render('login', {
        errors: errors.array(),
        next: nextPath
      });
    }

    const username = req.body.username.trim();
    const password = req.body.password;

    db.get(
      'SELECT id, username, password_hash, can_create, can_edit, can_delete, is_admin FROM users WHERE username = ?',
      [username],
      async (err, row) => {
        if (err) {
          console.error(err);
          return res.status(500).send('Erreur interne');
        }

        if (!row) {
          console.warn(`Tentative de connexion échouée depuis ${req.ip}`);
          return res.status(401).render('login', {
            errors: [{ msg: 'Identifiants invalides' }],
            next: nextPath
          });
        }

        try {
          const ok = await bcrypt.compare(password, row.password_hash);

          if (!ok) {
            console.warn(`Tentative de connexion échouée depuis ${req.ip}`);
            return res.status(401).render('login', {
              errors: [{ msg: 'Identifiants invalides' }],
              next: nextPath
            });
          }

          const user = normalizeUser(row);
          await startUserSession(req, user);
          return res.redirect(nextPath);
        } catch (compareErr) {
          console.error(compareErr);
          return res.status(500).send('Erreur interne');
        }
      }
    );
  }
);

router.get('/logout', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/');
  }

  return res.render('logout');
});

router.post('/logout', (req, res) => {
  if (!req.session) {
    return res.redirect('/');
  }

  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Erreur interne');
    }

    res.clearCookie('postit.sid');
    return res.redirect('/');
  });
});

router.get('/me', (req, res) => {
  return res.json({
    currentUser: req.session?.user || null,
    guestUser: getGuestUser(req),
    isAuthenticated: !!req.session?.userId
  });
});

module.exports = router;