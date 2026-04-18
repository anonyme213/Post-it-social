const { getActor } = require('./authMiddleware');

function requireRight(right) {
  return function (req, res, next) {
    const actor = getActor(req);
    req.actor = actor;

    if (actor && (actor.is_admin || actor[right])) {
      return next();
    }

    if (req.accepts('json') || req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }

    return res.status(403).send('Droits insuffisants');
  };
}

function requireAdmin(req, res, next) {
  const user = req.session?.user;

  if (user && user.is_admin) {
    return next();
  }

  if (req.accepts('json') || req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Accès administrateur requis' });
  }

  return res.status(403).send('Accès administrateur requis');
}

module.exports = { requireRight, requireAdmin };