const db = require('../db/db');

function normalizeUser(row) {
  return {
    id: row.id,
    username: row.username,
    can_create: !!row.can_create,
    can_edit: !!row.can_edit,
    can_delete: !!row.can_delete,
    is_admin: !!row.is_admin
  };
}

function getDefaultGuest() {
  return {
    id: null,
    username: 'guest',
    can_create: false,
    can_edit: false,
    can_delete: false,
    is_admin: false
  };
}

function getGuestUser(req) {
  return req.app?.locals?.guestUser || getDefaultGuest();
}

function getActor(req) {
  return req.session?.user || getGuestUser(req);
}

function isAuthenticated(req) {
  return !!(req.session && req.session.userId && req.session.user);
}

function ensureAuthenticated(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }

  if (req.accepts('json') || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Connexion requise' });
  }

  return res.redirect('/login');
}

function attachUser(req, res, next) {
  try {
    res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
  } catch {
    res.locals.csrfToken = '';
  }

  const guestUser = getGuestUser(req);

  res.locals.guestUser = guestUser;
  res.locals.currentUser = req.session?.user || null;
  res.locals.actorUser = req.session?.user || guestUser;

  if (!req.session?.userId) {
    return next();
  }

  db.get(
    'SELECT id, username, can_create, can_edit, can_delete, is_admin FROM users WHERE id = ?',
    [req.session.userId],
    (err, user) => {
      if (err) {
        return next(err);
      }

      if (!user) {
        return req.session.destroy((destroyErr) => {
          if (destroyErr) {
            return next(destroyErr);
          }

          res.locals.currentUser = null;
          res.locals.actorUser = guestUser;
          return next();
        });
      }

      const currentUser = normalizeUser(user);
      req.session.user = currentUser;
      res.locals.currentUser = currentUser;
      res.locals.actorUser = currentUser;
      return next();
    }
  );
}

module.exports = {
  normalizeUser,
  getGuestUser,
  getActor,
  isAuthenticated,
  ensureAuthenticated,
  attachUser
};