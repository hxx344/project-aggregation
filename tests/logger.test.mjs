import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../server/logger.mjs';

describe('Logger', () => {
  it('exports a logger instance with required methods', () => {
    assert.ok(logger);
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');
    assert.equal(typeof logger.debug, 'function');
  });

  it('logs without throwing errors', () => {
    assert.doesNotThrow(() => {
      logger.info({ type: 'test' }, 'Test info log');
      logger.warn({ type: 'test' }, 'Test warn log');
      logger.error({ type: 'test' }, 'Test error log');
      logger.debug({ type: 'test' }, 'Test debug log');
    });
  });
});
