const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/db');
const { requireRight } = require('../middlewares/rightsMiddleware');
const { getActor } = require('../middlewares/authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.File({ filename: 'logs/postits.log' })]
});

const router = express.Router();

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../data');

const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(dataDir, 'uploads');

fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const imageUpload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_MIMES.has(file.mimetype) || !ALLOWED_EXTS.has(ext)) {
      return cb(new Error('Format image invalide'));
    }

    return cb(null, true);
  }
});

function cleanupTempUpload(file) {
  if (!file || !file.path) return;

  fs.unlink(file.path, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn('Erreur suppression fichier temporaire', {
        error: err.message,
        tempPath: file.path
      });
    }
  });
}

function detectImageSignature(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(16);

  try {
    fs.readSync(fd, buffer, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) {
    return { mime: 'image/jpeg', exts: new Set(['.jpg', '.jpeg']) };
  }

  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;

  if (isPng) {
    return { mime: 'image/png', exts: new Set(['.png']) };
  }

  const ascii = buffer.toString('ascii', 0, 6);
  if (ascii === 'GIF87a' || ascii === 'GIF89a') {
    return { mime: 'image/gif', exts: new Set(['.gif']) };
  }

  const riff = buffer.toString('ascii', 0, 4);
  const webp = buffer.toString('ascii', 8, 12);
  if (riff === 'RIFF' && webp === 'WEBP') {
    return { mime: 'image/webp', exts: new Set(['.webp']) };
  }

  return null;
}

function validateUploadedImageFile(file) {
  if (!file) return;

  const ext = path.extname(file.originalname).toLowerCase();
  const detected = detectImageSignature(file.path);

  if (!detected) {
    throw new Error('Le contenu du fichier n’est pas une image valide');
  }

  if (!detected.exts.has(ext)) {
    throw new Error('Extension image incohérente avec le contenu réel');
  }

  if (detected.mime !== file.mimetype) {
    throw new Error('Type MIME incohérent avec le contenu réel');
  }
}

function handleImageUpload(req, res, next) {
  imageUpload.single('image')(req, res, (err) => {
    if (err) {
      logger.warn('Upload image refusé', { error: err.message, code: err.code });

      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image trop volumineuse (max 5 Mo)' });
      }

      return res.status(400).json({ error: err.message || 'Erreur upload image' });
    }

    if (!req.file) {
      return next();
    }

    try {
      validateUploadedImageFile(req.file);
      return next();
    } catch (validationErr) {
      cleanupTempUpload(req.file);
      return res.status(400).json({ error: validationErr.message });
    }
  });
}

function buildManagedFilename(ext) {
  return `${crypto.randomUUID()}${ext}`;
}

function moveUploadedFileToManagedLocation(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = buildManagedFilename(ext);
  const newPath = path.join(uploadDir, filename);
  fs.renameSync(file.path, newPath);
  return `/uploads/${filename}`;
}

function getSafeUploadPathFromUrl(imageUrl) {
  if (!imageUrl) return null;

  const normalized = path.posix.normalize(imageUrl);
  if (!normalized.startsWith('/uploads/')) {
    throw new Error('Chemin image invalide');
  }

  const filename = path.posix.basename(normalized);
  if (!/^[a-f0-9-]+\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
    throw new Error('Nom de fichier invalide');
  }

  return path.join(uploadDir, filename);
}

function safeDeleteManagedImage(imageUrl) {
  if (!imageUrl) return;

  try {
    const imagePath = getSafeUploadPathFromUrl(imageUrl);
    fs.unlink(imagePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        logger.warn('Erreur suppression image', { error: err.message, imageUrl });
      }
    });
  } catch (err) {
    logger.warn('Image ignorée pour suppression', { error: err.message, imageUrl });
  }
}

function isValidBoardSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(slug);
}

function validateBoardSlug(req, res, next) {
  const { boardSlug } = req.params;

  if (!isValidBoardSlug(boardSlug)) {
    return res.status(400).json({ error: 'Nom de tableau invalide' });
  }

  req.boardSlug = boardSlug;
  return next();
}

