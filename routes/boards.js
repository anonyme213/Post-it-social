const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { getActor } = require('../middlewares/authMiddleware');

const router = express.Router();

function isValidBoardSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(slug);
}

function emitBoardsChange(req, action, boardSlug) {
  const io = req.app.get('io');
  if (!io) return;

  io.emit('boards:changed', { action, boardSlug });

  if (action === 'deleted') {
    io.to(`board:${boardSlug}`).emit('board:deleted', { boardSlug });
  }
}

router.get('/api/boards', (req, res) => {
  const sql = `
    SELECT
      b.id,
      b.slug,
      b.created_at,
      b.creator_id,
      COUNT(p.id) AS postit_count
    FROM boards b
    LEFT JOIN postits p ON p.board_id = b.id
    GROUP BY b.id, b.slug, b.created_at, b.creator_id
    ORDER BY
      CASE WHEN b.slug = 'general' THEN 0 ELSE 1 END,
      datetime(b.created_at) ASC,
      b.slug ASC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Erreur récupération tableaux:', err);
      return res.status(500).json({ error: 'Erreur interne' });
    }

    return res.json({ boards: rows || [] });
  });
});

router.post(
  '/api/boards',
  body('slug')
    .trim()
    .matches(/^[A-Za-z0-9_-]{1,30}$/)
    .withMessage('Nom de tableau invalide'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const actor = getActor(req);
    if (!actor || actor.id == null) {
      return res.status(403).json({ error: 'Connexion requise pour créer un tableau' });
    }

    const slug = req.body.slug.trim();

    if (slug === 'general') {
      return db.get(
        'SELECT id, slug, created_at, creator_id FROM boards WHERE slug = ?',
        ['general'],
        (err, board) => {
          if (err) {
            console.error('Erreur lecture tableau général:', err);
            return res.status(500).json({ error: 'Erreur interne' });
          }

          return res.json({
            created: false,
            board
          });
        }
      );
    }

    db.get(
      'SELECT id, slug, created_at, creator_id FROM boards WHERE slug = ?',
      [slug],
      (err, existing) => {
        if (err) {
          console.error('Erreur lecture tableau:', err);
          return res.status(500).json({ error: 'Erreur interne' });
        }

        if (existing) {
          return res.json({
            created: false,
            board: existing
          });
        }

        db.run(
          'INSERT INTO boards (slug, creator_id) VALUES (?, ?)',
          [slug, actor.id],
          function onInsert(insertErr) {
            if (insertErr) {
              console.error('Erreur création tableau:', insertErr);
              return res.status(500).json({ error: 'Erreur interne' });
            }

            db.get(
              'SELECT id, slug, created_at, creator_id FROM boards WHERE id = ?',
              [this.lastID],
              (readErr, board) => {
                if (readErr) {
                  console.error('Erreur lecture tableau créé:', readErr);
                  return res.status(500).json({ error: 'Erreur interne' });
                }

                emitBoardsChange(req, 'created', slug);

                return res.status(201).json({
                  created: true,
                  board
                });
              }
            );
          }
        );
      }
    );
  }
);

router.post('/api/boards/:boardSlug/delete', (req, res) => {
  const { boardSlug } = req.params;

  if (!isValidBoardSlug(boardSlug)) {
    return res.status(400).json({ error: 'Nom de tableau invalide' });
  }

  if (boardSlug === 'general') {
    return res.status(400).json({ error: 'Le tableau général ne peut pas être supprimé' });
  }

  const actor = getActor(req);

  if (!actor || actor.id == null) {
    return res.status(403).json({ error: 'Connexion requise' });
  }

  db.get(
    'SELECT id, slug, creator_id FROM boards WHERE slug = ?',
    [boardSlug],
    (err, board) => {
      if (err) {
        console.error('Erreur lecture tableau:', err);
        return res.status(500).json({ error: 'Erreur interne' });
      }

      if (!board) {
        return res.status(404).json({ error: 'Tableau introuvable' });
      }

      const isOwner =
        board.creator_id != null && Number(board.creator_id) === Number(actor.id);

      if (!(actor.is_admin || isOwner)) {
        return res.status(403).json({ error: 'Vous ne pouvez pas supprimer ce tableau' });
      }

      db.run('BEGIN TRANSACTION', (beginErr) => {
        if (beginErr) {
          console.error('Erreur début transaction suppression tableau:', beginErr);
          return res.status(500).json({ error: 'Erreur interne' });
        }

        const rollback = (sourceErr) => {
          console.error('Erreur suppression tableau:', sourceErr);

          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) {
              console.error('Erreur rollback suppression tableau:', rollbackErr);
            }

            return res.status(500).json({ error: 'Erreur interne' });
          });
        };

        db.run(
          `
          DELETE FROM postit_history
          WHERE postit_id IN (
            SELECT id FROM postits WHERE board_id = ?
          )
          `,
          [board.id],
          (historyErr) => {
            if (historyErr) {
              return rollback(historyErr);
            }

            db.run(
              'DELETE FROM boards WHERE id = ?',
              [board.id],
              function onDelete(deleteBoardErr) {
                if (deleteBoardErr) {
                  return rollback(deleteBoardErr);
                }

                if (this.changes !== 1) {
                  return rollback(new Error('Suppression du tableau incohérente'));
                }

                db.run('COMMIT', (commitErr) => {
                  if (commitErr) {
                    return rollback(commitErr);
                  }

                  emitBoardsChange(req, 'deleted', boardSlug);

                  return res.json({
                    success: true,
                    message: 'Tableau supprimé'
                  });
                });
              }
            );
          }
        );
      });
    }
  );
});

module.exports = router;