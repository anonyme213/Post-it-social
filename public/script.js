const board = document.getElementById('board');
const modal = document.getElementById('postitModal');
const form = document.getElementById('newPostitForm');
const textInput = document.getElementById('postitText');
const cancelBtn = document.getElementById('cancelBtn');
const messageBox = document.getElementById('message');
const openPostitBtn = document.getElementById('openPostitBtn');
const boardSwitcherForm = document.getElementById('boardSwitcherForm');
const boardSlugInput = document.getElementById('boardSlugInput');
const boardName = document.getElementById('boardName');
const boardLinks = document.getElementById('boardLinks');
const authStatus = document.getElementById('authStatus');
const loginPanel = document.getElementById('loginPanel');
const deleteBoardBtn = document.getElementById('deleteBoardBtn');
const modalTitle = document.getElementById('modalTitle');
const submitPostitBtn = document.getElementById('submitPostitBtn');

let clickX = 0;
let clickY = 0;
let realtimeReloadTimer = null;
let knownBoards = [];
let modalMode = 'create';
let editingPostit = null;

const BOARD_BOTTOM_PADDING = 180;
const BOARD_GROW_EXTRA = 220;

function parseMetaJSON(name) {
  const meta = document.querySelector(`meta[name="${name}"]`);
  if (!meta || !meta.content) return null;

  try {
    return JSON.parse(decodeURIComponent(meta.content));
  } catch (err) {
    console.error(`Erreur parsing meta ${name}:`, err);
    return null;
  }
}

function getMeta(name) {
  const meta = document.querySelector(`meta[name="${name}"]`);
  return meta ? meta.content : '';
}

let currentUser = parseMetaJSON('current-user');
let guestUser = parseMetaJSON('guest-user');

const boardSlug = getMeta('current-board') || 'general';
const boardPath =
  getMeta('current-board-path') || (boardSlug === 'general' ? '/' : `/${boardSlug}`);

function getCsrf() {
  return getMeta('csrf-token');
}

function getActiveUser() {
  return currentUser || guestUser || null;
}

function isAuthenticated() {
  return !!currentUser;
}

function userCanCreate() {
  const actor = getActiveUser();
  return !!actor && (actor.is_admin || actor.can_create);
}

function canEditPostit(postit) {
  const actor = getActiveUser();
  if (!actor || actor.id == null) return false;

  const isOwner = Number(actor.id) === Number(postit.author_id);
  return actor.is_admin || (isOwner && actor.can_edit);
}

function canDeletePostit(postit) {
  const actor = getActiveUser();
  if (!actor || actor.id == null) return false;

  const isOwner = Number(actor.id) === Number(postit.author_id);
  return actor.is_admin || (isOwner && actor.can_delete);
}

function humanizeBoardName(slug) {
  return slug === 'general' ? 'général' : slug;
}

function canDeleteCurrentBoard() {
  if (!currentUser || boardSlug === 'general') return false;

  const currentBoard = knownBoards.find((item) => item.slug === boardSlug);

  if (!currentBoard) {
    return !!currentUser.is_admin;
  }

  return (
    !!currentUser.is_admin ||
    (currentBoard.creator_id != null &&
      Number(currentBoard.creator_id) === Number(currentUser.id))
  );
}

function updateDeleteBoardButton() {
  if (!deleteBoardBtn) return;
  deleteBoardBtn.classList.toggle('is-hidden', !canDeleteCurrentBoard());
}

function getBoardBaseMinHeight() {
  const rect = board.getBoundingClientRect();
  const available = window.innerHeight - rect.top - 24;
  return Math.max(700, available);
}

function setBoardHeight(targetHeight) {
  const finalHeight = Math.max(getBoardBaseMinHeight(), targetHeight);
  board.style.height = `${finalHeight}px`;
}