function emitBoardChange(req, boardSlug, action, postitId = null) {
  const io = req.app.get('io');
  if (!io) return;

  io.to(`board:${boardSlug}`).emit('postits:changed', {
    action,
    boardSlug,
    postitId
  });
}

function logPostitChange(postitId, changeType, changedBy, oldData = null, newData = null) {
  const changeData = {
    postit_id: postitId,
    change_type: changeType,
    changed_by: changedBy,
    text: newData ? newData.text : oldData ? oldData.text : null,
    x: newData ? newData.x : oldData ? oldData.x : null,
    y: newData ? newData.y : oldData ? oldData.y : null,
    image_url: newData ? newData.image_url : oldData ? oldData.image_url : null
  };

  db.run(
    'INSERT INTO postit_history (postit_id, text, x, y, image_url, changed_by, change_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      changeData.postit_id,
      changeData.text,
      changeData.x,
      changeData.y,
      changeData.image_url,
      changeData.changed_by,
      changeData.change_type
    ],
    (err) => {
      if (err) {
        logger.error('Erreur logging postit change', { error: err.message, changeData });
      }
    }
  );
}

function getBoardBySlug(boardSlug, callback) {
  db.get(
    'SELECT id, slug, creator_id, created_at FROM boards WHERE slug = ?',
    [boardSlug],
    callback
  );
}

router.get(
  '/api/:boardSlug/liste',
  validateBoardSlug,
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit invalide'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset invalide'),
  query('search').optional().isLength({ min: 1, max: 100 }).withMessage('Recherche invalide'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    getBoardBySlug(req.boardSlug, (boardErr, board) => {
      if (boardErr) {
        logger.error('Erreur lecture board liste', { error: boardErr.message, boardSlug: req.boardSlug });
        return res.status(500).json({ error: 'Erreur interne' });
      }

      if (!board) {
        return res.status(404).json({ error: 'Tableau introuvable' });
      }

      const limit = parseInt(req.query.limit, 10) || 50;
      const offset = parseInt(req.query.offset, 10) || 0;
      const search = req.query.search ? `%${req.query.search}%` : null;

      let sql = `
        SELECT
          p.id,
          p.text,
          p.created_at,
          COALESCE(p.updated_at, p.created_at) AS updated_at,
          p.x,
          p.y,
          b.slug AS board_slug,
          p.author_id,
          p.image_url,
          u.username AS author
        FROM postits p
        JOIN users u ON u.id = p.author_id
        JOIN boards b ON b.id = p.board_id
        WHERE p.board_id = ?
      `;
      const params = [board.id];

      if (search) {
        sql += ' AND (p.text LIKE ? OR u.username LIKE ?)';
        params.push(search, search);
      }

      sql += ' ORDER BY datetime(COALESCE(p.updated_at, p.created_at)) DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      db.all(sql, params, (err, rows) => {
        if (err) {
          logger.error('Erreur liste postits', { error: err.message, boardSlug: req.boardSlug });
          return res.status(500).json({ error: 'Erreur interne' });
        }

        let countSql =
          'SELECT COUNT(*) as total FROM postits p JOIN users u ON u.id = p.author_id WHERE p.board_id = ?';
        const countParams = [board.id];

        if (search) {
          countSql += ' AND (p.text LIKE ? OR u.username LIKE ?)';
          countParams.push(search, search);
        }

        db.get(countSql, countParams, (countErr, countRow) => {
          if (countErr) {
            logger.error('Erreur count postits', { error: countErr.message });
            return res.status(500).json({ error: 'Erreur interne' });
          }

          return res.json({
            postits: rows,
            pagination: {
              total: countRow.total,
              limit,
              offset,
              hasMore: offset + limit < countRow.total
            }
          });
        });
      });
    });
  }
);

