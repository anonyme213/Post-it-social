const request = require('supertest');
const app = require('../app');

describe('GET /health', () => {
  it('should return health status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
  });
});

describe('GET /', () => {
  it('should return the main page', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Post-it Social');
  });
});

describe('Security Tests', () => {
  it('should have security headers', async () => {
    const response = await request(app).get('/');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('should validate board slug format', async () => {
    const response = await request(app).get('/api/invalid-slug!/liste');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('invalide');
  });

  it('should require authentication for protected routes', async () => {
    const response = await request(app)
      .post('/api/general/ajouter')
      .send({ text: 'test', x: 100, y: 100 });

    expect(response.status).toBeGreaterThanOrEqual(403);
  });
});