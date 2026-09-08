#!/usr/bin/env node
// Dry-run validation of the GitHub Pages workflow: parses the YAML and checks
// the shape GitHub Actions requires (no `act` in this environment).
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const path = process.argv[2] || '.github/workflows/pages.yml';
const doc = yaml.load(readFileSync(path, 'utf8'));
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

need(doc && typeof doc === 'object', 'workflow is not a mapping');
need(typeof doc.name === 'string', 'missing name');
const on = doc.on ?? doc[true]; // YAML 1.1 parses bare `on` as boolean true
need(on && (on.push || on.workflow_dispatch), 'missing on.push / on.workflow_dispatch');
need(on && on.push && Array.isArray(on.push.branches) && on.push.branches.includes('main'), 'push trigger must include main');
need(doc.permissions && doc.permissions.pages === 'write' && doc.permissions['id-token'] === 'write', 'permissions must grant pages: write and id-token: write');
need(doc.jobs && typeof doc.jobs === 'object', 'missing jobs');
const jobs = doc.jobs || {};
for (const [name, job] of Object.entries(jobs)) {
  need(typeof job['runs-on'] === 'string', `job ${name}: missing runs-on`);
  need(Array.isArray(job.steps) && job.steps.length > 0, `job ${name}: no steps`);
  for (const [i, s] of (job.steps || []).entries()) {
    need(typeof s === 'object' && (s.uses || s.run), `job ${name} step ${i}: needs uses or run`);
    if (s.uses) need(/^[\w.-]+\/[\w.-]+@[\w.-]+$/.test(s.uses) || s.uses.startsWith('./'), `job ${name} step ${i}: uses '${s.uses}' is not pinned as owner/repo@ref`);
  }
}
const deploy = Object.values(jobs).find((j) => (j.steps || []).some((s) => s.uses && s.uses.startsWith('actions/deploy-pages')));
need(deploy, 'no job uses actions/deploy-pages');
need(deploy && deploy.environment && (deploy.environment === 'github-pages' || deploy.environment.name === 'github-pages'), 'deploy job must use the github-pages environment');
const upload = Object.values(jobs).find((j) => (j.steps || []).some((s) => s.uses && s.uses.startsWith('actions/upload-pages-artifact')));
need(upload, 'no job uses actions/upload-pages-artifact');
const test = Object.values(jobs).find((j) => (j.steps || []).some((s) => s.run && /node --test/.test(s.run)));
need(test, 'workflow should run node --test before deploying');

if (problems.length) {
  console.error(`INVALID ${path}:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`OK ${path}: ${Object.keys(jobs).length} job(s), triggers ${Object.keys(on).join('/')}, deploy-pages present`);