router.post(
  '/api/:boardSlug/ajouter',
  validateBoardSlug,
  requireRight('can_create'),
  handleImageUpload,
  body('text').trim().isLength({ min: 1, max: 500 }).withMessage('Texte 1-500 caractères'),
  body('x').isFloat({ min: 0, max: 5000 }).withMessage('Position x invalide'),
  body('y').isFloat({ min: 0, max: 5000 }).withMessage('Position y invalide'),
  (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      cleanupTempUpload(req.file);
      return res.status(400).json({ errors: errors.array() });
    }

    const actor = req.actor || getActor(req);

    if (!actor || actor.id == null) {
      cleanupTempUpload(req.file);
      return res.status(403).json({ error: 'Aucun utilisateur actif disponible' });
    }

    getBoardBySlug(req.boardSlug, (boardErr, board) => {
      if (boardErr) {
        cleanupTempUpload(req.file);
        logger.error('Erreur lecture board ajout', { error: boardErr.message });
        return res.status(500).json({ error: 'Erreur interne' });
      }

      if (!board) {
        cleanupTempUpload(req.file);
        return res.status(404).json({ error: 'Tableau introuvable' });
      }

      const text = req.body.text.trim();
      const x = Number(req.body.x);
      const y = Number(req.body.y);
      let imageUrl = null;

      if (req.file) {
        try {
          imageUrl = moveUploadedFileToManagedLocation(req.file);
        } catch (err) {
          cleanupTempUpload(req.file);
          logger.error('Erreur déplacement image ajout', { error: err.message });
          return res.status(500).json({ error: 'Erreur interne' });
        }
      }

      db.run(
        'INSERT INTO postits (text, x, y, board_id, author_id, image_url) VALUES (?, ?, ?, ?, ?, ?)',
        [text, x, y, board.id, actor.id, imageUrl],
        function onInsert(err) {
          if (err) {
            logger.error('Erreur ajout postit', { error: err.message, actor: actor.username });

            if (imageUrl) {
              safeDeleteManagedImage(imageUrl);
            }

            return res.status(500).json({ error: 'Erreur interne' });
          }

          logPostitChange(this.lastID, 'created', actor.id, null, {
            text,
            x,
            y,
            image_url: imageUrl
          });

          db.get(
            `
            SELECT
              p.id,
              p.text,
              p.created_at,
              COALESCE(p.updated_at, p.created_at) AS updated_at,
              p.x,
              p.y,
              b.slug AS board_slug,
              p.author_id,
              p.image_url,
              u.username AS author
            FROM postits p
            JOIN users u ON u.id = p.author_id
            JOIN boards b ON b.id = p.board_id
            WHERE p.id = ?
            `,
            [this.lastID],
            (readErr, row) => {
              if (readErr) {
                logger.error('Erreur lecture postit après ajout', { error: readErr.message });
                return res.status(500).json({ error: 'Erreur interne' });
              }

              emitBoardChange(req, req.boardSlug, 'added', row.id);
              logger.info('Postit ajouté', {
                postitId: row.id,
                author: actor.username,
                boardSlug: req.boardSlug
              });

              return res.json({ postit: row });
            }
          );
        }
      );
    });
  }
);

