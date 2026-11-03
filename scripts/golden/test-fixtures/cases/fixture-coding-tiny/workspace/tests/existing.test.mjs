/* global console */
import assert from 'node:assert/strict';
import { add } from '../src/calc.js';

assert.equal(add(1, 2), 3);
console.log('existing tests: ok');