function ensureBoardCanFit(requiredBottom) {
  const currentHeight = board.offsetHeight || getBoardBaseMinHeight();
  const wantedHeight = requiredBottom + BOARD_BOTTOM_PADDING;

  if (wantedHeight > currentHeight) {
    setBoardHeight(wantedHeight + BOARD_GROW_EXTRA);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fitPostitInsideBoard(node) {
  if (!node || !board) return;

  const noteWidth = node.offsetWidth || 180;
  const noteHeight = node.offsetHeight || 120;

  const maxX = Math.max(0, board.clientWidth - noteWidth - 8);
  const maxY = Math.max(0, board.offsetHeight - noteHeight - 8);

  const currentX = parseFloat(node.style.left) || 0;
  const currentY = parseFloat(node.style.top) || 0;

  const safeX = clamp(currentX, 0, maxX);
  const safeY = clamp(currentY, 0, maxY);

  node.style.left = `${safeX}px`;
  node.style.top = `${safeY}px`;
}

function fitAllPostitsInsideBoard() {
  const postits = board.querySelectorAll('.postit');
  postits.forEach((node) => fitPostitInsideBoard(node));
}

function isMobileLayout() {
  return window.innerWidth <= 768;
}

function layoutPostitsForMobile() {
  if (!board) return;

  const nodes = Array.from(board.querySelectorAll('.postit'));
  if (!nodes.length) {
    setBoardHeight(getBoardBaseMinHeight());
    return;
  }

  const boardWidth = board.clientWidth;
  const gap = 14;
  const padding = 12;

  const columns = boardWidth < 420 ? 1 : 2;
  const noteWidth =
    columns === 1
      ? Math.max(140, boardWidth - padding * 2)
      : Math.max(140, Math.floor((boardWidth - padding * 2 - gap) / 2));

  const heights = new Array(columns).fill(16);

  nodes.forEach((node) => {
    node.style.width = `${noteWidth}px`;

    const col =
      columns === 1
        ? 0
        : heights[0] <= heights[1]
          ? 0
          : 1;

    const x = padding + (columns === 1 ? 0 : col * (noteWidth + gap));
    const y = heights[col];

    node.style.left = `${x}px`;
    node.style.top = `${y}px`;

    heights[col] = y + node.offsetHeight + gap;
  });

  const maxBottom = Math.max(...heights, 0);
  setBoardHeight(maxBottom + BOARD_BOTTOM_PADDING);
}

function updateBoardHeightFromPostits() {
  let maxBottom = 0;

  const postits = board.querySelectorAll('.postit');

  postits.forEach((node) => {
    fitPostitInsideBoard(node);
    const top = parseFloat(node.style.top) || 0;
    const height = node.offsetHeight || 120;
    maxBottom = Math.max(maxBottom, top + height);
  });

  setBoardHeight(maxBottom + BOARD_BOTTOM_PADDING);
}

function layoutPostitsForDesktop() {
  if (!board) return;

  const nodes = Array.from(board.querySelectorAll('.postit'));

  nodes.forEach((node) => {
    node.style.width = '';
    fitPostitInsideBoard(node);
  });

  updateBoardHeightFromPostits();
}

function applyResponsivePostitLayout() {
  if (!board) return;

  if (isMobileLayout()) {
    layoutPostitsForMobile();
  } else {
    layoutPostitsForDesktop();
  }
}

function showMessage(text, type = 'success') {
  if (!messageBox) return;

  messageBox.textContent = text;
  messageBox.className = `message ${type}`;
  messageBox.classList.remove('hidden');
  messageBox.style.display = 'block';

  clearTimeout(showMessage._timer);
  showMessage._timer = setTimeout(() => {
    messageBox.style.display = 'none';
  }, 3000);
}

async function requestJSON(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  const method = (options.method || 'GET').toUpperCase();

  if (method !== 'GET') {
    const csrfToken = getCsrf();

    if (csrfToken) {
      headers.set('X-CSRF-Token', csrfToken);
    }

    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers
  });

  const contentType = response.headers.get('content-type') || '';
  let payload = {};

  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = { error: text || 'Erreur serveur' };
  }

  if (!response.ok) {
    const errorMessage =
      payload.error ||
      (Array.isArray(payload.errors) && payload.errors.length
        ? payload.errors.map((e) => e.msg).join(', ')
        : 'Erreur serveur');

    throw new Error(errorMessage);
  }

  return payload;
}

