'use strict';

module.exports = {
  ...require('./canonical'),
  ...require('./claude-adapter'),
  ...require('./codex-adapter'),
};
