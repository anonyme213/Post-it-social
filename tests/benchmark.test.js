const { performance } = require('perf_hooks');
const request = require('supertest');
const app = require('../app');

describe('Performance Benchmarks', () => {
  it('should handle multiple concurrent requests efficiently', async () => {
    const start = performance.now();
    const promises = [];
    for (let i = 0; i < 50; i += 1) {
      promises.push(request(app).get('/'));
    }
    await Promise.all(promises);
    const end = performance.now();
    const duration = end - start;
    expect(duration).toBeLessThan(5000);
  });

  it('should respond quickly to health check', async () => {
    const start = performance.now();
    await request(app).get('/health');
    const end = performance.now();
    const duration = end - start;
    expect(duration).toBeLessThan(300);
  });
});