function buildApiUrl(pathSuffix) {
  return `/api/${encodeURIComponent(boardSlug)}${pathSuffix}`;
}

function getOrderValue(postit) {
  const source = postit.updated_at || postit.created_at;
  const timestamp = new Date(source).getTime();
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 1;
}

function resetModalState() {
  modalMode = 'create';
  editingPostit = null;

  if (textInput) {
    textInput.value = '';
  }

  if (modalTitle) {
    modalTitle.textContent = 'Nouveau post-it';
  }

  if (submitPostitBtn) {
    submitPostitBtn.textContent = 'Ajouter';
  }
}

function closePostitModal() {
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  resetModalState();
}

function openPostitModal(options = {}) {
  const { mode = 'create', x = 100, y = 100, postit = null } = options;

  if (mode === 'create' && !userCanCreate()) {
    if (!isAuthenticated()) {
      showMessage('Connectez-vous pour ajouter un post-it.', 'error');
    } else {
      showMessage("Vous n'avez pas le droit de créer des post-it.", 'error');
    }
    return;
  }

  if (mode === 'edit' && (!postit || !canEditPostit(postit))) {
    showMessage("Vous n'avez pas le droit de modifier ce post-it.", 'error');
    return;
  }

  modalMode = mode;
  editingPostit = postit || null;
  clickX = typeof x === 'number' ? x : 100;
  clickY = typeof y === 'number' ? y : 100;

  if (textInput) {
    textInput.value = postit?.text || '';
  }

  if (modalTitle) {
    modalTitle.textContent = mode === 'edit' ? 'Modifier le post-it' : 'Nouveau post-it';
  }

  if (submitPostitBtn) {
    submitPostitBtn.textContent = mode === 'edit' ? 'Enregistrer' : 'Ajouter';
  }

  if (modal) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  if (textInput) {
    textInput.focus();
  }
}

function renderBoardLinks(items = []) {
  if (!boardLinks) return;

  knownBoards = Array.isArray(items) ? items : [];
  boardLinks.innerHTML = '';

  const seen = new Set();
  const finalBoards = [];

  const source = [
    { slug: 'general', creator_id: null },
    ...knownBoards,
    { slug: boardSlug, creator_id: null }
  ];

  source.forEach((item) => {
    if (!item || typeof item.slug !== 'string') return;
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(item.slug)) return;
    if (seen.has(item.slug)) return;

    seen.add(item.slug);
    finalBoards.push(item);
  });

  finalBoards.sort((a, b) => {
    if (a.slug === 'general') return -1;
    if (b.slug === 'general') return 1;
    return a.slug.localeCompare(b.slug, 'fr');
  });

  finalBoards.forEach((item) => {
    const link = document.createElement('a');
    link.href = item.slug === 'general' ? '/' : `/${encodeURIComponent(item.slug)}`;
    link.className = `board-link ${item.slug === boardSlug ? 'active' : ''}`;
    link.textContent = humanizeBoardName(item.slug);
    boardLinks.appendChild(link);
  });

  updateDeleteBoardButton();
}

async function loadBoardLinks() {
  try {
    const response = await requestJSON('/api/boards');
    const boards = Array.isArray(response.boards) ? response.boards : [];
    renderBoardLinks(boards);
  } catch (err) {
    console.error('Erreur chargement tableaux :', err);
    renderBoardLinks([{ slug: boardSlug, creator_id: null }]);
  }
}

function updateBoardUI() {
  if (boardName) {
    boardName.textContent = humanizeBoardName(boardSlug);
  }

  document.title = `Post-it Social — ${humanizeBoardName(boardSlug)}`;
  loadBoardLinks();
}

