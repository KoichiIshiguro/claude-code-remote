'use strict';

const DEFAULT_SELECTION = Object.freeze({
  selectedAgent: 'claude',
  models: Object.freeze({ claude: 'sonnet', codex: 'gpt-5.5' }),
  efforts: Object.freeze({ claude: '', codex: '' }),
});

const VALID_AGENTS = new Set(['claude', 'codex']);
const VALID_EFFORTS = {
  claude: new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  codex: new Set(['', 'minimal', 'low', 'medium', 'high', 'xhigh']),
};

function cleanModel(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function cleanEffort(agent, value) {
  if (typeof value !== 'string') return DEFAULT_SELECTION.efforts[agent];
  const v = value.trim();
  return VALID_EFFORTS[agent].has(v) ? v : DEFAULT_SELECTION.efforts[agent];
}

function normalizeSelection(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const models = src.models && typeof src.models === 'object' ? src.models : {};
  const efforts = src.efforts && typeof src.efforts === 'object' ? src.efforts : {};
  const selectedAgent = VALID_AGENTS.has(src.selectedAgent) ? src.selectedAgent : DEFAULT_SELECTION.selectedAgent;
  return {
    selectedAgent,
    models: {
      claude: cleanModel(models.claude, DEFAULT_SELECTION.models.claude),
      codex: cleanModel(models.codex, DEFAULT_SELECTION.models.codex),
    },
    efforts: {
      claude: cleanEffort('claude', efforts.claude),
      codex: cleanEffort('codex', efforts.codex),
    },
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : undefined,
  };
}

function mergeSelection(current, patch = {}) {
  const base = normalizeSelection(current);
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = {
    selectedAgent: VALID_AGENTS.has(p.selectedAgent) ? p.selectedAgent : base.selectedAgent,
    models: { ...base.models },
    efforts: { ...base.efforts },
  };
  if (p.models && typeof p.models === 'object') {
    if (Object.prototype.hasOwnProperty.call(p.models, 'claude')) next.models.claude = cleanModel(p.models.claude, base.models.claude);
    if (Object.prototype.hasOwnProperty.call(p.models, 'codex')) next.models.codex = cleanModel(p.models.codex, base.models.codex);
  }
  if (p.efforts && typeof p.efforts === 'object') {
    if (Object.prototype.hasOwnProperty.call(p.efforts, 'claude')) next.efforts.claude = cleanEffort('claude', p.efforts.claude);
    if (Object.prototype.hasOwnProperty.call(p.efforts, 'codex')) next.efforts.codex = cleanEffort('codex', p.efforts.codex);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function selectionForTranscript(transcript) {
  return normalizeSelection(transcript && transcript.meta && transcript.meta.selection);
}

function setTranscriptSelection(transcript, patch) {
  if (!transcript.meta || typeof transcript.meta !== 'object') transcript.meta = {};
  transcript.meta.selection = mergeSelection(transcript.meta.selection, patch);
  return transcript.meta.selection;
}

module.exports = {
  DEFAULT_SELECTION,
  normalizeSelection,
  mergeSelection,
  selectionForTranscript,
  setTranscriptSelection,
};
