const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { requireAdmin } = require('../middlewares/rightsMiddleware');

const router = express.Router();

router.get('/admin', requireAdmin, (req, res) => {
  db.all(
    `
    SELECT id, username, can_create, can_edit, can_delete, is_admin
    FROM users
    ORDER BY
      CASE WHEN username = 'guest' THEN 0 ELSE 1 END,
      username ASC
    `,
    [],
    (err, users) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Erreur interne');
      }

      return res.render('admin', { users, errors: [] });
    }
  );
});

router.post(
  '/admin/update',
  requireAdmin,
  body('userId').trim().isInt({ min: 1 }).withMessage('Utilisateur invalide'),
  (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).send('Données invalides');
    }

    const userId = Number(req.body.userId);
    const canCreate = req.body.can_create === '1' ? 1 : 0;
    const canEdit = req.body.can_edit === '1' ? 1 : 0;
    const canDelete = req.body.can_delete === '1' ? 1 : 0;
    let isAdmin = req.body.is_admin === '1' ? 1 : 0;

    db.get('SELECT id, username, is_admin FROM users WHERE id = ?', [userId], (err, targetUser) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Erreur interne');
      }

      if (!targetUser) {
        return res.status(404).send('Utilisateur introuvable');
      }

      if (targetUser.username === 'guest') {
        isAdmin = 0;
      }

      if (userId === req.session.userId && isAdmin === 0) {
        return res.status(400).send('Vous ne pouvez pas retirer votre propre rôle admin.');
      }

      db.get('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1', [], (countErr, row) => {
        if (countErr) {
          console.error(countErr);
          return res.status(500).send('Erreur interne');
        }

        const adminCount = row.count;

        if (targetUser.is_admin && isAdmin === 0 && adminCount <= 1) {
          return res.status(400).send('Impossible de retirer le dernier administrateur.');
        }

        db.run(
          'UPDATE users SET can_create = ?, can_edit = ?, can_delete = ?, is_admin = ? WHERE id = ?',
          [canCreate, canEdit, canDelete, isAdmin, userId],
          (updateErr) => {
            if (updateErr) {
              console.error(updateErr);
              return res.status(500).send('Erreur interne');
            }

            return res.redirect('/admin');
          }
        );
      });
    });
  }
);

router.post(
  '/admin/delete-user',
  requireAdmin,
  body('userId').trim().isInt({ min: 1 }).withMessage('Utilisateur invalide'),
  (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).send('Données invalides');
    }

    const userId = Number(req.body.userId);

    db.get('SELECT id, username, is_admin FROM users WHERE id = ?', [userId], (err, targetUser) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Erreur interne');
      }

      if (!targetUser) {
        return res.status(404).send('Utilisateur introuvable');
      }

      if (targetUser.username === 'guest') {
        return res.status(400).send("Le compte guest ne peut pas être supprimé.");
      }

      if (userId === req.session.userId) {
        return res.status(400).send("Vous ne pouvez pas supprimer votre propre compte admin.");
      }

      db.get('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1', [], (countErr, row) => {
        if (countErr) {
          console.error(countErr);
          return res.status(500).send('Erreur interne');
        }

        const adminCount = row.count;

        if (targetUser.is_admin && adminCount <= 1) {
          return res.status(400).send('Impossible de supprimer le dernier administrateur.');
        }

        db.run('BEGIN TRANSACTION', (beginErr) => {
          if (beginErr) {
            console.error(beginErr);
            return res.status(500).send('Erreur interne');
          }

          const rollback = (sourceErr) => {
            console.error(sourceErr);
            db.run('ROLLBACK', () => {
              return res.status(500).send('Erreur interne');
            });
          };

          db.run('DELETE FROM postit_history WHERE changed_by = ?', [userId], (historyErr) => {
            if (historyErr) {
              return rollback(historyErr);
            }

            db.run('DELETE FROM users WHERE id = ?', [userId], function onDelete(deleteErr) {
              if (deleteErr) {
                return rollback(deleteErr);
              }

              if (this.changes !== 1) {
                return rollback(new Error('Utilisateur introuvable ou déjà supprimé'));
              }

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  return rollback(commitErr);
                }

                return res.redirect('/admin');
              });
            });
          });
        });
      });
    });
  }
);

module.exports = router;