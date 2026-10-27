import assert from 'node:assert/strict';
import { progressFromEffort } from '../src/services/zentaoService.js';
assert.equal(progressFromEffort(0, 5), 0);
assert.equal(progressFromEffort(2, 6), 25);
assert.equal(progressFromEffort(3, 0), 100);
assert.equal(progressFromEffort(999, 1), 99);
console.log('✓ progressFromEffort');
