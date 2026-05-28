'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const projectsStore = require('./projects-store');

// jobId → { jobId, url, dest, name, status, proc, output, subscribers }
const jobs = new Map();

function emit(job, obj) {
  const data = JSON.stringify(obj);
  for (const ws of job.subscribers) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function deriveName(url) {
  const m = url.match(/([^/:]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

function validUrl(url) {
  if (!url || typeof url !== 'string' || url.length > 1000) return false;
  return /^https?:\/\/[^\s'"`;|&<>]+$/i.test(url)
      || /^git:\/\/[^\s'"`;|&<>]+$/i.test(url)
      || /^ssh:\/\/[^\s'"`;|&<>]+$/i.test(url)
      || /^[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+:[^\s'"`;|&<>]+$/.test(url);
}

function startClone({ url, name }) {
  if (!validUrl(url)) throw new Error('Unsupported or unsafe git url');
  const folderName = (name && String(name).trim()) || deriveName(url);
  if (!folderName || !/^[a-zA-Z0-9_.\-]+$/.test(folderName)) {
    throw new Error('Could not derive a valid folder name (supply name=)');
  }
  const parent = projectsStore.getAccessRoot() || os.homedir();
  const parentAbs = path.resolve(parent);
  const target = path.join(parentAbs, folderName);
  if (!target.startsWith(parentAbs + path.sep) && target !== parentAbs) {
    throw new Error('Invalid target path');
  }
  if (fs.existsSync(target)) throw new Error(`Project "${folderName}" already exists`);

  const jobId = uuidv4();
  const job = {
    jobId, url, dest: target, name: folderName,
    status: 'running', output: [], subscribers: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);

  // Note: 'git clone' writes progress to stderr by default; --progress
  // makes that explicit even when stderr is not a TTY.
  const proc = spawn('git', ['clone', '--progress', '--', url, target], {
    cwd: parentAbs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  job.proc = proc;

  const append = (chunk, kind) => {
    const text = chunk.toString();
    job.output.push(text);
    emit(job, { type: 'clone_output', jobId, kind, text });
  };
  proc.stdout.on('data', d => append(d, 'stdout'));
  proc.stderr.on('data', d => append(d, 'stderr'));

  const killTimer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 5 * 60 * 1000);

  proc.on('close', code => {
    clearTimeout(killTimer);
    if (code === 0) {
      try {
        const entry = projectsStore.addProject({ path: target, name: folderName });
        job.status = 'done';
        job.project = entry;
        emit(job, { type: 'clone_done', jobId, project: entry });
      } catch (err) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
        job.status = 'failed';
        emit(job, { type: 'clone_failed', jobId, error: err.message });
      }
    } else {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      job.status = 'failed';
      emit(job, { type: 'clone_failed', jobId, error: `git exited with code ${code}` });
    }
  });

  proc.on('error', err => {
    clearTimeout(killTimer);
    job.status = 'failed';
    emit(job, { type: 'clone_failed', jobId, error: err.message });
  });

  return jobId;
}

function attach(jobId, ws) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.subscribers.add(ws);
  ws.on('close', () => job.subscribers.delete(ws));
  return { jobId, status: job.status, output: job.output.join(''), name: job.name, dest: job.dest, project: job.project || null };
}

function listJobs() {
  return [...jobs.values()].map(j => ({
    jobId: j.jobId, url: j.url, name: j.name, status: j.status,
    startedAt: j.startedAt,
  }));
}

module.exports = { startClone, attach, listJobs };