function updateAuthUI() {
  if (!authStatus) return;

  authStatus.innerHTML = '';

  if (loginPanel) {
    loginPanel.classList.toggle('is-hidden', isAuthenticated());
  }

  if (openPostitBtn) {
    openPostitBtn.classList.toggle('is-hidden', !userCanCreate());
  }

  if (!isAuthenticated()) {
    const guestSpan = document.createElement('span');
    guestSpan.textContent = 'Mode invité';
    guestSpan.className = 'guest-badge';
    authStatus.appendChild(guestSpan);

    const loginLink = document.createElement('a');
    loginLink.href = `/login?next=${encodeURIComponent(boardPath)}`;
    loginLink.textContent = 'Connexion';
    authStatus.appendChild(loginLink);

    const signupLink = document.createElement('a');
    signupLink.href = `/signup?next=${encodeURIComponent(boardPath)}`;
    signupLink.textContent = 'Inscription';
    authStatus.appendChild(signupLink);

    updateDeleteBoardButton();
    return;
  }

  const userSpan = document.createElement('span');
  userSpan.textContent = `👤 ${currentUser.username}`;
  userSpan.className = 'user-badge';
  authStatus.appendChild(userSpan);

  if (currentUser.is_admin) {
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.textContent = '⚙️ Admin';
    authStatus.appendChild(adminLink);
  }

  const logoutForm = document.createElement('form');
  logoutForm.method = 'POST';
  logoutForm.action = '/logout';
  logoutForm.style.display = 'inline';

  const csrfInput = document.createElement('input');
  csrfInput.type = 'hidden';
  csrfInput.name = '_csrf';
  csrfInput.value = getCsrf();
  logoutForm.appendChild(csrfInput);

  const logoutButton = document.createElement('button');
  logoutButton.type = 'submit';
  logoutButton.textContent = 'Déconnexion';
  logoutForm.appendChild(logoutButton);

  authStatus.appendChild(logoutForm);
  updateDeleteBoardButton();
}

async function loadAuthStatus() {
  try {
    const response = await fetch('/me', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });

    const data = await response.json();
    currentUser = data.currentUser || null;
    guestUser = data.guestUser || null;
  } catch (err) {
    console.error('Erreur /me :', err);
  }

  updateAuthUI();
}

function enableDrag(node, postit, textNode) {
  if (isMobileLayout()) return;
  if (!canEditPostit(postit)) return;

  node.classList.add('draggable');

  let activePointerId = null;
  let originX = 0;
  let originY = 0;
  let offsetX = 0;
  let offsetY = 0;

  function cleanup() {
    node.classList.remove('dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    activePointerId = null;
  }

  function onPointerMove(event) {
    if (event.pointerId !== activePointerId) return;

    const boardRect = board.getBoundingClientRect();
    const noteWidth = node.offsetWidth;
    const noteHeight = node.offsetHeight;

    const desiredY = event.clientY - boardRect.top - offsetY;
    ensureBoardCanFit(desiredY + noteHeight);

    const newX = clamp(
      event.clientX - boardRect.left - offsetX,
      0,
      Math.max(0, board.clientWidth - noteWidth)
    );

    const newY = clamp(desiredY, 0, Math.max(0, board.offsetHeight - noteHeight));

    node.style.left = `${newX}px`;
    node.style.top = `${newY}px`;
    node.style.zIndex = '999999';

    if (event.clientY > window.innerHeight - 80) {
      window.scrollBy(0, 16);
    } else if (event.clientY < 80) {
      window.scrollBy(0, -16);
    }
  }

  async function onPointerUp(event) {
    if (event.pointerId !== activePointerId) return;

    cleanup();
    updateBoardHeightFromPostits();

    const x = parseFloat(node.style.left) || 0;
    const y = parseFloat(node.style.top) || 0;

    if (x === originX && y === originY) {
      node.style.zIndex = String(getOrderValue(postit));
      return;
    }

    try {
      const result = await requestJSON(buildApiUrl(`/modifier/${postit.id}`), {
        method: 'POST',
        body: JSON.stringify({
          text: textNode.textContent,
          x,
          y
        })
      });

      const updatedPostit = result.postit;
      node.style.zIndex = String(getOrderValue(updatedPostit));
      node.__postit = updatedPostit;
      showMessage('Position sauvegardée');
    } catch (err) {
      node.style.left = `${originX}px`;
      node.style.top = `${originY}px`;
      node.style.zIndex = String(getOrderValue(postit));
      updateBoardHeightFromPostits();
      showMessage(err.message, 'error');
    }
  }

  node.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.preventDefault();

    const nodeRect = node.getBoundingClientRect();

    activePointerId = event.pointerId;
    originX = parseFloat(node.style.left) || 0;
    originY = parseFloat(node.style.top) || 0;
    offsetX = event.clientX - nodeRect.left;
    offsetY = event.clientY - nodeRect.top;

    node.classList.add('dragging');
    node.style.zIndex = '999999';

    if (typeof node.setPointerCapture === 'function') {
      node.setPointerCapture(event.pointerId);
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });
}