router.post(
  '/api/:boardSlug/effacer/:id',
  validateBoardSlug,
  param('id').isInt({ min: 1 }).withMessage('ID invalide'),
  (req, res) => {
    const actor = getActor(req);

    if (!actor || actor.id == null) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const postitId = Number(req.params.id);

    db.get(
      `
      SELECT
        p.id,
        p.author_id,
        p.board_id,
        b.slug AS board_slug,
        p.text,
        p.x,
        p.y,
        p.image_url
      FROM postits p
      JOIN boards b ON b.id = p.board_id
      WHERE p.id = ? AND b.slug = ?
      `,
      [postitId, req.boardSlug],
      (err, postit) => {
        if (err) {
          logger.error('Erreur lecture postit pour suppression', { error: err.message });
          return res.status(500).json({ error: 'Erreur interne' });
        }

        if (!postit) {
          return res.status(404).json({ error: 'Post-it introuvable' });
        }

        const isOwner = Number(actor.id) === Number(postit.author_id);
        const allowed = actor.is_admin || (isOwner && actor.can_delete);

        if (!allowed) {
          return res.status(403).json({ error: 'Droits insuffisants' });
        }

        const oldData = {
          text: postit.text,
          x: postit.x,
          y: postit.y,
          image_url: postit.image_url
        };

        db.run('BEGIN TRANSACTION', (beginErr) => {
          if (beginErr) {
            logger.error('Erreur début transaction suppression', {
              error: beginErr.message,
              postitId
            });
            return res.status(500).json({ error: 'Erreur interne' });
          }

          const rollbackAndReply = (sourceErr, message) => {
            logger.error(message, {
              error: sourceErr.message,
              postitId,
              actor: actor.username,
              boardSlug: req.boardSlug
            });

            db.run('ROLLBACK', (rollbackErr) => {
              if (rollbackErr) {
                logger.error('Erreur rollback suppression postit', {
                  error: rollbackErr.message,
                  postitId
                });
              }

              return res.status(500).json({ error: 'Erreur interne' });
            });
          };

          db.run(
            `INSERT INTO postit_history
             (postit_id, text, x, y, image_url, changed_by, change_type)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [postitId, oldData.text, oldData.x, oldData.y, oldData.image_url, actor.id, 'deleted'],
            (historyErr) => {
              if (historyErr) {
                return rollbackAndReply(historyErr, 'Erreur insertion historique suppression');
              }

              db.run(
                'DELETE FROM postits WHERE id = ?',
                [postitId],
                function onDelete(deleteErr) {
                  if (deleteErr) {
                    return rollbackAndReply(deleteErr, 'Erreur suppression postit');
                  }

                  if (this.changes !== 1) {
                    return rollbackAndReply(
                      new Error('Suppression incohérente'),
                      'Aucun post-it supprimé dans la transaction'
                    );
                  }

                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      return rollbackAndReply(commitErr, 'Erreur commit suppression postit');
                    }

                    if (postit.image_url) {
                      safeDeleteManagedImage(postit.image_url);
                    }

                    emitBoardChange(req, req.boardSlug, 'deleted', postitId);
                    logger.info('Postit supprimé', {
                      postitId,
                      author: actor.username,
                      boardSlug: req.boardSlug
                    });

                    return res.json({ success: true });
                  });
                }
              );
            }
          );
        });
      }
    );
  }
);

router.post(
  '/api/:boardSlug/modifier/:id',
  validateBoardSlug,
  param('id').isInt({ min: 1 }).withMessage('ID invalide'),
  handleImageUpload,
  body('text').trim().isLength({ min: 1, max: 500 }).withMessage('Texte 1-500 caractères'),
  body('x').isFloat({ min: 0, max: 5000 }).withMessage('Position x invalide'),
  body('y').isFloat({ min: 0, max: 5000 }).withMessage('Position y invalide'),
  (req, res) => {
    const actor = getActor(req);

    if (!actor || actor.id == null) {
      cleanupTempUpload(req.file);
      return res.status(403).json({ error: 'Droits insuffisants' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      cleanupTempUpload(req.file);
      return res.status(400).json({ errors: errors.array() });
    }

    const postitId = Number(req.params.id);
    const text = req.body.text.trim();
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    const removeImage = req.body.removeImage === '1';

    db.get(
      `
      SELECT
        p.id,
        p.author_id,
        p.board_id,
        b.slug AS board_slug,
        p.text,
        p.x,
        p.y,
        p.image_url
      FROM postits p
      JOIN boards b ON b.id = p.board_id
      WHERE p.id = ? AND b.slug = ?
      `,
      [postitId, req.boardSlug],
      (err, postit) => {
        if (err) {
          cleanupTempUpload(req.file);
          logger.error('Erreur lecture postit pour modification', { error: err.message });
          return res.status(500).json({ error: 'Erreur interne' });
        }

        if (!postit) {
          cleanupTempUpload(req.file);
          return res.status(404).json({ error: 'Post-it introuvable' });
        }

        const isOwner = Number(actor.id) === Number(postit.author_id);
        const allowed = actor.is_admin || (isOwner && actor.can_edit);

        if (!allowed) {
          cleanupTempUpload(req.file);
          return res.status(403).json({ error: 'Droits insuffisants' });
        }

        let imageUrl = postit.image_url;
        let newManagedImageUrl = null;

        if (req.file) {
          try {
            newManagedImageUrl = moveUploadedFileToManagedLocation(req.file);
            imageUrl = newManagedImageUrl;
          } catch (moveErr) {
            cleanupTempUpload(req.file);
            logger.error('Erreur déplacement image modification', { error: moveErr.message });
            return res.status(500).json({ error: 'Erreur interne' });
          }
        } else if (removeImage) {
          imageUrl = null;
        }

        const oldData = {
          text: postit.text,
          x: postit.x,
          y: postit.y,
          image_url: postit.image_url
        };

        db.run(
          'UPDATE postits SET text = ?, x = ?, y = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [text, x, y, imageUrl, postitId],
          (updateErr) => {
            if (updateErr) {
              logger.error('Erreur modification postit', { error: updateErr.message });

              if (newManagedImageUrl) {
                safeDeleteManagedImage(newManagedImageUrl);
              }

              return res.status(500).json({ error: 'Erreur interne' });
            }

            logPostitChange(postitId, 'updated', actor.id, oldData, {
              text,
              x,
              y,
              image_url: imageUrl
            });

            if (newManagedImageUrl && postit.image_url && postit.image_url !== newManagedImageUrl) {
              safeDeleteManagedImage(postit.image_url);
            }

            if (!newManagedImageUrl && removeImage && postit.image_url) {
              safeDeleteManagedImage(postit.image_url);
            }

            db.get(
              `
              SELECT
                p.id,
                p.text,
                p.created_at,
                COALESCE(p.updated_at, p.created_at) AS updated_at,
                p.x,
                p.y,
                b.slug AS board_slug,
                p.author_id,
                p.image_url,
                u.username AS author
              FROM postits p
              JOIN users u ON u.id = p.author_id
              JOIN boards b ON b.id = p.board_id
              WHERE p.id = ?
              `,
              [postitId],
              (readErr, row) => {
                if (readErr) {
                  logger.error('Erreur lecture postit après modification', { error: readErr.message });
                  return res.status(500).json({ error: 'Erreur interne' });
                }

                emitBoardChange(req, req.boardSlug, 'updated', postitId);
                logger.info('Postit modifié', {
                  postitId,
                  author: actor.username,
                  boardSlug: req.boardSlug
                });

                return res.json({ postit: row });
              }
            );
          }
        );
      }
    );
  }
);

router.get(
  '/api/:boardSlug/historique/:id',
  validateBoardSlug,
  param('id').isInt({ min: 1 }).withMessage('ID invalide'),
  (req, res) => {
    const actor = getActor(req);

    if (!actor || !actor.is_admin) {
      return res.status(403).json({ error: 'Accès administrateur requis' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const postitId = Number(req.params.id);

    const sql = `
      SELECT
        h.id,
        h.postit_id,
        h.text,
        h.x,
        h.y,
        h.image_url,
        h.changed_at,
        h.change_type,
        u.username AS changed_by
      FROM postit_history h
      JOIN users u ON u.id = h.changed_by
      WHERE h.postit_id = ?
      ORDER BY h.changed_at DESC
    `;

    db.all(sql, [postitId], (err, rows) => {
      if (err) {
        logger.error('Erreur récupération historique', { error: err.message });
        return res.status(500).json({ error: 'Erreur interne' });
      }

      return res.json({ history: rows });
    });
  }
);

module.exports = router;