function renderPostit(postit) {
  const node = document.createElement('div');
  node.className = 'postit';
  node.style.left = `${postit.x}px`;
  node.style.top = `${postit.y}px`;
  node.style.zIndex = String(getOrderValue(postit));
  node.dataset.id = String(postit.id);
  node.__postit = postit;

  const header = document.createElement('div');
  header.className = 'header';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = postit.author;

  const date = document.createElement('span');
  date.className = 'date';

  const dateValue = new Date(postit.created_at);
  date.textContent = `${dateValue.toLocaleDateString('fr-FR')} ${dateValue.toLocaleTimeString(
    'fr-FR',
    {
      hour: '2-digit',
      minute: '2-digit'
    }
  )}`;

  meta.appendChild(author);
  meta.appendChild(date);
  header.appendChild(meta);

  const text = document.createElement('p');
  text.textContent = postit.text;

  if (canDeletePostit(postit)) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete';
    del.textContent = '✕';

    del.addEventListener('click', async (e) => {
      e.stopPropagation();

      if (!confirm('Supprimer ce post-it ?')) return;

      try {
        await requestJSON(buildApiUrl(`/effacer/${postit.id}`), {
          method: 'POST'
        });

        showMessage('Post-it supprimé');
        await loadPostits();
      } catch (err) {
        showMessage(err.message, 'error');
      }
    });

    header.appendChild(del);
  }

  if (canEditPostit(postit)) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'edit';
    edit.textContent = '✎';

    edit.addEventListener('click', async (e) => {
      e.stopPropagation();

      openPostitModal({
        mode: 'edit',
        x: parseFloat(node.style.left) || 0,
        y: parseFloat(node.style.top) || 0,
        postit: node.__postit || postit
      });
    });

    header.appendChild(edit);
  }

  node.appendChild(header);
  node.appendChild(text);
  board.appendChild(node);
  enableDrag(node, postit, text);
}

async function loadPostits() {
  try {
    const response = await requestJSON(buildApiUrl('/liste'));
    board.innerHTML = '';

    if (!response.postits || !Array.isArray(response.postits)) {
      console.error('Invalid response:', response);
      showMessage('Erreur de chargement des post-its', 'error');
      return;
    }

    response.postits.forEach(renderPostit);
    applyResponsivePostitLayout();
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

if (board) {
  board.addEventListener('dblclick', (event) => {
    if (event.target.closest('.postit')) return;

    const rect = board.getBoundingClientRect();

    const x = clamp(event.clientX - rect.left, 0, Math.max(0, board.clientWidth - 40));
    const y = clamp(event.clientY - rect.top, 0, Math.max(0, board.offsetHeight - 40));

    openPostitModal({ mode: 'create', x, y });
  });
}

if (openPostitBtn) {
  openPostitBtn.addEventListener('click', () => {
    const maxX = Math.max(40, board.clientWidth - 220);
    const maxY = Math.max(40, board.offsetHeight - 140);
    const x = Math.random() * maxX;
    const y = Math.random() * maxY;
    openPostitModal({ mode: 'create', x, y });
  });
}

if (deleteBoardBtn) {
  deleteBoardBtn.addEventListener('click', async () => {
    if (boardSlug === 'general') {
      showMessage('Le tableau général ne peut pas être supprimé', 'error');
      return;
    }

    const ok = confirm(
      `Voulez-vous vraiment supprimer le tableau "${boardSlug}" ?\n\nTous les post-it de ce tableau seront supprimés.`
    );

    if (!ok) return;

    try {
      await requestJSON(`/api/boards/${encodeURIComponent(boardSlug)}/delete`, {
        method: 'POST'
      });

      showMessage('Tableau supprimé');
      setTimeout(() => {
        window.location.href = '/';
      }, 500);
    } catch (err) {
      showMessage(err.message, 'error');
    }
  });
}

if (cancelBtn) {
  cancelBtn.addEventListener('click', closePostitModal);
}

if (modal) {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePostitModal();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePostitModal();
});

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const text = textInput.value.trim();
    if (!text) {
      showMessage('Texte requis', 'error');
      return;
    }

    try {
      const x = modalMode === 'edit' ? parseFloat(editingPostit?.x ?? clickX) : clickX;
      const y = modalMode === 'edit' ? parseFloat(editingPostit?.y ?? clickY) : clickY;

      if (modalMode === 'edit' && editingPostit) {
        await requestJSON(buildApiUrl(`/modifier/${editingPostit.id}`), {
          method: 'POST',
          body: JSON.stringify({ text, x, y })
        });

        showMessage('Post-it mis à jour');
      } else {
        await requestJSON(buildApiUrl('/ajouter'), {
          method: 'POST',
          body: JSON.stringify({ text, x, y })
        });

        showMessage('Post-it ajouté');
      }

      closePostitModal();
      await loadPostits();
    } catch (err) {
      showMessage(err.message, 'error');
    }
  });
}

if (boardSwitcherForm && boardSlugInput) {
  boardSwitcherForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const slug = boardSlugInput.value.trim();

    if (!/^[A-Za-z0-9_-]{1,30}$/.test(slug)) {
      showMessage('Nom de tableau invalide', 'error');
      return;
    }

    const existingBoard = knownBoards.find((item) => item.slug === slug);

    if (existingBoard) {
      window.location.href = slug === 'general' ? '/' : `/${encodeURIComponent(slug)}`;
      return;
    }

    if (!isAuthenticated()) {
      showMessage('Connectez-vous pour créer un tableau.', 'error');
      return;
    }

    try {
      const result = await requestJSON('/api/boards', {
        method: 'POST',
        body: JSON.stringify({ slug })
      });

      showMessage(result.created ? 'Tableau créé' : 'Tableau ouvert');
      window.location.href = slug === 'general' ? '/' : `/${encodeURIComponent(slug)}`;
    } catch (err) {
      showMessage(err.message, 'error');
    }
  });
}

if (window.io) {
  const socket = window.io();

  socket.on('connect', () => {
    socket.emit('board:join', boardSlug);
  });

  socket.on('postits:changed', (payload) => {
    if (!payload || payload.boardSlug !== boardSlug) return;

    clearTimeout(realtimeReloadTimer);
    realtimeReloadTimer = setTimeout(() => {
      loadPostits();
    }, 120);
  });

  socket.on('boards:changed', () => {
    loadBoardLinks();
  });

  socket.on('board:deleted', (payload) => {
    if (payload && payload.boardSlug === boardSlug) {
      window.location.href = '/';
    }
  });
}

window.addEventListener('resize', () => {
  applyResponsivePostitLayout();
});

updateBoardUI();
updateAuthUI();
loadAuthStatus();
loadPostits();